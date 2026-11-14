import { toXY, bearingOf } from '@emberwatch/shared';

const MIN_SPAN_MS = 20000;

// Collapses the active ignition incidents of each zone into one fire front.
// The origin is the first sensor that tripped; the bearing points from it to
// the centroid of every tripped sensor, so the arrow follows the growth of the
// burning area instead of the noisy order of individual neighbours. Speed is
// the farthest tripped sensor's distance from the origin over the time since
// the first trip, and is omitted until enough time has passed to be meaningful.
export function fireFronts(alerts, devices) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const zones = new Map();
  for (const alert of alerts) {
    if (alert.type !== 'ignition' || alert.state === 'resolved') continue;
    const device = byId.get(alert.sid);
    const at = Number(new Date(alert.openedAt));
    if (!device || !Number.isFinite(at)) continue;
    const list = zones.get(alert.zone) || [];
    list.push({ p: toXY(device), at, bearing: alert.spread?.bearing });
    zones.set(alert.zone, list);
  }
  const fronts = [];
  for (const [zone, points] of zones) {
    points.sort((a, b) => a.at - b.at);
    const origin = points[0];
    const cx = points.reduce((sum, q) => sum + q.p.x, 0) / points.length;
    const cy = points.reduce((sum, q) => sum + q.p.y, 0) / points.length;
    const dx = cx - origin.p.x,
      dy = cy - origin.p.y;
    let bearing = null;
    if (Math.hypot(dx, dy) >= 50) bearing = bearingOf(dx, dy);
    else {
      const known = points.filter((q) => Number.isFinite(q.bearing));
      if (known.length) {
        const rad = (d) => (d * Math.PI) / 180;
        const sx = known.reduce((sum, q) => sum + Math.sin(rad(q.bearing)), 0);
        const sy = known.reduce((sum, q) => sum + Math.cos(rad(q.bearing)), 0);
        if (Math.hypot(sx, sy) > 1e-6) bearing = bearingOf(sx, sy);
      }
    }
    if (bearing === null) continue;
    const span = points[points.length - 1].at - origin.at;
    const reach = Math.max(...points.map((q) => Math.hypot(q.p.x - origin.p.x, q.p.y - origin.p.y)));
    const kmh = span >= MIN_SPAN_MS ? Math.round((reach / span) * 36000) / 10 : null;
    fronts.push({ zone, origin: origin.p, centroid: { x: cx, y: cy }, bearing, kmh, sensors: points.length });
  }
  return fronts;
}
