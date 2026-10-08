import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  ensureIdempotencyKeysTable,
  getIdempotencyRecord,
  insertIdempotencyRecord,
  completeIdempotencyRecord,
  deleteIdempotencyRecord,
  pruneExpiredIdempotencyRecords,
} from "./idempotency.js";

function setup() {
  const db = openDatabase(":memory:");
  ensureIdempotencyKeysTable(db);
  return db;
}

test("getIdempotencyRecord returns undefined for a key that was never inserted", () => {
  const db = setup();
  assert.equal(getIdempotencyRecord(db, "never-seen"), undefined);
});

test("insertIdempotencyRecord creates an 'in_progress' row with no response yet", () => {
  const db = setup();
  insertIdempotencyRecord(db, "key1", "user1", "POST /projects");
  const record = getIdempotencyRecord(db, "key1");
  assert.ok(record);
  assert.equal(record!.status, "in_progress");
  assert.equal(record!.userId, "user1");
  assert.equal(record!.route, "POST /projects");
  assert.equal(record!.responseStatus, null);
  assert.equal(record!.responseBody, null);
});

test("completeIdempotencyRecord moves a row from 'in_progress' to 'done' and stores the real response", () => {
  const db = setup();
  insertIdempotencyRecord(db, "key1", "user1", "POST /projects");
  completeIdempotencyRecord(db, "key1", 201, JSON.stringify({ project: { id: "abc" } }));
  const record = getIdempotencyRecord(db, "key1");
  assert.equal(record!.status, "done");
  assert.equal(record!.responseStatus, 201);
  assert.deepEqual(JSON.parse(record!.responseBody!), { project: { id: "abc" } });
});

test("deleteIdempotencyRecord removes the row so a retry with the same key is treated as a brand-new request", () => {
  const db = setup();
  insertIdempotencyRecord(db, "key1", "user1", "POST /projects");
  deleteIdempotencyRecord(db, "key1");
  assert.equal(getIdempotencyRecord(db, "key1"), undefined);
});

test("deleteIdempotencyRecord on a key that doesn't exist is a harmless no-op", () => {
  const db = setup();
  assert.doesNotThrow(() => deleteIdempotencyRecord(db, "never-inserted"));
});

/**
 * Without this, a "done" row is never removed by anything else -- the
 * table (which stores a full JSON response body per row) grows by one row
 * per guarded request forever. Backdates two rows' createdAt directly via
 * raw SQL (the same pattern apps/api/src/twin.test.ts already uses to
 * simulate an old record) rather than waiting real time, then prunes with
 * a 24h cutoff and confirms only the genuinely-old row is gone.
 */
test("pruneExpiredIdempotencyRecords deletes only rows older than maxAgeMs, done or in_progress alike", () => {
  const db = setup();
  insertIdempotencyRecord(db, "old-done", "user1", "POST /projects");
  completeIdempotencyRecord(db, "old-done", 201, JSON.stringify({ ok: true }));
  insertIdempotencyRecord(db, "old-in-progress", "user1", "POST /projects");
  insertIdempotencyRecord(db, "fresh", "user1", "POST /projects");

  const oneDayMs = 24 * 60 * 60 * 1000;
  const twoDaysAgo = new Date(Date.now() - 2 * oneDayMs).toISOString();
  db.prepare("UPDATE idempotency_keys SET createdAt = ? WHERE key = ?").run(twoDaysAgo, "old-done");
  db.prepare("UPDATE idempotency_keys SET createdAt = ? WHERE key = ?").run(twoDaysAgo, "old-in-progress");

  pruneExpiredIdempotencyRecords(db, oneDayMs);

  assert.equal(getIdempotencyRecord(db, "old-done"), undefined, "an old 'done' row must be pruned, not kept forever");
  assert.equal(
    getIdempotencyRecord(db, "old-in-progress"),
    undefined,
    "an old 'in_progress' row (e.g. orphaned by a server crash mid-request) must also be pruned",
  );
  assert.ok(getIdempotencyRecord(db, "fresh"), "a row created just now must survive a 24h prune");
});
