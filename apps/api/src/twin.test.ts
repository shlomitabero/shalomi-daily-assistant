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

/**
 * Regression test for a real bug found by round 635's Explore survey:
 * FieldSchema/EntitySchema (packages/shared) only enforce uniqueness on a
 * field's `name`, never its display `label`, and the field-label route
 * (PATCH .../fields/:fieldName/label) lets a user rename two different
 * relation fields on the same entity to the identical label. Before this
 * fix, computeRelationCoverageObservations would then emit two
 * identical-looking "... have no "Customer" set." lines with no way to
 * tell which real field either one is about, even though field.name was
 * sitting right there unused -- the same gap round 623 already closed for
 * computeRelationHubObservation's own breakdown text.
 */
test("computeBusinessTwin's relation-coverage observations disambiguate two relation fields on the same entity that share a label", () => {
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
            { name: "escalatedTo", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, relationProject.id, relationProject.spec);
  const [customer, ticket] = relationProject.spec.entities;
  insertRecord(db, relationProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, relationProject.id, ticket, { subject: "Can't log in", customerId: null, escalatedTo: null });

  const twin = computeBusinessTwin(db, relationProject);
  const coverageObservations = twin.jumpableObservations.filter((o) => o.text.includes("have no"));
  assert.equal(coverageObservations.length, 2, `expected one observation per ambiguous relation field, got: ${JSON.stringify(coverageObservations)}`);
  assert.ok(
    coverageObservations.some((o) => o.text.includes('"Customer" (customerId)')),
    `expected the customerId field to be disambiguated by its own name, got: ${JSON.stringify(coverageObservations)}`,
  );
  assert.ok(
    coverageObservations.some((o) => o.text.includes('"Customer" (escalatedTo)')),
    `expected the escalatedTo field to be disambiguated by its own name, got: ${JSON.stringify(coverageObservations)}`,
  );
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

test("computeBusinessTwin's most-linked breakdown disambiguates two relation fields on the same entity pointing at the same target", () => {
  // Deal has BOTH customerId and referredBy pointing at Customer -- a
  // schema-legal shape (no uniqueness constraint across a field's own
  // relationTo within one entity). Without disambiguation, the breakdown
  // would render two bare '... in "Deals"' lines with no way to tell them
  // apart, even though fieldLabel was computed for exactly this purpose.
  const hubProject: Project = {
    ...project,
    description: "I need to track deals and who referred them",
    spec: {
      ...project.spec,
      entities: [
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "Deal",
          label: "Deals",
          fields: [
            { name: "amount", type: "number", required: true },
            { name: "customerId", label: "Customer", type: "relation", required: false, relationTo: "Customer" },
            { name: "referredBy", label: "Referred By", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, hubProject.id, hubProject.spec);
  const [customer, deal] = hubProject.spec.entities;
  const { id: dana } = insertRecord(db, hubProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, hubProject.id, deal, { amount: 100, customerId: dana });
  insertRecord(db, hubProject.id, deal, { amount: 200, customerId: dana });
  insertRecord(db, hubProject.id, deal, { amount: 300, customerId: dana });
  insertRecord(db, hubProject.id, deal, { amount: 50, referredBy: dana });
  insertRecord(db, hubProject.id, deal, { amount: 60, referredBy: dana });

  const twin = computeBusinessTwin(db, hubProject);
  assert.ok(twin.mostLinkedRecord, `expected a most-linked-record insight, got: ${JSON.stringify(twin.mostLinkedRecord)}`);
  const hubObservation = twin.mostLinkedRecord!.text;
  assert.ok(hubObservation.includes("Dana Levi"), `expected Dana Levi to be the hub, got: "${hubObservation}"`);
  assert.ok(hubObservation.includes("5 links total"));
  assert.ok(
    hubObservation.includes('3 in "Deals" (via Customer)'),
    `expected the customerId breakdown to be disambiguated by field label, got: "${hubObservation}"`,
  );
  assert.ok(
    hubObservation.includes('2 in "Deals" (via Referred By)'),
    `expected the referredBy breakdown to be disambiguated by field label, got: "${hubObservation}"`,
  );
});

/**
 * Round 867: every one of twin.ts's observation builders (relation
 * coverage/hub, duplicate detection, activity staleness, numeric
 * aggregates, enum distributions) and the top-level `entities` stat array
 * read an entity's own display label (`entity.label ?? entity.name`) raw,
 * with no collision check against sibling entities -- unlike the FIELD-label
 * collision guard every single one of those builders already carries (each
 * via its own local `labelOccurrences` map, several already exercised by
 * this file's own "...disambiguate two [relation/number/enum] fields..."
 * tests above/below). The Entity Label editor and its PATCH
 * /entities/:entityName/label route (routes/projects.ts) enforce no
 * uniqueness at all -- any real user can relabel two different entities to
 * the exact same string in one UI action -- and checkpointDiff.ts's/
 * pipeline.ts's own entityLabelOccurrences/entityDisplayLabel pair already
 * establish this as a legal, expected state elsewhere in this codebase.
 * Mirrors that exact pair into twin.ts, computed once per
 * computeBusinessTwin call and threaded into every helper, so two
 * same-labeled entities are disambiguated by their own (always-unique)
 * name everywhere the Business Twin names an entity -- the stat tiles
 * (entities/mostActive/unused), and every prose observation below.
 */
test("computeBusinessTwin's entities/mostActive/unused stats disambiguate two entities that share the same label", () => {
  const dualLabelProject: Project = {
    ...project,
    description: "I need to track active and archived customers separately",
    spec: {
      ...project.spec,
      entities: [
        { name: "CustomerActive", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
        { name: "CustomerArchived", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, dualLabelProject.id, dualLabelProject.spec);
  const [active, archived] = dualLabelProject.spec.entities;
  insertRecord(db, dualLabelProject.id, active, { name: "Dana Levi" });
  insertRecord(db, dualLabelProject.id, active, { name: "Yossi Cohen" });

  const twin = computeBusinessTwin(db, dualLabelProject);
  const activeStat = twin.entities.find((e) => e.name === "CustomerActive")!;
  const archivedStat = twin.entities.find((e) => e.name === "CustomerArchived")!;
  assert.equal(activeStat.label, "Customer (CustomerActive)", `expected the active entity's own label to be disambiguated, got: ${JSON.stringify(twin.entities)}`);
  assert.equal(archivedStat.label, "Customer (CustomerArchived)", `expected the archived entity's own label to be disambiguated, got: ${JSON.stringify(twin.entities)}`);

  assert.ok(twin.mostActive);
  assert.equal(twin.mostActive!.label, "Customer (CustomerActive)", "mostActive must reuse the already-disambiguated stat, not a bare 'Customer'");
  assert.ok(
    twin.mostActiveObservation!.text.includes("Customer (CustomerActive)"),
    `expected the most-active prose to name which of the two same-labeled entities it means, got: "${twin.mostActiveObservation!.text}"`,
  );

  assert.equal(twin.unused.length, 1);
  assert.equal(twin.unused[0].label, "Customer (CustomerArchived)");
  const unusedObservation = twin.jumpableObservations.find((o) => o.entityName === "CustomerArchived");
  assert.ok(
    unusedObservation?.text.includes("Customer (CustomerArchived)"),
    `expected the unused-entity prose to name which of the two same-labeled entities it means, got: ${JSON.stringify(twin.jumpableObservations)}`,
  );
});

test("computeBusinessTwin's duplicate-detection and activity-staleness observations disambiguate two entities that share the same label", () => {
  const dualLabelProject: Project = {
    ...project,
    description: "I need to track active and archived customers separately",
    spec: {
      ...project.spec,
      entities: [
        { name: "CustomerActive", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
        { name: "CustomerArchived", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, dualLabelProject.id, dualLabelProject.spec);
  const [active, archived] = dualLabelProject.spec.entities;
  // Two active-customer records share the exact same display name -- a
  // genuine duplicate-detection hit.
  insertRecord(db, dualLabelProject.id, active, { name: "Repeated Name" });
  insertRecord(db, dualLabelProject.id, active, { name: "Repeated Name" });
  // The archived entity's one record is backdated past the staleness
  // threshold -- a genuine activity-staleness hit.
  const { id: archivedRecordId } = insertRecord(db, dualLabelProject.id, archived, { name: "Old Record" });
  backdateRecord(db, dualLabelProject.id, "CustomerArchived", archivedRecordId, 40);

  const twin = computeBusinessTwin(db, dualLabelProject);
  const duplicateObservation = twin.jumpableObservations.find((o) => o.entityName === "CustomerActive" && o.text.includes("Repeated Name"));
  assert.ok(duplicateObservation, `expected a duplicate-name observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.ok(
    duplicateObservation!.text.includes("Customer (CustomerActive)"),
    `expected the duplicate observation to disambiguate which same-labeled entity it's about, got: "${duplicateObservation!.text}"`,
  );

  const staleObservation = twin.jumpableObservations.find((o) => o.entityName === "CustomerArchived" && /30/.test(o.text));
  assert.ok(staleObservation, `expected a staleness observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.ok(
    staleObservation!.text.includes("Customer (CustomerArchived)"),
    `expected the staleness observation to disambiguate which same-labeled entity it's about, got: "${staleObservation!.text}"`,
  );
});

test("computeBusinessTwin's relation-coverage, numeric-aggregate, and enum-distribution observations disambiguate the ENTITY label (not just the field label already covered above) when two entities share a label", () => {
  const dualLabelProject: Project = {
    ...project,
    description: "I need to track active and archived orders separately",
    spec: {
      ...project.spec,
      entities: [
        { name: "Courier", label: "Couriers", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "OrderActive",
          label: "Orders",
          fields: [
            { name: "amount", type: "number", required: false },
            { name: "status", type: "enum", required: false, enumValues: ["pending", "shipped"] },
            { name: "courierId", type: "relation", required: false, relationTo: "Courier" },
          ],
        },
        {
          name: "OrderArchived",
          label: "Orders",
          fields: [
            { name: "amount", type: "number", required: false },
            { name: "status", type: "enum", required: false, enumValues: ["pending", "shipped"] },
            { name: "courierId", type: "relation", required: false, relationTo: "Courier" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, dualLabelProject.id, dualLabelProject.spec);
  const [, orderActive, orderArchived] = dualLabelProject.spec.entities;
  insertRecord(db, dualLabelProject.id, orderActive, { amount: 100, status: "pending", courierId: null });
  insertRecord(db, dualLabelProject.id, orderArchived, { amount: 50, status: "shipped", courierId: null });
  insertRecord(db, dualLabelProject.id, orderArchived, { amount: 70, status: "pending", courierId: null });

  const twin = computeBusinessTwin(db, dualLabelProject);

  const coverageActive = twin.jumpableObservations.find((o) => o.entityName === "OrderActive" && /no\b/i.test(o.text));
  assert.ok(coverageActive?.text.includes("Orders (OrderActive)"), `expected OrderActive's relation-coverage observation disambiguated, got: ${JSON.stringify(twin.jumpableObservations)}`);
  const coverageArchived = twin.jumpableObservations.find((o) => o.entityName === "OrderArchived" && /no\b/i.test(o.text));
  assert.ok(coverageArchived?.text.includes("Orders (OrderArchived)"), `expected OrderArchived's relation-coverage observation disambiguated, got: ${JSON.stringify(twin.jumpableObservations)}`);

  const aggregateActive = twin.numericStats.find((s) => s.entityName === "OrderActive");
  assert.equal(aggregateActive?.entityLabel, "Orders (OrderActive)");
  assert.ok(aggregateActive?.text.includes("Orders (OrderActive)"));
  const aggregateArchived = twin.numericStats.find((s) => s.entityName === "OrderArchived");
  assert.equal(aggregateArchived?.entityLabel, "Orders (OrderArchived)");
  assert.ok(aggregateArchived?.text.includes("Orders (OrderArchived)"));

  const distributionArchived = twin.distributions.find((d) => d.entityName === "OrderArchived");
  assert.equal(distributionArchived?.entityLabel, "Orders (OrderArchived)");
  assert.ok(distributionArchived?.text.includes("Orders (OrderArchived)"));
});

test("computeBusinessTwin's relation-hub observation disambiguates both the SOURCE entities' and the TARGET entity's own label when either collides with a sibling", () => {
  const dualLabelProject: Project = {
    ...project,
    description: "I need to track active and archived customers, and orders from two systems",
    spec: {
      ...project.spec,
      entities: [
        { name: "CustomerActive", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
        { name: "CustomerArchived", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "OrderOld",
          label: "Orders",
          fields: [
            { name: "total", type: "number", required: true },
            { name: "customerId", type: "relation", required: false, relationTo: "CustomerActive" },
          ],
        },
        {
          name: "OrderNew",
          label: "Orders",
          fields: [
            { name: "total", type: "number", required: true },
            { name: "customerId", type: "relation", required: false, relationTo: "CustomerActive" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, dualLabelProject.id, dualLabelProject.spec);
  const [active, , orderOld, orderNew] = dualLabelProject.spec.entities;
  const { id: dana } = insertRecord(db, dualLabelProject.id, active, { name: "Dana Levi" });
  insertRecord(db, dualLabelProject.id, orderOld, { total: 50, customerId: dana });
  insertRecord(db, dualLabelProject.id, orderOld, { total: 30, customerId: dana });
  insertRecord(db, dualLabelProject.id, orderNew, { total: 10, customerId: dana });

  const twin = computeBusinessTwin(db, dualLabelProject);
  assert.ok(twin.mostLinkedRecord, `expected a most-linked-record insight, got: ${JSON.stringify(twin.mostLinkedRecord)}`);
  const hubObservation = twin.mostLinkedRecord!.text;
  assert.ok(
    hubObservation.includes("Customer (CustomerActive)"),
    `expected the hub record's own TARGET entity label to be disambiguated, got: "${hubObservation}"`,
  );
  assert.ok(
    hubObservation.includes('2 in "Orders (OrderOld)"'),
    `expected OrderOld's own SOURCE entity label to be disambiguated, got: "${hubObservation}"`,
  );
  assert.ok(
    hubObservation.includes('1 in "Orders (OrderNew)"'),
    `expected OrderNew's own SOURCE entity label to be disambiguated, got: "${hubObservation}"`,
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

test("computeBusinessTwin flags duplicates that differ only by case or surrounding whitespace, the exact shape a real accidental double-import produces", () => {
  const db = openDatabase(":memory:");
  const enProject: Project = { ...project, description: "I need a CRM for customers and appointments" };
  applyMigrations(db, enProject.id, enProject.spec);
  const customer = enProject.spec.entities[0];
  insertRecord(db, enProject.id, customer, { name: "Dana Levi" });
  insertRecord(db, enProject.id, customer, { name: "dana levi " });
  insertRecord(db, enProject.id, customer, { name: "DANA LEVI" });
  insertRecord(db, enProject.id, customer, { name: "Yossi Cohen" });

  const twin = computeBusinessTwin(db, enProject);
  const dupObservation = twin.jumpableObservations.find((o) => o.text.includes("possibly a duplicate"));
  assert.ok(dupObservation, `expected a duplicate observation across case/whitespace variants, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.ok(dupObservation!.text.includes("3 records"), `expected all 3 variants grouped together, got: "${dupObservation!.text}"`);
  assert.ok(!dupObservation!.text.includes("Yossi Cohen"), "Yossi Cohen appears only once and must not be reported");
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

test("computeBusinessTwin flags duplicates for an entity whose picked display field is longtext, not just plain text", () => {
  // Feedback has no "name"/"title" field and no plain-text field either --
  // only a longtext field and a number -- so pickDisplayField (round 762)
  // falls back to "message" (longtext) over "rating" (number). Two records
  // with the exact same feedback text is the textbook accidental
  // double-submit this observation exists to catch, and must be flagged
  // the same way it would be for a plain "text" display field.
  const feedbackProject: Project = {
    ...project,
    description: "I need to track customer feedback",
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Feedback",
          label: "Feedback",
          fields: [
            { name: "message", type: "longtext", required: true },
            { name: "rating", type: "number", required: true },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, feedbackProject.id, feedbackProject.spec);
  const feedback = feedbackProject.spec.entities[0];
  insertRecord(db, feedbackProject.id, feedback, { message: "Great service, very happy!", rating: 5 });
  insertRecord(db, feedbackProject.id, feedback, { message: "Great service, very happy!", rating: 1 });

  const twin = computeBusinessTwin(db, feedbackProject);
  const dupObservation = twin.jumpableObservations.find((o) => o.text.includes("possibly a duplicate"));
  assert.ok(dupObservation, `expected a duplicate observation for a longtext display field, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.ok(dupObservation!.text.includes("2 records"), `expected both records grouped together, got: "${dupObservation!.text}"`);
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
 * Round 1090: V8/ICU's "he-IL" locale silently prepends a real, invisible
 * U+200E LEFT-TO-RIGHT MARK before the minus sign of any negative number
 * -- confirmed directly via Node (`(-200).toLocaleString("he-IL")` embeds
 * it, the identical "en-US" call doesn't). sum/average here come from a
 * number field with no positivity constraint (a profit/loss or balance
 * field can be genuinely negative), and this observation's own .text
 * isn't only rendered on screen -- twinReport.ts folds it verbatim into a
 * downloadable plain-text snapshot (its own doc comment: "WhatsApp,
 * email, paste anywhere"), the same gap round 1089 already fixed in
 * automations.ts's interpolateTemplate.
 */
test("computeBusinessTwin's numeric-aggregate observation strips the invisible bidi mark toLocaleString adds before a negative sum/average under a Hebrew description", () => {
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
            { name: "profit", label: "רווח", type: "number", required: true },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  insertRecord(db, orderProject.id, orderProject.spec.entities[0], { customer: "דנה", profit: -200 });

  const twin = computeBusinessTwin(db, orderProject);
  const observation = twin.jumpableObservations.find((o) => o.text.includes('סה"כ') && o.fieldName === "profit");
  assert.ok(observation, `expected a numeric-aggregate observation for "profit", got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(observation!.text, /-200/, "the negative sum must render with a plain minus sign, no invisible character before it");
  assert.ok(!observation!.text.includes("‎") && !observation!.text.includes("‏"), "the observation text must contain no invisible bidi mark at all");
});

/**
 * Regression test for a real bug found by round 635's Explore survey: the
 * same label-collision gap round 623 closed for computeRelationHubObservation
 * and round 635 closed for computeRelationCoverageObservations above, but
 * for number fields. subtotal and shipping both renamed to "Amount" (a
 * schema-legal, one-click-away state -- only field.name is unique, never
 * label) used to produce two identical-looking "Total "Amount" in..." lines
 * with no way to tell which real money field either total is actually for.
 */
test("computeBusinessTwin's numeric-aggregate observations disambiguate two number fields on the same entity that share a label", () => {
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
            { name: "subtotal", label: "Amount", type: "number", required: true },
            { name: "shipping", label: "Amount", type: "number", required: true },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", subtotal: 500, shipping: 10 });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", subtotal: 300, shipping: 20 });

  const twin = computeBusinessTwin(db, orderProject);
  const numericObservations = twin.jumpableObservations.filter((o) => o.text.includes("Amount"));
  assert.equal(numericObservations.length, 2, `expected one observation per ambiguous number field, got: ${JSON.stringify(numericObservations)}`);
  const subtotalObs = numericObservations.find((o) => o.text.includes('"Amount" (subtotal)'));
  const shippingObs = numericObservations.find((o) => o.text.includes('"Amount" (shipping)'));
  assert.ok(subtotalObs, `expected the subtotal field to be disambiguated by its own name, got: ${JSON.stringify(numericObservations)}`);
  assert.ok(shippingObs, `expected the shipping field to be disambiguated by its own name, got: ${JSON.stringify(numericObservations)}`);
  assert.match(subtotalObs!.text, /800/, "subtotal's own total (500+300) must not be confused with shipping's");
  assert.match(shippingObs!.text, /30/, "shipping's own total (10+20) must not be confused with subtotal's");
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

/**
 * Round 669 regression test: a boolean field's two values are the same
 * "small, fixed value space" category entityFormatting.ts's own
 * isGroupableField/findFilterableFields already treat identically to an
 * enum's -- but computeEnumDistributionObservations' own field filter
 * never widened to match, leaving a business-meaningful boolean like
 * "Paid" with no distribution insight at all.
 */
test("computeBusinessTwin reports a boolean field's TRUE/FALSE value distribution, the same way it already does for enum fields", () => {
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
            { name: "paid", label: "Paid", type: "boolean", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", paid: true });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", paid: true });
  insertRecord(db, orderProject.id, order, { customer: "Noa", paid: false });

  const twin = computeBusinessTwin(db, orderProject);
  const distribution = twin.jumpableObservations.find((o) => o.text.includes("Paid"));
  assert.ok(distribution, `expected a boolean-distribution observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.equal(distribution!.entityName, "Order");
  // Sorted by count descending -- the larger bucket (2 TRUE) reads before the smaller one (1 FALSE).
  assert.match(distribution!.text, /2 "TRUE".*1 "FALSE"/);
});

/**
 * Round 1134: before repository.ts's rowToRecord fix, a boolean field
 * left out of insertRecord round-tripped as `false` (Boolean(null)), so a
 * record that was never actually answered got silently folded into the
 * FALSE bucket here -- computeEnumDistributionObservations' own `raw ===
 * null` skip (written for exactly this case) was simply unreachable for
 * booleans. Confirms a never-answered "paid" record is excluded from the
 * breakdown entirely, the same way it already is for an enum field left
 * unset, rather than inflating the FALSE count.
 */
test("computeBusinessTwin's boolean distribution excludes a never-answered (null) record entirely, instead of folding it into FALSE", () => {
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
            { name: "paid", label: "Paid", type: "boolean", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", paid: true });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", paid: true });
  insertRecord(db, orderProject.id, order, { customer: "Noa", paid: false });
  insertRecord(db, orderProject.id, order, { customer: "Amir" }); // "paid" never answered

  const twin = computeBusinessTwin(db, orderProject);
  const distribution = twin.jumpableObservations.find((o) => o.text.includes("Paid"));
  assert.ok(distribution, `expected a boolean-distribution observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(distribution!.text, /2 "TRUE".*1 "FALSE"/, "the never-answered record must not inflate either bucket");
  const dist = twin.distributions.find((d) => d.fieldName === "paid");
  assert.deepEqual(
    dist!.breakdown.map((b) => b.count),
    [2, 1],
    "exactly 3 of the 4 records must be counted -- the never-answered one excluded, not folded into FALSE",
  );
});

/**
 * New: the structured sibling of the prose distribution above -- the
 * dashboard view renders a real bar chart from `twin.distributions`
 * directly, rather than re-parsing the `text` sentence, so the raw
 * per-value counts must actually survive into the API response.
 */
test("computeBusinessTwin's twin.distributions carries the same per-value counts as the prose text, as real numbers", () => {
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
              enumLabels: { Pending: "ממתין", Shipped: "נשלח", Cancelled: "בוטל" },
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
  assert.equal(twin.distributions.length, 1);
  const dist = twin.distributions[0]!;
  assert.equal(dist.entityName, "Order");
  assert.equal(dist.fieldName, "status");
  assert.equal(dist.fieldLabel, "Status");
  assert.deepEqual(dist.breakdown, [
    { value: "Pending", label: "ממתין", count: 2 },
    { value: "Shipped", label: "נשלח", count: 1 },
  ]);
});

/** The structured sibling of the numeric-aggregate prose. */
test("computeBusinessTwin's twin.numericStats carries the real sum/average as numbers, not just the formatted prose", () => {
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
  insertRecord(db, orderProject.id, order, { customer: "Yossi", total: 300 });

  const twin = computeBusinessTwin(db, orderProject);
  assert.equal(twin.numericStats.length, 1);
  const stats = twin.numericStats[0]!;
  assert.equal(stats.entityName, "Order");
  assert.equal(stats.fieldName, "total");
  assert.equal(stats.sum, 400);
  assert.equal(stats.average, 200);
  assert.equal(stats.recordCount, 2);
});

/**
 * Round 754: the numeric-aggregate PROSE text's sum/average
 * toLocaleString() calls had no locale argument at all, baked server-side
 * into `text` with no way for a client re-render to ever correct it --
 * unlike every other number/date in this app (twinReport.ts/
 * searchReport.ts/checkpointDiff.ts, and round 703's own client-side fix
 * for this same Business Twin feature's Dashboard tab), which all pass an
 * explicit he-IL/en-US locale. he-IL and en-US render plain digits
 * identically, so this spies on Number.prototype.toLocaleString itself
 * (same technique round 703's own test uses) to prove a real, explicit
 * locale is actually forwarded, for both the English and Hebrew sentence
 * forms, not just that some number came back right.
 */
test("computeBusinessTwin's numeric-aggregate prose formats its sum/average with the project's own detected language, not the runtime's default locale", () => {
  const originalToLocaleString = Number.prototype.toLocaleString;
  const capturedLocales: unknown[] = [];
  Number.prototype.toLocaleString = function (this: number, ...args: unknown[]) {
    capturedLocales.push(args[0]);
    return originalToLocaleString.apply(this, args as [string?, Intl.NumberFormatOptions?]);
  } as typeof Number.prototype.toLocaleString;
  try {
    const orderFields = [
      { name: "customer", type: "text" as const, required: true },
      { name: "total", label: "Total", type: "number" as const, required: true },
    ];

    const englishProject: Project = {
      ...project,
      description: "An online store with orders",
      spec: { ...project.spec, entities: [{ name: "Order", label: "Orders", fields: orderFields }] },
    };
    const englishDb = openDatabase(":memory:");
    applyMigrations(englishDb, englishProject.id, englishProject.spec);
    const englishOrder = englishProject.spec.entities[0];
    insertRecord(englishDb, englishProject.id, englishOrder, { customer: "Dana", total: 100 });
    insertRecord(englishDb, englishProject.id, englishOrder, { customer: "Yossi", total: 300 });
    computeBusinessTwin(englishDb, englishProject);
    assert.ok(capturedLocales.length > 0, "expected at least one toLocaleString call for the English project");
    assert.ok(
      capturedLocales.every((l) => l === "en-US"),
      `expected every toLocaleString call to carry "en-US" for an English project, got: ${JSON.stringify(capturedLocales)}`,
    );
    capturedLocales.length = 0;

    const hebrewProject: Project = {
      ...project,
      description: "חנות מקוונת להזמנות",
      spec: { ...project.spec, entities: [{ name: "Order", label: "הזמנות", fields: orderFields }] },
    };
    const hebrewDb = openDatabase(":memory:");
    applyMigrations(hebrewDb, hebrewProject.id, hebrewProject.spec);
    const hebrewOrder = hebrewProject.spec.entities[0];
    insertRecord(hebrewDb, hebrewProject.id, hebrewOrder, { customer: "דנה", total: 100 });
    insertRecord(hebrewDb, hebrewProject.id, hebrewOrder, { customer: "יוסי", total: 300 });
    computeBusinessTwin(hebrewDb, hebrewProject);
    assert.ok(capturedLocales.length > 0, "expected at least one toLocaleString call for the Hebrew project");
    assert.ok(
      capturedLocales.every((l) => l === "he-IL"),
      `expected every toLocaleString call to carry "he-IL" for a Hebrew project, got: ${JSON.stringify(capturedLocales)}`,
    );
  } finally {
    Number.prototype.toLocaleString = originalToLocaleString;
  }
});

test("computeBusinessTwin's boolean distribution is skipped when every record shares the same value, same as the enum case", () => {
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
            { name: "paid", label: "Paid", type: "boolean", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", paid: true });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", paid: true });

  const twin = computeBusinessTwin(db, orderProject);
  const distribution = twin.jumpableObservations.find((o) => o.text.includes("Paid"));
  assert.equal(distribution, undefined, "a single-value boolean distribution isn't a distribution, same as the enum case");
});

/**
 * Regression test for a real bug found by round 635's Explore survey: the
 * same label-collision gap closed for computeRelationCoverageObservations
 * and computeNumericAggregateObservations above, for enum fields. Two
 * status-shaped fields (paymentStatus and shippingStatus) both renamed to
 * "Status" used to produce two identical-looking "Status" breakdown lines
 * with no way to tell which real field either distribution belongs to.
 */
test("computeBusinessTwin's enum-distribution observations disambiguate two enum fields on the same entity that share a label", () => {
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
            { name: "paymentStatus", label: "Status", type: "enum", required: true, enumValues: ["Paid", "Unpaid"] },
            { name: "shippingStatus", label: "Status", type: "enum", required: true, enumValues: ["Shipped", "Pending"] },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  insertRecord(db, orderProject.id, order, { customer: "Dana", paymentStatus: "Paid", shippingStatus: "Shipped" });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", paymentStatus: "Unpaid", shippingStatus: "Pending" });

  const twin = computeBusinessTwin(db, orderProject);
  const statusObservations = twin.jumpableObservations.filter((o) => o.text.includes("Status"));
  assert.equal(statusObservations.length, 2, `expected one observation per ambiguous enum field, got: ${JSON.stringify(statusObservations)}`);
  const paymentObs = statusObservations.find((o) => o.text.includes('"Status" (paymentStatus)'));
  const shippingObs = statusObservations.find((o) => o.text.includes('"Status" (shippingStatus)'));
  assert.ok(paymentObs, `expected the paymentStatus field to be disambiguated by its own name, got: ${JSON.stringify(statusObservations)}`);
  assert.ok(shippingObs, `expected the shippingStatus field to be disambiguated by its own name, got: ${JSON.stringify(statusObservations)}`);
  assert.match(paymentObs!.text, /"Paid".*"Unpaid"|"Unpaid".*"Paid"/, "payment status's own values must not be confused with shipping's");
  assert.match(shippingObs!.text, /"Shipped".*"Pending"|"Pending".*"Shipped"/, "shipping status's own values must not be confused with payment's");
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

/**
 * computeBusinessTwin fetches each entity's records exactly once now
 * (recordsByEntity), and every one of relation-coverage, the relation hub,
 * duplicate detection, numeric aggregates, enum distribution, and activity
 * staleness reads from that same shared array. The one real risk that
 * sharing introduces -- some helper mutating or misreading the shared
 * array, corrupting what a *different* helper sees -- can only show up on
 * a large dataset where every one of those code paths actually fires at
 * once (a tiny 2-3 record fixture wouldn't exercise every branch together).
 * This uses two linked entities with 1,200 records each, every field type
 * at once (text display field for duplicate-detection, a number field, an
 * enum field, and a relation field on one of them), and checks every single
 * observation category computeBusinessTwin produces is still correct
 * against the shared cache -- not just that the twin "has some output".
 */
test("computeBusinessTwin produces fully correct observations across every category at once, against a large shared-cache dataset", () => {
  const bigProject: Project = {
    ...project,
    description: "large twin dataset",
    spec: {
      ...project.spec,
      entities: [
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "customer", type: "text", required: true },
            { name: "amount", type: "number", required: false },
            { name: "status", type: "enum", required: false, enumValues: ["pending", "shipped"] },
            { name: "customerId", type: "relation", required: false, relationTo: "Customer" },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, bigProject.id, bigProject.spec);
  const [customer, order] = bigProject.spec.entities;

  const RECORD_COUNT = 1200;
  for (let i = 0; i < RECORD_COUNT; i++) {
    // Every 10th customer shares the exact same name -- a real, deliberate
    // duplicate-detection case, not just unique names that can never collide.
    insertRecord(db, bigProject.id, customer, { name: i % 10 === 0 ? "Repeated Name" : `Customer ${i}` });
  }
  let sumAmount = 0;
  for (let i = 0; i < RECORD_COUNT; i++) {
    // Every order after the first links to customer #1, making it the
    // single most-linked record once every order has been inserted.
    const customerId = i === 0 ? 2 : 1;
    const amount = i + 1;
    sumAmount += amount;
    insertRecord(db, bigProject.id, order, { customer: `Customer ${i}`, amount, status: i % 2 === 0 ? "pending" : "shipped", customerId });
  }

  const twin = computeBusinessTwin(db, bigProject);

  // Per-entity counts must still be exactly right, now that they're derived
  // from recordsByEntity.length instead of a separate countRecords() call.
  const customerStat = twin.entities.find((e) => e.name === "Customer")!;
  const orderStat = twin.entities.find((e) => e.name === "Order")!;
  assert.equal(customerStat.count, RECORD_COUNT);
  assert.equal(orderStat.count, RECORD_COUNT);
  assert.equal(twin.totalRecords, RECORD_COUNT * 2);

  // Relation hub: customer #1 is linked by every order except the first.
  assert.ok(twin.mostLinkedRecord);
  assert.equal(twin.mostLinkedRecord!.entityName, "Customer");
  assert.equal(twin.mostLinkedRecord!.recordId, 1);
  assert.match(twin.mostLinkedRecord!.text, new RegExp(`${RECORD_COUNT - 1}`));

  // Relation coverage: every Order has customerId set, so no "missing relation" observation for it.
  assert.ok(!twin.jumpableObservations.some((o) => o.entityName === "Order" && /customerId|customer/i.test(o.text) && /no\b/i.test(o.text)));

  // Duplicate detection: exactly RECORD_COUNT/10 customers share "Repeated Name".
  const duplicate = twin.jumpableObservations.find((o) => o.entityName === "Customer" && o.text.includes("Repeated Name"));
  assert.ok(duplicate, `expected a duplicate-name observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(duplicate!.text, new RegExp(`${RECORD_COUNT / 10}`));

  // Numeric aggregate: the sum of every order's amount, computed independently above.
  const aggregate = twin.jumpableObservations.find((o) => o.entityName === "Order" && /amount/i.test(o.text));
  assert.ok(aggregate, `expected a numeric-aggregate observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(aggregate!.text, new RegExp(sumAmount.toLocaleString()));

  // Enum distribution: an exact 50/50 pending/shipped split across RECORD_COUNT orders.
  const distribution = twin.jumpableObservations.find((o) => o.entityName === "Order" && /status/i.test(o.text));
  assert.ok(distribution, `expected an enum-distribution observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(distribution!.text, new RegExp(`${RECORD_COUNT / 2}`));

  // mostActive is whichever entity has more records -- both entities here have the same count,
  // so this just confirms the stat itself is still populated correctly from the shared cache.
  assert.ok(twin.mostActive);
  assert.equal(twin.mostActive!.count, RECORD_COUNT);
});

/**
 * Regression test for a real bug found by round 1078's Explore survey: the
 * same "invisible field type" gap this file's own doc comment already
 * narrates closing for number (computeNumericAggregateObservations) and
 * enum/boolean (computeEnumDistributionObservations), but for `date`
 * fields -- despite entityFormatting.ts's own isDeadlineFieldName/
 * getDateUrgency already existing and already driving real overdue/
 * due-soon cell styling in EntityPanel.tsx's table/board view, nothing in
 * this file ever surfaced an overdue deadline as a genuine, data-derived
 * observation. A fixed `today` is passed to computeBusinessTwin's new
 * optional 3rd parameter throughout, mirroring entityFormatting.test.ts's
 * own "classifies a date relative to a fixed reference day, not real
 * wall-clock time" convention for getDateUrgency -- these tests must never
 * depend on which real day they happen to run on.
 */
test("computeBusinessTwin reports an overdue deadline-named date field", () => {
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
            { name: "dueDate", label: "Due date", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", dueDate: "2026-01-01" }); // overdue
  insertRecord(db, orderProject.id, order, { customer: "Yossi", dueDate: "2026-01-10" }); // overdue
  insertRecord(db, orderProject.id, order, { customer: "Noa", dueDate: "2026-02-01" }); // not yet due

  const twin = computeBusinessTwin(db, orderProject, today);
  const overdue = twin.jumpableObservations.find((o) => o.text.includes("Due date"));
  assert.ok(overdue, `expected an overdue-deadline observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.equal(overdue!.entityName, "Order");
  assert.match(overdue!.text, /2 of 3/);
});

test("computeBusinessTwin does not flag a past date field whose name isn't deadline-shaped", () => {
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
            { name: "shipDate", label: "Ship date", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  // Every shipDate is in the past relative to today, but shipDate isn't a deadline -- a past ship date is normal history, not overdue.
  insertRecord(db, orderProject.id, order, { customer: "Dana", shipDate: "2026-01-01" });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", shipDate: "2026-01-05" });

  const twin = computeBusinessTwin(db, orderProject, today);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("Ship date")));
});

test("computeBusinessTwin stays silent about a deadline field when nothing is actually overdue yet", () => {
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
            { name: "deadline", label: "Deadline", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", deadline: "2026-02-01" });
  insertRecord(db, orderProject.id, order, { customer: "Yossi", deadline: "2026-03-01" });

  const twin = computeBusinessTwin(db, orderProject, today);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("Deadline")));
});

/**
 * Regression test for the same label-collision gap already closed above for
 * number/enum fields, now for two deadline fields sharing a label.
 */
test("computeBusinessTwin's overdue-deadline observations disambiguate two deadline fields on the same entity that share a label", () => {
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
            { name: "dueDate", label: "Deadline", type: "date", required: false },
            { name: "renewalDeadline", label: "Deadline", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", dueDate: "2026-01-01", renewalDeadline: "2026-01-02" });

  const twin = computeBusinessTwin(db, orderProject, today);
  const deadlineObservations = twin.jumpableObservations.filter((o) => o.text.includes("Deadline"));
  assert.equal(deadlineObservations.length, 2, `expected one observation per ambiguous deadline field, got: ${JSON.stringify(deadlineObservations)}`);
  assert.ok(deadlineObservations.some((o) => o.text.includes('"Deadline" (dueDate)')));
  assert.ok(deadlineObservations.some((o) => o.text.includes('"Deadline" (renewalDeadline)')));
});

test("computeBusinessTwin phrases the overdue-deadline observation in Hebrew for a Hebrew description", () => {
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
            { name: "dueDate", label: "תאריך יעד", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "דנה", dueDate: "2026-01-01" });

  const twin = computeBusinessTwin(db, orderProject, today);
  assert.ok(twin.jumpableObservations.some((o) => o.text.includes("תאריך יעד") && o.text.includes("עברו את התאריך")));
});

/**
 * Regression test for a real gap found by round 1079's Explore survey: the
 * "dueSoon" half of entityFormatting.ts's own DateUrgency classification
 * (see getDateUrgency's doc comment -- "overdue" | "dueSoon" | null) is
 * already rendered as its own distinct cell styling in EntityPanel.tsx's
 * table/board view, but round 1078's computeOverdueObservations above only
 * ever reports the strictly-past half. A deadline due in the next few days
 * produced zero Business Twin observations until the moment it slipped
 * into "overdue" -- the one case advance notice would have mattered most.
 * DUE_SOON_WINDOW_DAYS mirrors getDateUrgency's own (3 days), and a fixed
 * `today` is used throughout for the same reason as the overdue tests above.
 */
test("computeBusinessTwin reports a deadline-named date field coming due soon, distinct from overdue", () => {
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
            { name: "dueDate", label: "Due date", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", dueDate: "2026-01-15" }); // due today -- due soon
  insertRecord(db, orderProject.id, order, { customer: "Yossi", dueDate: "2026-01-17" }); // due in 2 days -- due soon
  insertRecord(db, orderProject.id, order, { customer: "Noa", dueDate: "2026-02-01" }); // far in the future -- not due soon
  insertRecord(db, orderProject.id, order, { customer: "Avi", dueDate: "2026-01-01" }); // already overdue, not due soon

  const twin = computeBusinessTwin(db, orderProject, today);
  const dueSoon = twin.jumpableObservations.find((o) => o.text.includes("coming up soon"));
  assert.ok(dueSoon, `expected a due-soon observation, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.equal(dueSoon!.entityName, "Order");
  assert.match(dueSoon!.text, /2 of 4/);

  const overdue = twin.jumpableObservations.find((o) => o.text.includes("overdue"));
  assert.ok(overdue, `expected the overdue observation to still fire independently, got: ${JSON.stringify(twin.jumpableObservations)}`);
  assert.match(overdue!.text, /1 of 4/);
});

test("computeBusinessTwin does not flag a past-future date field whose name isn't deadline-shaped as due soon", () => {
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
            { name: "shipDate", label: "Ship date", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", shipDate: "2026-01-16" });

  const twin = computeBusinessTwin(db, orderProject, today);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("Ship date")));
});

test("computeBusinessTwin stays silent about a deadline field when nothing is due soon or overdue", () => {
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
            { name: "deadline", label: "Deadline", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", deadline: "2026-02-01" });

  const twin = computeBusinessTwin(db, orderProject, today);
  assert.ok(!twin.jumpableObservations.some((o) => o.text.includes("Deadline")));
});

test("computeBusinessTwin's due-soon observations disambiguate two deadline fields on the same entity that share a label", () => {
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
            { name: "dueDate", label: "Deadline", type: "date", required: false },
            { name: "renewalDeadline", label: "Deadline", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "Dana", dueDate: "2026-01-16", renewalDeadline: "2026-01-17" });

  const twin = computeBusinessTwin(db, orderProject, today);
  const dueSoonObservations = twin.jumpableObservations.filter((o) => o.text.includes("Deadline") && o.text.includes("coming up soon"));
  assert.equal(dueSoonObservations.length, 2, `expected one due-soon observation per ambiguous deadline field, got: ${JSON.stringify(dueSoonObservations)}`);
  assert.ok(dueSoonObservations.some((o) => o.text.includes('"Deadline" (dueDate)')));
  assert.ok(dueSoonObservations.some((o) => o.text.includes('"Deadline" (renewalDeadline)')));
});

test("computeBusinessTwin phrases the due-soon observation in Hebrew for a Hebrew description", () => {
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
            { name: "dueDate", label: "תאריך יעד", type: "date", required: false },
          ],
        },
      ],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, orderProject.id, orderProject.spec);
  const order = orderProject.spec.entities[0];
  const today = new Date(2026, 0, 15);
  insertRecord(db, orderProject.id, order, { customer: "דנה", dueDate: "2026-01-16" });

  const twin = computeBusinessTwin(db, orderProject, today);
  assert.ok(twin.jumpableObservations.some((o) => o.text.includes("תאריך יעד") && o.text.includes("מתקרבות לתאריך")));
});
