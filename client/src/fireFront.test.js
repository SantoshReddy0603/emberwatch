import { describe, expect, it } from 'vitest';
import { fromXY } from '@emberwatch/shared';
import { fireFronts } from './fireFront.js';

const at = (id, x, y, zone = 'north') => ({ id, zone, ...fromXY({ x, y }) });
const ignition = (sid, ms, extra = {}) => ({
  sid,
  zone: 'north',
  type: 'ignition',
  state: 'open',
  openedAt: new Date(ms).toISOString(),
  ...extra,
});

describe('fireFronts', () => {
  const devices = [at('A', 1000, 1000), at('B', 1600, 1000), at('C', 2200, 1000), at('D', 1000, 1000, 'east')];

  it('collapses a zone into one front moving from the first detection toward the burning area', () => {
    const [front, ...rest] = fireFronts(
      [ignition('A', 0), ignition('B', 30000), ignition('C', 60000)],
      devices,
    );
    expect(rest).toHaveLength(0);
    expect(front.sensors).toBe(3);
    expect(front.bearing).toBeCloseTo(90, 0);
    expect(front.kmh).toBeCloseTo(72, 0);
  });

  it('omits speed until the trips span enough time', () => {
    const [front] = fireFronts([ignition('A', 0), ignition('B', 5000)], devices);
    expect(front.kmh).toBeNull();
  });

  it('falls back to reported bearings for a single sensor and ignores resolved or other types', () => {
    const fronts = fireFronts(
      [
        ignition('A', 0, { spread: { bearing: 180 } }),
        ignition('B', 1000, { state: 'resolved' }),
        { ...ignition('C', 1000), type: 'smoke' },
      ],
      devices,
    );
    expect(fronts).toHaveLength(1);
    expect(fronts[0].bearing).toBeCloseTo(180, 5);
  });

  it('keeps zones separate', () => {
    const fronts = fireFronts(
      [ignition('A', 0), ignition('B', 30000), { ...ignition('D', 0, { spread: { bearing: 45 } }), zone: 'east' }],
      devices,
    );
    expect(fronts.map((f) => f.zone).sort()).toEqual(['east', 'north']);
  });
});
