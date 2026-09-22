import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import { createSession, deleteExpiredSessions, ensureUsersTable, getSessionUser } from "./users.js";

const HOUR_MS = 60 * 60 * 1000;

test("deleteExpiredSessions removes only sessions whose expiresAt has already passed, leaving valid ones untouched", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  // Inserted directly (not via createSession, which itself opportunistically
  // prunes expired rows on every call -- this test is about
  // deleteExpiredSessions's own behavior in isolation).
  const insert = db.prepare("INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)");
  insert.run("expired-1", "u1", new Date(Date.now() - HOUR_MS).toISOString());
  insert.run("expired-2", "u1", new Date(Date.now() - HOUR_MS).toISOString());
  insert.run("still-valid", "u1", new Date(Date.now() + HOUR_MS).toISOString());

  const deletedCount = deleteExpiredSessions(db);
  assert.equal(deletedCount, 2);

  const remaining = db.prepare("SELECT token FROM sessions").all() as { token: string }[];
  assert.deepEqual(
    remaining.map((r) => r.token),
    ["still-valid"],
  );
});

test("deleteExpiredSessions is a harmless no-op when there are no expired sessions", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  createSession(db, { token: "still-valid", userId: "u1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  assert.equal(deleteExpiredSessions(db), 0);
});

test("createSession opportunistically prunes already-expired sessions on every call, so the table doesn't grow forever with only lazy per-read filtering", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  // Simulate a session from a much earlier login that already expired.
  createSession(db, { token: "old-expired", userId: "u1", expiresAt: new Date(Date.now() - HOUR_MS).toISOString() });
  const before = db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number };
  assert.equal(before.n, 1);

  // A brand-new login issues a new session -- this alone should also clean up the old one.
  createSession(db, { token: "new-session", userId: "u2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  const after = db.prepare("SELECT token FROM sessions").all() as { token: string }[];
  assert.deepEqual(
    after.map((r) => r.token),
    ["new-session"],
  );
});

test("getSessionUser still works correctly around the cleanup -- a real user can be looked up by a real, unexpired session token", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  db.prepare("INSERT INTO users (id, email, passwordHash, createdAt) VALUES (?, ?, ?, ?)").run(
    "u1",
    "dana@example.com",
    "hash",
    new Date().toISOString(),
  );
  createSession(db, { token: "real-token", userId: "u1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  const user = getSessionUser(db, "real-token");
  assert.equal(user?.email, "dana@example.com");
});

/**
 * This is the actual security boundary requireAuth (apps/api/src/auth/
 * middleware.ts) depends on: getSessionUser's own SQL filters on
 * `expiresAt > ?`. Every existing test that calls it, though, only ever
 * passes a token that's either genuinely still valid, was never created
 * (a "garbage" string), or was already deleted by logout -- none of those
 * exercise a session row that actually EXISTS in the table with a real,
 * already-past expiresAt, which is the one case that specifically proves
 * the expiry comparison itself works. Inserted directly (like the very
 * first test in this file) rather than via createSession, so its own
 * opportunistic pruning doesn't remove the row before getSessionUser gets
 * a chance to (correctly or not) filter it.
 */
test("getSessionUser returns undefined for a session token that still exists in the table but whose expiresAt has already passed", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  db.prepare("INSERT INTO users (id, email, passwordHash, createdAt) VALUES (?, ?, ?, ?)").run(
    "u1",
    "dana@example.com",
    "hash",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)").run(
    "long-expired-token",
    "u1",
    new Date(Date.now() - HOUR_MS).toISOString(),
  );

  // The row is genuinely still there -- this isn't testing deletion.
  const stillPresent = db.prepare("SELECT token FROM sessions WHERE token = ?").get("long-expired-token");
  assert.ok(stillPresent, "the expired session row must still exist in the table for this test to mean anything");

  assert.equal(getSessionUser(db, "long-expired-token"), undefined);
});
