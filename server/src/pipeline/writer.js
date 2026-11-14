import { Reading } from '../models/Reading.js';
import { Device } from '../models/Device.js';
import { log } from '../obs/log.js';

// Buffers accepted readings and writes them in batches. One insertMany every
// interval instead of one insert per event keeps database round trips flat
// no matter how fast events arrive.
export class Writer {
  constructor({ metrics, intervalMs, batchMax, hardCap, state }) {
    this.metrics = metrics;
    this.intervalMs = intervalMs;
    this.batchMax = batchMax;
    this.hardCap = hardCap;
    this.state = state;
    this.queue = [];
    this.busy = false;
    this.timer = null;
    this.seqTimer = null;
  }

  get depth() {
    return this.queue.length;
  }

  push(doc) {
    this.queue.push(doc);
  }

  start() {
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.seqTimer = setInterval(() => this.saveCursors(), 5000);
  }

  async stop() {
    clearInterval(this.timer);
    clearInterval(this.seqTimer);
    while (this.queue.length) await this.flush();
    await this.saveCursors();
  }

  async flush() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const batch = this.queue.splice(0, this.batchMax);
    const t0 = performance.now();
    try {
      await Reading.collection.insertMany(batch, { ordered: false, ignoreUndefined: true });
      this.metrics.c.written.add(batch.length);
    } catch (err) {
      const writeErrors = err.writeErrors ? [].concat(err.writeErrors) : [];
      const dups = writeErrors.filter((e) => e.code === 11000).length;
      const inserted = err.insertedCount ?? err.result?.insertedCount ?? 0;
      if (writeErrors.length && dups === writeErrors.length) {
        this.metrics.c.written.add(inserted);
        this.metrics.c.duplicate.add(dups);
      } else {
        // Database unavailable or similar: put the batch back (bounded) and retry.
        this.metrics.c.writeErrors.add(batch.length);
        const room = this.hardCap - this.queue.length;
        if (room > 0) this.queue.unshift(...batch.slice(0, room));
        log.warn({ err: err.message, batch: batch.length }, 'batch write failed, will retry');
      }
    } finally {
      this.metrics.writeMs.add(performance.now() - t0);
      this.busy = false;
    }
  }

  // Persist each device's latest sequence so a restarted server keeps
  // rejecting replays of old events.
  async saveCursors() {
    const ops = [];
    for (const st of this.state.list) {
      if (st.seq >= 0 && st.savedSeq !== st.seq) {
        ops.push({
          updateOne: {
            filter: { _id: st.id },
            update: { $max: { lastSeq: st.seq }, $set: { lastSeen: new Date(st.lastSeen || Date.now()) } },
          },
        });
        st.savedSeq = st.seq;
      }
    }
    if (!ops.length) return;
    try {
      await Device.bulkWrite(ops, { ordered: false });
    } catch (err) {
      log.warn({ err: err.message }, 'cursor save failed');
    }
  }
}
