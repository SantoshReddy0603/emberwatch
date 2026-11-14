# Local performance measurements

These are observed runs, not capacity guarantees. Both use 420 sensors, 8 stations, 8 gateways, 250 ms publication ticks, 500 ms writer batches, a 5-second warmup, and approximately 30 seconds of measurement. Each synthetic client authenticates as a ranger and subscribes to one authorized zone and one selected source.

| Scenario                                               | Connected clients | Accepted readings/s | Client p50 / p95 / p99 | Map frames received | Duplicates / rejected | Limited / shed |
| ------------------------------------------------------ | ----------------: | ------------------: | ------------------------: | ------------------: | --------------------: | -------------: |
| [Requested 10 Hz](50-clients-10hz.json)                |            50 / 50 |           1,885.57 |          356 / 823 / 954 ms |              4,500 |                  0 / 0 |           0 / 0 |
| [Requested 2 Hz with chaos](25-clients-2hz-chaos.json) |            25 / 25 |              763.10 |    262 / 1,056 / 2,065 ms |              2,443 |              242 / 102 |           0 / 0 |

No dashboard disconnects, observed cross-zone payloads, or write errors occurred in either window. Chaos deliberately interrupted gateway links and inserted malformed/duplicate events; dashboard connections stayed up. Reordering is stochastic, and the measured out-of-order counter was zero in these runs, so that behavior is covered by deterministic tests rather than claimed from this measurement.

| Scenario                 | Largest sampled queue | Largest sampled Node RSS | Source-to-tick p95 | Stored after graceful drain | Written counter | Queue after drain |
| ------------------------ | --------------------: | -----------------------: | ------------------: | --------------------------: | --------------: | ----------------: |
| 50 clients / 10 Hz        |                1,369 |               152.59 MiB |              530 ms |                     74,201 |         74,201 |                 0 |
| 25 clients / 2 Hz / chaos |                   806 |               131.21 MiB |           1,124 ms |                     27,443 |         27,443 |                 0 |

The final database counts include warmup and drain, whereas rates/counters cover only the measurement window. Written readings/s can differ from accepted readings/s because batches cross those window boundaries. Count reconciliation checks accepted storage draining; it does not count readings still unsent at gateways when the simulator stops.

## Conditions and interpretation

- Windows 10.0.26300, Node 22.19.0, Intel Core i7-1360P with 16 logical processors, 15.69 GiB RAM.
- Server, simulator, and synthetic Socket.IO clients share one Node process; temporary mongod runs separately. A separate 2 Hz interactive preview and normal desktop/browser activity ran concurrently. These runs were not performed on an isolated host.
- The server's requested 10 Hz setting is not 4,200 measured readings/s. Its 100 ms simulator polling, jitter, serialization, and shared event loop constrain the actual rate. Stations report at 1 Hz.
- Client latency is receipt time minus source timestamp, sampled from the first four rows of each delta, capped at 100,000 samples. The runs captured 18,000 and 9,736 samples. They measure coalesced updates, not every ingested event.
- The server's source-to-tick metric is collected before outbound transport queuing; it is not browser latency. Payload-byte counters omit transport framing, TLS, and subscription snapshots.
- Queue/RSS maxima are sampled at 5-second intervals and can miss shorter peaks. CPU/RSS cover the benchmark Node process only, excluding mongod and the separate preview/browser.
- ACKs confirm an in-memory queue admission. Zero remaining queue and matching database counts after graceful shutdown do not prove crash durability or uninterrupted long-run operation.
- These are synthetic Node clients, not 50 rendered browser dashboards or a hosted-service capacity claim. Default 2 Hz remains the interactive demonstration setting.

## Reproduce

From the repository root, after `npm ci`:

```sh
npm run bench -- --clients 50 --hz 10 --seconds 30 --warmup 5 --output docs/perf/local-10hz.json
npm run bench -- --clients 25 --hz 2 --seconds 30 --warmup 5 --chaos --output docs/perf/local-chaos.json
```

Each command starts its own temporary MongoDB and randomly assigned loopback HTTP port. It does not reset the configured application database. Keep the raw JSON and report conditions alongside the numbers. Run longer distributed tests before choosing a production capacity target.
