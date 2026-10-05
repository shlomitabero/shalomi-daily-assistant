import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import {
  deleteCheckpoint,
  deleteCheckpointsForProject,
  ensureCheckpointsTable,
  getCheckpoint,
  insertCheckpoint,
  listCheckpoints,
  listHistoricalEntityNames,
  renameCheckpoint,
} from "./checkpoints.js";
import { NotFoundError } from "./repository.js";

const validSpec: ProductSpec = {
  summary: "test",
  personas: [],
  roles: ["Admin"],
  entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  screens: [],
  assumptions: [],
  openQuestions: [],
};

test("insertCheckpoint stores a checkpoint and returns it with a createdAt timestamp", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  const checkpoint = insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "before refine", kind: "refine", spec: validSpec });
  assert.equal(checkpoint.id, "cp1");
  assert.equal(checkpoint.label, "before refine");
  assert.equal(checkpoint.kind, "refine");
  assert.ok(checkpoint.createdAt);
});

test("listCheckpoints returns a project's checkpoints newest first", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "first", kind: "build", spec: validSpec });
  insertCheckpoint(db, { id: "cp2", projectId: "proj1", label: "second", kind: "refine", spec: validSpec });
  const checkpoints = listCheckpoints(db, "proj1");
  assert.deepEqual(
    checkpoints.map((c) => c.id),
    ["cp2", "cp1"],
  );
});

test("getCheckpoint returns undefined for a missing id", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  assert.equal(getCheckpoint(db, "missing"), undefined);
});

test("listCheckpoints still returns a project's good checkpoints when one stored spec no longer matches the current schema", () => {
  // Same reasoning as the identical fix in projects.ts: ProductSpecSchema
  // can only get stricter over time, so a checkpoint written by an older
  // version of this app -- and no longer parseable against today's schema
  // -- is a real, expected future case, not a hypothetical. This row is
  // inserted via raw SQL (bypassing insertCheckpoint, which would itself
  // require a valid spec) specifically to stand in for that.
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  const good = insertCheckpoint(db, { id: "good", projectId: "proj1", label: "good checkpoint", kind: "build", spec: validSpec });
  db.prepare(
    "INSERT INTO checkpoints (id, projectId, label, spec_json, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run("stale", "proj1", "stale checkpoint", JSON.stringify({ summary: "old spec, missing fields" }), new Date().toISOString());

  const checkpoints = listCheckpoints(db, "proj1");
  assert.deepEqual(
    checkpoints.map((c) => c.id),
    [good.id],
    "the one unparseable checkpoint should be excluded, not take down the whole Time Machine list for this project",
  );
});

test("getCheckpoint still throws clearly for a single checkpoint whose stored spec no longer matches the current schema", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  db.prepare(
    "INSERT INTO checkpoints (id, projectId, label, spec_json, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run("stale", "proj1", "stale checkpoint", JSON.stringify({ summary: "old spec, missing fields" }), new Date().toISOString());

  assert.throws(() => getCheckpoint(db, "stale"));
});

/**
 * New in this round: a checkpoint's label was previously only ever the
 * automatic one build/refine gave it -- no way to give an important one a
 * name that's actually memorable months later. renameCheckpoint updates
 * exactly the one checkpoint's own label and returns the freshly-updated
 * row, leaving a different checkpoint in the same project untouched.
 */
test("renameCheckpoint updates exactly the one checkpoint's own label, leaving a different checkpoint in the same project untouched", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "Initial build", kind: "build", spec: validSpec });
  insertCheckpoint(db, { id: "cp2", projectId: "proj1", label: "Refine: add invoices", kind: "refine", spec: validSpec });

  const renamed = renameCheckpoint(db, "proj1", "cp1", "before the pricing overhaul");

  assert.equal(renamed.id, "cp1");
  assert.equal(renamed.label, "before the pricing overhaul");
  assert.equal(getCheckpoint(db, "cp1")!.label, "before the pricing overhaul", "the real stored row must reflect the new label");
  assert.equal(getCheckpoint(db, "cp2")!.label, "Refine: add invoices", "the other checkpoint's own label must be completely untouched");
});

/**
 * Regression test for the real bug round 419 fixed: renaming a checkpoint
 * used to be indistinguishable, from getCheckpointType's point of view,
 * from the checkpoint having always had that label -- since "build" vs
 * "refine" was re-derived from the label's own "Refine:"/"שיפור:" prefix on
 * every read. Renaming a refine checkpoint to arbitrary memorable text
 * (CheckpointLabelEditor's own advertised use case) silently reclassified
 * it as "build" the moment its label stopped matching either prefix. kind
 * is now set once at insertCheckpoint and renameCheckpoint only ever
 * touches `label` (see its own doc-comment), so this must stay "refine"
 * through the rename.
 */
test("renameCheckpoint never changes a checkpoint's own kind, even when the new label no longer looks like a refine at all", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "Refine: add invoice tracking", kind: "refine", spec: validSpec });

  const renamed = renameCheckpoint(db, "proj1", "cp1", "before the pricing overhaul");

  assert.equal(renamed.kind, "refine", "the kind set at creation must survive a rename to text with no 'Refine:' prefix at all");
  assert.equal(getCheckpoint(db, "cp1")!.kind, "refine", "re-reading from storage must agree -- this isn't just the in-memory return value");
});

/**
 * The projectId scope in renameCheckpoint's own WHERE clause (mirroring
 * deleteWhatsAppMessage's convention, per round 208's own critical lesson:
 * a "renames the right checkpoint" test alone would never have caught a
 * missing scope) means a real checkpoint id that happens to belong to a
 * DIFFERENT project can never be renamed by passing the wrong projectId --
 * it must be treated as not-found for that project, not silently succeed
 * against someone else's checkpoint.
 */
test("renameCheckpoint throws NotFoundError for a real checkpoint id that belongs to a different project", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj2", label: "belongs to proj2", kind: "build", spec: validSpec });

  assert.throws(() => renameCheckpoint(db, "proj1", "cp1", "hijacked label"), NotFoundError);
  assert.equal(getCheckpoint(db, "cp1")!.label, "belongs to proj2", "the checkpoint must still have its real, original label under its real project");
});

test("renameCheckpoint throws NotFoundError for an id that doesn't exist at all", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  assert.throws(() => renameCheckpoint(db, "proj1", "no-such-id", "new label"), NotFoundError);
});

/**
 * Regression test for ensureCheckpointsTable's own migration path: a table
 * created by an app version before `kind` existed has no such column at
 * all. ensureCheckpointsTable must add it (ADD COLUMN, additive-only, same
 * discipline migrate.ts uses everywhere else) and backfill every existing
 * row's kind from the exact label-prefix heuristic getCheckpointType used
 * to apply live, so every checkpoint already in the database before this
 * upgrade keeps reading as whatever it correctly was before -- the best
 * recoverable answer for data written before this column existed.
 */
test("ensureCheckpointsTable adds a missing kind column to a pre-existing table and backfills it from each row's own label", () => {
  const db = openDatabase(":memory:");
  // Stand in for a checkpoints table created by an app version before
  // `kind` existed -- the exact old CREATE TABLE, no kind column at all.
  db.exec(`
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      label TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  const insertOldRow = db.prepare("INSERT INTO checkpoints (id, projectId, label, spec_json, createdAt) VALUES (?, ?, ?, ?, ?)");
  insertOldRow.run("old-build", "proj1", "Initial build", JSON.stringify(validSpec), "2026-01-01T00:00:00.000Z");
  insertOldRow.run("old-refine-en", "proj1", "Refine: add invoices", JSON.stringify(validSpec), "2026-01-02T00:00:00.000Z");
  insertOldRow.run("old-build-he", "proj1", "בנייה ראשונית", JSON.stringify(validSpec), "2026-01-03T00:00:00.000Z");
  insertOldRow.run("old-refine-he", "proj1", "שיפור: הוספת חשבוניות", JSON.stringify(validSpec), "2026-01-04T00:00:00.000Z");

  ensureCheckpointsTable(db);

  assert.equal(getCheckpoint(db, "old-build")!.kind, "build");
  assert.equal(getCheckpoint(db, "old-refine-en")!.kind, "refine");
  assert.equal(getCheckpoint(db, "old-build-he")!.kind, "build");
  assert.equal(getCheckpoint(db, "old-refine-he")!.kind, "refine");

  // Running it again (every app startup) must stay a no-op -- the same
  // idempotence migrate.ts's own ALTER TABLE ADD COLUMN path requires.
  assert.doesNotThrow(() => ensureCheckpointsTable(db));
  assert.equal(getCheckpoint(db, "old-refine-en")!.kind, "refine", "re-running the migration must not re-derive or disturb an already-backfilled kind");
});

/**
 * Regression test for the real bug round 420 fixed: listAllCheckpointedEntityNames
 * re-derives a project's entity history live from whichever checkpoints
 * still happen to exist, so deleting a single checkpoint (an ordinary,
 * advertised cleanup action) can make it forget an entity name forever,
 * even though that entity genuinely had a real data table at some point.
 * listHistoricalEntityNames reads a durable, append-only ledger instead,
 * written once at insertCheckpoint and never pruned by deleteCheckpoint.
 */
test("listHistoricalEntityNames still remembers an entity name after the one checkpoint that mentioned it is deleted", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  const specWithOrder: ProductSpec = {
    ...validSpec,
    entities: [...validSpec.entities, { name: "Order", fields: [{ name: "total", type: "number", required: true }] }],
  };
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "build", kind: "build", spec: validSpec });
  insertCheckpoint(db, { id: "cp2", projectId: "proj1", label: "refine: add Order", kind: "refine", spec: specWithOrder });

  deleteCheckpoint(db, "proj1", "cp2");

  assert.deepEqual(
    listHistoricalEntityNames(db, "proj1").sort(),
    ["Customer", "Order"],
    "Order must still be remembered even though cp2 -- the only checkpoint that ever mentioned it -- is gone",
  );
});

test("listHistoricalEntityNames is scoped per project -- one project's history never leaks into another's", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "build", kind: "build", spec: validSpec });
  const otherSpec: ProductSpec = { ...validSpec, entities: [{ name: "Vendor", fields: [] }] };
  insertCheckpoint(db, { id: "cp2", projectId: "proj2", label: "build", kind: "build", spec: otherSpec });

  assert.deepEqual(listHistoricalEntityNames(db, "proj1"), ["Customer"]);
  assert.deepEqual(listHistoricalEntityNames(db, "proj2"), ["Vendor"]);
});

test("deleteCheckpointsForProject clears this project's own history ledger too, without touching another project's", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "build", kind: "build", spec: validSpec });
  const otherSpec: ProductSpec = { ...validSpec, entities: [{ name: "Vendor", fields: [] }] };
  insertCheckpoint(db, { id: "cp2", projectId: "proj2", label: "build", kind: "build", spec: otherSpec });

  deleteCheckpointsForProject(db, "proj1");

  assert.deepEqual(listHistoricalEntityNames(db, "proj1"), [], "proj1's own ledger rows must be gone");
  assert.deepEqual(listHistoricalEntityNames(db, "proj2"), ["Vendor"], "proj2's ledger must be completely untouched");
});

/**
 * Regression test for ensureCheckpointsTable's backfill of
 * checkpoint_entity_history itself: a database that predates this table
 * has real checkpoints (and a real project) whose entity names were never
 * recorded anywhere but the spec_json text itself. Stands in for that by
 * creating the checkpoints and projects tables directly via raw SQL (no
 * ledger table at all yet) before calling ensureCheckpointsTable.
 */
test("ensureCheckpointsTable backfills checkpoint_entity_history from both pre-existing checkpoints and each project's own current spec", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      label TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, spec_json TEXT NOT NULL)`);
  const checkpointSpec: ProductSpec = { ...validSpec, entities: [{ name: "Order", fields: [] }] };
  db.prepare("INSERT INTO checkpoints (id, projectId, label, spec_json, createdAt) VALUES (?, ?, ?, ?, ?)").run(
    "old-cp",
    "proj1",
    "Initial build",
    JSON.stringify(checkpointSpec),
    "2026-01-01T00:00:00.000Z",
  );
  // The project's own CURRENT spec mentions a different entity than any
  // checkpoint does -- e.g. a refine whose own checkpoint write predates
  // this ledger's existence in an even older app version.
  const currentSpec: ProductSpec = { ...validSpec, entities: [{ name: "Invoice", fields: [] }] };
  db.prepare("INSERT INTO projects (id, spec_json) VALUES (?, ?)").run("proj1", JSON.stringify(currentSpec));

  ensureCheckpointsTable(db);

  assert.deepEqual(
    listHistoricalEntityNames(db, "proj1").sort(),
    ["Invoice", "Order"],
    "the backfill must capture entity names from both the pre-existing checkpoint and the project's own current spec",
  );
});
