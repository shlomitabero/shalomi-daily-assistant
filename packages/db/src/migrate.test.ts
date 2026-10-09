import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
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
    " Note: entity_proj1_Order.customerId (→ Customer) is a relation field reusing a column that was never linked to anything — existing and new values in it are not protected against pointing at a record that doesn't exist.",
  );

  // All three together concatenate as three separate "Note:" segments, in
  // type order -- matching exactly what pipeline.ts's inline version did
  // before this extraction, so this round's refactor changed nothing about
  // /build and /refine's own existing behavior.
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
    ]),
    " Note: entity_proj1_Deal.won (boolean → text) kept the original database column type — existing data was not converted." +
      " Note: entity_proj1_Order.customerId (Customer → Courier) kept pointing at the original related table — existing data was not re-linked." +
      " Note: entity_proj1_Order.driverId (→ Driver) is a relation field reusing a column that was never linked to anything — existing and new values in it are not protected against pointing at a record that doesn't exist.",
  );
});
