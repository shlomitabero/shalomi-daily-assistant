import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity, Project } from "@forge/shared";
import {
  applyMigrations,
  ensureAutomationRulesTable,
  ensureProjectsTable,
  ensureWhatsAppConnectionsTable,
  ensureWhatsAppMessagesTable,
  getAutomationRule,
  insertAutomationRule,
  insertProject,
  insertRecord,
  listWhatsAppMessages,
  markProjectBuilt,
  openDatabase,
  updateAutomationRule,
} from "@forge/db";
import { interpolateTemplate, matchesTrigger, runAutomationsForRecordChange } from "./automations.js";
import type { WhatsAppConnectionState, WhatsAppSendResult, WhatsAppWebManager } from "./whatsappWeb.js";

const orderEntity: Entity = {
  name: "Order",
  label: "Order",
  fields: [
    { name: "customerName", type: "text", required: true },
    { name: "customerPhone", type: "text", required: false },
    { name: "status", type: "text", required: true },
  ],
};

const projectSpec = {
  summary: "An order-tracking app",
  entities: [orderEntity],
  roles: ["Admin"],
  screens: [],
  openQuestions: [],
};

/**
 * Minimal fake matching only the slice of WhatsAppWebManager automations.ts
 * actually calls (getStatus/sendMessage), mirroring whatsappWeb.test.ts's
 * own "inject a fake instead of the real network dependency" convention,
 * just one level up -- that file fakes the Baileys socket underneath a
 * real WhatsAppWebManager; this fakes the whole manager, since this
 * module's own interface boundary is exactly these two methods.
 */
function createFakeWhatsApp(opts: { connected: boolean; sendResult?: WhatsAppSendResult }) {
  const sendCalls: { projectId: string; to: string; body: string }[] = [];
  const manager = {
    getStatus(): WhatsAppConnectionState {
      return {
        status: opts.connected ? "connected" : "disconnected",
        qrDataUrl: null,
        phoneNumber: opts.connected ? "972500000000" : null,
        error: null,
      };
    },
    async sendMessage(projectId: string, to: string, body: string): Promise<WhatsAppSendResult> {
      sendCalls.push({ projectId, to, body });
      return opts.sendResult ?? { ok: true };
    },
  } as unknown as WhatsAppWebManager;
  return { manager, sendCalls };
}

function setupProject() {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureAutomationRulesTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "owner1",
    name: "Orders",
    description: "An order-tracking app",
    spec: projectSpec,
  });
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);
  const built = { ...project, status: "built" as const };
  return { db, project: built };
}

test("interpolateTemplate replaces known {{field}} placeholders with the record's own values", () => {
  const result = interpolateTemplate(
    "Hi {{customerName}}, your order is {{status}}.",
    orderEntity,
    {
      customerName: "Dana",
      status: "Delivered",
    },
    "en",
  );
  assert.equal(result, "Hi Dana, your order is Delivered.");
});

test("interpolateTemplate leaves an unmatched placeholder verbatim instead of collapsing it to an empty string", () => {
  const result = interpolateTemplate("Hi {{nonexistentField}}!", orderEntity, { customerName: "Dana" }, "en");
  assert.equal(result, "Hi {{nonexistentField}}!");
});

test("interpolateTemplate treats a null field value the same as an unmatched placeholder", () => {
  const result = interpolateTemplate("Phone: {{customerPhone}}", orderEntity, { customerPhone: null }, "en");
  assert.equal(result, "Phone: {{customerPhone}}");
});

/**
 * Round 647 regression: interpolateTemplate had zero field-type
 * awareness -- a boolean field's raw JS value stringified to lowercase
 * "true"/"false", and an enum field's raw stored code (e.g. "P1") showed
 * verbatim instead of its translated label, both unlike this exact same
 * field's own on-screen rendering and unlike entityFormatting.ts's/
 * backup.ts's own fieldDisplayValue, which already special-case both for
 * CSV export. Confirms interpolateTemplate now matches that convention.
 */
test("interpolateTemplate renders a boolean field as TRUE/FALSE and an enum field via its translated label, not the raw stored value", () => {
  const dealEntity: Entity = {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "isUrgent", type: "boolean", required: false },
      { name: "priority", type: "enum", required: true, enumValues: ["P1", "P2"], enumLabels: { P1: "Urgent", P2: "Normal" } },
    ],
  };
  const result = interpolateTemplate(
    "Urgent: {{isUrgent}}, priority: {{priority}}",
    dealEntity,
    {
      isUrgent: true,
      priority: "P1",
    },
    "en",
  );
  assert.equal(result, "Urgent: TRUE, priority: Urgent");
});

/**
 * Round 651's finding: interpolateTemplate left date/number fields
 * completely raw -- "2026-03-15" and "1500" instead of the same
 * locale-formatted values a business owner already sees on screen (via
 * EntityPanel.tsx's formatDateValue/formatNumberValue). Round 647 modeled
 * this function on fieldDisplayValue (CSV export), whose own doc comment
 * explains it deliberately leaves date/number raw so an export/import
 * round-trips exactly -- a rationale that doesn't apply to an outbound
 * WhatsApp message, which is never re-imported. Confirms both field
 * types now render the same way the on-screen table does, in both
 * supported languages (locale affects both the date's field order and
 * the number's thousands-separator character).
 */
test("interpolateTemplate renders a date field in locale-formatted form and a number field with locale thousands separators, not the raw stored value", () => {
  const invoiceEntity: Entity = {
    name: "Invoice",
    label: "Invoice",
    fields: [
      { name: "dueDate", type: "date", required: true },
      { name: "total", type: "number", required: true },
    ],
  };
  const record = { dueDate: "2026-03-15", total: 1500 };

  const en = interpolateTemplate("Due {{dueDate}}, total {{total}}", invoiceEntity, record, "en");
  assert.equal(en, "Due 3/15/2026, total 1,500");

  const he = interpolateTemplate("Due {{dueDate}}, total {{total}}", invoiceEntity, record, "he");
  assert.equal(he, "Due 15.3.2026, total 1,500");
});

test("interpolateTemplate falls back to the raw stored value for a date field that isn't actually a valid date", () => {
  const invoiceEntity: Entity = {
    name: "Invoice",
    label: "Invoice",
    fields: [{ name: "dueDate", type: "date", required: true }],
  };
  const result = interpolateTemplate("Due {{dueDate}}", invoiceEntity, { dueDate: "not-a-date" }, "en");
  assert.equal(result, "Due not-a-date");
});

test("matchesTrigger: record_created only matches the 'created' event, never 'updated'", () => {
  const rule = insertAutomationRule(openDbForRuleOnly(), {
    projectId: "p",
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972500000000",
    messageTemplate: "Welcome!",
  });
  assert.equal(matchesTrigger(rule, "created", { status: "New" }, new Set()), true);
  assert.equal(matchesTrigger(rule, "updated", { status: "New" }, new Set(["status"])), false);
});

test("matchesTrigger: field_equals matches a create whose field already has the target value", () => {
  const rule = insertAutomationRule(openDbForRuleOnly(), {
    projectId: "p",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972500000000",
    messageTemplate: "Delivered!",
  });
  assert.equal(matchesTrigger(rule, "created", { status: "Delivered" }, new Set(["status"])), true);
});

test("matchesTrigger: field_equals on an update only matches when the matching field is part of this update's own payload", () => {
  const db = openDbForRuleOnly();
  const rule = insertAutomationRule(db, {
    projectId: "p",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972500000000",
    messageTemplate: "Delivered!",
  });
  // The record's current value is "Delivered", but this particular update
  // never touched `status` at all (e.g. only customerPhone changed) -- must
  // not re-fire on every unrelated edit to an already-delivered record.
  assert.equal(matchesTrigger(rule, "updated", { status: "Delivered" }, new Set(["customerPhone"])), false);
  assert.equal(matchesTrigger(rule, "updated", { status: "Delivered" }, new Set(["status"])), true);
});

test("matchesTrigger: field_equals does not match when the record's value differs from the target", () => {
  const rule = insertAutomationRule(openDbForRuleOnly(), {
    projectId: "p",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972500000000",
    messageTemplate: "Delivered!",
  });
  assert.equal(matchesTrigger(rule, "updated", { status: "Cancelled" }, new Set(["status"])), false);
});

function openDbForRuleOnly() {
  const db = openDatabase(":memory:");
  ensureAutomationRulesTable(db);
  return db;
}

test("runAutomationsForRecordChange sends a WhatsApp message when a matching rule fires, interpolating the record's own fields", async () => {
  const { db, project } = setupProject();
  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "customerPhone",
    messageTemplate: "Hi {{customerName}}, your order has been delivered!",
  });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 1, customerName: "Dana", customerPhone: "972501234567", status: "Delivered" };

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "updated", record, new Set(["status"]));

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]!.to, "972501234567");
  assert.equal(sendCalls[0]!.body, "Hi Dana, your order has been delivered!");
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.status, "sent");
  assert.equal(messages[0]!.toNumber, "972501234567");
});

test("runAutomationsForRecordChange records the outcome on the rule itself (lastStatus/lastTriggeredAt)", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972509999999",
    messageTemplate: "New order!",
  });
  const { manager } = createFakeWhatsApp({ connected: true });
  const record = { id: 2, customerName: "Noa", customerPhone: null, status: "New" };

  assert.equal(rule.lastTriggeredAt, null);
  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)));

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.ok(after.lastTriggeredAt);
  assert.equal(after.lastStatus, "sent");
  assert.equal(after.lastError, null);
});

test("runAutomationsForRecordChange never calls sendMessage and records a failure when WhatsApp is not connected", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972509999999",
    messageTemplate: "New order!",
  });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: false });
  const record = { id: 3, customerName: "Omer", customerPhone: null, status: "New" };

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)));

  assert.equal(sendCalls.length, 0);
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /not connected/i);
});

test("runAutomationsForRecordChange records a failure, never attempts a send, when the record has no value in the configured phone field", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "customerPhone",
    messageTemplate: "Welcome!",
  });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 4, customerName: "Yossi", customerPhone: null, status: "New" };

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)));

  assert.equal(sendCalls.length, 0);
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /phone/i);
});

test("runAutomationsForRecordChange never evaluates a disabled rule", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972509999999",
    messageTemplate: "New order!",
  });
  updateAutomationRule(db, project.id, rule.id, { enabled: false });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 5, customerName: "Tal", customerPhone: null, status: "New" };

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)));

  assert.equal(sendCalls.length, 0);
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastTriggeredAt, null, "a disabled rule must never be fired, so its run state stays untouched");
});

test("runAutomationsForRecordChange does nothing (no rules match) for a non-matching field value, and leaves the rule's run state untouched", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972509999999",
    messageTemplate: "Delivered!",
  });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 6, customerName: "Ron", customerPhone: null, status: "Cancelled" };

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "updated", record, new Set(["status"]));

  assert.equal(sendCalls.length, 0);
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastTriggeredAt, null);
});

/**
 * Round 647 regression: a relation field's own stored value is just the
 * target record's raw numeric id (see repository.ts's rowToRecord) --
 * nothing in the create-rule UI stops someone from referencing a relation
 * field by name in {{...}}, since the hint text explicitly invites
 * referencing any field. Before this round, the real sent message
 * contained the bare id ("Hi 1, ..."), not anything a real recipient
 * could read. Confirms the real sent message now carries the related
 * Customer's own display label instead.
 */
test("runAutomationsForRecordChange interpolates a relation field's display label into the sent message, not its raw numeric id", async () => {
  const customerEntity: Entity = {
    name: "Customer",
    label: "Customer",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const dealEntity: Entity = {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "customer", type: "relation", relationTo: "Customer", required: true },
      { name: "status", type: "text", required: true },
    ],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureAutomationRulesTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  const spec = {
    summary: "A deals app",
    entities: [customerEntity, dealEntity],
    roles: ["Admin"],
    screens: [],
    openQuestions: [],
  };
  const inserted = insertProject(db, { id: "proj2", ownerId: "owner1", name: "Deals", description: "A deals app", spec });
  applyMigrations(db, inserted.id, inserted.spec);
  markProjectBuilt(db, inserted.id);
  const project = { ...inserted, status: "built" as const };

  const customer = insertRecord(db, project.id, customerEntity, { name: "Dana Levi" });
  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Deal",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Won",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972501234567",
    messageTemplate: "Congrats {{customer}}, your deal is {{status}}!",
  });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 1, customer: customer.id, status: "Won" };

  await runAutomationsForRecordChange(db, manager, project, dealEntity, "updated", record, new Set(["status"]));

  assert.equal(sendCalls.length, 1);
  assert.equal(
    sendCalls[0]!.body,
    "Congrats Dana Levi, your deal is Won!",
    "the message must carry the related customer's own name, not the bare numeric id it's actually stored as",
  );
});
