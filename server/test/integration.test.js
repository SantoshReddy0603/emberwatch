import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import request from 'supertest';
import { deriveKey } from '@emberwatch/shared/keys';
import { config } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createCore } from '../src/core.js';
import { createApp } from '../src/app.js';
import { Reading } from '../src/models/Reading.js';
import { Rollup } from '../src/models/Rollup.js';
import { Alert } from '../src/models/Alert.js';
import jwt from 'jsonwebtoken';

process.env.MONGOMS_DOWNLOAD_DIR ||= resolve('../.data/mongodb-binaries');
let mongo, core, io, server, app, url, adminToken, rangerToken, north, east, gateway;
const sockets = [];
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const event = (st, seq, extra = {}) => ({
  sid: st.id,
  seq,
  ts: Date.now(),
  m: { t: 30, h: 35, s: 4 },
  ...extra,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await connectDb(mongo.getUri('emberwatch_test'));
  await seed();
  server = http.createServer((req, res) => app(req, res));
  io = new Server(server, { cors: { origin: config.corsOrigins } });
  core = await createCore({
    config: { ...config, tickMs: 50, bucketCapacity: 2000, bucketRefillPerSec: 2000 },
    io,
  });
  app = createApp(core);
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  url = `http://127.0.0.1:${server.address().port}`;
  north = core.state.list.find((st) => st.zone === 'north' && st.type === 'sensor');
  east = core.state.list.find((st) => st.zone === 'east' && st.type === 'sensor');
  gateway = core.registry.verify(north.gateway, deriveKey(config.fleetSecret, north.gateway));
  const login = async (email) =>
    (
      await request(app)
        .post('/api/auth/login')
        .send({ email, password: config.demoPassword })
        .expect(200)
    ).body.token;
  adminToken = await login('admin@emberwatch.dev');
  rangerToken = await login('north@emberwatch.dev');
}, 240000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (core) await core.stop();
  if (io) await new Promise((yes) => io.close(yes));
  await disconnectDb();
  if (mongo) await mongo.stop();
}, 60000);

describe.sequential('authenticated application', () => {
  it('protects APIs and never returns password hashes', async () => {
    await request(app).get('/api/devices').expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@emberwatch.dev', password: 'wrong' })
      .expect(401);
    const me = await request(app).get('/api/auth/me').set(auth(adminToken)).expect(200);
    expect(me.body.user.role).toBe('admin');
    expect(JSON.stringify(me.body)).not.toContain('passHash');
  });
  it('scopes ranger snapshots, history, and controls', async () => {
    const snap = await request(app).get('/api/snapshot').set(auth(rangerToken)).expect(200);
    expect(snap.body.devices.length).toBeGreaterThan(0);
    expect(snap.body.devices.every((st) => st.zone === 'north')).toBe(true);
    expect(JSON.stringify(snap.body)).not.toContain('keyHash');
    await request(app).get('/api/snapshot?zone=east').set(auth(rangerToken)).expect(403);
    await request(app).get(`/api/sensors/${east.id}/history`).set(auth(rangerToken)).expect(403);
    await request(app)
      .post('/api/control')
      .set(auth(rangerToken))
      .send({ cmd: 'extinguish' })
      .expect(403);
    await request(app).get('/api/metrics').set(auth(rangerToken)).expect(403);
  });
  it('validates history bounds and source credentials', async () => {
    await request(app)
      .get(`/api/sensors/${north.id}/history?from=20&to=10`)
      .set(auth(adminToken))
      .expect(400);
    await request(app)
      .get(`/api/sensors/${north.id}/history?limit=500000`)
      .set(auth(adminToken))
      .expect(400);
    await request(app)
      .post('/api/ingest')
      .send([event(north, 1)])
      .expect(401);
    await request(app)
      .post('/api/ingest')
      .set({
        'x-gateway-id': north.gateway,
        'x-gateway-key': deriveKey(config.fleetSecret, north.gateway),
      })
      .send([event(north, 1)])
      .expect(200);
  });
  it('merges queued and persisted history by event identity', async () => {
    const queued = await request(app)
      .get(`/api/sensors/${north.id}/history`)
      .set(auth(adminToken))
      .expect(200);
    expect(queued.body.points.filter((p) => p.seq === 1)).toHaveLength(1);
    await core.writer.flush();
    const stored = await request(app)
      .get(`/api/sensors/${north.id}/history`)
      .set(auth(adminToken))
      .expect(200);
    expect(stored.body.points.filter((p) => p.seq === 1)).toHaveLength(1);
  });
  it('keeps rollups exact for duplicates older than the in-memory ring', async () => {
    const records = Array.from({ length: 265 }, (_, i) => event(north, i + 2));
    expect(core.ingestor.handle(gateway, records).accepted).toBe(265);
    await core.writer.flush();
    await core.rollups.flush();
    const before = await Rollup.aggregate([
      { $match: { sid: north.id } },
      { $group: { _id: null, n: { $sum: '$n' } } },
    ]);
    core.ingestor.handle(gateway, [event(north, 1)]);
    await core.writer.flush();
    await core.rollups.flush();
    const after = await Rollup.aggregate([
      { $match: { sid: north.id } },
      { $group: { _id: null, n: { $sum: '$n' } } },
    ]);
    expect(before[0].n).toBe(266);
    expect(after[0].n).toBe(266);
    expect(await Reading.countDocuments({ sid: north.id })).toBe(266);
  });
  it('retains late events without replacing newer state and seeds future points', async () => {
    const seq = north.seq;
    core.ingestor.handle(gateway, [
      event(north, 0, { ts: Date.now() - 1000, m: { t: 90, h: 20, s: 300 } }),
    ]);
    expect(north.seq).toBe(seq);
    expect(north.t).toBe(30);
    core.ingestor.handle(gateway, [event(north, seq + 1, { ts: Date.now() + 3000 })]);
    const history = await request(app)
      .get(`/api/sensors/${north.id}/history`)
      .set(auth(adminToken))
      .expect(200);
    expect(history.body.points.some((p) => p.seq === 0)).toBe(true);
    expect(history.body.pending.some((p) => p.seq === seq + 1)).toBe(true);
  });
  it('authorizes actual Socket.IO rooms and repairs scope on resubscription', async () => {
    const socket = clientIo(`${url}/live`, {
      auth: { token: rangerToken },
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
    });
    sockets.push(socket);
    socket.connect();
    await once(socket, 'connect');
    const denied = await socket.timeout(5000).emitWithAck('subscribe', { zones: ['east'] });
    expect(denied.ok).toBe(false);
    const joined = await socket
      .timeout(5000)
      .emitWithAck('subscribe', { zones: ['north'], sensor: north.id });
    expect(joined.ok).toBe(true);
    expect(joined.snapshot.devices.every((st) => st.zone === 'north')).toBe(true);
    const serverSocket = core.live.ns.sockets.get(socket.id);
    expect(serverSocket.rooms.has('zone:north')).toBe(true);
    expect(serverSocket.rooms.has('zone:east')).toBe(false);
    const frames = [];
    socket.on('f', (frame) => frames.push(frame));
    core.state.takeDirty();
    const eastGateway = core.registry.verify(
      east.gateway,
      deriveKey(config.fleetSecret, east.gateway),
    );
    core.ingestor.handle(eastGateway, [event(east, 1)]);
    core.live.tick();
    await delay(50);
    expect(frames).toHaveLength(0);
    await socket.timeout(5000).emitWithAck('subscribe', { zones: [] });
    expect(serverSocket.rooms.has('zone:north')).toBe(false);
    expect(serverSocket.rooms.has(`sensor:${north.id}`)).toBe(false);
  }, 15000);
  it('supports the polling transport without conflicting HTTP responders', async () => {
    const socket = clientIo(`${url}/live`, {
      auth: { token: adminToken },
      transports: ['polling'],
      forceNew: true,
      autoConnect: false,
    });
    sockets.push(socket);
    socket.connect();
    await once(socket, 'connect');
    expect((await socket.timeout(5000).emitWithAck('subscribe', { zones: ['north'] })).ok).toBe(
      true,
    );
  }, 15000);
  it('delivers zone deltas and selected-source details together on both transports', async () => {
    for (const transport of ['websocket', 'polling']) {
      const socket = clientIo(`${url}/live`, {
        auth: { token: rangerToken },
        transports: [transport],
        forceNew: true,
        autoConnect: false,
      });
      sockets.push(socket);
      socket.connect();
      await once(socket, 'connect');
      const frames = [],
        details = [];
      socket.on('f', (frame) => frames.push(frame));
      socket.on('sensor', (value) => details.push(value));
      expect(
        (
          await socket.timeout(5000).emitWithAck('subscribe', {
            zones: ['north'],
            sensor: north.id,
          })
        ).ok,
      ).toBe(true);
      for (let i = 0; i < 6; i++) {
        core.ingestor.handle(gateway, [event(north, north.seq + 1)]);
        core.live.tick();
        await delay(80);
      }
      expect(frames.length).toBeGreaterThanOrEqual(4);
      expect(details.length).toBeGreaterThanOrEqual(4);
      expect(frames.every((frame) => frame.zone === 'north')).toBe(true);
      expect(details.every((value) => value.id === north.id)).toBe(true);
      socket.close();
    }
  }, 20000);
  it('persists incidents, scopes acknowledgement, and requires recovery separately', async () => {
    const previousDwell = core.engine.dwellMs,
      previousRecovery = core.engine.recoveryMs;
    core.engine.dwellMs = 0;
    core.engine.recoveryMs = 0;
    core.ingestor.handle(gateway, [event(north, north.seq + 1, { m: { t: 75, h: 15, s: 400 } })]);
    await core.engine.flush();
    const alert = await Alert.findOne({ sid: north.id, type: 'ignition', state: 'open' }).lean();
    expect(alert).not.toBeNull();
    const eastLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'east@emberwatch.dev', password: config.demoPassword })
      .expect(200);
    await request(app)
      .post(`/api/alerts/${alert._id}/ack`)
      .set(auth(eastLogin.body.token))
      .expect(403);
    await request(app).post(`/api/alerts/${alert._id}/ack`).set(auth(rangerToken)).expect(200);
    const acknowledged = await Alert.findById(alert._id).lean();
    expect(acknowledged.state).toBe('ack');
    expect(acknowledged.active).toBe(true);
    core.ingestor.handle(gateway, [event(north, north.seq + 1)]);
    await core.engine.flush();
    expect((await Alert.findById(alert._id).lean()).state).toBe('resolved');
    core.engine.dwellMs = previousDwell;
    core.engine.recoveryMs = previousRecovery;
  });
  it('rejects an expired JWT on HTTP and Socket.IO', async () => {
    const token = jwt.sign({}, config.jwtSecret, {
      subject: '000000000000000000000000',
      expiresIn: -1,
    });
    await request(app).get('/api/auth/me').set(auth(token)).expect(401);
    const socket = clientIo(`${url}/live`, {
      auth: { token },
      reconnection: false,
      forceNew: true,
      autoConnect: false,
    });
    sockets.push(socket);
    socket.connect();
    const [error] = await once(socket, 'connect_error');
    expect(error.message).toBe('unauthorized');
  }, 15000);
  it('requires a new cut instead of omitting a concurrently advanced rollup', async () => {
    const bucket = await Rollup.findOne({ sid: north.id }).lean();
    const originalFind = Rollup.find.bind(Rollup);
    const spy = vi.spyOn(Rollup, 'find').mockImplementationOnce((filter) => {
      const query = originalFind(filter),
        lean = query.lean.bind(query);
      query.lean = async () => {
        await Rollup.updateOne({ _id: bucket._id }, { $set: { lastSeq: north.seq + 1 } });
        return lean();
      };
      return query;
    });
    try {
      const response = await request(app)
        .get(`/api/sensors/${north.id}/history?from=${Date.now() - 7 * 3600000}`)
        .set(auth(adminToken))
        .expect(409);
      expect(response.body.code).toBe('HISTORY_CHANGED');
    } finally {
      spy.mockRestore();
      await Rollup.updateOne({ _id: bucket._id }, { $set: { lastSeq: bucket.lastSeq } });
    }
  });
  it('keeps delayed six-hour weather queries in retained raw history', async () => {
    const station = core.state.list.find((st) => st.type === 'station' && st.zone === 'north');
    const weatherGateway = core.registry.verify(
      station.gateway,
      deriveKey(config.fleetSecret, station.gateway),
    );
    core.ingestor.handle(weatherGateway, [
      event(station, station.seq + 1, {
        m: { t: 29, h: 32, ws: 18, wd: 210 },
      }),
    ]);
    await core.writer.flush();
    const cutoff = Date.now() - config.rawTtlMinutes * 60000;
    const response = await request(app)
      .get(`/api/sensors/${station.id}/history?from=${cutoff - 1500}`)
      .set(auth(adminToken))
      .expect(200);
    expect(response.body.mode).toBe('raw');
    expect(response.body.from).toBeGreaterThanOrEqual(cutoff);
    expect(response.body.points.some((p) => p.ws === 18 && p.wd === 210)).toBe(true);
    await request(app)
      .get(`/api/sensors/${station.id}/history?from=${Date.now() - 86400000}`)
      .set(auth(adminToken))
      .expect(416);
    await request(app)
      .get(`/api/sensors/${station.id}/history?from=${cutoff - 7200000}&to=${cutoff - 3600000}`)
      .set(auth(adminToken))
      .expect(416);
  });
  it('hydrates the durable newest sequence through indexed per-source queries', async () => {
    await core.writer.flush();
    const newest = await Reading.findOne({ sid: north.id }).sort({ seq: -1 }).lean();
    const restartServer = http.createServer();
    const restartIo = new Server(restartServer);
    let restored;
    try {
      restored = await createCore({ config, io: restartIo });
      expect(restored.state.get(north.id).seq).toBe(newest.seq);
      expect(restored.state.get(north.id).ts).toBe(Number(newest.ts));
    } finally {
      if (restored) await restored.stop();
      await new Promise((yes) => restartIo.close(yes));
    }
  }, 20000);
});
