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
