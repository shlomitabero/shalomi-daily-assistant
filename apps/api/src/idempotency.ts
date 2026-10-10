import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  completeIdempotencyRecord,
  deleteIdempotencyRecord,
  pruneExpiredIdempotencyRecords,
  type ForgeDatabase,
} from "@forge/db";
import { HttpError } from "./httpError.js";

/**
 * 24h: "far longer than any realistic retry sequence," per the design
 * doc's own open-question answer -- this table only needs to cover a
 * single retry sequence's own window, not serve as a permanent audit log.
 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The server-side half of the idempotency-key mechanism designed in
 * docs/wakeRetry-idempotency-design.md (round 470), first wired up for
 * POST /projects in round 471. Mirrors the shape `activePipelines`
 * (routes/projects.ts) already established for "guard + do the work +
 * record the outcome" -- guard + do the work + persist the outcome so a
 * retry can be recognized instead of repeated.
 *
 * `key` is undefined for a caller that didn't send one (an older client,
 * or a route this hasn't been opted into) -- `run` just executes directly,
 * identical to today's unguarded behavior. This is deliberately an opt-in
 * per call site, not a blanket default; see the design doc's "what this
 * deliberately does NOT do" section.
 */
export async function withIdempotency<T>(
  db: ForgeDatabase,
  key: string | undefined,
  userId: string,
  route: string,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  if (!key) return run();

  // Opportunistic cleanup (the design doc's own suggested alternative to a
  // scheduled sweep, since this app has no cron/scheduler infrastructure):
  // runs before the lookup below so a key whose own row has aged out is
  // treated as brand-new rather than replayed from a stale cached response
  // forever.
  pruneExpiredIdempotencyRecords(db, IDEMPOTENCY_TTL_MS);

  const existing = getIdempotencyRecord(db, key);
  // `existing.userId`/`existing.route` are stored specifically to scope a
  // key to the one request it was chosen for (see the table's own doc
  // comment in packages/db/src/idempotency.ts), but were never actually
  // compared against the *current* request before replaying "done" or
  // rejecting "in_progress" below -- a key reused across users or routes
  // (whether by a client bug or a guessed/forged header value, since this
  // header is entirely client-supplied) would silently get back another
  // request's cached response, or block on another request's in-flight
  // one, with no relation to its own route or project at all.
  //
  // `route` must be the actual resource instance being mutated, not just
  // the Express route *template* -- round 495 only ever compared the bare
  // template (e.g. "POST /projects/:id/roles") since that's all every real
  // call site passed, so the same key reused across two different
  // projects (or entities) for the same user still matched on both
  // userId and route, silently replaying the first project's cached
  // response and skipping the second project's own mutation entirely.
  // Round 528 fixed every per-resource call site in routes/projects.ts to
  // interpolate the real project/entity id into this string instead.
  if (existing && (existing.userId !== userId || existing.route !== route)) {
    throw new HttpError(409, "This idempotency key was already used for a different request", "IDEMPOTENCY_KEY_MISMATCH");
  }
  if (existing?.status === "in_progress") {
    throw new HttpError(409, "This request is already being processed", "DUPLICATE_REQUEST_IN_PROGRESS");
  }
  if (existing?.status === "done") {
    return { status: existing.responseStatus!, body: JSON.parse(existing.responseBody!) as T };
  }

  insertIdempotencyRecord(db, key, userId, route);
  try {
    const result = await run();
    completeIdempotencyRecord(db, key, result.status, JSON.stringify(result.body));
    return result;
  } catch (err) {
    // The attempt genuinely failed -- an "in_progress" row left behind
    // would reject every future retry with this same key forever, with no
    // way for it to ever succeed. Clearing it makes a retry after a real
    // failure behave exactly like the first attempt ever made.
    deleteIdempotencyRecord(db, key);
    throw err;
  }
}
