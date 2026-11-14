import { controlSchema } from '@emberwatch/shared';
import { log } from '../obs/log.js';

// /devices namespace: field gateways stream batches of readings here and
// receive acknowledgements that double as a backpressure signal. The
// simulator's controller also connects here to receive admin commands.
export function attachDeviceNamespace(io, { registry, ingestor, onGatewayChange }) {
  const ns = io.of('/devices');
  const online = new Map();
  let simStatus = null;

  ns.use((socket, next) => {
    const { id, key } = socket.handshake.auth || {};
    const gw = registry.verify(id, key);
    if (!gw) return next(new Error('unauthorized'));
    socket.data.gateway = gw;
    next();
  });

  ns.on('connection', (socket) => {
    const gw = socket.data.gateway;
    if (gw.kind === 'controller') {
      socket.join('controllers');
      socket.on('sim:status', (s) => {
        if (s && typeof s === 'object') simStatus = { ...s, at: Date.now() };
      });
    } else {
      online.set(gw.id, (online.get(gw.id) || 0) + 1);
      onGatewayChange?.(online);
    }
    log.info({ gateway: gw.id }, 'gateway connected');

    socket.on('r', (batch, ack) => {
      const res = ingestor.handle(gw, batch);
      if (typeof ack === 'function') ack(res);
    });

    socket.on('disconnect', (reason) => {
      if (gw.kind !== 'controller') {
        const n = (online.get(gw.id) || 1) - 1;
        if (n <= 0) online.delete(gw.id);
        else online.set(gw.id, n);
        onGatewayChange?.(online);
      }
      log.info({ gateway: gw.id, reason }, 'gateway disconnected');
    });
  });

  return {
    ns,
    online,
    controllers: () => ns.adapter.rooms.get('controllers')?.size || 0,
    simStatus: () => simStatus,
    // Forward a validated admin command to the simulator controller.
    sendControl(cmd) {
      const parsed = controlSchema.parse(cmd);
      ns.to('controllers').emit('control', parsed);
      return parsed;
    },
  };
}
