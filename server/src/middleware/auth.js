import { verifyOwnerToken } from '../engine/auth.js';

export function requireOwner(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !verifyOwnerToken(token)) return res.status(401).json({ error: 'not authenticated' });
  next();
}
