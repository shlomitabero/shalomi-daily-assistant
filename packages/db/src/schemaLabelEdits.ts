import type { ForgeDatabase } from "./connection.js";

export type SchemaLabelEditAction = "entity_renamed" | "field_renamed";

export interface SchemaLabelEdit {
  id: number;
  projectId: string;
  changedByUserId: string | null;
  action: SchemaLabelEditAction;
  entityName: string;
  fieldName: string | null;
  previousLabel: string;
  newLabel: string;
  changedAt: string;
}

export function ensureSchemaLabelEditsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_label_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      changedByUserId TEXT,
      action TEXT NOT NULL,
      entityName TEXT NOT NULL,
      fieldName TEXT,
      previousLabel TEXT NOT NULL,
      newLabel TEXT NOT NULL,
      changedAt TEXT NOT NULL
    )
  `);
}

/**
 * Round 1639: docs/security.md's own "Section 40" note still explicitly
 * names this exact gap -- a checkpoint now records who created it (round
 * 1567), a restore records who performed it (round 1568), a record
 * deletion has its own audit log (round 1632), and a collaborator role
 * change/removal has its own audit log (round 1636), but "entity/field
 * schema edits outside a build... still carry no 'who did this' trail."
 * An entity/field label rename is a live, post-build PATCH any editor-role
 * collaborator can trigger (routes/projects.ts's two .../label routes),
 * and it overwrites the previous label in place with nothing left to show
 * who changed it. Mirrors collaboratorAccessChanges.ts's own
 * small-log-with-retention-limit shape exactly, for the identical reason.
 */
export const SCHEMA_LABEL_EDITS_RETENTION_LIMIT = 500;

export function insertSchemaLabelEdit(
  db: ForgeDatabase,
  edit: {
    projectId: string;
    changedByUserId: string | null;
    action: SchemaLabelEditAction;
    entityName: string;
    fieldName: string | null;
    previousLabel: string;
    newLabel: string;
  },
): void {
  const changedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO schema_label_edits (projectId, changedByUserId, action, entityName, fieldName, previousLabel, newLabel, changedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    edit.projectId,
    edit.changedByUserId,
    edit.action,
    edit.entityName,
    edit.fieldName,
    edit.previousLabel,
    edit.newLabel,
    changedAt,
  );
  // Prunes the oldest entries beyond the retention limit, mirroring
  // insertCollaboratorAccessChange's own exact DELETE...NOT IN
  // (SELECT...ORDER BY...LIMIT ?) pattern. Scoped to this projectId only,
  // so a high-churn project can never evict another project's own log.
  db.prepare(
    `DELETE FROM schema_label_edits WHERE projectId = ? AND id NOT IN (
      SELECT id FROM schema_label_edits WHERE projectId = ? ORDER BY changedAt DESC, id DESC LIMIT ?
    )`,
  ).run(edit.projectId, edit.projectId, SCHEMA_LABEL_EDITS_RETENTION_LIMIT);
}

function rowToSchemaLabelEdit(row: Record<string, unknown>): SchemaLabelEdit {
  return {
    id: row.id as number,
    projectId: row.projectId as string,
    changedByUserId: (row.changedByUserId as string | null) ?? null,
    action: row.action as SchemaLabelEditAction,
    entityName: row.entityName as string,
    fieldName: (row.fieldName as string | null) ?? null,
    previousLabel: row.previousLabel as string,
    newLabel: row.newLabel as string,
    changedAt: row.changedAt as string,
  };
}

/** Round 1680: see recordDeletions.ts's own identical fix for why this default now matches SCHEMA_LABEL_EDITS_RETENTION_LIMIT instead of a smaller, unrelated 50. */
export function listSchemaLabelEdits(db: ForgeDatabase, projectId: string, limit = SCHEMA_LABEL_EDITS_RETENTION_LIMIT): SchemaLabelEdit[] {
  const rows = db
    .prepare(`SELECT * FROM schema_label_edits WHERE projectId = ? ORDER BY changedAt DESC, id DESC LIMIT ?`)
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToSchemaLabelEdit);
}

/** Part of deleteProject's cleanup (projects.ts), mirroring deleteCollaboratorAccessChangesForProject -- nobody can review a project's own audit trail once the project itself no longer exists. */
export function deleteSchemaLabelEditsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare(`DELETE FROM schema_label_edits WHERE projectId = ?`).run(projectId);
}
