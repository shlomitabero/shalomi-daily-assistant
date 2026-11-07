import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT,
  deleteAutomationRuleDeletionsForProject,
  ensureAutomationRuleDeletionsTable,
  insertAutomationRuleDeletion,
  listAutomationRuleDeletions,
} from "./automationRuleDeletions.js";

test("insertAutomationRuleDeletion stores a deletion and returns it via listAutomationRuleDeletions, newest first", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  insertAutomationRuleDeletion(db, {
    projectId: "proj1",
    ruleId: "rule1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: "user1",
  });
  insertAutomationRuleDeletion(db, {
    projectId: "proj1",
    ruleId: "rule2",
    entityName: "Order",
    trigger: "field_equals",
    actionType: "webhook",
    deletedByUserId: "user2",
  });

  const deletions = listAutomationRuleDeletions(db, "proj1");
  assert.equal(deletions.length, 2);
  assert.equal(deletions[0].ruleId, "rule2", "newest deletion must come first");
  assert.equal(deletions[0].entityName, "Order");
  assert.equal(deletions[0].trigger, "field_equals");
  assert.equal(deletions[0].actionType, "webhook");
  assert.equal(deletions[0].deletedByUserId, "user2");
  assert.equal(deletions[1].ruleId, "rule1");
  assert.ok(deletions[0].deletedAt);
});

test("insertAutomationRuleDeletion stores deletedByUserId as null when given null, never fabricating an actor", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  insertAutomationRuleDeletion(db, {
    projectId: "proj1",
    ruleId: "rule1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: null,
  });

  const deletions = listAutomationRuleDeletions(db, "proj1");
  assert.equal(deletions[0].deletedByUserId, null);
});

test("listAutomationRuleDeletions never crosses project boundaries", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  insertAutomationRuleDeletion(db, {
    projectId: "proj1",
    ruleId: "rule1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: "user1",
  });
  insertAutomationRuleDeletion(db, {
    projectId: "proj2",
    ruleId: "rule1",
    entityName: "a different project's own entity",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: "user1",
  });

  assert.equal(listAutomationRuleDeletions(db, "proj1").length, 1);
  assert.equal(listAutomationRuleDeletions(db, "proj1")[0].entityName, "Customer");
  assert.equal(listAutomationRuleDeletions(db, "proj2").length, 1);
  assert.equal(listAutomationRuleDeletions(db, "proj2")[0].entityName, "a different project's own entity");
});

/**
 * Round 1666: mirrors recordDeletions.test.ts's own insertRecordDeletion
 * retention test for the identical shape -- insertAutomationRuleDeletion
 * applies the same prune on every insert.
 */
test("insertAutomationRuleDeletion prunes the oldest deletions once a project passes the retention limit, keeping only the newest ones", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  for (let i = 0; i < AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT + 5; i++) {
    insertAutomationRuleDeletion(db, {
      projectId: "proj1",
      ruleId: `rule${i}`,
      entityName: "Customer",
      trigger: "record_created",
      actionType: "send_whatsapp",
      deletedByUserId: "user1",
    });
  }
  const deletions = listAutomationRuleDeletions(db, "proj1", AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT + 10);
  assert.equal(deletions.length, AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT, "the project's own deletion count must never exceed the retention limit");
  assert.equal(deletions[0].ruleId, `rule${AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT + 4}`, "the newest deletion must always survive pruning");
  assert.equal(
    deletions[deletions.length - 1].ruleId,
    "rule5",
    "pruning must drop exactly the oldest deletions, keeping the most recent AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT",
  );
});

/** Round 1680: see recordDeletions.test.ts's own identical new test for why 60 (between the old default of 50 and AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT's 500) is the deliberate choice here. */
test("listAutomationRuleDeletions with no limit argument returns every retained deletion, not just the first 50", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  for (let i = 0; i < 60; i++) {
    insertAutomationRuleDeletion(db, {
      projectId: "proj1",
      ruleId: `rule${i}`,
      entityName: "Customer",
      trigger: "record_created",
      actionType: "send_whatsapp",
      deletedByUserId: "user1",
    });
  }
  assert.equal(listAutomationRuleDeletions(db, "proj1").length, 60, "the default limit must not silently truncate below the real retention limit");
});

test("insertAutomationRuleDeletion never prunes a DIFFERENT project's deletions when this project passes the retention limit", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  insertAutomationRuleDeletion(db, {
    projectId: "proj2",
    ruleId: "other project's own deletion",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: "user1",
  });
  for (let i = 0; i < AUTOMATION_RULE_DELETIONS_RETENTION_LIMIT + 5; i++) {
    insertAutomationRuleDeletion(db, {
      projectId: "proj1",
      ruleId: `rule${i}`,
      entityName: "Customer",
      trigger: "record_created",
      actionType: "send_whatsapp",
      deletedByUserId: "user1",
    });
  }
  const otherProjectDeletions = listAutomationRuleDeletions(db, "proj2");
  assert.equal(otherProjectDeletions.length, 1, "a different project's own deletion must survive another project's pruning untouched");
  assert.equal(otherProjectDeletions[0].ruleId, "other project's own deletion");
});

test("deleteAutomationRuleDeletionsForProject removes only the given project's own deletions", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRuleDeletionsTable(db);
  insertAutomationRuleDeletion(db, {
    projectId: "proj1",
    ruleId: "rule1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: "user1",
  });
  insertAutomationRuleDeletion(db, {
    projectId: "proj2",
    ruleId: "rule1",
    entityName: "a different project's own entity",
    trigger: "record_created",
    actionType: "send_whatsapp",
    deletedByUserId: "user1",
  });

  deleteAutomationRuleDeletionsForProject(db, "proj1");

  assert.equal(listAutomationRuleDeletions(db, "proj1").length, 0);
  assert.equal(listAutomationRuleDeletions(db, "proj2").length, 1);
});
