import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  createPasswordResetToken,
  deletePasswordResetToken,
  deletePasswordResetTokensForUser,
  ensurePasswordResetTokensTable,
  getPasswordResetTokenByHash,
  pruneExpiredPasswordResetTokens,
} from "./passwordResetTokens.js";

const HOUR_MS = 60 * 60 * 1000;

test("createPasswordResetToken inserts a row that getPasswordResetTokenByHash can read back by its hash", () => {
  const db = openDatabase(":memory:");
  ensurePasswordResetTokensTable(db);
  createPasswordResetToken(db, { id: "token-1", userId: "u1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  const record = getPasswordResetTokenByHash(db, "hash-1");
  assert.ok(record);
  assert.equal(record!.id, "token-1");
  assert.equal(record!.userId, "u1");
});

test("getPasswordResetTokenByHash returns undefined for a hash that was never created", () => {
  const db = openDatabase(":memory:");
  ensurePasswordResetTokensTable(db);
  assert.equal(getPasswordResetTokenByHash(db, "no-such-hash"), undefined);
});

test("deletePasswordResetToken removes only its own row", () => {
  const db = openDatabase(":memory:");
  ensurePasswordResetTokensTable(db);
  createPasswordResetToken(db, { id: "token-1", userId: "u1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createPasswordResetToken(db, { id: "token-2", userId: "u2", tokenHash: "hash-2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  deletePasswordResetToken(db, "token-1");

  assert.equal(getPasswordResetTokenByHash(db, "hash-1"), undefined);
  assert.ok(getPasswordResetTokenByHash(db, "hash-2"));
});

test("deletePasswordResetTokensForUser removes every pending token for that user, leaving other users' tokens untouched", () => {
  const db = openDatabase(":memory:");
  ensurePasswordResetTokensTable(db);
  createPasswordResetToken(db, { id: "token-1", userId: "u1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createPasswordResetToken(db, { id: "token-2", userId: "u1", tokenHash: "hash-2", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });
  createPasswordResetToken(db, { id: "token-3", userId: "u2", tokenHash: "hash-3", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  deletePasswordResetTokensForUser(db, "u1");

  assert.equal(getPasswordResetTokenByHash(db, "hash-1"), undefined);
  assert.equal(getPasswordResetTokenByHash(db, "hash-2"), undefined);
  assert.ok(getPasswordResetTokenByHash(db, "hash-3"), "a different user's token must survive");
});

test("pruneExpiredPasswordResetTokens removes only rows whose expiresAt has already passed, leaving valid ones untouched", () => {
  const db = openDatabase(":memory:");
  ensurePasswordResetTokensTable(db);
  // Inserted directly, bypassing createPasswordResetToken's own
  // opportunistic prune, so this test is about pruneExpiredPasswordResetTokens's
  // own behavior in isolation.
  const insert = db.prepare("INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)");
  const now = new Date().toISOString();
  insert.run("expired-1", "u1", "hash-expired", new Date(Date.now() - HOUR_MS).toISOString(), now);
  insert.run("still-valid", "u1", "hash-valid", new Date(Date.now() + HOUR_MS).toISOString(), now);

  const deletedCount = pruneExpiredPasswordResetTokens(db);
  assert.equal(deletedCount, 1);
  assert.equal(getPasswordResetTokenByHash(db, "hash-expired"), undefined);
  assert.ok(getPasswordResetTokenByHash(db, "hash-valid"));
});

test("createPasswordResetToken opportunistically prunes an already-expired row for a DIFFERENT user before inserting its own", () => {
  const db = openDatabase(":memory:");
  ensurePasswordResetTokensTable(db);
  const insert = db.prepare("INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)");
  insert.run("stale", "u1", "hash-stale", new Date(Date.now() - HOUR_MS).toISOString(), new Date().toISOString());

  createPasswordResetToken(db, { id: "fresh", userId: "u2", tokenHash: "hash-fresh", expiresAt: new Date(Date.now() + HOUR_MS).toISOString() });

  assert.equal(getPasswordResetTokenByHash(db, "hash-stale"), undefined);
  assert.ok(getPasswordResetTokenByHash(db, "hash-fresh"));
});
