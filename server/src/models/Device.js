import mongoose from 'mongoose';

const deviceSchema = new mongoose.Schema(
  {
    _id: { type: String },
    type: { type: String, enum: ['sensor', 'station'], required: true },
    zone: { type: String, required: true, index: true },
    lat: Number,
    lng: Number,
    site: String,
    gateway: String,
    neighbours: { type: [String], default: [] },
    lastSeq: { type: Number, default: -1 },
    lastSeen: Date,
  },
  { timestamps: true, versionKey: false },
);

export const Device = mongoose.model('Device', deviceSchema);
