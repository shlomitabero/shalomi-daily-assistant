import type { ForgeDatabase } from "./connection.js";

/**
 * Backs the "forgot password" flow (apps/api/src/routes/auth.ts): a row
 * here holds the *hash* of a random, URL-carried reset token (never the
 * plaintext token itself, so a DB leak alone can't be replayed into a
 * password reset the same way a leaked session token could) until the
 * link is followed and a new password submitted. Mirrors loginCodes.ts's
 * own table almost exactly -- same "hash only, TTL, single row per user"
 * shape -- except there's no `attempts` column: a reset token is a long
 * random string meant to be pasted/followed from a link, not typed by
 * hand digit by digit, so brute-forcing it by guessing is already
 * infeasible without a per-attempt counter the way a 6-digit login code
 * would need one. That also means, unlike login_codes (looked up by its
 * own opaque `id`, with the short guessable `code` compared only after
 * fetching, so attempts can be rate-limited per row), a reset token can
 * safely be looked up directly by its own hash -- there's no meaningful
 * guessing attack against a 256-bit random value's hash to defend
 * against by splitting the lookup key from the secret.
 */
export function ensurePasswordResetTokensTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Deletes every row whose expiresAt has already passed. Called
 * opportunistically from createPasswordResetToken (every forgot-password
 * request for a real account touches this table), the same lazy-cleanup
 * convention login_codes/sessions/idempotency_keys already use --
 * otherwise a token nobody ever followed would sit in this table forever.
 */
export function pruneExpiredPasswordResetTokens(db: ForgeDatabase): number {
  const result = db.prepare("DELETE FROM password_reset_tokens WHERE expiresAt <= ?").run(new Date().toISOString());
  return result.changes;
}

export function createPasswordResetToken(
  db: ForgeDatabase,
  record: { id: string; userId: string; tokenHash: string; expiresAt: string },
): void {
  pruneExpiredPasswordResetTokens(db);
  db.prepare(
    "INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(record.id, record.userId, record.tokenHash, record.expiresAt, new Date().toISOString());
}

export function getPasswordResetTokenByHash(db: ForgeDatabase, tokenHash: string): PasswordResetTokenRecord | undefined {
  return db.prepare("SELECT * FROM password_reset_tokens WHERE tokenHash = ?").get(tokenHash) as
    | PasswordResetTokenRecord
    | undefined;
}

export function deletePasswordResetToken(db: ForgeDatabase, id: string): void {
  db.prepare("DELETE FROM password_reset_tokens WHERE id = ?").run(id);
}

/**
 * Called right before issuing a fresh token for a forgot-password request
 * (routes/auth.ts): without this, requesting a reset twice (e.g. because
 * the first email was slow to arrive) would leave the earlier token's row
 * behind, valid until its own TTL -- two different reset links for the
 * same account both accepted at once, for no reason. At most one pending
 * reset token per user ever exists once this runs first.
 */
export function deletePasswordResetTokensForUser(db: ForgeDatabase, userId: string): void {
  db.prepare("DELETE FROM password_reset_tokens WHERE userId = ?").run(userId);
}
