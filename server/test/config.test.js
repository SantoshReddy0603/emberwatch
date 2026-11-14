import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../../', import.meta.url));
const load = (changes) =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('./server/src/config.js'); console.log('configuration accepted')",
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        FLEET_SECRET: 'b'.repeat(48),
        ...changes,
      },
      encoding: 'utf8',
    },
  );

describe('production configuration', () => {
  it('refuses missing, short and example secrets before startup', () => {
    for (const name of ['JWT_SECRET', 'FLEET_SECRET']) {
      for (const value of ['', 'too-short', 'change-me-to-a-long-random-string']) {
        const result = load({ [name]: value });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(name);
        expect(result.stderr).not.toContain('too-short');
      }
    }
  });
  it('accepts explicit production secrets', () => {
    expect(load({}).status).toBe(0);
  });
});
