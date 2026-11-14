import { Device } from './models/Device.js';
import { StateStore } from './pipeline/stateStore.js';
import { Writer } from './pipeline/writer.js';
import { Rollups } from './pipeline/rollup.js';
import { Ingestor } from './ingest/ingestor.js';
import { GatewayRegistry } from './ingest/gatewayAuth.js';
import { attachDeviceNamespace } from './ingest/deviceNs.js';
import { createMetrics } from './obs/metrics.js';
import { randomUUID } from 'node:crypto';
import { Reading } from './models/Reading.js';
import { Gateway } from './models/Gateway.js';
import { AnomalyEngine } from './analysis/engine.js';
import { attachLive } from './realtime.js';

// Wires the telemetry pipeline together. Kept separate from the HTTP server
// so tests can build a core against an in-memory database.
export async function createCore({ config, io }) {
  const devices = await Device.find({}).sort({ _id: 1 }).lean();
  if (!devices.length) throw new Error('No devices found. Run `npm run seed` first.');

  const metrics = createMetrics();
  const state = new StateStore(devices.map((d) => ({ ...d, id: d._id })));
  const retainedAfter = new Date(Date.now() - config.rawTtlMinutes * 60000);
  const remaining = devices.values();
  // Bound concurrency and seek each source's unique sequence index. A global
  // timestamp filter plus sort can scan the entire retained telemetry window.
  await Promise.all(
    Array.from({ length: Math.min(12, devices.length) }, async () => {
      for (const device of remaining) {
        const r = await Reading.findOne({ sid: device._id, rx: { $gte: retainedAfter } })
          .sort({ seq: -1 })
          .hint({ sid: 1, seq: 1 })
          .maxTimeMS(5000)
          .lean();
        if (r)
          state.apply(
            state.get(r.sid),
            { sid: r.sid, seq: r.seq, ts: Number(r.ts), m: r },
            Number(r.rx),
          );
      }
    }),
  );
  const rollups = new Rollups();
  const historyDirty = new Set();
  const writer = new Writer({
    metrics,
    state,
    intervalMs: config.writeIntervalMs,
    batchMax: config.writeBatchMax,
    hardCap: config.queueHardCap,
    onStored(batch) {
      for (const r of batch) {
        rollups.add(state.get(r.sid), r);
        historyDirty.add(r.sid);
      }
    },
  });
  const registry = new GatewayRegistry();
  await registry.load();

  const hooks = [];
  const ingestor = new Ingestor({
    state,
    writer,
    rollups,
    metrics,
    config,
    onReading: (st, r, rx) => {
      for (const h of hooks) h(st, r, rx);
    },
  });

  const devicesNs = attachDeviceNamespace(io, {
    registry,
    ingestor,
    onGatewayChange(online) {
      if (online.size)
        void Gateway.updateMany(
          { _id: { $in: [...online.keys()] } },
          { $set: { lastSeen: new Date() } },
        ).catch(() => {});
    },
  });

  const core = {
    config,
    io,
    metrics,
    state,
    writer,
    rollups,
    registry,
    ingestor,
    devicesNs,
    epoch: randomUUID(),
    historyDirty,
    onReading(fn) {
      hooks.push(fn);
    },
    pipelineStats() {
      return {
        queueDepth: writer.depth,
        gatewaysOnline: devicesNs.online.size,
        simulator: devicesNs.controllers() > 0,
      };
    },
    start() {
      writer.start();
      rollups.start();
      core.engine.start();
      core.live.start();
    },
    async stop() {
      core.live.stop();
      await core.engine.stop();
      await writer.stop();
      await rollups.stop();
      metrics.stop();
    },
  };
  core.engine = new AnomalyEngine({
    state,
    metrics,
    offlineAfterMs: config.offlineAfterMs,
    onAlert: (a) => core.live.publishAlert(a),
  });
  await core.engine.load();
  core.onReading((st, r, rx) => core.engine.onReading(st, r, rx));
  core.live = attachLive(core);
  return core;
}
