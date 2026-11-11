import { Router } from 'express';
import { verifyOwnerPassword, signOwnerToken } from '../engine/auth.js';
import { createLoginRateLimiter } from '../engine/loginRateLimit.js';
import { logAction } from '../services/execution.js';
import { db } from '../db/store.js';

export const authRouter = Router();

// verifyOwnerPassword already uses a constant-time comparison so a wrong
// guess can't be timed to narrow down the real password - but nothing
// stopped an unlimited number of guesses per second otherwise. This is a
// personal console with a single password and no username to even slow a
// brute-force script down, reachable on the open internet.
const loginRateLimiter = createLoginRateLimiter();

const MAX_LOGIN_ATTEMPT_ENTRIES = 500;

// A sustained brute-force attack now writes a real, permanent actions_log
// row per attempt - without pruning, that row count grows completely
// unbounded, and db/store.js's persist() re-serializes and rewrites the
// ENTIRE db.json file on every single write (to every table, not just this
// one), so that growth would progressively slow down every future write in
// the whole app, not just future login attempts. Unlike sale_confirmed
// (services/ledger.js's countUnrecordedSales scans its entire lifetime
// history, so pruning it could silently drop a real, still-unresolved
// payment problem) or the actual password itself, nothing anywhere in this
// app ever needs more than a recent window of login_attempt entries -
// digest.js only ever counts today's, and ActivityLog.jsx already caps its
// own display at 200 overall regardless.
function logLoginAttempt(detail, result) {
  logAction({ type: 'login_attempt', detail, result });
  const entries = db.actions_log.where((a) => a.type === 'login_attempt');
  const excess = entries.length - MAX_LOGIN_ATTEMPT_ENTRIES;
  if (excess > 0) {
    entries
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(0, excess)
      .forEach((entry) => db.actions_log.delete(entry.id));
  }
}

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
    logLoginAttempt({ ip: key }, 'blocked: יותר מדי ניסיונות התחברות שגויים');
    return res.status(429).json({ error: 'יותר מדי ניסיונות התחברות שגויים — נסה שוב בעוד כמה דקות' });
  }
  const { password } = req.body ?? {};
  if (!verifyOwnerPassword(password)) {
    loginRateLimiter.recordFailure(key);
    // Same reasoning as the block above - a few wrong guesses from an
    // unfamiliar source is exactly the early signal an owner glancing at
    // their own activity log should be able to see, not just the 11th
    // attempt once it's already being rate-limited.
    logLoginAttempt({ ip: key }, 'failed');
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }
  loginRateLimiter.recordSuccess(key);
  res.json({ token: signOwnerToken() });
}

authRouter.post('/login', login);
