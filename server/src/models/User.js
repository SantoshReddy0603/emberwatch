import mongoose from 'mongoose';

export const ROLES = ['admin', 'operator', 'ranger'];

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // Rangers only see the zones listed here. Admins and operators see all.
    zones: { type: [String], default: [] },
  },
  { timestamps: true },
);

export const User = mongoose.model('User', userSchema);
