import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../httpError.js";

interface Bucket {
  count: number;
  windowStart: number;
}

// Bounds the Map's memory (and the cost of the sweep below) in a
// long-running process without a background sweep (see createRateLimiter's
// own comment for why no setInterval is used here).
//
// Round 1880: the comment this replaced claimed an attacker would need
// "unboundedly many distinct IPs/emails" to grow the map past this cap --
// false for any limiter whose keyGenerator reads a free-form, pre-
// validation request value instead of req.ip/req.userId. Three limiters do
// exactly that: forgotPasswordRateLimiter (routes/auth.ts, keyed by
// req.body.email) and calendarFeedRateLimiter/webhookInRateLimiter
// (routes/calendar.ts, routes/webhookIn.ts, both keyed by
// `${projectId}:${token}`) all run as middleware BEFORE any Zod validation
// or token/project lookup, so the key string never has to correspond to a
// real account, project, or token -- a single attacker IP can mint a fresh
// bucket per request by simply varying that one string. Since every bucket
// it creates is brand new (never expired), the old sweep below -- which
// only ever removed already-EXPIRED buckets -- deleted nothing, so the map
// grew without bound for as long as the attack continued, and every
// request on EVERY route sharing this one event loop paid an ever-growing
// O(map size) scan on this sweep once the map first crossed this cap.
// Exported so rateLimit.test.ts's own regression test can flood exactly
// this many keys without hardcoding the production value twice.
export const MAX_TRACKED_KEYS = 5000;

/**
 * A small in-memory fixed-window limiter. This app runs as a single
 * Express process (see app.ts's own "trust proxy" comment on the
 * single-service Render deployment it targets), so there's no shared
 * store to coordinate across instances -- an in-memory Map is enough.
 *
 * Deliberately no background setInterval sweep: automations.ts's own
 * startScheduledAutomationsLoop doc comment already documents why a timer
 * started from inside createApp()/createAuthRouter() would leak one per
 * test across the hundreds of app instances app.test.ts's withServer
 * helper creates (each test calls createApp() fresh, with no
 * corresponding place to stop it). Expired buckets are instead swept
 * lazily -- piggybacking on whichever request happens to find the map
 * larger than MAX_TRACKED_KEYS -- so there's no timer to leak at all.
 *
 * Each call to this factory owns its own Map, so createAuthRouter()
 * creating one fresh per call (the same convention app.ts's own
 * `activePipelines` already follows) means no state leaks between
 * unrelated app instances/tests either.
 */
export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  keyGenerator: (req: Request) => string;
  message: string;
}) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();

    if (buckets.size > MAX_TRACKED_KEYS) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart > opts.windowMs) buckets.delete(key);
      }
      // Round 1880: the expiry sweep above does nothing against a flood of
      // brand-new, still-live keys (see MAX_TRACKED_KEYS's own comment) --
      // without this, the map keeps growing forever instead of staying
      // capped. Map iterates in insertion order, so the oldest-inserted
      // buckets (the ones a real client is least likely to still be
      // mid-window on) are evicted first, same unconditional-eviction shape
      // every other fixed-size cache in this codebase already uses.
      if (buckets.size > MAX_TRACKED_KEYS) {
        let overflow = buckets.size - MAX_TRACKED_KEYS;
        for (const key of buckets.keys()) {
          if (overflow-- <= 0) break;
          buckets.delete(key);
        }
      }
    }

    const key = opts.keyGenerator(req);
    const existing = buckets.get(key);
    if (!existing || now - existing.windowStart > opts.windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      next();
      return;
    }
    existing.count++;
    if (existing.count > opts.max) {
      next(new HttpError(429, opts.message, "RATE_LIMITED"));
      return;
    }
    next();
  };
}
