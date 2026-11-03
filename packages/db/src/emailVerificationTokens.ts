import type { ForgeDatabase } from "./connection.js";

/**
 * Backs the "verify your email" flow (apps/api/src/routes/auth.ts): a row
 * here holds the *hash* of a random, URL-carried verification token (never
 * the plaintext token itself, so a DB leak alone can't be replayed into a
 * verification the same way a leaked session token could) until the link
 * is followed. Mirrors passwordResetTokens.ts's own table almost exactly --
 * same "hash only, TTL, single row per user" shape, same reasoning for why
 * there's no `attempts` column (a long random string meant to be followed
 * from a link, not typed by hand, so brute-forcing it by guessing is
 * already infeasible without a per-attempt counter).
 */
export function ensureEmailVerificationTokensTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

export interface EmailVerificationTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Deletes every row whose expiresAt has already passed. Called
 * opportunistically from createEmailVerificationToken (every signup/resend
 * for an account with email configured touches this table), the same lazy-
 * cleanup convention login_codes/password_reset_tokens/sessions/
 * idempotency_keys already use -- otherwise a token nobody ever followed
 * would sit in this table forever.
 */
export function pruneExpiredEmailVerificationTokens(db: ForgeDatabase): number {
  const result = db.prepare("DELETE FROM email_verification_tokens WHERE expiresAt <= ?").run(new Date().toISOString());
  return result.changes;
}

export function createEmailVerificationToken(
  db: ForgeDatabase,
  record: { id: string; userId: string; tokenHash: string; expiresAt: string },
): void {
  pruneExpiredEmailVerificationTokens(db);
  db.prepare(
    "INSERT INTO email_verification_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(record.id, record.userId, record.tokenHash, record.expiresAt, new Date().toISOString());
}

export function getEmailVerificationTokenByHash(db: ForgeDatabase, tokenHash: string): EmailVerificationTokenRecord | undefined {
  return db.prepare("SELECT * FROM email_verification_tokens WHERE tokenHash = ?").get(tokenHash) as
    | EmailVerificationTokenRecord
    | undefined;
}

export function deleteEmailVerificationToken(db: ForgeDatabase, id: string): void {
  db.prepare("DELETE FROM email_verification_tokens WHERE id = ?").run(id);
}

/**
 * Called right before issuing a fresh token (signup, or a resend-
 * verification request): without this, requesting a resend twice would
 * leave the earlier token's row behind, valid until its own TTL -- two
 * different verification links for the same account both accepted at
 * once, for no reason. At most one pending verification token per user
 * ever exists once this runs first.
 */
export function deleteEmailVerificationTokensForUser(db: ForgeDatabase, userId: string): void {
  db.prepare("DELETE FROM email_verification_tokens WHERE userId = ?").run(userId);
}
