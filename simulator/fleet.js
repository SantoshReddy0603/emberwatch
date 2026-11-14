import { io } from 'socket.io-client';
import { toXY, mulberry32 } from '@emberwatch/shared';
import { noise } from './world.js';

const BUFFER_CAP = 20000;
const MAX_INFLIGHT = 2;

// Sequence numbers start from the wall clock so a restarted device never
// reuses numbers it already sent (supports up to 20 readings per second).
const seqBase = () => Math.floor(Date.now() / 50);

class Agent {
  constructor(dev, rand) {
    this.dev = dev;
    this.rand = rand;
    this.pos = toXY(dev);
    this.seq = seqBase();
    this.offsetT = noise(rand, 0.8);
    this.offsetH = noise(rand, 2);
    this.battery = 70 + rand() * 30;
    this.rssi = -70 - rand() * 30;
    this.dead = false;
    this.phase = rand();
    this.next = 0;
  }

  read(world, now) {
    const amb = world.ambient(this.dev.zone, now);
    const r = this.rand;
    this.battery = Math.max(5, this.battery - 0.00002);
    const m = {};
    if (this.dev.type === 'station') {
      const gust = r() < 0.004 ? 18 + r() * 20 : 0;
      m.t = round1(amb.t + this.offsetT + noise(r, 0.2));
      m.h = round1(clamp(amb.h + this.offsetH + noise(r, 0.6), 2, 100));
      m.ws = round1(Math.max(0, world.wind.speed + noise(r, 2.5) + gust));
      m.wd = Math.round((world.wind.dir + noise(r, 8) + 360) % 360);
    } else {
      const fx = world.fireEffect(this.pos.x, this.pos.y);
      if (fx.onFire && r() < 0.02) this.dead = true;
      const glitch = r() < 0.00005 ? 200 + r() * 200 : 0;
      m.t = round1(clamp(amb.t + this.offsetT + fx.heat + noise(r, 0.35), -40, 199));
      m.h = round1(clamp(amb.h + this.offsetH - fx.heat * 0.35 + noise(r, 0.8), 1, 100));
      m.s = round1(clamp(3 + r() * 2 + fx.smoke + glitch + noise(r, 0.6), 0, 4999));
      m.co = round1(clamp(0.6 + fx.smoke * 0.09 + noise(r, 0.2), 0, 4999));
    }
    m.b = Math.round(this.battery);
    m.rssi = Math.round(this.rssi + noise(r, 2));
    return { sid: this.dev.id, seq: ++this.seq, ts: now, m };
  }
}

// A field gateway: polls its sensors on schedule, buffers readings and ships
// them in batches. Honours retryAfterMs from the server and keeps a bounded
// store-and-forward buffer while disconnected.
export class GatewayClient {
  constructor({ id, url, key, devices, world, getHz, chaos, stats, seed }) {
    this.id = id;
    this.world = world;
    this.getHz = getHz;
    this.chaos = chaos;
    this.stats = stats;
    this.rand = mulberry32(seed);
    this.agents = devices.map((d) => new Agent(d, mulberry32(seed ^ hashId(d.id))));
    this.buffer = [];
    this.inflight = 0;
    this.pausedUntil = 0;
    this.socket = io(`${url}/devices`, {
      auth: { id, key },
      transports: ['websocket'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
    });
    this.socket.on('connect_error', (err) => {
      this.stats.connectErrors++;
      this.stats.lastError = err.message;
    });
    this.timer = setInterval(() => this.tick(), 100);
    this.flapTimer = setInterval(() => this.maybeFlap(), 15000);
  }

  tick() {
    const now = Date.now();
    const hz = this.getHz();
    for (const a of this.agents) {
      if (a.dead) continue;
      if (now < a.next) continue;
      const period = 1000 / (a.dev.type === 'station' ? Math.min(hz, 1) : hz);
      a.next = (a.next || now + a.phase * period) + period * (0.9 + this.rand() * 0.2);
      if (a.next < now) a.next = now + period;
      const reading = a.read(this.world, now);
      this.enqueue(reading);
    }
    this.send();
  }

  enqueue(reading) {
    const c = this.chaos();
    if (c && this.rand() < 0.005) {
      // Malformed payload: humidity out of range.
      this.buffer.push({ ...reading, m: { ...reading.m, h: 180 } });
      this.stats.chaosMalformed++;
    }
    this.buffer.push(reading);
    if (c && this.rand() < 0.01) {
      this.buffer.push(reading);
      this.stats.chaosDuplicates++;
    }
    if (this.buffer.length > BUFFER_CAP) {
      const drop = this.buffer.length - BUFFER_CAP;
      this.buffer.splice(0, drop);
      this.stats.droppedAtEdge += drop;
    }
  }

  send() {
    if (!this.socket.connected || this.inflight >= MAX_INFLIGHT || !this.buffer.length) return;
    if (Date.now() < this.pausedUntil) return;
    const batch = this.buffer.splice(0, 400);
    if (this.chaos() && this.rand() < 0.05 && batch.length > 2) {
      // Swap two readings to simulate out-of-order delivery over the mesh.
      const i = Math.floor(this.rand() * batch.length);
      const j = Math.floor(this.rand() * batch.length);
      [batch[i], batch[j]] = [batch[j], batch[i]];
      this.stats.chaosReordered++;
    }
    this.inflight++;
    this.socket.timeout(5000).emit('r', batch, (err, ack) => {
      this.inflight--;
      if (err) {
        // No ack: put the batch back so it is retried; dedup makes this safe.
        this.buffer.unshift(...batch);
        this.stats.timeouts++;
        return;
      }
      this.stats.sent += batch.length;
      this.stats.accepted += ack.accepted || 0;
      this.stats.dup += ack.dup || 0;
      this.stats.rejected += ack.rejected || 0;
      this.stats.limited += ack.limited || 0;
      if (ack.retryAfterMs > 0) {
        this.pausedUntil = Date.now() + ack.retryAfterMs;
        this.stats.backoffs++;
        if (!ack.accepted && ack.limited) this.buffer.unshift(...batch);
      }
    });
  }

  maybeFlap() {
    if (!this.chaos() || this.rand() > 0.15) return;
    this.stats.chaosDisconnects++;
    this.socket.disconnect();
    setTimeout(() => this.socket.connect(), 2000 + this.rand() * 2000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.flapTimer);
    this.socket.close();
  }
}

function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
