import { z } from 'zod';
import { METRICS } from './metrics.js';

const bounded = (k) => z.number().finite().min(METRICS[k].min).max(METRICS[k].max);

export const MAX_BATCH = 500;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const metricsSchema = z
  .object({
    t: bounded('t'),
    h: bounded('h'),
    s: bounded('s').optional(),
    co: bounded('co').optional(),
    ws: bounded('ws').optional(),
    wd: bounded('wd').optional(),
    b: bounded('b').optional(),
    rssi: bounded('rssi').optional(),
  })
  .strict();

// One telemetry event. (sid, seq) identifies it uniquely; ts is the device
// clock at measurement time in epoch milliseconds.
export const readingSchema = z
  .object({
    sid: z.string().regex(/^[A-Z]{1,3}-[A-Z0-9]{1,6}$/),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ts: z.number().int().positive(),
    m: metricsSchema,
  })
  .strict();

export const batchSchema = z.array(z.unknown()).min(1).max(MAX_BATCH);

export const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1).max(200),
});

export const subscribeSchema = z
  .object({
    zones: z.array(z.string().max(20)).max(10).optional(),
    sensor: z.string().max(20).nullable().optional(),
  })
  .strict();

export const historyQuerySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(20000).optional(),
});

export const controlSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('ignite'), lat: z.number(), lng: z.number() }),
  z.object({ cmd: z.literal('extinguish') }),
  z.object({ cmd: z.literal('wind'), dir: z.number().min(0).max(360), speed: z.number().min(0).max(120) }),
  z.object({ cmd: z.literal('rate'), hz: z.number().min(0.2).max(20) }),
  z.object({ cmd: z.literal('chaos'), on: z.boolean() }),
]);

export function issuesText(error) {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
    .join('; ');
}
