import mongoose from 'mongoose';
import { config } from '../config.js';

// One document per sensor per minute. Sums are stored instead of averages so
// that partial flushes can be merged with $inc.
const rollupSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true },
    zone: { type: String, required: true },
    b: { type: Date, required: true },
    n: Number,
    tSum: Number,
    tMax: Number,
    hSum: Number,
    hMin: Number,
    sSum: Number,
    sMax: Number,
    fdiMax: Number,
    lastSeq: Number,
  },
  { versionKey: false, collection: 'rollups_1m' },
);

rollupSchema.index({ sid: 1, b: 1 }, { unique: true });
rollupSchema.index({ b: 1, zone: 1 });
rollupSchema.index({ b: 1 }, { expireAfterSeconds: Math.round(config.rollupTtlHours * 3600), name: 'ttl_b' });

export const Rollup = mongoose.model('Rollup', rollupSchema);
