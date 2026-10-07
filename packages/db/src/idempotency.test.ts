import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  ensureIdempotencyKeysTable,
  getIdempotencyRecord,
  insertIdempotencyRecord,
  completeIdempotencyRecord,
  deleteIdempotencyRecord,
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
