import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  createSession,
  createUser,
  deleteAllSessionsForUser,
  deleteExpiredSessions,
  deleteOtherSessionsForUser,
  deleteUser,
  ensureUsersTable,
  findUserById,
  getPasswordHash,
  getSessionUser,
  updatePasswordHash,
} from "./users.js";

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

test("updatePasswordHash replaces the stored hash, and getPasswordHash reads it back -- leaving every other field untouched", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  const user = createUser(db, { id: "u1", email: "dana@example.com", passwordHash: "original-hash" });

  assert.equal(getPasswordHash(db, user.id), "original-hash");

  updatePasswordHash(db, user.id, "new-hash");
  assert.equal(getPasswordHash(db, user.id), "new-hash");

  // Nothing else about the row should have moved.
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as {
    id: string;
    email: string;
    createdAt: string;
  };
  assert.equal(row.id, user.id);
  assert.equal(row.email, user.email);
  assert.equal(row.createdAt, user.createdAt);
});

test("getPasswordHash returns undefined for a user id that doesn't exist", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  assert.equal(getPasswordHash(db, "no-such-user"), undefined);
});

/**
 * New in this round: part of the real "delete my account" flow
 * (routes/auth.ts) -- signs the user out of every device at once by
 * revoking every one of their sessions, not just the token making the
 * delete request itself. Scoped by userId, so a different user's own
 * session must never be touched.
 */
test("deleteAllSessionsForUser revokes every one of this user's own sessions, leaving a different user's session untouched", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  const leaving = createUser(db, { id: "leaving", email: "leaving@example.com", passwordHash: "x" });
  const staying = createUser(db, { id: "staying", email: "staying@example.com", passwordHash: "x" });
  const future = new Date(Date.now() + HOUR_MS).toISOString();
  createSession(db, { token: "leaving-token-1", userId: leaving.id, expiresAt: future });
  createSession(db, { token: "leaving-token-2", userId: leaving.id, expiresAt: future });
  createSession(db, { token: "staying-token", userId: staying.id, expiresAt: future });

  deleteAllSessionsForUser(db, leaving.id);

  assert.equal(getSessionUser(db, "leaving-token-1"), undefined);
  assert.equal(getSessionUser(db, "leaving-token-2"), undefined);
  assert.ok(getSessionUser(db, "staying-token"), "a different user's own session must be completely untouched");
});

test("deleteAllSessionsForUser is a harmless no-op for a user with no sessions at all", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  assert.doesNotThrow(() => deleteAllSessionsForUser(db, "never-logged-in"));
});

/**
 * New in this round: part of the real "change my password" flow
 * (routes/auth.ts) -- fixes a bug where changing your password never
 * revoked any other active session (e.g. a lost laptop, a leaked token),
 * defeating the standard security purpose of a password change, even
 * though the exact revoke-by-user mechanism already existed for account
 * deletion (deleteAllSessionsForUser above). Unlike that function, this
 * one must deliberately spare one specific token -- the very session
 * making the change-password request itself, which the route's own
 * response still needs to be valid against.
 */
test("deleteOtherSessionsForUser revokes every OTHER session for this user, but leaves the one matching keepToken untouched", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  const user = createUser(db, { id: "u1", email: "u1@example.com", passwordHash: "x" });
  const otherUser = createUser(db, { id: "u2", email: "u2@example.com", passwordHash: "x" });
  const future = new Date(Date.now() + HOUR_MS).toISOString();
  createSession(db, { token: "current-session", userId: user.id, expiresAt: future });
  createSession(db, { token: "lost-laptop-session", userId: user.id, expiresAt: future });
  createSession(db, { token: "other-users-session", userId: otherUser.id, expiresAt: future });

  deleteOtherSessionsForUser(db, user.id, "current-session");

  assert.ok(getSessionUser(db, "current-session"), "the session making the request itself must stay valid");
  assert.equal(getSessionUser(db, "lost-laptop-session"), undefined, "every other session for this user must be revoked");
  assert.ok(getSessionUser(db, "other-users-session"), "a different user's own session must be completely untouched");
});

test("deleteOtherSessionsForUser is a harmless no-op for a user with no other sessions", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  const user = createUser(db, { id: "u1", email: "u1@example.com", passwordHash: "x" });
  createSession(db, { token: "only-session", userId: user.id, expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  assert.doesNotThrow(() => deleteOtherSessionsForUser(db, user.id, "only-session"));
  assert.ok(getSessionUser(db, "only-session"), "the lone matching session must stay untouched");
});

/**
 * New in this round: the final step of "delete my account" -- removes the
 * user row itself. Confirms it's genuinely gone (findUserById returns
 * undefined afterward), and that a different user's own row is completely
 * untouched.
 */
test("deleteUser removes the real user row, leaving a different user's own row untouched", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  const leaving = createUser(db, { id: "leaving", email: "leaving@example.com", passwordHash: "x" });
  const staying = createUser(db, { id: "staying", email: "staying@example.com", passwordHash: "x" });

  deleteUser(db, leaving.id);

  assert.equal(findUserById(db, leaving.id), undefined);
  assert.ok(findUserById(db, staying.id), "a different user's own row must be completely untouched");
});
