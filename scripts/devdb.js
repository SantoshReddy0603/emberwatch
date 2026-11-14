// Starts a persistent local MongoDB for development when Docker or a system
// mongod is not available. Data survives restarts. Set DEV_DB_PATH to choose
// where it lives (defaults to ~/.emberwatch/db).
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const dbPath = process.env.DEV_DB_PATH || join(homedir(), '.emberwatch', 'db');
mkdirSync(dbPath, { recursive: true });

const server = await MongoMemoryServer.create({
  instance: { port: Number(process.env.DEV_DB_PORT || 27017), dbPath, storageEngine: 'wiredTiger', launchTimeout: 120000 },
});

console.log(`MongoDB ready at ${server.getUri()} (data: ${dbPath})`);

const stop = async () => {
  await server.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
