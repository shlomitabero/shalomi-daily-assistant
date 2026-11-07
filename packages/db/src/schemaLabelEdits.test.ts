import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  SCHEMA_LABEL_EDITS_RETENTION_LIMIT,
  deleteSchemaLabelEditsForProject,
  ensureSchemaLabelEditsTable,
  insertSchemaLabelEdit,
  listSchemaLabelEdits,
} from "./schemaLabelEdits.js";

test("insertSchemaLabelEdit stores an entity rename and a field rename and returns them via listSchemaLabelEdits, newest first", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  insertSchemaLabelEdit(db, {
    projectId: "proj1",
    changedByUserId: "user1",
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "Clients",
  });
  insertSchemaLabelEdit(db, {
    projectId: "proj1",
    changedByUserId: "user1",
    action: "field_renamed",
    entityName: "Customer",
    fieldName: "phone",
    previousLabel: "Phone",
    newLabel: "Mobile",
  });

  const edits = listSchemaLabelEdits(db, "proj1");
  assert.equal(edits.length, 2);
  assert.equal(edits[0].action, "field_renamed", "newest edit must come first");
  assert.equal(edits[0].fieldName, "phone");
  assert.equal(edits[0].previousLabel, "Phone");
  assert.equal(edits[0].newLabel, "Mobile");
  assert.ok(edits[0].changedAt);
  assert.equal(edits[1].action, "entity_renamed");
  assert.equal(edits[1].fieldName, null, "an entity rename has no field name");
  assert.equal(edits[1].previousLabel, "Customers");
  assert.equal(edits[1].newLabel, "Clients");
  assert.equal(edits[1].changedByUserId, "user1");
});

test("insertSchemaLabelEdit stores changedByUserId as null when given null, never fabricating an actor", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  insertSchemaLabelEdit(db, {
    projectId: "proj1",
    changedByUserId: null,
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "Clients",
  });

  const edits = listSchemaLabelEdits(db, "proj1");
  assert.equal(edits[0].changedByUserId, null);
});

test("listSchemaLabelEdits never crosses project boundaries", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  insertSchemaLabelEdit(db, {
    projectId: "proj1",
    changedByUserId: "user1",
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "Clients",
  });
  insertSchemaLabelEdit(db, {
    projectId: "proj2",
    changedByUserId: "user2",
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "Buyers",
  });

  assert.equal(listSchemaLabelEdits(db, "proj1").length, 1);
  assert.equal(listSchemaLabelEdits(db, "proj1")[0].newLabel, "Clients");
  assert.equal(listSchemaLabelEdits(db, "proj2").length, 1);
  assert.equal(listSchemaLabelEdits(db, "proj2")[0].newLabel, "Buyers");
});

/**
 * Round 1639: mirrors collaboratorAccessChanges.test.ts's own
 * insertCollaboratorAccessChange retention test for the identical shape --
 * insertSchemaLabelEdit applies the same prune on every insert.
 */
test("insertSchemaLabelEdit prunes the oldest entries once a project passes the retention limit, keeping only the newest ones", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  for (let i = 0; i < SCHEMA_LABEL_EDITS_RETENTION_LIMIT + 5; i++) {
    insertSchemaLabelEdit(db, {
      projectId: "proj1",
      changedByUserId: "user1",
      action: "entity_renamed",
      entityName: "Customer",
      fieldName: null,
      previousLabel: `label${i}`,
      newLabel: `label${i + 1}`,
    });
  }
  const edits = listSchemaLabelEdits(db, "proj1", SCHEMA_LABEL_EDITS_RETENTION_LIMIT + 10);
  assert.equal(edits.length, SCHEMA_LABEL_EDITS_RETENTION_LIMIT, "the project's own entry count must never exceed the retention limit");
  assert.equal(edits[0].newLabel, `label${SCHEMA_LABEL_EDITS_RETENTION_LIMIT + 5}`, "the newest entry must always survive pruning");
  assert.equal(
    edits[edits.length - 1].newLabel,
    "label6",
    "pruning must drop exactly the oldest entries, keeping the most recent SCHEMA_LABEL_EDITS_RETENTION_LIMIT",
  );
});

/** Round 1680: see recordDeletions.test.ts's own identical new test for why 60 (between the old default of 50 and SCHEMA_LABEL_EDITS_RETENTION_LIMIT's 500) is the deliberate choice here. */
test("listSchemaLabelEdits with no limit argument returns every retained entry, not just the first 50", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  for (let i = 0; i < 60; i++) {
    insertSchemaLabelEdit(db, {
      projectId: "proj1",
      changedByUserId: "user1",
      action: "entity_renamed",
      entityName: "Customer",
      fieldName: null,
      previousLabel: `label${i}`,
      newLabel: `label${i + 1}`,
    });
  }
  assert.equal(listSchemaLabelEdits(db, "proj1").length, 60, "the default limit must not silently truncate below the real retention limit");
});

test("insertSchemaLabelEdit never prunes a DIFFERENT project's entries when this project passes the retention limit", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  insertSchemaLabelEdit(db, {
    projectId: "proj2",
    changedByUserId: "user2",
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "other-project-label",
  });
  for (let i = 0; i < SCHEMA_LABEL_EDITS_RETENTION_LIMIT + 5; i++) {
    insertSchemaLabelEdit(db, {
      projectId: "proj1",
      changedByUserId: "user1",
      action: "entity_renamed",
      entityName: "Customer",
      fieldName: null,
      previousLabel: `label${i}`,
      newLabel: `label${i + 1}`,
    });
  }
  const otherProjectEdits = listSchemaLabelEdits(db, "proj2");
  assert.equal(otherProjectEdits.length, 1, "a different project's own entry must survive another project's pruning untouched");
  assert.equal(otherProjectEdits[0].newLabel, "other-project-label");
});

test("deleteSchemaLabelEditsForProject removes only the given project's own entries", () => {
  const db = openDatabase(":memory:");
  ensureSchemaLabelEditsTable(db);
  insertSchemaLabelEdit(db, {
    projectId: "proj1",
    changedByUserId: "user1",
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "Clients",
  });
  insertSchemaLabelEdit(db, {
    projectId: "proj2",
    changedByUserId: "user2",
    action: "entity_renamed",
    entityName: "Customer",
    fieldName: null,
    previousLabel: "Customers",
    newLabel: "Buyers",
  });

  deleteSchemaLabelEditsForProject(db, "proj1");

  assert.equal(listSchemaLabelEdits(db, "proj1").length, 0);
  assert.equal(listSchemaLabelEdits(db, "proj2").length, 1);
});
