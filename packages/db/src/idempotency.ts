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
