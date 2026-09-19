import type { User } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

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
}

function rowToUser(row: Record<string, unknown>): User {
  return { id: row.id as string, email: row.email as string, createdAt: row.createdAt as string };
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
  db.prepare("INSERT INTO users (id, email, passwordHash, createdAt) VALUES (?, ?, ?, ?)").run(
    user.id,
    user.email,
    user.passwordHash,
    createdAt,
  );
  return { id: user.id, email: user.email, createdAt };
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
    session.token,
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
    .get(token, new Date().toISOString()) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : undefined;
}

export function deleteSession(db: ForgeDatabase, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
