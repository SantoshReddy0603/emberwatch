import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { telemetryDelivery } from '../src/telemetryDelivery.js';

function connection() {
  const socket = new EventEmitter();
  socket.connected = true;
  socket.rooms = new Set(['zone:north', 'zone:east', 'zone:west', 'zone:south', 'sensor:N-001']);
  socket.conn = new EventEmitter();
  socket.conn.transport = Object.assign(new EventEmitter(), { writable: false });
  const packets = [],
    sent = vi.fn(),
    skipped = vi.fn();
  socket.volatile = {
    emit(event, payload) {
      packets.push({ event, payload });
      socket.conn.transport.writable = false;
    },
  };
  const delivery = telemetryDelivery(socket, { sent, skipped });
  const ready = () => {
    socket.conn.transport.writable = true;
    socket.conn.transport.emit('ready');
  };
  return { socket, delivery, packets, sent, skipped, ready };
}

describe('bounded telemetry delivery', () => {
  it('coalesces each stream and drains zone and detail packets fairly', () => {
    const { delivery, packets, sent, skipped, ready } = connection();
    for (let seq = 1; seq <= 100; seq++) {
      for (const zone of ['north', 'east', 'west', 'south'])
        delivery.enqueue(`zone:${zone}`, 'f', { zone, seq }, 10);
      delivery.enqueue('sensor:N-001', 'sensor', { seq }, 20);
    }
    expect(delivery.pending.size).toBe(5);
    expect(packets).toHaveLength(0);
    for (let i = 0; i < 5; i++) ready();
    expect(packets).toHaveLength(5);
    expect(packets.every((p) => p.payload.seq === 100)).toBe(true);
    expect(packets.at(-1).event).toBe('sensor');
    expect(delivery.pending.size).toBe(0);
    expect(sent).toHaveBeenCalledTimes(5);
    expect(skipped).toHaveBeenCalledTimes(495);
    delivery.close();
  });
  it('discards pending old-scope data on resubscribe and releases listeners on disconnect', () => {
    const { socket, delivery, packets, ready } = connection();
    delivery.enqueue('zone:north', 'f', { zone: 'north' }, 10);
    delivery.clear();
    socket.rooms = new Set(['zone:east']);
    delivery.enqueue('zone:east', 'f', { zone: 'east' }, 10);
    ready();
    expect(packets.map((p) => p.payload.zone)).toEqual(['east']);
    delivery.enqueue('zone:east', 'f', { zone: 'east', seq: 2 }, 10);
    socket.emit('disconnect');
    expect(delivery.pending.size).toBe(0);
    expect(socket.conn.transport.listenerCount('ready')).toBe(0);
    expect(socket.conn.listenerCount('upgrade')).toBe(0);
    ready();
    expect(packets).toHaveLength(1);
  });
  it('reattaches readiness on transport upgrade without losing the latest packet', () => {
    const { socket, delivery, packets, ready } = connection();
    delivery.enqueue('zone:north', 'f', { seq: 2 }, 10);
    const old = socket.conn.transport;
    socket.conn.transport = Object.assign(new EventEmitter(), { writable: false });
    socket.conn.emit('upgrade', socket.conn.transport);
    expect(old.listenerCount('ready')).toBe(0);
    ready();
    expect(packets).toEqual([{ event: 'f', payload: { seq: 2 } }]);
    delivery.close();
  });
});
