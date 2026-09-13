import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import { openDatabase } from "./connection.js";
import { applyMigrations } from "./migrate.js";
import { insertRecord } from "./repository.js";
import { generateSeedRecords } from "./seed.js";

const customer: Entity = {
  name: "Customer",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "vip", type: "boolean", required: false },
    { name: "status", type: "enum", required: true, enumValues: ["New", "Won"] },
    { name: "joined", type: "date", required: false },
  ],
};

test("generateSeedRecords produces the requested count with type-appropriate values", () => {
  const records = generateSeedRecords(customer, 3);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(typeof record.name, "string");
    assert.equal(typeof record.vip, "boolean");
    assert.ok(["New", "Won"].includes(record.status as string));
  }
});

test("seed records satisfy the real repository validation and insert cleanly", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", {
    summary: "t",
    personas: [],
    roles: ["Admin"],
    entities: [customer],
    screens: [],
    assumptions: [],
    openQuestions: [],
  });
  const records = generateSeedRecords(customer, 2);
  for (const record of records) {
    const inserted = insertRecord(db, "proj1", customer, record);
    assert.ok(inserted.id);
  }
});
