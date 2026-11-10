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

/**
 * Round 1665: "invited" is the one sibling action in this exact family
 * (role_changed/removed round 1636, ownership_transferred round 1654) that
 * never got its own audit-trail entry -- going from no access to some role
 * is the most fundamental access change there is. previousRole is always
 * null (there was no prior role at all), mirroring removed's own newRole
 * being null for the opposite direction.
 */
test("insertCollaboratorAccessChange stores an invite with previousRole null and the granted role as newRole", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  insertCollaboratorAccessChange(db, {
    projectId: "proj1",
    targetUserId: "user1",
    changedByUserId: "owner1",
    action: "invited",
    previousRole: null,
    newRole: "editor",
  });

  const changes = listCollaboratorAccessChanges(db, "proj1");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].action, "invited");
  assert.equal(changes[0].previousRole, null, "there was no prior role at all before the invite");
  assert.equal(changes[0].newRole, "editor");
  assert.equal(changes[0].changedByUserId, "owner1");
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

/** Round 1680: see recordDeletions.test.ts's own identical new test for why 60 (between the old default of 50 and COLLABORATOR_ACCESS_CHANGES_RETENTION_LIMIT's 500) is the deliberate choice here. */
test("listCollaboratorAccessChanges with no limit argument returns every retained entry, not just the first 50", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  for (let i = 0; i < 60; i++) {
    insertCollaboratorAccessChange(db, {
      projectId: "proj1",
      targetUserId: `user${i}`,
      changedByUserId: "owner1",
      action: "removed",
      previousRole: "editor",
      newRole: null,
    });
  }
  assert.equal(listCollaboratorAccessChanges(db, "proj1").length, 60, "the default limit must not silently truncate below the real retention limit");
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

/** Round 1867: see recordDeletions.test.ts's own identical test and checkpoints.test.ts's round-1853 original for why. */
test("listCollaboratorAccessChanges' projectId+changedAt lookup uses an index, not a full table scan", () => {
  const db = openDatabase(":memory:");
  ensureCollaboratorAccessChangesTable(db);
  const plan = db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM collaborator_access_changes WHERE projectId = ? ORDER BY changedAt DESC, rowid DESC")
    .all("proj1") as { detail: string }[];
  const detail = plan.map((row) => row.detail).join("; ");
  assert.doesNotMatch(detail, /SCAN collaborator_access_changes\b/, `expected an index-backed search, got a full table scan: ${detail}`);
  assert.match(detail, /USING INDEX collaborator_access_changes_projectId_changedAt_idx/, `expected the new index to be used: ${detail}`);
});
