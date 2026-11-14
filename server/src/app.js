import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ingestRouter } from './api/ingest.js';
import { log } from './obs/log.js';
import { authRouter } from './auth.js';
import { readRouter } from './api/read.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

export function createApp(core) {
  const { config } = core;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      contentSecurityPolicy: {
        directives: {
          imgSrc: [
            "'self'",
            'data:',
            'https://tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
          ],
          connectSrc: ["'self'", ...config.corsOrigins],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
    }),
  );
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), ...core.pipelineStats() });
  });

  app.use('/api/ingest', ingestRouter(core));
  app.use('/api/auth', authRouter(config));
  app.use('/api', readRouter(core));
  app.get('/readyz', (_req, res) =>
    res
      .status(mongoose.connection.readyState === 1 ? 200 : 503)
      .json({ ready: mongoose.connection.readyState === 1 }),
  );

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  const clientDir = fileURLToPath(new URL('../../client/dist/', import.meta.url));
  const indexFile = `${clientDir}/index.html`;
  if (existsSync(indexFile)) {
    app.use(express.static(clientDir, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(indexFile));
  }

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large')
      return res.status(413).json({ error: 'payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    log.error({ err }, 'unhandled error');
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'internal error' });
  });

  return app;
}
