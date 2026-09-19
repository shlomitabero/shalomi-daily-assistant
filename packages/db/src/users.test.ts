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
