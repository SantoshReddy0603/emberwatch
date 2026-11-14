import { Reading } from '../models/Reading.js';
import { Device } from '../models/Device.js';
import { log } from '../obs/log.js';

export class Writer {
  constructor({ metrics, intervalMs, batchMax, hardCap, state, onStored = () => {} }) {
    Object.assign(this, { metrics, intervalMs, batchMax, hardCap, state, onStored });
    this.queue = [];
    this.inflight = [];
    this.busy = null;
    this.persisted = new Map();
    this.saved = new Map();
  }
  get depth() {
    return this.queue.length + this.inflight.length;
  }
  get pending() {
    return [...this.inflight, ...this.queue];
  }
  push(doc) {
    this.queue.push(doc);
  }
  start() {
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.seqTimer = setInterval(() => void this.saveCursors(), 5000);
  }
  async stop() {
    clearInterval(this.timer);
    clearInterval(this.seqTimer);
    if (this.busy) await this.busy;
    while (this.queue.length) {
      await this.flush();
      if (this.lastError) throw new Error('Database unavailable while draining telemetry');
    }
    await this.saveCursors();
  }
  flush() {
    if (this.busy) return this.busy;
    if (!this.queue.length) return Promise.resolve();
    const batch = this.queue.splice(0, this.batchMax);
    this.inflight = batch;
    const started = performance.now();
    this.busy = (async () => {
      let confirmed = false;
      try {
        await Reading.collection.insertMany(batch, { ordered: false, ignoreUndefined: true });
        this.metrics.c.written.add(batch.length);
        confirmed = true;
        this.lastError = null;
      } catch (err) {
        const errors = err.writeErrors ? [].concat(err.writeErrors) : [];
        const duplicates = errors.filter((e) => e.code === 11000).length;
        if (errors.length && duplicates === errors.length) {
          this.metrics.c.written.add(err.insertedCount ?? err.result?.insertedCount ?? 0);
          this.metrics.c.duplicate.add(duplicates);
          confirmed = true;
          this.lastError = null;
        } else {
          this.metrics.c.writeErrors.add(batch.length);
          this.queue.unshift(...batch);
          this.lastError = err;
          log.warn({ error: err.message, batch: batch.length }, 'batch write will retry');
        }
      } finally {
        if (confirmed) {
          for (const r of batch) {
            const previous = this.persisted.get(r.sid);
            if (!previous || r.seq > previous.seq)
              this.persisted.set(r.sid, { seq: r.seq, rx: r.rx });
          }
        }
        // Rebuilding affected rollups also repairs an uncertain partial insert.
        this.onStored(batch, confirmed);
        this.inflight = [];
        this.metrics.writeMs.add(performance.now() - started);
        this.busy = null;
      }
    })();
    return this.busy;
  }
  async saveCursors() {
    const entries = [...this.persisted].filter(([id, r]) => this.saved.get(id) !== r.seq);
    if (!entries.length) return;
    try {
      await Device.bulkWrite(
        entries.map(([id, r]) => ({
          updateOne: { filter: { _id: id }, update: { $max: { lastSeq: r.seq, lastSeen: r.rx } } },
        })),
        { ordered: false },
      );
      for (const [id, r] of entries) this.saved.set(id, r.seq);
    } catch (err) {
      log.warn({ error: err.message }, 'cursor save will retry');
    }
  }
}
