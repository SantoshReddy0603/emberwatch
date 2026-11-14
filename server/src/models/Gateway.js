import mongoose from 'mongoose';

// Field gateways relay readings from the sensors in their zone. Each one
// authenticates with its own key; only a SHA-256 hash is stored.
const gatewaySchema = new mongoose.Schema(
  {
    _id: { type: String },
    zone: { type: String, required: true },
    keyHash: { type: String, required: true },
    kind: { type: String, enum: ['gateway', 'controller'], default: 'gateway' },
    lastSeen: Date,
  },
  { timestamps: true, versionKey: false },
);

export const Gateway = mongoose.model('Gateway', gatewaySchema);
