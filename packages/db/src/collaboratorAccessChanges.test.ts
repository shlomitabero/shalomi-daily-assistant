import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import {
  COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT,
  deleteCollaboratorAccessChangesForProject,
  ensureCollaboratorAccessChangesTable,
  insertCollaboratorAccessChange,
  listCollaboratorAccessChanges,
} from "./collaboratorAccessChanges.js";

test("insertCollaboratorAccessChange stores a role change and returns it via listCollaboratorAccessChanges, newest first", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  insertCollaboratorAccessChange(db, {
    projectId: "proj1",
    targetUserId: "user1",
    changedByUserId: "owner1",
    action: "role_changed",
    previousRole: "editor",
    newRole: "viewer",
  });
  insertCollaboratorAccessChange(db, {
    projectId: "proj1",
    targetUserId: "user2",
    changedByUserId: "owner1",
    action: "removed",
    previousRole: "editor",
    newRole: null,
  });

  const changes = listCollaboratorAccessChanges(db, "proj1");
  assert.equal(changes.length, 2);
  assert.equal(changes[0].action, "removed", "newest change must come first");
  assert.equal(changes[0].targetUserId, "user2");
  assert.equal(changes[0].previousRole, "editor");
  assert.equal(changes[0].newRole, null);
  assert.ok(changes[0].changedAt);
  assert.equal(changes[1].action, "role_changed");
  assert.equal(changes[1].previousRole, "editor");
  assert.equal(changes[1].newRole, "viewer");
  assert.equal(changes[1].changedByUserId, "owner1");
});

test("insertCollaboratorAccessChange stores changedByUserId as null when given null, never fabricating an actor", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  insertCollaboratorAccessChange(db, {
    projectId: "proj1",
    targetUserId: "user1",
    changedByUserId: null,
    action: "removed",
    previousRole: "viewer",
    newRole: null,
  });

  const changes = listCollaboratorAccessChanges(db, "proj1");
  assert.equal(changes[0].changedByUserId, null);
});

test("listCollaboratorAccessChanges never crosses project boundaries", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  insertCollaboratorAccessChange(db, {
    projectId: "proj1",
    targetUserId: "user1",
    changedByUserId: "owner1",
    action: "removed",
    previousRole: "editor",
    newRole: null,
  });
  insertCollaboratorAccessChange(db, {
    projectId: "proj2",
    targetUserId: "user1",
    changedByUserId: "owner2",
    action: "removed",
    previousRole: "viewer",
    newRole: null,
  });

  assert.equal(listCollaboratorAccessChanges(db, "proj1").length, 1);
  assert.equal(listCollaboratorAccessChanges(db, "proj1")[0].changedByUserId, "owner1");
  assert.equal(listCollaboratorAccessChanges(db, "proj2").length, 1);
  assert.equal(listCollaboratorAccessChanges(db, "proj2")[0].changedByUserId, "owner2");
});

/**
 * Round 1636: mirrors recordDeletions.test.ts's own insertRecordDeletion
 * retention test for the identical shape -- insertCollaboratorAccessChange
 * applies the same prune on every insert.
 */
test("insertCollaboratorAccessChange prunes the oldest entries once a project passes the retention limit, keeping only the newest ones", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  for (let i = 0; i < COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT + 5; i++) {
    insertCollaboratorAccessChange(db, {
      projectId: "proj1",
      targetUserId: `user${i}`,
      changedByUserId: "owner1",
      action: "removed",
      previousRole: "editor",
      newRole: null,
    });
  }
  const changes = listCollaboratorAccessChanges(db, "proj1", COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT + 10);
  assert.equal(changes.length, COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT, "the project's own entry count must never exceed the retention limit");
  assert.equal(changes[0].targetUserId, `user${COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT + 4}`, "the newest entry must always survive pruning");
  assert.equal(
    changes[changes.length - 1].targetUserId,
    "user5",
    "pruning must drop exactly the oldest entries, keeping the most recent COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT",
  );
});

test("insertCollaboratorAccessChange never prunes a DIFFERENT project's entries when this project passes the retention limit", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  insertCollaboratorAccessChange(db, {
    projectId: "proj2",
    targetUserId: "other-project-user",
    changedByUserId: "owner2",
    action: "removed",
    previousRole: "editor",
    newRole: null,
  });
  for (let i = 0; i < COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT + 5; i++) {
    insertCollaboratorAccessChange(db, {
      projectId: "proj1",
      targetUserId: `user${i}`,
      changedByUserId: "owner1",
      action: "removed",
      previousRole: "editor",
      newRole: null,
    });
  }
  const otherProjectChanges = listCollaboratorAccessChanges(db, "proj2");
  assert.equal(otherProjectChanges.length, 1, "a different project's own entry must survive another project's pruning untouched");
  assert.equal(otherProjectChanges[0].targetUserId, "other-project-user");
});

test("deleteCollaboratorAccessChangesForProject removes only the given project's own entries", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  insertCollaboratorAccessChange(db, {
    projectId: "proj1",
    targetUserId: "user1",
    changedByUserId: "owner1",
    action: "removed",
    previousRole: "editor",
    newRole: null,
  });
  insertCollaboratorAccessChange(db, {
    projectId: "proj2",
    targetUserId: "user1",
    changedByUserId: "owner2",
    action: "removed",
    previousRole: "editor",
    newRole: null,
  });

  deleteCollaboratorAccessChangesForProject(db, "proj1");

  assert.equal(listCollaboratorAccessChanges(db, "proj1").length, 0);
  assert.equal(listCollaboratorAccessChanges(db, "proj2").length, 1);
});
