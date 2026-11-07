import type { ForgeDatabase } from "./connection.js";

export interface RecordDeletion {
  id: number;
  projectId: string;
  entityName: string;
  recordId: number;
  recordLabel: string;
  deletedByUserId: string | null;
  deletedAt: string;
}

export function ensureRecordDeletionsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS record_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      entityName TEXT NOT NULL,
      recordId INTEGER NOT NULL,
      recordLabel TEXT NOT NULL,
      deletedByUserId TEXT,
      deletedAt TEXT NOT NULL
    )
  `);
}

/**
 * Round 1632: the delete half of the audit-trail pair round 1613
 * (createdByUserId) explicitly deferred -- "Record update/delete actor-
 * tracking... are natural, well-scoped follow-ups for a future round" --
 * and round 1617 (updatedByUserId) picked up update but, by its own title,
 * never touched delete either. Unlike create/update, a deleted record has
 * nowhere left to carry a column once it's gone, so this is a small,
 * separate log table instead -- mirroring checkpoints.ts/automations.ts/
 * whatsapp.ts's own RETENTION_LIMIT convention for the identical "small
 * log that only ever grows" shape, applied from this table's very first
 * round rather than shipping another unbounded table a future round would
 * have to come back and fix (the exact gap round 1631 just closed for
 * whatsapp_messages). 500 is comfortably above anything a normal project's
 * own cleanup/correction activity would reach, while still being a real
 * backstop against unbounded growth.
 */
export const RECORD_DELETIONS_RETENTION_LIMIT = 500;

export function insertRecordDeletion(
  db: ForgeDatabase,
  deletion: { projectId: string; entityName: string; recordId: number; recordLabel: string; deletedByUserId: string | null },
): void {
  const deletedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO record_deletions (projectId, entityName, recordId, recordLabel, deletedByUserId, deletedAt) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(deletion.projectId, deletion.entityName, deletion.recordId, deletion.recordLabel, deletion.deletedByUserId, deletedAt);
  // Prunes the oldest deletions beyond the retention limit, mirroring
  // insertCheckpoint's/insertWhatsAppMessage's own exact DELETE...NOT IN
  // (SELECT...ORDER BY...LIMIT ?) pattern. Scoped to this projectId only,
  // so a high-volume project can never evict another project's own log.
  db.prepare(
    `DELETE FROM record_deletions WHERE projectId = ? AND id NOT IN (
      SELECT id FROM record_deletions WHERE projectId = ? ORDER BY deletedAt DESC, id DESC LIMIT ?
    )`,
  ).run(deletion.projectId, deletion.projectId, RECORD_DELETIONS_RETENTION_LIMIT);
}

function rowToRecordDeletion(row: Record<string, unknown>): RecordDeletion {
  return {
    id: row.id as number,
    projectId: row.projectId as string,
    entityName: row.entityName as string,
    recordId: row.recordId as number,
    recordLabel: row.recordLabel as string,
    deletedByUserId: (row.deletedByUserId as string | null) ?? null,
    deletedAt: row.deletedAt as string,
  };
}

/**
 * Round 1680: defaulted to 50 while RECORD_DELETIONS_RETENTION_LIMIT (just
 * above) keeps up to 500 -- the only caller of this function with no limit
 * override, CollaboratorsPanel.tsx's own Copy/Download report, silently
 * showed just the 50 most recent deletions out of up to 500 genuinely
 * retained ones, with no disclosure anything was left out. Matches the
 * sibling AUTOMATION_RUNS_RETENTION_LIMIT/listAutomationRuns convention
 * (automations.ts), which keeps its own retention and default list limit
 * equal for the identical reason: a report built from this data should
 * never be able to look complete while silently missing real, retained
 * rows.
 */
export function listRecordDeletions(db: ForgeDatabase, projectId: string, limit = RECORD_DELETIONS_RETENTION_LIMIT): RecordDeletion[] {
  const rows = db
    .prepare(`SELECT * FROM record_deletions WHERE projectId = ? ORDER BY deletedAt DESC, id DESC LIMIT ?`)
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToRecordDeletion);
}

/** Part of deleteProject's cleanup (projects.ts) -- the project this log describes no longer exists. */
export function deleteRecordDeletionsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare(`DELETE FROM record_deletions WHERE projectId = ?`).run(projectId);
}
