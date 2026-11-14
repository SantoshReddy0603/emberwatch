import { useSyncExternalStore } from 'react';
import { decodeRow } from '@emberwatch/shared';
import { mergeSamples, POINT_CAP } from './history.js';

const stateRank = { open: 0, ack: 1, resolved: 2 };

export class TelemetryStore {
  constructor() {
    this.listeners = new Set();
    this.byIndex = new Map();
    this.alerts = new Map();
    this.detail = new Map();
    this.preFrames = new Map();
    this.zones = new Set();
    this.selected = null;
    this.history = { points: [], lastSeq: -1, mode: 'raw' };
    this.metrics = null;
    this.epoch = null;
    this.connected = false;
    this.dirty = false;
    this.version = 0;
    this.values = this.build();
    this.alertBuffer = new Map();
    this.bufferAlerts = false;
  }
  build() {
    return {
      version: this.version,
      devices: [...this.byIndex.values()],
      alerts: [...this.alerts.values()]
        .sort((a, b) => Number(new Date(b.openedAt)) - Number(new Date(a.openedAt)))
        .slice(0, 250),
      metrics: this.metrics,
      connected: this.connected,
      selected: this.selected,
      points: mergeSamples(this.history, [...this.detail.values()]),
      historyMode: this.history.mode,
      historyTruncated: this.history.truncated,
      epoch: this.epoch,
    };
  }
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.values;
  touch() {
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.version++;
    this.values = this.build();
    for (const fn of this.listeners) fn();
  }
  start() {
    this.timer = setInterval(() => {
      if (document.visibilityState !== 'hidden' && this.dirty && !this.raf)
        this.raf = requestAnimationFrame(() => {
          this.raf = null;
          this.flush();
        });
    }, 250);
  }
  stop() {
    clearInterval(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
  scope(zones, selected) {
    this.zones = new Set(zones);
    for (const [idx, d] of this.byIndex) if (!this.zones.has(d.zone)) this.byIndex.delete(idx);
    for (const [id, a] of this.alerts) if (!this.zones.has(a.zone)) this.alerts.delete(id);
    if (selected !== this.selected) {
      this.selected = selected;
      this.detail.clear();
      this.history = { points: [], lastSeq: -1, mode: 'raw' };
    }
    this.touch();
    this.flush();
  }
  setSnapshot(value) {
    if (this.epoch && this.epoch !== value.epoch) {
      this.byIndex.clear();
      this.detail.clear();
      this.history = { points: [], lastSeq: -1, mode: 'raw' };
    }
    this.epoch = value.epoch;
    for (const d of value.devices) {
      if (!this.zones.has(d.zone)) continue;
      const old = this.byIndex.get(d.idx);
      if (!old || d.seq > old.seq || (d.seq === old.seq && value.ts >= (old._at || 0)))
        this.byIndex.set(d.idx, { ...old, ...d, _at: value.ts });
    }
    for (const frame of this.preFrames.values()) this.frame(frame);
    this.preFrames.clear();
    this.touch();
  }
  frame(frame) {
    if (!this.zones.has(frame.zone)) return;
    if (!this.epoch || frame.epoch !== this.epoch) {
      this.preFrames.set(frame.zone, frame);
      return;
    }
    for (const row of frame.rows) {
      const p = decodeRow(row, frame.ts),
        old = this.byIndex.get(p.idx);
      if (!old || p.seq < old.seq || (p.seq === old.seq && frame.ts < (old._at || 0))) continue;
      const merged = { ...old, ...p, _at: frame.ts };
      this.byIndex.set(p.idx, merged);
      if (merged.id === this.selected && p.seq >= 0) this.addPoint({ ...merged, sid: merged.id });
    }
    this.touch();
  }
  sensor(value) {
    if (value.id !== this.selected || value.epoch !== this.epoch || !this.zones.has(value.zone))
      return;
    this.addPoint({ ...value, sid: value.id });
    const old = this.byIndex.get(value.idx);
    if (!old || value.seq > old.seq || (value.seq === old.seq && (value.at || 0) >= (old._at || 0)))
      this.byIndex.set(value.idx, { ...old, ...value, _at: value.at || 0 });
    this.touch();
  }
  addPoint(p) {
    if (p.seq < 0) return;
    this.detail.set(p.seq, { ...this.detail.get(p.seq), ...p });
    while (this.detail.size > POINT_CAP) this.detail.delete(this.detail.keys().next().value);
  }
  setHistory(value) {
    if (value.source !== this.selected) return;
    this.history = value;
    for (const seq of this.detail.keys()) if (seq <= value.lastSeq) this.detail.delete(seq);
    this.touch();
  }
  alert(value) {
    if (!this.zones.has(value.zone)) return;
    const id = String(value._id),
      old = this.alerts.get(id);
    if (this.bufferAlerts) this.alertBuffer.set(id, value);
    const time = Number(new Date(value.updatedAt || value.openedAt)),
      previous = old ? Number(new Date(old.updatedAt || old.openedAt)) : -1;
    if (time > previous || (time === previous && stateRank[value.state] >= stateRank[old?.state]))
      this.alerts.set(id, value);
    if (this.alerts.size > 500) {
      const keep = [...this.alerts.values()]
        .sort((a, b) => Number(new Date(b.openedAt)) - Number(new Date(a.openedAt)))
        .slice(0, 500);
      this.alerts = new Map(keep.map((a) => [String(a._id), a]));
    }
    this.touch();
  }
  beginAlertSnapshot() {
    this.bufferAlerts = true;
    this.alertBuffer.clear();
  }
  setAlertSnapshot(alerts) {
    const buffered = [...this.alertBuffer.values()];
    this.bufferAlerts = false;
    this.alertBuffer.clear();
    for (const [id, a] of this.alerts)
      if (this.zones.has(a.zone) && a.state !== 'resolved') this.alerts.delete(id);
    for (const a of alerts) this.alert(a);
    for (const a of buffered) this.alert(a);
    this.touch();
  }
  setMetrics(value) {
    this.metrics = value;
    this.touch();
  }
  status(connected) {
    this.connected = connected;
    this.touch();
    this.flush();
  }
}

export const telemetry = new TelemetryStore();
export const useTelemetry = () => useSyncExternalStore(telemetry.subscribe, telemetry.getSnapshot);
