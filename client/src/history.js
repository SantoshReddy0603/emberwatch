export const POINT_CAP = 10000;

export function mergeSamples(
  history,
  live = [],
  { from = 0, to = Infinity, limit = POINT_CAP } = {},
) {
  const unique = new Map();
  for (const p of [...(history.points || []), ...(history.pending || [])])
    if (Number.isSafeInteger(p.seq)) unique.set(p.seq, p);
  if (history.mode !== 'rollup')
    for (const p of live) {
      if (!Number.isSafeInteger(p.seq)) continue;
      if (p.seq > history.lastSeq || unique.has(p.seq))
        unique.set(p.seq, { ...unique.get(p.seq), ...p });
    }
  return [...unique.values()]
    .filter((p) => p.ts >= from && p.ts <= to)
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    .slice(-limit);
}

export function sampleSeries(points, key, limit = 800) {
  const valid = points.filter((p) => Number.isFinite(p[key]) && Number.isFinite(p.ts));
  if (valid.length <= limit) return valid;
  const stride = Math.ceil(valid.length / Math.max(1, Math.floor((limit - 2) / 2)));
  const selected = [valid[0]];
  for (let i = 1; i < valid.length - 1; i += stride) {
    const bucket = valid.slice(i, Math.min(i + stride, valid.length - 1));
    let min = bucket[0],
      max = bucket[0];
    for (const p of bucket) {
      if (p[key] < min[key]) min = p;
      if (p[key] > max[key]) max = p;
    }
    if (min === max) selected.push(min);
    else selected.push(...[min, max].sort((a, b) => a.ts - b.ts || a.seq - b.seq));
  }
  selected.push(valid.at(-1));
  return selected;
}
