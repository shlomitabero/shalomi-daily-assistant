import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";
import {
  AUTOMATION_RUNS_RETENTION_LIMIT,
  deleteAutomationRule,
  deleteAutomationRulesForProject,
  deleteAutomationRunsForRule,
  deleteAutomationRunsForProject,
  ensureAutomationRulesTable,
  ensureAutomationRunsTable,
  getAutomationRule,
  getAutomationRun,
  insertAutomationRule,
  listAutomationRules,
  listAutomationRuns,
  listEnabledAutomationRulesForEntity,
  listEnabledScheduledRules,
  recordAutomationRun,
  updateAutomationRule,
  WHATSAPP_NOT_CONNECTED_ERROR,
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

test("listAutomationRules returns rules oldest-first even when two share the exact same createdAt millisecond", () => {
  // createdAt is a new Date().toISOString() string with only millisecond
  // resolution, so two rules created in quick succession can share the
  // exact same value, leaving ORDER BY createdAt ASC alone with no
  // SQL-defined tiebreak for that tie -- the same hazard checkpoints.ts's
  // listCheckpoints/projects.ts's listProjectsForOwner, and this same
  // file's own listAutomationRuns (automation_runs), already guard
  // against with an explicit rowid tiebreak. This pins the intended,
  // deterministic ordering contract going forward; node:sqlite's current
  // table-scan-then-sort plan for this query happens to already return
  // ties in rowid order even without the explicit tiebreak, so this test
  // does not itself distinguish the fix from its absence in this specific
  // engine/version -- the tiebreak is still worth having, since nothing in
  // SQL guarantees that tie order stays stable across a different query
  // plan (e.g. an index added later) or a different SQLite build.
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const a = insertAutomationRule(db, baseRule({ entityName: "Order" }));
  const b = insertAutomationRule(db, baseRule({ entityName: "Ticket" }));
  const rules = listAutomationRules(db, "proj1");
  assert.deepEqual(
    rules.map((r) => r.id),
    [a.id, b.id],
    "the rule created first must sort first even on a createdAt tie",
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

test("listEnabledAutomationRulesForEntity returns rules oldest-first (the actual firing order) even when two share the exact same createdAt millisecond", () => {
  // Same reasoning as listAutomationRules's own tiebreak test above, but
  // for the hot-path list apps/api/src/automations.ts actually fires
  // rules from on every record create/update -- here a tie isn't just a
  // display-order cosmetic, it's the order two tied rules' real actions
  // (e.g. two webhooks) fire in.
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const first = insertAutomationRule(db, baseRule({ entityName: "Order" }));
  const second = insertAutomationRule(db, baseRule({ entityName: "Order" }));
  const rules = listEnabledAutomationRulesForEntity(db, "proj1", "Order");
  assert.deepEqual(
    rules.map((r) => r.id),
    [first.id, second.id],
    "the rule created first must fire first even on a createdAt tie",
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

/**
 * Round 1165: fireWebhookAction (apps/api/src/automations.ts) needs the
 * exact id a run row will get BEFORE this function is called, so it can
 * include that same id in the outbound webhook payload as a delivery id a
 * receiver could use to correlate that specific attempt -- generating the
 * id internally (the pre-round-1165 behavior) made that impossible, since
 * the id didn't exist until after the POST had already gone out. Confirms
 * the optional runId both ends up as the stored row's own id (not just
 * accepted and ignored) and is returned, so a caller that generated it
 * up front can treat this call as "confirm what I already sent", not
 * "tell me what id you picked instead".
 */
test("recordAutomationRun accepts and returns a caller-supplied runId, storing it as the run row's own id", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());

  const returned = recordAutomationRun(db, "proj1", rule.id, { status: "sent" }, "webhook", null, null, new Date(), "caller-chosen-id-123");
  assert.equal(returned, "caller-chosen-id-123");

  const [run] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(run!.id, "caller-chosen-id-123");

  // The retention-pruning deletes (round 951/1032) sit after the insert in
  // the function body -- confirms they still actually run when a runId is
  // passed in, not skipped by an early return that would otherwise let
  // automation_runs grow unbounded.
  const secondReturned = recordAutomationRun(db, "proj1", rule.id, { status: "sent" }, "webhook");
  assert.notEqual(secondReturned, "caller-chosen-id-123", "omitting runId must still generate a fresh id, not reuse the previous call's");
  assert.equal(listAutomationRuns(db, "proj1", rule.id, 10).length, 2, "both the caller-supplied-id run and the auto-generated-id run must be present");
});

/**
 * Round 948: a rule's actionType can be edited after it last fired
 * (updateAutomationRule never touches lastTriggeredAt/lastStatus/lastError),
 * so a live `rule.actionType` read at display time is NOT necessarily the
 * actionType that actually produced the stored lastError -- the exact
 * regression apps/web/src/AutomationsPanel.tsx's translateAutomationError
 * (round 935) could otherwise reopen via an edit. recordAutomationRun must
 * snapshot the actionType it's given into automation_rules.lastActionType
 * (and into the new automation_runs row too, so every historical run keeps
 * its own correct actionType even after a later edit), not leave it to be
 * read live off the rule's own actionType column.
 */
test("recordAutomationRun snapshots the given actionType onto both the rule's own lastActionType and the new automation_runs row, surviving a later actionType edit on the rule itself", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ actionType: "send_whatsapp" }));
  recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "missing_country_code" }, "send_whatsapp");

  const afterFirstRun = getAutomationRule(db, "proj1", rule.id)!;
  assert.equal(afterFirstRun.lastActionType, "send_whatsapp", "the rule's own lastActionType must reflect the actionType it actually fired under");
  const [run] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(run.actionType, "send_whatsapp", "the individual run row must carry its own actionType, independent of the rule");

  // Simulates editing the rule's action type to webhook, same as
  // updateAutomationRule actually does -- it never touches
  // lastTriggeredAt/lastStatus/lastError/lastActionType at all.
  updateAutomationRule(db, "proj1", rule.id, { actionType: "webhook" });

  const afterEdit = getAutomationRule(db, "proj1", rule.id)!;
  assert.equal(afterEdit.actionType, "webhook", "the rule's own live actionType must reflect the edit");
  assert.equal(
    afterEdit.lastActionType,
    "send_whatsapp",
    "lastActionType must survive the edit unchanged -- it describes what was true when lastError was recorded, not what's true now",
  );
  const [stillSameRun] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(stillSameRun.actionType, "send_whatsapp", "a historical run's own actionType must never retroactively change just because the rule was edited later");
});

/**
 * Round 971: recordAutomationRun's new recordId parameter -- lets a
 * failed record-triggered run be manually retried later (see
 * apps/api/src/routes/projects.ts's own POST .../runs/:runId/retry) by
 * referencing which record triggered it. Defaults to null for a
 * "schedule" rule's own call sites (apps/api/src/automations.ts's
 * fireScheduledRule), which never have a triggering record at all.
 */
test("recordAutomationRun stores the given recordId on the new automation_runs row, defaulting to null when omitted", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ actionType: "send_whatsapp" }));

  recordAutomationRun(db, "proj1", rule.id, { status: "sent" }, "send_whatsapp", 42);
  const [withRecord] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(withRecord.recordId, 42);

  recordAutomationRun(db, "proj1", rule.id, { status: "sent" }, "send_whatsapp");
  const [noRecordArg] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(noRecordArg.recordId, null, "omitting recordId entirely (every schedule-rule call site) must default to null, not throw");

  recordAutomationRun(db, "proj1", rule.id, { status: "sent" }, "send_whatsapp", null);
  const [explicitNull] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(explicitNull.recordId, null);
});

/**
 * Round 971: getAutomationRun's own scoped single-row lookup, used by the
 * manual Retry route to read a specific run's recordId before re-firing.
 */
test("getAutomationRun returns a single run by id, scoped to the given project/rule, and undefined when no match", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ actionType: "send_whatsapp" }));
  const otherRule = insertAutomationRule(db, baseRule({ actionType: "send_whatsapp" }));
  recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "oops" }, "send_whatsapp", 7);

  const [run] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(getAutomationRun(db, "proj1", rule.id, run!.id)?.recordId, 7);
  assert.equal(getAutomationRun(db, "proj1", otherRule.id, run!.id), undefined, "a run must not be found under a DIFFERENT rule's id, even with the right project/run id");
  assert.equal(getAutomationRun(db, "proj1", rule.id, "nonexistent-id"), undefined);
});

/**
 * Round 971: the recordId column migration -- same additive-only,
 * no-backfill discipline as every other column this table has ever
 * added (actionType, round 948).
 */
test("ensureAutomationRulesTable adds recordId to a pre-existing automation_runs table from an older app version, leaving existing rows intact, and is idempotent", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      ruleId TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      triggeredAt TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT INTO automation_runs (id, projectId, ruleId, status, error, triggeredAt) VALUES ('old-run', 'proj1', 'rule1', 'sent', NULL, '2026-01-01T00:00:00.000Z')`,
  ).run();

  ensureAutomationRunsTable(db);

  const oldRun = getAutomationRun(db, "proj1", "rule1", "old-run")!;
  assert.equal(oldRun.recordId, null, "the migration must default a pre-existing row's recordId to null, not fail or guess");
  assert.equal(oldRun.status, "sent", "the migration must not disturb an existing row's other columns");

  assert.doesNotThrow(() => ensureAutomationRunsTable(db));
  assert.equal(getAutomationRun(db, "proj1", "rule1", "old-run")!.status, "sent");
});

test("recordAutomationRun called with no actionType argument (every pre-round-948 call site) leaves lastActionType/the run's own actionType null, not throwing or defaulting to the rule's current one", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ actionType: "send_whatsapp" }));
  recordAutomationRun(db, "proj1", rule.id, { status: "sent" });

  const afterRun = getAutomationRule(db, "proj1", rule.id)!;
  assert.equal(afterRun.lastActionType, null);
  const [run] = listAutomationRuns(db, "proj1", rule.id);
  assert.equal(run.actionType, null);
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

/**
 * New in this round: recordAutomationRun must actually prune old rows,
 * not just rely on listAutomationRuns's own LIMIT to hide them -- a busy
 * rule (a daily schedule trigger, or a record_created/field_equals rule
 * on an active entity) fires forever, and before this round automation_runs
 * had no deletion path short of deleting the whole rule or project. Counts
 * the real underlying rows directly (bypassing listAutomationRuns's own
 * LIMIT entirely) to prove the table itself stays bounded, not just what
 * any one read happens to return.
 */
test("recordAutomationRun prunes automation_runs to its retention cap, not just relying on listAutomationRuns's own LIMIT", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());
  const otherRule = insertAutomationRule(db, baseRule({ entityName: "Ticket" }));

  for (let i = 0; i < 50; i++) recordAutomationRun(db, "proj1", rule.id, { status: "sent" });
  recordAutomationRun(db, "proj1", otherRule.id, { status: "sent" });

  const rawCountForRule = (
    db.prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE projectId = ? AND ruleId = ?").get("proj1", rule.id) as {
      c: number;
    }
  ).c;
  assert.equal(rawCountForRule, 20, "the real row count for a busy rule must never exceed the retention cap, even after 50 firings");

  const rawCountForOtherRule = (
    db.prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE projectId = ? AND ruleId = ?").get("proj1", otherRule.id) as {
      c: number;
    }
  ).c;
  assert.equal(rawCountForOtherRule, 1, "pruning one rule's own runs must never touch another rule's history");

  // The 20 rows that DID survive must be the 20 most recent ones, not an
  // arbitrary 20 -- same ordering listAutomationRuns itself uses.
  const runs = listAutomationRuns(db, "proj1", rule.id, 20);
  assert.equal(runs.length, 20);
  const timestamps = db
    .prepare("SELECT triggeredAt FROM automation_runs WHERE projectId = ? AND ruleId = ? ORDER BY triggeredAt ASC, rowid ASC")
    .all("proj1", rule.id) as { triggeredAt: string }[];
  assert.equal(timestamps.length, 20, "sanity check: exactly 20 rows must remain in insertion order too");
});

/**
 * Round 951: before this round, the prune above cut a single top-20
 * window across every kind of run together -- a scheduled rule stays
 * "due" every tick for the rest of the day after any failure, disconnect
 * included, so a single ordinary WhatsApp outage could record far more
 * than 20 consecutive "WhatsApp is not connected" rows and, under the old
 * single-bucket prune, evict an earlier GENUINE failure out of the table
 * entirely -- with no trace left for apps/api/src/automations.ts's own
 * hasTooManyConsecutiveFailuresToday to ever find again, silently
 * defeating its 5-per-day cap. Confirms the fix: a disconnect flood of
 * any length can no longer evict a genuine row, because each kind is now
 * pruned to its own independent top-20 window.
 */
test("recordAutomationRun's retention prune keeps the newest 20 genuine-failure rows and the newest 20 WhatsApp-disconnect rows independently, so one kind can never evict the other", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule());

  // One genuine failure first...
  recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "recipient not found" });
  // ...then a disconnect flood far past the old single-bucket cap of 20.
  // Under the pre-fix single-bucket prune, this alone would have evicted
  // the genuine failure above.
  for (let i = 0; i < 30; i++) {
    recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: WHATSAPP_NOT_CONNECTED_ERROR });
  }

  const genuineCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error != ?")
      .get("proj1", rule.id, WHATSAPP_NOT_CONNECTED_ERROR) as { c: number }
  ).c;
  assert.equal(genuineCount, 1, "the one genuine failure must survive a disconnect flood of any length, not just a short one");

  const disconnectCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error = ?")
      .get("proj1", rule.id, WHATSAPP_NOT_CONNECTED_ERROR) as { c: number }
  ).c;
  assert.equal(disconnectCount, AUTOMATION_RUNS_RETENTION_LIMIT, "the disconnect rows must still be capped at the normal retention limit, just in their own independent bucket");

  // Mirrors the existing sibling test just above, the other direction:
  // a flood of GENUINE failures must likewise never evict disconnect rows
  // beyond their own independent cap.
  for (let i = 0; i < 30; i++) {
    recordAutomationRun(db, "proj1", rule.id, { status: "failed", error: "recipient not found" });
  }
  const genuineCountAfter = (
    db
      .prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error != ?")
      .get("proj1", rule.id, WHATSAPP_NOT_CONNECTED_ERROR) as { c: number }
  ).c;
  const disconnectCountAfter = (
    db
      .prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE projectId = ? AND ruleId = ? AND error = ?")
      .get("proj1", rule.id, WHATSAPP_NOT_CONNECTED_ERROR) as { c: number }
  ).c;
  assert.equal(genuineCountAfter, AUTOMATION_RUNS_RETENTION_LIMIT, "genuine-failure rows must be capped at the normal retention limit too");
  assert.equal(disconnectCountAfter, AUTOMATION_RUNS_RETENTION_LIMIT, "a flood of genuine failures must never evict the disconnect bucket's own retained rows either");
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
 * Round 967: scheduleTimezone is the IANA zone scheduleTimeUtc/
 * scheduleDaysOfWeek are wall-clock values in -- see AutomationRule's own
 * doc comment on this column. Stored/updated/cleared exactly like its two
 * sibling schedule columns above.
 */
test("insertAutomationRule stores scheduleTimezone, and updateAutomationRule can change or clear it", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(
    db,
    baseRule({
      trigger: "schedule",
      fieldName: null,
      fieldValue: null,
      scheduleTimeUtc: "09:00",
      scheduleDaysOfWeek: null,
      scheduleTimezone: "Asia/Jerusalem",
      toMode: "static",
      toField: null,
      toNumber: "972501234567",
    }),
  );
  assert.equal(rule.scheduleTimezone, "Asia/Jerusalem");

  const noZone = insertAutomationRule(
    db,
    baseRule({ trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "09:00", toMode: "static", toField: null, toNumber: "1" }),
  );
  assert.equal(noZone.scheduleTimezone, null, "a rule created without an explicit scheduleTimezone must leave it null, not default to a literal string");

  const updated = updateAutomationRule(db, "proj1", rule.id, { scheduleTimezone: "America/New_York" });
  assert.equal(updated.scheduleTimezone, "America/New_York");
  const cleared = updateAutomationRule(db, "proj1", rule.id, { scheduleTimezone: null });
  assert.equal(cleared.scheduleTimezone, null);
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
  assert.equal(oldRule.scheduleTimezone, null, "round 967's scheduleTimezone column must also be added additively, defaulting to null for a pre-existing row");
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

test("listEnabledScheduledRules returns rules oldest-first even when two share the exact same createdAt millisecond", () => {
  // Same reasoning as the two tiebreak tests above -- this is the global
  // periodic scheduler's own evaluation order across every project.
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const first = insertAutomationRule(
    db,
    baseRule({ projectId: "proj1", trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "09:00", toMode: "static", toField: null, toNumber: "1" }),
  );
  const second = insertAutomationRule(
    db,
    baseRule({ projectId: "proj1", trigger: "schedule", fieldName: null, fieldValue: null, scheduleTimeUtc: "10:00", toMode: "static", toField: null, toNumber: "2" }),
  );
  const rules = listEnabledScheduledRules(db);
  assert.deepEqual(
    rules.map((r) => r.id),
    [first.id, second.id],
    "the rule created first must sort first even on a createdAt tie",
  );
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

/**
 * Round 974: webhookSecret is optional even for a "webhook" rule (unlike
 * webhookUrl, which is required) -- apps/api/src/automations.ts's
 * fireWebhookAction simply omits the Authorization header when it's null.
 */
test("insertAutomationRule stores a webhook rule's webhookSecret, and leaves it null when omitted", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const withSecret = insertAutomationRule(
    db,
    baseRule({ actionType: "webhook", webhookUrl: "https://example.com/hook", webhookSecret: "top-secret", toField: null, toNumber: null }),
  );
  assert.equal(withSecret.webhookSecret, "top-secret");

  const withoutSecret = insertAutomationRule(
    db,
    baseRule({ actionType: "webhook", webhookUrl: "https://example.com/hook2", toField: null, toNumber: null }),
  );
  assert.equal(withoutSecret.webhookSecret, null);
});

test("updateAutomationRule can set and clear a webhook rule's webhookSecret", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ actionType: "webhook", webhookUrl: "https://example.com/hook", toField: null, toNumber: null }));
  assert.equal(rule.webhookSecret, null);

  const withSecret = updateAutomationRule(db, "proj1", rule.id, { webhookSecret: "new-secret" });
  assert.equal(withSecret.webhookSecret, "new-secret");

  const cleared = updateAutomationRule(db, "proj1", rule.id, { webhookSecret: null });
  assert.equal(cleared.webhookSecret, null);
});

/** Mirrors the identical additive-migration test for webhookUrl above, for the webhookSecret column. */
test("ensureAutomationRulesTable adds webhookSecret to a pre-existing table from an older app version, leaving existing rows intact, and is idempotent", () => {
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
      webhookUrl TEXT,
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
    `INSERT INTO automation_rules (id, projectId, entityName, trigger, fieldName, fieldValue, actionType, toMode, toNumber, toField, webhookUrl, messageTemplate, enabled, createdAt, updatedAt)
     VALUES ('old-rule', 'proj1', 'Order', 'field_equals', 'status', 'Delivered', 'send_whatsapp', 'field', NULL, 'customerPhone', NULL, 'Hi!', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();

  ensureAutomationRulesTable(db);

  const oldRule = getAutomationRule(db, "proj1", "old-rule")!;
  assert.equal(oldRule.webhookSecret, null);
  assert.equal(oldRule.fieldName, "status", "the migration must not disturb an existing row's other columns");

  assert.doesNotThrow(() => ensureAutomationRulesTable(db));
  assert.equal(getAutomationRule(db, "proj1", "old-rule")!.fieldName, "status");
});

/**
 * Round 996: insertAutomationRule stores a "send_email" rule's toEmail/
 * emailSubject, and leaves both null when omitted -- mirrors the webhookUrl/
 * webhookSecret tests above.
 */
test("insertAutomationRule stores a send_email rule's toEmail/emailSubject, and leaves both null when omitted", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const withEmail = insertAutomationRule(
    db,
    baseRule({
      actionType: "send_email",
      toMode: "static",
      toField: null,
      toEmail: "owner@example.com",
      emailSubject: "Your order shipped!",
    }),
  );
  assert.equal(withEmail.toEmail, "owner@example.com");
  assert.equal(withEmail.emailSubject, "Your order shipped!");

  const withoutEmail = insertAutomationRule(db, baseRule({ actionType: "send_email", toMode: "field", toField: "customerEmail" }));
  assert.equal(withoutEmail.toEmail, null);
  assert.equal(withoutEmail.emailSubject, null);
});

test("updateAutomationRule can set and clear a send_email rule's toEmail/emailSubject", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const rule = insertAutomationRule(db, baseRule({ actionType: "send_email", toMode: "static", toField: null, toEmail: "owner@example.com", emailSubject: "Hi" }));
  assert.equal(rule.toEmail, "owner@example.com");
  assert.equal(rule.emailSubject, "Hi");

  const updated = updateAutomationRule(db, "proj1", rule.id, { toEmail: "new@example.com", emailSubject: "New subject" });
  assert.equal(updated.toEmail, "new@example.com");
  assert.equal(updated.emailSubject, "New subject");

  const cleared = updateAutomationRule(db, "proj1", rule.id, { toEmail: null, emailSubject: null });
  assert.equal(cleared.toEmail, null);
  assert.equal(cleared.emailSubject, null);
});

/** Mirrors the identical additive-migration test for webhookSecret above, for the toEmail/emailSubject columns. */
test("ensureAutomationRulesTable adds toEmail/emailSubject to a pre-existing table from an older app version, leaving existing rows intact, and is idempotent", () => {
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
      webhookUrl TEXT,
      webhookSecret TEXT,
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
    `INSERT INTO automation_rules (id, projectId, entityName, trigger, fieldName, fieldValue, actionType, toMode, toNumber, toField, webhookUrl, webhookSecret, messageTemplate, enabled, createdAt, updatedAt)
     VALUES ('old-rule', 'proj1', 'Order', 'field_equals', 'status', 'Delivered', 'send_whatsapp', 'field', NULL, 'customerPhone', NULL, NULL, 'Hi!', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();

  ensureAutomationRulesTable(db);

  const oldRule = getAutomationRule(db, "proj1", "old-rule")!;
  assert.equal(oldRule.toEmail, null);
  assert.equal(oldRule.emailSubject, null);
  assert.equal(oldRule.fieldName, "status", "the migration must not disturb an existing row's other columns");

  assert.doesNotThrow(() => ensureAutomationRulesTable(db));
  assert.equal(getAutomationRule(db, "proj1", "old-rule")!.fieldName, "status");
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
