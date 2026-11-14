import http from 'node:http';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import { ZONE_IDS, decodeRow } from '@emberwatch/shared';
import { startSimulator } from '@emberwatch/simulator';
import { config } from '../server/src/config.js';
import { connectDb, disconnectDb } from '../server/src/db.js';
import { seed } from '../server/src/seed.js';
import { createCore } from '../server/src/core.js';
import { createApp } from '../server/src/app.js';
import { Reading } from '../server/src/models/Reading.js';

const { values } = parseArgs({
  options: {
    clients: { type: 'string', default: '50' },
    hz: { type: 'string', default: '10' },
    seconds: { type: 'string', default: '30' },
    warmup: { type: 'string', default: '5' },
    chaos: { type: 'boolean', default: false },
    output: { type: 'string' },
  },
});
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const bounded = (name, min, max) => {
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
  return n;
};
const clients = bounded('clients', 1, 500),
  hz = bounded('hz', 1, 20);
const seconds = bounded('seconds', 5, 300),
  warmup = bounded('warmup', 1, 60);
const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const round = (n) => Math.round(n * 100) / 100;
const totals = (core) =>
  Object.fromEntries(Object.entries(core.metrics.c).map(([k, c]) => [k, c.total]));
const difference = (end, start) =>
  Object.fromEntries(Object.keys(end).map((k) => [k, end[k] - (start[k] || 0)]));
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
};

let mongo,
  core,
  io,
  server,
  sim,
  progress,
  measuring = false;
const sockets = [],
  latency = [];
let frames = 0,
  bytes = 0,
  rows = 0,
  violations = 0,
  disconnects = 0;
let peakQueue = 0,
  peakRssMb = 0;
try {
  process.env.MONGOMS_DOWNLOAD_DIR ||= resolve(projectRoot, '.data/mongodb-binaries');
  // A new mongod and database keep the benchmark away from application data.
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await connectDb(mongo.getUri('emberwatch_benchmark'));
  await seed();
  let app;
  server = http.createServer((req, res) => app(req, res));
  io = new Server(server, { maxHttpBufferSize: 512 * 1024, perMessageDeflate: false });
  core = await createCore({ config, io });
  app = createApp(core);
  core.start();
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const zone of ZONE_IDS) {
    const name = zone === 'west' ? 'south' : zone;
    if (!tokens[name]) {
      const response = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${name}@emberwatch.dev`, password: config.demoPassword }),
      });
      if (!response.ok) throw new Error(`Benchmark login failed: ${response.status}`);
      tokens[name] = (await response.json()).token;
    }
  }
  await Promise.all(
    Array.from(
      { length: clients },
      (_, index) =>
        new Promise((yes, no) => {
          const zone = ZONE_IDS[index % ZONE_IDS.length];
          const source = core.state.zones.get(zone).find((st) => st.type === 'sensor');
          const indices = new Set(core.state.zones.get(zone).map((st) => st.idx));
          const socket = clientIo(`${url}/live`, {
            auth: { token: tokens[zone === 'west' ? 'south' : zone] },
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
          });
          sockets.push(socket);
          const timeout = setTimeout(
            () => no(new Error('Live client subscription timed out')),
            15000,
          );
          socket.once('connect_error', no);
          socket.on('disconnect', () => {
            if (measuring) disconnects++;
          });
          socket.onAny((event, value) => {
            if (!measuring) return;
            bytes += Buffer.byteLength(JSON.stringify(value));
            if (event === 'f') {
              frames++;
              rows += value.rows.length;
              if (value.zone !== zone || value.rows.some((row) => !indices.has(row[0])))
                violations++;
              // Deterministic sampling bounds memory without timing every client row.
              for (const row of value.rows.slice(0, 4)) {
                if (latency.length < 100000)
                  latency.push(Math.max(0, Date.now() - decodeRow(row, value.ts).ts));
              }
            }
            if (
              event === 'heads' &&
              (value.zone !== zone || value.rows.some((r) => !indices.has(r[0])))
            )
              violations++;
            if (event === 'sensor' && value.id !== source.id) violations++;
            if (event === 'alert' && value.zone !== zone) violations++;
          });
          socket.once('connect', () => {
            socket
              .timeout(12000)
              .emit('subscribe', { zones: [zone], sensor: source.id }, (error, ack) => {
                clearTimeout(timeout);
                if (error || !ack?.ok)
                  return no(error || new Error(ack?.error || 'Subscription failed'));
                if (ack.snapshot.devices.some((st) => st.zone !== zone)) violations++;
                yes();
              });
          });
        }),
    ),
  );
  sim = await startSimulator({
    url,
    fleetSecret: config.fleetSecret,
    hz,
    chaos: values.chaos,
    quiet: true,
  });
  console.log(
    `Warming up ${warmup}s; ${clients} scoped clients, ${hz}Hz requested, chaos ${values.chaos}.`,
  );
  await delay(warmup * 1000);
  const before = totals(core),
    cpuBefore = process.cpuUsage(),
    started = performance.now();
  measuring = true;
  progress = setInterval(() => {
    peakQueue = Math.max(peakQueue, core.writer.depth);
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1048576);
    console.log(
      `${Math.round((performance.now() - started) / 1000)}s: ${core.metrics.c.accepted.total - before.accepted} accepted, queue ${core.writer.depth}, clients ${core.live.ns.sockets.size}`,
    );
  }, 5000);
  await delay(seconds * 1000);
  const elapsedS = (performance.now() - started) / 1000;
  measuring = false;
  clearInterval(progress);
  const cpu = process.cpuUsage(cpuBefore),
    measured = difference(totals(core), before);
  const connected = core.live.ns.sockets.size;
  const pipeline = core.metrics.snapshot(core.pipelineStats());
  sim.stop();
  sim = null;
  for (const socket of sockets) socket.close();
  await core.stop();
  const persisted = await Reading.countDocuments({});
  const all = totals(core);
  const result = {
    measuredAt: new Date().toISOString(),
    environment: {
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryGb: round(os.totalmem() / 1073741824),
    },
    scenario: {
      sensors: 420,
      stations: 8,
      gateways: 8,
      clients,
      requestedSensorHz: hz,
      stationHz: 1,
      chaos: values.chaos,
      warmupS: warmup,
      elapsedS: round(elapsedS),
      tickMs: config.tickMs,
      writeIntervalMs: config.writeIntervalMs,
      bucketRefillPerSec: config.bucketRefillPerSec,
      transport: 'WebSocket; one zone and one sensor per client',
    },
    throughput: {
      acceptedPerS: round(measured.accepted / elapsedS),
      writtenPerS: round(measured.written / elapsedS),
      receivedPerS: round(measured.received / elapsedS),
      counters: measured,
    },
    delivery: {
      clientsConnected: connected,
      framesReceived: frames,
      rowsReceived: rows,
      payloadBytes: bytes,
      payloadBytesPerS: round(bytes / elapsedS),
      latencySamples: latency.length,
      sampledClientLatencyMs: {
        p50: percentile(latency, 50),
        p95: percentile(latency, 95),
        p99: percentile(latency, 99),
      },
      zoneViolations: violations,
      disconnects,
    },
    resources: {
      peakQueue,
      peakNodeRssMb: round(peakRssMb),
      processCpuCorePercent: round((cpu.user + cpu.system) / (elapsedS * 10000)),
      writeMs: pipeline.writeMs,
      serverTickLatencyMs: pipeline.e2eMs,
    },
    persistence: {
      persisted,
      writtenCounter: all.written,
      remainingQueue: core.writer.depth,
      reconciled: persisted === all.written && core.writer.depth === 0,
    },
    limitations: [
      'Single Windows host; server, simulator, and synthetic clients share one Node process. MongoDB is a separate temporary local process.',
      'Concurrent host workloads are not isolated; record them alongside any published result.',
      'Requested Hz is a setting, not measured throughput; the simulator polls every100ms and applies jitter.',
      'Client latency samples the first four rows of each received delta; volatile frames coalesce readings. This does not measure delivery of every event.',
      'Payload bytes exclude WebSocket/Socket.IO framing, TLS, and initial subscription snapshots. CPU/RSS exclude mongod and other processes.',
      'ACK means queued acceptance. Final count reconciliation is a graceful-drain check, not crash-durability or a long-duration capacity guarantee.',
    ],
  };
  if (values.output) {
    const target = resolve(projectRoot, values.output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (
    !frames ||
    !latency.length ||
    violations ||
    disconnects ||
    connected !== clients ||
    !result.persistence.reconciled ||
    measured.writeErrors
  )
    process.exitCode = 1;
} finally {
  measuring = false;
  clearInterval(progress);
  sim?.stop();
  for (const socket of sockets) socket.close();
  if (core) await core.stop();
  if (io) await new Promise((yes) => io.close(yes));
  await disconnectDb();
  if (mongo) await mongo.stop();
}
