import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import {
  applyMigrations,
  ensureWhatsAppConnectionsTable,
  ensureWhatsAppMessagesTable,
  insertRecord,
  insertWhatsAppMessage,
  openDatabase,
  type ForgeDatabase,
} from "@forge/db";
import { generateBackupZipEntries } from "./backup.js";

/**
 * Every real server opens its database through store.ts, which calls
 * ensureWhatsAppConnectionsTable/ensureWhatsAppMessagesTable once at
 * startup -- generateBackupZipEntries (since this round) always queries
 * whatsapp_messages, so a bare openDatabase(":memory:")+applyMigrations
 * pair (the only two calls this file's own tests used before) no longer
 * matches what every real request actually runs against, and throws "no
 * such table" the instant a test calls generateBackupZipEntries at all.
 */
function createTestDb(p: Project): ForgeDatabase {
  const db = openDatabase(":memory:");
  applyMigrations(db, p.id, p.spec);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  return db;
}

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

/**
 * Regression test for a real bug found by round 285's Explore survey:
 * zip.ts's buildZip writes an entry's `path` into the archive verbatim,
 * with no validation -- unlike SQL table names (tableNameFor sanitizes)
 * or the exported app's own generated source files (codegen.ts's
 * assertSafe rejects outright, see round 283/284), a live preview's
 * entity.name reaches this ZIP-path construction completely unguarded,
 * because tableNameFor SANITIZES an unsafe name rather than rejecting it
 * -- so a project with such a name is a real, already-built, live
 * project by the time "Backup all data" is clicked. A "/" would create
 * an unintended nested folder in the downloaded archive instead of a
 * flat "<EntityName>.csv", and could invite path traversal on a naive
 * unzip tool for a name containing "../" -- replacing every path
 * separator rules both out, since a flat filename with no "/" at all
 * (even one still containing literal dots) can never be interpreted as
 * a multi-segment, directory-escaping path.
 */
test("an entity name containing a path separator never produces a nested or path-traversing ZIP entry", () => {
  const trickyProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        { name: "Reports/2024", fields: [{ name: "title", type: "text", required: true }] },
        { name: "../../etc", fields: [{ name: "value", type: "text", required: true }] },
      ],
    },
  };
  const db = createTestDb(trickyProject);
  const entries = generateBackupZipEntries(db, trickyProject);
  assert.deepEqual(
    entries.map((e) => e.path),
    ["Reports_2024.csv", ".._.._etc.csv"],
  );
  assert.ok(
    entries.every((e) => !e.path.includes("/") && !e.path.includes("\\")),
    "no ZIP entry path may contain a path separator",
  );
});

test("generateBackupZipEntries produces one CSV entry per entity, named after it", () => {
  const db = createTestDb(project);
  const entries = generateBackupZipEntries(db, project);
  assert.deepEqual(
    entries.map((e) => e.path),
    ["Customer.csv", "Order.csv"],
  );
});

test("each CSV has a real header row from field labels, even with zero records", () => {
  const db = createTestDb(project);
  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content;
  // A UTF-8 BOM prefix (Excel-friendly, matches the client's own CSV export) precedes the header.
  assert.ok(customerCsv.startsWith("﻿"));
  assert.equal(customerCsv.replace(/^﻿/, ""), "שם,סטטוס");
});

test("real inserted records appear in the CSV with translated enum labels, not raw stored values", () => {
  const db = createTestDb(project);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi", status: "Won" });

  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content.replace(/^﻿/, "");
  const lines = customerCsv.split("\r\n");
  assert.equal(lines[0], "שם,סטטוס");
  assert.equal(lines[1], "Dana Levi,הצליח");
});

test("a relation field resolves to the related record's display label, not the raw foreign-key id", () => {
  const db = createTestDb(project);
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
  const db = createTestDb(project);
  const order = project.spec.entities[1];
  insertRecord(db, project.id, order, { amount: 12345 });

  const entries = generateBackupZipEntries(db, project);
  const orderCsv = entries.find((e) => e.path === "Order.csv")!.content.replace(/^﻿/, "");
  const lines = orderCsv.split("\r\n");
  assert.equal(lines[1], "12345,");
});

test("a value containing a comma or quote is correctly CSV-escaped", () => {
  const db = createTestDb(project);
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
  const db = createTestDb(boolProject);
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

test("real WhatsApp messages produce a 'WhatsApp Messages.csv' entry, correctly escaped and ordered", () => {
  const db = createTestDb(project);
  const first = insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "in",
    fromNumber: "+972501111111",
    toNumber: "+972502222222",
    body: "מתי אפשר לקבל, את ההזמנה?",
    matchedLabel: "Dana Levi",
    matchedEntityName: "Customer",
    matchedRecordId: 1,
    status: "received",
  });
  const second = insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "out",
    fromNumber: "+972502222222",
    toNumber: "+972501111111",
    body: "מחר בבוקר",
    status: "sent",
  });

  const entries = generateBackupZipEntries(db, project);
  assert.deepEqual(
    entries.map((e) => e.path),
    ["Customer.csv", "Order.csv", "WhatsApp Messages.csv"],
  );
  const csv = entries.find((e) => e.path === "WhatsApp Messages.csv")!.content.replace(/^﻿/, "");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Direction,From,To,Message,Matched Record,Status,Date");
  // A phone number's leading "+" is also a formula-injection trigger character to csvEscape, so From/To are
  // guarded with a leading single quote just like any other field -- same convention, no special case.
  // listWhatsAppMessages returns newest-first, so the "out" reply comes first.
  assert.equal(lines[1], `Outgoing,'+972502222222,'+972501111111,מחר בבוקר,,sent,${second.createdAt}`);
  assert.equal(
    lines[2],
    `Incoming,'+972501111111,'+972502222222,"מתי אפשר לקבל, את ההזמנה?",Dana Levi,received,${first.createdAt}`,
  );
});

test("a WhatsApp message containing a comma is CSV-escaped like any other field, and the createdAt timestamp is real, not blank", () => {
  const db = createTestDb(project);
  const inserted = insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "in",
    fromNumber: "+972501111111",
    toNumber: "+972502222222",
    body: "מתי אפשר לקבל, את ההזמנה?",
    matchedLabel: "Dana Levi",
    status: "received",
  });

  const entries = generateBackupZipEntries(db, project);
  const csv = entries.find((e) => e.path === "WhatsApp Messages.csv")!.content.replace(/^﻿/, "");
  const lines = csv.split("\r\n");
  assert.equal(lines[1], `Incoming,'+972501111111,'+972502222222,"מתי אפשר לקבל, את ההזמנה?",Dana Levi,received,${inserted.createdAt}`);
});

test("collectAllWhatsAppMessages walks every page, not just the first 200, so a large history backs up in full", () => {
  const db = createTestDb(project);
  for (let i = 0; i < 205; i += 1) {
    insertWhatsAppMessage(db, {
      projectId: project.id,
      direction: "in",
      fromNumber: "+972501111111",
      toNumber: "+972502222222",
      body: `message ${i}`,
      status: "received",
    });
  }

  const entries = generateBackupZipEntries(db, project);
  const csv = entries.find((e) => e.path === "WhatsApp Messages.csv")!.content.replace(/^﻿/, "");
  const lines = csv.split("\r\n");
  // header + 205 rows, proving the second page (messages 201-205) wasn't dropped
  assert.equal(lines.length, 206);
});

test("a project that never used WhatsApp gets no 'WhatsApp Messages.csv' entry at all (omitted, not an empty file)", () => {
  const db = createTestDb(project);
  const entries = generateBackupZipEntries(db, project);
  assert.ok(!entries.some((e) => e.path === "WhatsApp Messages.csv"));
});

test("a value that would be interpreted as a spreadsheet formula is guarded with a leading single quote (CSV/formula injection)", () => {
  // A stored "name" field can hold arbitrary text -- not just values this
  // app itself ever wrote -- and Excel/Sheets/LibreOffice treat an
  // unguarded cell starting with =, +, -, or @ as a formula to evaluate.
  const db = createTestDb(project);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "=cmd|' /C calc'!A1", status: "New" });

  const entries = generateBackupZipEntries(db, project);
  const customerCsv = entries.find((e) => e.path === "Customer.csv")!.content.replace(/^﻿/, "");
  const lines = customerCsv.split("\r\n");
  assert.equal(lines[1], "'=cmd|' /C calc'!A1,חדש");
});
