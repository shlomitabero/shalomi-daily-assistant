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

test("a boolean field renders as Excel's own TRUE/FALSE convention -- and unlike every other field type, an unset boolean is never left blank", () => {
  // Every other field type (text, enum, number, relation) already has its
  // own test above, but this backup.ts CSV writer is a standalone copy of
  // entityFormatting.ts's formatting logic (see the file's own top comment
  // on why it's duplicated, not imported) -- its boolean branch had never
  // been exercised here at all.
  //
  // `false` is falsy but isn't null/undefined/"", so it reaches the
  // boolean branch and renders "FALSE" rather than the empty-value guard.
  // More surprising: an omitted boolean field renders "FALSE" too, not
  // blank -- packages/db/src/repository.ts's rowToRecord coerces a
  // boolean column's stored NULL through `Boolean(value)`, so a never-set
  // boolean is indistinguishable from an explicit `false` by the time it
  // reaches this CSV writer at all. Confirmed empirically before writing
  // this assertion (an initial version of this test assumed the unset
  // case renders blank, like other field types, and failed against the
  // real code -- see round 117's roadmap entry).
  const boolProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Task",
          label: "משימות",
          fields: [
            { name: "title", label: "כותרת", type: "text", required: true },
            { name: "done", label: "בוצע", type: "boolean", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, boolProject.id, boolProject.spec);
  const task = boolProject.spec.entities[0];
  insertRecord(db, boolProject.id, task, { title: "Finished", done: true });
  insertRecord(db, boolProject.id, task, { title: "Not finished", done: false });
  insertRecord(db, boolProject.id, task, { title: "Never set" });

  const entries = generateBackupZipEntries(db, boolProject);
  const taskCsv = entries.find((e) => e.path === "Task.csv")!.content.replace(/^﻿/, "");
  // listRecords returns newest-first (ORDER BY id DESC), so the rows are
  // in reverse insertion order.
  const lines = taskCsv.split("\r\n");
  assert.equal(lines[0], "כותרת,בוצע");
  assert.equal(lines[1], "Never set,FALSE");
  assert.equal(lines[2], "Not finished,FALSE");
  assert.equal(lines[3], "Finished,TRUE");
});

test("a value that would be interpreted as a spreadsheet formula is guarded with a leading single quote (CSV/formula injection)", () => {
  // A stored "name" field can hold arbitrary text -- not just values this
  // app itself ever wrote -- and Excel/Sheets/LibreOffice treat an
  // unguarded cell starting with =, +, -, or @ as a formula to evaluate.
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "=cmd|' /C calc'!A1", status: "New" });

  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content.replace(/^﻿/, "");
  const lines = customerCsv.split("\r\n");
  assert.equal(lines[1], "'=cmd|' /C calc'!A1,חדש");
});
