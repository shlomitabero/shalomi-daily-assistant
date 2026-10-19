import { randomUUID } from "node:crypto";
import type { ForgeDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";

/**
 * Automation rules: "when a record in this entity is created, or a field
 * on it is set to a given value, send a WhatsApp message" -- the
 * if-this-then-that layer on top of this app's existing WhatsApp
 * integration (packages/db/src/whatsapp.ts). A rule is evaluated by
 * apps/api/src/automations.ts on every record create/update; this module
 * only owns storage. `actionType` is modeled as an enum of one value
 * ("send_whatsapp") rather than hardcoded, so a future action type (e.g.
 * an in-app notification) is an additive change, not a rewrite.
 */
export type AutomationTrigger = "record_created" | "field_equals" | "schedule";
export type AutomationActionType = "send_whatsapp" | "webhook";
export type AutomationToMode = "static" | "field";
export type AutomationLastStatus = "sent" | "failed" | null;

export interface AutomationRule {
  id: string;
  projectId: string;
  entityName: string;
  trigger: AutomationTrigger;
  /** Required when trigger is "field_equals"; null for "record_created". */
  fieldName: string | null;
  /** Required when trigger is "field_equals"; null for "record_created". Compared as a string against the record's own field value. */
  fieldValue: string | null;
  /** Required when trigger is "schedule"; null otherwise. "HH:MM" in 24-hour UTC -- there's no stored per-project timezone anywhere in this app (see automations.ts's own interpolateTemplate comment on lang having the same gap), so a schedule rule's time is UTC, same as this app's own hourly-trigger-style scheduling elsewhere. */
  scheduleTimeUtc: string | null;
  /** Only meaningful when trigger is "schedule". Comma-separated day-of-week numbers (0 = Sunday .. 6 = Saturday, matching Date.prototype.getUTCDay()); null or empty means every day. */
  scheduleDaysOfWeek: string | null;
  actionType: AutomationActionType;
  /** "static" sends to toNumber; "field" reads the destination number from the triggering record's own toField. Meaningless (always "static", ignored) for actionType "webhook" -- stored anyway since the column itself has never been nullable. */
  toMode: AutomationToMode;
  toNumber: string | null;
  toField: string | null;
  /** Required when actionType is "webhook"; null otherwise. The outbound URL the rule POSTs a JSON payload to -- see apps/api/src/automations.ts's own fireWebhookAction for the exact payload shape and the SSRF-hardening host checks applied before every request. */
  webhookUrl: string | null;
  /** May reference the record's own fields as {{fieldName}} placeholders, interpolated at send time. Sent verbatim as the webhook payload's own "message" field for actionType "webhook" too. */
  messageTemplate: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastStatus: AutomationLastStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  projectId: string;
  ruleId: string;
  status: "sent" | "failed";
  error: string | null;
  triggeredAt: string;
}

/**
 * Every individual firing of a rule, not just the most recent one --
 * recordAutomationRun below used to only ever overwrite
 * automation_rules.lastTriggeredAt/lastStatus/lastError, so a rule that
 * failed nine times and then succeeded on the tenth looked perfectly
 * healthy in the UI, with zero way to tell it had been flaky. Same shape
 * as whatsapp_messages (whatsapp.ts) -- a rule fires repeatedly over
 * time and a user wants a log, the identical story that table already
 * solves for WhatsApp traffic.
 */
export function ensureAutomationRunsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      ruleId TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      triggeredAt TEXT NOT NULL
    )
  `);
}

function rowToRun(row: Record<string, unknown>): AutomationRun {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    ruleId: row.ruleId as string,
    status: row.status as "sent" | "failed",
    error: (row.error as string | null) ?? null,
    triggeredAt: row.triggeredAt as string,
  };
}

/**
 * listAutomationRuns below never reads past its own default `limit` (no
 * caller anywhere in this codebase ever passes a different one), so a
 * busy rule -- a daily "schedule" trigger, or a "record_created"/
 * "field_equals" rule on an active entity -- accumulated one row per
 * firing *forever* with nothing ever reading past the most recent 20:
 * pure unbounded growth for zero benefit. Unlike whatsapp_messages and
 * checkpoints (each of which at least got a manual, user-initiated
 * single-row delete -- deleteWhatsAppMessage, deleteCheckpoint), this
 * table had no deletion path at all short of deleting the whole rule or
 * project. Matches listAutomationRuns's own default exactly, so pruning
 * to this cap can never discard a row any current reader could still see.
 */
const AUTOMATION_RUNS_RETENTION_LIMIT = 20;

/**
 * The most recent runs for one rule, newest first -- capped at `limit`
 * (default 20) rather than cursor-paginated like listWhatsAppMessages:
 * AutomationsPanel only ever shows "did this rule recently misbehave,"
 * not a full archival log, so a single bounded page is enough and avoids
 * the extra cursor plumbing a feature this UI doesn't expose would never
 * use.
 */
export function listAutomationRuns(db: ForgeDatabase, projectId: string, ruleId: string, limit = 20): AutomationRun[] {
  const rows = db
    .prepare("SELECT * FROM automation_runs WHERE projectId = ? AND ruleId = ? ORDER BY triggeredAt DESC, rowid DESC LIMIT ?")
    .all(projectId, ruleId, limit) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

/** Part of deleteAutomationRule's own cleanup -- a rule's run history has no reason to survive the rule itself. */
export function deleteAutomationRunsForRule(db: ForgeDatabase, projectId: string, ruleId: string): void {
  db.prepare("DELETE FROM automation_runs WHERE projectId = ? AND ruleId = ?").run(projectId, ruleId);
}

/** Part of deleteProject's cleanup (projects.ts), mirroring deleteAutomationRulesForProject's own convention. */
export function deleteAutomationRunsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM automation_runs WHERE projectId = ?").run(projectId);
}

export function ensureAutomationRulesTable(db: ForgeDatabase): void {
  // automation_runs is a logically separate table, but every existing
  // caller of this function (store.ts, migrate.ts, and this module's own
  // extensive test suite) already treats "the automation rules feature is
  // set up" as a single call -- provisioning the run-history table here
  // too, rather than requiring every one of those call sites to also
  // learn about a second function, keeps recordAutomationRun/
  // deleteAutomationRule's own now-unconditional writes to automation_runs
  // from ever hitting a "no such table" error.
  ensureAutomationRunsTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      entityName TEXT NOT NULL,
      trigger TEXT NOT NULL,
      fieldName TEXT,
      fieldValue TEXT,
      actionType TEXT NOT NULL,
      toMode TEXT NOT NULL,
      toNumber TEXT,
      toField TEXT,
      messageTemplate TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      lastTriggeredAt TEXT,
      lastStatus TEXT,
      lastError TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  // Additive-only, same discipline as checkpoints.ts's own `kind` column
  // migration -- a table created by an older version of this app has
  // neither column at all. Both stay nullable (no backfill/default needed,
  // unlike checkpoints' `kind`): every pre-existing row is a
  // record_created/field_equals rule, for which both columns are simply
  // unused (null), exactly like a schedule rule's own unused fieldName/
  // fieldValue.
  const columns = (db.prepare("PRAGMA table_info(automation_rules)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("scheduleTimeUtc")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN scheduleTimeUtc TEXT");
  }
  if (!columns.includes("scheduleDaysOfWeek")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN scheduleDaysOfWeek TEXT");
  }
  if (!columns.includes("webhookUrl")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN webhookUrl TEXT");
  }
}

function rowToRule(row: Record<string, unknown>): AutomationRule {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    entityName: row.entityName as string,
    trigger: row.trigger as AutomationTrigger,
    fieldName: (row.fieldName as string | null) ?? null,
    fieldValue: (row.fieldValue as string | null) ?? null,
    scheduleTimeUtc: (row.scheduleTimeUtc as string | null) ?? null,
    scheduleDaysOfWeek: (row.scheduleDaysOfWeek as string | null) ?? null,
    actionType: row.actionType as AutomationActionType,
    toMode: row.toMode as AutomationToMode,
    toNumber: (row.toNumber as string | null) ?? null,
    toField: (row.toField as string | null) ?? null,
    webhookUrl: (row.webhookUrl as string | null) ?? null,
    messageTemplate: row.messageTemplate as string,
    enabled: Boolean(row.enabled),
    lastTriggeredAt: (row.lastTriggeredAt as string | null) ?? null,
    lastStatus: (row.lastStatus as AutomationLastStatus) ?? null,
    lastError: (row.lastError as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

export function insertAutomationRule(
  db: ForgeDatabase,
  rule: {
    projectId: string;
    entityName: string;
    trigger: AutomationTrigger;
    fieldName?: string | null;
    fieldValue?: string | null;
    scheduleTimeUtc?: string | null;
    scheduleDaysOfWeek?: string | null;
    actionType: AutomationActionType;
    toMode: AutomationToMode;
    toNumber?: string | null;
    toField?: string | null;
    webhookUrl?: string | null;
    messageTemplate: string;
  },
): AutomationRule {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO automation_rules
       (id, projectId, entityName, trigger, fieldName, fieldValue, scheduleTimeUtc, scheduleDaysOfWeek, actionType, toMode, toNumber, toField, webhookUrl, messageTemplate, enabled, lastTriggeredAt, lastStatus, lastError, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    rule.projectId,
    rule.entityName,
    rule.trigger,
    rule.fieldName ?? null,
    rule.fieldValue ?? null,
    rule.scheduleTimeUtc ?? null,
    rule.scheduleDaysOfWeek ?? null,
    rule.actionType,
    rule.toMode,
    rule.toNumber ?? null,
    rule.toField ?? null,
    rule.webhookUrl ?? null,
    rule.messageTemplate,
    now,
    now,
  );
  return getAutomationRule(db, rule.projectId, id)!;
}

export function getAutomationRule(db: ForgeDatabase, projectId: string, id: string): AutomationRule | undefined {
  const row = db.prepare("SELECT * FROM automation_rules WHERE projectId = ? AND id = ?").get(projectId, id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRule(row) : undefined;
}

export function listAutomationRules(db: ForgeDatabase, projectId: string): AutomationRule[] {
  const rows = db
    .prepare("SELECT * FROM automation_rules WHERE projectId = ? ORDER BY createdAt ASC")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToRule);
}

/**
 * Enabled rules scoped to one entity -- the hot-path list evaluated on
 * every record create/update (apps/api/src/automations.ts), kept to only
 * enabled rows so a disabled rule is never even considered a candidate.
 */
export function listEnabledAutomationRulesForEntity(db: ForgeDatabase, projectId: string, entityName: string): AutomationRule[] {
  const rows = db
    .prepare("SELECT * FROM automation_rules WHERE projectId = ? AND entityName = ? AND enabled = 1 ORDER BY createdAt ASC")
    .all(projectId, entityName) as Record<string, unknown>[];
  return rows.map(rowToRule);
}

/**
 * Every enabled schedule-trigger rule across EVERY project -- unlike
 * listEnabledAutomationRulesForEntity above, a schedule check has no
 * single record-change event to scope it to one entity/project, so the
 * periodic checker (apps/api/src/automations.ts's runScheduledAutomationsCheck)
 * evaluates this list globally on every tick instead.
 */
export function listEnabledScheduledRules(db: ForgeDatabase): AutomationRule[] {
  const rows = db
    .prepare("SELECT * FROM automation_rules WHERE trigger = 'schedule' AND enabled = 1 ORDER BY createdAt ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToRule);
}

export function updateAutomationRule(
  db: ForgeDatabase,
  projectId: string,
  id: string,
  patch: Partial<{
    entityName: string;
    trigger: AutomationTrigger;
    fieldName: string | null;
    fieldValue: string | null;
    scheduleTimeUtc: string | null;
    scheduleDaysOfWeek: string | null;
    actionType: AutomationActionType;
    toMode: AutomationToMode;
    toNumber: string | null;
    toField: string | null;
    webhookUrl: string | null;
    messageTemplate: string;
    enabled: boolean;
  }>,
): AutomationRule {
  const existing = getAutomationRule(db, projectId, id);
  if (!existing) {
    throw new NotFoundError(`Automation rule ${id} not found in project ${projectId}`);
  }
  const next = { ...existing, ...patch };
  db.prepare(
    `UPDATE automation_rules SET
       entityName = ?, trigger = ?, fieldName = ?, fieldValue = ?, scheduleTimeUtc = ?, scheduleDaysOfWeek = ?, actionType = ?, toMode = ?, toNumber = ?, toField = ?, webhookUrl = ?, messageTemplate = ?, enabled = ?, updatedAt = ?
     WHERE projectId = ? AND id = ?`,
  ).run(
    next.entityName,
    next.trigger,
    next.fieldName,
    next.fieldValue,
    next.scheduleTimeUtc,
    next.scheduleDaysOfWeek,
    next.actionType,
    next.toMode,
    next.toNumber,
    next.toField,
    next.webhookUrl,
    next.messageTemplate,
    next.enabled ? 1 : 0,
    new Date().toISOString(),
    projectId,
    id,
  );
  return getAutomationRule(db, projectId, id)!;
}

/**
 * Records the outcome of the most recent automatic trigger -- surfaced in
 * AutomationsPanel so a rule that silently keeps failing (e.g. WhatsApp
 * disconnected) is visible, not a black box. Deliberately swallows a
 * missing rule (no-op, no throw): called from fire-and-forget background
 * code after the record mutation has already responded to the user, so a
 * rule deleted in the few milliseconds since it was read must never turn
 * an already-sent 200 response into a crash.
 */
export function recordAutomationRun(
  db: ForgeDatabase,
  projectId: string,
  id: string,
  outcome: { status: "sent" | "failed"; error?: string | null },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE automation_rules SET lastTriggeredAt = ?, lastStatus = ?, lastError = ? WHERE projectId = ? AND id = ?`,
  ).run(now, outcome.status, outcome.error ?? null, projectId, id);
  // The rule row above stays a cheap, already-wired-up "most recent
  // outcome" summary; this is the actual history, inserted alongside it
  // rather than instead of it so no existing lastTriggeredAt/lastStatus/
  // lastError reader needs to change.
  db.prepare(
    `INSERT INTO automation_runs (id, projectId, ruleId, status, error, triggeredAt) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), projectId, id, outcome.status, outcome.error ?? null, now);
  // Prune anything beyond AUTOMATION_RUNS_RETENTION_LIMIT right away --
  // ordered identically to listAutomationRuns's own ORDER BY, so "the
  // rows that survive" and "the rows listAutomationRuns would return"
  // are always the same set.
  db.prepare(
    `DELETE FROM automation_runs WHERE projectId = ? AND ruleId = ? AND id NOT IN (
      SELECT id FROM automation_runs WHERE projectId = ? AND ruleId = ? ORDER BY triggeredAt DESC, rowid DESC LIMIT ?
    )`,
  ).run(projectId, id, projectId, id, AUTOMATION_RUNS_RETENTION_LIMIT);
}

export function deleteAutomationRule(db: ForgeDatabase, projectId: string, id: string): void {
  const result = db.prepare("DELETE FROM automation_rules WHERE projectId = ? AND id = ?").run(projectId, id);
  if (result.changes === 0) {
    throw new NotFoundError(`Automation rule ${id} not found in project ${projectId}`);
  }
  deleteAutomationRunsForRule(db, projectId, id);
}

/** Part of deleteProject's cleanup (projects.ts), mirroring deleteWhatsAppData's own convention. */
export function deleteAutomationRulesForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM automation_rules WHERE projectId = ?").run(projectId);
  deleteAutomationRunsForProject(db, projectId);
}

/**
 * Called from diffAndMigrate (migrate.ts) when an entity present in
 * previousSpec is absent from nextSpec -- without this, a rule created
 * against the removed entity stayed enabled forever, and deriveEntityName
 * only dedupes against the entities that currently exist, so a *later,
 * unrelated* entity reusing the same auto-derived name would silently
 * resurrect it.
 *
 * Disables rather than deletes (round 596): diffAndMigrate's own doc
 * comment describes it as additive-only, "never drops or renames
 * anything... consistent with... Time Machine checkpoints always being
 * safe to restore" -- but this function used to hard-delete, the one
 * genuine exception to that contract. diffAndMigrate also runs in the
 * *reverse* direction on checkpoint restore (previousSpec = the project's
 * current spec, nextSpec = the checkpoint being restored), and nothing
 * recreates a deleted row when the entity comes back -- restoring an
 * earlier checkpoint that still has the entity silently failed to bring
 * its automation rule back too. Disabling instead keeps the row (and its
 * own history -- lastTriggeredAt/lastStatus/lastError) around for exactly
 * that case: once the entity reappears, the rule is interactable and
 * re-enable-able again through the normal PATCH route, not gone forever.
 */
/**
 * Returns the number of rules actually disabled (0 when none referenced
 * this entity), so diffAndMigrate's own sweep can tell whether to surface
 * this as a migration hazard (see describeMigrationHazards) instead of
 * silently discarding the outcome the way it used to.
 */
export function disableAutomationRulesForEntity(db: ForgeDatabase, projectId: string, entityName: string): number {
  const result = db
    .prepare("UPDATE automation_rules SET enabled = 0, updatedAt = ? WHERE projectId = ? AND entityName = ?")
    .run(new Date().toISOString(), projectId, entityName);
  return Number(result.changes);
}

/**
 * Called from diffAndMigrate for a field removed from a surviving entity.
 * A rule can reference a field two ways -- as the field_equals trigger's
 * own fieldName, or as a toMode: "field" destination's toField -- so both
 * are checked. Scoped by entityName too, the same way
 * disableAutomationRulesForEntity is, since fieldName/toField are plain
 * strings that could otherwise coincide with an unrelated entity's own
 * field of the same name. Disables rather than deletes for the same
 * restore-safety reason as disableAutomationRulesForEntity above.
 *
 * Returns the number of rules actually disabled, same reason as
 * disableAutomationRulesForEntity's own return value.
 */
export function disableAutomationRulesForField(
  db: ForgeDatabase,
  projectId: string,
  entityName: string,
  fieldName: string,
): number {
  const result = db
    .prepare("UPDATE automation_rules SET enabled = 0, updatedAt = ? WHERE projectId = ? AND entityName = ? AND (fieldName = ? OR toField = ?)")
    .run(new Date().toISOString(), projectId, entityName, fieldName, fieldName);
  return Number(result.changes);
}
