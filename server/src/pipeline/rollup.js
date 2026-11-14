import { Rollup } from '../models/Rollup.js';
import { Reading } from '../models/Reading.js';
import { log } from '../obs/log.js';

const MINUTE = 60000;

export class Rollups {
  constructor({ flushMs = 5000 } = {}) {
    this.flushMs = flushMs;
    this.buckets = new Map();
    this.busy = null;
  }
  add(st, r) {
    if (st?.type !== 'sensor') return;
    const b = Math.floor(Number(r.ts) / MINUTE) * MINUTE;
    this.buckets.set(`${st.id}|${b}`, { sid: st.id, zone: st.zone, b });
  }
  start() {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
  }
  async stop() {
    clearInterval(this.timer);
    if (this.busy) await this.busy;
    await this.flush();
  }
  flush() {
    if (this.busy) return this.busy;
    if (!this.buckets.size) return Promise.resolve();
    const items = [...this.buckets.values()];
    this.buckets.clear();
    this.busy = (async () => {
      try {
        const min = Math.min(...items.map((a) => a.b)),
          max = Math.max(...items.map((a) => a.b)) + MINUTE;
        const rows = await Reading.aggregate([
          {
            $match: {
              sid: { $in: [...new Set(items.map((a) => a.sid))] },
              ts: { $gte: new Date(min), $lt: new Date(max) },
            },
          },
          {
            $group: {
              _id: { sid: '$sid', b: { $dateTrunc: { date: '$ts', unit: 'minute' } } },
              n: { $sum: 1 },
              tSum: { $sum: '$t' },
              tMax: { $max: '$t' },
              hSum: { $sum: '$h' },
              hMin: { $min: '$h' },
              sSum: { $sum: { $ifNull: ['$s', 0] } },
              sMax: { $max: '$s' },
              fdiMax: { $max: '$fdi' },
              lastSeq: { $max: '$seq' },
            },
          },
        ]).option({ maxTimeMS: 15000 });
        const zones = new Map(items.map((a) => [a.sid, a.zone]));
        if (rows.length)
          await Rollup.bulkWrite(
            rows.map(({ _id, ...a }) => ({
              updateOne: {
                filter: { sid: _id.sid, b: _id.b },
                update: {
                  $set: {
                    ...a,
                    fdiMax: a.fdiMax ?? 0,
                    sMax: a.sMax ?? 0,
                    zone: zones.get(_id.sid),
                  },
                },
                upsert: true,
              },
            })),
            { ordered: false },
          );
      } catch (err) {
        for (const a of items) this.buckets.set(`${a.sid}|${a.b}`, a);
        log.warn({ error: err.message }, 'rollup rebuild will retry');
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }
}
