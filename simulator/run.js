#!/usr/bin/env node
import './env.js';
import { parseArgs } from 'node:util';
import { startSimulator } from './index.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SIM_URL || 'http://localhost:4000' },
    hz: { type: 'string', default: process.env.SIM_HZ || '2' },
    chaos: { type: 'boolean', default: false },
    zones: { type: 'string' },
    'fire-speed': { type: 'string', default: '1' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Usage: emberwatch-sim [--url URL] [--hz N] [--chaos] [--zones north,east] [--fire-speed N]

  --url         server base URL (default http://localhost:4000)
  --hz          readings per second per sensor (default 2; 420 sensors x 2 = 840 ev/s)
  --chaos       inject duplicates, reordering, malformed events and link drops
  --zones       only run gateways for these zones
  --fire-speed  multiplier for fire spread speed (default 1)

Requires FLEET_SECRET to match the server.`);
  process.exit(0);
}

const sim = await startSimulator({
  url: values.url,
  fleetSecret: process.env.FLEET_SECRET || 'dev-only-fleet-secret',
  hz: Number(values.hz),
  chaos: values.chaos,
  zones: values.zones ? values.zones.split(',') : null,
  fireSpeed: Number(values['fire-speed']),
});

console.log(`[sim] streaming to ${values.url} at ${values.hz} Hz per sensor${values.chaos ? ' with chaos' : ''}`);
process.on('SIGINT', () => {
  sim.stop();
  process.exit(0);
});
