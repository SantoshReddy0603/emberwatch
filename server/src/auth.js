import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { loginSchema, ZONE_IDS } from '@emberwatch/shared';
import { User } from './models/User.js';

export const publicUser = (u) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  role: u.role,
  zones: u.zones || [],
});
export const allowedZones = (u) =>
  u.role === 'ranger' ? ZONE_IDS.filter((z) => u.zones.includes(z)) : [...ZONE_IDS];
export const canSee = (u, zone) => allowedZones(u).includes(zone);

export async function verifyToken(token, config) {
  const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (typeof claims.sub !== 'string' || !/^[a-f\d]{24}$/i.test(claims.sub))
    throw new Error('invalid identity');
  const user = await User.findById(claims.sub).select('-passHash').lean();
  if (!user) throw new Error('unknown identity');
  return { user: publicUser(user), expiresAt: claims.exp * 1000 };
}

export function requireAuth(config) {
  return async (req, res, next) => {
    try {
      const value = req.get('authorization') || '';
      if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'sign in required' });
      req.auth = await verifyToken(value.slice(7), config);
      req.user = req.auth.user;
      next();
    } catch {
      res.status(401).json({ error: 'session expired or invalid' });
    }
  };
}

export const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'insufficient permissions' });

export function authRouter(config) {
  const router = Router();
  router.post(
    '/login',
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'enter a valid email and password' });
      const user = await User.findOne({ email: parsed.data.email.trim().toLowerCase() }).lean();
      const valid = await bcrypt.compare(
        parsed.data.password,
        user?.passHash || '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
      );
      if (!user || !valid) return res.status(401).json({ error: 'incorrect email or password' });
      const token = jwt.sign({ role: user.role, zones: user.zones }, config.jwtSecret, {
        subject: String(user._id),
        expiresIn: config.jwtTtl,
        algorithm: 'HS256',
      });
      res.json({ token, user: publicUser(user) });
    },
  );
  router.get('/me', requireAuth(config), (req, res) => res.json({ user: req.user }));
  return router;
}
