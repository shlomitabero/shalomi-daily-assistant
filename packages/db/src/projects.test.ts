import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { ensureProjectCollaboratorsTable, addCollaborator, isCollaborator } from "./collaborators.js";
import { ensureCheckpointsTable, insertCheckpoint, listCheckpoints } from "./checkpoints.js";
import { applyMigrations } from "./migrate.js";
import { insertRecord } from "./repository.js";
import {
  ensureWhatsAppConnectionsTable,
  ensureWhatsAppMessagesTable,
  recordWhatsAppConnected,
  insertWhatsAppMessage,
  getWhatsAppConnection,
  listWhatsAppMessages,
} from "./whatsapp.js";
import {
  ensureProjectsTable,
  deleteProject,
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

test("deleteProject removes the project row, its real generated data table, checkpoints, collaborators, and WhatsApp history -- not just some of them", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureProjectCollaboratorsTable(db);
  ensureCheckpointsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const project = insertProject(db, {
    id: "to-delete",
    ownerId: "owner1",
    name: "Project to delete",
    description: "will be deleted",
    spec: validSpec,
  });
  applyMigrations(db, project.id, project.spec);
  const record = insertRecord(db, project.id, project.spec.entities[0], { name: "a real customer" });
  insertCheckpoint(db, { id: "cp1", projectId: project.id, label: "build", spec: project.spec });
  addCollaborator(db, project.id, "collaborator1");
  recordWhatsAppConnected(db, project.id, "15551234567");
  insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "in",
    fromNumber: "15551234567",
    toNumber: "15557654321",
    body: "hi",
    status: "received",
  });

  // A second, untouched project proves deleteProject scopes every cleanup
  // query to the deleted project's id -- not a blunt "wipe everything"
  // that would also destroy an unrelated project's own data.
  const other = insertProject(db, {
    id: "keep-me",
    ownerId: "owner1",
    name: "Untouched project",
    description: "must survive",
    spec: validSpec,
  });
  applyMigrations(db, other.id, other.spec);
  insertRecord(db, other.id, other.spec.entities[0], { name: "a customer that must survive" });
  insertCheckpoint(db, { id: "cp-other", projectId: other.id, label: "build", spec: other.spec });
  addCollaborator(db, other.id, "collaborator1");
  recordWhatsAppConnected(db, other.id, "15559999999");

  assert.equal(record.id > 0, true, "sanity check: the record was really inserted before deleting");

  deleteProject(db, project);

  assert.equal(getProject(db, project.id), undefined, "the project row itself should be gone");
  assert.deepEqual(listCheckpoints(db, project.id), [], "checkpoints should be gone");
  assert.equal(isCollaborator(db, project.id, "collaborator1"), false, "collaborator grant should be gone");
  assert.equal(getWhatsAppConnection(db, project.id), undefined, "WhatsApp connection row should be gone");
  assert.deepEqual(listWhatsAppMessages(db, project.id), [], "WhatsApp message log should be gone");
  assert.throws(
    () => db.prepare(`SELECT * FROM "entity_to_delete_Customer"`).all(),
    /no such table/,
    "the project's real generated data table should be dropped, not just orphaned",
  );

  // The untouched project must be completely unaffected.
  assert.notEqual(getProject(db, other.id), undefined, "the other project must still exist");
  assert.equal(listCheckpoints(db, other.id).length, 1, "the other project's checkpoint must survive");
  assert.equal(isCollaborator(db, other.id, "collaborator1"), true, "the other project's collaborator must survive");
  assert.notEqual(getWhatsAppConnection(db, other.id), undefined, "the other project's WhatsApp connection must survive");
  const otherCount = db.prepare(`SELECT COUNT(*) as c FROM "entity_keep_me_Customer"`).get() as { c: number };
  assert.equal(otherCount.c, 1, "the other project's real data table and its row must survive");
});
