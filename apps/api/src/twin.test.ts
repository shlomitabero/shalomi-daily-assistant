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
  assert.equal(twin.mostActiveObservation?.entityName, "Customer");
  assert.ok(twin.mostActiveObservation?.text.includes("לקוחות"));
  assert.ok(
    !twin.observations.some((o) => o.includes("לקוחות")),
    "the most-active fact must live only in mostActiveObservation now, not also duplicated into the plain observations array",
  );
  assert.ok(
    !twin.observations.some((o) => o.includes("תורים")),
    "the unused-entity fact must live only in jumpableObservations now, not the plain observations array",
  );
  const unusedObservation = twin.jumpableObservations.find((o) => o.text.includes("תורים"));
  assert.ok(unusedObservation, `expected a jumpable unused-entity observation naming "תורים", got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.equal(unusedObservation!.entityName, "Appointment");
});

/**
 * New in this round: before, two or more unused entities were folded into
 * one sentence naming all of them at once ("No records yet in: X, Y"),
 * which meant it could never be a single clickable jump anyway. Now each
 * gets its own jumpableObservations entry, exactly like every other insight
 * in this panel already gets one entry per fact. This is the case that
 * proves the fix genuinely handles more than one stale/unused entity at
 * once, not just the single-entity case the test above already covers.
 */
test("computeBusinessTwin gives each of several unused entities its own independently-jumpable observation, not one sentence naming all of them", () => {
  const threeEntityProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        ...project.spec.entities,
        { name: "Invoice", label: "חשבוניות", fields: [{ name: "total", type: "number", required: true }] },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, threeEntityProject.id, threeEntityProject.spec);
  // Give Customer at least one record so it's the only non-unused entity;
  // Appointment and Invoice both stay unused.
  insertRecord(db, threeEntityProject.id, threeEntityProject.spec.entities[0], { name: "Alice" });

  const twin = computeBusinessTwin(db, threeEntityProject);
  assert.deepEqual(
    twin.unused.map((e) => e.name).sort(),
    ["Appointment", "Invoice"],
  );
  const unusedEntityNames = twin.jumpableObservations
    .filter((o) => o.text.includes("תורים") || o.text.includes("חשבוניות"))
    .map((o) => o.entityName)
    .sort();
  assert.deepEqual(
    unusedEntityNames,
    ["Appointment", "Invoice"],
    `expected one independently-jumpable observation per unused entity, got: ${JSON.stringify(twin.jumpableObservations)}`,
  );
  assert.ok(
    !twin.jumpableObservations.some((o) => o.text.includes("תורים") && o.text.includes("חשבוניות")),
    "the two unused entities must never be bundled into a single observation's text",
  );
});

/**
 * mostActive's reduce uses a strict `>` comparison, so a tie keeps
 * whichever entity was already `best` -- the earlier one in
 * project.spec.entities order -- rather than the later one with the same
 * count. This is a real, deterministic choice (not an arbitrary "whatever
 * the reduce happens to do"), but nothing verified it: a change from `>`
 * to `>=` would silently flip which entity wins a tie, with the wrong one
 * reported as "most active" to a real user, and no test would catch it.
 */
test("computeBusinessTwin breaks a tie in mostActive by keeping the earlier entity in spec order, not the later one with the same count", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const [customer, appointment] = project.spec.entities;
  insertRecord(db, project.id, customer, { name: "Alice" });
  insertRecord(db, project.id, customer, { name: "Bob" });
  insertRecord(db, project.id, appointment, { title: "Haircut" });
  insertRecord(db, project.id, appointment, { title: "Color" });

  const twin = computeBusinessTwin(db, project);
  assert.equal(twin.mostActive?.name, "Customer", `expected the earlier-declared entity to win a genuine tie, got: ${twin.mostActive?.name}`);
  assert.equal(twin.mostActive?.count, 2);
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
    twin.jumpableObservations.some((o) => o.text.includes("2 of 3 records have no") && o.entityName === "Ticket"),
    `expected a relation-coverage observation, got: ${JSON.stringify(twin.jumpableObservations)}`,
  );
  assert.ok(
    !twin.observations.some((o) => o.includes("have no")),
    "the relation-coverage fact must live only in jumpableObservations now, not also duplicated into the plain observations array",
  );

  // Once every ticket has a customer, the observation must disappear -- it
  // reports a real gap, not a permanent nag.
  const db2 = openDatabase(":memory:");
  applyMigrations(db2, relationProject.id, relationProject.spec);
  const { id: customerId2 } = insertRecord(db2, relationProject.id, customer, { name: "Dana Levi" });
  insertRecord(db2, relationProject.id, ticket, { subject: "Can't log in", customerId: customerId2 });
  const twinFullyLinked = computeBusinessTwin(db2, relationProject);
  assert.ok(!twinFullyLinked.jumpableObservations.some((o) => o.text.includes("have no")));
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
  assert.ok(
    twin.mostLinkedRecord,
    `expected a most-linked-record insight, got: ${JSON.stringify(twin.mostLinkedRecord)}`,
  );
  const hubObservation = twin.mostLinkedRecord!.text;
  assert.ok(hubObservation.includes("Dana Levi"), `expected Dana Levi (3 total links) to be the hub, got: "${hubObservation}"`);
  assert.ok(hubObservation.includes("3 links total"));
  assert.ok(hubObservation.includes('2 in "Orders"'));
  assert.ok(hubObservation.includes('1 in "Tickets"'));
  assert.ok(!hubObservation.includes("Yossi Cohen"), "Yossi Cohen has only 1 link and must not be reported as the hub");
  // New in this round: the insight is also resolved down to a real,
  // clickable entityName+id -- not just prose -- so a person can jump
  // straight to the actual record instead of just reading about it.
  assert.equal(twin.mostLinkedRecord!.entityName, "Customer");
  assert.equal(twin.mostLinkedRecord!.recordId, dana);
  assert.equal(
    twin.observations.some((o) => o.includes("most-linked record")),
    false,
    "the structured mostLinkedRecord insight must not ALSO be duplicated into the plain observations array",
  );
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
  assert.ok(
    twin.mostLinkedRecord,
    `expected the insight to fall back to Yossi Cohen (2 real links) instead of disappearing, got: ${JSON.stringify(twin.mostLinkedRecord)}`,
  );
  const hubObservation = twin.mostLinkedRecord!.text;
  assert.ok(hubObservation.includes("Yossi Cohen"), `expected Yossi Cohen as the fallback hub, got: "${hubObservation}"`);
  assert.ok(hubObservation.includes("2 links total"));
  assert.ok(!hubObservation.includes("Dana Levi"), "Dana Levi was deleted and must not be reported as the hub");
  assert.equal(twin.mostLinkedRecord!.recordId, yossi, "the fallback insight's own recordId must point at the real Yossi record, not the stale deleted one");
});

/**
 * computeRelationHubObservation has no explicit tie-break rule for two
 * candidates with the exact same total link count -- whichever ends up
 * first in the `candidates` array before the (stable) sort wins, and that
 * position is itself just a side effect of iteration order: listRecords
 * returns rows `ORDER BY id DESC` (repository.ts), so the customer id
 * attached to the *most recently inserted* Order row is the first one
 * Map-inserted into `countsById`/`perId`, and so the first candidate
 * pushed. Confirmed empirically (not just reasoned about) before writing
 * this test: with Dana and Yossi genuinely tied at 2 links each, Yossi
 * -- whose most recent Order row has the highest id -- wins, even though
 * Dana was created first and would win any "first customer" or "lowest
 * id" tiebreaker a reader might otherwise assume. This is worth locking
 * in specifically because it's an *accidental* consequence of iteration
 * order, not a deliberate rule -- exactly the kind of thing a future
 * refactor (switching a Map to a plain object, changing which order
 * results are fetched in, "simplifying" the sort) could silently flip
 * with nothing to catch it.
 */
test("computeBusinessTwin's most-linked-record insight has a real, if accidental, tie-break rule: the candidate whose most recently inserted record comes first wins", () => {
  const hubProject: Project = {
    ...project,
    description: "I need to track orders for my customers",
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
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, hubProject.id, hubProject.spec);
  const [customer, order] = hubProject.spec.entities;
  const { id: dana } = insertRecord(db, hubProject.id, customer, { name: "Dana Levi" });
  const { id: yossi } = insertRecord(db, hubProject.id, customer, { name: "Yossi Cohen" });
  // Genuinely tied at 2 links each -- Yossi's orders were inserted last,
  // so his customerId is the first one encountered when listRecords'
  // DESC-ordered rows are scanned.
  insertRecord(db, hubProject.id, order, { total: 50, customerId: dana });
  insertRecord(db, hubProject.id, order, { total: 30, customerId: dana });
  insertRecord(db, hubProject.id, order, { total: 20, customerId: yossi });
  insertRecord(db, hubProject.id, order, { total: 10, customerId: yossi });

  const twin = computeBusinessTwin(db, hubProject);
  assert.ok(twin.mostLinkedRecord, `expected a most-linked-record insight even on a tie, got: ${JSON.stringify(twin.mostLinkedRecord)}`);
  const hubObservation = twin.mostLinkedRecord!.text;
  assert.ok(hubObservation.includes("Yossi Cohen"), `expected Yossi Cohen (most-recently-inserted tie-break winner) as the hub, got: "${hubObservation}"`);
  assert.ok(hubObservation.includes("2 links total"));
  assert.ok(!hubObservation.includes("Dana Levi"), "Dana Levi has the same link count but was created first, and must lose the tie under the current rule");
});

test("computeBusinessTwin flags two records that share the exact same display name as a possible duplicate", () => {
  const db = openDatabase(":memory:");
  const enProject: Project = { ...project, description: "I need a CRM for customers and appointments" };
  applyMigrations(db, enProject.id, enProject.spec);
  const customer = enProject.spec.entities[0];
  insertRecord(db, enProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, enProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, enProject.id, customer, { name: "Yossi Cohen" });

  const twin = computeBusinessTwin(db, enProject);
  const dupObservation = twin.jumpableObservations.find((o) => o.text.includes("possibly a duplicate"));
  assert.ok(dupObservation, `expected a duplicate observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.ok(dupObservation!.text.includes("2 records"));
  assert.ok(dupObservation!.text.includes("Dana Levi"));
  assert.ok(dupObservation!.entityName === "Customer");
  assert.ok(!dupObservation!.text.includes("Yossi Cohen"), "Yossi Cohen appears only once and must not be reported");
  assert.ok(
    !twin.observations.some((o) => o.includes("possibly a duplicate")),
    "the duplicate fact must live only in jumpableObservations now, not also duplicated into the plain observations array",
  );
});

test("computeBusinessTwin stays silent about duplicates when every record's display name is genuinely unique", () => {
  const db = openDatabase(":memory:");
  const enProject: Project = { ...project, description: "I need a CRM for customers and appointments" };
  applyMigrations(db, enProject.id, enProject.spec);
  const customer = enProject.spec.entities[0];
  insertRecord(db, enProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, enProject.id, customer, { name: "Yossi Cohen" });

  const twin = computeBusinessTwin(db, enProject);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("possibly a duplicate")));
});

test("computeBusinessTwin never flags two records as duplicates just because they share the same value on a non-text fallback field", () => {
  // Shipment has no "name"/"title" field and no text field at all, so
  // pickDisplayField falls back to the only field it has -- "weight", a
  // number. Two unrelated shipments that happen to both weigh 5kg are not
  // duplicates in any meaningful sense; duplicate-detection must skip an
  // entity entirely rather than flag every coincidental numeric match.
  const noNameProject: Project = {
    ...project,
    description: "I need to track shipments",
    spec: {
      ...project.spec,
      entities: [{ name: "Shipment", label: "Shipments", fields: [{ name: "weight", type: "number", required: true }] }],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, noNameProject.id, noNameProject.spec);
  const shipment = noNameProject.spec.entities[0];
  insertRecord(db, noNameProject.id, shipment, { weight: 5 });
  insertRecord(db, noNameProject.id, shipment, { weight: 5 });

  const twin = computeBusinessTwin(db, noNameProject);
  assert.ok(
    !twin.jumpableObservations.some((o) => o.text.includes("possibly a duplicate")),
    `an entity with no text display field must never be flagged for duplicates, got: ${JSON.stringify(twin.jumpableObservations)}`,
  );
});

test("computeBusinessTwin phrases the duplicate observation in Hebrew for a Hebrew description", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi" });
  insertRecord(db, project.id, customer, { name: "Dana Levi" });

  const twin = computeBusinessTwin(db, project);
  assert.ok(twin.jumpableObservations.some((o) => o.text.includes("יתכן כפילות")));
});

/** Backdates a real record's own createdAt column directly (insertRecord always stamps "now", with no override param), the same raw-SQL technique the most-linked-record fallback test above already uses via tableNameFor. */
function backdateRecord(db: ReturnType<typeof openDatabase>, projectId: string, entityName: string, recordId: number, daysAgo: number) {
  const isoDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE ${tableNameFor(projectId, entityName)} SET createdAt = ? WHERE id = ?`).run(isoDate, recordId);
}

test("computeBusinessTwin reports how many records were added in the last week, counting only the genuinely recent ones", () => {
  const db = openDatabase(":memory:");
  const enProject: Project = { ...project, description: "I need a CRM for customers and appointments" };
  applyMigrations(db, enProject.id, enProject.spec);
  const customer = enProject.spec.entities[0];
  insertRecord(db, enProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, enProject.id, customer, { name: "Yossi Cohen" });
  const old = insertRecord(db, enProject.id, customer, { name: "Noa Peretz" });
  backdateRecord(db, enProject.id, customer.name, old.id as number, 14);

  const twin = computeBusinessTwin(db, enProject);
  const activityObservation = twin.observations.find((o) => o.includes("added in the last week"));
  assert.ok(activityObservation, `expected a recent-activity observation, got: ${JSON.stringify(twin.observations)}`);
  assert.ok(activityObservation!.includes("2 records"), `expected exactly the 2 fresh records counted, got: "${activityObservation}"`);
});

test("computeBusinessTwin flags an entity with real records but none added in the last 30 days as stale, and stays silent for one with recent activity", () => {
  const db = openDatabase(":memory:");
  const enProject: Project = {
    ...project,
    description: "I need a CRM for customers and appointments",
    spec: {
      ...project.spec,
      entities: [
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        { name: "Appointment", label: "Appointments", fields: [{ name: "title", type: "text", required: true }] },
      ],
    },
  };
  applyMigrations(db, enProject.id, enProject.spec);
  const [customer, appointment] = enProject.spec.entities;

  // Customer: every record is old -> stale.
  const staleCustomer = insertRecord(db, enProject.id, customer, { name: "Dana Levi" });
  backdateRecord(db, enProject.id, customer.name, staleCustomer.id as number, 45);

  // Appointment: one old record, but one recent one too -> NOT stale.
  const oldAppt = insertRecord(db, enProject.id, appointment, { title: "Old haircut" });
  backdateRecord(db, enProject.id, appointment.name, oldAppt.id as number, 45);
  insertRecord(db, enProject.id, appointment, { title: "New haircut" });

  const twin = computeBusinessTwin(db, enProject);
  const staleObservation = twin.jumpableObservations.find((o) => o.text.includes("No new records added in the last 30 days"));
  assert.ok(staleObservation, `expected a jumpable stale-entity observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.ok(staleObservation!.text.includes("Customers"), `expected the stale Customer entity named, got: "${staleObservation!.text}"`);
  assert.equal(staleObservation!.entityName, "Customer");
  assert.ok(
    !twin.jumpableObservations.some((o) => o.text.includes("Appointments") && o.text.includes("30 days")),
    "Appointment has a recent record and must not be flagged stale",
  );
});

test("computeBusinessTwin phrases the activity observations in Hebrew for a Hebrew description", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const old = insertRecord(db, project.id, customer, { name: "Dana Levi" });
  backdateRecord(db, project.id, customer.name, old.id as number, 45);

  const twin = computeBusinessTwin(db, project);
  assert.ok(twin.jumpableObservations.some((o) => o.text.includes("לא נוספו רשומות חדשות ב-30 הימים האחרונים")));
});

/**
 * New in this round: every observation above is derived from counts,
 * relation fields, the display field, or createdAt -- the Business Twin
 * never once read a `number` field's actual value, even though most of
 * this app's own domain-library entities have one (Order.total,
 * Payment.amount). A real order-total sum was invisible to the one panel
 * meant to summarize the business's data.
 */
test("computeBusinessTwin reports a number field's total and average across real records", () => {
  const orderProject: Project = {
    ...project,
    description: "An online store with orders",
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "customer", type: "text", required: true },
            { name: "total", label: "Total", type: "number", required: true },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", total: 100 });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", total: 250 });
  insertRecord(db, orderProject.id, order, { customer: "Noa", total: 150 });

  const twin = computeBusinessTwin(db, orderProject);
  const numeric = twin.jumpableObservations.find((o) => o.text.includes("Total"));
  assert.ok(numeric, `expected a numeric-aggregate observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.equal(numeric!.entityName, "Order");
  assert.match(numeric!.text, /500/);
  assert.match(numeric!.text, /166\.7/, "the average of 100+250+150 across 3 records is 166.666..., rounded to one decimal");
  assert.match(numeric!.text, /3 records/);
});

test("computeBusinessTwin stays silent about a number field when no record has a real value for it", () => {
  const orderProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "customer", type: "text", required: true },
            { name: "total", label: "Total", type: "number", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  insertRecord(db, orderProject.id, orderProject.spec.entities[0], { customer: "Dana", total: null });

  const twin = computeBusinessTwin(db, orderProject);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("Total")));
});

test("computeBusinessTwin phrases the numeric-aggregate observation in Hebrew for a Hebrew description", () => {
  const orderProject: Project = {
    ...project,
    description: "חנות מקוונת עם הזמנות",
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "הזמנות",
          fields: [
            { name: "customer", type: "text", required: true },
            { name: "total", label: "סכום", type: "number", required: true },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  insertRecord(db, orderProject.id, orderProject.spec.entities[0], { customer: "דנה", total: 200 });

  const twin = computeBusinessTwin(db, orderProject);
  assert.ok(twin.jumpableObservations.some((o) => o.text.includes('סה"כ') && o.text.includes("הזמנות")));
});

/**
 * The `enum` counterpart to the numeric-aggregate gap above -- a status
 * field's actual value distribution (e.g. how many Orders are 'pending'
 * vs. 'shipped') was equally invisible.
 */
test("computeBusinessTwin reports an enum field's value distribution when there's a real split to see", () => {
  const orderProject: Project = {
    ...project,
    description: "An online store with orders",
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "customer", type: "text", required: true },
            {
              name: "status",
              label: "Status",
              type: "enum",
              required: true,
              enumValues: ["Pending", "Shipped", "Cancelled"],
            },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", status: "Pending" });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", status: "Pending" });
  insertRecord(db, orderProject.id, order, { customer: "Noa", status: "Shipped" });

  const twin = computeBusinessTwin(db, orderProject);
  const distribution = twin.jumpableObservations.find((o) => o.text.includes("Status"));
  assert.ok(distribution, `expected an enum-distribution observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.equal(distribution!.entityName, "Order");
  // Sorted by count descending -- the larger bucket (2 "Pending") reads before the smaller one (1 "Shipped").
  assert.match(distribution!.text, /2 "Pending".*1 "Shipped"/);
});

test("computeBusinessTwin stays silent about an enum field when every record shares the exact same single value", () => {
  const orderProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "customer", type: "text", required: true },
            { name: "status", label: "Status", type: "enum", required: true, enumValues: ["Pending", "Shipped"] },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", status: "Pending" });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", status: "Pending" });

  const twin = computeBusinessTwin(db, orderProject);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("Status")));
});

test("computeBusinessTwin's enum distribution uses the enum's display label, not the raw stored value", () => {
  const orderProject: Project = {
    ...project,
    description: "חנות מקוונת עם הזמנות",
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "הזמנות",
          fields: [
            { name: "customer", type: "text", required: true },
            {
              name: "status",
              label: "סטטוס",
              type: "enum",
              required: true,
              enumValues: ["Pending", "Shipped"],
              enumLabels: { Pending: "ממתין", Shipped: "נשלח" },
            },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "דנה", status: "Pending" });
  insertRecord(db, orderProject.id, order, { customer: "יוסי", status: "Shipped" });

  const twin = computeBusinessTwin(db, orderProject);
  const distribution = twin.jumpableObservations.find((o) => o.text.includes("סטטוס"));
  assert.ok(distribution, `expected an enum-distribution observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(distribution!.text, /ממתין/);
  assert.match(distribution!.text, /נשלח/);
});
