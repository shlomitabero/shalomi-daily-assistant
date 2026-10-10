import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  createLoginCode,
  deleteLoginCode,
  deleteLoginCodesForUser,
  ensureLoginCodesTable,
  getLoginCode,
  incrementLoginCodeAttempts,
  pruneExpiredLoginCodes,
} from "./loginCodes.js";

const HOUR_MS = 60 * 60 * 1000;

test("createLoginCode inserts a row that getLoginCode can read back, with attempts starting at 0", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  createLoginCode(db, { id: "code-1", userId: "u1", codeHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  const record = getLoginCode(db, "code-1");
  assert.ok(record);
  assert.equal(record!.userId, "u1");
  assert.equal(record!.codeHash, "hash-1");
  assert.equal(record!.attempts, 0);
});

test("getLoginCode returns undefined for an id that was never created", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  assert.equal(getLoginCode(db, "no-such-id"), undefined);
});

test("incrementLoginCodeAttempts increases attempts by exactly 1 each call, scoped to its own row", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  createLoginCode(db, { id: "code-1", userId: "u1", codeHash: "h", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createLoginCode(db, { id: "code-2", userId: "u2", codeHash: "h", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  incrementLoginCodeAttempts(db, "code-1");
  incrementLoginCodeAttempts(db, "code-1");
  incrementLoginCodeAttempts(db, "code-2");

  assert.equal(getLoginCode(db, "code-1")!.attempts, 2);
  assert.equal(getLoginCode(db, "code-2")!.attempts, 1);
});

test("deleteLoginCode removes only its own row", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  createLoginCode(db, { id: "code-1", userId: "u1", codeHash: "h", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createLoginCode(db, { id: "code-2", userId: "u2", codeHash: "h", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  deleteLoginCode(db, "code-1");

  assert.equal(getLoginCode(db, "code-1"), undefined);
  assert.ok(getLoginCode(db, "code-2"));
});

test("deleteLoginCodesForUser removes every pending code for that user, leaving other users' codes untouched", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  createLoginCode(db, { id: "code-1", userId: "u1", codeHash: "h", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createLoginCode(db, { id: "code-2", userId: "u1", codeHash: "h2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createLoginCode(db, { id: "code-3", userId: "u2", codeHash: "h3", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  deleteLoginCodesForUser(db, "u1");

  assert.equal(getLoginCode(db, "code-1"), undefined);
  assert.equal(getLoginCode(db, "code-2"), undefined);
  assert.ok(getLoginCode(db, "code-3"), "a different user's code must survive");
});

test("pruneExpiredLoginCodes removes only rows whose expiresAt has already passed, leaving valid ones untouched", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  // Inserted directly, bypassing createLoginCode's own opportunistic prune,
  // so this test is about pruneExpiredLoginCodes's own behavior in isolation.
  const insert = db.prepare("INSERT INTO login_codes (id, userId, codeHash, attempts, expiresAt, createdAt) VALUES (?, ?, ?, 0, ?, ?)");
  const now = new Date().toISOString();
  insert.run("expired-1", "u1", "h", new Date(Date.now() - HOUR_MS).toISOString(), now);
  insert.run("still-valid", "u1", "h", new Date(Date.now() + HOUR_MS).toISOString(), now);

  const deletedCount = pruneExpiredLoginCodes(db);
  assert.equal(deletedCount, 1);
  assert.equal(getLoginCode(db, "expired-1"), undefined);
  assert.ok(getLoginCode(db, "still-valid"));
});

test("createLoginCode opportunistically prunes an already-expired row for a DIFFERENT user before inserting its own", () => {
  const db = openDatabase(":memory:");
  ensureLoginCodesTable(db);
  const insert = db.prepare("INSERT INTO login_codes (id, userId, codeHash, attempts, expiresAt, createdAt) VALUES (?, ?, ?, 0, ?, ?)");
  insert.run("stale", "u1", "h", new Date(Date.now() - HOUR_MS).toISOString(), new Date().toISOString());

  createLoginCode(db, { id: "fresh", userId: "u2", codeHash: "h2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  assert.equal(getLoginCode(db, "stale"), undefined);
  assert.ok(getLoginCode(db, "fresh"));
});
