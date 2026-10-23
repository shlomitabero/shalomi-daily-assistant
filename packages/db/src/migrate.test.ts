import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { ensureAutomationRulesTable, getAutomationRule, insertAutomationRule } from "./automations.js";
import { ensureCheckpointsTable, insertCheckpoint, listHistoricalEntityNames } from "./checkpoints.js";
import { openDatabase } from "./connection.js";
import { applyMigrations, describeMigrationHazards, diffAndMigrate, generateCreateTableStatements } from "./migrate.js";
import { insertRecord, listRecords, ValidationError } from "./repository.js";

const spec: ProductSpec = {
  summary: "test",
  personas: [],
  roles: ["Admin"],
  entities: [
    {
      name: "Customer",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "status", type: "enum", required: true, enumValues: ["New", "Won"] },
      ],
    },
    {
      name: "Order",
      fields: [
        { name: "total", type: "number", required: true },
        { name: "customerId", type: "relation", required: false, relationTo: "Customer" },
      ],
    },
  ],
  screens: [],
  assumptions: [],
  openQuestions: [],
};

test("generates one CREATE TABLE per entity with correct SQL types", () => {
  const statements = generateCreateTableStatements("proj1", spec);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS "entity_proj1_Customer"/);
  assert.match(statements[0], /"name" TEXT NOT NULL/);
  assert.match(statements[1], /"customerId" INTEGER REFERENCES "entity_proj1_Customer"\(id\)/);
});

test("applyMigrations actually creates queryable tables", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(
    tables.map((t) => t.name),
    ["entity_proj1_Customer", "entity_proj1_Order"],
  );
});

test("sanitizes unsafe entity/project names instead of building injectable SQL", () => {
  const malicious: ProductSpec = {
    ...spec,
    entities: [{ name: "Bad; DROP TABLE x;--", fields: [{ name: "n", type: "text", required: true }] }],
  };
  const statements = generateCreateTableStatements("proj1", malicious);
  assert.equal(statements.length, 1);
  // The dangerous characters must be stripped from the identifier — no raw
  // semicolons or comment markers can reach the generated SQL string.
  assert.doesNotMatch(statements[0], /;.*DROP TABLE/i);
  assert.doesNotMatch(statements[0], /--/);
});

test("rejects unsafe column names rather than sanitizing them silently", () => {
  const malicious: ProductSpec = {
    ...spec,
    entities: [{ name: "Thing", fields: [{ name: "n; DROP TABLE x;--", type: "text", required: true }] }],
  };
  assert.throws(() => generateCreateTableStatements("proj1", malicious));
});

test("diffAndMigrate with no previous spec behaves like a fresh applyMigrations", () => {
  const db = openDatabase(":memory:");
  const changes = diffAndMigrate(db, "proj1", undefined, spec);
  assert.deepEqual(
    changes.map((c) => c.type),
    ["new_table", "new_table"],
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name")
    .all() as { name: string }[];
  assert.equal(tables.length, 2);
});

test("diffAndMigrate adds only a new table for a brand-new entity, keeping existing data", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const customerEntity = spec.entities[0];
  insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      ...spec.entities,
      { name: "Invoice", fields: [{ name: "amount", type: "number", required: true }] },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(changes, [{ type: "new_table", table: "entity_proj1_Invoice" }]);

  // Existing Customer data must survive untouched.
  const customers = listRecords(db, "proj1", customerEntity);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Alice");
});

test("diffAndMigrate adds a nullable column for a new field on an existing entity, never dropping old ones", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const customerEntity = spec.entities[0];
  insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: [...spec.entities[0].fields, { name: "loyaltyPoints", type: "number", required: false }],
      },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(changes, [
    { type: "new_column", table: "entity_proj1_Customer", column: "loyaltyPoints" },
  ]);

  const updatedEntity = nextSpec.entities[0];
  const customers = listRecords(db, "proj1", updatedEntity);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Alice");
  assert.equal(customers[0].loyaltyPoints, null);
});

/**
 * Regression test: a relation field added to an *existing* entity via
 * refine (the "new_column" branch, not "new_table") got no REFERENCES
 * clause at all, unlike a relation field present from the entity's very
 * first build (generateCreateTableStatements already handles that case
 * correctly, confirmed by the "generates one CREATE TABLE" test above).
 * Without the fix, deleting a Customer another entity's brand-new relation
 * field still pointed at would silently succeed -- a real, user-visible
 * gap in the exact same FK-protection family round 311 fixed for the
 * exported codegen app, except this one is in the live backend's own
 * incremental migration path.
 */
test("diffAndMigrate's new relation column on an existing entity gets real FK protection, not just a plain nullable column", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [spec.entities[0], { name: "Order", fields: [{ name: "total", type: "number", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);
  const customerEntity = baseSpec.entities[0];
  const customer = insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...baseSpec,
    entities: [
      baseSpec.entities[0],
      {
        ...baseSpec.entities[1],
        fields: [...baseSpec.entities[1].fields, { name: "customerId", type: "relation", required: false, relationTo: "Customer" }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", baseSpec, nextSpec);
  assert.deepEqual(changes, [{ type: "new_column", table: "entity_proj1_Order", column: "customerId" }]);

  const orderEntity = nextSpec.entities[1];
  insertRecord(db, "proj1", orderEntity, { total: 100, customerId: customer.id });

  // The real proof: deleting the still-referenced Customer must now throw a
  // real FOREIGN KEY constraint failure, exactly like a relation field
  // present from the start already does -- not succeed silently.
  assert.throws(
    () => db.prepare(`DELETE FROM "entity_proj1_Customer" WHERE id = ?`).run(customer.id),
    /FOREIGN KEY constraint failed/,
  );

  // The referenced row must still genuinely exist after the blocked delete.
  const customers = listRecords(db, "proj1", customerEntity);
  assert.equal(customers.length, 1);
});

// Regression test: if a refine changes an *existing* field's type (same
// name, e.g. "status" going from enum to text), diffAndMigrate's own
// prevFieldNames check used to just see the name already existed and
// `continue`, silently reporting no change at all -- the spec would end
// up claiming a different type than the SQLite column actually has
// (SQLite has no cheap ALTER COLUMN TYPE, so actually converting it is a
// real design decision, not something this diff should do on its own).
// This doesn't fix the underlying limitation, but it must stop being
// silent about it: a "type_changed" entry, with the actual column left
// untouched, so the pipeline (see pipeline.ts) can surface it instead of
// the build just reporting "0 changes" as if nothing happened.
test("diffAndMigrate reports a type_changed entry (without altering the column) when an existing field's type changes, instead of silently reporting no change at all", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const customerEntity = spec.entities[0];
  insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: [
          spec.entities[0].fields[0],
          { name: "status", type: "text", required: true },
        ],
      },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(changes, [
    { type: "type_changed", table: "entity_proj1_Customer", column: "status", fromType: "enum", toType: "text" },
  ]);

  // The column's real SQL type in SQLite must be completely untouched --
  // this test would still pass even if the column silently stayed the old
  // type forever, which is exactly the point: reporting the change is not
  // the same as applying it, and this proves no ALTER TABLE ran.
  const columnInfo = db.prepare('PRAGMA table_info("entity_proj1_Customer")').all() as { name: string; type: string }[];
  const statusColumn = columnInfo.find((c) => c.name === "status")!;
  assert.equal(statusColumn.type, "TEXT", "enum fields are already stored as SQL TEXT, same as the new 'text' type -- this pins that coincidence so a future sqlTypeFor change doesn't silently invalidate this test's own premise");

  // Existing data must survive completely unchanged.
  const customers = listRecords(db, "proj1", spec.entities[0]);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].status, "New");
});

/**
 * Round 617: a refine that merely changes a surviving field's letter-case
 * (e.g. "name" -> "Name") used to be invisible to prevFieldsByName's
 * exact-string lookup -- EntitySchema's own case-insensitive-duplicate check
 * only rejects a collision WITHIN one spec, so nextSpec's single "Name"
 * field passes validation cleanly even though previousSpec had "name". The
 * field then fell through to the "reused column" branch, whose own
 * exact-string currentColumns.has() check also missed the already-existing
 * physical column, so diffAndMigrate tried `ALTER TABLE ... ADD COLUMN
 * "Name" ...` against a table that (from SQLite's own case-insensitive
 * perspective) already had that exact column -- a raw, unhandled
 * "duplicate column name" SQLite error, not a reported change.
 */
test("diffAndMigrate treats a field that only changed letter-case as the same surviving field, instead of throwing a duplicate-column SQLite error", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  insertRecord(db, "proj1", spec.entities[0], { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: [{ ...spec.entities[0].fields[0], name: "Name" }, spec.entities[0].fields[1]],
      },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(changes, [], "a pure case rename with no real type change must report zero changes, same as any other no-op refine");

  // The original column (still physically named "name") must survive with
  // its data intact -- no ALTER, no new column, no data loss.
  const columnInfo = db.prepare('PRAGMA table_info("entity_proj1_Customer")').all() as { name: string }[];
  assert.deepEqual(columnInfo.map((c) => c.name).sort(), ["createdAt", "id", "name", "status"], "must still have exactly one name-ish column, not two");
  const customers = listRecords(db, "proj1", spec.entities[0]);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Alice");
});

/**
 * Round 618: round 617 fixed the exact-string prevFieldsByName lookup for a
 * field that survives letter-case renamed across the IMMEDIATELY preceding
 * spec. But a field removed on one refine and re-added two+ refines later
 * under different letter-case has NO entry in either prevFieldsByName or
 * prevFieldByLowerName -- the field genuinely wasn't in the immediately
 * preceding spec at all, so it falls into the sibling "reused column"
 * branch below, whose own currentColumns.has()/physicalShapeByColumn.get()
 * lookups are keyed by the column's REAL physical name (PRAGMA table_info)
 * and were still exact-string. The ALTER TABLE ADD COLUMN then throws the
 * same "duplicate column name" SQLite error round 617 fixed for the other
 * branch, just reached via a different path (remove-then-re-add instead of
 * a same-hop rename).
 */
test("diffAndMigrate treats a field removed on one refine and re-added under different letter-case two refines later as the same reused column, instead of throwing a duplicate-column SQLite error", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  insertRecord(db, "proj1", spec.entities[0], { name: "Alice", status: "New" });

  const withoutName: ProductSpec = {
    ...spec,
    entities: [{ ...spec.entities[0], fields: [spec.entities[0].fields[1]] }, spec.entities[1]],
  };
  const afterRemoval = diffAndMigrate(db, "proj1", spec, withoutName);
  assert.deepEqual(afterRemoval, [], "removing a field from the spec must not touch the physical column (additive-only design)");

  const withNameDifferentCase: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: [{ ...spec.entities[0].fields[0], name: "Name" }, spec.entities[0].fields[1]],
      },
      spec.entities[1],
    ],
  };
  const afterReAdd = diffAndMigrate(db, "proj1", withoutName, withNameDifferentCase);
  assert.deepEqual(
    afterReAdd,
    [{ type: "new_column", table: "entity_proj1_Customer", column: "Name" }],
    "must not throw, and must report the reused column as new_column (same as any other field absent from previousSpec), not as a duplicate-column crash",
  );

  const columnInfo = db.prepare('PRAGMA table_info("entity_proj1_Customer")').all() as { name: string }[];
  assert.deepEqual(columnInfo.map((c) => c.name).sort(), ["createdAt", "id", "name", "status"], "must still have exactly one name-ish column, not two");
  const customers = listRecords(db, "proj1", spec.entities[0]);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Alice", "the original data in the reused column must survive untouched");
});

/**
 * Regression test: diffAndMigrate's prevField branch compared only
 * `prevField.type !== field.type`, so a relation field that keeps the same
 * name and type ("relation") but has its `relationTo` repointed to a
 * *different, still-existing* entity (a very plausible refine like "treat
 * couriers as drivers now") fell through the same `continue` as "nothing
 * changed" -- reporting zero changes even though the column's actual FK
 * (bound at CREATE/ALTER time, see generateCreateTableStatements) still
 * points at the OLD entity's table. This is the same class of gap
 * "type_changed" above already covers for a field's own type, just for a
 * relation field's target -- and it's the exact gap round 275's
 * checkpointDiff.ts fieldSignature() already had to account for
 * client-side (it folds relationTo into the signature precisely so this
 * kind of change isn't invisible there either), but the live migration
 * path itself never got the matching fix until now.
 */
test("diffAndMigrate reports a relation_target_changed entry (without repointing the FK) when a relation field's relationTo changes to a different existing entity", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const customerEntity = spec.entities[0];
  const alice = insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      spec.entities[0],
      { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] },
      {
        ...spec.entities[1],
        fields: [
          spec.entities[1].fields[0],
          { name: "customerId", type: "relation", required: false, relationTo: "Vendor" },
        ],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(changes, [
    { type: "new_table", table: "entity_proj1_Vendor" },
    {
      type: "relation_target_changed",
      table: "entity_proj1_Order",
      column: "customerId",
      fromRelationTo: "Customer",
      toRelationTo: "Vendor",
    },
  ]);

  // The real proof the FK itself was NOT repointed: it's still bound to
  // Customer, not Vendor, so inserting an Order that references the real,
  // just-created Vendor record is wrongly rejected... A filler Vendor row
  // is inserted first so the real one's id (2) can't coincide by luck with
  // the Customer table's own existing id (1, Alice's) -- the whole point
  // being to prove the FK still only knows about the Customer table, not
  // to accidentally pass because both tables happen to allocate the same
  // next id.
  const vendorEntity = nextSpec.entities[1];
  insertRecord(db, "proj1", vendorEntity, { name: "filler" });
  const vendor = insertRecord(db, "proj1", vendorEntity, { name: "Acme Co" });
  const orderEntity = nextSpec.entities[2];
  assert.throws(
    () => insertRecord(db, "proj1", orderEntity, { total: 50, customerId: vendor.id }),
    /FOREIGN KEY constraint failed/,
    "a real Vendor record must not be silently rejected by a stale FK still watching Customer -- but today it is",
  );

  // ...while an id that happens to coincide with the STALE (Customer)
  // table's rows is silently accepted, even though the current spec says
  // this field now points at Vendor -- a genuinely corrupted relation
  // value with no error anywhere.
  const order = insertRecord(db, "proj1", orderEntity, { total: 75, customerId: alice.id });
  assert.equal(order.customerId, alice.id);

  // The column's real FK in SQLite must be completely untouched -- this
  // test would still pass even if the FK silently stayed bound to the old
  // table forever, which is exactly the point: reporting the change is not
  // the same as applying it (same documented limitation as type_changed).
  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList.map((fk) => fk.table), ["entity_proj1_Customer"]);
});

/**
 * Regression test: a field removed from an entity on one refine and then
 * re-added under the SAME NAME but a different type on a LATER refine has
 * no prevField in prevFieldsByName (that map only ever comes from the
 * spec immediately before this one, and the field wasn't there). It used
 * to fall straight into the "new_column" branch, which saw the physical
 * column already existed (this migration engine is additive-only -- it
 * never actually drops the column when a field is removed from the spec)
 * and skipped the ALTER, silently reporting a clean "new_column" with zero
 * indication that the reused column's real SQL type (still INTEGER, with
 * its old FK) disagrees with what the spec now claims ("text"). The fix
 * reads the column's real shape straight from SQLite's own catalog and
 * reports the same "type_changed" entry it already would if the field had
 * never left the spec.
 */
test("diffAndMigrate reports a type_changed entry when a field removed then re-added under the same name comes back with a different, cross-bucket type", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const customerEntity = spec.entities[0];
  insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  // Refine 1: drop the "customerId" relation field from Order entirely.
  const midSpec: ProductSpec = {
    ...spec,
    entities: [spec.entities[0], { ...spec.entities[1], fields: [spec.entities[1].fields[0]] }],
  };
  const removalChanges = diffAndMigrate(db, "proj1", spec, midSpec);
  assert.deepEqual(removalChanges, [], "removing a field from the spec reports no change at all -- the additive-only engine never drops the column");

  // The physical column must still be there, untouched -- additive-only.
  const columnsAfterRemoval = db.prepare('PRAGMA table_info("entity_proj1_Order")').all() as { name: string }[];
  assert.ok(columnsAfterRemoval.some((c) => c.name === "customerId"), "additive-only migration must never physically drop the column");

  // Refine 2: re-add a field also named "customerId", but as plain text --
  // a different SQL-type bucket (TEXT) than the stale column's real one
  // (INTEGER, left over from when it was a relation).
  const nextSpec: ProductSpec = {
    ...midSpec,
    entities: [
      midSpec.entities[0],
      {
        ...midSpec.entities[1],
        fields: [midSpec.entities[1].fields[0], { name: "customerId", type: "text", required: false }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", midSpec, nextSpec);
  assert.deepEqual(changes, [
    { type: "type_changed", table: "entity_proj1_Order", column: "customerId", fromType: "relation", toType: "text" },
    { type: "new_column", table: "entity_proj1_Order", column: "customerId" },
  ]);

  // The real column must be completely untouched by this report -- still
  // INTEGER, still FK-bound to Customer, exactly like the pre-existing
  // type_changed test above proves for the same-name-never-left case.
  const columnInfo = db.prepare('PRAGMA table_info("entity_proj1_Order")').all() as { name: string; type: string }[];
  const customerIdColumn = columnInfo.find((c) => c.name === "customerId")!;
  assert.equal(customerIdColumn.type, "INTEGER");
  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList.map((fk) => fk.table), ["entity_proj1_Customer"]);
});

// Regression test: the benign twin of the above -- a field removed then
// re-added under the same name with the SAME type must stay silent (just
// the baseline "new_column" every brand-new-to-this-diff field already
// gets), never a spurious type_changed/relation_target_changed. Proves the
// new stale-column check only fires on a genuine mismatch, not on every
// reuse of a name.
test("diffAndMigrate stays silent (no spurious type_changed) when a removed field is re-added under the same name with the same type", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const midSpec: ProductSpec = {
    ...spec,
    entities: [spec.entities[0], { ...spec.entities[1], fields: [spec.entities[1].fields[0]] }],
  };
  diffAndMigrate(db, "proj1", spec, midSpec);

  // Re-add "customerId" exactly as it was: relation to Customer.
  const changes = diffAndMigrate(db, "proj1", midSpec, spec);
  assert.deepEqual(changes, [{ type: "new_column", table: "entity_proj1_Order", column: "customerId" }]);

  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList.map((fk) => fk.table), ["entity_proj1_Customer"]);
});

// Regression test: the relation_target_changed twin of the type_changed
// test above -- a relation field removed then re-added under the same
// name, still a relation, but now pointing at a DIFFERENT existing entity.
// Both the stale column and the new field are INTEGER (same SQL-type
// bucket), so this only shows up by actually comparing the stale FK's real
// target table against what the field now claims.
test("diffAndMigrate reports a relation_target_changed entry when a removed relation field is re-added pointing at a different entity", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const midSpec: ProductSpec = {
    ...spec,
    entities: [spec.entities[0], { ...spec.entities[1], fields: [spec.entities[1].fields[0]] }],
  };
  diffAndMigrate(db, "proj1", spec, midSpec);

  const nextSpec: ProductSpec = {
    ...midSpec,
    entities: [
      midSpec.entities[0],
      { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] },
      {
        ...midSpec.entities[1],
        fields: [midSpec.entities[1].fields[0], { name: "customerId", type: "relation", required: false, relationTo: "Vendor" }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", midSpec, nextSpec);
  assert.deepEqual(changes, [
    { type: "new_table", table: "entity_proj1_Vendor" },
    { type: "relation_target_changed", table: "entity_proj1_Order", column: "customerId", fromRelationTo: "Customer", toRelationTo: "Vendor" },
    { type: "new_column", table: "entity_proj1_Order", column: "customerId" },
  ]);

  // The real FK must still be untouched -- bound to Customer, not Vendor.
  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList.map((fk) => fk.table), ["entity_proj1_Customer"]);
});

/**
 * Regression test: the mirror-image gap of the type_changed test above, in
 * the relation branch specifically. A field removed then re-added under the
 * same name as a *relation* was already checked against a stale FK pointing
 * at the wrong table (relation_target_changed, above) -- but if the reused
 * column never had a FK at all (e.g. it used to be a plain "boolean", which
 * shares relation's own INTEGER SQL bucket), the type_changed check stays
 * silent (same bucket, no mismatch) AND the relation_target_changed check
 * stays silent (its own condition requires a real fromRelationTo, i.e.
 * `shape.fkTable` truthy, to compare against). The column keeps zero
 * referential-integrity protection forever -- SQLite can't add a FOREIGN KEY
 * to an existing column any more than it can retype one -- which is exactly
 * the "dangling id can't happen through this app's own code paths" invariant
 * twin.ts's own insight logic documents and relies on, silently false for
 * this one column with nothing reported to explain why.
 */
test("diffAndMigrate reports a relation_missing_fk entry when a removed boolean field is re-added as a relation, reusing a column that never had a FK", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [
      spec.entities[0],
      { ...spec.entities[1], fields: [spec.entities[1].fields[0], { name: "isUrgent", type: "boolean", required: false }] },
    ],
  };
  applyMigrations(db, "proj1", baseSpec);

  // Refine 1: drop "isUrgent" entirely. The physical INTEGER column (no FK)
  // survives untouched -- additive-only.
  const midSpec: ProductSpec = {
    ...baseSpec,
    entities: [baseSpec.entities[0], { ...baseSpec.entities[1], fields: [baseSpec.entities[1].fields[0]] }],
  };
  const removalChanges = diffAndMigrate(db, "proj1", baseSpec, midSpec);
  assert.deepEqual(removalChanges, []);

  // Refine 2: re-add a field also named "isUrgent", but now a relation to
  // Customer -- same INTEGER bucket as boolean, so no type_changed.
  const nextSpec: ProductSpec = {
    ...midSpec,
    entities: [
      midSpec.entities[0],
      {
        ...midSpec.entities[1],
        fields: [midSpec.entities[1].fields[0], { name: "isUrgent", type: "relation", required: false, relationTo: "Customer" }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", midSpec, nextSpec);
  assert.deepEqual(changes, [
    { type: "relation_missing_fk", table: "entity_proj1_Order", column: "isUrgent", toRelationTo: "Customer" },
    { type: "new_column", table: "entity_proj1_Order", column: "isUrgent" },
  ]);

  // The real proof of the documented gap: the column has no FK at all, so a
  // completely nonexistent Customer id is accepted with no error -- unlike
  // every relation field created fresh, which would throw FOREIGN KEY
  // constraint failed for the same write.
  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList, [], "the reused column must still have zero FK -- SQLite can't add one to an existing column, same documented limitation as type_changed/relation_target_changed");
  const orderEntity = nextSpec.entities[1];
  const order = insertRecord(db, "proj1", orderEntity, { total: 10, isUrgent: 999999 });
  assert.equal(order.isUrgent, 999999, "a dangling, nonexistent Customer id is silently accepted -- the exact gap this change type now reports");
});

test("diffAndMigrate reports a type_changed entry when a removed relation field is re-added as boolean, reusing a column that still has a real FK", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [
      spec.entities[0],
      { ...spec.entities[1], fields: [spec.entities[1].fields[0], { name: "driverId", type: "relation", required: false, relationTo: "Customer" }] },
    ],
  };
  applyMigrations(db, "proj1", baseSpec);
  insertRecord(db, "proj1", baseSpec.entities[0], { name: "Alice", status: "New" }); // Customer id 1

  // Refine 1: drop "driverId" entirely. The physical INTEGER column, FK
  // constraint included, survives untouched -- additive-only.
  const midSpec: ProductSpec = {
    ...baseSpec,
    entities: [baseSpec.entities[0], { ...baseSpec.entities[1], fields: [baseSpec.entities[1].fields[0]] }],
  };
  const removalChanges = diffAndMigrate(db, "proj1", baseSpec, midSpec);
  assert.deepEqual(removalChanges, []);

  // Refine 2: re-add a field also named "driverId", but now boolean -- same
  // INTEGER bucket as relation, so the plain sqlType comparison alone would
  // stay silent. fieldTypeLabelForSqlType's existing hasForeignKey signal
  // catches it: the column's real FK (still physically present) means the
  // reused column was a relation, not a boolean, until this refine.
  const nextSpec: ProductSpec = {
    ...midSpec,
    entities: [
      midSpec.entities[0],
      { ...midSpec.entities[1], fields: [midSpec.entities[1].fields[0], { name: "driverId", type: "boolean", required: false }] },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", midSpec, nextSpec);
  assert.deepEqual(changes, [
    { type: "type_changed", table: "entity_proj1_Order", column: "driverId", fromType: "relation", toType: "boolean" },
    { type: "new_column", table: "entity_proj1_Order", column: "driverId" },
  ]);

  // The real proof of the documented gap: the column still has its original
  // FK, which SQLite can't retroactively drop -- so writing a boolean that
  // coerces to anything but an existing Customer row id throws a raw FOREIGN
  // KEY constraint failed, not a validation error, for a field the UI now
  // renders as a plain Yes/No checkbox.
  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList.map((fk) => fk.table), ["entity_proj1_Customer"]);
  const orderEntity = nextSpec.entities[1];
  assert.throws(
    () => insertRecord(db, "proj1", orderEntity, { total: 20, driverId: false }),
    /FOREIGN KEY constraint failed/,
    "driverId: false coerces to 0, never a valid Customer row id -- the exact gap this change type now reports",
  );
});

/**
 * Round 444: the prevField branch's relation_target_changed check compared
 * only `prevField.relationTo !== field.relationTo` -- the IMMEDIATELY
 * preceding spec, never physical reality. A relationTo that oscillates
 * across two refines (Customer -> Vendor -> Customer, the field staying a
 * "relation" the whole time, never removed from the spec) used to report a
 * spurious relation_target_changed on the THIRD spec ("Vendor -> Customer"),
 * even though the real FK had pointed at Customer continuously the entire
 * time -- the middle refine's own report already documented that SQLite
 * can't retroactively repoint an existing column's FK, so it never actually
 * moved. The fix compares the column's real physical FK target instead,
 * so a relationTo that returns to what's already physically there reports
 * nothing, regardless of how many hops it took to get there.
 */
test("diffAndMigrate reports no relation_target_changed when relationTo oscillates back to the entity the FK has pointed at the whole time", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const vendorAddedSpec: ProductSpec = {
    ...spec,
    entities: [spec.entities[0], { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] }, spec.entities[1]],
  };
  const repointedToVendor: ProductSpec = {
    ...vendorAddedSpec,
    entities: [
      vendorAddedSpec.entities[0],
      vendorAddedSpec.entities[1],
      { ...spec.entities[1], fields: [spec.entities[1].fields[0], { name: "customerId", type: "relation", required: false, relationTo: "Vendor" }] },
    ],
  };
  const firstHopChanges = diffAndMigrate(db, "proj1", spec, repointedToVendor);
  assert.deepEqual(firstHopChanges.filter((c) => c.type === "relation_target_changed"), [
    { type: "relation_target_changed", table: "entity_proj1_Order", column: "customerId", fromRelationTo: "Customer", toRelationTo: "Vendor" },
  ]);

  // Refine again, repointing relationTo back to Customer -- the field was
  // never removed from the spec, so this goes through the prevField branch,
  // not the field-reuse path the relation_missing_fk test above exercises.
  const repointedBackToCustomer: ProductSpec = {
    ...repointedToVendor,
    entities: [
      repointedToVendor.entities[0],
      repointedToVendor.entities[1],
      { ...repointedToVendor.entities[2], fields: [repointedToVendor.entities[2].fields[0], { name: "customerId", type: "relation", required: false, relationTo: "Customer" }] },
    ],
  };
  const secondHopChanges = diffAndMigrate(db, "proj1", repointedToVendor, repointedBackToCustomer);
  assert.deepEqual(
    secondHopChanges,
    [],
    "relationTo returned to Customer, exactly matching the FK's real, never-moved target -- nothing should be reported",
  );

  // The real FK must still point at Customer -- it never moved, through
  // either hop.
  const fkList = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkList.map((fk) => fk.table), ["entity_proj1_Customer"]);
});

/**
 * Round 444: the mirror-image case of the oscillation test above, for
 * relation_missing_fk rather than relation_target_changed. A relation field
 * whose relationTo was invalid (pointing at a not-yet-existing entity) when
 * its column was first created gets no FK at all -- and the prevField
 * branch's old check (`prevField.relationTo !== field.relationTo`) stayed
 * silent forever afterward once relationTo stopped changing text-wise, even
 * after the target entity started existing and the column should have been
 * flagged as still missing its FK. The fix's relation_missing_fk check
 * (mirroring the existing one in the "reused column" branch) catches this
 * for a field that was never removed from the spec at all.
 */
test("diffAndMigrate reports relation_missing_fk once an invalid relationTo's target entity starts existing, for a field never removed from the spec", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [
      spec.entities[0],
      { ...spec.entities[1], fields: [spec.entities[1].fields[0], { name: "assigneeId", type: "relation", required: false, relationTo: "Ghost" }] },
    ],
  };
  applyMigrations(db, "proj1", baseSpec);
  const fkListBefore = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
  assert.deepEqual(fkListBefore, [], "Ghost doesn't exist yet, so the column must be created with no FK at all");

  const ghostAddedSpec: ProductSpec = {
    ...baseSpec,
    entities: [baseSpec.entities[0], { name: "Ghost", fields: [{ name: "name", type: "text", required: true }] }, baseSpec.entities[1]],
  };
  const changes = diffAndMigrate(db, "proj1", baseSpec, ghostAddedSpec);
  assert.deepEqual(changes.filter((c) => c.type !== "new_table"), [
    { type: "relation_missing_fk", table: "entity_proj1_Order", column: "assigneeId", toRelationTo: "Ghost" },
  ]);
});

/**
 * Round 860: relationTo is only ever checked for being non-empty
 * (FieldSchema's own refine, @forge/shared) -- never for actually naming a
 * real entity in the spec. Before this round, a brand-new table/column for
 * a RELATION field whose relationTo names an entity that was never in the
 * spec at all got no FK (generateCreateTableStatements/the new-column ALTER
 * branch both silently drop the REFERENCES clause) and no diagnostic
 * anywhere -- unlike the sibling case just above (round 444), which only
 * catches a field that ALREADY existed, oscillating between invalid and
 * valid relationTo across refines. Round 415 already tried a hard
 * ProductSpecSchema-level rejection for this exact gap and reverted it in
 * full: domainEntities.ts's own built-in library deliberately keeps a
 * relation field's relationTo naming a possibly-absent entity (e.g.
 * Order.courierId -> "Courier"), and every one of its own such fields is
 * `required: false` -- its own comment explains why null is a legitimate,
 * honest "not assigned yet" value there. Scoping this new, non-blocking
 * hazard note to REQUIRED relation fields only (never fired for the
 * deliberate placeholder pattern, which is always optional) is the
 * distinguishing mechanism round 415's own revert note asked for.
 *
 * Covers all three ways a brand-new relation column/table can appear:
 * the very first build (previousSpec undefined), a brand-new entity added
 * by a refine, and a brand-new field added to an already-existing entity
 * by a refine -- and confirms an OPTIONAL relation field with the exact
 * same unresolvable relationTo is correctly left unflagged in every one of
 * them, proving the required-only scoping actually holds.
 */
test("diffAndMigrate reports relation_missing_fk for a brand-new REQUIRED relation field whose relationTo never named a real entity, but never for an optional one", () => {
  const ghostSpecEntity = (fieldRequired: boolean): ProductSpec => ({
    ...spec,
    entities: [...spec.entities, { name: "Task", fields: [{ name: "assigneeId", type: "relation", required: fieldRequired, relationTo: "Ghost" }] }],
  });

  // (1) The very first build of a project (previousSpec undefined) --
  // the overwhelmingly common case (every POST /projects/:id/build call).
  {
    const db = openDatabase(":memory:");
    const changes = diffAndMigrate(db, "proj1", undefined, ghostSpecEntity(true));
    assert.ok(
      changes.some((c) => c.type === "relation_missing_fk" && c.table === "entity_proj1_Task" && c.column === "assigneeId" && c.toRelationTo === "Ghost"),
      "a required relation field with no real target must be flagged even on the very first build",
    );

    const dbOptional = openDatabase(":memory:");
    const optionalChanges = diffAndMigrate(dbOptional, "proj1", undefined, ghostSpecEntity(false));
    assert.ok(
      !optionalChanges.some((c) => c.type === "relation_missing_fk"),
      "an OPTIONAL relation field with the identical unresolvable target must never be flagged -- this is domainEntities.ts's own deliberate placeholder shape",
    );
  }

  // (2) A brand-new entity added by a refine.
  {
    const db = openDatabase(":memory:");
    applyMigrations(db, "proj1", spec);
    const changes = diffAndMigrate(db, "proj1", spec, ghostSpecEntity(true));
    assert.ok(
      changes.some((c) => c.type === "relation_missing_fk" && c.table === "entity_proj1_Task" && c.column === "assigneeId" && c.toRelationTo === "Ghost"),
      "a required relation field on a brand-new entity (added via refine) with no real target must be flagged",
    );

    const dbOptional = openDatabase(":memory:");
    applyMigrations(dbOptional, "proj1", spec);
    const optionalChanges = diffAndMigrate(dbOptional, "proj1", spec, ghostSpecEntity(false));
    assert.ok(!optionalChanges.some((c) => c.type === "relation_missing_fk"));
  }

  // (3) A brand-new FIELD added to an already-existing entity by a refine.
  {
    const withNewRequiredField: ProductSpec = {
      ...spec,
      entities: [spec.entities[0], { ...spec.entities[1], fields: [...spec.entities[1].fields, { name: "driverId", type: "relation", required: true, relationTo: "Ghost" }] }],
    };
    const db = openDatabase(":memory:");
    applyMigrations(db, "proj1", spec);
    const changes = diffAndMigrate(db, "proj1", spec, withNewRequiredField);
    assert.ok(
      changes.some((c) => c.type === "relation_missing_fk" && c.table === "entity_proj1_Order" && c.column === "driverId" && c.toRelationTo === "Ghost"),
      "a required relation field newly added to an existing entity via refine, with no real target, must be flagged",
    );

    const withNewOptionalField: ProductSpec = {
      ...spec,
      entities: [spec.entities[0], { ...spec.entities[1], fields: [...spec.entities[1].fields, { name: "driverId", type: "relation", required: false, relationTo: "Ghost" }] }],
    };
    const dbOptional = openDatabase(":memory:");
    applyMigrations(dbOptional, "proj1", spec);
    const optionalChanges = diffAndMigrate(dbOptional, "proj1", spec, withNewOptionalField);
    assert.ok(!optionalChanges.some((c) => c.type === "relation_missing_fk"));
  }
});

/**
 * Round 863: the mirror-image gap of round 860's own fix, one step later
 * in a field's life. Round 860 covers a relation field created with an
 * unresolvable relationTo from the start. This covers a field that
 * SURVIVED unchanged from previousSpec, but whose own relationTo now
 * names an entity a refine just removed entirely -- expectedFkTable
 * (the prevField-relation branch's own comparison target) is undefined
 * either way a relationTo fails to resolve, so neither of that branch's
 * two existing conditions (both require expectedFkTable truthy) could
 * ever fire for this case before this round. Confirmed empirically
 * before fixing: PRAGMA foreign_key_list on the real column still shows
 * the genuine, now-orphaned FK after the target entity is removed --
 * additive-only migration never drops the physical table or its FK, it
 * just stops being represented anywhere in the live spec.
 */
test("diffAndMigrate reports relation_missing_fk when a REQUIRED relation field survives a refine unchanged but its own relationTo's target entity is removed, but never for an optional one", () => {
  const baseSpecWithDriver: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "Driver", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const driverRemovedSpec: ProductSpec = { ...spec }; // Driver entity gone; Order's own fields are untouched below.

  // (1) Required field: must be flagged.
  {
    const withRequiredDriverId: ProductSpec = {
      ...baseSpecWithDriver,
      entities: [baseSpecWithDriver.entities[0], { ...baseSpecWithDriver.entities[1], fields: [...baseSpecWithDriver.entities[1].fields, { name: "driverId", type: "relation", required: true, relationTo: "Driver" }] }, baseSpecWithDriver.entities[2]],
    };
    const nextWithoutDriver: ProductSpec = {
      ...driverRemovedSpec,
      entities: [driverRemovedSpec.entities[0], { ...driverRemovedSpec.entities[1], fields: [...driverRemovedSpec.entities[1].fields, { name: "driverId", type: "relation", required: true, relationTo: "Driver" }] }],
    };
    const db = openDatabase(":memory:");
    applyMigrations(db, "proj1", withRequiredDriverId);
    const fkBefore = db.prepare('PRAGMA foreign_key_list("entity_proj1_Order")').all() as { table: string }[];
    assert.ok(fkBefore.some((fk) => fk.table === "entity_proj1_Driver"), "the real FK to Driver must exist before Driver is removed, for this test to mean anything");

    const changes = diffAndMigrate(db, "proj1", withRequiredDriverId, nextWithoutDriver);
    assert.ok(
      changes.some((c) => c.type === "relation_missing_fk" && c.table === "entity_proj1_Order" && c.column === "driverId" && c.toRelationTo === "Driver"),
      "a required relation field surviving a refine must be flagged once its own target entity is removed entirely",
    );
  }

  // (2) Optional field with the identical shape: must never be flagged --
  // this is domainEntities.ts's own deliberate placeholder pattern.
  {
    const withOptionalDriverId: ProductSpec = {
      ...baseSpecWithDriver,
      entities: [baseSpecWithDriver.entities[0], { ...baseSpecWithDriver.entities[1], fields: [...baseSpecWithDriver.entities[1].fields, { name: "driverId", type: "relation", required: false, relationTo: "Driver" }] }, baseSpecWithDriver.entities[2]],
    };
    const nextWithoutDriverOptional: ProductSpec = {
      ...driverRemovedSpec,
      entities: [driverRemovedSpec.entities[0], { ...driverRemovedSpec.entities[1], fields: [...driverRemovedSpec.entities[1].fields, { name: "driverId", type: "relation", required: false, relationTo: "Driver" }] }],
    };
    const db = openDatabase(":memory:");
    applyMigrations(db, "proj1", withOptionalDriverId);
    const changes = diffAndMigrate(db, "proj1", withOptionalDriverId, nextWithoutDriverOptional);
    assert.ok(!changes.some((c) => c.type === "relation_missing_fk"), "an optional relation field must never be flagged this way, even when its target entity is removed");
  }
});

/**
 * Regression test: the entity-level twin of the field-reuse gaps above.
 * previousSpec is only ever the spec immediately before THIS ONE
 * diffAndMigrate call, so an entity removed on one refine and re-added
 * under the same name on a LATER refine has no prevEntity here, even
 * though its physical table (additive-only, never dropped) survived the
 * whole round trip untouched. Before this fix, the `!prevEntity` branch
 * unconditionally treated this as a brand-new entity: CREATE TABLE IF NOT
 * EXISTS silently no-opped against the still-existing table, and the early
 * `return` skipped the per-field diff loop entirely -- so a field the
 * re-added entity needs that the stale table doesn't already have was
 * never added, and the very next insert/update for it threw a raw SQLite
 * "no such column" error instead of failing at migration time with a
 * reported, user-visible change.
 */
test("diffAndMigrate adds a field a re-added entity needs, instead of silently skipping it because the entity itself was reused", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "Courier", fields: [{ name: "name", type: "text", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);

  // Refine 1: remove Courier from the spec entirely. The physical table
  // survives untouched -- additive-only.
  const midSpec: ProductSpec = { ...spec };
  const removalChanges = diffAndMigrate(db, "proj1", baseSpec, midSpec);
  assert.deepEqual(removalChanges, [], "removing an entity from the spec reports no change at all -- the additive-only engine never drops the table");
  const columnsAfterRemoval = db.prepare('PRAGMA table_info("entity_proj1_Courier")').all() as { name: string }[];
  assert.ok(columnsAfterRemoval.length > 0, "additive-only migration must never physically drop the table");

  // Refine 2: re-add Courier under the same name, now with an extra field
  // ("phone") the stale table doesn't have.
  const nextSpec: ProductSpec = {
    ...midSpec,
    entities: [
      ...midSpec.entities,
      {
        name: "Courier",
        fields: [{ name: "name", type: "text", required: true }, { name: "phone", type: "text", required: false }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", midSpec, nextSpec);
  assert.deepEqual(
    changes,
    [
      { type: "new_column", table: "entity_proj1_Courier", column: "name" },
      { type: "new_column", table: "entity_proj1_Courier", column: "phone" },
    ],
    "a re-added entity must be diffed field-by-field against physical reality, not blindly reported as new_table",
  );

  // The real proof: "phone" must actually be a queryable column now, not
  // just reported -- a write using it must not throw.
  const courierEntity = nextSpec.entities[nextSpec.entities.length - 1];
  const courier = insertRecord(db, "proj1", courierEntity, { name: "Dana", phone: "050-1234567" });
  assert.equal(courier.phone, "050-1234567");
});

// Regression test: the benign twin of the above -- an entity removed then
// re-added under the same name with the SAME fields must stay silent on
// type/relation mismatches (there are none), never spuriously report
// new_table. Every field still reports new_column (consistent with how a
// reused column already behaves elsewhere in this file), just not a bogus
// new_table for the whole entity.
test("diffAndMigrate does not report new_table for a re-added entity whose table already physically exists", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "Courier", fields: [{ name: "name", type: "text", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);

  const midSpec: ProductSpec = { ...spec };
  diffAndMigrate(db, "proj1", baseSpec, midSpec);

  // Re-add Courier exactly as it was.
  const changes = diffAndMigrate(db, "proj1", midSpec, baseSpec);
  assert.deepEqual(changes, [{ type: "new_column", table: "entity_proj1_Courier", column: "name" }]);
  assert.ok(
    !changes.some((c) => c.type === "new_table"),
    "the table already exists physically -- reporting new_table here would be wrong and would mislead anything downstream that treats new_table as 'needs seeding from scratch'",
  );
});

test("diffAndMigrate is safe to call twice with the same additive change (idempotent, never throws)", () => {
  // Reproduces the real failure class this hardening prevents: SQLite
  // throws "duplicate column name" on a second ALTER TABLE ADD COLUMN for
  // the same column. Previously this would halt the whole build with no
  // recovery path; it must now be a silent no-op the second time.
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);
  const customerEntity = spec.entities[0];
  insertRecord(db, "proj1", customerEntity, { name: "Alice", status: "New" });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: [...spec.entities[0].fields, { name: "loyaltyPoints", type: "number", required: false }],
      },
      spec.entities[1],
    ],
  };

  const firstRun = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.equal(firstRun.length, 1);

  // Simulate the diff not recognizing the field as already present (the
  // exact scenario a spec regeneration quirk could hit) by diffing against
  // the *original* (pre-loyaltyPoints) spec again.
  assert.doesNotThrow(() => diffAndMigrate(db, "proj1", spec, nextSpec));

  const customers = listRecords(db, "proj1", nextSpec.entities[0]);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Alice");
});

test("diffAndMigrate still reports a column as a real change on a retry, even though the ALTER TABLE itself is skipped as already applied", () => {
  // This is exactly what the pipeline's Debug Agent recovery does: the
  // Database step calls diffAndMigrate(db, project.id, previousSpec,
  // nextSpec), gets a real column added, then a LATER entity in the same
  // spec throws (e.g. an unsafe field name); the Debug Agent produces a
  // fixed spec and pipeline.ts calls diffAndMigrate again with the SAME
  // previousSpec. The column already added on the first (partial) attempt
  // must still show up in the second call's returned changes -- it's a
  // real difference from previousSpec, even though physically re-running
  // its ALTER TABLE would now be a no-op.
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: [...spec.entities[0].fields, { name: "loyaltyPoints", type: "number", required: false }],
      },
      spec.entities[1],
    ],
  };

  const firstRun = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(firstRun, [{ type: "new_column", table: "entity_proj1_Customer", column: "loyaltyPoints" }]);

  // Retry with the identical previousSpec/nextSpec (the physical ALTER
  // TABLE is now a no-op since the column already exists) -- the reported
  // change list must be identical to the first run's, not silently empty.
  const retryRun = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(
    retryRun,
    firstRun,
    "a column added by an earlier partial attempt must still be reported as a change relative to previousSpec",
  );
});

test("two entities whose names collide when compared case-insensitively silently share one SQLite table instead of erroring -- this is why @forge/shared's ProductSpecSchema rejects that spec before it ever reaches this file", () => {
  // SQLite compares identifiers case-insensitively for ASCII, even when
  // double-quoted, so "entity_proj1_Order" and "entity_proj1_order" name
  // the exact same table to SQLite. tableNameFor doesn't normalize case
  // (by design -- it only strips unsafe characters), so this file has no
  // way to tell the two apart on its own; the real fix is upstream, in
  // ProductSpecSchema's entity-name-collision refine, which stops such a
  // spec from ever reaching applyMigrations/diffAndMigrate in the first
  // place. This test documents the actual mechanism that guard prevents.
  const caseCollidingSpec: ProductSpec = {
    ...spec,
    entities: [
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "order", fields: [{ name: "status", type: "text", required: false }] },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", caseCollidingSpec);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name")
    .all() as { name: string }[];
  // Only ONE table exists -- the second CREATE TABLE IF NOT EXISTS silently
  // no-op'd because SQLite already considered the name taken. A real
  // "order" entity would never get a "status" column: every write meant
  // for it would actually hit the "Order" table's "total" column instead.
  assert.deepEqual(tables.map((t) => t.name), ["entity_proj1_Order"]);
});

/**
 * The cross-refine twin of the case-insensitive-collision test above:
 * ProductSpecSchema's findSanitizedIdentifierCollisions only ever checks
 * entities WITHIN one spec, so it can never catch a brand-new entity whose
 * sanitized table name collides with a DIFFERENT entity that existed in an
 * earlier spec and has since been removed -- previousSpec is the only
 * place diffAndMigrate (or anything else) still has a handle on that
 * removed entity's name. Without this round's fix, the removed entity's
 * real rows would keep sitting in the stale table and silently surface as
 * records of the new, differently-named entity.
 */
test("diffAndMigrate refuses to silently merge a brand-new entity into a removed entity's stale table when their sanitized names collide", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "לקוח", fields: [{ name: "phone", type: "text", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);
  const customerRecord = insertRecord(db, "proj1", baseSpec.entities[2], { phone: "050-1234567" });
  assert.equal(customerRecord.phone, "050-1234567");

  // Refine: remove "לקוח" entirely and introduce an unrelated-looking "מוצר"
  // entity -- same length, different word, but tableNameFor sanitizes both
  // down to the identical "entity_proj1_____" table name.
  const nextSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "מוצר", fields: [{ name: "price", type: "number", required: true }] }],
  };
  assert.throws(
    () => diffAndMigrate(db, "proj1", baseSpec, nextSpec),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.match((err as Error).message, /מוצר/);
      assert.match((err as Error).message, /לקוח/);
      return true;
    },
  );

  // The real proof this isn't just a reported warning: "לקוח"'s real row
  // must still be sitting in the table, completely untouched, not merged
  // into or overwritten by anything "מוצר"-shaped.
  const stillThere = listRecords(db, "proj1", baseSpec.entities[2]);
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].phone, "050-1234567");
});

/**
 * The multi-hop twin of the test directly above: the collision check it
 * added only ever searches previousSpec.entities, which is just the ONE
 * immediately preceding spec -- a real refine loop calls diffAndMigrate
 * once per refine, each time with only that one hop of history
 * (pipeline.ts's own call site never passes anything older). An entity
 * removed on an EARLIER refine is already gone from previousSpec by the
 * time a later, colliding entity shows up, so the one-hop check alone
 * would miss it. ensureCheckpointsTable + insertCheckpoint (exactly what
 * the real build/refine pipeline does after every successful
 * diffAndMigrate) populate checkpoint_entity_history, the durable ledger
 * allKnownEntityNames also consults -- this is the fix.
 */
test("diffAndMigrate also refuses the collision when the removed entity vanished two refines ago, not just the one immediately before", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);

  const baseSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "לקוח", fields: [{ name: "phone", type: "text", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "Initial build", kind: "build", spec: baseSpec });
  const customerRecord = insertRecord(db, "proj1", baseSpec.entities[2], { phone: "050-1234567" });
  assert.equal(customerRecord.phone, "050-1234567");

  // Refine 1: remove "לקוח" entirely. No collision yet -- nothing new is
  // being added this hop.
  const spec1: ProductSpec = { ...spec };
  diffAndMigrate(db, "proj1", baseSpec, spec1);
  insertCheckpoint(db, { id: "cp2", projectId: "proj1", label: "Refine: drop לקוח", kind: "refine", spec: spec1 });

  // Refine 2: previousSpec is now spec1, which no longer mentions "לקוח" at
  // all -- the one-hop check alone would see nothing to collide with. Adds
  // "מוצר", whose sanitized table name still collides with "לקוח"'s old one.
  const spec2: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "מוצר", fields: [{ name: "price", type: "number", required: true }] }],
  };
  assert.throws(
    () => diffAndMigrate(db, "proj1", spec1, spec2),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.match((err as Error).message, /מוצר/);
      assert.match((err as Error).message, /לקוח/);
      return true;
    },
  );

  const stillThere = listRecords(db, "proj1", baseSpec.entities[2]);
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].phone, "050-1234567");
});

/**
 * A third angle on the same collision guard (rounds 496/497 fixed how far
 * back in history it looks; this is about the comparison itself): SQLite
 * compares ASCII table identifiers case-insensitively even when
 * double-quoted -- the exact fact ProductSpecSchema's own
 * findCaseInsensitiveDuplicateEntityNames refine exists to guard against
 * within one spec (see the "two entities whose names collide when compared
 * case-insensitively" test above). A plain `===` on the sanitized table
 * names would miss a collision that differs only by letter case, even
 * though the colliding name is sitting right there in allKnownEntityNames.
 */
test("diffAndMigrate refuses the collision even when the colliding entity's name differs from the removed one only by letter case", () => {
  const db = openDatabase(":memory:");
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "Order2", fields: [{ name: "note", type: "text", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);
  const orderRecord = insertRecord(db, "proj1", baseSpec.entities[2], { note: "secret old data" });
  assert.equal(orderRecord.note, "secret old data");

  // Refine: remove "Order2" and introduce "order2" -- a different literal
  // entity name (so the exact-name prevEntity lookup doesn't apply), but
  // tableNameFor sanitizes both to table names SQLite treats as identical.
  const nextSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "order2", fields: [{ name: "price", type: "number", required: true }] }],
  };
  assert.throws(
    () => diffAndMigrate(db, "proj1", baseSpec, nextSpec),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.match((err as Error).message, /order2/);
      assert.match((err as Error).message, /Order2/);
      return true;
    },
  );

  const stillThere = listRecords(db, "proj1", baseSpec.entities[2]);
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].note, "secret old data");
});

/**
 * round 611: diffAndMigrate processes nextSpec.entities one at a time, each
 * with its own real, immediately-committed db.exec -- no transaction wraps
 * the whole call. A genuinely new entity earlier in that array can get its
 * real table created and committed, then a LATER entity in the SAME call
 * (e.g. one that collides with history, like the test above) makes the
 * whole call throw. Before this round, the durable history ledger only ever
 * learned about an entity once the pipeline's entire migration call
 * succeeded (round 610) -- too late here, since the call never returns.
 * This test asserts the earlier entity's name is tracked anyway, the moment
 * its own migration step commits, regardless of what a later entity in the
 * same call does.
 */
test("diffAndMigrate records an earlier entity's name in the history ledger even when a later entity in the same call makes the whole call throw", () => {
  const db = openDatabase(":memory:");
  ensureCheckpointsTable(db);

  const baseSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "לקוח", fields: [{ name: "phone", type: "text", required: true }] }],
  };
  applyMigrations(db, "proj1", baseSpec);
  insertCheckpoint(db, { id: "cp1", projectId: "proj1", label: "Initial build", kind: "build", spec: baseSpec });

  const spec1: ProductSpec = { ...spec };
  diffAndMigrate(db, "proj1", baseSpec, spec1);
  insertCheckpoint(db, { id: "cp2", projectId: "proj1", label: "Refine: drop לקוח", kind: "refine", spec: spec1 });

  // nextSpec adds "Invoice" (genuinely new, FIRST in the array -- its table
  // commits) then "מוצר" (collides with the long-removed "לקוח", SECOND --
  // throws before its own db.exec ever runs).
  const nextSpec: ProductSpec = {
    ...spec1,
    entities: [
      ...spec1.entities,
      { name: "Invoice", fields: [{ name: "amount", type: "number", required: true }] },
      { name: "מוצר", fields: [{ name: "price", type: "number", required: true }] },
    ],
  };
  assert.throws(() => diffAndMigrate(db, "proj1", spec1, nextSpec), ValidationError);

  assert.ok(
    listHistoricalEntityNames(db, "proj1").includes("Invoice"),
    "Invoice's own migration already committed before מוצר threw -- its name must be tracked even though the overall call failed",
  );
  assert.doesNotThrow(
    () => db.prepare(`SELECT COUNT(*) as c FROM "entity_proj1_Invoice"`).get(),
    "Invoice's real table must actually exist, matching the history ledger entry",
  );
});

test("generateCreateTableStatements quotes identifiers so a field named after a SQL reserved keyword doesn't break the statement", () => {
  // Table names are always safe (tableNameFor prefixes with
  // "entity_<projectId>_", so the bare identifier can never literally be a
  // reserved word), but field/column names are used unprefixed and were
  // previously unquoted -- a field named "order", "group", "key", etc. (an
  // entirely ordinary business field name) produced invalid SQL.
  const specWithReservedField: ProductSpec = {
    ...spec,
    entities: [{ name: "Task", fields: [{ name: "order", type: "number", required: false }] }],
  };
  const [statement] = generateCreateTableStatements("proj1", specWithReservedField);
  assert.match(statement, /"order" REAL/);

  const db = openDatabase(":memory:");
  assert.doesNotThrow(() => db.exec(statement));
});

/**
 * New in this round: describeMigrationHazards is the shared helper pulled
 * out of pipeline.ts (round 464) so the checkpoint-restore route could
 * reuse the exact same "kept the original type/relation target" notice
 * instead of silently discarding diffAndMigrate's own hazard entries, which
 * is what pipeline.ts's own "Database" agent message already did. Pins the
 * exact text (byte-for-byte what pipeline.ts used to build inline) and the
 * no-hazard "" case, since both call sites now depend on this contract.
 */
test("describeMigrationHazards reports nothing for new_table/new_column entries, and the exact note text for each hazard type", () => {
  assert.equal(describeMigrationHazards([]), "");
  assert.equal(
    describeMigrationHazards([
      { type: "new_table", table: "entity_proj1_Deal" },
      { type: "new_column", table: "entity_proj1_Deal", column: "title" },
    ]),
    "",
  );

  assert.equal(
    describeMigrationHazards([
      { type: "type_changed", table: "entity_proj1_Deal", column: "won", fromType: "boolean", toType: "text" },
    ]),
    " Note: entity_proj1_Deal.won (boolean → text) kept the original database column type — existing data was not converted.",
  );

  assert.equal(
    describeMigrationHazards([
      {
        type: "relation_target_changed",
        table: "entity_proj1_Order",
        column: "customerId",
        fromRelationTo: "Customer",
        toRelationTo: "Courier",
      },
    ]),
    " Note: entity_proj1_Order.customerId (Customer → Courier) kept pointing at the original related table — existing data was not re-linked.",
  );

  assert.equal(
    describeMigrationHazards([
      { type: "relation_missing_fk", table: "entity_proj1_Order", column: "customerId", toRelationTo: "Customer" },
    ]),
    " Note: entity_proj1_Order.customerId (→ Customer) is a relation field with no real foreign-key link to the entity it names — existing and new values in it are not protected against pointing at a record that doesn't exist.",
  );

  // Round 687: the automation-rule-disable sweep used to silently discard
  // its own outcome instead of reporting it through this same shared
  // mechanism -- a 4th hazard kind, same contract as the other three.
  assert.equal(
    describeMigrationHazards([{ type: "automation_rule_disabled", table: "entity_proj1_Order", disabledCount: 3 }]),
    " Note: 3 automation rule(s) were disabled because they referenced a field or entity that no longer exists — re-enable them from the Automations panel if still needed.",
  );
  // Two separate disable entries (e.g. one entity removed, one field
  // removed from a different surviving entity) must sum into a single
  // combined note, not one segment per entry.
  assert.equal(
    describeMigrationHazards([
      { type: "automation_rule_disabled", table: "entity_proj1_Order", disabledCount: 1 },
      { type: "automation_rule_disabled", table: "entity_proj1_Customer", column: "status", disabledCount: 2 },
    ]),
    " Note: 3 automation rule(s) were disabled because they referenced a field or entity that no longer exists — re-enable them from the Automations panel if still needed.",
  );

  // All four together concatenate as four separate "Note:" segments, in
  // type order -- matching exactly how the first three already combined
  // before this round, so this addition changed nothing about /build and
  // /refine's own existing behavior for the first three.
  assert.equal(
    describeMigrationHazards([
      { type: "type_changed", table: "entity_proj1_Deal", column: "won", fromType: "boolean", toType: "text" },
      {
        type: "relation_target_changed",
        table: "entity_proj1_Order",
        column: "customerId",
        fromRelationTo: "Customer",
        toRelationTo: "Courier",
      },
      { type: "relation_missing_fk", table: "entity_proj1_Order", column: "driverId", toRelationTo: "Driver" },
      { type: "automation_rule_disabled", table: "entity_proj1_Order", disabledCount: 1 },
    ]),
    " Note: entity_proj1_Deal.won (boolean → text) kept the original database column type — existing data was not converted." +
      " Note: entity_proj1_Order.customerId (Customer → Courier) kept pointing at the original related table — existing data was not re-linked." +
      " Note: entity_proj1_Order.driverId (→ Driver) is a relation field with no real foreign-key link to the entity it names — existing and new values in it are not protected against pointing at a record that doesn't exist." +
      " Note: 1 automation rule(s) were disabled because they referenced a field or entity that no longer exists — re-enable them from the Automations panel if still needed.",
  );
});

/**
 * Round 588: an automation rule referencing an entity or field diffAndMigrate
 * removes from the spec used to stay in the automation_rules table forever,
 * enabled and unaware anything changed -- harmless by itself (the record
 * routes that would fire it already 404 via findEntity/findField), but
 * deriveEntityName/deriveFieldName only dedupe against names that currently
 * exist, so a LATER refine that reintroduces the same name resurrects the
 * stale rule against an entity/field it was never actually written for.
 *
 * Round 596: this used to hard-delete the row (assert.equal(..., undefined)
 * below used to be the test's own assertion) -- changed to disable-only,
 * since diffAndMigrate also runs in reverse on checkpoint restore and a
 * hard-deleted row can never come back once the entity does. See the
 * restore-safety test further below.
 */
test("diffAndMigrate disables (not deletes) automation rules for an entity removed from the spec", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const rule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "total",
    fieldValue: "100",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15551234567",
    messageTemplate: "Order total hit {{total}}",
  });

  const nextSpec: ProductSpec = { ...spec, entities: [spec.entities[0]] };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);

  const after = getAutomationRule(db, "proj1", rule.id);
  assert.ok(after, "the rule row must survive -- only its enabled flag changes");
  assert.equal(after!.enabled, false);
  // Round 687: this used to be silently discarded -- pipeline.ts's own
  // build/refine stream and the checkpoint-restore route's
  // migrationWarning are both driven solely by
  // describeMigrationHazards(changes), so a disable that never lands in
  // this returned array is a disable the user is never told about.
  assert.deepEqual(
    changes.filter((c) => c.type === "automation_rule_disabled"),
    [{ type: "automation_rule_disabled", table: "entity_proj1_Order", disabledCount: 1 }],
    "the entity-level disable must be reported as a real MigrationChange, not silently discarded",
  );
});

test("diffAndMigrate disables an automation rule referencing a field removed from a surviving entity, as either its trigger field or its destination field, but leaves an unrelated rule alone", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  // References "status" as the field_equals trigger.
  const statusTriggerRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Won",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15551234567",
    messageTemplate: "Deal won!",
  });
  // References "status" only as the toMode:"field" destination -- a
  // different column than the trigger, same removed field.
  const statusDestinationRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "status",
    messageTemplate: "New customer!",
  });
  // References "name", a field that survives the refine below -- must not
  // be touched, proving this isn't just "every rule on the entity dies".
  const survivingRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "field_equals",
    fieldName: "name",
    fieldValue: "Alice",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15551234567",
    messageTemplate: "Hi Alice!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      { ...spec.entities[0], fields: spec.entities[0].fields.filter((f) => f.name !== "status") },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);

  assert.equal(getAutomationRule(db, "proj1", statusTriggerRule.id)!.enabled, false);
  assert.equal(getAutomationRule(db, "proj1", statusDestinationRule.id)!.enabled, false);
  assert.equal(
    getAutomationRule(db, "proj1", survivingRule.id)!.enabled,
    true,
    "the rule on the surviving 'name' field must not be touched",
  );
  // Round 687: one UPDATE call disables both rules in a single statement
  // (fieldName = ? OR toField = ? matches both), so this must be reported
  // as ONE automation_rule_disabled entry with disabledCount: 2, not
  // silently discarded or double-reported.
  assert.deepEqual(
    changes.filter((c) => c.type === "automation_rule_disabled"),
    [{ type: "automation_rule_disabled", table: "entity_proj1_Customer", column: "status", disabledCount: 2 }],
  );
});

/**
 * Round 620: this same automation-disable sweep's own nextFieldNames
 * lookup is exact-string, the identical mistake rounds 617/618 already
 * fixed for the main per-field diff loop earlier in diffAndMigrate
 * (prevFieldByLowerName / the "reused column" branch's physicalColumnName
 * fallback) -- but this sweep is a separate code path those fixes never
 * touched. A refine that renames a field only by letter case (e.g.
 * "status" -> "Status") is correctly a no-op for the migration itself
 * (confirmed: zero changes, no ALTER, same physical column), yet this
 * sweep still saw the old-cased "status" as absent from
 * nextFieldNames and disabled any rule still referencing it -- even
 * though the field, its data, and its column never actually left.
 */
test("diffAndMigrate leaves an automation rule enabled when its referenced field only changed letter-case across a refine, instead of wrongly disabling it", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const statusTriggerRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Won",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15551234567",
    messageTemplate: "Deal won!",
  });
  const statusDestinationRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "status",
    messageTemplate: "New customer!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: spec.entities[0].fields.map((f) => (f.name === "status" ? { ...f, name: "Status" } : f)),
      },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);
  assert.deepEqual(changes, [], "a pure case rename must still be a genuine no-op migration");

  assert.equal(
    getAutomationRule(db, "proj1", statusTriggerRule.id)!.enabled,
    true,
    "the field_equals rule must stay enabled -- its trigger field never actually left, only its letter-case changed",
  );
  assert.equal(
    getAutomationRule(db, "proj1", statusDestinationRule.id)!.enabled,
    true,
    "the toField destination rule must stay enabled for the same reason",
  );
});

/**
 * Round 606: a field kept by NAME but retyped away from text/longtext used
 * to leave a toMode:"field" automation rule fully enabled, since the field
 * never disappeared -- only validateAutomationToField (routes/projects.ts,
 * round 597) rejects a non-text/longtext destination, and that only runs at
 * rule create/update time, never again. A refine that redefines "name" (a
 * real field on this fixture's Customer entity) as a date field leaves a
 * rule whose toField is "name" still pointed at it; fireRule's own runtime
 * guard (typeof to !== "string") can't catch this, since a date field is
 * still stored as a plain string. Proven here against diffAndMigrate's real
 * type_changed computation, the same mechanism the "removed field" tests
 * above already exercise.
 */
test("diffAndMigrate disables a toMode:\"field\" automation rule whose destination field was kept by name but retyped away from text/longtext", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const destinationRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "name",
    messageTemplate: "New customer!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      { ...spec.entities[0], fields: spec.entities[0].fields.map((f) => (f.name === "name" ? { ...f, type: "date" } : f)) },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);

  assert.ok(
    changes.some((c) => c.type === "type_changed" && c.column === "name" && c.toType === "date"),
    "expected a type_changed entry for the retyped field",
  );
  assert.equal(getAutomationRule(db, "proj1", destinationRule.id)!.enabled, false);
});

test("diffAndMigrate leaves a toMode:\"field\" automation rule enabled when its destination field is retyped between text and longtext, since both remain valid WhatsApp destinations", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const destinationRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "name",
    messageTemplate: "New customer!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      { ...spec.entities[0], fields: spec.entities[0].fields.map((f) => (f.name === "name" ? { ...f, type: "longtext" } : f)) },
      spec.entities[1],
    ],
  };
  diffAndMigrate(db, "proj1", spec, nextSpec);

  assert.equal(getAutomationRule(db, "proj1", destinationRule.id)!.enabled, true);
});

/**
 * Round 614: an enum field kept by NAME and by TYPE can still invalidate a
 * field_equals automation rule, if the refine narrows its enumValues to drop
 * the exact option the rule's fieldValue was keyed to. Unlike the
 * type_changed cases above, this never produces a type_changed entry at all
 * (prevField.type === field.type === "enum"), so it was previously invisible
 * to the whole automation-rule safety sweep -- the rule stayed enabled
 * forever, pointed at a value coerceValue (repository.ts) can never store
 * again. computeImpact (pipeline.ts) already detects this exact narrowing
 * for a different purpose (warning the user about existing records); this
 * mirrors that same condition to feed the automation-disable sweep instead.
 */
test("diffAndMigrate disables a field_equals automation rule whose stored fieldValue names an enum option a refine just removed, even though the field keeps its name and its \"enum\" type", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const deadRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "New",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15550001111",
    messageTemplate: "Status changed!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: spec.entities[0].fields.map((f) => (f.name === "status" ? { ...f, enumValues: ["Won"] } : f)),
      },
      spec.entities[1],
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);

  assert.ok(
    !changes.some((c) => c.type === "type_changed"),
    "narrowing enumValues without changing the field's type must not itself be reported as a type_changed entry",
  );
  assert.equal(getAutomationRule(db, "proj1", deadRule.id)!.enabled, false);
});

test("diffAndMigrate leaves a field_equals automation rule enabled when an enum field's enumValues change without dropping the rule's own value", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const survivingRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Customer",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "New",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15550001111",
    messageTemplate: "Status changed!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        ...spec.entities[0],
        fields: spec.entities[0].fields.map((f) => (f.name === "status" ? { ...f, enumValues: ["New", "Won", "Lost"] } : f)),
      },
      spec.entities[1],
    ],
  };
  diffAndMigrate(db, "proj1", spec, nextSpec);

  assert.equal(getAutomationRule(db, "proj1", survivingRule.id)!.enabled, true);
});

/**
 * Round 639: a field_equals rule's stored fieldValue, on a relation field, is
 * a raw row id -- meaningful only against whatever table the column's FK
 * actually watches. relation_target_changed (above) already proves that
 * repointing relationTo to a different existing entity leaves the physical
 * FK, and therefore every id stored in the column, still watching the OLD
 * table. A field_equals rule left enabled after that retarget doesn't just
 * become stale the way a removed field's rule does -- it keeps comparing
 * against ids that now coincidentally belong to a DIFFERENT entity than the
 * one the rule was written for, so it can fire for the wrong reason entirely.
 * Unlike type_changed/enum-narrowing (already covered above), this relation
 * branch never fed fieldsNeedingAutomationDisable at all before this round's
 * fix, so the rule below used to survive this refine fully enabled.
 */
test("diffAndMigrate disables a field_equals automation rule on a relation field whose relationTo is retargeted to a different existing entity, but leaves a rule on an unrelated field alone", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const retargetedRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "customerId",
    fieldValue: "1",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15550001111",
    messageTemplate: "Order for this customer!",
  });
  const unrelatedRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "total",
    fieldValue: "100",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15550001111",
    messageTemplate: "Big order!",
  });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      spec.entities[0],
      { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] },
      {
        ...spec.entities[1],
        fields: [spec.entities[1].fields[0], { name: "customerId", type: "relation", required: false, relationTo: "Vendor" }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", spec, nextSpec);

  assert.ok(
    changes.some((c) => c.type === "relation_target_changed" && c.column === "customerId"),
    "expected a relation_target_changed entry for the retargeted field",
  );
  assert.equal(getAutomationRule(db, "proj1", retargetedRule.id)!.enabled, false);
  assert.equal(
    getAutomationRule(db, "proj1", unrelatedRule.id)!.enabled,
    true,
    "the rule on the untouched 'total' field must not be touched",
  );
});

/**
 * Round 639's second gap, the "reused column" twin of the test above: a
 * relation column reused after an earlier removal, that never had a FK at
 * all (relation_missing_fk, proven in isolation further above), leaves a
 * field_equals rule's stored id with even less meaning than a retargeted FK
 * -- the column now has zero referential-integrity protection, so nothing
 * guarantees the id still names any record at all, let alone one of the
 * field's current relationTo. This branch had the identical
 * fieldsNeedingAutomationDisable gap as the prevField relation branch above,
 * fixed in the same round.
 */
test("diffAndMigrate disables a field_equals automation rule on a relation field that reuses a column which never had a FK (relation_missing_fk)", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  const baseSpec: ProductSpec = {
    ...spec,
    entities: [
      spec.entities[0],
      { ...spec.entities[1], fields: [spec.entities[1].fields[0], { name: "isUrgent", type: "boolean", required: false }] },
    ],
  };
  applyMigrations(db, "proj1", baseSpec);

  // Refine 1: drop "isUrgent" entirely. The physical INTEGER column (no FK)
  // survives untouched -- additive-only.
  const midSpec: ProductSpec = {
    ...baseSpec,
    entities: [baseSpec.entities[0], { ...baseSpec.entities[1], fields: [baseSpec.entities[1].fields[0]] }],
  };
  diffAndMigrate(db, "proj1", baseSpec, midSpec);

  // The rule is created only now, while "isUrgent" doesn't exist in the spec
  // at all -- deliberately so the removal sweep above (which already,
  // correctly, disables a rule that existed *before* its field was dropped)
  // can't be what's credited for disabling it. The only mechanism that can
  // still catch this rule is refine 2's own relation_missing_fk branch,
  // which is exactly what this test is proving.
  const deadRule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "isUrgent",
    fieldValue: "1",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15550001111",
    messageTemplate: "Urgent order!",
  });

  // Refine 2: re-add a field also named "isUrgent", but now a relation to
  // Customer -- same INTEGER bucket as boolean, so no type_changed, and the
  // column still has no FK at all.
  const nextSpec: ProductSpec = {
    ...midSpec,
    entities: [
      midSpec.entities[0],
      {
        ...midSpec.entities[1],
        fields: [midSpec.entities[1].fields[0], { name: "isUrgent", type: "relation", required: false, relationTo: "Customer" }],
      },
    ],
  };
  const changes = diffAndMigrate(db, "proj1", midSpec, nextSpec);

  assert.ok(
    changes.some((c) => c.type === "relation_missing_fk" && c.column === "isUrgent"),
    "expected a relation_missing_fk entry for the reused column",
  );
  assert.equal(getAutomationRule(db, "proj1", deadRule.id)!.enabled, false);
});

/**
 * Round 596's own finding: diffAndMigrate also runs in the *reverse*
 * direction on checkpoint restore (apps/api/src/routes/projects.ts calls
 * diffAndMigrate(db, project.id, project.spec, checkpoint.spec) -- the
 * project's current spec as previousSpec, the checkpoint being restored as
 * nextSpec). Before this round's fix, an entity removed by one refine and
 * restored by a later Time Machine restore came back with its automation
 * rule gone forever, even though diffAndMigrate's own doc comment promises
 * Time Machine checkpoints are always safe to restore. Proven here as a
 * real two-step sequence through diffAndMigrate itself, not just the
 * disable in isolation.
 */
test("restoring a checkpoint that still has an entity removed by a later refine brings its automation rule back disabled, not permanently gone", () => {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  applyMigrations(db, "proj1", spec);
  const rule = insertAutomationRule(db, {
    projectId: "proj1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "total",
    fieldValue: "100",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "+15551234567",
    messageTemplate: "Order total hit {{total}}",
  });

  // Refine away: Order is removed from the spec -- mirrors a real /refine.
  const specWithoutOrder: ProductSpec = { ...spec, entities: [spec.entities[0]] };
  diffAndMigrate(db, "proj1", spec, specWithoutOrder);
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.enabled, false);

  // Restore an earlier checkpoint that still has Order -- mirrors the real
  // checkpoint-restore route's own diffAndMigrate(db, id, project.spec,
  // checkpoint.spec) call, current (Order-less) spec as previousSpec.
  diffAndMigrate(db, "proj1", specWithoutOrder, spec);

  const restored = getAutomationRule(db, "proj1", rule.id);
  assert.ok(restored, "the rule must still exist after the entity it references comes back via restore");
  assert.equal(restored!.entityName, "Order");
  assert.equal(restored!.fieldName, "total");
});
