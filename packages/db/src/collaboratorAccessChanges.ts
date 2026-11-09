import type { CollaboratorRole } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

// Round 1654: widened to add "ownership_transferred" -- the single
// biggest access-change action in this file (round 1255's own doc
// comment) had no audit-trail entry at all, unlike its two siblings
// (role_changed/removed, round 1636) despite sitting right next to them
// in routes/projects.ts.
//
// Round 1665: widened again to add "invited" -- the one remaining
// sibling in this exact action family (the routes/projects.ts doc
// comments at the collaborators-route section explicitly group invite/
// role-change/removal/ownership-transfer together as "every action that
// changes who has access to this project") that still had no audit-trail
// entry: going from no access to some role is the single most
// fundamental access change there is, yet it left no trace once the
// grant was later changed or removed.
//
// Round 1781: widened again to add "previous_owner_demoted" --
// transferProjectOwnership (projects.ts) does two access changes
// atomically (the new owner is granted ownership AND the previous owner
// is demoted from unrestricted "owner" down to a capped "editor"
// collaborator), but only the first half ever got an audit-trail entry
// (ownership_transferred, round 1654). The bigger side of that handoff --
// the acting user's own loss of delete/invite/transfer-again capability
// -- left no trace. Not reusing "role_changed" for this: that action's
// own report string renders "from {previousRole} to {newRole}", and
// "owner" isn't a representable CollaboratorRole (same reason
// ownership_transferred itself uses newRole: null), so a "role_changed"
// entry here would render with a blank "from".
export type CollaboratorAccessChangeAction = "invited" | "role_changed" | "removed" | "ownership_transferred" | "previous_owner_demoted";

export interface CollaboratorAccessChange {
  id: number;
  projectId: string;
  targetUserId: string;
  changedByUserId: string | null;
  action: CollaboratorAccessChangeAction;
  previousRole: CollaboratorRole | null;
  newRole: CollaboratorRole | null;
  changedAt: string;
}

export function ensureCollaboratorAccessChangesTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaborator_access_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      targetUserId TEXT NOT NULL,
      changedByUserId TEXT,
      action TEXT NOT NULL,
      previousRole TEXT,
      newRole TEXT,
      changedAt TEXT NOT NULL
    )
  `);
}

/**
 * Round 1636: docs/security.md's own "Section 40" note named this exact
 * gap explicitly -- a checkpoint now records who created it
 * (`checkpoints.createdByUserId`, round 1567) and a restore records who
 * performed it (`projects.lastRestoredByUserId`, round 1568), and a record
 * deletion now has its own audit log (round 1632, record_deletions.ts),
 * but "collaborator role changes still carry no 'who did this' trail
 * beyond the implicit single owner." Mirrors record_deletions.ts's own
 * small-log-with-retention-limit shape exactly, and for the identical
 * reason: a role change overwrites the collaborator's previous role in
 * place and a removal deletes the row outright, so neither has anywhere
 * left to carry a "who/when" once it happens -- this is the one place
 * left to keep it.
 */
export const COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT = 500;

export function insertCollaboratorAccessChange(
  db: ForgeDatabase,
  change: {
    projectId: string;
    targetUserId: string;
    changedByUserId: string | null;
    action: CollaboratorAccessChangeAction;
    previousRole: CollaboratorRole | null;
    newRole: CollaboratorRole | null;
  },
): void {
  const changedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO collaborator_access_changes (projectId, targetUserId, changedByUserId, action, previousRole, newRole, changedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    change.projectId,
    change.targetUserId,
    change.changedByUserId,
    change.action,
    change.previousRole,
    change.newRole,
    changedAt,
  );
  // Prunes the oldest entries beyond the retention limit, mirroring
  // insertRecordDeletion's own exact DELETE...NOT IN (SELECT...ORDER BY...
  // LIMIT ?) pattern. Scoped to this projectId only, so a high-churn
  // project can never evict another project's own log.
  db.prepare(
    `DELETE FROM collaborator_access_changes WHERE projectId = ? AND id NOT IN (
      SELECT id FROM collaborator_access_changes WHERE projectId = ? ORDER BY changedAt DESC, id DESC LIMIT ?
    )`,
  ).run(change.projectId, change.projectId, COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT);
}

function rowToCollaboratorAccessChange(row: Record<string, unknown>): CollaboratorAccessChange {
  return {
    id: row.id as number,
    projectId: row.projectId as string,
    targetUserId: row.targetUserId as string,
    changedByUserId: (row.changedByUserId as string | null) ?? null,
    action: row.action as CollaboratorAccessChangeAction,
    previousRole: (row.previousRole as CollaboratorRole | null) ?? null,
    newRole: (row.newRole as CollaboratorRole | null) ?? null,
    changedAt: row.changedAt as string,
  };
}

/** Round 1680: see recordDeletions.ts's own identical fix for why this default now matches COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT instead of a smaller, unrelated 50. */
export function listCollaboratorAccessChanges(db: ForgeDatabase, projectId: string, limit = COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT): CollaboratorAccessChange[] {
  const rows = db
    .prepare(`SELECT * FROM collaborator_access_changes WHERE projectId = ? ORDER BY changedAt DESC, id DESC LIMIT ?`)
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToCollaboratorAccessChange);
}

/** Part of deleteProject's cleanup (projects.ts), mirroring deleteRecordDeletionsForProject -- nobody can review a project's own audit trail once the project itself no longer exists. */
export function deleteCollaboratorAccessChangesForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare(`DELETE FROM collaborator_access_changes WHERE projectId = ?`).run(projectId);
}
