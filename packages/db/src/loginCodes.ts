import type { ForgeDatabase } from "./connection.js";

/**
 * Backs the email-login-code step (apps/api/src/routes/auth.ts): once a
 * password checks out, a row here holds the *hash* of a short-lived numeric
 * code (never the plaintext code itself, so a DB leak alone can't be used
 * to log in) until the same browser submits it back. A row only ever covers
 * one pending login for one user -- createLoginCode's own caller deletes any
 * other row for that userId first, so at most one code is ever valid at a
 * time per account. `attempts` exists so the verify route can lock a code
 * out after a handful of wrong guesses instead of letting it be brute-forced
 * for its whole TTL.
 */
export function ensureLoginCodesTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_codes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      codeHash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

export interface LoginCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  attempts: number;
  expiresAt: string;
  createdAt: string;
}

/**
 * Deletes every row whose expiresAt has already passed. Called
 * opportunistically from createLoginCode (every password-verified login
 * attempt that reaches the email step touches this table), the same lazy-
 * cleanup convention sessions/idempotency_keys already use -- otherwise a
 * code nobody ever came back to enter would sit in this table forever.
 */
export function pruneExpiredLoginCodes(db: ForgeDatabase): number {
  const result = db.prepare("DELETE FROM login_codes WHERE expiresAt <= ?").run(new Date().toISOString());
  return result.changes;
}

export function createLoginCode(
  db: ForgeDatabase,
  record: { id: string; userId: string; codeHash: string; expiresAt: string },
): void {
  pruneExpiredLoginCodes(db);
  db.prepare(
    "INSERT INTO login_codes (id, userId, codeHash, attempts, expiresAt, createdAt) VALUES (?, ?, ?, 0, ?, ?)",
  ).run(record.id, record.userId, record.codeHash, record.expiresAt, new Date().toISOString());
}

export function getLoginCode(db: ForgeDatabase, id: string): LoginCodeRecord | undefined {
  return db.prepare("SELECT * FROM login_codes WHERE id = ?").get(id) as LoginCodeRecord | undefined;
}

export function incrementLoginCodeAttempts(db: ForgeDatabase, id: string): void {
  db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
}

export function deleteLoginCode(db: ForgeDatabase, id: string): void {
  db.prepare("DELETE FROM login_codes WHERE id = ?").run(id);
}

/**
 * Called right before issuing a fresh code for a login attempt (routes/
 * auth.ts): without this, re-submitting the login form (e.g. after an
 * abandoned first attempt) would leave the earlier code's row behind,
 * valid until its own TTL -- two different codes for the same account
 * both accepted at once, for no reason. At most one pending code per user
 * ever exists once this runs first.
 */
export function deleteLoginCodesForUser(db: ForgeDatabase, userId: string): void {
  db.prepare("DELETE FROM login_codes WHERE userId = ?").run(userId);
}
