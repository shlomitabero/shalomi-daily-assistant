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

/**
 * Regression test (round 546): coerceValue's boolean branch used to have
 * no rejection path at all, unlike every other branch in this same
 * function (number/relation, enum, date) -- any value outside the exact
 * true/false allowlist silently became `false` and was written to the DB
 * with the write still reporting success. This is the actual
 * persistence-layer validator every record write funnels through
 * (routes/projects.ts passes req.body straight into insertRecord/
 * updateRecord with no schema above it), so a malformed boolean from a
 * direct API call -- not just the already-fixed CSV-import path (round
 * 514) -- used to be silently corrupted rather than rejected.
 */
test("insertRecord accepts every recognized true/false form for a boolean field", () => {
  const db = setup();
  for (const [raw, expected] of [
    [true, true],
    ["true", true],
    [1, true],
    ["1", true],
    [false, false],
    ["false", false],
    [0, false],
    ["0", false],
  ] as const) {
    const created = insertRecord(db, "proj1", customer, { name: "Alice", vip: raw, status: "New" });
    assert.equal(created.vip, expected, `expected ${JSON.stringify(raw)} to coerce to ${expected}`);
  }
});

test("insertRecord rejects a boolean field value outside the true/false allowlist, instead of silently storing it as false", () => {
  const db = setup();
  for (const bad of ["yes", "no", "TRUE", "כן", "לא", 2, "banana"]) {
    assert.throws(
      () => insertRecord(db, "proj1", customer, { name: "Alice", vip: bad, status: "New" }),
      ValidationError,
      `expected ${JSON.stringify(bad)} to be rejected as an invalid boolean`,
    );
  }
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

test("insertRecord accepts a date in the year 0-99 range, instead of wrongly rejecting it as invalid", () => {
  // new Date(Date.UTC(year, ...)) silently adds 1900 to a year 0-99 (legacy
  // ECMA-262 behavior), so isValidDateString's own round-trip check used to
  // fail a syntactically valid "0099-01-01" -- a real, well-formed date.
  const db = setupAppointment();
  const created = insertRecord(db, "proj1", appointment, { customerName: "Alice", date: "0099-01-01" });
  assert.equal(created.date, "0099-01-01");
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

/**
 * Regression test for round 408: coerceValue's required-field check only
 * ever tested for the literal empty string (`raw === ""`), so a
 * whitespace-only value (" ", "\t\n", …) skipped it entirely and fell
 * straight into `Number(raw)` for a "number"/"relation" field --
 * `Number(" ")` is a genuine JS quirk (`0`, not `NaN`), so the field
 * silently got a real stored `0` instead of the ValidationError every
 * other "no real value given" case already throws.
 */
test("insertRecord rejects a whitespace-only value for a required number field, instead of silently coercing it to 0", () => {
  const invoice: Entity = {
    name: "Invoice",
    fields: [
      { name: "label", type: "text", required: true },
      { name: "amount", type: "number", required: true },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [invoice] });

  for (const whitespace of [" ", "\t", "\n", "  \t  "]) {
    assert.throws(
      () => insertRecord(db, "proj1", invoice, { label: "Rent", amount: whitespace }),
      ValidationError,
      `expected ${JSON.stringify(whitespace)} to be rejected, not coerced to 0`,
    );
  }

  const created = insertRecord(db, "proj1", invoice, { label: "Rent", amount: 500 });
  assert.equal(created.amount, 500);
});

/**
 * Regression test (round 523): Number("Infinity")/Number("-Infinity") is
 * Infinity, not NaN, so a NaN-only check let it through -- but a literal
 * Infinity isn't valid JSON, so by the time any client request reaches
 * here via JSON.stringify it has already silently become null. A raw
 * "Infinity" string reaching coerceValue directly (e.g. a non-browser
 * caller) must still be rejected as cleanly as any other bad number.
 */
test("insertRecord rejects \"Infinity\"/\"-Infinity\" for a number field, instead of silently accepting it", () => {
  const invoice: Entity = {
    name: "Invoice",
    fields: [
      { name: "label", type: "text", required: true },
      { name: "amount", type: "number", required: false },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [invoice] });

  for (const value of ["Infinity", "-Infinity"]) {
    assert.throws(
      () => insertRecord(db, "proj1", invoice, { label: "Rent", amount: value }),
      ValidationError,
      `expected ${JSON.stringify(value)} to be rejected as not a real number`,
    );
  }
});

/**
 * Regression test for round 604: JS's own array-to-number coercion is the
 * same quirk the whitespace-string (408) and "Infinity"-string (523) fixes
 * above already guard against -- Number([]) is 0 and Number([42]) is 42,
 * not NaN, so an array raw value passed Number.isFinite and was silently
 * stored as a real number/foreign-key id instead of being rejected. For a
 * *required* field this also bypassed the required-check entirely, since
 * isEmpty doesn't recognize an array as "no real value" either.
 */
test("insertRecord rejects an array value for a required number field, instead of silently coercing it via Number([])", () => {
  const invoice: Entity = {
    name: "Invoice",
    fields: [
      { name: "label", type: "text", required: true },
      { name: "amount", type: "number", required: true },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [invoice] });

  assert.throws(
    () => insertRecord(db, "proj1", invoice, { label: "Rent", amount: [] }),
    ValidationError,
    "expected [] to be rejected, not coerced to 0",
  );
  assert.throws(
    () => insertRecord(db, "proj1", invoice, { label: "Rent", amount: [42] }),
    ValidationError,
    "expected [42] to be rejected, not coerced to 42",
  );

  const created = insertRecord(db, "proj1", invoice, { label: "Rent", amount: 500 });
  assert.equal(created.amount, 500);
});

/**
 * Same bug, but for a required "relation" field: before the fix, a
 * whitespace-only value coerced to foreign key `0` and hit the real
 * `REFERENCES ... (id)` constraint (migrate.ts), throwing a bare SQLite
 * "FOREIGN KEY constraint failed" error instead of the same clean
 * ValidationError every other invalid-input path produces.
 */
test("insertRecord rejects a whitespace-only value for a required relation field with a clean ValidationError, not a raw foreign-key error", () => {
  const customerEntity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const order: Entity = {
    name: "Order",
    fields: [
      { name: "total", type: "number", required: true },
      { name: "customerId", type: "relation", required: true, relationTo: "Customer" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [customerEntity, order] });

  assert.throws(
    () => insertRecord(db, "proj1", order, { total: 10, customerId: "  " }),
    ValidationError,
    "a whitespace-only relation value must be rejected as a missing required field, not hit the FK constraint as a fabricated id 0",
  );
});

/**
 * The same whitespace-only value must also be treated as "nothing given"
 * for a field that ISN'T required -- not stored as a fabricated 0 (for a
 * number) or as the literal whitespace string itself (for text), matching
 * entityFormatting.ts's own CSV import convention of trimming before
 * checking for emptiness.
 */
test("insertRecord treats a whitespace-only value as null for an optional number field and an optional text field alike", () => {
  const note: Entity = {
    name: "Note",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "priority", type: "number", required: false },
      { name: "body", type: "text", required: false },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [note] });

  const created = insertRecord(db, "proj1", note, { title: "Reminder", priority: "   ", body: "\t" });
  assert.equal(created.priority, null, "a whitespace-only optional number must become null, not a fabricated 0");
  assert.equal(created.body, null, "a whitespace-only optional text value must become null too, not the literal whitespace string");
});
