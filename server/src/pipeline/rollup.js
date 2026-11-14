import { Rollup } from '../models/Rollup.js';
import { fireDangerIndex } from '@emberwatch/shared';
import { log } from '../obs/log.js';

const MINUTE = 60000;

// Aggregates readings into per-sensor one-minute buckets in memory and
// merges them into MongoDB every few seconds with $inc/$max/$min upserts.
export class Rollups {
  constructor({ flushMs = 5000 } = {}) {
    this.flushMs = flushMs;
    this.buckets = new Map();
    this.timer = null;
  }

  add(st, r, windKmh = 0) {
    if (st.type !== 'sensor') return;
    const b = Math.floor(r.ts / MINUTE) * MINUTE;
    const key = `${st.id}|${b}`;
    let a = this.buckets.get(key);
    if (!a) {
      a = { sid: st.id, zone: st.zone, b, n: 0, tSum: 0, tMax: -Infinity, hSum: 0, hMin: Infinity, sSum: 0, sMax: 0, fdiMax: 0, lastSeq: -1 };
      this.buckets.set(key, a);
    }
    const m = r.m;
    a.n++;
    a.tSum += m.t;
    a.tMax = Math.max(a.tMax, m.t);
    a.hSum += m.h;
    a.hMin = Math.min(a.hMin, m.h);
    a.sSum += m.s ?? 0;
    a.sMax = Math.max(a.sMax, m.s ?? 0);
    a.fdiMax = Math.max(a.fdiMax, fireDangerIndex(m.t, m.h, windKmh));
    a.lastSeq = Math.max(a.lastSeq, r.seq);
  }

  start() {
    this.timer = setInterval(() => this.flush(), this.flushMs);
  }

  async stop() {
    clearInterval(this.timer);
    await this.flush();
  }

  async flush() {
    if (!this.buckets.size) return;
    const items = [...this.buckets.values()];
    this.buckets.clear();
    const ops = items.map((a) => ({
      updateOne: {
        filter: { sid: a.sid, b: new Date(a.b) },
        update: {
          $setOnInsert: { zone: a.zone },
          $inc: { n: a.n, tSum: a.tSum, hSum: a.hSum, sSum: a.sSum },
          $max: { tMax: a.tMax, sMax: a.sMax, fdiMax: a.fdiMax, lastSeq: a.lastSeq },
          $min: { hMin: a.hMin },
        },
        upsert: true,
      },
    }));
    try {
      await Rollup.collection.bulkWrite(ops, { ordered: false });
    } catch (err) {
      log.warn({ err: err.message, n: ops.length }, 'rollup flush failed');
    }
  }
}
