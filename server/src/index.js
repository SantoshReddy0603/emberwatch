import './env.js';
import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { createCore } from './core.js';
import { createApp } from './app.js';
import { log } from './obs/log.js';

await connectDb();

const httpServer = http.createServer((req, res) => app(req, res));
const io = new Server(httpServer, {
  cors: { origin: config.corsOrigins },
  maxHttpBufferSize: 512 * 1024,
  pingInterval: 10000,
  pingTimeout: 8000,
  perMessageDeflate: false,
});

const core = await createCore({ config, io });
const app = createApp(core);
core.start();

httpServer.listen(config.port, config.host, () => {
  log.info({ port: config.port }, 'EmberWatch server listening');
});

let sim = null;
if (config.simEmbedded) {
  const { startSimulator } = await import('@emberwatch/simulator');
  sim = await startSimulator({
    url: `http://127.0.0.1:${config.port}`,
    fleetSecret: config.fleetSecret,
    hz: config.simHz,
    quiet: true,
  });
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'shutting down');
  sim?.stop();
  io.close();
  await core.stop();
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
