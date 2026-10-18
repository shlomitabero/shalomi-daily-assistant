import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";
import {
  deleteAutomationRule,
  deleteAutomationRulesForProject,
  deleteAutomationRunsForRule,
  deleteAutomationRunsForProject,
  ensureAutomationRulesTable,
  ensureAutomationRunsTable,
  getAutomationRule,
  insertAutomationRule,
  listAutomationRules,
  listAutomationRuns,
  listEnabledAutomationRulesForEntity,
  listEnabledScheduledRules,
  recordAutomationRun,
  updateAutomationRule,
} from "./automations.js";

function baseRule(overrides: Partial<Parameters<typeof insertAutomationRule>[1]> = {}) {
  return {
    projectId: "proj1",
    entityName: "Order",
    trigger: "field_equals" as const,
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp" as const,
    toMode: "field" as const,
    toField: "customerPhone",
    messageTemplate: "Hi {{customerName}}, your order shipped!",
    ...overrides,
  };
}

test("insertAutomationRule stores the rule and returns it with generated id/timestamps/defaults", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  assert.ok(rule.id);
  assert.equal(rule.projectId, "proj1");
  assert.equal(rule.entityName, "Order");
  assert.equal(rule.trigger, "field_equals");
  assert.equal(rule.fieldName, "status");
  assert.equal(rule.fieldValue, "Delivered");
  assert.equal(rule.toMode, "field");
  assert.equal(rule.toField, "customerPhone");
  assert.equal(rule.toNumber, null);
  assert.equal(rule.enabled, true);
  assert.equal(rule.lastTriggeredAt, null);
  assert.equal(rule.lastStatus, null);
  assert.ok(rule.createdAt);
  assert.ok(rule.updatedAt);
});

test("insertAutomationRule supports a record_created trigger with no field/value", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(
    db,
    baseRule({ trigger: "record_created", fieldName: null, fieldValue: null, toMode: "static", toField: null, toNumber: "972501234567" }),
  );
  assert.equal(rule.trigger, "record_created");
  assert.equal(rule.fieldName, null);
  assert.equal(rule.toMode, "static");
  assert.equal(rule.toNumber, "972501234567");
});

test("getAutomationRule returns undefined for an id that doesn't exist, and scopes by projectId", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  assert.equal(getAutomationRule(db, "proj1", "nonexistent"), undefined);
  // Same id, wrong project -- must not leak across projects.
  assert.equal(getAutomationRule(db, "other-project", rule.id), undefined);
  assert.deepEqual(getAutomationRule(db, "proj1", rule.id), rule);
});

test("listAutomationRules returns only this project's rules, in creation order", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const a = insertAutomationRule(db, baseRule({ entityName: "Order" }));
  const b = insertAutomationRule(db, baseRule({ entityName: "Ticket" }));
  insertAutomationRule(db, baseRule({ projectId: "other-project" }));
  const rules = listAutomationRules(db, "proj1");
  assert.deepEqual(
    rules.map((r) => r.id),
    [a.id, b.id],
  );
});

test("listEnabledAutomationRulesForEntity excludes disabled rules and other entities", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const enabled = insertAutomationRule(db, baseRule({ entityName: "Order" }));
  const disabled = insertAutomationRule(db, baseRule({ entityName: "Order" }));
  updateAutomationRule(db, "proj1", disabled.id, { enabled: false });
  insertAutomationRule(db, baseRule({ entityName: "Ticket" }));
  const rules = listEnabledAutomationRulesForEntity(db, "proj1", "Order");
  assert.deepEqual(
    rules.map((r) => r.id),
    [enabled.id],
  );
});

test("updateAutomationRule patches only the given fields and bumps updatedAt", async () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  await new Promise((r) => setTimeout(r, 2));
  const updated = updateAutomationRule(db, "proj1", rule.id, { fieldValue: "Cancelled", enabled: false });
  assert.equal(updated.fieldValue, "Cancelled");
  assert.equal(updated.enabled, false);
  // Untouched fields keep their original value.
  assert.equal(updated.fieldName, "status");
  assert.equal(updated.messageTemplate, rule.messageTemplate);
  assert.notEqual(updated.updatedAt, rule.updatedAt);
});

test("updateAutomationRule throws NotFoundError for a rule that doesn't exist", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  assert.throws(() => updateAutomationRule(db, "proj1", "nonexistent", { enabled: false }), NotFoundError);
});

test("recordAutomationRun stamps lastTriggeredAt/lastStatus/lastError, and silently no-ops for a deleted rule", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });
  const afterSent = getAutomationRule(db, "proj1", rule.id)!;
  assert.ok(afterSent.lastTriggeredAt);
  assert.equal(afterSent.lastStatus, "sent");
  assert.equal(afterSent.lastError, null);

  recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "WhatsApp not connected" });
  const afterFailed = getAutomationRule(db, "proj1", rule.id)!;
  assert.equal(afterFailed.lastStatus, "failed");
  assert.equal(afterFailed.lastError, "WhatsApp not connected");

  // Must not throw for an id that no longer exists -- this runs from
  // fire-and-forget background code, never on a user-facing request path.
  assert.doesNotThrow(() => recordAutomationRun(db, "proj1", "nonexistent", { status: "sent" }));
});

test("deleteAutomationRule removes the row and throws NotFoundError for a second delete", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  deleteAutomationRule(db, "proj1", rule.id);
  assert.equal(getAutomationRule(db, "proj1", rule.id), undefined);
  assert.throws(() => deleteAutomationRule(db, "proj1", rule.id), NotFoundError);
});

test("deleteAutomationRule scoped to projectId -- cannot delete another project's rule by id", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  assert.throws(() => deleteAutomationRule(db, "some-other-project", rule.id), NotFoundError);
  assert.ok(getAutomationRule(db, "proj1", rule.id));
});

test("deleteAutomationRulesForProject wipes every rule for that project only", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  insertAutomationRule(db, baseRule({ projectId: "proj1" }));
  insertAutomationRule(db, baseRule({ projectId: "proj1", entityName: "Ticket" }));
  const otherRule = insertAutomationRule(db, baseRule({ projectId: "proj2" }));
  deleteAutomationRulesForProject(db, "proj1");
  assert.deepEqual(listAutomationRules(db, "proj1"), []);
  assert.ok(getAutomationRule(db, "proj2", otherRule.id));
});

/**
 * New in this round: a rule's lastTriggeredAt/lastStatus/lastError only
 * ever reflected the single most recent firing -- a rule that failed
 * repeatedly and then happened to succeed on its latest attempt looked
 * perfectly healthy, with no way to tell it had been flaky. recordAutomationRun
 * now also inserts into the new automation_runs table (ensureAutomationRunsTable
 * is called automatically from ensureAutomationRulesTable, so every
 * existing call site gets it without having to learn about a second
 * function), and listAutomationRuns returns the real run-by-run history,
 * newest first.
 */
test("recordAutomationRun also inserts a row into automation_runs, and listAutomationRuns returns every run newest-first", async () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());

  recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "WhatsApp not connected" });
  await new Promise((r) => setTimeout(r, 2));
  recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "WhatsApp not connected" });
  await new Promise((r) => setTimeout(r, 2));
  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });

  const runs = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(runs.length, 3, "every individual firing must be kept, not just the latest");
  assert.deepEqual(
    runs.map((r) => r.status),
    ["sent", "failed", "failed"],
    "must be ordered newest-first, so a rule that just failed twice in a row is visible even though its latest attempt succeeded",
  );
  assert.equal(runs[1].error, "WhatsApp not connected");
  assert.equal(runs[0].error, null);
  for (const run of runs) {
    assert.equal(run.ruleId, rule.id);
    assert.equal(run.projectId, "proj1");
  }
});

test("listAutomationRuns is scoped to one rule and one project, and caps at its own limit", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const ruleA = insertAutomationRule(db, baseRule());
  const ruleB = insertAutomationRule(db, baseRule({ entityName: "Ticket" }));
  recordAutomationRun(db, "proj1", ruleA.id, { status: "sent" });
  recordAutomationRun(db, "proj1", ruleB.id, { status: "sent" });
  assert.equal(listAutomationRuns(db, "proj1", ruleA.id).length, 1);
  assert.equal(listAutomationRuns(db, "proj1", ruleB.id).length, 1);
  assert.deepEqual(listAutomationRuns(db, "proj1", "nonexistent-rule"), []);

  for (let i = 0; i < 25; i++) recordAutomationRun(db, "proj1", ruleA.id, { status: "sent" });
  assert.equal(listAutomationRuns(db, "proj1", ruleA.id, 20).length, 20, "must cap at the given limit, not return every run ever fired");
});

test("deleteAutomationRule also wipes that rule's own run history", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });
  deleteAutomationRule(db, "proj1", rule.id);
  assert.deepEqual(listAutomationRuns(db, "proj1", rule.id), []);
});

test("deleteAutomationRulesForProject also wipes every one of that project's runs, leaving other projects' untouched", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ projectId: "proj1" }));
  const otherRule = insertAutomationRule(db, baseRule({ projectId: "proj2" }));
  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });
  recordAutomationRun(db, "proj2", otherRule.id, { status: "sent" });
  deleteAutomationRulesForProject(db, "proj1");
  assert.deepEqual(listAutomationRuns(db, "proj1", rule.id), []);
  assert.equal(listAutomationRuns(db, "proj2", otherRule.id).length, 1, "another project's run history must survive");
});

test("ensureAutomationRunsTable is idempotent and standalone, and deleteAutomationRunsForRule/deleteAutomationRunsForProject work directly", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRunsTable(db);
  assert.doesNotThrow(() => ensureAutomationRunsTable(db));
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });
  deleteAutomationRunsForRule(db, "proj1", rule.id);
  assert.deepEqual(listAutomationRuns(db, "proj1", rule.id), []);

  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });
  deleteAutomationRunsForProject(db, "proj1");
  assert.deepEqual(listAutomationRuns(db, "proj1", rule.id), []);
});

test("insertAutomationRule supports a schedule trigger with no triggering field, storing scheduleTimeUtc/scheduleDaysOfWeek", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(
    db,
    baseRule({
      trigger: "schedule",
      fieldName: null,
      fieldValue: null,
      scheduleTimeUtc: "09:00",
      scheduleDaysOfWeek: "1,3,5",
      toMode: "static",
      toField: null,
      toNumber: "972501234567",
    }),
  );
  assert.equal(rule.trigger, "schedule");
  assert.equal(rule.scheduleTimeUtc, "09:00");
  assert.equal(rule.scheduleDaysOfWeek, "1,3,5");
  assert.equal(rule.fieldName, null);
});

test("insertAutomationRule leaves scheduleTimeUtc/scheduleDaysOfWeek null when not given, for a non-schedule rule", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  assert.equal(rule.scheduleTimeUtc, null);
  assert.equal(rule.scheduleDaysOfWeek, null);
});

test("updateAutomationRule can set and clear scheduleTimeUtc/scheduleDaysOfWeek", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(
    db,
    baseRule({ trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "09:00", scheduleDaysOfWeek: null, toMode: "static", toField: null, toNumber: "972501234567" }),
  );
  const updated = updateAutomationRule(db, "proj1", rule.id, { scheduleTimeUtc: "17:30", scheduleDaysOfWeek: "0,6" });
  assert.equal(updated.scheduleTimeUtc, "17:30");
  assert.equal(updated.scheduleDaysOfWeek, "0,6");
  const cleared = updateAutomationRule(db, "proj1", rule.id, { scheduleDaysOfWeek: null });
  assert.equal(cleared.scheduleDaysOfWeek, null, "clearing scheduleDaysOfWeek (back to 'every day') must actually null the column, not leave the previous value");
});

/**
 * Mirrors checkpoints.test.ts's own "old-shape table, run the migration,
 * confirm it backfills without disturbing existing rows, and is idempotent
 * on a second run" pattern -- automation_rules gets the identical
 * additive-only ALTER TABLE ADD COLUMN treatment for scheduleTimeUtc/
 * scheduleDaysOfWeek (see ensureAutomationRulesTable's own comment), so a
 * database created by a version of this app before this round must not
 * break when it next starts up.
 */
test("ensureAutomationRulesTable adds scheduleTimeUtc/scheduleDaysOfWeek to a pre-existing table from an older app version, leaving existing rows intact, and is idempotent", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE automation_rules (
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
  db.prepare(
    `INSERT INTO automation_rules (id, projectId, entityName, trigger, fieldName, fieldValue, actionType, toMode, toNumber, toField, messageTemplate, enabled, createdAt, updatedAt)
     VALUES ('old-rule', 'proj1', 'Order', 'field_equals', 'status', 'Delivered', 'send_whatsapp', 'field', NULL, 'customerPhone', 'Hi!', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();

  ensureAutomationRulesTable(db);

  const oldRule = getAutomationRule(db, "proj1", "old-rule")!;
  assert.equal(oldRule.scheduleTimeUtc, null);
  assert.equal(oldRule.scheduleDaysOfWeek, null);
  assert.equal(oldRule.fieldName, "status", "the migration must not disturb an existing row's other columns");

  // Running it again (every app startup) must stay a no-op.
  assert.doesNotThrow(() => ensureAutomationRulesTable(db));
  assert.equal(getAutomationRule(db, "proj1", "old-rule")!.fieldName, "status");
});

test("listEnabledScheduledRules returns only enabled schedule-trigger rules, across every project", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const due = insertAutomationRule(
    db,
    baseRule({ projectId: "proj1", trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "09:00", toMode: "static", toField: null, toNumber: "1" }),
  );
  insertAutomationRule(
    db,
    baseRule({ projectId: "proj2", trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "10:00", toMode: "static", toField: null, toNumber: "2" }),
  );
  const disabledSchedule = insertAutomationRule(
    db,
    baseRule({ projectId: "proj1", trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "11:00", toMode: "static", toField: null, toNumber: "3" }),
  );
  updateAutomationRule(db, "proj1", disabledSchedule.id, { enabled: false });
  insertAutomationRule(db, baseRule({ projectId: "proj1", trigger: "field_equals" })); // not a schedule rule at all

  const rules = listEnabledScheduledRules(db);
  assert.equal(rules.length, 2, "exactly the two enabled schedule rules, across both projects, excluding the disabled one and the non-schedule one");
  assert.ok(rules.some((r) => r.id === due.id));
  assert.ok(rules.some((r) => r.projectId === "proj2"));
  assert.ok(!rules.some((r) => r.id === disabledSchedule.id));
  assert.ok(rules.every((r) => r.trigger === "schedule" && r.enabled));
});

test("insertAutomationRule supports actionType 'webhook' with a webhookUrl, and leaves it null for a send_whatsapp rule", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const webhookRule = insertAutomationRule(
    db,
    baseRule({ actionType: "webhook", webhookUrl: "https://example.com/hook", toField: null, toNumber: null }),
  );
  assert.equal(webhookRule.actionType, "webhook");
  assert.equal(webhookRule.webhookUrl, "https://example.com/hook");

  const whatsappRule = insertAutomationRule(db, baseRule());
  assert.equal(whatsappRule.webhookUrl, null);
});

test("updateAutomationRule can switch a rule's actionType and set/clear webhookUrl", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  const switched = updateAutomationRule(db, "proj1", rule.id, { actionType: "webhook", webhookUrl: "https://example.com/hook" });
  assert.equal(switched.actionType, "webhook");
  assert.equal(switched.webhookUrl, "https://example.com/hook");

  const clearedBack = updateAutomationRule(db, "proj1", rule.id, { actionType: "send_whatsapp", webhookUrl: null });
  assert.equal(clearedBack.actionType, "send_whatsapp");
  assert.equal(clearedBack.webhookUrl, null);
});

/** Mirrors the identical additive-migration test for scheduleTimeUtc/scheduleDaysOfWeek above, for the webhookUrl column. */
test("ensureAutomationRulesTable adds webhookUrl to a pre-existing table from an older app version, leaving existing rows intact, and is idempotent", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE automation_rules (
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
  db.prepare(
    `INSERT INTO automation_rules (id, projectId, entityName, trigger, fieldName, fieldValue, actionType, toMode, toNumber, toField, messageTemplate, enabled, createdAt, updatedAt)
     VALUES ('old-rule', 'proj1', 'Order', 'field_equals', 'status', 'Delivered', 'send_whatsapp', 'field', NULL, 'customerPhone', 'Hi!', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();

  ensureAutomationRulesTable(db);

  const oldRule = getAutomationRule(db, "proj1", "old-rule")!;
  assert.equal(oldRule.webhookUrl, null);
  assert.equal(oldRule.fieldName, "status", "the migration must not disturb an existing row's other columns");

  assert.doesNotThrow(() => ensureAutomationRulesTable(db));
  assert.equal(getAutomationRule(db, "proj1", "old-rule")!.fieldName, "status");
});
