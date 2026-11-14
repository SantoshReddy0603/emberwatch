import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUS, encodeRow, decodeRow, fireDangerIndex } from '@emberwatch/shared';
import { TokenBucket } from '../src/ingest/tokenBucket.js';
import { StateStore } from '../src/pipeline/stateStore.js';
import { Ingestor } from '../src/ingest/ingestor.js';
import { Writer } from '../src/pipeline/writer.js';
import { Reading } from '../src/models/Reading.js';
import { Device } from '../src/models/Device.js';
import { Alert } from '../src/models/Alert.js';
import { createMetrics } from '../src/obs/metrics.js';
import { AnomalyEngine, Baseline } from '../src/analysis/engine.js';

const meters = [];
const makeMetrics = () => {
  const m = createMetrics();
  meters.push(m);
  return m;
};
afterEach(() => {
  meters.splice(0).forEach((m) => m.stop());
  vi.restoreAllMocks();
});
const dev = (id = 'N-001', extra = {}) => ({
  id,
  type: 'sensor',
  zone: 'north',
  gateway: 'GW-N1',
  lat: 37.2,
  lng: -119.28,
  neighbours: [],
  ...extra,
});
const reading = (seq, m = {}, ts = Date.now()) => ({
  sid: 'N-001',
  seq,
  ts,
  m: { t: 30, h: 35, s: 4, ...m },
});

function rig(overrides = {}) {
  const state = new StateStore([dev()]),
    metrics = makeMetrics();
  const writer = {
    queue: [],
    get depth() {
      return this.queue.length;
    },
    push(r) {
      this.queue.push(r);
    },
  };
  const config = {
    bucketCapacity: 100,
    bucketRefillPerSec: 100,
    gatewayBucketCapacity: 1000,
    gatewayBucketRefillPerSec: 1000,
    queueHighWater: 50,
    queueHardCap: 100,
    ...overrides,
  };
  const ingestor = new Ingestor({ state, metrics, writer, config, rollups: {} });
  return {
    state,
    metrics,
    writer,
    ingestor,
    gateway: { id: 'GW-N1', zone: 'north', kind: 'gateway' },
  };
}

describe('admission and ordering', () => {
  it('refills a bounded token bucket and gives a retry delay', () => {
    const b = new TokenBucket(2, 2, 1000);
    expect(b.take(2, 1000)).toBe(0);
    expect(b.take(1, 1000)).toBe(500);
    expect(b.take(1, 1500)).toBe(0);
    expect(b.take(2, 100000)).toBe(0);
    expect(b.take(1, 100000)).toBe(500);
  });
  it('rejects malformed and foreign-gateway readings', () => {
    const r = rig();
    expect(r.ingestor.handle(r.gateway, [reading(1, { h: 101 })]).rejected).toBe(1);
    expect(r.ingestor.handle({ id: 'OTHER', zone: 'east' }, [reading(1)]).rejected).toBe(1);
    expect(r.writer.depth).toBe(0);
  });
  it('does not advance current state or queue a recently duplicated event', () => {
    const r = rig(),
      event = reading(2);
    expect(r.ingestor.handle(r.gateway, [event]).accepted).toBe(1);
    expect(r.ingestor.handle(r.gateway, [event]).dup).toBe(1);
    expect(r.writer.depth).toBe(1);
    expect(r.state.get('N-001').seq).toBe(2);
  });
  it('retains unseen late records without regressing latest readings', () => {
    const r = rig();
    r.ingestor.handle(r.gateway, [reading(3, { t: 31 })]);
    expect(r.ingestor.handle(r.gateway, [reading(1, { t: 70 })]).ooo).toBe(1);
    expect(r.writer.depth).toBe(2);
    expect(r.state.get('N-001').t).toBe(31);
  });
  it('reserves room for the complete batch at the hard cap', () => {
    const r = rig({ queueHardCap: 2 });
    r.ingestor.handle(r.gateway, [reading(1)]);
    expect(r.ingestor.handle(r.gateway, [reading(2), reading(3)]).accepted).toBe(0);
    expect(r.writer.depth).toBe(1);
  });
  it('rejects clocks beyond the allowed skew and enforces source limits', () => {
    const r = rig({ bucketCapacity: 1, bucketRefillPerSec: 1 });
    expect(r.ingestor.handle(r.gateway, [reading(1, {}, Date.now() + 3600000)]).rejected).toBe(1);
    const now = Date.now();
    expect(
      r.ingestor.handle(r.gateway, [reading(2, {}, now), reading(3, {}, now)], now).limited,
    ).toBe(1);
  });
});

describe('storage reservations', () => {
  it('counts in-flight work and retains it after a failed write', async () => {
    let reject;
    vi.spyOn(Reading.collection, 'insertMany').mockImplementation(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const writer = new Writer({
      metrics: makeMetrics(),
      intervalMs: 500,
      batchMax: 10,
      hardCap: 2,
      state: {},
    });
    writer.push({ sid: 'N-001', seq: 1, rx: new Date() });
    const flush = writer.flush();
    expect(writer.depth).toBe(1);
    expect(writer.pending).toHaveLength(1);
    reject(new Error('database unavailable'));
    await flush;
    expect(writer.depth).toBe(1);
    expect(writer.queue[0].seq).toBe(1);
    const save = vi.spyOn(Device, 'bulkWrite');
    await writer.saveCursors();
    expect(save).not.toHaveBeenCalled();
  });
  it('retries saving a durable cursor after a database error', async () => {
    const write = vi
      .spyOn(Device, 'bulkWrite')
      .mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValueOnce({});
    const writer = new Writer({ metrics: makeMetrics(), state: {} });
    writer.persisted.set('N-001', { seq: 4, rx: new Date() });
    await writer.saveCursors();
    await writer.saveCursors();
    expect(write).toHaveBeenCalledTimes(2);
    expect(writer.saved.get('N-001')).toBe(4);
  });
});

describe('compact telemetry', () => {
  it('round trips identity, source time, status, and temperature precision', () => {
    const st = { seq: 12, t: 31.27, h: 40.4, s: 8.2, fdi: 52, status: STATUS.ELEVATED, ts: 9000 };
    expect(decodeRow(encodeRow(3, st, 10000), 10000)).toEqual({
      idx: 3,
      seq: 12,
      t: 31.3,
      h: 40,
      s: 8,
      fdi: 52,
      status: 1,
      ts: 9000,
    });
  });
  it('preserves unavailable readings instead of fabricating zero', () => {
    expect(
      decodeRow(
        encodeRow(0, { seq: -1, t: null, h: null, s: null, ts: 0, status: STATUS.OFFLINE }, 1000),
        1000,
      ).t,
    ).toBeNull();
  });
  it('bounds the existing composite danger index', () => {
    expect(fireDangerIndex(NaN, 10, 20)).toBe(0);
    expect(fireDangerIndex(100, 1, 200)).toBe(100);
    expect(fireDangerIndex(20, 90, -10)).toBeGreaterThanOrEqual(0);
  });
});

describe('incident evidence', () => {
  it('restores critical status before a restarted server publishes snapshots', async () => {
    const r = rig(),
      st = r.state.get('N-001'),
      now = Date.now();
    r.state.apply(st, reading(1, {}, now), now);
    vi.spyOn(Alert, 'find').mockReturnValue({
      lean: async () => [
        {
          _id: '507f1f77bcf86cd799439011',
          sid: st.id,
          type: 'ignition',
          state: 'open',
          severity: 'critical',
        },
      ],
    });
    const engine = new AnomalyEngine({ state: r.state, metrics: r.metrics, offlineAfterMs: 10000 });
    await engine.load();
    expect(st.status).toBe(STATUS.CRITICAL);
  });
  it('drains a recovery queued while an earlier incident write is in flight', async () => {
    const r = rig();
    const engine = new AnomalyEngine({ state: r.state, metrics: r.metrics, offlineAfterMs: 10000 });
    const alert = {
      _id: '507f1f77bcf86cd799439011',
      sid: 'N-001',
      zone: 'north',
      type: 'ignition',
      state: 'open',
      severity: 'critical',
      timeline: [],
    };
    const states = [];
    let release;
    vi.spyOn(Alert, 'updateOne')
      .mockImplementationOnce((_filter, update) => {
        states.push(update.$set.state);
        return new Promise((yes) => {
          release = yes;
        });
      })
      .mockImplementation((_filter, update) => {
        states.push(update.$set.state);
        return Promise.resolve({});
      });
    engine.dirty.add(alert);
    const first = engine.flush();
    alert.state = 'resolved';
    alert.active = false;
    engine.dirty.add(alert);
    const stop = engine.stop();
    release({});
    await first;
    await stop;
    expect(states).toEqual(['open', 'resolved']);
    expect(engine.dirty.size).toBe(0);
  });
  it('does not call normal baseline noise anomalous', () => {
    const b = new Baseline(1.5);
    for (let i = 0; i < 60; i++) b.add(30 + (i % 2 ? 0.1 : -0.1));
    expect(Math.abs(b.score(30.1))).toBeLessThan(1);
    expect(b.score(60)).toBeGreaterThan(10);
  });
  it('requires dwell, spatial confirmation, and sustained recovery', () => {
    const ids = ['N-001', 'N-002', 'N-003'];
    const state = new StateStore(
      ids.map((id, i) =>
        dev(id, { lat: 37.2 + i * 0.001, neighbours: ids.filter((n) => n !== id) }),
      ),
    );
    const engine = new AnomalyEngine({ state, metrics: makeMetrics(), offlineAfterMs: 10000 });
    const now = Date.now();
    const apply = (time, temperature, smoke) => {
      for (const st of state.list) {
        const r = { sid: st.id, seq: st.seq + 1, ts: time, m: { t: temperature, h: 20, s: smoke } };
        state.apply(st, r, time);
        engine.onReading(st, r, time);
      }
    };
    apply(now, 70, 300);
    expect(engine.active.size).toBe(0);
    apply(now + 1500, 70, 300);
    expect(state.list.every((s) => s.status === STATUS.CRITICAL)).toBe(true);
    const count = engine.active.size;
    apply(now + 2000, 70, 300);
    expect(engine.active.size).toBe(count);
    apply(now + 3000, 30, 4);
    expect(engine.active.size).toBe(count);
    apply(now + 8500, 30, 4);
    expect(engine.active.size).toBe(0);
  });
  it('does not resolve an active fire condition when telemetry stops', () => {
    const r = rig();
    const engine = new AnomalyEngine({
      state: r.state,
      metrics: r.metrics,
      offlineAfterMs: 10000,
      dwellMs: 0,
    });
    const now = Date.now(),
      st = r.state.get('N-001'),
      event = reading(1, { t: 70, s: 300 }, now);
    r.state.apply(st, event, now);
    engine.onReading(st, event, now);
    engine.sweep(now + 15000);
    expect(st.status).toBe(STATUS.OFFLINE);
    expect(engine.active.get('N-001:ignition').state).toBe('open');
    expect(engine.active.get('N-001:offline').state).toBe('open');
  });
});
