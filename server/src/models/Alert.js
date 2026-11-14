import mongoose from 'mongoose';

export const ALERT_TYPES = ['ignition', 'smoke', 'temp_spike', 'low_humidity', 'wind_gust', 'offline'];

const alertSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true },
    zone: { type: String, required: true },
    type: { type: String, enum: ALERT_TYPES, required: true },
    severity: { type: String, enum: ['warning', 'critical'], required: true },
    state: { type: String, enum: ['open', 'ack', 'resolved'], default: 'open' },
    active: { type: Boolean, default: true },
    title: String,
    detail: String,
    value: Number,
    unit: String,
    z: Number,
    confirmCount: { type: Number, default: 0 },
    spread: { bearing: Number, kmh: Number },
    openedAt: { type: Date, required: true },
    updatedAt: Date,
    resolvedAt: Date,
    ackBy: String,
    ackAt: Date,
    timeline: [{ _id: false, ts: Date, msg: String }],
  },
  { versionKey: false },
);

alertSchema.index({ state: 1, openedAt: -1 });
alertSchema.index({ zone: 1, openedAt: -1 });
alertSchema.index({ sid: 1, openedAt: -1 });
alertSchema.index({ sid: 1, type: 1 }, { unique: true, partialFilterExpression: { active: true } });

export const Alert = mongoose.model('Alert', alertSchema);
