import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { ensureCheckpointsTable, getCheckpoint, insertCheckpoint, listCheckpoints } from "./checkpoints.js";

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
  const checkpoint = insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "before refine", spec: validSpec });
  assert.equal(checkpoint.id, "cp1");
  assert.equal(checkpoint.label, "before refine");
  assert.ok(checkpoint.createdAt);
});

test("listCheckpoints returns a project's checkpoints newest first", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "first", spec: validSpec });
  insertCheckpoint(db, { id: "cp2", projectId: "proj1", label: "second", spec: validSpec });
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
  const good = insertCheckpoint(db, { id: "good", projectId: "proj1", label: "good checkpoint", spec: validSpec });
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
