import type { ProjectCollaborator } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

/**
 * Project sharing, the honest first version of the "No RBAC / organizations"
 * gap docs/security.md documented: not a full Workspace/roles system, just a
 * flat "this user has the same full access as the owner" grant per project,
 * one step past "the owner can do everything and nobody else can do
 * anything." Anyone in this table gets identical read/write access to the
 * project through requireProjectAccess (apps/api/src/routes/projects.ts);
 * managing the collaborator list itself stays owner-only.
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
}

/** Idempotent: adding an existing collaborator again is a silent no-op rather than a duplicate-key error. */
export function addCollaborator(db: ForgeDatabase, projectId: string, userId: string): void {
  const addedAt = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO project_collaborators (projectId, userId, addedAt) VALUES (?, ?, ?)").run(
    projectId,
    userId,
    addedAt,
  );
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

export function listCollaborators(db: ForgeDatabase, projectId: string): ProjectCollaborator[] {
  const rows = db
    .prepare(
      `SELECT project_collaborators.userId AS userId, users.email AS email, project_collaborators.addedAt AS addedAt
       FROM project_collaborators
       JOIN users ON users.id = project_collaborators.userId
       WHERE project_collaborators.projectId = ?
       ORDER BY project_collaborators.addedAt ASC, project_collaborators.userId ASC`,
    )
    .all(projectId) as { userId: string; email: string; addedAt: string }[];
  return rows;
}
