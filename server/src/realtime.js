import { subscribeSchema, ZONE_IDS, encodeRow } from '@emberwatch/shared';
import { verifyToken, allowedZones } from './auth.js';
import { Alert } from './models/Alert.js';
import { snapshot, sensorView } from './views.js';
import { telemetryDelivery } from './telemetryDelivery.js';

export function attachLive(core) {
  const ns = core.io.of('/live');
  ns.use(async (socket, next) => {
    try {
      const origin = socket.handshake.headers.origin;
      if (origin && !core.config.corsOrigins.includes(origin))
        return next(new Error('origin not allowed'));
      socket.data.auth = await verifyToken(socket.handshake.auth?.token, core.config);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  ns.on('connection', (socket) => {
    socket.data.telemetry = telemetryDelivery(socket, {
      sent(bytes) {
        core.metrics.c.framesSent.add(1);
        core.metrics.c.bytesSent.add(bytes);
      },
      skipped() {
        core.metrics.c.framesSkipped.add(1);
      },
    });
    const expires = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.auth.expiresAt - Date.now()),
    );
    expires.unref();
    socket.on('disconnect', () => clearTimeout(expires));
    socket.data.generation = 0;
    let since = Date.now(),
      requests = 0;
    socket.on('subscribe', async (value, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (Date.now() - since > 10000) {
        since = Date.now();
        requests = 0;
      }
      if (++requests > 30) return reply({ ok: false, error: 'subscription rate limited' });
      const generation = ++socket.data.generation;
      const parsed = subscribeSchema.safeParse(value);
      if (!parsed.success) return reply({ ok: false, error: 'invalid subscription' });
      try {
        const auth = await verifyToken(socket.handshake.auth.token, core.config);
        if (generation !== socket.data.generation || !socket.connected)
          return reply({ ok: false, error: 'subscription superseded' });
        const allowed = allowedZones(auth.user);
        const zones = [...new Set(parsed.data.zones ?? allowed)];
        if (zones.some((zone) => !allowed.includes(zone)))
          return reply({ ok: false, error: 'zone access denied' });
        const sensor = parsed.data.sensor ? core.state.get(parsed.data.sensor) : null;
        if (parsed.data.sensor && (!sensor || !zones.includes(sensor.zone)))
          return reply({ ok: false, error: 'source access denied' });
        socket.data.telemetry.clear();
        for (const room of [...socket.rooms])
          if (/^(zone:|sensor:|alerts:|metrics$)/.test(room)) socket.leave(room);
        socket.data.auth = auth;
        socket.data.zones = zones;
        for (const zone of zones) {
          socket.join(`zone:${zone}`);
          socket.join(`alerts:${zone}`);
        }
        if (sensor) socket.join(`sensor:${sensor.id}`);
        if (auth.user.role !== 'ranger') socket.join('metrics');
        const initial = snapshot(core, zones);
        const alerts = await Alert.find({ zone: { $in: zones }, state: { $in: ['open', 'ack'] } })
          .sort({ openedAt: -1 })
          .limit(250)
          .lean();
        if (generation === socket.data.generation && socket.connected)
          reply({ ok: true, snapshot: initial, alerts });
      } catch {
        reply({ ok: false, error: 'subscription unavailable' });
      }
    });
  });

  const measure = (event, room, payload, volatile = false) => {
    const count = ns.adapter.rooms.get(room)?.size ?? 0;
    if (!count) {
      core.metrics.c.framesSkipped.add(1);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (volatile) {
      for (const id of ns.adapter.rooms.get(room))
        ns.sockets.get(id)?.data.telemetry.enqueue(room, event, payload, bytes);
    } else {
      ns.to(room).emit(event, payload);
      core.metrics.c.framesSent.add(count);
      core.metrics.c.bytesSent.add(bytes * count);
    }
  };
  let second = 0;
  const tick = () => {
    const now = Date.now();
    const grouped = new Map();
    for (const st of core.state.takeDirty()) {
      if (!grouped.has(st.zone)) grouped.set(st.zone, []);
      grouped.get(st.zone).push(encodeRow(st.idx, st, now));
      if (st.lastSeen && st.status !== 3) core.metrics.e2eMs.add(Math.max(0, now - st.ts));
      if (ns.adapter.rooms.has(`sensor:${st.id}`))
        measure(
          'sensor',
          `sensor:${st.id}`,
          { epoch: core.epoch, at: now, ...sensorView(st) },
          true,
        );
    }
    for (const [zone, rows] of grouped)
      measure('f', `zone:${zone}`, { epoch: core.epoch, ts: now, zone, rows }, true);
    if (Math.floor(now / 1000) === second) return;
    second = Math.floor(now / 1000);
    if (ns.adapter.rooms.has('metrics'))
      measure(
        'metrics',
        'metrics',
        core.metrics.snapshot({ ...core.pipelineStats(), clients: ns.sockets.size }),
      );
    for (const sid of core.historyDirty) {
      if (ns.adapter.rooms.has(`sensor:${sid}`))
        measure('history:changed', `sensor:${sid}`, { sid, epoch: core.epoch });
    }
    core.historyDirty.clear();
    if (second % 2 === 0)
      for (const zone of ZONE_IDS) {
        if (ns.adapter.rooms.has(`zone:${zone}`))
          measure('heads', `zone:${zone}`, {
            epoch: core.epoch,
            ts: now,
            zone,
            rows: core.state.zones.get(zone).map((st) => [st.idx, st.seq, st.status]),
            weather: core.state.zones
              .get(zone)
              .filter((st) => st.type === 'station')
              .map(sensorView),
          });
      }
  };
  return {
    ns,
    publishAlert(alert) {
      measure('alert', `alerts:${alert.zone}`, alert);
    },
    start() {
      this.timer = setInterval(tick, core.config.tickMs);
    },
    stop() {
      clearInterval(this.timer);
    },
    tick,
  };
}
