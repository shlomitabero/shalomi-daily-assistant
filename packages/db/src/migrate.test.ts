import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations, generateCreateTableStatements } from "./migrate.js";

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
