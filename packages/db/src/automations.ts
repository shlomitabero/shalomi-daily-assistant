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
/**
 * Round 969: "record_deleted" fires at the exact same point as
 * "record_created" would for a brand-new row, but for a row that's about
 * to be (or was just) removed -- see apps/api/src/automations.ts's own
 * matchesTrigger/runAutomationsForRecordChange for how the "deleted"
 * event reuses the pre-delete record's own last-known field values, the
 * only state a deleted row has left to interpolate a message or resolve
 * a toMode:"field" destination from.
 */
export type AutomationTrigger = "record_created" | "field_equals" | "schedule" | "record_deleted";
export type AutomationActionType = "send_whatsapp" | "webhook" | "send_email";
export type AutomationToMode = "static" | "field";
export type AutomationLastStatus = "sent" | "failed" | null;

/**
 * Round 951: exported so apps/api/src/automations.ts's fireRule/
 * fireScheduledRule (the only real producers of this exact error) and this
 * module's own run-retention pruning (recordAutomationRun below) agree on
 * one literal instead of two independently-typed copies silently drifting
 * apart. See recordAutomationRun's own doc comment for why pruning needs
 * to single this error out specifically.
 */
export const WHATSAPP_NOT_CONNECTED_ERROR = "WhatsApp is not connected";

/**
 * Round 1032: the same deployment-level (not per-rule) infrastructure gap
 * as WHATSAPP_NOT_CONNECTED_ERROR above, for the "send_email" action
 * type's own equivalent -- no RESEND_API_KEY configured for this
 * deployment (apps/api/src/automations.ts's fireEmailAction). Exported
 * for the same reason: apps/api/src/automations.ts's
 * hasTooManyConsecutiveFailuresToday and this module's own
 * recordAutomationRun pruning both need to single it out, and a shared
 * constant is the only thing that keeps them from silently drifting
 * apart the way two independently-typed copies of the literal could.
 */
export const EMAIL_NOT_CONFIGURED_ERROR = "Email sending is not configured for this deployment";

export interface AutomationRule {
  id: string;
  projectId: string;
  entityName: string;
  trigger: AutomationTrigger;
  /** Required when trigger is "field_equals"; null for "record_created". */
  fieldName: string | null;
  /** Required when trigger is "field_equals"; null for "record_created". Compared as a string against the record's own field value. */
  fieldValue: string | null;
  /**
   * Required when trigger is "schedule"; null otherwise. "HH:MM", 24-hour --
   * despite the field's own name (kept as-is for backward compatibility
   * with every existing stored rule and API caller rather than renamed),
   * this is wall-clock time in `scheduleTimezone` below, not literally
   * UTC, as of round 967. A rule with no `scheduleTimezone` set (every
   * rule created before round 967) is still interpreted as UTC exactly as
   * before -- see isScheduledRuleDue's own doc comment (apps/api/src/automations.ts).
   */
  scheduleTimeUtc: string | null;
  /**
   * Only meaningful when trigger is "schedule". Comma-separated day-of-week
   * numbers (0 = Sunday .. 6 = Saturday), in the same `scheduleTimezone`
   * wall-clock terms as scheduleTimeUtc above (not necessarily UTC, despite
   * sibling field's own name); null or empty means every day.
   */
  scheduleDaysOfWeek: string | null;
  /**
   * Round 967: the IANA timezone (e.g. "Asia/Jerusalem") that
   * scheduleTimeUtc/scheduleDaysOfWeek are wall-clock values in. Null for
   * every rule created before this column existed, and treated identically
   * to the literal string "UTC" everywhere this is read -- so an existing
   * schedule rule's real-world firing time is completely unchanged by this
   * column's addition. Storing the zone itself (rather than converting the
   * user's local time to a fixed UTC HH:MM once, at save time) is what lets
   * isScheduledRuleDue get DST transitions right automatically, by asking
   * the platform's own timezone database what the current wall-clock time
   * in that zone is on every check, instead of a UTC offset baked in at
   * creation time silently going stale twice a year.
   */
  scheduleTimezone: string | null;
  actionType: AutomationActionType;
  /**
   * "static" sends to toNumber (actionType "send_whatsapp") or toEmail
   * (actionType "send_email"); "field" reads the destination number/email
   * from the triggering record's own toField instead. Meaningless
   * (always "static", ignored) for actionType "webhook" -- stored anyway
   * since the column itself has never been nullable.
   */
  toMode: AutomationToMode;
  toNumber: string | null;
  toField: string | null;
  /** Round 996: required when actionType is "send_email" and toMode is "static"; null otherwise. The recipient address a "send_email" rule emails directly, mirroring toNumber's own identical role for "send_whatsapp". */
  toEmail: string | null;
  /** Round 996: required when actionType is "send_email"; null otherwise. The outgoing email's subject line -- messageTemplate below is reused as the email BODY, the same way it's already reused as "send_whatsapp"'s message text and "webhook"'s payload message field. */
  emailSubject: string | null;
  /** Required when actionType is "webhook"; null otherwise. The outbound URL the rule POSTs a JSON payload to -- see apps/api/src/automations.ts's own fireWebhookAction for the exact payload shape and the SSRF-hardening host checks applied before every request. */
  webhookUrl: string | null;
  /**
   * Round 974: optional, only meaningful when actionType is "webhook". When
   * set, apps/api/src/automations.ts's fireWebhookAction sends it as an
   * `Authorization: Bearer <webhookSecret>` request header -- before this,
   * the outbound request carried no auth of any kind, so the webhook
   * action couldn't reach any real destination that requires one (the
   * overwhelming majority: Slack/Stripe/GitHub-style receivers, or any
   * plain bearer-token API). Null leaves the request exactly as it always
   * was, with no Authorization header at all.
   */
  webhookSecret: string | null;
  /** May reference the record's own fields as {{fieldName}} placeholders, interpolated at send time. Sent verbatim as the webhook payload's own "message" field for actionType "webhook" too. */
  messageTemplate: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastStatus: AutomationLastStatus;
  lastError: string | null;
  /** Round 948: the actionType this rule actually HAD when lastTriggeredAt/lastStatus/lastError were last written -- see AutomationRun's own identical field for why a live `actionType` reference isn't safe to translate lastError against. Null for a run recorded before this column existed, or if the rule has never fired at all. */
  lastActionType: AutomationActionType | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  projectId: string;
  ruleId: string;
  status: "sent" | "failed";
  error: string | null;
  /**
   * Round 948: the rule's own actionType AT THE TIME this run fired, not a
   * live reference to the rule -- a rule's actionType can be edited after
   * the fact (UpdateAutomationRuleSchema/updateAutomationRule never touch
   * run history), so without its own snapshot, re-rendering an older run
   * after the rule's actionType changed would translate (or fail to
   * translate) its stored `error` using the WRONG rule's current action
   * type. Null only for a run recorded before this column existed
   * (additive-only migration, no backfill, same convention as every other
   * column this table/automation_rules has ever added).
   */
  actionType: AutomationActionType | null;
  /**
   * Round 971: the id of the record (if any) that triggered this run --
   * null for a "schedule" rule's own run (there's no triggering record at
   * all) and for any run recorded before this column existed. Lets a
   * failed record-triggered run be manually retried later (see
   * apps/api/src/routes/projects.ts's own POST .../runs/:runId/retry) by
   * re-fetching that SAME record's CURRENT state -- this table stores no
   * snapshot of the record's values at the time it originally fired, only
   * a reference to which one it was, so a retry necessarily uses
   * whatever that record looks like now, not what it looked like then.
   *
   * Round 991: that "re-fetch the current state" design is unreachable for
   * a "record_deleted"-triggered run specifically -- the triggering event
   * IS that record's own deletion, so by the time any run recorded against
   * it could ever be retried, recordId is GUARANTEED to resolve to nothing,
   * every single time, not just occasionally the way it can for
   * record_created/field_equals. See recordSnapshot below, which is what
   * actually makes a "record_deleted" run retryable.
   */
  recordId: number | null;
  /**
   * Round 991: a JSON snapshot of the triggering record's own field values
   * at the moment this run fired -- null for every run except a
   * "record_deleted"-triggered one (the only trigger where recordId above
   * can never again resolve to a live row, so a retry has nothing else to
   * replay against), and still null for any "record_deleted" run recorded
   * before this column existed (additive-only migration, no backfill, same
   * convention as every other column here). Deliberately NOT captured for
   * record_created/field_equals runs -- their own retry re-fetching the
   * record's CURRENT state is intentional (recordId's own doc comment
   * above), and snapshotting every record-triggered run regardless of
   * trigger would store full record JSON for potentially high-volume rules
   * that never need it.
   */
  recordSnapshot: string | null;
  triggeredAt: string;
  /**
   * Round 1263: true only for a run fired by the manual "Test" button
   * (routes/projects.ts's POST .../test, schedule-rule branch) -- every
   * real caller (the scheduler itself, every record-triggered fire, and
   * the manual Retry route) leaves this false, exactly mirroring
   * recordAutomationRun's own `skipRuleSummaryUpdate` parameter, whose
   * value this column stores verbatim (see that parameter's own doc
   * comment for why it's true at exactly that one call site). Lets
   * hasTooManyConsecutiveFailuresToday (apps/api/src/automations.ts)
   * exclude Test-originated runs from the real scheduler's own daily
   * failure-pause cap -- without this, repeatedly Testing a rule while
   * debugging a real misconfiguration could trip that cap and silently
   * skip the rule's genuine scheduled send later the same day, even
   * after the real problem was fixed. False (not null) for any run
   * recorded before this column existed, since every one of those was
   * necessarily a pre-round-1261 run with no Test-vs-real distinction to
   * begin with, and false is the correct "count this toward the cap"
   * default for it either way.
   */
  isTest: boolean;
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
  // Round 948: additive-only, same discipline as automation_rules' own
  // scheduleTimeUtc/scheduleDaysOfWeek/webhookUrl column migrations just
  // below -- a table created before this round has no actionType column at
  // all. Stays nullable, no backfill: a pre-existing run's own actionType
  // at the time it fired is genuinely unknowable now.
  const runColumns = (db.prepare("PRAGMA table_info(automation_runs)").all() as { name: string }[]).map((c) => c.name);
  if (!runColumns.includes("actionType")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN actionType TEXT");
  }
  // Round 971: see AutomationRun's own doc comment on this column.
  if (!runColumns.includes("recordId")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN recordId INTEGER");
  }
  // Round 991: see AutomationRun's own doc comment on this column.
  if (!runColumns.includes("recordSnapshot")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN recordSnapshot TEXT");
  }
  // Round 1263: see AutomationRun.isTest's own doc comment.
  if (!runColumns.includes("isTest")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN isTest INTEGER");
  }
}

function rowToRun(row: Record<string, unknown>): AutomationRun {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    ruleId: row.ruleId as string,
    status: row.status as "sent" | "failed",
    error: (row.error as string | null) ?? null,
    actionType: (row.actionType as AutomationActionType | null) ?? null,
    recordId: (row.recordId as number | null) ?? null,
    recordSnapshot: (row.recordSnapshot as string | null) ?? null,
    triggeredAt: row.triggeredAt as string,
    isTest: row.isTest === 1,
  };
}

/**
 * listAutomationRuns' own default `limit` (AutomationsPanel's "History"
 * list never passes a different one), so a busy rule -- a daily
 * "schedule" trigger, or a "record_created"/"field_equals" rule on an
 * active entity -- accumulated one row per firing *forever* with nothing
 * ever reading past the most recent 20: pure unbounded growth for zero
 * benefit. Unlike whatsapp_messages and checkpoints (each of which at
 * least got a manual, user-initiated single-row delete --
 * deleteWhatsAppMessage, deleteCheckpoint), this table had no deletion
 * path at all short of deleting the whole rule or project. Matches
 * listAutomationRuns's own default exactly, so pruning to this cap can
 * never discard a row the History panel's own default view could still
 * see.
 *
 * Round 951: apps/api/src/automations.ts's own hasTooManyConsecutiveFailuresToday
 * (the round-924/934 scheduled-rule failure cap) now reads past this
 * default on purpose -- see recordAutomationRun's own doc comment just
 * below for why this single limit used to let an ordinary WhatsApp
 * disconnect quietly defeat that cap, and exported so that caller's own
 * lookback limit can stay derived from this one instead of an
 * independently-chosen number that could silently drift out of sync with
 * it.
 */
export const AUTOMATION_RUNS_RETENTION_LIMIT = 20;

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

/**
 * Round 971: a single run by id, scoped by projectId/ruleId the same way
 * every other per-rule lookup here is -- used by the manual Retry route
 * (apps/api/src/routes/projects.ts) to read the specific failed run's own
 * `recordId` before re-firing against that record's current state.
 */
export function getAutomationRun(db: ForgeDatabase, projectId: string, ruleId: string, runId: string): AutomationRun | undefined {
  const row = db.prepare("SELECT * FROM automation_runs WHERE projectId = ? AND ruleId = ? AND id = ?").get(projectId, ruleId, runId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : undefined;
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
  // Round 948: same additive-only convention as the three columns above --
  // pairs with lastTriggeredAt/lastStatus/lastError (see AutomationRule's
  // own doc comment on this column for why a live actionType reference
  // can't be trusted to translate a stale lastError).
  if (!columns.includes("lastActionType")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN lastActionType TEXT");
  }
  // Round 967: see AutomationRule's own doc comment on this column.
  if (!columns.includes("scheduleTimezone")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN scheduleTimezone TEXT");
  }
  // Round 974: see AutomationRule's own doc comment on this column.
  if (!columns.includes("webhookSecret")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN webhookSecret TEXT");
  }
  // Round 996: see AutomationRule's own doc comment on these two columns.
  if (!columns.includes("toEmail")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN toEmail TEXT");
  }
  if (!columns.includes("emailSubject")) {
    db.exec("ALTER TABLE automation_rules ADD COLUMN emailSubject TEXT");
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
    scheduleTimezone: (row.scheduleTimezone as string | null) ?? null,
    actionType: row.actionType as AutomationActionType,
    toMode: row.toMode as AutomationToMode,
    toNumber: (row.toNumber as string | null) ?? null,
    toField: (row.toField as string | null) ?? null,
    webhookUrl: (row.webhookUrl as string | null) ?? null,
    webhookSecret: (row.webhookSecret as string | null) ?? null,
    toEmail: (row.toEmail as string | null) ?? null,
    emailSubject: (row.emailSubject as string | null) ?? null,
    messageTemplate: row.messageTemplate as string,
    enabled: Boolean(row.enabled),
    lastTriggeredAt: (row.lastTriggeredAt as string | null) ?? null,
    lastStatus: (row.lastStatus as AutomationLastStatus) ?? null,
    lastError: (row.lastError as string | null) ?? null,
    lastActionType: (row.lastActionType as AutomationActionType | null) ?? null,
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
    scheduleTimezone?: string | null;
    actionType: AutomationActionType;
    toMode: AutomationToMode;
    toNumber?: string | null;
    toField?: string | null;
    webhookUrl?: string | null;
    webhookSecret?: string | null;
    toEmail?: string | null;
    emailSubject?: string | null;
    messageTemplate: string;
  },
): AutomationRule {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO automation_rules
       (id, projectId, entityName, trigger, fieldName, fieldValue, scheduleTimeUtc, scheduleDaysOfWeek, scheduleTimezone, actionType, toMode, toNumber, toField, webhookUrl, webhookSecret, toEmail, emailSubject, messageTemplate, enabled, lastTriggeredAt, lastStatus, lastError, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    rule.projectId,
    rule.entityName,
    rule.trigger,
    rule.fieldName ?? null,
    rule.fieldValue ?? null,
    rule.scheduleTimeUtc ?? null,
    rule.scheduleDaysOfWeek ?? null,
    rule.scheduleTimezone ?? null,
    rule.actionType,
    rule.toMode,
    rule.toNumber ?? null,
    rule.toField ?? null,
    rule.webhookUrl ?? null,
    rule.webhookSecret ?? null,
    rule.toEmail ?? null,
    rule.emailSubject ?? null,
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

// createdAt has only millisecond resolution, so two rules created in quick
// succession (e.g. two collaborators each adding one within the same
// millisecond, or a doubled "Save rule" click) can share the same value;
// ORDER BY createdAt ASC alone leaves that tie's order undefined --
// exactly the hazard checkpoints.ts/projects.ts's own listCheckpoints/
// listProjectsForUser already guard against with a rowid tiebreak, and
// this same file's own listAutomationRuns (above) already applies for
// automation_runs. rowid strictly increases with insertion order in this
// table (not declared WITHOUT ROWID), so `rowid ASC` breaks the tie
// deterministically in favor of "created first" -- exactly what "oldest
// first" means for a tie, matching this function's own ASC direction.
export function listAutomationRules(db: ForgeDatabase, projectId: string): AutomationRule[] {
  const rows = db
    .prepare("SELECT * FROM automation_rules WHERE projectId = ? ORDER BY createdAt ASC, rowid ASC")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToRule);
}

/**
 * Enabled rules scoped to one entity -- the hot-path list evaluated on
 * every record create/update (apps/api/src/automations.ts), kept to only
 * enabled rows so a disabled rule is never even considered a candidate.
 * Same rowid tiebreak as listAutomationRules above, for the same reason --
 * this is the order two tied rules actually fire in for the same record
 * change, not just a display-order cosmetic.
 */
export function listEnabledAutomationRulesForEntity(db: ForgeDatabase, projectId: string, entityName: string): AutomationRule[] {
  const rows = db
    .prepare("SELECT * FROM automation_rules WHERE projectId = ? AND entityName = ? AND enabled = 1 ORDER BY createdAt ASC, rowid ASC")
    .all(projectId, entityName) as Record<string, unknown>[];
  return rows.map(rowToRule);
}

/**
 * Every enabled schedule-trigger rule across EVERY project -- unlike
 * listEnabledAutomationRulesForEntity above, a schedule check has no
 * single record-change event to scope it to one entity/project, so the
 * periodic checker (apps/api/src/automations.ts's runScheduledAutomationsCheck)
 * evaluates this list globally on every tick instead. Same rowid tiebreak
 * as the two functions above, for the same reason.
 */
export function listEnabledScheduledRules(db: ForgeDatabase): AutomationRule[] {
  const rows = db
    .prepare("SELECT * FROM automation_rules WHERE trigger = 'schedule' AND enabled = 1 ORDER BY createdAt ASC, rowid ASC")
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
    scheduleTimezone: string | null;
    actionType: AutomationActionType;
    toMode: AutomationToMode;
    toNumber: string | null;
    toField: string | null;
    webhookUrl: string | null;
    webhookSecret: string | null;
    toEmail: string | null;
    emailSubject: string | null;
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
       entityName = ?, trigger = ?, fieldName = ?, fieldValue = ?, scheduleTimeUtc = ?, scheduleDaysOfWeek = ?, scheduleTimezone = ?, actionType = ?, toMode = ?, toNumber = ?, toField = ?, webhookUrl = ?, webhookSecret = ?, toEmail = ?, emailSubject = ?, messageTemplate = ?, enabled = ?, updatedAt = ?
     WHERE projectId = ? AND id = ?`,
  ).run(
    next.entityName,
    next.trigger,
    next.fieldName,
    next.fieldValue,
    next.scheduleTimeUtc,
    next.scheduleDaysOfWeek,
    next.scheduleTimezone,
    next.actionType,
    next.toMode,
    next.toNumber,
    next.toField,
    next.webhookUrl,
    next.webhookSecret,
    next.toEmail,
    next.emailSubject,
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
  // Round 948: optional, defaulting to null, specifically so every existing
  // caller that doesn't care about actionType-stale-error translation
  // (this module's own test suite, which fires runs against a bare
  // `{status, error}` with no rule context in hand) keeps working
  // unchanged. Every real caller in apps/api/src/automations.ts passes its
  // own rule.actionType explicitly -- see AutomationRun's own doc comment
  // for why this must be snapshotted per-run rather than read live off the
  // rule at render time.
  actionType: AutomationActionType | null = null,
  // Round 971: see AutomationRun's own doc comment on this column. Optional,
  // defaulting to null (every "schedule" rule's own call site, and this
  // module's own pre-round-971 test suite, correctly has no record to
  // reference at all).
  recordId: number | null = null,
  // Round 991: see AutomationRun's own doc comment on this column. Optional,
  // defaulting to null -- every caller except fireRule/fireWebhookAction's
  // own "record_deleted" branch has nothing to snapshot (either no record
  // at all, or a record_created/field_equals run that deliberately wants
  // its later retry to re-fetch current state instead).
  recordSnapshot: string | null = null,
  at: Date = new Date(),
  // Round 1165: fireWebhookAction (apps/api/src/automations.ts) needs the
  // exact id this run row ends up with BEFORE this function is called, so
  // it can include that same id in the outbound webhook payload itself
  // (as a delivery id a receiving system can use to deduplicate a manual
  // retry's resend from the original attempt) -- generating the id here,
  // after the POST has already gone out, made that impossible. Every
  // other caller doesn't need a specific id, so this stays optional and
  // defaults to a fresh one exactly like the inline randomUUID() call this
  // replaces.
  runId: string = randomUUID(),
  // Round 1261: a manual "Test" of a schedule-trigger rule
  // (apps/api/src/routes/projects.ts's POST .../test) fires it through
  // fireScheduledRule, the exact same path the real scheduler uses, so it
  // always reached here and unconditionally updated these same two
  // columns -- which isScheduledRuleDue (apps/api/src/automations.ts) then
  // reads to decide whether today's REAL scheduled occurrence has already
  // happened. A rule tested successfully in the morning looked "already
  // sent today" to the scheduler, silently skipping that day's actual
  // scheduled send -- directly contradicting Test's own stated purpose
  // (AutomationsPanel.tsx's doc comment: verify a rule "immediately
  // instead of waiting for... its own next due time", not replace that
  // occurrence). Defaults to false for every real caller (the scheduler
  // itself, every record-triggered fire, and the existing manual Retry
  // route, whose own round-972 design deliberately DOES want a successful
  // retry to count as today's send and un-pause the rest of the day's
  // ticks) -- only the Test route's own schedule-rule call site passes
  // true. The automation_runs history row below is still inserted exactly
  // as before regardless, so a test's outcome still shows up in the
  // rule's own run history, just without feeding back into whether the
  // real schedule still considers itself due.
  //
  // Round 1263: this same value is ALSO stored verbatim as the inserted
  // row's own isTest column (AutomationRun.isTest's own doc comment) --
  // it already means exactly "this run was fired by the manual Test
  // button" at every call site, which is exactly what
  // hasTooManyConsecutiveFailuresToday needs to exclude Test runs from
  // the real scheduler's own daily failure-pause cap, so no separate
  // parameter is needed.
  skipRuleSummaryUpdate: boolean = false,
): string {
  const now = at.toISOString();
  if (!skipRuleSummaryUpdate) {
    db.prepare(
      `UPDATE automation_rules SET lastTriggeredAt = ?, lastStatus = ?, lastError = ?, lastActionType = ? WHERE projectId = ? AND id = ?`,
    ).run(now, outcome.status, outcome.error ?? null, actionType, projectId, id);
  }
  // The rule row above stays a cheap, already-wired-up "most recent
  // outcome" summary; this is the actual history, inserted alongside it
  // rather than instead of it so no existing lastTriggeredAt/lastStatus/
  // lastError reader needs to change.
  db.prepare(
    `INSERT INTO automation_runs (id, projectId, ruleId, status, error, actionType, recordId, recordSnapshot, triggeredAt, isTest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, projectId, id, outcome.status, outcome.error ?? null, actionType, recordId, recordSnapshot, now, skipRuleSummaryUpdate ? 1 : 0);
  // Round 951: pruned in two independent buckets -- the newest
  // AUTOMATION_RUNS_RETENTION_LIMIT "WhatsApp is not connected" rows, and
  // the newest AUTOMATION_RUNS_RETENTION_LIMIT rows of everything else --
  // instead of one single top-N cut across both kinds at once. A scheduled
  // rule stays "due" (isScheduledRuleDue) for the rest of the day after any
  // failure, including a disconnect, so a single ordinary WhatsApp outage
  // (round 934's own "no auto-reconnect" reality) can genuinely produce one
  // disconnect row per minute for however long it lasts -- a single-bucket
  // top-20 cut let that volume alone evict a REAL failure recorded just
  // before the outage, with no trace left for
  // hasTooManyConsecutiveFailuresToday (apps/api/src/automations.ts) to
  // ever find again. That function's own round-934 doc comment already
  // claims it "looks further back... so enough genuine failures can still
  // be found even with disconnect runs interleaved among them" -- true of
  // its own in-memory filter, but pointless if the rows it would have
  // found were already gone from the table before that filter ever ran.
  // Splitting the prune into two buckets guarantees a disconnect flood of
  // any length can never evict a real row (and vice versa), so those real
  // rows are always still there for that function's own widened lookback
  // (see its own updated doc comment) to find.
  db.prepare(
    `DELETE FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error = ? AND id NOT IN (
      SELECT id FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error = ? ORDER BY triggeredAt DESC, rowid DESC LIMIT ?
    )`,
  ).run(projectId, id, WHATSAPP_NOT_CONNECTED_ERROR, projectId, id, WHATSAPP_NOT_CONNECTED_ERROR, AUTOMATION_RUNS_RETENTION_LIMIT);
  // Round 1032: mirrors the WhatsApp bucket just above, for
  // EMAIL_NOT_CONFIGURED_ERROR's own identical flood risk -- a send_email
  // schedule rule on a deployment with no RESEND_API_KEY set produces one
  // of these rows per tick, same as a WhatsApp disconnect, for however
  // long the misconfiguration lasts. Without its own bucket, that volume
  // fell into the catch-all "everything else" prune just below and could
  // evict a genuine failure the same way the pre-round-951 single bucket
  // once let a WhatsApp outage do.
  db.prepare(
    `DELETE FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error = ? AND id NOT IN (
      SELECT id FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error = ? ORDER BY triggeredAt DESC, rowid DESC LIMIT ?
    )`,
  ).run(projectId, id, EMAIL_NOT_CONFIGURED_ERROR, projectId, id, EMAIL_NOT_CONFIGURED_ERROR, AUTOMATION_RUNS_RETENTION_LIMIT);
  db.prepare(
    `DELETE FROM automation_runs WHERE projectId = ? AND ruleId = ? AND (error IS NULL OR (error != ? AND error != ?)) AND id NOT IN (
      SELECT id FROM automation_runs WHERE projectId = ? AND ruleId = ? AND (error IS NULL OR (error != ? AND error != ?)) ORDER BY triggeredAt DESC, rowid DESC LIMIT ?
    )`,
  ).run(
    projectId,
    id,
    WHATSAPP_NOT_CONNECTED_ERROR,
    EMAIL_NOT_CONFIGURED_ERROR,
    projectId,
    id,
    WHATSAPP_NOT_CONNECTED_ERROR,
    EMAIL_NOT_CONFIGURED_ERROR,
    AUTOMATION_RUNS_RETENTION_LIMIT,
  );
  return runId;
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
 * Mirrors apps/api/src/automations.ts's own interpolateTemplate placeholder
 * regex exactly (hand-duplicated rather than imported: apps/api depends on
 * this package, never the other way around, the same cross-package-boundary
 * duplication convention this codebase already uses for entityLabelOccurrences/
 * entityDisplayLabel across several consuming modules). Extracting every
 * placeholder name and checking set membership, rather than building a
 * per-field RegExp from untrusted interpolation, also sidesteps any regex-
 * injection risk from a field name containing a regex metacharacter.
 */
function templateReferencesField(template: string, fieldName: string): boolean {
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    if (match[1] === fieldName) return true;
  }
  return false;
}

/**
 * Called from diffAndMigrate for a field removed from a surviving entity.
 * A rule can reference a field three ways -- as the field_equals trigger's
 * own fieldName, as a toMode: "field" destination's toField, or as a
 * "{{fieldName}}" placeholder inside messageTemplate -- so all three are
 * checked. Round 961: the messageTemplate case was missing entirely --
 * unlike a trigger/toField reference to a since-removed field (which the
 * record routes that would fire it harmlessly 404 on via findEntity/
 * findField), interpolateTemplate (apps/api/src/automations.ts) fails OPEN
 * on a missing field: `record[fieldName]` is undefined once rowToRecord
 * stops copying a column no field in the current spec names (migrations
 * are additive-only, so the physical column survives, but EntityRecord
 * never gets a key for it), and interpolateTemplate's own replacer
 * function returns the literal unresolved "{{fieldName}}" text rather than
 * failing -- so a record_created/field_equals/record_deleted rule whose
 * trigger is on a DIFFERENT field, but whose messageTemplate names the
 * removed one, kept firing forever, recording a normal "sent" run while
 * actually sending "Hi Dana, your order {{orderId}} is ready!" to a real
 * WhatsApp contact, with zero warning anywhere. (Round 970: NOT a
 * "schedule" rule -- see this function's own messageTemplate-scan query
 * below for why that trigger is deliberately excluded from this specific
 * check.)
 *
 * Scoped by entityName too, the same way disableAutomationRulesForEntity
 * is, since fieldName/toField/a placeholder name are plain strings that
 * could otherwise coincide with an unrelated entity's own field of the
 * same name. Disables rather than deletes for the same restore-safety
 * reason as disableAutomationRulesForEntity above.
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
  const now = new Date().toISOString();
  const directResult = db
    .prepare("UPDATE automation_rules SET enabled = 0, updatedAt = ? WHERE projectId = ? AND entityName = ? AND enabled = 1 AND (fieldName = ? OR toField = ?)")
    .run(now, projectId, entityName, fieldName, fieldName);
  // A second, separate pass: only the rules the direct UPDATE above didn't
  // already catch (enabled = 1 still holds, since that update just ran)
  // need their messageTemplate inspected in JS -- SQLite has no portable
  // regex support to express "contains this placeholder, allowing internal
  // whitespace" directly in SQL.
  //
  // Round 970: excludes trigger = 'schedule' -- unlike every other trigger
  // type, a schedule rule's messageTemplate is never run through
  // interpolateTemplate at all (apps/api/src/automations.ts's
  // fireScheduledRule sends it to WhatsApp completely verbatim, and
  // fireWebhookAction's own entity/record-is-null branch for a schedule
  // rule does the identical pass-through for its webhook payload's
  // "message" field -- see either function's own doc comment). A
  // schedule rule's message can legally contain literal "{{...}}"-shaped
  // text (nothing in the UI prevents or warns against it once round 868
  // stopped advertising interpolation for this trigger) that was ALWAYS
  // sent as-is and stays exactly as-is regardless of which fields get
  // removed from the entity -- removing a field this text happens to
  // name changes nothing about what actually gets sent. Scanning it
  // anyway would silently disable a perfectly healthy scheduled
  // automation (a daily/weekly WhatsApp report, say) over an unrelated,
  // harmless field cleanup, with the UI only ever surfacing a generic "N
  // automation rule(s) disabled" migration hazard and no way to tell this
  // disable was spurious.
  // Round 999: emailSubject (round 996's own "send_email" column) is
  // interpolated completely independently of messageTemplate --
  // apps/api/src/automations.ts's fireEmailAction runs each of
  // emailSubject/messageTemplate through interpolateTemplate separately,
  // for the email's subject and body respectively -- so a "send_email"
  // rule whose {{field}} placeholder appears ONLY in its subject line (not
  // in messageTemplate, the body) was never caught by this sweep at all:
  // it stayed enabled and kept sending real emails with the literal,
  // unresolved "{{field}}" text baked into every subject, the exact
  // user-facing failure mode this whole function exists to prevent.
  const candidates = db
    .prepare("SELECT id, messageTemplate, emailSubject FROM automation_rules WHERE projectId = ? AND entityName = ? AND enabled = 1 AND trigger != 'schedule'")
    .all(projectId, entityName) as { id: string; messageTemplate: string; emailSubject: string | null }[];
  const templateMatchIds = candidates
    .filter((r) => templateReferencesField(r.messageTemplate, fieldName) || (r.emailSubject != null && templateReferencesField(r.emailSubject, fieldName)))
    .map((r) => r.id);
  for (const id of templateMatchIds) {
    db.prepare("UPDATE automation_rules SET enabled = 0, updatedAt = ? WHERE id = ?").run(now, id);
  }
  return Number(directResult.changes) + templateMatchIds.length;
}
