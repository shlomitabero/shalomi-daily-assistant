import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, insertRecord, openDatabase, tableNameFor } from "@forge/db";
import { computeBusinessTwin } from "./twin.js";

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "test",
  description: "אני צריך אפליקציה לניהול לקוחות ותורים למספרה",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "test summary",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      { name: "Customer", label: "לקוחות", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Appointment", label: "תורים", fields: [{ name: "title", type: "text", required: true }] },
    ],
  },
};

test("computeBusinessTwin reports zero counts and a no-data observation on a fresh build", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const twin = computeBusinessTwin(db, project);
  assert.equal(twin.totalRecords, 0);
  assert.equal(twin.mostActive, null);
  assert.equal(twin.unused.length, 2);
  assert.ok(twin.observations.some((o) => o.includes("לא הוזנו")));
});

test("computeBusinessTwin identifies the most active entity and unused ones from real counts", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Alice" });
  insertRecord(db, project.id, customer, { name: "Bob" });
  insertRecord(db, project.id, customer, { name: "Carol" });

  const twin = computeBusinessTwin(db, project);
  assert.equal(twin.totalRecords, 3);
  assert.equal(twin.mostActive?.label, "לקוחות");
  assert.equal(twin.mostActive?.count, 3);
  assert.deepEqual(
    twin.unused.map((e) => e.label),
    ["תורים"],
  );
  assert.ok(twin.observations.some((o) => o.includes("לקוחות")));
  assert.ok(twin.observations.some((o) => o.includes("תורים")));
});

test("computeBusinessTwin phrases observations in English for an English description", () => {
  const db = openDatabase(":memory:");
  const enProject: Project = { ...project, description: "I need a CRM for customers and appointments" };
  applyMigrations(db, enProject.id, enProject.spec);
  const twin = computeBusinessTwin(db, enProject);
  assert.ok(twin.observations.some((o) => o.includes("No real data")));
});

test("computeBusinessTwin reports how many records are missing a relation field, and stays silent once it's fully set", () => {
  const relationProject: Project = {
    ...project,
    description: "I need a support ticket system linked to customers",
    spec: {
      ...project.spec,
      entities: [
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "Ticket",
          label: "Tickets",
          fields: [
            { name: "subject", type: "text", required: true },
            { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, relationProject.id, relationProject.spec);
  const customer = relationProject.spec.entities[0];
  const ticket = relationProject.spec.entities[1];
  const { id: customerId } = insertRecord(db, relationProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, relationProject.id, ticket, { subject: "Can't log in", customerId: null });
  insertRecord(db, relationProject.id, ticket, { subject: "Billing question", customerId: null });
  insertRecord(db, relationProject.id, ticket, { subject: "Refund request", customerId });

  const twin = computeBusinessTwin(db, relationProject);
  assert.ok(
    twin.observations.some((o) => o.includes("2 of 3 records have no") && o.includes("Customer")),
    `expected a relation-coverage observation, got: ${JSON.stringify(twin.observations)}`,
  );

  // Once every ticket has a customer, the observation must disappear -- it
  // reports a real gap, not a permanent nag.
  const db2 = openDatabase(":memory:");
  applyMigrations(db2, relationProject.id, relationProject.spec);
  const { id: customerId2 } = insertRecord(db2, relationProject.id, customer, { name: "Dana Levi" });
  insertRecord(db2, relationProject.id, ticket, { subject: "Can't log in", customerId: customerId2 });
  const twinFullyLinked = computeBusinessTwin(db2, relationProject);
  assert.ok(!twinFullyLinked.observations.some((o) => o.includes("have no")));
});

test("computeBusinessTwin identifies the record most referenced across multiple relation fields, with a per-entity breakdown", () => {
  const hubProject: Project = {
    ...project,
    description: "I need to track orders and support tickets for my customers",
    spec: {
      ...project.spec,
      entities: [
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "total", type: "number", required: true },
            { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
        {
          name: "Ticket",
          label: "Tickets",
          fields: [
            { name: "subject", type: "text", required: true },
            { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, hubProject.id, hubProject.spec);
  const [customer, order, ticket] = hubProject.spec.entities;
  const { id: dana } = insertRecord(db, hubProject.id, customer, { name: "Dana Levi" });
  const { id: yossi } = insertRecord(db, hubProject.id, customer, { name: "Yossi Cohen" });
  insertRecord(db, hubProject.id, order, { total: 50, customerId: dana });
  insertRecord(db, hubProject.id, order, { total: 30, customerId: dana });
  insertRecord(db, hubProject.id, ticket, { subject: "Refund", customerId: dana });
  insertRecord(db, hubProject.id, order, { total: 10, customerId: yossi });

  const twin = computeBusinessTwin(db, hubProject);
  const hubObservation = twin.observations.find((o) => o.includes("most-linked record"));
  assert.ok(hubObservation, `expected a most-linked-record observation, got: ${JSON.stringify(twin.observations)}`);
  assert.ok(hubObservation!.includes("Dana Levi"), `expected Dana Levi (3 total links) to be the hub, got: "${hubObservation}"`);
  assert.ok(hubObservation!.includes("3 links total"));
  assert.ok(hubObservation!.includes('2 in "Orders"'));
  assert.ok(hubObservation!.includes('1 in "Tickets"'));
  assert.ok(!hubObservation!.includes("Yossi Cohen"), "Yossi Cohen has only 1 link and must not be reported as the hub");
});

test("computeBusinessTwin falls back to the next real candidate when the top-linked id no longer resolves to a real record, instead of dropping the insight entirely", () => {
  // deleteRecord itself can't produce this state today: migrate.ts declares
  // a real REFERENCES constraint on every relation column and openDatabase
  // turns PRAGMA foreign_keys ON, so SQLite refuses to delete a Customer
  // still referenced by an Order/Ticket row (confirmed by hand: the delete
  // throws "FOREIGN KEY constraint failed"), and diffAndMigrate never drops
  // a table either. So a dangling relation id isn't reachable through this
  // app's own code paths right now -- this test simulates it directly
  // (temporarily disabling FK enforcement to delete the referenced row
  // anyway) purely to prove the fallback logic itself is correct, as cheap
  // insurance against a future code path (or a bug in a different layer)
  // ever producing a stale id computeRelationHubObservation has to handle.
  const hubProject: Project = {
    ...project,
    description: "I need to track orders and support tickets for my customers",
    spec: {
      ...project.spec,
      entities: [
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "total", type: "number", required: true },
            { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
        {
          name: "Ticket",
          label: "Tickets",
          fields: [
            { name: "subject", type: "text", required: true },
            { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, hubProject.id, hubProject.spec);
  const [customer, order, ticket] = hubProject.spec.entities;
  const { id: dana } = insertRecord(db, hubProject.id, customer, { name: "Dana Levi" });
  const { id: yossi } = insertRecord(db, hubProject.id, customer, { name: "Yossi Cohen" });
  // Dana: 3 links (the top candidate) -- Yossi: 2 links (a real, valid runner-up).
  insertRecord(db, hubProject.id, order, { total: 50, customerId: dana });
  insertRecord(db, hubProject.id, order, { total: 30, customerId: dana });
  insertRecord(db, hubProject.id, ticket, { subject: "Refund", customerId: dana });
  insertRecord(db, hubProject.id, order, { total: 10, customerId: yossi });
  insertRecord(db, hubProject.id, ticket, { subject: "Where's my order?", customerId: yossi });

  // Simulates Dana being gone while her old customerId is still sitting in
  // two Order rows and one Ticket row -- FK enforcement (see comment above)
  // means the app itself can never reach this state through deleteRecord,
  // so it's forced here directly: FKs off, a raw delete of just the
  // customers row, FKs back on for the rest of the test.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.prepare(`DELETE FROM ${tableNameFor(hubProject.id, customer.name)} WHERE id = ?`).run(dana);
  db.exec("PRAGMA foreign_keys = ON;");

  const twin = computeBusinessTwin(db, hubProject);
  const hubObservation = twin.observations.find((o) => o.includes("most-linked record"));
  assert.ok(
    hubObservation,
    `expected the insight to fall back to Yossi Cohen (2 real links) instead of disappearing, got: ${JSON.stringify(twin.observations)}`,
  );
  assert.ok(hubObservation!.includes("Yossi Cohen"), `expected Yossi Cohen as the fallback hub, got: "${hubObservation}"`);
  assert.ok(hubObservation!.includes("2 links total"));
  assert.ok(!hubObservation!.includes("Dana Levi"), "Dana Levi was deleted and must not be reported as the hub");
});
