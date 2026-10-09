import { verifyToken } from '../engine/auth.js';
import { db } from '../db/store.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'not authenticated' });
  const user = db.users.get(userId);
  if (!user) return res.status(401).json({ error: 'not authenticated' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (!adminEmail || req.user?.email?.toLowerCase() !== adminEmail) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}
