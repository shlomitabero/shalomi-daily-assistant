import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  deleteRecordDeletionsForProject,
  ensureRecordDeletionsTable,
  insertRecordDeletion,
  listRecordDeletions,
  RECORD_DELETIONS_RETENTION_LIMIT,
} from "./recordDeletions.js";

test("insertRecordDeletion stores a deletion and returns it via listRecordDeletions, newest first", () => {
  const db = openDatabase(":memory:");
  ensureRecordDeletionsTable(db);
  insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: 1, recordLabel: "Acme Corp", deletedByUserId: "user1" });
  insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: 2, recordLabel: "Beta LLC", deletedByUserId: "user2" });

  const deletions = listRecordDeletions(db, "proj1");
  assert.equal(deletions.length, 2);
  assert.equal(deletions[0].recordLabel, "Beta LLC", "newest deletion must come first");
  assert.equal(deletions[0].deletedByUserId, "user2");
  assert.equal(deletions[1].recordLabel, "Acme Corp");
  assert.ok(deletions[0].deletedAt);
  assert.equal(deletions[0].entityName, "Customer");
  assert.equal(deletions[0].recordId, 2);
});

test("insertRecordDeletion stores deletedByUserId as null when given null, never fabricating an actor", () => {
  const db = openDatabase(":memory:");
  ensureRecordDeletionsTable(db);
  insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: 1, recordLabel: "Acme Corp", deletedByUserId: null });

  const deletions = listRecordDeletions(db, "proj1");
  assert.equal(deletions[0].deletedByUserId, null);
});

test("listRecordDeletions never crosses project boundaries", () => {
  const db = openDatabase(":memory:");
  ensureRecordDeletionsTable(db);
  insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: 1, recordLabel: "Acme Corp", deletedByUserId: "user1" });
  insertRecordDeletion(db, { projectId: "proj2", entityName: "Customer", recordId: 1, recordLabel: "a different project's own record", deletedByUserId: "user1" });

  assert.equal(listRecordDeletions(db, "proj1").length, 1);
  assert.equal(listRecordDeletions(db, "proj1")[0].recordLabel, "Acme Corp");
  assert.equal(listRecordDeletions(db, "proj2").length, 1);
  assert.equal(listRecordDeletions(db, "proj2")[0].recordLabel, "a different project's own record");
});

/**
 * Round 1632: mirrors checkpoints.test.ts's/whatsapp.test.ts's own
 * insertCheckpoint/insertWhatsAppMessage retention tests for the identical
 * shape -- insertRecordDeletion applies the same prune on every insert.
 */
test("insertRecordDeletion prunes the oldest deletions once a project passes the retention limit, keeping only the newest ones", () => {
  const db = openDatabase(":memory:");
  ensureRecordDeletionsTable(db);
  for (let i = 0; i < RECORD_DELETIONS_RETENTION_LIMIT + 5; i++) {
    insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: i, recordLabel: `record ${i}`, deletedByUserId: "user1" });
  }
  const deletions = listRecordDeletions(db, "proj1", RECORD_DELETIONS_RETENTION_LIMIT + 10);
  assert.equal(deletions.length, RECORD_DELETIONS_RETENTION_LIMIT, "the project's own deletion count must never exceed the retention limit");
  assert.equal(deletions[0].recordLabel, `record ${RECORD_DELETIONS_RETENTION_LIMIT + 4}`, "the newest deletion must always survive pruning");
  assert.equal(
    deletions[deletions.length - 1].recordLabel,
    "record 5",
    "pruning must drop exactly the oldest deletions, keeping the most recent RECORD_DELETIONS_RETENTION_LIMIT",
  );
});

test("insertRecordDeletion never prunes a DIFFERENT project's deletions when this project passes the retention limit", () => {
  const db = openDatabase(":memory:");
  ensureRecordDeletionsTable(db);
  insertRecordDeletion(db, { projectId: "proj2", entityName: "Customer", recordId: 1, recordLabel: "other project's own deletion", deletedByUserId: "user1" });
  for (let i = 0; i < RECORD_DELETIONS_RETENTION_LIMIT + 5; i++) {
    insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: i, recordLabel: `record ${i}`, deletedByUserId: "user1" });
  }
  const otherProjectDeletions = listRecordDeletions(db, "proj2");
  assert.equal(otherProjectDeletions.length, 1, "a different project's own deletion must survive another project's pruning untouched");
  assert.equal(otherProjectDeletions[0].recordLabel, "other project's own deletion");
});

test("deleteRecordDeletionsForProject removes only the given project's own deletions", () => {
  const db = openDatabase(":memory:");
  ensureRecordDeletionsTable(db);
  insertRecordDeletion(db, { projectId: "proj1", entityName: "Customer", recordId: 1, recordLabel: "Acme Corp", deletedByUserId: "user1" });
  insertRecordDeletion(db, { projectId: "proj2", entityName: "Customer", recordId: 1, recordLabel: "a different project's own record", deletedByUserId: "user1" });

  deleteRecordDeletionsForProject(db, "proj1");

  assert.equal(listRecordDeletions(db, "proj1").length, 0);
  assert.equal(listRecordDeletions(db, "proj2").length, 1);
});
