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

/**
 * Regression test for a real gap round 313's Explore survey found, in the
 * same bug family as rounds 311/312: a constraint correctly applied on the
 * fresh-insert path silently broke the incremental-refine path, but here
 * the breakage isn't a missing FK -- it's that updateRecord revalidated
 * EVERY field against the entity's *current* definition, even ones the
 * caller never mentioned (`{ ...existing, ...data }` then coerceValue on
 * every field). A refine that narrows an existing enum field's allowed
 * values (or tightens required on an existing field) left old records
 * whose stored value no longer satisfies the new definition -- and any
 * future update to such a record, even one touching a completely
 * different field (an inline cell edit, a bulk field update, a Kanban
 * drag), would throw and permanently fail, forever, with no way to fix it
 * except editing the stale field directly through the full form.
 */
test("updateRecord only validates fields the caller actually supplies, not every field against the entity's current (possibly since-narrowed) definition", () => {
  const db = setup();
  // Inserted while "New" was still a valid Status -- the entity as it
  // existed before a later refine narrowed the enum.
  const created = insertRecord(db, "proj1", customer, { name: "Alice", status: "New" });

  const narrowedCustomer: Entity = {
    ...customer,
    fields: customer.fields.map((f) => (f.name === "status" ? { ...f, enumValues: ["Won"] } : f)),
  };

  // Updating a totally different field (name) must not re-validate the
  // untouched, now-stale status value against the narrowed enum.
  const updated = updateRecord(db, "proj1", narrowedCustomer, created.id as number, { name: "Alice Cohen" });
  assert.equal(updated.name, "Alice Cohen", "the field actually updated must take effect");
  assert.equal(updated.status, "New", "the untouched, now-stale field must keep its original stored value, not be silently dropped or default to null");

  // Explicitly setting the now-invalid field to something still outside
  // the narrowed enum must still be rejected -- the fix must not weaken
  // validation for a field the caller actually touches.
  assert.throws(
    () => updateRecord(db, "proj1", narrowedCustomer, created.id as number, { status: "New" }),
    ValidationError,
  );
});

test("updateRecord doesn't re-require a field that's now required but was optional when an existing row was created", () => {
  // A separate, boolean-free entity -- a boolean's own "unset" value
  // round-trips through rowToRecord's Boolean() coercion as `false`, which
  // never hits coerceValue's required check in the first place (only
  // undefined/null/"" do), so it wouldn't actually exercise this bug.
  const task: Entity = {
    name: "Task",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "notes", type: "text", required: false },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [task] });
  const created = insertRecord(db, "proj1", task, { title: "Buy milk" });
  assert.equal(created.notes, null, "notes was optional and unset at insert time");

  const tightenedTask: Entity = {
    ...task,
    fields: task.fields.map((f) => (f.name === "notes" ? { ...f, required: true } : f)),
  };

  // Updating the unrelated title field on a row whose "notes" is still
  // null must not throw "Field notes is required" -- notes was never
  // touched.
  const updated = updateRecord(db, "proj1", tightenedTask, created.id as number, { title: "Buy oat milk" });
  assert.equal(updated.title, "Buy oat milk");
  assert.equal(updated.notes, null, "the untouched field keeps its stored value even though it's now below the tightened requirement");
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
