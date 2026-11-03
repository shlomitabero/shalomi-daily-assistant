import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  createEmailVerificationToken,
  deleteEmailVerificationToken,
  deleteEmailVerificationTokensForUser,
  ensureEmailVerificationTokensTable,
  getEmailVerificationTokenByHash,
  pruneExpiredEmailVerificationTokens,
} from "./emailVerificationTokens.js";

const HOUR_MS = 60 * 60 * 1000;

test("createEmailVerificationToken inserts a row that getEmailVerificationTokenByHash can read back by its hash", () => {
  const db = openDatabase(":memory:");
  ensureEmailVerificationTokensTable(db);
  createEmailVerificationToken(db, { id: "token-1", userId: "u1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  const record = getEmailVerificationTokenByHash(db, "hash-1");
  assert.ok(record);
  assert.equal(record!.id, "token-1");
  assert.equal(record!.userId, "u1");
});

test("getEmailVerificationTokenByHash returns undefined for a hash that was never created", () => {
  const db = openDatabase(":memory:");
  ensureEmailVerificationTokensTable(db);
  assert.equal(getEmailVerificationTokenByHash(db, "no-such-hash"), undefined);
});

test("deleteEmailVerificationToken removes only its own row", () => {
  const db = openDatabase(":memory:");
  ensureEmailVerificationTokensTable(db);
  createEmailVerificationToken(db, { id: "token-1", userId: "u1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createEmailVerificationToken(db, { id: "token-2", userId: "u2", tokenHash: "hash-2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  deleteEmailVerificationToken(db, "token-1");

  assert.equal(getEmailVerificationTokenByHash(db, "hash-1"), undefined);
  assert.ok(getEmailVerificationTokenByHash(db, "hash-2"));
});

test("deleteEmailVerificationTokensForUser removes every pending token for that user, leaving other users' tokens untouched", () => {
  const db = openDatabase(":memory:");
  ensureEmailVerificationTokensTable(db);
  createEmailVerificationToken(db, { id: "token-1", userId: "u1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createEmailVerificationToken(db, { id: "token-2", userId: "u1", tokenHash: "hash-2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createEmailVerificationToken(db, { id: "token-3", userId: "u2", tokenHash: "hash-3", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  deleteEmailVerificationTokensForUser(db, "u1");

  assert.equal(getEmailVerificationTokenByHash(db, "hash-1"), undefined);
  assert.equal(getEmailVerificationTokenByHash(db, "hash-2"), undefined);
  assert.ok(getEmailVerificationTokenByHash(db, "hash-3"), "a different user's token must survive");
});

test("pruneExpiredEmailVerificationTokens removes only rows whose expiresAt has already passed, leaving valid ones untouched", () => {
  const db = openDatabase(":memory:");
  ensureEmailVerificationTokensTable(db);
  // Inserted directly, bypassing createEmailVerificationToken's own
  // opportunistic prune, so this test is about pruneExpiredEmailVerificationTokens's
  // own behavior in isolation.
  const insert = db.prepare("INSERT INTO email_verification_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)");
  const now = new Date().toISOString();
  insert.run("expired-1", "u1", "hash-expired", new Date(Date.now() - HOUR_MS).toISOString(), now);
  insert.run("still-valid", "u1", "hash-valid", new Date(Date.now() + HOUR_MS).toISOString(), now);

  const deletedCount = pruneExpiredEmailVerificationTokens(db);
  assert.equal(deletedCount, 1);
  assert.equal(getEmailVerificationTokenByHash(db, "hash-expired"), undefined);
  assert.ok(getEmailVerificationTokenByHash(db, "hash-valid"));
});

test("createEmailVerificationToken opportunistically prunes an already-expired row for a DIFFERENT user before inserting its own", () => {
  const db = openDatabase(":memory:");
  ensureEmailVerificationTokensTable(db);
  const insert = db.prepare("INSERT INTO email_verification_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)");
  insert.run("stale", "u1", "hash-stale", new Date(Date.now() - HOUR_MS).toISOString(), new Date().toISOString());

  createEmailVerificationToken(db, { id: "fresh", userId: "u2", tokenHash: "hash-fresh", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  assert.equal(getEmailVerificationTokenByHash(db, "hash-stale"), undefined);
  assert.ok(getEmailVerificationTokenByHash(db, "hash-fresh"));
});
