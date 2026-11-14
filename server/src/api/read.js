import { Router } from 'express';
import mongoose from 'mongoose';
import { rateLimit } from 'express-rate-limit';
import {
  ZONES,
  REGION,
  historyQuerySchema,
  controlSchema,
  MAX_CLOCK_SKEW_MS,
  fireDangerIndex,
} from '@emberwatch/shared';
import { requireAuth, requireRole, allowedZones, canSee } from '../auth.js';
import { Reading } from '../models/Reading.js';
import { Rollup } from '../models/Rollup.js';
import { Alert } from '../models/Alert.js';
import { sensorView, snapshot } from '../views.js';

function zonesFor(req, res) {
  const zones = allowedZones(req.user);
  const zone = req.query.zone;
  if (zone === undefined || zone === 'all') return zones;
  if (typeof zone !== 'string' || !ZONES.some((z) => z.id === zone)) {
    res.status(400).json({ error: 'unknown zone' });
    return null;
  }
  if (!zones.includes(zone)) {
    res.status(403).json({ error: 'zone access denied' });
    return null;
  }
  return [zone];
}

function timeRange(req, res, core) {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid history query' });
    return null;
  }
  const now = Date.now(),
    to = parsed.data.to ?? now,
    from = parsed.data.from ?? to - 15 * 60000;
  if (
    to <= from ||
    to > now + MAX_CLOCK_SKEW_MS ||
    to - from > core.config.rollupTtlHours * 3600000 + 60000
  ) {
    res.status(400).json({ error: 'invalid history time range' });
    return null;
  }
  const earliest = now - core.config.rollupTtlHours * 3600000;
  if (from < earliest - 60000) {
    res.status(416).json({ error: 'history outside retention', availableFrom: earliest });
    return null;
  }
  return { from: Math.max(from, earliest), to, limit: parsed.data.limit ?? 5000 };
}

const point = (r) => ({
  sid: r.sid,
  seq: r.seq,
  ts: Number(r.ts),
  t: r.t,
  h: r.h,
  s: r.s ?? null,
  co: r.co ?? null,
  ws: r.ws ?? null,
  wd: r.wd ?? null,
  b: r.b ?? null,
  rssi: r.rssi ?? null,
  fdi: r.fdi ?? fireDangerIndex(r.t, r.h, r.ws ?? 0),
});

export function readRouter(core) {
  const router = Router();
  router.use(requireAuth(core.config));
  const historyLimit = rateLimit({
    windowMs: 60000,
    limit: 180,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  router.get('/zones', (req, res) =>
    res.json({ zones: ZONES.filter((z) => canSee(req.user, z.id)) }),
  );
  router.get('/devices', (req, res) => {
    const zones = zonesFor(req, res);
    if (zones)
      res.json({ devices: core.state.list.filter((d) => zones.includes(d.zone)).map(sensorView) });
  });
  router.get('/snapshot', (req, res) => {
    const zones = zonesFor(req, res);
    if (zones) res.json(snapshot(core, zones));
  });

  router.get('/sensors/:id/history', historyLimit, async (req, res) => {
    const st = core.state.get(req.params.id);
    if (!st) return res.status(404).json({ error: 'source not found' });
    if (!canSee(req.user, st.zone)) return res.status(403).json({ error: 'source access denied' });
    const range = timeRange(req, res, core);
    if (!range) return;
    const rawAvailableFrom = Date.now() - core.config.rawTtlMinutes * 60000;
    if (st.type === 'station') {
      if (range.to <= rawAvailableFrom || range.from < rawAvailableFrom - 60000)
        return res.status(416).json({
          error: 'weather history outside raw retention',
          availableFrom: rawAvailableFrom,
        });
      range.from = Math.max(range.from, rawAvailableFrom);
      range.availableFrom = rawAvailableFrom;
    }
    const { from, to, limit } = range,
      lastSeq = st.seq;
    const live = sensorView(st);
    const pending = core.writer.pending
      .filter(
        (r) =>
          r.sid === st.id &&
          r.seq <= lastSeq &&
          Number(r.ts) >= from &&
          Number(r.ts) < to + MAX_CLOCK_SKEW_MS,
      )
      .map(point);
    if (st.type === 'sensor' && from < rawAvailableFrom) {
      const buckets = await Rollup.find({
        sid: st.id,
        b: { $gte: new Date(from), $lt: new Date(to) },
      })
        .sort({ b: -1 })
        .limit(limit + 1)
        .maxTimeMS(10000)
        .lean();
      if (buckets.some((a) => a.lastSeq > lastSeq))
        return res.status(409).json({
          error: 'History changed during the snapshot; retry the request',
          code: 'HISTORY_CHANGED',
        });
      return res.json({
        ...range,
        source: st.id,
        lastSeq,
        live,
        mode: 'rollup',
        truncated: buckets.length > limit,
        points: buckets
          .slice(0, limit)
          .reverse()
          .map((a) => ({
            sid: a.sid,
            seq: a.lastSeq,
            ts: Number(a.b),
            t: a.tSum / a.n,
            h: a.hSum / a.n,
            s: a.sSum / a.n,
            fdi: a.fdiMax,
            n: a.n,
          })),
      });
    }
    const stored = await Reading.find({
      sid: st.id,
      seq: { $lte: lastSeq },
      ts: { $gte: new Date(from), $lt: new Date(to + MAX_CLOCK_SKEW_MS) },
      rx: { $gte: new Date(Date.now() - core.config.rawTtlMinutes * 60000) },
    })
      .sort({ ts: -1, seq: -1 })
      .limit(limit + 1)
      .maxTimeMS(10000)
      .lean();
    const unique = new Map(stored.map((r) => [r.seq, point(r)]));
    for (const r of pending) unique.set(r.seq, r);
    if (st.seq >= 0 && live.ts >= from && live.ts < to + MAX_CLOCK_SKEW_MS)
      unique.set(live.seq, { ...live, sid: st.id });
    const all = [...unique.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const visible = all.filter((r) => r.ts < to),
      future = all.filter((r) => r.ts >= to);
    res.json({
      ...range,
      source: st.id,
      lastSeq,
      live,
      mode: 'raw',
      truncated: stored.length > limit || visible.length > limit,
      points: visible.slice(-limit),
      pending: future.slice(-limit),
    });
  });

  router.get('/zones/:id/history', historyLimit, async (req, res) => {
    const zone = ZONES.find((z) => z.id === req.params.id);
    if (!zone) return res.status(404).json({ error: 'zone not found' });
    if (!canSee(req.user, zone.id)) return res.status(403).json({ error: 'zone access denied' });
    const range = timeRange(req, res, core);
    if (!range) return;
    const points = await Rollup.aggregate([
      { $match: { zone: zone.id, b: { $gte: new Date(range.from), $lt: new Date(range.to) } } },
      {
        $group: {
          _id: '$b',
          n: { $sum: '$n' },
          tSum: { $sum: '$tSum' },
          hSum: { $sum: '$hSum' },
          sSum: { $sum: '$sSum' },
          tMax: { $max: '$tMax' },
          sMax: { $max: '$sMax' },
          fdi: { $max: '$fdiMax' },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: Math.min(range.limit, 1440) },
    ]).option({ maxTimeMS: 10000 });
    res.json({
      ...range,
      zone: zone.id,
      points: points.map(({ _id, ...p }) => ({
        ...p,
        ts: Number(_id),
        t: p.tSum / p.n,
        h: p.hSum / p.n,
        s: p.sSum / p.n,
      })),
    });
  });

  router.get('/alerts', async (req, res) => {
    const zones = zonesFor(req, res);
    if (!zones) return;
    const state = req.query.state ?? 'active';
    if (!['active', 'open', 'ack', 'resolved', 'all'].includes(state))
      return res.status(400).json({ error: 'invalid alert state' });
    const filter = {
      zone: { $in: zones },
      openedAt: { $gte: new Date(Date.now() - 7 * 86400000) },
    };
    if (state === 'active') filter.state = { $in: ['open', 'ack'] };
    else if (state !== 'all') filter.state = state;
    const alerts = await Alert.find(filter)
      .sort({ openedAt: -1 })
      .limit(250)
      .maxTimeMS(10000)
      .lean();
    res.json({ alerts });
  });
  router.post('/alerts/:id/ack', async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.id))
      return res.status(400).json({ error: 'invalid alert id' });
    const alert = await Alert.findById(req.params.id).lean();
    if (!alert) return res.status(404).json({ error: 'alert not found' });
    if (!canSee(req.user, alert.zone)) return res.status(403).json({ error: 'zone access denied' });
    res.json({ alert: await core.engine.acknowledge(req.params.id, req.user) });
  });
  router.post(
    '/control',
    requireRole('admin'),
    rateLimit({
      windowMs: 60000,
      limit: 90,
      keyGenerator: (req) => req.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    (req, res) => {
      const parsed = controlSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid simulator command' });
      const cmd = parsed.data;
      if (
        cmd.cmd === 'ignite' &&
        (!Number.isFinite(cmd.lat) ||
          !Number.isFinite(cmd.lng) ||
          cmd.lat < REGION.south ||
          cmd.lat > REGION.north ||
          cmd.lng < REGION.west ||
          cmd.lng > REGION.east)
      )
        return res.status(400).json({ error: 'ignition must be inside the monitored region' });
      if (!core.devicesNs.controllers())
        return res.status(409).json({ error: 'simulator is not connected' });
      res.json({ command: core.devicesNs.sendControl(cmd) });
    },
  );
  router.get('/sim/status', requireRole('admin', 'operator'), (_req, res) => {
    const status = core.devicesNs.simStatus();
    res.json({
      connected: core.devicesNs.controllers() > 0,
      status: status && Date.now() - status.at < 5000 ? status : null,
    });
  });
  router.get('/metrics', requireRole('admin', 'operator'), (_req, res) =>
    res.json(
      core.metrics.snapshot({ ...core.pipelineStats(), clients: core.live?.ns.sockets.size ?? 0 }),
    ),
  );
  return router;
}
