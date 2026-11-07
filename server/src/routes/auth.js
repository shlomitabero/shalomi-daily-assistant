import { Router } from 'express';
import { verifyOwnerPassword, signOwnerToken } from '../engine/auth.js';
import { createLoginRateLimiter } from '../engine/loginRateLimit.js';

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
    return res.status(429).json({ error: 'יותר מדי ניסיונות התחברות שגויים — נסה שוב בעוד כמה דקות' });
  }
  const { password } = req.body ?? {};
  if (!verifyOwnerPassword(password)) {
    loginRateLimiter.recordFailure(key);
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }
  loginRateLimiter.recordSuccess(key);
  res.json({ token: signOwnerToken() });
}

authRouter.post('/login', login);
