import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "./connection.js";
import { ensureUsersTable, createUser } from "./users.js";
import {
  ensureProjectCollaboratorsTable,
  addCollaborator,
  removeCollaborator,
  isCollaborator,
  listCollaborators,
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
