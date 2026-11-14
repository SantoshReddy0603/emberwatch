import { REGION } from './geo.js';

const midLat = (REGION.south + REGION.north) / 2;
const midLng = (REGION.west + REGION.east) / 2;

// Four ranger zones laid out as quadrants of the region.
export const ZONES = [
  { id: 'north', code: 'N', name: 'North', bounds: { south: midLat, north: REGION.north, west: REGION.west, east: midLng } },
  { id: 'east', code: 'E', name: 'East', bounds: { south: midLat, north: REGION.north, west: midLng, east: REGION.east } },
  { id: 'west', code: 'W', name: 'West', bounds: { south: REGION.south, north: midLat, west: REGION.west, east: midLng } },
  { id: 'south', code: 'S', name: 'South', bounds: { south: REGION.south, north: midLat, west: midLng, east: REGION.east } },
];

export const ZONE_IDS = ZONES.map((z) => z.id);
export const zoneById = Object.fromEntries(ZONES.map((z) => [z.id, z]));

export function zoneOf({ lat, lng }) {
  for (const z of ZONES) {
    const b = z.bounds;
    if (lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east) return z.id;
  }
  return null;
}
