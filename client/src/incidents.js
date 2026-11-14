import { zoneById } from '@emberwatch/shared';

const CATEGORY = {
  ignition: 'fire',
  smoke: 'fire',
  temp_spike: 'fire',
  low_humidity: 'weather',
  wind_gust: 'weather',
  offline: 'offline',
};
const LABEL = { fire: 'Fire incident', weather: 'Fire weather', offline: 'Sensors offline' };
const STATE_RANK = { open: 0, ack: 1, resolved: 2 };
const time = (value) => Number(new Date(value)) || 0;

export const categoryOf = (type) => CATEGORY[type] || type;

// Groups per-sensor alerts into one incident per zone and category, so a fire
// that trips dozens of sensors reads as a single incident with its members
// underneath. The incident takes its worst severity and its most urgent state.
export function groupIncidents(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const category = categoryOf(alert.type);
    const id = `${alert.zone}:${category}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, zone: alert.zone, category, members: [] };
      groups.set(id, group);
    }
    group.members.push(alert);
  }
  const incidents = [...groups.values()].map((group) => {
    const members = group.members.sort(
      (a, b) =>
        (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3) ||
        (b.severity === 'critical') - (a.severity === 'critical') ||
        time(b.updatedAt || b.openedAt) - time(a.updatedAt || a.openedAt),
    );
    const sensors = new Set(members.map((a) => a.sid)).size;
    const critical = members.filter((a) => a.severity === 'critical').length;
    const open = members.filter((a) => a.state === 'open').length;
    const state = members.reduce(
      (best, a) => ((STATE_RANK[a.state] ?? 3) < (STATE_RANK[best] ?? 3) ? a.state : best),
      'resolved',
    );
    const types = [...new Set(members.map((a) => a.type))];
    return {
      ...group,
      _id: group.id,
      members,
      sensors,
      critical,
      open,
      state,
      types,
      severity: critical ? 'critical' : 'warning',
      openedAt: new Date(Math.min(...members.map((a) => time(a.openedAt)))).toISOString(),
      updatedAt: new Date(
        Math.max(...members.map((a) => time(a.updatedAt || a.openedAt))),
      ).toISOString(),
      title: `${LABEL[group.category] || 'Incident'} · ${zoneById[group.zone]?.name || group.zone}`,
    };
  });
  return incidents.sort(
    (a, b) =>
      (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3) ||
      (b.severity === 'critical') - (a.severity === 'critical') ||
      time(b.updatedAt) - time(a.updatedAt),
  );
}
