import { hashKey, safeEqualHex } from '@emberwatch/shared/keys';
import { Gateway } from '../models/Gateway.js';

// Gateway credentials are cached in memory; they change only on re-seed.
export class GatewayRegistry {
  constructor() {
    this.byId = new Map();
  }

  async load() {
    const rows = await Gateway.find({}).lean();
    this.byId = new Map(rows.map((g) => [g._id, { id: g._id, zone: g.zone, kind: g.kind, keyHash: g.keyHash }]));
    return this.byId.size;
  }

  verify(id, key) {
    const gw = this.byId.get(id);
    if (!gw || typeof key !== 'string' || key.length > 200) return null;
    return safeEqualHex(hashKey(key), gw.keyHash) ? gw : null;
  }
}
