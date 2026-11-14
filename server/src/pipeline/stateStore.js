import { STATUS, fireDangerIndex } from '@emberwatch/shared';

const RECENT = 256;

// Latest known state of every device, plus the bookkeeping needed to classify
// each incoming event as new, duplicate or out-of-order.
export class StateStore {
  constructor(devices) {
    this.byId = new Map();
    this.list = [];
    this.zones = new Map();
    devices.forEach((d, idx) => {
      const st = {
        id: d.id,
        idx,
        type: d.type,
        zone: d.zone,
        lat: d.lat,
        lng: d.lng,
        site: d.site,
        gateway: d.gateway,
        neighbours: d.neighbours || [],
        seq: typeof d.lastSeq === 'number' ? d.lastSeq : -1,
        ts: 0,
        lastSeen: 0,
        t: null,
        h: null,
        s: null,
        co: null,
        ws: null,
        wd: null,
        b: null,
        rssi: null,
        fdi: 0,
        status: STATUS.OFFLINE,
        z: 0,
        // Ring of recently seen sequence numbers for duplicate detection.
        recent: new Set(),
        recentQ: new Array(RECENT),
        recentI: 0,
      };
      this.byId.set(d.id, st);
      this.list.push(st);
      if (!this.zones.has(d.zone)) this.zones.set(d.zone, []);
      this.zones.get(d.zone).push(st);
    });
    this.dirty = new Set();
    // Latest wind per zone from weather stations, used for sensor FDI.
    this.zoneWind = new Map();
  }

  get(id) {
    return this.byId.get(id);
  }

  // 'new'  - newer than anything seen, becomes the live state
  // 'ooo'  - older than current state but never seen; stored, not applied
  // 'dup'  - already seen
  classify(st, seq) {
    if (st.recent.has(seq)) return 'dup';
    if (seq > st.seq) return 'new';
    if (seq === st.seq) return 'dup';
    // Older than the tracked window: let the unique index decide.
    return 'ooo';
  }

  remember(st, seq) {
    const old = st.recentQ[st.recentI];
    if (old !== undefined) st.recent.delete(old);
    st.recentQ[st.recentI] = seq;
    st.recentI = (st.recentI + 1) % RECENT;
    st.recent.add(seq);
  }

  apply(st, r, rx) {
    st.seq = r.seq;
    st.ts = r.ts;
    st.lastSeen = rx;
    const m = r.m;
    st.t = m.t;
    st.h = m.h;
    if (m.s !== undefined) st.s = m.s;
    if (m.co !== undefined) st.co = m.co;
    if (m.ws !== undefined) st.ws = m.ws;
    if (m.wd !== undefined) st.wd = m.wd;
    if (m.b !== undefined) st.b = m.b;
    if (m.rssi !== undefined) st.rssi = m.rssi;
    if (st.status === STATUS.OFFLINE) st.status = STATUS.NORMAL;
    if (st.type === 'station' && st.ws !== null) this.zoneWind.set(st.zone, { ws: st.ws, wd: st.wd });
    st.fdi = fireDangerIndex(st.t, st.h, this.windFor(st));
    this.dirty.add(st);
  }

  windFor(st) {
    return st.ws ?? this.zoneWind.get(st.zone)?.ws ?? 0;
  }

  markDirty(st) {
    this.dirty.add(st);
  }

  takeDirty() {
    const d = this.dirty;
    this.dirty = new Set();
    return d;
  }
}
