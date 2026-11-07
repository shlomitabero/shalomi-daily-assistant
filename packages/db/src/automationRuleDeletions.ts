import type { ForgeDatabase } from "./connection.js";
import type { AutomationActionType, AutomationTrigger } from "./automations.js";

export interface AutomationRuleDeletion {
  id: number;
  projectId: string;
  ruleId: string;
  entityName: string;
  trigger: AutomationTrigger;
  actionType: AutomationActionType;
  deletedByUserId: string | null;
  deletedAt: string;
}

export function ensureAutomationRuleDeletionsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_rule_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL,
      ruleId TEXT NOT NULL,
      entityName TEXT NOT NULL,
      trigger TEXT NOT NULL,
      actionType TEXT NOT NULL,
      deletedByUserId TEXT,
      deletedAt TEXT NOT NULL
    )
  `);
}

/**
 * Round 1666: the delete half of the automation-rule audit-trail pair --
 * round 1664 (createdByUserId/updatedByUserId) closed create/update, but
 * deleteAutomationRule itself still just ran a bare DELETE, exactly the
 * gap round 1632's own doc comment named for ordinary records before
 * record_deletions.ts closed it ("Record update/delete actor-tracking...
 * are natural, well-scoped follow-ups"). Mirrors record_deletions.ts's
 * own shape and RETENTION_LIMIT convention exactly: a deleted rule has
 * nowhere left to carry a column once it's gone, so this is a small,
 * separate log table, scoped per-project. entityName/trigger/actionType
 * are captured at delete time (read from the live row just before the
 * DELETE) since there's no single free-text "name" field on an
 * automation rule to snapshot the way record_deletions.ts snapshots
 * recordLabel -- these three fields are enough to identify which rule
 * was deleted without needing the full entities/relatedRecords/lang
 * context describeRule's own human-readable sentence requires.
 */
export const AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT = 500;

export function insertAutomationRuleDeletion(
  db: ForgeDatabase,
  deletion: {
    projectId: string;
    ruleId: string;
    entityName: string;
    trigger: AutomationTrigger;
    actionType: AutomationActionType;
    deletedByUserId: string | null;
  },
): void {
  const deletedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO automation_rule_deletions (projectId, ruleId, entityName, trigger, actionType, deletedByUserId, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(deletion.projectId, deletion.ruleId, deletion.entityName, deletion.trigger, deletion.actionType, deletion.deletedByUserId, deletedAt);
  // Prunes the oldest deletions beyond the retention limit, mirroring
  // insertRecordDeletion's own exact DELETE...NOT IN (SELECT...ORDER BY...
  // LIMIT ?) pattern. Scoped to this projectId only, so a high-churn
  // project can never evict another project's own log.
  db.prepare(
    `DELETE FROM automation_rule_deletions WHERE projectId = ? AND id NOT IN (
      SELECT id FROM automation_rule_deletions WHERE projectId = ? ORDER BY deletedAt DESC, id DESC LIMIT ?
    )`,
  ).run(deletion.projectId, deletion.projectId, AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT);
}

function rowToAutomationRuleDeletion(row: Record<string, unknown>): AutomationRuleDeletion {
  return {
    id: row.id as number,
    projectId: row.projectId as string,
    ruleId: row.ruleId as string,
    entityName: row.entityName as string,
    trigger: row.trigger as AutomationTrigger,
    actionType: row.actionType as AutomationActionType,
    deletedByUserId: (row.deletedByUserId as string | null) ?? null,
    deletedAt: row.deletedAt as string,
  };
}

export function listAutomationRuleDeletions(db: ForgeDatabase, projectId: string, limit = 50): AutomationRuleDeletion[] {
  const rows = db
    .prepare(`SELECT * FROM automation_rule_deletions WHERE projectId = ? ORDER BY deletedAt DESC, id DESC LIMIT ?`)
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToAutomationRuleDeletion);
}

/** Part of deleteProject's cleanup (projects.ts), mirroring deleteRecordDeletionsForProject's own convention -- nobody can review a project's own audit trail once the project itself no longer exists. */
export function deleteAutomationRuleDeletionsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare(`DELETE FROM automation_rule_deletions WHERE projectId = ?`).run(projectId);
}
