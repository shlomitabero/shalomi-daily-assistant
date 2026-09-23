import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { ensureProjectCollaboratorsTable, addCollaborator } from "./collaborators.js";
import {
  ensureProjectsTable,
  getProject,
  insertProject,
  listProjectsForOwner,
  listProjectsForUser,
  updateProjectName,
} from "./projects.js";

const validSpec: ProductSpec = {
  summary: "test",
  personas: [],
  roles: ["Admin"],
  entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  screens: [],
  assumptions: [],
  openQuestions: [],
};

test("listProjectsForOwner still returns the owner's good projects when one stored spec no longer matches the current schema", () => {
  // rowToProject runs ProductSpecSchema.parse() against whatever JSON was
  // stored when the project was created. Since ProductSpecSchema can only
  // ever get *stricter* over time (a field goes from optional to required,
  // a new .min(1) is added, etc.), a project written by an older version of
  // this app is a real, expected future case -- not a hypothetical. This
  // row is inserted directly via raw SQL (bypassing insertProject, which
  // would itself require a valid spec) specifically to stand in for that:
  // spec_json that satisfied whatever schema existed when it was written,
  // but doesn't parse against today's.
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  const good = insertProject(db, {
    id: "good",
    ownerId: "owner1",
    name: "Good project",
    description: "test",
    spec: validSpec,
  });
  db.prepare(
    "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("stale", "owner1", "Stale project", "test", JSON.stringify({ summary: "old spec, missing fields" }), "built", new Date().toISOString());

  const projects = listProjectsForOwner(db, "owner1");
  assert.deepEqual(
    projects.map((p) => p.id),
    [good.id],
    "the one unparseable project should be excluded, not take down the whole list",
  );
});

test("getProject still throws clearly for a single project whose stored spec no longer matches the current schema", () => {
  // Unlike the list, a single-project fetch has no valid fallback to
  // return instead -- every caller (the build pipeline, records routes,
  // twin, etc.) needs a real, valid Project to operate on. Surfacing this
  // as a clear failure (a 500 via the app's catch-all handler, not a
  // panic that takes other requests down with it) is the right behavior
  // here, so this stays intentionally unhandled.
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  db.prepare(
    "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("stale", "owner1", "Stale project", "test", JSON.stringify({ summary: "old spec, missing fields" }), "built", new Date().toISOString());

  assert.throws(() => getProject(db, "stale"));
});

test("listProjectsForOwner returns projects newest first even when two share the exact same createdAt millisecond", () => {
  // createdAt is a new Date().toISOString() string with only millisecond
  // resolution, and the query ordered purely by ORDER BY createdAt DESC
  // with no tiebreaker -- the identical bug already found and fixed in
  // checkpoints.ts's listCheckpoints. Two synchronous inserts (no await in
  // between) reliably land in the same millisecond, exposing it.
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  insertProject(db, { id: "p1", ownerId: "owner1", name: "first", description: "test", spec: validSpec });
  insertProject(db, { id: "p2", ownerId: "owner1", name: "second", description: "test", spec: validSpec });

  const projects = listProjectsForOwner(db, "owner1");
  assert.deepEqual(
    projects.map((p) => p.id),
    ["p2", "p1"],
    "the most recently created project should sort first even on a createdAt tie",
  );
});

test("listProjectsForUser includes a project someone else owns when this user has been added as a collaborator on it, alongside their own owned projects", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureProjectCollaboratorsTable(db);
  const owned = insertProject(db, { id: "owned", ownerId: "alice", name: "Alice's project", description: "test", spec: validSpec });
  const sharedWithAlice = insertProject(db, { id: "shared", ownerId: "bob", name: "Bob's project", description: "test", spec: validSpec });
  insertProject(db, { id: "not-shared", ownerId: "bob", name: "Bob's other project", description: "test", spec: validSpec });
  addCollaborator(db, sharedWithAlice.id, "alice");

  const projects = listProjectsForUser(db, "alice");
  assert.deepEqual(
    new Set(projects.map((p) => p.id)),
    new Set([owned.id, sharedWithAlice.id]),
    "alice should see her own project and the one she collaborates on, but not bob's unrelated project",
  );
});

test("listProjectsForUser returns each project exactly once even when the user is both its owner and (redundantly) listed as a collaborator", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureProjectCollaboratorsTable(db);
  const project = insertProject(db, { id: "p1", ownerId: "alice", name: "test", description: "test", spec: validSpec });
  addCollaborator(db, project.id, "alice");

  const projects = listProjectsForUser(db, "alice");
  assert.deepEqual(
    projects.map((p) => p.id),
    ["p1"],
    "should not list the same project twice",
  );
});

test("updateProjectName changes only the name, leaving every other field (spec, description, status, ownerId) untouched", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  const project = insertProject(db, {
    id: "p1",
    ownerId: "owner1",
    name: "Auto-derived name",
    description: "the original description",
    spec: validSpec,
  });

  const renamed = updateProjectName(db, project.id, "My Actual Business Name");
  assert.equal(renamed.name, "My Actual Business Name");
  assert.equal(renamed.description, project.description);
  assert.equal(renamed.ownerId, project.ownerId);
  assert.equal(renamed.status, project.status);
  assert.deepEqual(renamed.spec, project.spec);
});
