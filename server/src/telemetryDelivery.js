// Keep only the newest unsent packet for each subscribed telemetry stream.
// Waiting for transport readiness prevents one volatile stream starving another.
export function telemetryDelivery(socket, { sent, skipped }) {
  const pending = new Map();
  let transport,
    closed = false;
  const flush = () => {
    while (!closed && socket.connected && transport?.writable && pending.size) {
      const [key, packet] = pending.entries().next().value;
      pending.delete(key);
      if (!socket.rooms.has(packet.room)) continue;
      socket.volatile.emit(packet.event, packet.payload);
      sent(packet.bytes);
    }
  };
  const bind = () => {
    transport?.off('ready', flush);
    transport = socket.conn.transport;
    transport.on('ready', flush);
    flush();
  };
  bind();
  socket.conn.on('upgrade', bind);
  const close = () => {
    closed = true;
    pending.clear();
    transport?.off('ready', flush);
    socket.conn.off('upgrade', bind);
  };
  socket.once('disconnect', close);
  return {
    pending,
    clear() {
      pending.clear();
    },
    enqueue(room, event, payload, bytes) {
      if (closed || !socket.rooms.has(room)) return;
      const key = `${room}|${event}`;
      if (pending.has(key)) skipped();
      // Four zone streams and one selected-source stream are the maximum.
      if (!pending.has(key) && pending.size >= 5) {
        pending.delete(pending.keys().next().value);
        skipped();
      }
      pending.set(key, { room, event, payload, bytes });
      flush();
    },
    close,
  };
}
