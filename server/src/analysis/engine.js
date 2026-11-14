import mongoose from 'mongoose';
import { STATUS, distanceM, bearingOf, toXY } from '@emberwatch/shared';
import { Alert } from '../models/Alert.js';
import { log } from '../obs/log.js';

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : 0;
};

export class Baseline {
  constructor(floor) {
    this.floor = floor;
    this.values = [];
    this.mean = null;
    this.variance = 0;
  }
  score(value) {
    if (this.values.length < 12) return 0;
    const center = median(this.values);
    const mad = median(this.values.map((v) => Math.abs(v - center)));
    return (value - center) / Math.max(this.floor, 1.4826 * mad, Math.sqrt(this.variance) * 0.5);
  }
  add(value) {
    const delta = value - (this.mean ?? value);
    this.mean = this.mean === null ? value : this.mean + 0.08 * delta;
    this.variance = 0.92 * (this.variance + 0.08 * delta * delta);
    this.values.push(value);
    if (this.values.length > 60) this.values.shift();
  }
}

export class AnomalyEngine {
  constructor({
    state,
    metrics,
    offlineAfterMs,
    onAlert = () => {},
    dwellMs = 1000,
    recoveryMs = 5000,
  }) {
    Object.assign(this, { state, metrics, offlineAfterMs, onAlert, dwellMs, recoveryMs });
    this.baselines = new Map();
    this.conditions = new Map();
    this.active = new Map();
    this.dirty = new Set();
    this.tripped = new Map();
    this.startedAt = Date.now();
    this.busy = null;
    this.timer = null;
    this.counted = new WeakSet();
  }
  async load() {
    for (const alert of await Alert.find({ state: { $in: ['open', 'ack'] } }).lean()) {
      if (this.state.get(alert.sid)) {
        this.active.set(`${alert.sid}:${alert.type}`, alert);
        this.counted.add(alert);
      }
    }
    for (const st of this.state.list) {
      const active = [...this.active.values()].filter(
        (a) => a.sid === st.id && a.type !== 'offline',
      );
      st.status =
        !st.lastSeen || Date.now() - st.lastSeen > this.offlineAfterMs
          ? STATUS.OFFLINE
          : active.some((a) => a.severity === 'critical')
            ? STATUS.CRITICAL
            : active.length
              ? STATUS.ELEVATED
              : STATUS.NORMAL;
      this.state.markDirty(st);
    }
  }
  start() {
    this.timer = setInterval(() => {
      this.sweep();
      void this.flush().catch(() => {});
    }, 1000);
  }
  async stop() {
    clearInterval(this.timer);
    let timeout;
    try {
      await Promise.race([
        (async () => {
          if (this.busy) await this.busy;
          while (this.dirty.size) await this.flush();
        })(),
        new Promise((_yes, no) => {
          timeout = setTimeout(() => no(new Error('Incident shutdown drain timed out')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  addNote(alert, msg, now) {
    alert.timeline = [...(alert.timeline || []), { ts: new Date(now), msg }].slice(-50);
  }
  condition(st, type, tripped, recovered, details, now, dwell = this.dwellMs) {
    const key = `${st.id}:${type}`;
    let c = this.conditions.get(key);
    if (!c) {
      c = { since: null, clear: null, last: now };
      this.conditions.set(key, c);
    }
    if (now - c.last > this.offlineAfterMs) {
      c.since = null;
      c.clear = null;
    }
    c.last = now;
    let alert = this.active.get(key);
    if (tripped) {
      c.clear = null;
      c.since ??= now;
      if (!alert && now - c.since >= dwell) {
        alert = {
          _id: new mongoose.Types.ObjectId(),
          sid: st.id,
          zone: st.zone,
          type,
          state: 'open',
          active: true,
          openedAt: new Date(now),
          updatedAt: new Date(now),
          timeline: [],
          ...details,
        };
        this.addNote(alert, details.title, now);
        this.active.set(key, alert);
        this.dirty.add(alert);
      } else if (
        alert &&
        (details.severity !== alert.severity || now - new Date(alert.updatedAt).getTime() >= 2000)
      ) {
        if (details.severity !== alert.severity)
          this.addNote(alert, `Severity changed to ${details.severity}`, now);
        Object.assign(alert, details, { updatedAt: new Date(now) });
        this.dirty.add(alert);
      }
    } else {
      c.since = null;
      if (alert && recovered) {
        c.clear ??= now;
        if (now - c.clear >= this.recoveryMs) {
          Object.assign(alert, {
            state: 'resolved',
            active: false,
            resolvedAt: new Date(now),
            updatedAt: new Date(now),
          });
          this.addNote(alert, 'Fresh readings confirmed recovery', now);
          this.dirty.add(alert);
          this.active.delete(key);
          c.clear = null;
        }
      } else c.clear = null;
    }
    return alert?.state !== 'resolved' ? alert : null;
  }
  onReading(st, r, now) {
    let b = this.baselines.get(st.id);
    if (!b) {
      b = { t: new Baseline(1.5), s: new Baseline(8) };
      this.baselines.set(st.id, b);
    }
    const tz = b.t.score(st.t),
      sz = st.s === null ? 0 : b.s.score(st.s);
    st.z = Math.max(tz, sz, 0);
    const tempTrip = st.t >= 50 || (tz >= 4 && st.t - b.t.mean >= 8);
    const smokeTrip = st.s !== null && (st.s >= 80 || (sz >= 5 && st.s >= 25));
    const fireTrip = st.type === 'sensor' && st.t >= 45 && (st.s ?? 0) >= 50;
    if (fireTrip && !this.tripped.has(st.id)) this.tripped.set(st.id, now);
    if (!fireTrip && st.t < 40 && (st.s ?? 0) < 30) this.tripped.delete(st.id);
    const neighbours = st.neighbours
      .map((id) => this.state.get(id))
      .filter(
        (n) =>
          n &&
          n.zone === st.zone &&
          this.tripped.has(n.id) &&
          now - n.lastSeen < this.offlineAfterMs,
      );
    let spread;
    const prior = neighbours
      .filter((n) => this.tripped.get(n.id) < (this.tripped.get(st.id) ?? now))
      .sort((a, b) => this.tripped.get(a.id) - this.tripped.get(b.id))[0];
    if (prior) {
      const a = toXY(prior),
        p = toXY(st),
        dt = this.tripped.get(st.id) - this.tripped.get(prior.id);
      spread = {
        bearing: bearingOf(p.x - a.x, p.y - a.y),
        ...(dt >= 5000 ? { kmh: Math.round((distanceM(prior, st) / dt) * 36000) / 10 } : {}),
      };
    }
    const common = { severity: 'warning', z: Math.round(st.z * 10) / 10 };
    this.condition(
      st,
      'temp_spike',
      tempTrip,
      st.t < 43 && tz < 2,
      {
        ...common,
        title: `Temperature rise · ${st.id}`,
        detail: 'Sustained high temperature or baseline deviation',
        value: st.t,
        unit: '°C',
      },
      now,
    );
    if (st.type === 'sensor') {
      this.condition(
        st,
        'smoke',
        smokeTrip,
        (st.s ?? 0) < 30 && sz < 2,
        {
          ...common,
          title: `Smoke detected · ${st.id}`,
          detail: 'Sustained smoke concentration or baseline deviation',
          value: st.s,
          unit: 'ppm',
        },
        now,
      );
      this.condition(
        st,
        'ignition',
        fireTrip,
        st.t < 40 && (st.s ?? 0) < 30,
        {
          ...common,
          severity: neighbours.length >= 2 ? 'critical' : 'warning',
          title: `Ignition suspected · ${st.id}`,
          detail: `${neighbours.length} neighbouring sensors confirm`,
          value: st.s,
          unit: 'ppm',
          confirmCount: neighbours.length,
          spread: spread ?? null,
        },
        now,
      );
    } else {
      this.condition(
        st,
        'low_humidity',
        st.h < 15,
        st.h > 20,
        {
          ...common,
          title: `Low humidity · ${st.id}`,
          detail: 'Station humidity below 15%',
          value: st.h,
          unit: '%',
        },
        now,
        5000,
      );
      this.condition(
        st,
        'wind_gust',
        (st.ws ?? 0) >= 45,
        (st.ws ?? 0) < 35,
        {
          ...common,
          title: `Wind gust · ${st.id}`,
          detail: 'Station wind above 45 km/h',
          value: st.ws,
          unit: 'km/h',
        },
        now,
      );
    }
    this.condition(st, 'offline', false, true, {}, now, 0);
    const alerts = [...this.active.values()].filter((a) => a.sid === st.id && a.type !== 'offline');
    st.status = alerts.some((a) => a.severity === 'critical')
      ? STATUS.CRITICAL
      : alerts.length
        ? STATUS.ELEVATED
        : STATUS.NORMAL;
    if (!tempTrip && !smokeTrip && !fireTrip) {
      b.t.add(st.t);
      if (st.s !== null) b.s.add(st.s);
    }
    this.state.markDirty(st);
  }
  sweep(now = Date.now()) {
    if (now - this.startedAt < this.offlineAfterMs) return;
    for (const st of this.state.list) {
      if (now - (st.lastSeen || this.startedAt) <= this.offlineAfterMs) continue;
      if (st.status !== STATUS.OFFLINE) {
        st.status = STATUS.OFFLINE;
        this.state.markDirty(st);
      }
      this.condition(
        st,
        'offline',
        true,
        false,
        {
          severity: 'warning',
          title: `Source offline · ${st.id}`,
          detail: 'No fresh telemetry for the configured timeout',
          value: Math.round((now - (st.lastSeen || this.startedAt)) / 1000),
          unit: 's',
        },
        now,
        0,
      );
    }
  }
  flush() {
    if (this.busy) return this.busy;
    if (!this.dirty.size) return Promise.resolve();
    const snapshots = [...this.dirty].map((a) => ({ source: a, document: structuredClone(a) }));
    this.dirty.clear();
    this.busy = (async () => {
      try {
        for (const { source, document } of snapshots) {
          const { _id, ...fields } = document;
          await Alert.updateOne(
            { _id: source._id },
            { $set: fields },
            { upsert: true, runValidators: true, maxTimeMS: 5000 },
          );
          if (!this.counted.has(source)) {
            this.metrics.c.alerts.add(1);
            this.counted.add(source);
          }
          this.onAlert({ ...fields, _id: String(source._id) });
        }
      } catch (err) {
        for (const { source } of snapshots) this.dirty.add(source);
        log.warn({ error: err.message }, 'alert persistence will retry');
        throw err;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }
  async acknowledge(id, user) {
    const alert = [...this.active.values()].find((a) => String(a._id) === id);
    if (!alert) return Alert.findById(id).lean();
    if (alert.state === 'open') {
      alert.state = 'ack';
      alert.ackBy = user.id;
      alert.ackAt = new Date();
      alert.updatedAt = alert.ackAt;
      this.addNote(alert, `Acknowledged by ${user.name}`, Date.now());
      this.dirty.add(alert);
    }
    await this.flush();
    if (this.dirty.size) await this.flush();
    return { ...alert, _id: String(alert._id) };
  }
}
