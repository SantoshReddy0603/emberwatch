import { describe, expect, it } from 'vitest';
import { mergeSamples, sampleSeries, POINT_CAP } from './history.js';
import { TelemetryStore } from './store.js';
import { encodeRow } from '@emberwatch/shared';

const source = (extra = {}) => ({
  id: 'N-001',
  idx: 0,
  zone: 'north',
  type: 'sensor',
  seq: 5,
  ts: 5000,
  t: 30,
  h: 35,
  s: 4,
  status: 0,
  fdi: 50,
  ...extra,
});
const alert = (id, state = 'open', ts = 1000) => ({
  _id: id,
  zone: 'north',
  sid: 'N-001',
  state,
  severity: 'critical',
  openedAt: new Date(1000).toISOString(),
  updatedAt: new Date(ts).toISOString(),
});

describe('history and live handoff', () => {
  it('deduplicates snapshot overlap and applies only new post-cut live readings', () => {
    const history = {
      mode: 'raw',
      lastSeq: 5,
      points: [
        { seq: 4, ts: 4000, t: 29 },
        { seq: 5, ts: 5000, t: 30 },
      ],
    };
    const points = mergeSamples(history, [
      { seq: 5, ts: 5000, t: 30 },
      { seq: 6, ts: 6000, t: 31 },
      { seq: 3, ts: 3000, t: 28 },
    ]);
    expect(points.map((p) => p.seq)).toEqual([4, 5, 6]);
  });
  it('retains pre-cut future data and makes it visible when the clock reaches it', () => {
    const history = { lastSeq: 2, points: [{ seq: 1, ts: 1000 }], pending: [{ seq: 2, ts: 4000 }] };
    expect(mergeSamples(history, [], { to: 2000 }).map((p) => p.seq)).toEqual([1]);
    expect(mergeSamples(history, [], { to: 5000 }).map((p) => p.seq)).toEqual([1, 2]);
  });
  it('does not mix raw live samples into minute aggregates', () => {
    expect(
      mergeSamples({ mode: 'rollup', lastSeq: 5, points: [{ seq: 5, ts: 1000, n: 5 }] }, [
        { seq: 6, ts: 2000 },
      ]),
    ).toHaveLength(1);
  });
  it('preserves a brief spike when reducing a large chart', () => {
    const points = Array.from({ length: 10000 }, (_, seq) => ({
      seq,
      ts: seq * 1000,
      t: seq === 4321 ? 150 : 30,
    }));
    const reduced = sampleSeries(points, 't', 600);
    expect(reduced.some((p) => p.seq === 4321)).toBe(true);
    expect(reduced.length).toBeLessThanOrEqual(602);
    expect(reduced[0].seq).toBe(0);
    expect(reduced.at(-1).seq).toBe(9999);
  });
});

describe('bounded scoped telemetry store', () => {
  it('buffers a pre-snapshot frame and preserves newer live state', () => {
    const store = new TelemetryStore();
    store.scope(['north'], 'N-001');
    store.frame({
      epoch: 'a',
      zone: 'north',
      ts: 6500,
      rows: [encodeRow(0, source({ seq: 6, ts: 6000, t: 31 }), 6500)],
    });
    store.setSnapshot({ epoch: 'a', ts: 5500, devices: [source()] });
    store.setHistory({
      source: 'N-001',
      lastSeq: 5,
      points: [source({ seq: 4, ts: 4000 }), source()],
    });
    store.flush();
    expect(store.values.devices[0].seq).toBe(6);
    expect(store.values.points.map((p) => p.seq)).toEqual([4, 5, 6]);
  });
  it('does not let a delayed same-sequence snapshot regress a status update', () => {
    const store = new TelemetryStore();
    store.scope(['north'], null);
    store.setSnapshot({ epoch: 'a', ts: 5500, devices: [source()] });
    store.frame({
      epoch: 'a',
      zone: 'north',
      ts: 7000,
      rows: [encodeRow(0, source({ status: 3 }), 7000)],
    });
    store.setSnapshot({ epoch: 'a', ts: 6000, devices: [source()] });
    store.flush();
    expect(store.values.devices[0].status).toBe(3);
  });
  it('drops data outside the selected authorized scope', () => {
    const store = new TelemetryStore();
    store.scope(['north'], null);
    store.setSnapshot({
      epoch: 'a',
      ts: 5500,
      devices: [source(), source({ idx: 1, id: 'E-001', zone: 'east' })],
    });
    store.frame({
      epoch: 'a',
      zone: 'east',
      ts: 7000,
      rows: [encodeRow(0, source({ seq: 9 }), 7000)],
    });
    store.alert({ ...alert('east'), zone: 'east' });
    store.flush();
    expect(store.values.devices).toHaveLength(1);
    expect(store.values.devices[0].seq).toBe(5);
    expect(store.values.alerts).toHaveLength(0);
  });
  it('reconciles a reconnect snapshot without losing incident transitions in flight', () => {
    const store = new TelemetryStore();
    store.scope(['north'], null);
    store.alert(alert('old'));
    store.alert(alert('resolved-while-away'));
    store.beginAlertSnapshot();
    store.alert(alert('new', 'open', 2000));
    store.alert(alert('old', 'resolved', 2100));
    store.setAlertSnapshot([alert('old', 'open', 1500)]);
    store.flush();
    expect(store.values.alerts.find((a) => a._id === 'old').state).toBe('resolved');
    expect(store.values.alerts.find((a) => a._id === 'new').state).toBe('open');
    expect(store.values.alerts.some((a) => a._id === 'resolved-while-away')).toBe(false);
  });
  it('resets old history on a server epoch change and keeps point buffers bounded', () => {
    const store = new TelemetryStore();
    store.scope(['north'], 'N-001');
    store.setSnapshot({ epoch: 'a', ts: 5500, devices: [source()] });
    for (let seq = 0; seq < POINT_CAP + 20; seq++) store.addPoint({ seq, ts: seq });
    expect(store.detail.size).toBe(POINT_CAP);
    store.setSnapshot({ epoch: 'b', ts: 6000, devices: [source({ seq: 1 })] });
    store.flush();
    expect(store.values.devices[0].seq).toBe(1);
    expect(store.values.points).toHaveLength(0);
  });
});
