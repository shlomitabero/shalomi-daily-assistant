// Single-owner auth: this is a personal console, not a multi-tenant SaaS, so
// there's one password (OWNER_PASSWORD) rather than a users table.
import jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// A missing JWT_SECRET used to fall back to a random one with zero
// indication anything was wrong. On a platform that redeploys on every
// push (this app gets redeployed roughly hourly by its own upgrade
// routine), that silently logs the owner out of every active session on
// every single deploy — a new random secret each boot invalidates every
// token signed with the previous one. Warn loudly so this shows up in the
// deploy logs instead of just looking like an unexplained random logout.
export function resolveJwtSecret(envValue, { onFallback } = {}) {
  if (envValue) return envValue;
  onFallback?.();
  return randomBytes(32).toString('hex');
}

const JWT_SECRET = resolveJwtSecret(process.env.JWT_SECRET, {
  onFallback: () => console.warn(
    'JWT_SECRET is not set — using a random secret for this process only. ' +
    'Every login session will be silently invalidated the next time this process restarts ' +
    '(including a routine redeploy). Set JWT_SECRET to a stable value to keep sessions alive across deploys.'
  ),
});

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
