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
  const result = interpolateTemplate("Hi {{customerName}}, your order is {{status}}.", {
    customerName: "Dana",
    status: "Delivered",
  });
  assert.equal(result, "Hi Dana, your order is Delivered.");
});

test("interpolateTemplate leaves an unmatched placeholder verbatim instead of collapsing it to an empty string", () => {
  const result = interpolateTemplate("Hi {{nonexistentField}}!", { customerName: "Dana" });
  assert.equal(result, "Hi {{nonexistentField}}!");
});

test("interpolateTemplate treats a null field value the same as an unmatched placeholder", () => {
  const result = interpolateTemplate("Phone: {{customerPhone}}", { customerPhone: null });
  assert.equal(result, "Phone: {{customerPhone}}");
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
