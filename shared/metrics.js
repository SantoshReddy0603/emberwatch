// Telemetry fields. Short keys keep payloads and documents small.
export const METRICS = {
  t: { label: 'Temperature', unit: '°C', min: -40, max: 200 },
  h: { label: 'Humidity', unit: '%', min: 0, max: 100 },
  s: { label: 'Smoke', unit: 'ppm', min: 0, max: 5000 },
  co: { label: 'CO', unit: 'ppm', min: 0, max: 5000 },
  ws: { label: 'Wind speed', unit: 'km/h', min: 0, max: 250 },
  wd: { label: 'Wind direction', unit: '°', min: 0, max: 360 },
  b: { label: 'Battery', unit: '%', min: 0, max: 100 },
  rssi: { label: 'Signal', unit: 'dBm', min: -150, max: 0 },
};

export const STATUS = {
  NORMAL: 0,
  ELEVATED: 1,
  CRITICAL: 2,
  OFFLINE: 3,
};

export const STATUS_NAMES = ['normal', 'elevated', 'critical', 'offline'];

// Fire Danger Index on a 0-100 scale.
// Base term is the Chandler Burning Index (Chandler et al., 1983), which
// combines air temperature (°C) and relative humidity (%). A wind multiplier
// accounts for faster spread in strong wind, and the result is scaled so a
// hot, dry, windy afternoon lands in the 90s. This is a composite index for
// ranking risk, not the official Canadian Fire Weather Index.
export function fireDangerIndex(tempC, rh, windKmh = 0) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh)) return 0;
  const cbi =
    (((110 - 1.373 * rh) - 0.54 * (10.2 - tempC)) * (124 * Math.pow(10, -0.0142 * rh))) / 60;
  const wind = 1 + Math.min(Math.max(windKmh, 0), 80) / 60;
  return Math.max(0, Math.min(100, Math.round(cbi * wind * 0.55)));
}

export function fdiBand(fdi) {
  if (fdi >= 90) return 'extreme';
  if (fdi >= 75) return 'very high';
  if (fdi >= 50) return 'high';
  if (fdi >= 25) return 'moderate';
  return 'low';
}
