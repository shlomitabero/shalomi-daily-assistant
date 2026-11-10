import { Router } from 'express';
import { verifyOwnerPassword, signOwnerToken } from '../engine/auth.js';
import { createLoginRateLimiter } from '../engine/loginRateLimit.js';
import { logAction } from '../services/execution.js';

export const authRouter = Router();

// verifyOwnerPassword already uses a constant-time comparison so a wrong
// guess can't be timed to narrow down the real password - but nothing
// stopped an unlimited number of guesses per second otherwise. This is a
// personal console with a single password and no username to even slow a
// brute-force script down, reachable on the open internet.
const loginRateLimiter = createLoginRateLimiter();

export function login(req, res) {
  if (!process.env.OWNER_PASSWORD) {
    return res.status(503).json({ error: 'OWNER_PASSWORD עדיין לא הוגדר בשרת' });
  }
  const key = req.ip ?? 'unknown';
  if (loginRateLimiter.isBlocked(key)) {
    // A brute-force attempt against the owner's own login was invisible
    // anywhere in the app until now - not just unlogged here, but
    // console.error never fired for it either, so even Railway's own log
    // viewer showed nothing. This app's own stated philosophy (the
    // activity log shows every action the system tried, including
    // failures) never covered the one action an actual attacker, not the
    // owner, might be the one triggering.
    logAction({ type: 'login_attempt', detail: { ip: key }, result: 'blocked: יותר מדי ניסיונות התחברות שגויים' });
    return res.status(429).json({ error: 'יותר מדי ניסיונות התחברות שגויים — נסה שוב בעוד כמה דקות' });
  }
  const { password } = req.body ?? {};
  if (!verifyOwnerPassword(password)) {
    loginRateLimiter.recordFailure(key);
    // Same reasoning as the block above - a few wrong guesses from an
    // unfamiliar source is exactly the early signal an owner glancing at
    // their own activity log should be able to see, not just the 11th
    // attempt once it's already being rate-limited.
    logAction({ type: 'login_attempt', detail: { ip: key }, result: 'failed' });
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }
  loginRateLimiter.recordSuccess(key);
  res.json({ token: signOwnerToken() });
}

authRouter.post('/login', login);
