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
  countRecords,
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

const appointment: Entity = {
  name: "Appointment",
  fields: [
    { name: "customerName", type: "text", required: true },
    { name: "date", type: "date", required: true },
    { name: "followUp", type: "date", required: false },
  ],
};

function setupAppointment() {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [appointment] });
  return db;
}

test("insertRecord accepts a real calendar date in YYYY-MM-DD format", () => {
  const db = setupAppointment();
  const created = insertRecord(db, "proj1", appointment, { customerName: "Alice", date: "2026-03-15" });
  assert.equal(created.date, "2026-03-15");
});

test("insertRecord rejects a date field value that isn't a real, well-formed calendar date", () => {
  const db = setupAppointment();
  for (const bad of ["not-a-real-date-at-all", "2024/01/15", "15-01-2024", "2024-13-45", "2024-02-30"]) {
    assert.throws(
      () => insertRecord(db, "proj1", appointment, { customerName: "Alice", date: bad }),
      ValidationError,
      `expected "${bad}" to be rejected as an invalid date`,
    );
  }
});

test("insertRecord leaves an optional, unset date field as null rather than requiring a value", () => {
  const db = setupAppointment();
  const created = insertRecord(db, "proj1", appointment, { customerName: "Alice", date: "2026-03-15" });
  assert.equal(created.followUp, null);
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

test("countRecords reflects inserts and deletes", () => {
  const db = setup();
  assert.equal(countRecords(db, "proj1", customer), 0);
  const a = insertRecord(db, "proj1", customer, { name: "Alice", status: "New" });
  insertRecord(db, "proj1", customer, { name: "Bob", status: "New" });
  assert.equal(countRecords(db, "proj1", customer), 2);
  deleteRecord(db, "proj1", customer, a.id as number);
  assert.equal(countRecords(db, "proj1", customer), 1);
});

test("a field named after a SQL reserved keyword (e.g. 'order') works end-to-end through create/read/update/delete", () => {
  // assertSafeIdentifier only checks character composition
  // ([A-Za-z][A-Za-z0-9_]*), not against SQLite's reserved-word list, and
  // field/column names (unlike table names, which tableNameFor always
  // prefixes with "entity_<projectId>_") are used as bare, unprefixed SQL
  // identifiers. A field plausibly named "order" (sort order), "group",
  // "key", "index", "default", "check", "references", "value", etc. is a
  // completely ordinary business field name that an LLM-generated or
  // heuristic spec could produce, and this codebase already independently
  // discovered and fixed the identical problem once, in the exported
  // standalone app's own codegen (see codegen.ts's q() helper and its
  // comment about "an entity or field name that happens to be a SQL
  // keyword") -- but never applied the same fix to this, the live app's
  // own database layer.
  const withReservedFields: Entity = {
    name: "Task",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "order", type: "number", required: false },
      { name: "group", type: "text", required: false },
    ],
  };
  const specWithReserved: ProductSpec = { ...spec, entities: [withReservedFields] };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", specWithReserved);

  const created = insertRecord(db, "proj1", withReservedFields, { title: "Ship it", order: 1, group: "eng" });
  assert.equal(created.order, 1);
  assert.equal(created.group, "eng");

  const fetched = getRecord(db, "proj1", withReservedFields, created.id as number);
  assert.deepEqual(fetched, created);

  const rows = listRecords(db, "proj1", withReservedFields);
  assert.equal(rows.length, 1);

  const updated = updateRecord(db, "proj1", withReservedFields, created.id as number, { order: 2 });
  assert.equal(updated.order, 2);

  deleteRecord(db, "proj1", withReservedFields, created.id as number);
  assert.equal(getRecord(db, "proj1", withReservedFields, created.id as number), undefined);
});
