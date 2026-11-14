import { describe, expect, it } from 'vitest';
import { categoryOf, groupIncidents } from './incidents.js';

const alert = (over) => ({
  _id: Math.random().toString(36).slice(2),
  zone: 'north',
  type: 'ignition',
  severity: 'warning',
  state: 'open',
  openedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('groupIncidents', () => {
  it('folds fire alerts of one zone into a single incident', () => {
    const list = groupIncidents([
      alert({ sid: 'N-001', type: 'ignition' }),
      alert({ sid: 'N-001', type: 'smoke' }),
      alert({ sid: 'N-002', type: 'temp_spike', severity: 'critical', openedAt: '2025-12-31T23:59:00Z' }),
    ]);
    expect(list).toHaveLength(1);
    const [fire] = list;
    expect(fire.title).toBe('Fire incident · North');
    expect(fire.members).toHaveLength(3);
    expect(fire.sensors).toBe(2);
    expect(fire.severity).toBe('critical');
    expect(fire.critical).toBe(1);
    expect(fire.openedAt).toBe('2025-12-31T23:59:00.000Z');
    expect(fire.members[0].severity).toBe('critical');
  });

  it('keeps zones and categories apart', () => {
    const list = groupIncidents([
      alert({ sid: 'N-001' }),
      alert({ sid: 'E-001', zone: 'east' }),
      alert({ sid: 'N-003', type: 'offline' }),
      alert({ sid: 'N-004', type: 'wind_gust' }),
    ]);
    expect(list.map((g) => g.id).sort()).toEqual([
      'east:fire',
      'north:fire',
      'north:offline',
      'north:weather',
    ]);
  });

  it('reports the most urgent state and counts open members', () => {
    const [group] = groupIncidents([
      alert({ sid: 'N-001', state: 'ack' }),
      alert({ sid: 'N-002', state: 'open' }),
      alert({ sid: 'N-003', state: 'resolved' }),
    ]);
    expect(group.state).toBe('open');
    expect(group.open).toBe(1);
    expect(group.members.map((a) => a.state)).toEqual(['open', 'ack', 'resolved']);
    const [quiet] = groupIncidents([alert({ sid: 'N-001', state: 'ack' })]);
    expect(quiet.state).toBe('ack');
  });

  it('orders open critical incidents first', () => {
    const list = groupIncidents([
      alert({ sid: 'N-003', type: 'offline', updatedAt: '2026-01-01T00:05:00Z' }),
      alert({ sid: 'E-001', zone: 'east', severity: 'critical' }),
      alert({ sid: 'S-001', zone: 'south', state: 'ack', severity: 'critical' }),
    ]);
    expect(list.map((g) => g.id)).toEqual(['east:fire', 'north:offline', 'south:fire']);
    expect(categoryOf('smoke')).toBe('fire');
  });
});
