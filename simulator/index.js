import { io } from 'socket.io-client';
import { buildFleet } from '@emberwatch/shared';
import { deriveKey, CONTROLLER_ID } from '@emberwatch/shared/keys';
import { World } from './world.js';
import { GatewayClient } from './fleet.js';

export async function startSimulator({
  url = 'http://localhost:4000',
  fleetSecret,
  hz = 2,
  chaos = false,
  zones = null,
  fireSpeed = 1,
  quiet = false,
} = {}) {
  if (!fleetSecret) throw new Error('fleetSecret is required');
  const fleet = buildFleet();
  const world = new World({ fireSpeed });
  const settings = { hz, chaos };
  const stats = {
    sent: 0, accepted: 0, dup: 0, rejected: 0, limited: 0, timeouts: 0, backoffs: 0,
    droppedAtEdge: 0, connectErrors: 0, chaosDuplicates: 0, chaosMalformed: 0,
    chaosReordered: 0, chaosDisconnects: 0, lastError: null,
  };

  const gateways = fleet.gateways
    .filter((g) => !zones || zones.includes(g.zone))
    .map(
      (g, i) =>
        new GatewayClient({
          id: g.id,
          url,
          key: deriveKey(fleetSecret, g.id),
          devices: fleet.devices.filter((d) => d.gateway === g.id),
          world,
          getHz: () => settings.hz,
          chaos: () => settings.chaos,
          stats,
          seed: 1000 + i * 97,
        }),
    );

  const stepTimer = setInterval(() => world.step(0.25), 250);

  // Control channel: admin commands from the dashboard arrive here.
  const ctrl = io(`${url}/devices`, {
    auth: { id: CONTROLLER_ID, key: deriveKey(fleetSecret, CONTROLLER_ID) },
    transports: ['websocket'],
  });
  ctrl.on('control', (cmd) => {
    switch (cmd.cmd) {
      case 'ignite':
        world.ignite(cmd.lat, cmd.lng);
        break;
      case 'extinguish':
        world.extinguish();
        break;
      case 'wind':
        world.setWind(cmd.dir, cmd.speed);
        break;
      case 'rate':
        settings.hz = cmd.hz;
        break;
      case 'chaos':
        settings.chaos = cmd.on;
        break;
    }
    if (!quiet) console.log(`[control] ${JSON.stringify(cmd)}`);
  });
  // Report world state so the dashboard can show what the simulator is doing.
  const statusTimer = setInterval(() => {
    if (ctrl.connected) ctrl.emit('sim:status', { ...settings, ...world.describe(), stats });
  }, 1000);

  let logTimer = null;
  if (!quiet) {
    let last = 0;
    logTimer = setInterval(() => {
      const rate = (stats.sent - last) / 5;
      last = stats.sent;
      const w = world.describe();
      console.log(
        `[sim] ${rate.toFixed(0)} ev/s sent | accepted ${stats.accepted} dup ${stats.dup} rejected ${stats.rejected} ` +
          `limited ${stats.limited} | fire ${w.burningCells} cells | wind ${w.wind.speed} km/h from ${w.wind.compass}` +
          (stats.lastError ? ` | last error: ${stats.lastError}` : ''),
      );
    }, 5000);
  }

  return {
    world,
    stats,
    settings,
    stop() {
      clearInterval(stepTimer);
      clearInterval(statusTimer);
      clearInterval(logTimer);
      ctrl.close();
      gateways.forEach((g) => g.stop());
    },
  };
}
