import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations, diffAndMigrate, generateCreateTableStatements } from "./migrate.js";
import { insertRecord, listRecords } from "./repository.js";

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
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS entity_proj1_Customer/);
  assert.match(statements[0], /name TEXT NOT NULL/);
  assert.match(statements[1], /customerId INTEGER REFERENCES entity_proj1_Customer\(id\)/);
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
