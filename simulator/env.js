// Load the repo-level .env when present. Hosted environments set real
// environment variables instead, so a missing file is fine.
import { existsSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
if (existsSync(file)) process.loadEnvFile(file);
