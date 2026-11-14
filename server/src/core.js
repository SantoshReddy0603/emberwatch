import { Device } from './models/Device.js';
import { StateStore } from './pipeline/stateStore.js';
import { Writer } from './pipeline/writer.js';
import { Rollups } from './pipeline/rollup.js';
import { Ingestor } from './ingest/ingestor.js';
import { GatewayRegistry } from './ingest/gatewayAuth.js';
import { attachDeviceNamespace } from './ingest/deviceNs.js';
import { createMetrics } from './obs/metrics.js';

// Wires the telemetry pipeline together. Kept separate from the HTTP server
// so tests can build a core against an in-memory database.
export async function createCore({ config, io }) {
  const devices = await Device.find({}).sort({ _id: 1 }).lean();
  if (!devices.length) throw new Error('No devices found. Run `npm run seed` first.');

  const metrics = createMetrics();
  const state = new StateStore(devices.map((d) => ({ ...d, id: d._id })));
  const writer = new Writer({
    metrics,
    state,
    intervalMs: config.writeIntervalMs,
    batchMax: config.writeBatchMax,
    hardCap: config.queueHardCap,
  });
  const rollups = new Rollups();
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

  const devicesNs = attachDeviceNamespace(io, { registry, ingestor });

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
    },
    async stop() {
      await writer.stop();
      await rollups.stop();
    },
  };
  return core;
}
