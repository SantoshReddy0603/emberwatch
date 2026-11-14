import { readingSchema, batchSchema, MAX_CLOCK_SKEW_MS } from '@emberwatch/shared';
import { TokenBucket } from './tokenBucket.js';

// Single entry point for telemetry, shared by the Socket.IO device namespace
// and the HTTP ingest route. Validates, rate-limits, deduplicates and hands
// accepted events to state, storage and analysis.
export class Ingestor {
  constructor({ state, writer, rollups, metrics, config, onReading }) {
    this.state = state;
    this.writer = writer;
    this.rollups = rollups;
    this.metrics = metrics;
    this.config = config;
    this.onReading = onReading || (() => {});
    this.sensorBuckets = new Map();
    this.gatewayBuckets = new Map();
  }

  sensorBucket(id) {
    let b = this.sensorBuckets.get(id);
    if (!b) {
      b = new TokenBucket(this.config.bucketCapacity, this.config.bucketRefillPerSec);
      this.sensorBuckets.set(id, b);
    }
    return b;
  }

  gatewayBucket(id) {
    let b = this.gatewayBuckets.get(id);
    if (!b) {
      b = new TokenBucket(this.config.gatewayBucketCapacity, this.config.gatewayBucketRefillPerSec);
      this.gatewayBuckets.set(id, b);
    }
    return b;
  }

  // Returns an acknowledgement for the sender. retryAfterMs > 0 asks the
  // sender to slow down (backpressure) and is honoured by our gateways.
  handle(gateway, payload, rx = Date.now()) {
    const { metrics, config, state, writer } = this;
    const res = { ok: true, accepted: 0, dup: 0, ooo: 0, rejected: 0, limited: 0, retryAfterMs: 0 };

    const parsedBatch = batchSchema.safeParse(payload);
    if (!parsedBatch.success) {
      metrics.reject('bad_batch');
      return { ...res, ok: false, rejected: 1, error: 'payload must be an array of 1-500 readings' };
    }
    const batch = parsedBatch.data;
    metrics.c.received.add(batch.length, rx);

    // Load shedding: the write queue is full, refuse the whole batch.
    if (writer.depth >= config.queueHardCap) {
      metrics.c.shed.add(batch.length, rx);
      return { ...res, ok: false, limited: batch.length, retryAfterMs: 2000, error: 'overloaded' };
    }

    const gwWait = this.gatewayBucket(gateway.id).take(batch.length, rx);
    if (gwWait > 0) {
      metrics.c.rateLimited.add(batch.length, rx);
      return { ...res, ok: false, limited: batch.length, retryAfterMs: gwWait, error: 'rate limited' };
    }

    for (const raw of batch) {
      const p = readingSchema.safeParse(raw);
      if (!p.success) {
        res.rejected++;
        metrics.reject('schema');
        continue;
      }
      const r = p.data;
      const st = state.get(r.sid);
      if (!st) {
        res.rejected++;
        metrics.reject('unknown_device');
        continue;
      }
      if (gateway.zone !== '*' && st.gateway !== gateway.id) {
        res.rejected++;
        metrics.reject('wrong_gateway');
        continue;
      }
      if (Math.abs(r.ts - rx) > MAX_CLOCK_SKEW_MS) {
        res.rejected++;
        metrics.reject('clock_skew');
        continue;
      }
      if (this.sensorBucket(r.sid).take(1, rx) > 0) {
        res.limited++;
        metrics.c.rateLimited.add(1, rx);
        continue;
      }

      const verdict = state.classify(st, r.seq);
      if (verdict === 'dup') {
        res.dup++;
        metrics.c.duplicate.add(1, rx);
        continue;
      }
      state.remember(st, r.seq);

      const m = r.m;
      writer.push({
        sid: r.sid, seq: r.seq, ts: new Date(r.ts), rx: new Date(rx),
        t: m.t, h: m.h, s: m.s, co: m.co, ws: m.ws, wd: m.wd, b: m.b, rssi: m.rssi,
      });
      this.rollups.add(st, r, state.windFor(st));
      metrics.ingestLagMs.add(Math.max(0, rx - r.ts));

      if (verdict === 'ooo') {
        // Kept for history, never allowed to overwrite newer live state.
        res.ooo++;
        metrics.c.outOfOrder.add(1, rx);
        continue;
      }
      state.apply(st, r, rx);
      this.onReading(st, r, rx);
      res.accepted++;
    }

    metrics.c.accepted.add(res.accepted + res.ooo, rx);
    if (writer.depth >= config.queueHighWater) {
      res.retryAfterMs = Math.max(res.retryAfterMs, 250 + Math.round((writer.depth / config.queueHighWater) * 250));
    }
    return res;
  }
}
