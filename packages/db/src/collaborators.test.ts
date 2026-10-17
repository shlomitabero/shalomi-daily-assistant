import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import { ensureUsersTable, createUser } from "./users.js";
import {
  ensureProjectCollaboratorsTable,
  addCollaborator,
  removeCollaborator,
  removeAllCollaborationsForUser,
  isCollaborator,
  listCollaborators,
  listCollaboratedProjectIds,
  getCollaboratorRole,
  updateCollaboratorRole,
} from "./collaborators.js";

function setup() {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  ensureProjectCollaboratorsTable(db);
  return db;
}

test("isCollaborator is false until addCollaborator is called, then true, then false again after removeCollaborator", () => {
  const db = setup();
  assert.equal(isCollaborator(db, "proj1", "user1"), false);
  addCollaborator(db, "proj1", "user1");
  assert.equal(isCollaborator(db, "proj1", "user1"), true);
  removeCollaborator(db, "proj1", "user1");
  assert.equal(isCollaborator(db, "proj1", "user1"), false);
});

test("addCollaborator is idempotent: adding the same user to the same project twice doesn't throw or duplicate the row", () => {
  const db = setup();
  addCollaborator(db, "proj1", "user1");
  addCollaborator(db, "proj1", "user1");
  const user = createUser(db, { id: "user1", email: "user1@example.com", passwordHash: "x" });
  const collaborators = listCollaborators(db, "proj1");
  assert.deepEqual(
    collaborators.map((c) => c.userId),
    [user.id],
    "adding the same collaborator twice should still leave exactly one row",
  );
});

test("listCollaborators resolves each collaborator's real email (joined from users) and orders by when they were added", () => {
  const db = setup();
  createUser(db, { id: "user1", email: "first@example.com", passwordHash: "x" });
  createUser(db, { id: "user2", email: "second@example.com", passwordHash: "x" });
  addCollaborator(db, "proj1", "user1");
  addCollaborator(db, "proj1", "user2");

  const collaborators = listCollaborators(db, "proj1");
  assert.deepEqual(
    collaborators.map((c) => ({ userId: c.userId, email: c.email })),
    [
      { userId: "user1", email: "first@example.com" },
      { userId: "user2", email: "second@example.com" },
    ],
  );
});

test("listCollaborators only returns collaborators for the requested project, not every project's collaborators", () => {
  const db = setup();
  createUser(db, { id: "user1", email: "user1@example.com", passwordHash: "x" });
  addCollaborator(db, "proj1", "user1");

  assert.deepEqual(listCollaborators(db, "proj2"), []);
});

test("removeCollaborator on a user who was never added is a harmless no-op, not an error", () => {
  const db = setup();
  assert.doesNotThrow(() => removeCollaborator(db, "proj1", "never-added"));
});

/**
 * New in this round: the robust complement to projects.ts's
 * listOwnedProjectIds, for the exact same reason -- DeleteAccountPanel.tsx
 * used to derive its sharedProjectIds (used for localStorage cleanup after
 * account deletion) from listProjects(), which silently drops any project
 * whose stored spec no longer parses against today's schema. This table
 * alone never touches a project's spec_json at all, so it can't miss a row
 * that way -- confirmed here by covering both a project this user has no
 * access to and multiple projects they do.
 */
test("listCollaboratedProjectIds returns every project id this user collaborates on, and nothing for a project they have no access to", () => {
  const db = setup();
  addCollaborator(db, "proj1", "user1");
  addCollaborator(db, "proj2", "user1");
  addCollaborator(db, "proj3", "someone-else");

  assert.deepEqual(listCollaboratedProjectIds(db, "user1").slice().sort(), ["proj1", "proj2"]);
  assert.deepEqual(listCollaboratedProjectIds(db, "someone-else"), ["proj3"]);
  assert.deepEqual(listCollaboratedProjectIds(db, "never-invited"), []);
});

/**
 * New in this round: part of the real "delete my account" flow
 * (routes/auth.ts) -- once every project a user actually OWNS has been
 * deleted, this cleans up their grants on every OTHER project they were
 * merely invited to, so those projects don't keep a dangling collaborator
 * row for a user id that no longer exists. Scoped by userId, the mirror of
 * removeAllCollaborators' own projectId scoping: must remove this one
 * user's own grants across every project, and must never touch a different
 * user's grant on the same project.
 */
test("removeAllCollaborationsForUser removes this user's own grants across every project, leaving a different user's grant on the same project untouched", () => {
  const db = setup();
  createUser(db, { id: "leaving", email: "leaving@example.com", passwordHash: "x" });
  createUser(db, { id: "staying", email: "staying@example.com", passwordHash: "x" });
  addCollaborator(db, "proj1", "leaving");
  addCollaborator(db, "proj2", "leaving");
  addCollaborator(db, "proj1", "staying");

  removeAllCollaborationsForUser(db, "leaving");

  assert.equal(isCollaborator(db, "proj1", "leaving"), false);
  assert.equal(isCollaborator(db, "proj2", "leaving"), false);
  assert.equal(isCollaborator(db, "proj1", "staying"), true, "a different user's own grant on the same project must be completely untouched");
});

test("removeAllCollaborationsForUser is a harmless no-op for a user with no collaborations at all", () => {
  const db = setup();
  assert.doesNotThrow(() => removeAllCollaborationsForUser(db, "never-collaborated"));
});

test("addCollaborator defaults to the 'editor' role when none is given, matching every collaborator's access before roles existed", () => {
  const db = setup();
  createUser(db, { id: "user1", email: "user1@example.com", passwordHash: "x" });
  addCollaborator(db, "proj1", "user1");
  assert.equal(getCollaboratorRole(db, "proj1", "user1"), "editor");
  assert.equal(listCollaborators(db, "proj1")[0].role, "editor");
});

test("addCollaborator stores an explicit 'viewer' role, and getCollaboratorRole/listCollaborators both reflect it", () => {
  const db = setup();
  createUser(db, { id: "user1", email: "user1@example.com", passwordHash: "x" });
  addCollaborator(db, "proj1", "user1", "viewer");
  assert.equal(getCollaboratorRole(db, "proj1", "user1"), "viewer");
  assert.equal(listCollaborators(db, "proj1")[0].role, "viewer");
});

test("getCollaboratorRole returns null for a user who isn't a collaborator on that project at all", () => {
  const db = setup();
  assert.equal(getCollaboratorRole(db, "proj1", "never-added"), null);
});

test("updateCollaboratorRole changes an existing collaborator's role, leaving a different collaborator on the same project untouched", () => {
  const db = setup();
  createUser(db, { id: "user1", email: "user1@example.com", passwordHash: "x" });
  createUser(db, { id: "user2", email: "user2@example.com", passwordHash: "x" });
  addCollaborator(db, "proj1", "user1", "editor");
  addCollaborator(db, "proj1", "user2", "editor");

  updateCollaboratorRole(db, "proj1", "user1", "viewer");

  assert.equal(getCollaboratorRole(db, "proj1", "user1"), "viewer");
  assert.equal(getCollaboratorRole(db, "proj1", "user2"), "editor", "a different collaborator's own role on the same project must be untouched");
});

test("updateCollaboratorRole on a user who isn't a collaborator at all is a harmless no-op, not an error", () => {
  const db = setup();
  assert.doesNotThrow(() => updateCollaboratorRole(db, "proj1", "never-added", "viewer"));
  assert.equal(getCollaboratorRole(db, "proj1", "never-added"), null);
});

/**
 * Regression test for ensureProjectCollaboratorsTable's own migration path:
 * a table created by an app version before roles existed has no `role`
 * column at all. ensureProjectCollaboratorsTable must add it (ADD COLUMN,
 * additive-only, same discipline checkpoints.ts's own `kind` backfill
 * uses) with every existing row defaulting to "editor" -- the exact full
 * access that row already had before this upgrade, so adding roles can
 * never be a silent permission downgrade for an existing deployment.
 */
test("ensureProjectCollaboratorsTable adds a missing role column to a pre-existing table, defaulting every existing row to 'editor'", () => {
  const db = openDatabase(":memory:");
  ensureUsersTable(db);
  // Stand in for a project_collaborators table created by an app version
  // before `role` existed -- the exact old CREATE TABLE, no role column.
  db.exec(`
    CREATE TABLE project_collaborators (
      projectId TEXT NOT NULL,
      userId TEXT NOT NULL,
      addedAt TEXT NOT NULL,
      PRIMARY KEY (projectId, userId)
    )
  `);
  db.prepare("INSERT INTO project_collaborators (projectId, userId, addedAt) VALUES (?, ?, ?)").run(
    "proj1",
    "pre-existing-user",
    "2026-01-01T00:00:00.000Z",
  );

  ensureProjectCollaboratorsTable(db);

  assert.equal(getCollaboratorRole(db, "proj1", "pre-existing-user"), "editor");

  // Running it again (every app startup) must stay a no-op.
  assert.doesNotThrow(() => ensureProjectCollaboratorsTable(db));
  assert.equal(getCollaboratorRole(db, "proj1", "pre-existing-user"), "editor", "re-running the migration must not disturb an already-backfilled role");
});
