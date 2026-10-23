import type { CollaboratorRole, ProjectCollaborator } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

/**
 * Project sharing, now a real two-tier role system: a collaborator is
 * either an "editor" (identical read/write access to the owner, the
 * original and still-default grant) or a "viewer" (read-only -- enforced
 * server-side by requireProjectWriteAccess in
 * apps/api/src/routes/projects.ts, not just hidden in the UI). The owner
 * themself is never a row in this table -- ownership is project.ownerId,
 * checked separately by requireProjectOwner; managing the collaborator
 * list (inviting, removing, changing someone's role) stays owner-only.
 */
export function ensureProjectCollaboratorsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_collaborators (
      projectId TEXT NOT NULL,
      userId TEXT NOT NULL,
      addedAt TEXT NOT NULL,
      PRIMARY KEY (projectId, userId)
    )
  `);

  // Additive migration (mirrors checkpoints.ts's own `kind` column
  // backfill): every collaborator granted before roles existed keeps
  // exactly the full access they already had, so this can never be a
  // silent permission downgrade for an existing deployment.
  const hasRoleColumn = (db.prepare("PRAGMA table_info(project_collaborators)").all() as { name: string }[]).some(
    (c) => c.name === "role",
  );
  if (!hasRoleColumn) {
    db.exec("ALTER TABLE project_collaborators ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'");
  }
}

/** Idempotent: adding an existing collaborator again is a silent no-op rather than a duplicate-key error (their existing role is left untouched -- use updateCollaboratorRole to change it). */
export function addCollaborator(
  db: ForgeDatabase,
  projectId: string,
  userId: string,
  role: CollaboratorRole = "editor",
): void {
  const addedAt = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO project_collaborators (projectId, userId, addedAt, role) VALUES (?, ?, ?, ?)",
  ).run(projectId, userId, addedAt, role);
}

/** Null means "not a collaborator at all" (could still be the owner, who isn't in this table -- callers that need the owner case too should check that separately). */
export function getCollaboratorRole(db: ForgeDatabase, projectId: string, userId: string): CollaboratorRole | null {
  const row = db
    .prepare("SELECT role FROM project_collaborators WHERE projectId = ? AND userId = ?")
    .get(projectId, userId) as { role: CollaboratorRole } | undefined;
  return row ? row.role : null;
}

/** No-op (rather than throwing) if the given userId isn't actually a collaborator on this project -- callers already resolved that via requireProjectOwner before reaching here. */
export function updateCollaboratorRole(db: ForgeDatabase, projectId: string, userId: string, role: CollaboratorRole): void {
  db.prepare("UPDATE project_collaborators SET role = ? WHERE projectId = ? AND userId = ?").run(role, projectId, userId);
}

export function removeCollaborator(db: ForgeDatabase, projectId: string, userId: string): void {
  db.prepare("DELETE FROM project_collaborators WHERE projectId = ? AND userId = ?").run(projectId, userId);
}

export function isCollaborator(db: ForgeDatabase, projectId: string, userId: string): boolean {
  const row = db.prepare("SELECT 1 FROM project_collaborators WHERE projectId = ? AND userId = ?").get(projectId, userId);
  return row !== undefined;
}

/** Part of deleteProject's cleanup (projects.ts) -- nobody has access to a project that no longer exists. */
export function removeAllCollaborators(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM project_collaborators WHERE projectId = ?").run(projectId);
}

/**
 * The complement to removeAllCollaborators above, scoped by userId instead
 * of projectId -- part of a real self-service "delete my account" flow
 * (routes/auth.ts): once every project this user actually OWNS has already
 * been deleted (each with its own full cascade via deleteProject), this
 * removes them from every OTHER project's collaborator list too, so a
 * project they were merely invited to keeps working correctly for its real
 * owner and any other collaborators, rather than leaking a grant for a
 * user id that no longer exists.
 */
export function removeAllCollaborationsForUser(db: ForgeDatabase, userId: string): void {
  db.prepare("DELETE FROM project_collaborators WHERE userId = ?").run(userId);
}

/**
 * The complement to listOwnedProjectIds (projects.ts): every project id this
 * user has collaborator access to, queried directly off this table alone so
 * it never touches projects.spec_json -- unlike listProjectsForUser, which
 * silently drops a project whose stored spec no longer parses against
 * today's (stricter) ProductSpecSchema. A caller that needs the real,
 * complete set of ids this user can reach -- not a user-facing listing of
 * project details -- should use this instead.
 */
export function listCollaboratedProjectIds(db: ForgeDatabase, userId: string): string[] {
  const rows = db.prepare("SELECT projectId FROM project_collaborators WHERE userId = ?").all(userId) as {
    projectId: string;
  }[];
  return rows.map((r) => r.projectId);
}

// addedAt has only millisecond resolution, so two collaborators added in
// quick succession (e.g. two invites sent back-to-back, or two concurrent
// requests) can share the same value -- exactly the hazard checkpoints.ts/
// projects.ts/automations.ts's own listCheckpoints/listProjectsForUser/
// listAutomationRules already guard against with a rowid tiebreak (round
// 808). This query instead broke the tie on userId ASC, an essentially
// random string unrelated to insertion order -- CollaboratorsPanel.tsx
// renders this list directly, so a same-millisecond tie could display the
// collaborator added second above the one added first. rowid strictly
// increases with insertion order in this table (not declared WITHOUT
// ROWID), so `rowid ASC` breaks the tie deterministically in favor of
// "added first" -- matching this function's own ASC direction.
export function listCollaborators(db: ForgeDatabase, projectId: string): ProjectCollaborator[] {
  const rows = db
    .prepare(
      `SELECT project_collaborators.userId AS userId, users.email AS email, project_collaborators.addedAt AS addedAt, project_collaborators.role AS role
       FROM project_collaborators
       JOIN users ON users.id = project_collaborators.userId
       WHERE project_collaborators.projectId = ?
       ORDER BY project_collaborators.addedAt ASC, project_collaborators.rowid ASC`,
    )
    .all(projectId) as { userId: string; email: string; addedAt: string; role: CollaboratorRole }[];
  return rows;
}
