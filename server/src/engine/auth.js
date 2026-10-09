// Single-owner auth: this is a personal console, not a multi-tenant SaaS, so
// there's one password (OWNER_PASSWORD) rather than a users table.
import jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Falls back to a random secret at boot if unset — fine for a single
// process, but means sessions won't survive a restart without JWT_SECRET set.
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');

export function verifyOwnerPassword(password) {
  const expected = process.env.OWNER_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(String(password ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signOwnerToken() {
  return jwt.sign({ sub: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyOwnerToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET).sub === 'owner';
  } catch {
    return false;
  }
}
