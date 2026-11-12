import { createHash } from "node:crypto";
import type { User } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

/**
 * Round 861: unlike this app's two other bearer-style secrets (both
 * hashed before storage -- see routes/auth.ts's own hashResetToken/
 * hashLoginCode, each with a doc comment explicitly stating "the token/
 * code itself is never stored -- only this hash -- so a DB leak alone
 * can't be replayed into a reset/login the way a leaked session token
 * could"), the session token itself -- the one credential actually used
 * on every single authenticated API request, for up to 30 days -- was
 * stored and looked up as a raw, directly-replayable string. Anything
 * that exposes a row from this table (a DB admin's read access, a future
 * read-only diagnostics feature, a verbose logger capturing bound SQL
 * parameters, a leaked/stolen SQLite file -- a single file, trivially
 * copyable) hands over a ready-to-use 30-day credential with no
 * cracking required at all, exactly the risk the two sibling secrets
 * were already deliberately protected against, just never extended to
 * the one secret that matters most and lives longest. Deliberately the
 * same fast sha256 those two already use, not hashPassword's scrypt: a
 * session token's own defense is its 256 bits of randomness (randomBytes
 * in routes/auth.ts's issueSession) plus its TTL, not hash cost -- there
 * is no attempts-counter/brute-force concern here any more than there is
 * for a password-reset token.
 *
 * Exported (unlike hashResetToken/hashLoginCode, which stay private to
 * routes/auth.ts) specifically so users.test.ts can construct a raw
 * session row matching a known plaintext token for a test that
 * deliberately bypasses createSession's own write path (see e.g. the
 * expiry-filter test, which inserts directly via SQL to isolate
 * getSessionUser's own expiresAt comparison from createSession's
 * opportunistic pruning).
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ensureUsersTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    )
  `);
  // Round 1838: see rounds 1829/1833/1834's own identical fix for
  // idempotency_keys/automation_runs/whatsapp_messages -- this table had
  // no secondary index at all (only `token` via its own PRIMARY KEY),
  // despite deleteExpiredSessions' own `WHERE expiresAt <= ?` DELETE
  // running unconditionally from createSession on every single login/
  // signup/login-code verification (routes/auth.ts's issueSession), the
  // hottest of the four unindexed queries this fixes -- and
  // deleteAllSessionsForUser/deleteOtherSessionsForUser/
  // countOtherSessionsForUser's own `WHERE userId = ? ...` queries, each
  // scanning every OTHER user's rows too instead of being bounded to just
  // this one. Two separate indexes (not a composite) since the four
  // queries filter on `expiresAt` alone, `userId` alone, or `userId` plus
  // a `token !=` exclusion SQLite can't use an index for anyway -- a
  // `userId`-only index already lets it seek straight to this user's own
  // rows before applying that filter in memory.
  db.exec(`CREATE INDEX IF NOT EXISTS sessions_expiresAt_idx ON sessions (expiresAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS sessions_userId_idx ON sessions (userId)`);
  // Round 1566: backs the "verify your email" feature -- additive-only,
  // same discipline as projects.ts's own calendarFeedToken/
  // inboundWebhookToken columns. Unlike those (lazily null forever until
  // first used), a row left null here would mean every account that
  // existed before this feature shipped shows the "please verify your
  // email" banner forever, with no way to tell them apart from a genuinely
  // unverified new signup -- a false signal on every real, already-trusted
  // existing account. Backfilling to createdAt, in the same migration step
  // (not a separate pass), marks every pre-existing account as already
  // verified; createUser below always inserts NULL for a brand-new row, so
  // only a signup made AFTER this column existed can ever be genuinely
  // unverified.
  const userColumns = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (!userColumns.includes("emailVerifiedAt")) {
    db.exec("ALTER TABLE users ADD COLUMN emailVerifiedAt TEXT");
    db.exec("UPDATE users SET emailVerifiedAt = createdAt WHERE emailVerifiedAt IS NULL");
  }
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    createdAt: row.createdAt as string,
    emailVerifiedAt: (row.emailVerifiedAt as string | null) ?? null,
  };
}

export class DuplicateEmailError extends Error {}

export function createUser(
  db: ForgeDatabase,
  user: { id: string; email: string; passwordHash: string },
): User {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(user.email);
  if (existing) {
    throw new DuplicateEmailError(`An account with email "${user.email}" already exists`);
  }
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO users (id, email, passwordHash, createdAt, emailVerifiedAt) VALUES (?, ?, ?, ?, NULL)").run(
    user.id,
    user.email,
    user.passwordHash,
    createdAt,
  );
  return { id: user.id, email: user.email, createdAt, emailVerifiedAt: null };
}

/**
 * Round 1566: marks the account's email as verified -- called either when
 * a real POST /auth/verify-email call consumes a genuine token, or
 * immediately at signup when emailSender.configured is false (there is no
 * way to verify on a deployment with no email provider, so treating a
 * brand-new account as perpetually "unverified" with no usable resend
 * would just be a dead-end banner; see routes/auth.ts's own signup route).
 */
export function markEmailVerified(db: ForgeDatabase, userId: string): void {
  db.prepare("UPDATE users SET emailVerifiedAt = ? WHERE id = ?").run(new Date().toISOString(), userId);
}

export function findUserById(db: ForgeDatabase, id: string): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToUser(row) : undefined;
}

export function findUserByEmail(
  db: ForgeDatabase,
  email: string,
): (User & { passwordHash: string }) | undefined {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | Record<string, unknown>
    | undefined;
  return row ? { ...rowToUser(row), passwordHash: row.passwordHash as string } : undefined;
}

/**
 * Deletes every session whose expiresAt has already passed. Nothing else
 * in this file ever pruned expired rows -- getSessionUser just filters
 * them out of its own query -- so on a long-running deployment the table
 * only ever grows, one row per login, forever. Called opportunistically
 * from createSession (every login/signup issues one) rather than needing
 * a separate scheduled job: a real, if imprecise, session's worth of
 * lazy cleanup on the one write path that already touches this table.
 */
export function deleteExpiredSessions(db: ForgeDatabase): number {
  const result = db.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(new Date().toISOString());
  return result.changes;
}

export function createSession(
  db: ForgeDatabase,
  session: { token: string; userId: string; expiresAt: string },
): void {
  deleteExpiredSessions(db);
  db.prepare("INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)").run(
    hashSessionToken(session.token),
    session.userId,
    session.expiresAt,
  );
}

export function getSessionUser(db: ForgeDatabase, token: string): User | undefined {
  const row = db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.userId
       WHERE sessions.token = ? AND sessions.expiresAt > ?`,
    )
    .get(hashSessionToken(token), new Date().toISOString()) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : undefined;
}

export function deleteSession(db: ForgeDatabase, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(hashSessionToken(token));
}

/** For the change-password route: verifying the caller's *current* password before accepting a new one. Not part of the public User type, so this stays its own narrow lookup rather than widening findUserById. */
export function getPasswordHash(db: ForgeDatabase, userId: string): string | undefined {
  const row = db.prepare("SELECT passwordHash FROM users WHERE id = ?").get(userId) as
    | { passwordHash: string }
    | undefined;
  return row?.passwordHash;
}

export function updatePasswordHash(db: ForgeDatabase, userId: string, passwordHash: string): void {
  db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").run(passwordHash, userId);
}

/**
 * For the "change my email" flow (routes/auth.ts) -- `email` was otherwise
 * write-once, set once at createUser and never touched again, the same gap
 * updateProjectName/updateProjectDescription (routes/projects.ts) already
 * closed for a project's own name/description: a signup typo, or an email
 * provider becoming inaccessible, left the only "fix" as deleting the
 * entire account (DELETE /auth/account, cascading away every owned
 * project) and re-registering from scratch. It also broke collaboration --
 * addCollaborator/CollaboratorsPanel identify people strictly by email
 * (findUserByEmail), so a stale or wrong email on one's own account meant
 * collaborators could no longer find or re-invite that person correctly,
 * with no self-service fix available either way.
 *
 * Same uniqueness guard as createUser, just scoped to exclude this user's
 * own current row (`AND id != ?`) -- without it, re-submitting your own
 * unchanged email back (a no-op from the caller's point of view) would be
 * rejected as "already taken", since the row that already has it is this
 * exact user.
 */
export function updateUserEmail(db: ForgeDatabase, userId: string, email: string): User {
  const existing = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, userId);
  if (existing) {
    throw new DuplicateEmailError(`An account with email "${email}" already exists`);
  }
  db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
  return findUserById(db, userId)!;
}

/** Part of the "delete my account" flow (routes/auth.ts) -- signs the user out of every device at once, not just the one session making this request. */
export function deleteAllSessionsForUser(db: ForgeDatabase, userId: string): void {
  db.prepare("DELETE FROM sessions WHERE userId = ?").run(userId);
}

/**
 * Part of the "change my password" flow (routes/auth.ts) -- revokes every
 * one of this user's OTHER sessions (e.g. a lost laptop, a borrowed phone,
 * a leaked token), the standard security purpose of a password change,
 * without also killing the very session making this exact request (which
 * requireAuth needs to stay valid so the response can still succeed).
 */
export function deleteOtherSessionsForUser(db: ForgeDatabase, userId: string, keepToken: string): void {
  db.prepare("DELETE FROM sessions WHERE userId = ? AND token != ?").run(userId, hashSessionToken(keepToken));
}

/**
 * Round 1640: lets the "log out other devices" button (App.tsx) know in
 * advance whether there's anything to revoke, mirroring
 * deleteOtherSessionsForUser's own exclusion of the keep-token -- without
 * this, the button's confirm() dialog fires for the overwhelmingly common
 * case of a single-device user with nothing else to log out of. Also
 * excludes already-expired rows (same `expiresAt > now` condition
 * getSessionUser uses), so a stale row deleteExpiredSessions hasn't swept
 * yet never counts as a real other session.
 */
export function countOtherSessionsForUser(db: ForgeDatabase, userId: string, keepToken: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sessions WHERE userId = ? AND token != ? AND expiresAt > ?")
    .get(userId, hashSessionToken(keepToken), new Date().toISOString()) as { count: number };
  return row.count;
}

/**
 * Deletes the user row itself -- the last step of "delete my account"
 * (routes/auth.ts), called only after every project this user owns has
 * already been deleted, every OTHER project's collaborator grant for them
 * has been removed (removeAllCollaborationsForUser), every one of their
 * own sessions has been revoked (deleteAllSessionsForUser), and (round
 * 1985) any outstanding password-reset token, login code and email-
 * verification token for them has been superseded
 * (deletePasswordResetTokensForUser/deleteLoginCodesForUser/
 * deleteEmailVerificationTokensForUser) -- those three tables each carry
 * their own `userId` column with no foreign-key constraint, so a row left
 * behind there would otherwise never be cleaned up by this delete alone.
 */
export function deleteUser(db: ForgeDatabase, userId: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}
