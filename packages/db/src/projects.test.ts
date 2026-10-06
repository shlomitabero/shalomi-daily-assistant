import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { ensureProjectCollaboratorsTable, addCollaborator, removeCollaborator, isCollaborator } from "./collaborators.js";
import { ensureCheckpointsTable, insertCheckpoint, listCheckpoints, deleteCheckpoint } from "./checkpoints.js";
import { applyMigrations, diffAndMigrate } from "./migrate.js";
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
  listOwnedProjectIds,
  listProjectsForOwner,
  listProjectsForUser,
  updateProjectName,
  updateProjectDescription,
  updateProjectSpec,
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

test("listProjectsForUser exposes the collaborator's own addedAt as sharedAt on a shared project, and leaves it undefined on a project this user owns", () => {
  // Round 405: the web app's "New share" chip (sharedProjectSeen.ts) needs
  // a per-grant timestamp to tell one share from the next, not just
  // whether the project id was ever opened before -- this is the field it
  // reads.
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureProjectCollaboratorsTable(db);
  const owned = insertProject(db, { id: "owned", ownerId: "alice", name: "Alice's project", description: "test", spec: validSpec });
  const shared = insertProject(db, { id: "shared", ownerId: "bob", name: "Bob's project", description: "test", spec: validSpec });
  addCollaborator(db, shared.id, "alice");

  const projects = listProjectsForUser(db, "alice");
  const ownedResult = projects.find((p) => p.id === owned.id);
  const sharedResult = projects.find((p) => p.id === shared.id);
  assert.equal(ownedResult?.sharedAt, undefined, "a project alice owns herself must never carry a sharedAt");
  assert.equal(typeof sharedResult?.sharedAt, "string", "a project alice collaborates on must carry the collaborator row's own addedAt as sharedAt");
});

test("listProjectsForUser reports a fresh, later sharedAt once a removed collaborator is re-invited to the same project", (t) => {
  // The exact bug round 405 fixes: without this, a collaborator who was
  // removed and later re-added would never see the home screen's "New
  // share" chip again, because the old flat "ever seen this project id"
  // marker (round 401) had no way to tell the second invite apart from
  // the first. Mocking Date (same technique as BuildProgress.test.ts's
  // elapsed-timer test) makes the two addedAt values deterministically
  // different, rather than relying on real wall-clock time to advance
  // between two synchronous calls -- the exact createdAt-tie risk this
  // same file already calls out for listProjectsForOwner above.
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureProjectCollaboratorsTable(db);
  const project = insertProject(db, { id: "p1", ownerId: "bob", name: "test", description: "test", spec: validSpec });

  t.mock.timers.enable({ apis: ["Date"] });
  try {
    addCollaborator(db, project.id, "alice");
    const firstSharedAt = listProjectsForUser(db, "alice").find((p) => p.id === project.id)?.sharedAt;
    assert.equal(typeof firstSharedAt, "string");

    removeCollaborator(db, project.id, "alice");
    assert.deepEqual(listProjectsForUser(db, "alice").map((p) => p.id), [], "alice must lose access once removed");

    t.mock.timers.tick(1000);
    addCollaborator(db, project.id, "alice");
    const secondSharedAt = listProjectsForUser(db, "alice").find((p) => p.id === project.id)?.sharedAt;
    assert.equal(typeof secondSharedAt, "string");
    assert.notEqual(secondSharedAt, firstSharedAt, "re-inviting after a removal must produce a new sharedAt, not resurrect the original grant's timestamp");
  } finally {
    t.mock.timers.reset();
  }
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

test("updateProjectDescription changes only the description, leaving every other field (name, spec, status, ownerId) untouched", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  const project = insertProject(db, {
    id: "p1",
    ownerId: "owner1",
    name: "My Business",
    description: "track customer payments by mistake, meant appointments",
    spec: validSpec,
  });

  const updated = updateProjectDescription(db, project.id, "A CRM to track customer appointments.");
  assert.equal(updated.description, "A CRM to track customer appointments.");
  assert.equal(updated.name, project.name);
  assert.equal(updated.ownerId, project.ownerId);
  assert.equal(updated.status, project.status);
  assert.deepEqual(updated.spec, project.spec);
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
  insertCheckpoint(db, { id: "cp1", projectId: project.id, label: "build", kind: "build", spec: project.spec });
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
  insertCheckpoint(db, { id: "cp-other", projectId: other.id, label: "build", kind: "build", spec: other.spec });
  addCollaborator(db, other.id, "collaborator1");
  recordWhatsAppConnected(db, other.id, "15559999999");

  assert.equal(record.id > 0, true, "sanity check: the record was really inserted before deleting");

  deleteProject(db, project.id);

  assert.equal(getProject(db, project.id), undefined, "the project row itself should be gone");
  assert.deepEqual(listCheckpoints(db, project.id), [], "checkpoints should be gone");
  assert.equal(isCollaborator(db, project.id, "collaborator1"), false, "collaborator grant should be gone");
  assert.equal(getWhatsAppConnection(db, project.id), undefined, "WhatsApp connection row should be gone");
  assert.deepEqual(listWhatsAppMessages(db, project.id), { messages: [], hasMore: false }, "WhatsApp message log should be gone");
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

/**
 * migrate.ts's diffAndMigrate is deliberately additive-only -- it never
 * drops a table for an entity removed from the spec (see its own comment).
 * deleteProject used to drop tables only for project.spec.entities, the
 * *current* spec -- so a real build -> refine (adds Order) -> refine
 * (removes Order from the spec again) -> delete project sequence left
 * Order's own real data table, with real rows, permanently orphaned: no
 * project row pointing at it, and deleteProject's own entity loop never
 * saw its name because it had already been refined back out of the spec.
 * Every successful build/refine inserts exactly one checkpoint with its
 * resulting spec (pipeline.ts), so this reproduces the exact real
 * sequence via raw diffAndMigrate + insertCheckpoint calls, the same way
 * the actual pipeline does it, rather than asserting against a contrived
 * fixture.
 */
test("deleteProject drops the real data table of an entity that was added then later removed from the spec, not just the entities still in the current spec", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  ensureProjectCollaboratorsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const buildSpec: ProductSpec = validSpec;
  const project = insertProject(db, {
    id: "proj-orphan",
    ownerId: "owner1",
    name: "Project with a removed entity",
    description: "test",
    spec: buildSpec,
  });
  diffAndMigrate(db, project.id, undefined, buildSpec);
  insertCheckpoint(db, { id: "cp-build", projectId: project.id, label: "build", kind: "build", spec: buildSpec });

  // Refine #1: adds a real "Order" entity. Its table gets created and real
  // data gets inserted into it, exactly like a real user would do before
  // ever refining it back out.
  const specWithOrder: ProductSpec = {
    ...buildSpec,
    entities: [...buildSpec.entities, { name: "Order", fields: [{ name: "total", type: "number", required: true }] }],
  };
  diffAndMigrate(db, project.id, buildSpec, specWithOrder);
  insertRecord(db, project.id, specWithOrder.entities[1], { total: 42 });
  insertCheckpoint(db, { id: "cp-refine1", projectId: project.id, label: "refine: add Order", kind: "refine", spec: specWithOrder });

  // Refine #2: removes Order from the spec again. diffAndMigrate is
  // additive-only, so the real table (and its row) is left untouched --
  // only the spec itself stops listing it.
  diffAndMigrate(db, project.id, specWithOrder, buildSpec);
  insertCheckpoint(db, { id: "cp-refine2", projectId: project.id, label: "refine: remove Order", kind: "refine", spec: buildSpec });
  const finalProject = updateProjectSpec(db, project.id, buildSpec);

  assert.doesNotThrow(
    () => db.prepare(`SELECT COUNT(*) as c FROM "entity_proj_orphan_Order"`).get(),
    "sanity check: Order's real table must still exist (and still have its row) before delete -- migrations never drop it",
  );

  deleteProject(db, finalProject.id);

  assert.equal(getProject(db, project.id), undefined, "the project row itself should be gone");
  assert.throws(
    () => db.prepare(`SELECT * FROM "entity_proj_orphan_Customer"`).all(),
    /no such table/,
    "the entity still in the final spec must be dropped as before",
  );
  assert.throws(
    () => db.prepare(`SELECT * FROM "entity_proj_orphan_Order"`).all(),
    /no such table/,
    "Order's table must ALSO be dropped even though it was removed from the spec before deletion -- it's not an orphan left behind",
  );
});

/**
 * round 420: the fix above (round 409's listAllCheckpointedEntityNames)
 * re-derives this project's entity history live from whichever checkpoints
 * still exist right now -- but deleteCheckpoint (round 216) is a real,
 * advertised, ordinary cleanup action ("an experimental refine that went
 * nowhere"), and nothing about it considers deleteProject's own later
 * reliance on checkpoint history as the sole record of entities since
 * removed from the spec. If the ONE checkpoint that still mentioned Order
 * is deleted before the project itself is, listAllCheckpointedEntityNames
 * can no longer see "Order" anywhere -- the exact same orphaned-table bug
 * the test above closed, reopened by a completely different, unrelated
 * feature acting on the very history deleteProject depends on.
 * listHistoricalEntityNames (the durable ledger written at every
 * insertCheckpoint, never pruned by deleteCheckpoint) is the fix: this
 * test is identical to the one above except the build checkpoint -- the
 * only one ever to mention Order -- is explicitly deleted before deleting
 * the project.
 */
test("deleteProject still drops a real data table even when the one checkpoint that ever mentioned it was itself deleted first", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  ensureProjectCollaboratorsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const buildSpec: ProductSpec = validSpec;
  const project = insertProject(db, {
    id: "proj-pruned",
    ownerId: "owner1",
    name: "Project whose own history gets pruned",
    description: "test",
    spec: buildSpec,
  });
  diffAndMigrate(db, project.id, undefined, buildSpec);
  insertCheckpoint(db, { id: "cp-build", projectId: project.id, label: "build", kind: "build", spec: buildSpec });

  const specWithOrder: ProductSpec = {
    ...buildSpec,
    entities: [...buildSpec.entities, { name: "Order", fields: [{ name: "total", type: "number", required: true }] }],
  };
  diffAndMigrate(db, project.id, buildSpec, specWithOrder);
  insertRecord(db, project.id, specWithOrder.entities[1], { total: 42 });
  insertCheckpoint(db, { id: "cp-refine1", projectId: project.id, label: "refine: add Order", kind: "refine", spec: specWithOrder });

  // Refine back out: only "cp-refine1" (and nothing else yet) still
  // mentions Order in its own spec_json.
  diffAndMigrate(db, project.id, specWithOrder, buildSpec);
  insertCheckpoint(db, { id: "cp-refine2", projectId: project.id, label: "refine: remove Order", kind: "refine", spec: buildSpec });
  const finalProject = updateProjectSpec(db, project.id, buildSpec);

  // The real, user-facing single-checkpoint-delete action -- an ordinary
  // cleanup of the one checkpoint that ever mentioned Order.
  deleteCheckpoint(db, project.id, "cp-refine1");
  assert.deepEqual(
    listCheckpoints(db, project.id).map((c) => c.id).sort(),
    ["cp-build", "cp-refine2"],
    "sanity check: cp-refine1 (the only mention of Order) is really gone from the checkpoint history",
  );

  assert.doesNotThrow(
    () => db.prepare(`SELECT COUNT(*) as c FROM "entity_proj_pruned_Order"`).get(),
    "sanity check: Order's real table must still exist (and still have its row) before delete -- migrations never drop it, and deleting a checkpoint never touches real data tables",
  );

  deleteProject(db, finalProject.id);

  assert.equal(getProject(db, project.id), undefined, "the project row itself should be gone");
  assert.throws(
    () => db.prepare(`SELECT * FROM "entity_proj_pruned_Order"`).all(),
    /no such table/,
    "Order's table must still be dropped, even though the one checkpoint that ever mentioned it was deleted before the project was",
  );
});

/**
 * round 409: the fix above (reading every checkpoint's entities) used
 * listCheckpoints, which silently excludes any checkpoint row whose
 * *other* fields (roles, summary, ...) no longer satisfy today's
 * ProductSpecSchema -- the right behavior for a user-facing history list
 * (see checkpoints.ts's own tryRowToCheckpoint), but wrong here: it would
 * drop that checkpoint's entities from deleteProject's own accounting,
 * leaving their real tables orphaned all over again -- a narrower repeat
 * of the exact bug the test above already closed. This checkpoint row is
 * inserted directly via raw SQL (bypassing insertCheckpoint, which would
 * itself require a valid spec) to stand in for a checkpoint written by an
 * older app version: its spec_json has no `roles` at all, which fails
 * today's `roles: z.array(z.string()).min(1)`, but its `entities` array
 * is perfectly readable.
 */
test("deleteProject still drops the real data table of an entity from a checkpoint whose stored spec no longer parses against today's schema", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  ensureProjectCollaboratorsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const buildSpec: ProductSpec = validSpec;
  const project = insertProject(db, {
    id: "proj-stale-cp",
    ownerId: "owner1",
    name: "Project with a stale checkpoint",
    description: "test",
    spec: buildSpec,
  });
  diffAndMigrate(db, project.id, undefined, buildSpec);
  insertCheckpoint(db, { id: "cp-build", projectId: project.id, label: "build", kind: "build", spec: buildSpec });

  // Refine: adds a real "Order" entity, with a real row. Its own checkpoint
  // is written directly (not via insertCheckpoint) with no `roles` field --
  // standing in for a checkpoint written before `roles` existed/was
  // required, which fails ProductSpecSchema.parse today.
  const specWithOrder: ProductSpec = {
    ...buildSpec,
    entities: [...buildSpec.entities, { name: "Order", fields: [{ name: "total", type: "number", required: true }] }],
  };
  diffAndMigrate(db, project.id, buildSpec, specWithOrder);
  insertRecord(db, project.id, specWithOrder.entities[1], { total: 42 });
  db.prepare(
    "INSERT INTO checkpoints (id, projectId, label, spec_json, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run("cp-stale", project.id, "refine: add Order", JSON.stringify({ summary: "test", entities: specWithOrder.entities }), new Date().toISOString());

  assert.equal(
    listCheckpoints(db, project.id).some((c) => c.id === "cp-stale"),
    false,
    "sanity check: the stale checkpoint must actually fail to parse and be excluded from listCheckpoints, or this test isn't exercising the gap",
  );

  // Refine back out: Order leaves the spec again, its table and row left
  // untouched by the (additive-only) migration, exactly like the test above.
  diffAndMigrate(db, project.id, specWithOrder, buildSpec);
  const finalProject = updateProjectSpec(db, project.id, buildSpec);

  deleteProject(db, finalProject.id);

  assert.equal(getProject(db, project.id), undefined, "the project row itself should be gone");
  assert.throws(
    () => db.prepare(`SELECT * FROM "entity_proj_stale_cp_Order"`).all(),
    /no such table/,
    "Order's table must be dropped even though the only checkpoint that ever mentioned it fails to parse under today's schema",
  );
});

/**
 * round 411: DELETE /auth/account (apps/api/src/routes/auth.ts) used to
 * compute which projects to clean up via listProjectsForUser -- the exact
 * same "tolerant listing used where completeness is needed" gap round 409
 * already closed for checkpoints, just one level up. A project row can
 * fail ProductSpecSchema.parse too (tryRowToProject's own comment: a real,
 * expected case for an older project, not a hypothetical), and
 * listProjectsForUser/listProjectsForOwner silently exclude it -- fine for
 * a user-facing list, wrong for a cleanup that must see every row. This
 * project is written directly via raw SQL (bypassing insertProject, which
 * would itself require a valid spec) with no `roles` field, standing in
 * for a project written by an older app version.
 */
test("listOwnedProjectIds still returns a project whose stored spec no longer parses against today's schema, unlike listProjectsForOwner", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);

  insertProject(db, { id: "proj-good", ownerId: "owner1", name: "Good project", description: "test", spec: validSpec });
  db.prepare(
    "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("proj-stale", "owner1", "Stale project", "test", JSON.stringify({ summary: "test", entities: validSpec.entities }), "draft", new Date().toISOString());

  assert.deepEqual(
    listProjectsForOwner(db, "owner1").map((p) => p.id),
    ["proj-good"],
    "sanity check: listProjectsForOwner must actually exclude the stale project, or this test isn't exercising the gap",
  );
  assert.deepEqual(
    listOwnedProjectIds(db, "owner1").slice().sort(),
    ["proj-good", "proj-stale"],
    "listOwnedProjectIds must see the stale project too -- it never parses spec_json at all, so it can't miss a row this way",
  );
});

/**
 * The other half of round 411's fix: deleteProject itself used to take a
 * parsed Project (needing project.spec.entities), which made it just as
 * unable to clean up a project whose own spec fails to parse as the
 * listing gap above was. It now takes a bare project id and reads this
 * project's own spec_json the same tolerant way a checkpoint's is read
 * (extractEntityNamesFromSpecJson), so it can finish the job even when
 * getProject itself would throw for this exact row.
 */
test("deleteProject still drops the real data table, checkpoints, collaborators, and WhatsApp history of a project whose own stored spec no longer parses against today's schema", () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  ensureProjectCollaboratorsTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);

  const buildSpec: ProductSpec = validSpec;
  // No FOREIGN KEY ties any of these to a real `projects` row (confirmed
  // by reading collaborators.ts/whatsapp.ts's own table schemas), so all
  // of this project's real data can be created before its own `projects`
  // row is ever written below -- standing in for a project whose spec was
  // perfectly valid when it was built, but has since stopped parsing
  // against today's (stricter) schema.
  applyMigrations(db, "proj-stale-own", buildSpec);
  insertRecord(db, "proj-stale-own", buildSpec.entities[0], { name: "Dana" });
  insertCheckpoint(db, { id: "cp-stale-own", projectId: "proj-stale-own", label: "build", kind: "build", spec: buildSpec });
  addCollaborator(db, "proj-stale-own", "collaborator1");
  recordWhatsAppConnected(db, "proj-stale-own", "15559999999");

  db.prepare(
    "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("proj-stale-own", "owner1", "Stale project", "test", JSON.stringify({ summary: "test", entities: buildSpec.entities }), "draft", new Date().toISOString());

  // sanity check: this project's own spec_json must actually fail to
  // re-parse, or this test isn't exercising the gap.
  assert.throws(() => getProject(db, "proj-stale-own"));

  deleteProject(db, "proj-stale-own");

  assert.equal(
    db.prepare("SELECT * FROM projects WHERE id = ?").get("proj-stale-own"),
    undefined,
    "the project row itself should be gone even though its own spec never parsed",
  );
  assert.throws(
    () => db.prepare(`SELECT * FROM "entity_proj_stale_own_Customer"`).all(),
    /no such table/,
    "the real data table must be dropped even though deleteProject could never construct a valid Project for this row",
  );
  assert.deepEqual(listCheckpoints(db, "proj-stale-own"), [], "checkpoints should be gone too");
  assert.equal(isCollaborator(db, "proj-stale-own", "collaborator1"), false, "collaborator grant should be gone too");
  assert.equal(getWhatsAppConnection(db, "proj-stale-own"), undefined, "WhatsApp connection row should be gone too");
});
