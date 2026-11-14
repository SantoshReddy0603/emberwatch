// Monitored area: a 12 km x 8 km forest block in the Sierra Nevada foothills.
// Sensor positions are generated, not real deployments.
export const REGION = {
  name: 'Kaiser Ridge Forest Block',
  south: 37.164,
  north: 37.236,
  west: -119.318,
  east: -119.183,
};

export const REGION_CENTER = {
  lat: (REGION.south + REGION.north) / 2,
  lng: (REGION.west + REGION.east) / 2,
};

const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

// Local flat projection in metres around the region centre. Accurate enough
// for a 12 km area and much cheaper than haversine in hot loops.
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(toRad(REGION_CENTER.lat));

export function toXY({ lat, lng }) {
  return {
    x: (lng - REGION.west) * M_PER_DEG_LNG,
    y: (lat - REGION.south) * M_PER_DEG_LAT,
  };
}

export function fromXY({ x, y }) {
  return {
    lat: REGION.south + y / M_PER_DEG_LAT,
    lng: REGION.west + x / M_PER_DEG_LNG,
  };
}

export const REGION_SIZE_M = toXY({ lat: REGION.north, lng: REGION.east });

// Compass bearing in degrees (0 = north, 90 = east) of a vector in metres.
export function bearingOf(dx, dy) {
  return (toDeg(Math.atan2(dx, dy)) + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
