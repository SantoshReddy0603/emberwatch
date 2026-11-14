import { ZONES } from './zones.js';
import { distanceM } from './geo.js';
import { mulberry32 } from './rng.js';

export const SENSORS_PER_ZONE = 105;
export const STATIONS_PER_ZONE = 2;
export const GATEWAYS_PER_ZONE = 2;
export const NEIGHBOUR_RADIUS_M = 750;

const HABITATS = ['ridge line', 'valley', 'clearing', 'trailhead', 'creek', 'pine stand', 'saddle', 'slope', 'meadow', 'summit'];

const pad = (n) => String(n).padStart(3, '0');

// Deterministic fleet layout shared by the seed script, the server and the
// simulator. Sensors sit on a jittered grid inside each zone.
export function buildFleet(seed = 20261114) {
  const rand = mulberry32(seed);
  const sensors = [];
  const stations = [];
  const gateways = [];

  for (const zone of ZONES) {
    const b = zone.bounds;
    const cols = 15;
    const rows = Math.ceil(SENSORS_PER_ZONE / cols);
    const cellW = (b.east - b.west) / cols;
    const cellH = (b.north - b.south) / rows;

    let n = 0;
    for (let r = 0; r < rows && n < SENSORS_PER_ZONE; r++) {
      for (let c = 0; c < cols && n < SENSORS_PER_ZONE; c++) {
        n++;
        const lat = b.north - (r + 0.15 + rand() * 0.7) * cellH;
        const lng = b.west + (c + 0.15 + rand() * 0.7) * cellW;
        const gw = `GW-${zone.code}${1 + (c < cols / 2 ? 0 : 1)}`;
        sensors.push({
          id: `${zone.code}-${pad(n)}`,
          type: 'sensor',
          zone: zone.id,
          lat: +lat.toFixed(6),
          lng: +lng.toFixed(6),
          site: HABITATS[Math.floor(rand() * HABITATS.length)],
          gateway: gw,
        });
      }
    }

    for (let s = 1; s <= STATIONS_PER_ZONE; s++) {
      stations.push({
        id: `WX-${zone.code}${s}`,
        type: 'station',
        zone: zone.id,
        lat: +(b.south + (0.3 + 0.4 * rand()) * (b.north - b.south)).toFixed(6),
        lng: +(b.west + (s === 1 ? 0.25 : 0.75) * (b.east - b.west)).toFixed(6),
        site: 'weather station',
        gateway: `GW-${zone.code}${s}`,
      });
    }

    for (let g = 1; g <= GATEWAYS_PER_ZONE; g++) {
      gateways.push({ id: `GW-${zone.code}${g}`, zone: zone.id });
    }
  }

  // Precompute neighbour lists for spatial confirmation of anomalies.
  for (const a of sensors) {
    a.neighbours = sensors
      .filter((b) => b !== a && distanceM(a, b) <= NEIGHBOUR_RADIUS_M)
      .map((b) => b.id);
  }

  return { sensors, stations, gateways, devices: [...sensors, ...stations] };
}
