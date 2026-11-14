import './env.js';
import bcrypt from 'bcryptjs';
import { buildFleet } from '@emberwatch/shared';
import { deriveKey, hashKey, CONTROLLER_ID } from '@emberwatch/shared/keys';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { Device } from './models/Device.js';
import { Gateway } from './models/Gateway.js';
import { User } from './models/User.js';
import { Reading } from './models/Reading.js';
import { Rollup } from './models/Rollup.js';
import { Alert } from './models/Alert.js';

export const DEMO_USERS = [
  { email: 'admin@emberwatch.dev', name: 'Riya Kapoor', role: 'admin', zones: [] },
  { email: 'ops@emberwatch.dev', name: 'Dispatch Desk', role: 'operator', zones: [] },
  { email: 'north@emberwatch.dev', name: 'Arjun Mehta', role: 'ranger', zones: ['north'] },
  { email: 'east@emberwatch.dev', name: 'Lena Ortiz', role: 'ranger', zones: ['east'] },
  { email: 'south@emberwatch.dev', name: 'Sam Okafor', role: 'ranger', zones: ['south', 'west'] },
];

export async function seed({ reset = false } = {}) {
  const fleet = buildFleet();

  if (reset) {
    await Promise.all([Reading.deleteMany({}), Rollup.deleteMany({}), Alert.deleteMany({})]);
  }

  await Device.bulkWrite(
    fleet.devices.map(({ id, ...d }) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: d, $setOnInsert: { lastSeq: -1 } },
        upsert: true,
      },
    })),
  );

  const gateways = [
    ...fleet.gateways.map((g) => ({ ...g, kind: 'gateway' })),
    { id: CONTROLLER_ID, zone: '*', kind: 'controller' },
  ];
  await Gateway.bulkWrite(
    gateways.map(({ id, ...g }) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { ...g, keyHash: hashKey(deriveKey(config.fleetSecret, id)) } },
        upsert: true,
      },
    })),
  );

  const passHash = await bcrypt.hash(config.demoPassword, 10);
  await User.bulkWrite(
    DEMO_USERS.map((u) => ({
      updateOne: { filter: { email: u.email }, update: { $set: { ...u, passHash } }, upsert: true },
    })),
  );

  await Promise.all([Reading.syncIndexes(), Rollup.syncIndexes(), Alert.syncIndexes(), Device.syncIndexes()]);

  return { devices: fleet.devices.length, gateways: gateways.length, users: DEMO_USERS.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await connectDb();
  const res = await seed({ reset: process.argv.includes('--reset') });
  console.log(`Seeded ${res.devices} devices, ${res.gateways} gateways, ${res.users} users.`);
  console.log(`Demo accounts use the password from DEMO_PASSWORD (default "ember-demo").`);
  await disconnectDb();
}
