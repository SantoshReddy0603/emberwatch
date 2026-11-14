import { monitorEventLoopDelay } from 'node:perf_hooks';

// Per-second counters over a sliding 60 s window, plus latency samples.
// Cheap enough to update on every event.
class RateCounter {
  constructor() {
    this.total = 0;
    this.buckets = new Array(60).fill(0);
    this.sec = Math.floor(Date.now() / 1000);
  }
  roll(now) {
    const s = Math.floor(now / 1000);
    if (s === this.sec) return;
    const gap = Math.min(s - this.sec, 60);
    for (let i = 1; i <= gap; i++) this.buckets[(this.sec + i) % 60] = 0;
    this.sec = s;
  }
  add(n = 1, now = Date.now()) {
    this.roll(now);
    this.buckets[this.sec % 60] += n;
    this.total += n;
  }
  // Rate over the last complete `window` seconds.
  rate(window = 5, now = Date.now()) {
    this.roll(now);
    let sum = 0;
    for (let i = 1; i <= window; i++) sum += this.buckets[(this.sec - i + 60) % 60];
    return sum / window;
  }
  series(now = Date.now()) {
    this.roll(now);
    const out = [];
    for (let i = 59; i >= 1; i--) out.push(this.buckets[(this.sec - i + 60) % 60]);
    return out;
  }
}

class Samples {
  constructor(size = 2048) {
    this.size = size;
    this.buf = new Float64Array(size);
    this.n = 0;
  }
  add(v) {
    this.buf[this.n % this.size] = v;
    this.n++;
  }
  pct(p) {
    const len = Math.min(this.n, this.size);
    if (!len) return 0;
    const arr = Array.from(this.buf.subarray(0, len)).sort((a, b) => a - b);
    return arr[Math.min(len - 1, Math.floor((p / 100) * len))];
  }
}

const COUNTERS = [
  'received', 'accepted', 'duplicate', 'outOfOrder', 'rejected', 'rateLimited',
  'shed', 'written', 'writeErrors', 'framesSent', 'framesSkipped', 'bytesSent', 'alerts',
];

export function createMetrics() {
  const c = Object.fromEntries(COUNTERS.map((k) => [k, new RateCounter()]));
  const writeMs = new Samples(512);
  const ingestLagMs = new Samples(4096);
  const e2eMs = new Samples(4096);
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const rejectReasons = {};
  const startedAt = Date.now();

  return {
    c,
    writeMs,
    ingestLagMs,
    e2eMs,
    rejectReasons,
    reject(reason, n = 1) {
      c.rejected.add(n);
      rejectReasons[reason] = (rejectReasons[reason] || 0) + n;
    },
    snapshot(extra = {}) {
      const totals = Object.fromEntries(COUNTERS.map((k) => [k, c[k].total]));
      const rates = Object.fromEntries(COUNTERS.map((k) => [k, Math.round(c[k].rate(5))]));
      const mem = process.memoryUsage();
      const snap = {
        ts: Date.now(),
        uptimeS: Math.round((Date.now() - startedAt) / 1000),
        totals,
        rates,
        series: { accepted: c.accepted.series(), bytesSent: c.bytesSent.series() },
        rejectReasons: { ...rejectReasons },
        writeMs: { p50: round(writeMs.pct(50)), p95: round(writeMs.pct(95)) },
        ingestLagMs: { p50: round(ingestLagMs.pct(50)), p95: round(ingestLagMs.pct(95)) },
        e2eMs: { p50: round(e2eMs.pct(50)), p95: round(e2eMs.pct(95)), p99: round(e2eMs.pct(99)) },
        loopLagMs: { p50: round(loop.percentile(50) / 1e6), p99: round(loop.percentile(99) / 1e6) },
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        ...extra,
      };
      loop.reset();
      return snap;
    },
  };
}

const round = (v) => Math.round(v * 10) / 10;
