import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations, diffAndMigrate } from "./migrate.js";
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

/**
 * Round 1134: rowToRecord used to run every boolean value through
 * Boolean(value) unconditionally, so a genuinely never-answered field (a
 * real stored SQL NULL -- coerceValue's own isEmpty check stores NULL,
 * not a default false, for an optional boolean left out of the insert)
 * silently round-tripped as `false`, indistinguishable from a box someone
 * actually unchecked. NULL is routine here, not a hypothetical: a refine
 * that adds a boolean field to an entity with existing rows (see
 * migrate.ts's own "NOT NULL deliberately omitted" column-add comment)
 * leaves every pre-existing record with exactly this real NULL until
 * someone edits it. Downstream consumers (CSV/backup export, the Business
 * Twin's enum-distribution breakdown, WhatsApp/email template
 * interpolation) each already had their own `value === null` guard
 * written and ready -- it was simply unreachable for booleans
 * specifically, since this function never let a real null survive this
 * far.
 */
test("insertRecord then getRecord round-trips a never-set optional boolean field as a real null, not false", () => {
  const db = setup();
  const created = insertRecord(db, "proj1", customer, { name: "Alice", status: "New" }); // vip omitted entirely
  assert.equal(created.vip, null, "an omitted optional boolean must round-trip as null, not false");
  const fetched = getRecord(db, "proj1", customer, created.id as number);
  assert.equal(fetched!.vip, null, "a fresh read must also see null, not just the insert's own return value");
});

/**
 * Round 855: coerceValue's default branch (text/longtext/file -- every
 * field type not covered by an explicit `case` above) used to have no
 * rejection path at all, unlike every other branch in this same function
 * (number/relation, boolean, enum, date) -- `String(raw)` on an object or
 * array silently stringifies it to `"[object Object]"` or a comma-joined
 * string and writes that garbage with the write still reporting success.
 * This is the exact same "a sibling branch in the same function already
 * has this guard" shape round 546 already fixed for the boolean branch
 * one case above -- same function, same reachability (routes/projects.ts
 * passes req.body straight into insertRecord/updateRecord with nothing
 * above coerceValue to catch this first), just the one branch that round
 * never touched because it wasn't the one round 546 was fixing.
 */
test("insertRecord rejects an object or array value for a text field, instead of silently stringifying it to \"[object Object]\" or a comma-joined list", () => {
  const db = setup();
  for (const bad of [{ foo: "bar" }, [1, 2, 3], [], {}]) {
    assert.throws(
      () => insertRecord(db, "proj1", customer, { name: bad, status: "New" }),
      ValidationError,
      `expected ${JSON.stringify(bad)} to be rejected instead of silently stringified`,
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
  // A separate, boolean-free entity. Before round 1134, a boolean's own
  // "unset" value round-tripped through rowToRecord's unconditional
  // Boolean() coercion as `false` rather than a real null, so it wouldn't
  // have exercised this bug (coerceValue's required check only fires on
  // undefined/null/""). rowToRecord now preserves a genuinely unset
  // boolean as null (see repository.test.ts's own round-1134 test above),
  // so that's no longer a reason to avoid one here -- kept as a plain text
  // field anyway, since this test has nothing to do with booleans
  // specifically.
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
 * Regression test for round 1303: the same array-coercion quirk fixed by
 * round 604 above has a boolean-shaped twin this function never guarded
 * against. Number(true) is 1 and Number(false) is 0, both finite, so a
 * boolean raw value for a number/relation field silently became a real
 * stored number/foreign-key id instead of being rejected -- and for a
 * *required* field, `raw === false` also bypassed the required-check
 * entirely, since isEmpty doesn't recognize `false` as "no real value"
 * either (the same required-check-bypass shape round 604's own array fix
 * already closed for arrays).
 */
test("insertRecord rejects a boolean value for a required number field, instead of silently coercing it via Number(true)/Number(false)", () => {
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
    () => insertRecord(db, "proj1", invoice, { label: "Rent", amount: true }),
    ValidationError,
    "expected true to be rejected, not coerced to 1",
  );
  assert.throws(
    () => insertRecord(db, "proj1", invoice, { label: "Rent", amount: false }),
    ValidationError,
    "expected false to be rejected as missing a required value, not coerced to 0",
  );

  const created = insertRecord(db, "proj1", invoice, { label: "Rent", amount: 500 });
  assert.equal(created.amount, 500);
});

/**
 * Same bug, but for a required "relation" field: a boolean raw value must
 * be rejected with a clean ValidationError, not silently coerced into a
 * real foreign-key id (1 or 0) that may or may not point at an unrelated
 * record -- the identical hazard round 604's own array-value test above
 * already covers for arrays.
 */
test("insertRecord rejects a boolean value for a required relation field, instead of silently coercing it to foreign key 1 or 0", () => {
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
  const customer = insertRecord(db, "proj1", customerEntity, { name: "Dana" });

  assert.throws(
    () => insertRecord(db, "proj1", order, { total: 10, customerId: true }),
    ValidationError,
    "expected true to be rejected, not coerced to foreign key 1",
  );
  assert.throws(
    () => insertRecord(db, "proj1", order, { total: 10, customerId: false }),
    ValidationError,
    "expected false to be rejected as missing a required value, not coerced to foreign key 0",
  );

  const created = insertRecord(db, "proj1", order, { total: 10, customerId: customer.id });
  assert.equal(created.customerId, customer.id);
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

/**
 * Round 619: diffAndMigrate (migrate.ts, rounds 617/618) correctly treats a
 * field renamed only by letter case as a no-op -- the physical column
 * keeps its ORIGINAL casing, since SQLite resolves it case-insensitively
 * and no ALTER is needed. But `row[field.name]` here was still an
 * exact-string lookup against the row node:sqlite returns, which is keyed
 * by that same original physical casing, not by the entity's current spec
 * casing -- so a record's data for that field silently vanished on every
 * read, and writing any OTHER field on the same row crashed trying to bind
 * `undefined` for the renamed field's untouched value.
 */
test("a field renamed only by letter case across a refine stays readable, writable, and updatable, instead of silently vanishing or crashing", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  insertRecord(db, "proj1", customer, { name: "Alice", status: "New" });

  const renamed: Entity = { ...customer, fields: [{ ...customer.fields[0], name: "Name" }, customer.fields[1], customer.fields[2]] };
  const changes = diffAndMigrate(db, "proj1", spec, { ...spec, entities: [renamed] });
  assert.deepEqual(changes, [], "a pure case rename is a no-op migration (rounds 617/618)");

  const records = listRecords(db, "proj1", renamed);
  assert.equal(records.length, 1);
  assert.equal(records[0].Name, "Alice", "the pre-existing record's data must still read back under the renamed field, not silently vanish");

  const updated = updateRecord(db, "proj1", renamed, records[0].id, { status: "Won" });
  assert.equal(updated.Name, "Alice", "updating an unrelated field must not throw, and must preserve the renamed field's untouched value");
  assert.equal(updated.status, "Won");

  const created = insertRecord(db, "proj1", renamed, { Name: "Bob", status: "New" });
  assert.equal(created.Name, "Bob", "a brand-new record inserted under the post-rename entity must read back correctly too");
});

/**
 * Round 1037: a self-referencing relation field (field.relationTo ===
 * this entity's own name -- e.g. Employee.managerId -> Employee, a
 * completely ordinary, schema-legal pattern) had no guard anywhere in the
 * write path: the SQL FOREIGN KEY constraint itself allows a row to
 * reference its own id, and coerceValue only ever checked that the raw
 * value is a finite number. updateRecord now rejects setting a relation
 * field to the record's own id, with a clean ValidationError -- the same
 * kind of input-rejection every other invalid value already gets, rather
 * than silently storing nonsensical data (an employee who is their own
 * manager) with no warning anywhere.
 */
test("updateRecord rejects a self-referencing relation field (field.relationTo pointing at this record's own entity, set to its own id)", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "managerId", type: "relation", required: false, relationTo: "Employee" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [employee] });
  const created = insertRecord(db, "proj1", employee, { name: "Dana" });

  assert.throws(
    () => updateRecord(db, "proj1", employee, created.id as number, { managerId: created.id }),
    ValidationError,
    "setting a record's own self-referencing relation field to its own id must be rejected",
  );
});

/**
 * Round 1176: rounds 1159-1162 already established, across many other
 * files, that a relationTo string can legitimately differ in letter case
 * from its target entity's actual declared name -- a real, demonstrated
 * byproduct of AI-generated/refined specs, not a contrived edge case. The
 * guard above compared field.relationTo to entity.name with exact-case
 * equality, so a self-relation whose own relationTo happened to differ in
 * case from its own entity's name (managerId's relationTo: "employee"
 * against an entity declared "Employee") silently never hit the guard at
 * all, storing the exact "record references its own id" state this guard
 * exists specifically to reject.
 */
test("updateRecord rejects a self-referencing relation field even when relationTo differs in case from the entity's own declared name", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "managerId", type: "relation", required: false, relationTo: "employee" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [employee] });
  const created = insertRecord(db, "proj1", employee, { name: "Dana" });

  assert.throws(
    () => updateRecord(db, "proj1", employee, created.id as number, { managerId: created.id }),
    ValidationError,
    "a case-mismatched relationTo ('employee' vs the entity's own 'Employee') must not let a self-reference slip past this guard",
  );
});

/**
 * The guard must only fire when the CALLER is actually setting the
 * self-reference right now -- an update to some other, unrelated field on
 * a record that already carries a pre-existing self-reference (seeded
 * directly, bypassing this guard, the same way legacy data could predate
 * this round) must still succeed, the same "only re-validate what the
 * caller actually touched" principle this function's own pre-existing
 * tests above already establish for a since-narrowed field definition.
 */
test("updateRecord updating an unrelated field doesn't re-reject a pre-existing self-reference it never touched", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "managerId", type: "relation", required: false, relationTo: "Employee" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [employee] });
  const created = insertRecord(db, "proj1", employee, { name: "Dana" });
  // Seeds the pre-existing self-reference directly via a raw UPDATE,
  // bypassing updateRecord's own guard -- the same way data from before
  // this round, or a direct write outside this app, could already exist.
  db.prepare(`UPDATE "entity_proj1_Employee" SET "managerId" = ? WHERE id = ?`).run(created.id, created.id);

  const updated = updateRecord(db, "proj1", employee, created.id as number, { name: "Dana Cohen" });
  assert.equal(updated.name, "Dana Cohen", "updating only the name must succeed, not throw, even though this record already has a pre-existing self-reference");
  assert.equal(updated.managerId, created.id, "the untouched self-reference must survive exactly as it was");
});

/**
 * The guard must be scoped to a relation field that targets THIS entity --
 * a relation field pointing at a genuinely different entity whose id
 * happens to numerically equal this record's own id is an entirely
 * ordinary, unrelated reference and must never be rejected.
 */
test("updateRecord's self-reference guard never rejects a relation field pointing at a DIFFERENT entity, even if the ids numerically collide", () => {
  const department: Entity = { name: "Department", fields: [{ name: "title", type: "text", required: true }] };
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "departmentId", type: "relation", required: false, relationTo: "Department" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [department, employee] });
  const dept = insertRecord(db, "proj1", department, { title: "Engineering" });
  const emp = insertRecord(db, "proj1", employee, { name: "Dana" });

  const updated = updateRecord(db, "proj1", employee, emp.id as number, { departmentId: dept.id });
  assert.equal(updated.departmentId, dept.id, "a relation to a different entity must never be rejected by the self-reference guard, regardless of numeric id overlap");
});

/**
 * Round 1231: updateRecord got the self-reference guard above (rounds
 * 1037/1176), but insertRecord never did -- and a self-reference is just
 * as reachable on CREATE as on update. The new row's id is only known
 * after the INSERT commits, but that's exactly why this was reachable
 * with no error at all: a freshly-built entity table's very first record
 * gets a predictable id (AUTOINCREMENT starts at 1), so a direct create
 * call setting managerId to that same, now-known id self-references with
 * nothing to stop it -- the SQL FOREIGN KEY constraint itself allows a
 * row to reference its own id, and coerceValue only checks the raw value
 * is a finite number, same as updateRecord's own pre-1037 gap.
 */
test("insertRecord rejects a self-referencing relation field set to the new record's own (freshly-assigned) id", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "managerId", type: "relation", required: false, relationTo: "Employee" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [employee] });

  // The very first record in a fresh table: AUTOINCREMENT guarantees id 1.
  assert.throws(
    () => insertRecord(db, "proj1", employee, { name: "Dana", managerId: 1 }),
    ValidationError,
    "creating a record whose own self-referencing relation field is set to its own freshly-assigned id must be rejected",
  );
  assert.equal(countRecords(db, "proj1", employee), 0, "the rejected self-referencing row must not be left committed");
});

test("insertRecord rejects a self-referencing relation field even when relationTo differs in case from the entity's own declared name", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "managerId", type: "relation", required: false, relationTo: "employee" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [employee] });

  assert.throws(
    () => insertRecord(db, "proj1", employee, { name: "Dana", managerId: 1 }),
    ValidationError,
    "a case-mismatched relationTo ('employee' vs the entity's own 'Employee') must not let a create-time self-reference slip past this guard",
  );
  assert.equal(countRecords(db, "proj1", employee), 0, "the rejected self-referencing row must not be left committed");
});

test("insertRecord's self-reference guard doesn't reject a relation field referencing an EARLIER, different, already-existing record", () => {
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "managerId", type: "relation", required: false, relationTo: "Employee" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [employee] });
  const boss = insertRecord(db, "proj1", employee, { name: "Dana" });

  const created = insertRecord(db, "proj1", employee, { name: "Bob", managerId: boss.id });
  assert.equal(created.managerId, boss.id, "referencing a different, already-existing record of the same entity is an entirely ordinary relation and must never be rejected");
});

test("insertRecord's self-reference guard never rejects a relation field pointing at a DIFFERENT entity, even if the ids numerically collide", () => {
  const department: Entity = { name: "Department", fields: [{ name: "title", type: "text", required: true }] };
  const employee: Entity = {
    name: "Employee",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "departmentId", type: "relation", required: false, relationTo: "Department" },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", { ...spec, entities: [department, employee] });
  const dept = insertRecord(db, "proj1", department, { title: "Engineering" });

  // dept.id is 1; the first Employee record will also be assigned id 1,
  // but departmentId targets a different entity, so no self-reference.
  const created = insertRecord(db, "proj1", employee, { name: "Dana", departmentId: dept.id });
  assert.equal(created.departmentId, dept.id, "a relation to a different entity must never be rejected by the self-reference guard, regardless of numeric id overlap");
});
