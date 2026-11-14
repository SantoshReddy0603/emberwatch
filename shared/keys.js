// Node-only helpers for fleet credentials. Kept out of index.js so the
// browser bundle never pulls in node:crypto.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Gateway keys are derived from a provisioning secret, the way a fleet is
// flashed at the factory. The server stores only a hash of each key.
export function deriveKey(fleetSecret, id) {
  return createHmac('sha256', fleetSecret).update(`ew:${id}`).digest('hex');
}

export function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const CONTROLLER_ID = 'SIM-CTRL';
