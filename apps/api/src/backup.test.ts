import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, insertRecord, openDatabase } from "@forge/db";
import { generateBackupZipEntries } from "./backup.js";

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "test",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        label: "לקוחות",
        fields: [
          { name: "name", label: "שם", type: "text", required: true },
          {
            name: "status",
            label: "סטטוס",
            type: "enum",
            required: true,
            enumValues: ["New", "Won"],
            enumLabels: { New: "חדש", Won: "הצליח" },
          },
        ],
      },
      {
        name: "Order",
        label: "הזמנות",
        fields: [
          { name: "amount", label: "סכום", type: "number", required: true },
          { name: "customerId", label: "לקוח", type: "relation", required: false, relationTo: "Customer" },
        ],
      },
    ],
  },
};

test("generateBackupZipEntries produces one CSV entry per entity, named after it", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const entries = generateBackupZipEntries(db, project);
  assert.deepEqual(
    entries.map((e) => e.path),
    ["Customer.csv", "Order.csv"],
  );
});

test("each CSV has a real header row from field labels, even with zero records", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content;
  // A UTF-8 BOM prefix (Excel-friendly, matches the client's own CSV export) precedes the header.
  assert.ok(customerCsv.startsWith("﻿"));
  assert.equal(customerCsv.replace(/^﻿/, ""), "שם,סטטוס");
});

test("real inserted records appear in the CSV with translated enum labels, not raw stored values", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi", status: "Won" });

  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content.replace(/^﻿/, "");
  const lines = customerCsv.split("\r\n");
  assert.equal(lines[0], "שם,סטטוס");
  assert.equal(lines[1], "Dana Levi,הצליח");
});

test("a relation field resolves to the related record's display label, not the raw foreign-key id", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const order = project.spec.entities[1];
  const dana = insertRecord(db, project.id, customer, { name: "Dana Levi", status: "New" });
  insertRecord(db, project.id, order, { amount: 150, customerId: dana.id });

  const entries = generateBackupZipEntries(db, project);
  const orderCsv = entries.find((e) => e.path === "Order.csv")!.content.replace(/^﻿/, "");
  const lines = orderCsv.split("\r\n");
  assert.equal(lines[0], "סכום,לקוח");
  assert.equal(lines[1], "150,Dana Levi");
});

test("a number >= 1000 is written unformatted, without a thousands separator (this CSV shares its column format with the per-entity Import CSV feature, so a locale-formatted \"1,234\" would fail that feature's plain Number() re-parse)", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const order = project.spec.entities[1];
  insertRecord(db, project.id, order, { amount: 12345 });

  const entries = generateBackupZipEntries(db, project);
  const orderCsv = entries.find((e) => e.path === "Order.csv")!.content.replace(/^﻿/, "");
  const lines = orderCsv.split("\r\n");
  assert.equal(lines[1], "12345,");
});

test("a value containing a comma or quote is correctly CSV-escaped", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: 'Says "hi", bye', status: "New" });

  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content.replace(/^﻿/, "");
  const lines = customerCsv.split("\r\n");
  assert.equal(lines[1], '"Says ""hi"", bye",חדש');
});
