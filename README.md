# EmberWatch

## Overview

EmberWatch monitors a simulated forest sensor mesh for early signs of wildfire. It brings live conditions, spatially confirmed anomalies, incident handling, and recent history into one control room. Administrators manage the simulation; operations staff monitor the whole forest; rangers receive only their assigned zones.

All telemetry is generated continuously by virtual devices with current timestamps. The Kaiser Ridge scenario and sensor locations are fictional. The underlying OpenStreetMap geography is real. No external wildfire feed or physical hardware is required.

## Setup and execution

Use Node.js 22.12 or newer, npm, and MongoDB 7 or newer. Install from the repository root:

```sh
npm ci
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` on macOS/Linux). Replace both secret placeholders with separate random strings of at least 32 characters. The server and standalone simulator must share `FLEET_SECRET`.

Start a local development database in one terminal:

```sh
npm run db
```

The helper downloads a real mongod on its first run and keeps its files in `~/.emberwatch/db`. Set `DEV_DB_PATH` and `DEV_DB_PORT` to use another directory/port; update `MONGO_URI` to match. An existing MongoDB or Atlas database also works.

In a second terminal:

```sh
npm run seed
npm run dev
```

Open **http://127.0.0.1:5173**. The development command runs Express on 4000, the simulator, and Vite on 5173. Keep `SIM_EMBEDDED=0` in this mode to avoid running two simulators. Seeding provisions devices, gateways, and demo users; running it again updates their credentials from the current environment without clearing telemetry. Do not use `seed -- --reset` on data you need to retain.

| Demo account           | Role          | Access                            |
| ---------------------- | ------------- | --------------------------------- |
| `admin@emberwatch.dev` | Administrator | All zones and simulation controls |
| `ops@emberwatch.dev`   | Operations    | All zones and pipeline metrics    |
| `north@emberwatch.dev` | Ranger        | North                             |
| `east@emberwatch.dev`  | Ranger        | East                              |
| `south@emberwatch.dev` | Ranger        | South and West                    |

The default password is `ember-demo`. One-click demo buttons use that default. After changing `DEMO_PASSWORD` and reseeding, sign in using the email/password form. Tokens stay in the current tab's session storage and expire after 12 hours by default (`JWT_TTL`).

For one process serving the built frontend, run `npm run build`, set `SIM_EMBEDDED=1`, then run `npm start`. Open **http://127.0.0.1:4000**. [Deployment instructions](docs/DEPLOYMENT.md) cover the supplied Render configuration and MongoDB setup.

## Features

- 420 forest sensors, 8 weather stations, 8 gateways, and 4 independently subscribed zones.
- Dark control room with Canvas sensor map, temperature/smoke heat layer, wind information, and apparent-spread arrows.
- Selected-source charts with live/raw-history merge, 15-minute to 24-hour ranges, chart pause, and peak-preserving downsampling.
- EWMA and robust anomaly scores, hard thresholds, dwell/recovery hysteresis, neighboring-source confirmation, and offline detection.
- Persistent open, acknowledged, and resolved incidents with bounded timelines. Acknowledging an incident does not clear its condition.
- Administrator ignition, extinguishing, wind, rate, and chaos controls.
- Zone history scrubber, searchable virtualized source list, virtualized incidents, and pipeline metrics.
- Authenticated APIs and Socket.IO subscriptions with ranger zone isolation, validation, token buckets, and bounded queues.

The 0–100 **fire danger index** is a Chandler-derived temperature/humidity composite with a wind adjustment. It is not the official Canadian Fire Weather Index, a fire probability, or a calibrated forecast. The cellular fire model and apparent-spread estimate describe this simulation; they are not measurements from an actual incident.

## Tech stack

MongoDB and Mongoose store readings, minute aggregates, incidents, users, and gateway credentials. Node.js with Express handles ingestion, authentication, history, and control. React renders the client; Socket.IO carries live telemetry. Leaflet, uPlot, and react-window keep map, charts, and large lists responsive. Vite builds the frontend. All workspaces use JavaScript.

## Data generation and ingestion

The simulator combines ambient weather, a cellular fire front, wind-driven smoke, sensor noise, and device failures. Sensor sequence numbers identify events across retries; stations report at up to 1 Hz. The default requested sensor rate is 2 Hz. Its 100 ms polling loop and jitter mean requested frequency and measured throughput can differ.

Each gateway authenticates to `/devices` using a derived provisioning key, batches readings, buffers disconnections, and honors server backoff. Optional chaos injects duplicates, malformed humidity, reordering, and link interruptions. HTTP ingestion is also available at `POST /api/ingest` with `x-gateway-id` and `x-gateway-key` headers. An event has the form:

```json
{ "sid": "N-001", "seq": 123, "ts": 1794650000000, "m": { "t": 31.2, "h": 28, "s": 4.1 } }
```

Use a current millisecond timestamp when sending events. Validation checks source ownership, metrics, sequence values, clock skew, rate limits, and queue capacity. Older sequence readings can enter history without rolling back the live state. A MongoDB unique index on `(sid,seq)` provides persistent deduplication. Raw readings expire after 6 hours and minute aggregates after 24 hours by default; MongoDB TTL cleanup is asynchronous.

**An ingestion ACK confirms queued acceptance, not a durable database commit.** The writer batches inserts, retries transient errors, and reserves in-flight queue capacity. A process crash can lose acknowledged in-memory data. Rollups are rebuilt from unique persisted raw readings so duplicate retries do not inflate their counts. Limits above the configured source allowance are intentionally visible in metrics; this demo does not promise lossless ingestion during sustained overload.

## Real-time communication

The authenticated `/live` namespace joins only authorized `zone:*`, `sensor:*`, and `alerts:*` rooms. Operations/admin users also receive metrics. Every 250 ms the server publishes compact changed-source rows, while the selected-source stream supplies full metrics. Each connection retains at most five latest unsent telemetry packets and coalesces superseded updates when its transport is busy. Alerts use reliable Socket.IO events; active alerts are refetched when subscribing or reconnecting.

The client subscribes before fetching history, buffers overlap, and merges raw points by sequence number. Rollup charts remain minute aggregates while the current reading stays live. A 10, 000-point cap bounds client memory and is disclosed when a range is truncated. Two-second head messages repair missed latest-state deltas using snapshots. Database history updates and periodic refresh recover committed readings; bounded retries handle a concurrent history cut. Socket.IO is not a durable event log and the dashboard does not receive every ingested reading.

See [architecture and protocol](docs/ARCHITECTURE.md) for schemas, data flow, and consistency boundaries.

## Running and testing

```sh
npm test
npm run build
npm run bench -- --clients 50 --hz 10 --seconds 30 --warmup 5 --output docs/perf/local-run.json
```

Tests cover ingestion limits/deduplication, writer retries and shutdown, exact rollups, anomaly state transitions, authentication, ranger isolation, HTTP/polling/WebSocket integration, bounded telemetry delivery, and client history/reconnect consistency. Integration tests and the benchmark launch isolated temporary databases; their first run downloads mongod. They require permission to bind/connect to local ports.

The benchmark uses real ingestion, storage, and Socket.IO clients; it exits unsuccessfully if map frames are absent, clients disconnect, scope leaks, writes fail, or final persistence does not reconcile. [Measured results and conditions](docs/perf/README.md) distinguish requested rate, accepted events, sampled client latency, and graceful-drain verification. Use `--chaos` to exercise faulty links and events. This synthetic same-host test does not replace a distributed capacity test.

Follow the [four-minute demonstration](docs/DEMO.md) to show separate administrator and ranger sessions, ignition, acknowledgment, history, and metrics.

## External resources and attribution

| Resource                                                                                                                                                                                                                    | Use                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [MongoDB](https://www.mongodb.com/), [Mongoose](https://mongoosejs.com/)                                                                                 | Runtime, HTTP server, database, modeling                                 |
| [React and React DOM](https://react.dev/), [Vite](https://vite.dev/), [React Vite plugin](https://github.com/vitejs/vite-plugin-react)                                                                                      | Interface, development, production build                                 |
| [Socket.IO and socket.io-client](https://socket.io/)                                                                                                                                                                        | Device and dashboard communication                                       |
| [Zod](https://zod.dev/), [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit)                                                                                                                     | Validation and request limits                                            |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js), [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)                                                                                                                | Password hashing and session tokens                                      |
| [Helmet](https://helmetjs.github.io/), [cors](https://github.com/expressjs/cors), [Pino](https://getpino.io/)                                                                                                               | HTTP headers, CORS, structured logs                                      |
| [Leaflet](https://leafletjs.com/), [uPlot](https://github.com/leeoniya/uPlot), [react-window](https://github.com/bvaughn/react-window), [Lucide](https://lucide.dev/)                                                       | Map, plots, virtual lists, icons                                         |
| [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)                                                                                                                                                       | Basemap data and standard map tiles; attribution also appears on the map |
| [DM Sans](https://fonts.google.com/specimen/DM+Sans), [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono)                                                                                                      | Optional Google Fonts, with local system fallbacks                       |
| [Vitest](https://vitest.dev/), [Supertest](https://github.com/ladjs/supertest), [MongoDB Memory Server](https://github.com/typegoose/mongodb-memory-server), [concurrently](https://github.com/open-cli-tools/concurrently) | Tests, local database helper, development commands                       |

Standard OpenStreetMap tiles require an internet connection and follow the [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/); no bulk tile downloading is implemented. `VITE_TILE_URL` and `VITE_TILE_ATTRIBUTION` can select another properly licensed provider at build time; allow its image origin in the server CSP as well. Provider-specific keys are only needed if that chosen provider requires them.

The composite danger calculation is documented in [shared/metrics.js](shared/metrics.js). Its base follows the Chandler Burning Index described in Chandler et al., _Fire in Forestry_, 1983; the wind adjustment and 0–100 display are specific to this application.
