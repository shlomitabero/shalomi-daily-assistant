import type { ForgeDatabase } from "./connection.js";

/**
 * Backs the idempotency-key mechanism designed in
 * docs/wakeRetry-idempotency-design.md (round 470) and first wired up for
 * POST /projects in round 471. A row only ever covers one client-chosen
 * key for one route: a request that supplies a key gets a row inserted
 * "in_progress" before the real work runs, then updated to "done" with the
 * real response once it finishes, so a retry that reuses the same key can
 * either be rejected (still running) or replayed (already finished)
 * instead of running the underlying effect a second time. This is a
 * deliberately short-lived table, not a permanent audit log -- see
 * deleteIdempotencyRecord below.
 */
export interface IdempotencyRecord {
  key: string;
  userId: string;
  route: string;
  status: "in_progress" | "done";
  responseStatus: number | null;
  responseBody: string | null;
  createdAt: string;
}

export function ensureIdempotencyKeysTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      route TEXT NOT NULL,
      status TEXT NOT NULL,
      responseStatus INTEGER,
      responseBody TEXT,
      createdAt TEXT NOT NULL
    )
  `);
  // Round 1829: pruneExpiredIdempotencyRecords below runs a
  // `WHERE createdAt < ?` DELETE, and withIdempotency (apps/api/src/
  // idempotency.ts) calls it unconditionally, first thing, on every single
  // request that carries an X-Idempotency-Key header -- roughly a dozen
  // distinct mutating routes across the app. Without an index on createdAt,
  // that DELETE is a full table scan every time, on a table that is global
  // (not scoped to one project/user) and holds every "done" row for up to
  // 24h (IDEMPOTENCY_TTL_MS) -- so its cost grows with overall app usage
  // and is paid by every guarded request, in proportion to everyone else's
  // recent activity, not just the caller's own. node:sqlite's API here is
  // synchronous, so that scan blocks the server's single JS event loop for
  // its full duration -- real added latency for every other concurrent
  // request being served by the same process at that moment. Purely
  // additive: doesn't change any query's result, just lets this existing
  // prune run in O(log n + k) instead of O(n).
  db.exec(`CREATE INDEX IF NOT EXISTS idempotency_keys_createdAt_idx ON idempotency_keys (createdAt)`);
}

export function getIdempotencyRecord(db: ForgeDatabase, key: string): IdempotencyRecord | undefined {
  return db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(key) as IdempotencyRecord | undefined;
}

export function insertIdempotencyRecord(db: ForgeDatabase, key: string, userId: string, route: string): void {
  db.prepare(
    "INSERT INTO idempotency_keys (key, userId, route, status, responseStatus, responseBody, createdAt) VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?)",
  ).run(key, userId, route, new Date().toISOString());
}

export function completeIdempotencyRecord(db: ForgeDatabase, key: string, responseStatus: number, responseBody: string): void {
  db.prepare("UPDATE idempotency_keys SET status = 'done', responseStatus = ?, responseBody = ? WHERE key = ?").run(
    responseStatus,
    responseBody,
    key,
  );
}

/**
 * Deletes every row (whether "in_progress" or "done") older than maxAgeMs.
 * This is what actually makes the table "deliberately short-lived" per the
 * doc comment above -- without it, a "done" row is never removed by
 * anything else and the table grows by one row (holding a full JSON
 * response body) per guarded request forever. Also self-heals a row
 * orphaned "in_progress" by a server crash mid-request (deleteIdempotencyRecord's
 * own catch-path never runs in that case), which the docs/
 * wakeRetry-idempotency-design.md TTL discussion didn't call out by name
 * but falls out of the same age-based cutoff for free.
 */
export function pruneExpiredIdempotencyRecords(db: ForgeDatabase, maxAgeMs: number): void {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  db.prepare("DELETE FROM idempotency_keys WHERE createdAt < ?").run(cutoff);
}

/**
 * Called when the guarded work throws instead of completing: an
 * "in_progress" row for a request that actually failed must not be left
 * behind, or every future retry with that same key would be wrongly
 * rejected as "already being processed" forever, with no way to ever
 * succeed. Deleting it makes a retry after a genuine failure behave
 * exactly like the very first attempt.
 */
export function deleteIdempotencyRecord(db: ForgeDatabase, key: string): void {
  db.prepare("DELETE FROM idempotency_keys WHERE key = ?").run(key);
}
