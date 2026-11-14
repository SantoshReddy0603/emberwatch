import { Router } from 'express';

// HTTP alternative to the socket path, handy for curl tests and devices that
// can only POST. Goes through exactly the same Ingestor.
export function ingestRouter({ registry, ingestor }) {
  const r = Router();
  r.post('/', (req, res) => {
    const gw = registry.verify(req.get('x-gateway-id'), req.get('x-gateway-key'));
    if (!gw || gw.kind !== 'gateway') return res.status(401).json({ error: 'invalid gateway credentials' });
    const out = ingestor.handle(gw, req.body);
    if (out.retryAfterMs > 0 && !out.accepted) {
      res.set('Retry-After', String(Math.ceil(out.retryAfterMs / 1000)));
      return res.status(429).json(out);
    }
    if (!out.ok) return res.status(400).json(out);
    res.status(out.retryAfterMs ? 202 : 200).json(out);
  });
  return r;
}
