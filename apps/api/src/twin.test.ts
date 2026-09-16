import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, insertRecord, openDatabase } from "@forge/db";
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
