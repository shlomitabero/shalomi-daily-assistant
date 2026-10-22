import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../httpError.js";

interface Bucket {
  count: number;
  windowStart: number;
}

// Bounds the Map's memory in a long-running process without a background
// sweep (see createRateLimiter's own comment for why no setInterval is
// used here) -- an attacker who could make this app track unboundedly many
// distinct keys would need unboundedly many distinct IPs/emails in the
// first place, at which point the sweep below runs on whichever request
// happens to push the map past this size.
const MAX_TRACKED_KEYS = 5000;

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
