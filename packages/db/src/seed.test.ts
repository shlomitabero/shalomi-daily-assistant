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

test("seed records use believable values for known field names, not a generic placeholder formula", () => {
  const customerEntity: Entity = {
    name: "Customer",
    label: "לקוחות",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "email", label: "אימייל", type: "text", required: false },
      { name: "phone", label: "טלפון", type: "text", required: false },
      { name: "source", label: "מקור", type: "text", required: false },
    ],
  };
  const records = generateSeedRecords(customerEntity, 2);

  for (const record of records) {
    // Not the old "לקוחות - שם 1" style placeholder formula.
    assert.doesNotMatch(record.name as string, /לקוחות - שם/);
    assert.match(record.email as string, /^[a-z.]+@example\.com$/);
    assert.match(record.phone as string, /^0\d{2}-\d{3}-\d{4}$/);
  }
  // The two records should actually differ, not repeat the same value.
  assert.notEqual(records[0].name, records[1].name);
  assert.notEqual(records[0].email, records[1].email);
});

test("the same 'name' field means a person for Customer but a catalog item for Service", () => {
  const customerEntity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const serviceEntity: Entity = { name: "Service", fields: [{ name: "name", type: "text", required: true }] };

  const [customerRecord] = generateSeedRecords(customerEntity, 1);
  const [serviceRecord] = generateSeedRecords(serviceEntity, 1);

  assert.equal(customerRecord.name, "Dana Levi");
  assert.equal(serviceRecord.name, "Basic Package");
});

test("an unrecognized field name still gets a labeled fallback value instead of throwing", () => {
  const custom: Entity = { name: "Widget", fields: [{ name: "colorPreference", type: "text", required: false }] };
  const [record] = generateSeedRecords(custom, 1);
  assert.equal(record.colorPreference, "Widget colorPreference 1");
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
