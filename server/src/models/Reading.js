import mongoose from 'mongoose';
import { config } from '../config.js';

// Raw telemetry. Keys are short on purpose: at thousands of events per second
// every byte per document counts for storage and index size.
const readingSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true },
    seq: { type: Number, required: true },
    ts: { type: Date, required: true },
    rx: { type: Date, required: true },
    t: Number,
    h: Number,
    s: Number,
    co: Number,
    ws: Number,
    wd: Number,
    b: Number,
    rssi: Number,
  },
  { versionKey: false, collection: 'readings' },
);

// (sid, seq) is the event identity; the unique index makes duplicate inserts
// fail at the database even if the in-memory dedup misses them.
readingSchema.index({ sid: 1, seq: 1 }, { unique: true });
readingSchema.index({ sid: 1, ts: -1 });
readingSchema.index({ rx: 1 }, { expireAfterSeconds: Math.round(config.rawTtlMinutes * 60) });

export const Reading = mongoose.model('Reading', readingSchema);
