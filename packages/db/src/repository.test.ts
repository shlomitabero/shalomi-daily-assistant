import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations } from "./migrate.js";
import {
  insertRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
  ValidationError,
  NotFoundError,
} from "./repository.js";

const customer: Entity = {
  name: "Customer",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "vip", type: "boolean", required: false },
    { name: "status", type: "enum", required: true, enumValues: ["New", "Won"] },
  ],
};

const spec: ProductSpec = {
  summary: "t",
  personas: [],
  roles: ["Admin"],
  entities: [customer],
  screens: [],
  assumptions: [],
  openQuestions: [],
};

function setup() {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  return db;
}

test("insertRecord then getRecord round-trips data including boolean coercion", () => {
  const db = setup();
  const created = insertRecord(db, "proj1", customer, { name: "Alice", vip: true, status: "New" });
  assert.equal(created.name, "Alice");
  assert.equal(created.vip, true);
  const fetched = getRecord(db, "proj1", customer, created.id as number);
  assert.deepEqual(fetched, created);
});

test("listRecords returns newest first", () => {
  const db = setup();
  insertRecord(db, "proj1", customer, { name: "First", status: "New" });
  insertRecord(db, "proj1", customer, { name: "Second", status: "New" });
  const rows = listRecords(db, "proj1", customer);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Second");
});

test("insertRecord rejects a missing required field", () => {
  const db = setup();
  assert.throws(() => insertRecord(db, "proj1", customer, { status: "New" }), ValidationError);
});

test("insertRecord rejects a value outside the enum", () => {
  const db = setup();
  assert.throws(
    () => insertRecord(db, "proj1", customer, { name: "Alice", status: "Nope" }),
    ValidationError,
  );
});

test("updateRecord merges fields and persists them", () => {
  const db = setup();
  const created = insertRecord(db, "proj1", customer, { name: "Alice", status: "New" });
  const updated = updateRecord(db, "proj1", customer, created.id as number, { status: "Won" });
  assert.equal(updated.status, "Won");
  assert.equal(updated.name, "Alice");
});

test("updateRecord on a missing id throws NotFoundError", () => {
  const db = setup();
  assert.throws(() => updateRecord(db, "proj1", customer, 999, { status: "Won" }), NotFoundError);
});

test("deleteRecord removes the row; a second delete throws NotFoundError", () => {
  const db = setup();
  const created = insertRecord(db, "proj1", customer, { name: "Alice", status: "New" });
  deleteRecord(db, "proj1", customer, created.id as number);
  assert.equal(getRecord(db, "proj1", customer, created.id as number), undefined);
  assert.throws(() => deleteRecord(db, "proj1", customer, created.id as number), NotFoundError);
});
