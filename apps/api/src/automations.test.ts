import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import {
  fireScheduledRule,
  findTemplateFileAttachment,
  interpolateTemplate,
  isAllowedWebhookUrl,
  isScheduledRuleDue,
  matchesTrigger,
  resolveFileFieldsForWebhook,
  runAutomationsForRecordChange,
  runScheduledAutomationsCheck,
} from "./automations.js";
import type { WhatsAppAttachment, WhatsAppConnectionState, WhatsAppSendResult, WhatsAppWebManager } from "./whatsappWeb.js";

/**
 * None of the existing fixtures below reference a file-type field in their
 * message templates, so findTemplateFileAttachment never actually reads
 * this path for any of them -- it exists only so every pre-existing
 * runAutomationsForRecordChange call site has a value to pass for the new
 * uploadsDir parameter (round 786). The one test that DOES exercise a real
 * attachment uses its own real mkdtemp'd directory instead.
 */
const UNUSED_UPLOADS_DIR = "/tmp/forge-automations-test-unused-uploads";

/**
 * None of the existing fixtures below fire a webhook rule with a real file
 * field (resolveFileFieldsForWebhook only ever runs for the webhook action
 * type), so every pre-existing runAutomationsForRecordChange call site
 * just needs a value to pass for the new baseUrl parameter (round 788).
 * The dedicated webhook-file test uses a real, meaningful base URL.
 */
const UNUSED_BASE_URL = "https://unused.example.com";

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
  const sendCalls: { projectId: string; to: string; body: string; attachment?: WhatsAppAttachment }[] = [];
  const manager = {
    getStatus(): WhatsAppConnectionState {
      return {
        status: opts.connected ? "connected" : "disconnected",
        qrDataUrl: null,
        phoneNumber: opts.connected ? "972500000000" : null,
        error: null,
      };
    },
    async sendMessage(projectId: string, to: string, body: string, attachment?: WhatsAppAttachment): Promise<WhatsAppSendResult> {
      sendCalls.push({ projectId, to, body, attachment });
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

/**
 * Round 744: "createdAt" is a reserved key repository.ts's own insert
 * always sets on every EntityRecord, never a declared entity field -- so
 * entity.fields.find(...) above always returns undefined for it, and it
 * used to fall through to the generic raw-String(value) branch, sending a
 * raw ISO-8601 timestamp to a real WhatsApp recipient instead of a
 * locale-formatted one, even though the create-rule UI's own hint invites
 * referencing any field by name and {{createdAt}} is a very natural guess
 * for "when this record was created". Mirrors the established pattern in
 * entityFormatting.test.ts's own formatRecordCreatedAt test: the exact
 * formatted string is locale/timezone-dependent, but comparing against
 * the raw value and against the declared-date-field's own date-only
 * output confirms real formatting (including time-of-day) actually
 * happened, not a silent pass-through.
 */
test("interpolateTemplate renders {{createdAt}} in locale-formatted form (date and time), not the raw ISO-8601 timestamp", () => {
  const invoiceEntity: Entity = {
    name: "Invoice",
    label: "Invoice",
    fields: [{ name: "dueDate", type: "date", required: true }],
  };
  const rawTimestamp = "2026-03-15T14:30:00.000Z";
  const record = { createdAt: rawTimestamp, dueDate: "2026-03-15" };

  const result = interpolateTemplate("Created {{createdAt}}", invoiceEntity, record, "en");
  assert.notEqual(result, `Created ${rawTimestamp}`, "must never send the raw ISO-8601 timestamp verbatim");

  const dueDateOnly = interpolateTemplate("Due {{dueDate}}", invoiceEntity, record, "en");
  assert.notEqual(
    result.replace("Created ", ""),
    dueDateOnly.replace("Due ", ""),
    "createdAt carries real time-of-day information a declared date field never does, so it must not format identically to one",
  );
});

/**
 * New in this round: a "file" field's stored value is a JSON-encoded
 * {url, name, size, mimeType} descriptor (see entityFormatting.ts's own
 * parseFileFieldValue), not plain text like every other field type --
 * interpolateTemplate never got a branch for it, so a template
 * referencing a file field (the create-rule UI's own hint explicitly
 * invites referencing ANY field by name, and neither
 * CreateAutomationRuleSchema nor UpdateAutomationRuleSchema restrict
 * messageTemplate's field references by type) sent the raw JSON
 * descriptor -- including the server's own internal upload URL path --
 * verbatim to a real WhatsApp recipient or webhook endpoint. Mirrors
 * backup.ts's own fileFieldDisplayName exactly: just the filename, same
 * as fieldDisplayValue (CSV export) and calendarIcs.ts already do for
 * this exact field type.
 */
test("interpolateTemplate renders a file field as just its own filename, not the raw JSON upload descriptor", () => {
  const applicantEntity: Entity = {
    name: "Applicant",
    label: "Applicant",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "resume", type: "file", required: false },
    ],
  };
  const fileValue = JSON.stringify({ url: "/api/uploads/p1/Applicant/abc.pdf", name: "resume.pdf", size: 123, mimeType: "application/pdf" });
  const result = interpolateTemplate("Thanks {{name}}, see attached: {{resume}}", applicantEntity, { name: "Dana", resume: fileValue }, "en");
  assert.equal(result, "Thanks Dana, see attached: resume.pdf");
});

test("interpolateTemplate renders an empty string for a file field whose value isn't a real file descriptor", () => {
  const applicantEntity: Entity = {
    name: "Applicant",
    label: "Applicant",
    fields: [{ name: "resume", type: "file", required: false }],
  };
  const result = interpolateTemplate("Attached: {{resume}}", applicantEntity, { resume: "not-json" }, "en");
  assert.equal(result, "Attached: ");
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

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]!.to, "972501234567");
  assert.equal(sendCalls[0]!.body, "Hi Dana, your order has been delivered!");
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.status, "sent");
  assert.equal(messages[0]!.toNumber, "972501234567");
});

/**
 * Round 786: before this round, a message template referencing a `file`
 * field (e.g. "{{invoice}}") only ever sent the bare filename as plain
 * text -- a customer never actually received the file itself, even though
 * Baileys supports attaching one. This drives the real upload-storage
 * layout (routes/projects.ts's createUploadMiddleware: uploadsDir/
 * projectId/entityName/<storedFilename>) end-to-end through
 * runAutomationsForRecordChange and confirms the real file on disk is
 * handed to WhatsAppWebManager.sendMessage as an attachment, not just
 * mentioned in the text.
 */
test("runAutomationsForRecordChange attaches a real uploaded file when the message template references a 'file' field", async () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureAutomationRulesTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  const project = {
    ...insertProject(db, {
      id: "proj1",
      ownerId: "owner1",
      name: "Orders",
      description: "An order-tracking app",
      spec: { ...projectSpec, entities: [entityWithInvoice] },
    }),
    status: "built" as const,
  };
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "customerPhone",
    messageTemplate: "Hi {{customerName}}, here's your invoice: {{invoice}}",
  });
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });

  const uploadsDir = await mkdtemp(path.join(tmpdir(), "forge-automations-attachment-test-"));
  try {
    const storedFilename = "abc123.pdf";
    await mkdir(path.join(uploadsDir, project.id, "Order"), { recursive: true });
    await writeFile(path.join(uploadsDir, project.id, "Order", storedFilename), "%PDF-fake-invoice-contents");

    const record = {
      id: 1,
      customerName: "Dana",
      customerPhone: "972501234567",
      status: "Delivered",
      invoice: JSON.stringify({ url: `/api/uploads/${project.id}/Order/${storedFilename}`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
    };

    await runAutomationsForRecordChange(db, manager, project, entityWithInvoice, "updated", record, new Set(["status"]), uploadsDir, UNUSED_BASE_URL);

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]!.body, "Hi Dana, here's your invoice: invoice-203.pdf", "the plain text itself still only names the file, same as before this round");
    assert.deepEqual(sendCalls[0]!.attachment, {
      filePath: path.join(uploadsDir, project.id, "Order", storedFilename),
      fileName: "invoice-203.pdf",
      mimeType: "application/pdf",
    });
  } finally {
    await rm(uploadsDir, { recursive: true, force: true });
  }
});

test("findTemplateFileAttachment resolves the first file-type field referenced in the template to its real path on disk", () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };
  const record = {
    customerName: "Dana",
    invoice: JSON.stringify({ url: "/api/uploads/proj1/Order/abc123.pdf", name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
  };
  const attachment = findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "Hi {{customerName}}, here's {{invoice}}", record);
  assert.deepEqual(attachment, { filePath: "/uploads/proj1/Order/abc123.pdf", fileName: "invoice-203.pdf", mimeType: "application/pdf" });
});

/**
 * Round 850's finding: this function builds the identical kind of path
 * from the identical unrestricted entity.name string rounds 848/849
 * already found exploitable on the write (upload-destination) and delete
 * (deleteUploadedFile) sides -- but reached here through a READ: the
 * resolved path is handed straight to performSend's own readFile and
 * sent as a real WhatsApp document attachment to whatever toNumber/
 * toField the automation rule names, an arbitrary-file-read-and-
 * exfiltration primitive rather than a write-or-delete one. Confirms the
 * traversal-named entity case returns null (no attachment, matching this
 * function's own existing "silently fall back to plain text" contract
 * for every other malformed case) instead of a path that resolves
 * outside uploadsDir.
 */
test("findTemplateFileAttachment returns null instead of a path that escapes uploadsDir, when the entity's own name is a path-traversal attempt", () => {
  const unsafeEntity: Entity = {
    name: "../../../tmp/evil",
    label: "../../../tmp/evil",
    fields: [{ name: "invoice", label: "Invoice", type: "file", required: false }],
  };
  const record = {
    invoice: JSON.stringify({ url: "/api/uploads/x/y/abc123.pdf", name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
  };
  const attachment = findTemplateFileAttachment("/uploads", "proj1", unsafeEntity, "Here's {{invoice}}", record);
  assert.equal(attachment, null, "must never return a filePath that resolves outside uploadsDir");
});

test("findTemplateFileAttachment returns null when the template references no file field, references one with no value, or the field isn't a 'file' type at all", () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };
  assert.equal(
    findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "Hi {{customerName}}", { customerName: "Dana" }),
    null,
    "no file field referenced at all",
  );
  assert.equal(
    findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "Invoice: {{invoice}}", { customerName: "Dana", invoice: "" }),
    null,
    "the file field is referenced but has no real value",
  );
  assert.equal(
    findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "Name: {{customerName}}", { customerName: "Dana", invoice: "{}" }),
    null,
    "customerName is referenced but isn't a 'file'-type field, so it must never be treated as one",
  );
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
  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, project, orderEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, project, dealEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(sendCalls.length, 1);
  assert.equal(
    sendCalls[0]!.body,
    "Congrats Dana Levi, your deal is Won!",
    "the message must carry the related customer's own name, not the bare numeric id it's actually stored as",
  );
});

function scheduleRuleBase(overrides: Partial<Parameters<typeof insertAutomationRule>[1]> = {}) {
  return {
    projectId: "proj1",
    entityName: "Order",
    trigger: "schedule" as const,
    fieldName: null,
    fieldValue: null,
    scheduleTimeUtc: "09:00",
    scheduleDaysOfWeek: null,
    actionType: "send_whatsapp" as const,
    toMode: "static" as const,
    toNumber: "972501234567",
    messageTemplate: "Good morning! Here's your daily reminder.",
    ...overrides,
  };
}

test("isScheduledRuleDue fires once the scheduled time has passed today and it hasn't already fired today", () => {
  const rule = { ...scheduleRuleBase(), id: "r1", createdAt: "", updatedAt: "", lastTriggeredAt: null, lastStatus: null, lastError: null, enabled: true } as unknown as Parameters<typeof isScheduledRuleDue>[0];
  assert.equal(isScheduledRuleDue(rule, new Date("2026-03-15T08:59:00.000Z")), false, "not due yet -- one minute before the scheduled time");
  assert.equal(isScheduledRuleDue(rule, new Date("2026-03-15T09:00:00.000Z")), true, "due exactly at the scheduled time");
  assert.equal(isScheduledRuleDue(rule, new Date("2026-03-15T14:30:00.000Z")), true, "still due later the same day if the checker missed the exact minute");
});

test("isScheduledRuleDue is not due again the same UTC day it already fired, but is due again the next day", () => {
  const rule = {
    ...scheduleRuleBase(),
    id: "r1",
    createdAt: "",
    updatedAt: "",
    lastTriggeredAt: "2026-03-15T09:00:05.000Z",
    lastStatus: "sent",
    lastError: null,
    enabled: true,
  } as unknown as Parameters<typeof isScheduledRuleDue>[0];
  assert.equal(isScheduledRuleDue(rule, new Date("2026-03-15T20:00:00.000Z")), false, "already fired today -- must not fire twice in the same day");
  assert.equal(isScheduledRuleDue(rule, new Date("2026-03-16T09:00:00.000Z")), true, "a new UTC day has started, so it's due again");
});

test("isScheduledRuleDue is still due later the same day after a failed attempt, so a WhatsApp disconnect doesn't skip the whole day", () => {
  const rule = {
    ...scheduleRuleBase(),
    id: "r1",
    createdAt: "",
    updatedAt: "",
    lastTriggeredAt: "2026-03-15T09:00:05.000Z",
    lastStatus: "failed",
    lastError: "WhatsApp is not connected",
    enabled: true,
  } as unknown as Parameters<typeof isScheduledRuleDue>[0];
  assert.equal(
    isScheduledRuleDue(rule, new Date("2026-03-15T09:05:00.000Z")),
    true,
    "the one attempt today failed, so it must stay due -- not silently skip the rest of the day",
  );

  const succeededOnRetry = { ...rule, lastTriggeredAt: "2026-03-15T09:05:30.000Z", lastStatus: "sent" as const };
  assert.equal(
    isScheduledRuleDue(succeededOnRetry, new Date("2026-03-15T09:10:00.000Z")),
    false,
    "once a retry actually succeeds today, it must go back to not-due for the rest of the day",
  );
});

test("isScheduledRuleDue respects scheduleDaysOfWeek when set, and treats null as every day", () => {
  const mondayOnly = {
    ...scheduleRuleBase({ scheduleDaysOfWeek: "1" }),
    id: "r1",
    createdAt: "",
    updatedAt: "",
    lastTriggeredAt: null,
    lastStatus: null,
    lastError: null,
    enabled: true,
  } as unknown as Parameters<typeof isScheduledRuleDue>[0];
  // 2026-03-15 is a Sunday (day 0); 2026-03-16 is a Monday (day 1).
  assert.equal(isScheduledRuleDue(mondayOnly, new Date("2026-03-15T09:00:00.000Z")), false, "Sunday is not in the Monday-only day list");
  assert.equal(isScheduledRuleDue(mondayOnly, new Date("2026-03-16T09:00:00.000Z")), true, "Monday is in the day list");

  const everyDay = { ...mondayOnly, scheduleDaysOfWeek: null };
  assert.equal(isScheduledRuleDue(everyDay, new Date("2026-03-15T09:00:00.000Z")), true, "null scheduleDaysOfWeek means every day, including Sunday");
});

test("isScheduledRuleDue is always false for a non-schedule trigger or a schedule rule with no scheduleTimeUtc", () => {
  const notSchedule = { ...scheduleRuleBase(), trigger: "field_equals" as const, id: "r1", createdAt: "", updatedAt: "", lastTriggeredAt: null, lastStatus: null, lastError: null, enabled: true } as unknown as Parameters<typeof isScheduledRuleDue>[0];
  assert.equal(isScheduledRuleDue(notSchedule, new Date("2026-03-15T09:00:00.000Z")), false);

  const noTime = { ...scheduleRuleBase({ scheduleTimeUtc: null }), id: "r1", createdAt: "", updatedAt: "", lastTriggeredAt: null, lastStatus: null, lastError: null, enabled: true } as unknown as Parameters<typeof isScheduledRuleDue>[0];
  assert.equal(isScheduledRuleDue(noTime, new Date("2026-03-15T09:00:00.000Z")), false);
});

test("fireScheduledRule sends the messageTemplate verbatim (no {{field}} interpolation -- there's no triggering record) and records a sent outcome", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase({ messageTemplate: "Reminder: check {{anything}} today." }));
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });

  await fireScheduledRule(db, manager, project, rule);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]!.to, "972501234567");
  assert.equal(sendCalls[0]!.body, "Reminder: check {{anything}} today.", "a schedule rule has no record, so a {{field}} placeholder must be left exactly as typed, not interpolated or stripped");
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});

test("fireScheduledRule records a failed outcome with no destination configured when toNumber is empty", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase({ toNumber: null }));
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });

  await fireScheduledRule(db, manager, project, rule);

  assert.equal(sendCalls.length, 0);
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /no destination phone number/);
});

test("fireScheduledRule records a failed outcome when WhatsApp isn't connected, without attempting to send", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase());
  const { manager, sendCalls } = createFakeWhatsApp({ connected: false });

  await fireScheduledRule(db, manager, project, rule);

  assert.equal(sendCalls.length, 0);
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "failed");
});

test("runScheduledAutomationsCheck fires exactly the rules that are due right now, across different projects, and skips disabled/not-yet-due ones", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureAutomationRulesTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  const spec = { summary: "test", entities: [orderEntity], roles: ["Admin"], screens: [], openQuestions: [] };
  for (const id of ["proj1", "proj2"]) {
    const inserted = insertProject(db, { id, ownerId: "owner1", name: id, description: "test", spec });
    applyMigrations(db, inserted.id, inserted.spec);
    markProjectBuilt(db, inserted.id);
  }

  const due = insertAutomationRule(db, scheduleRuleBase({ projectId: "proj1", scheduleTimeUtc: "09:00", toNumber: "111" }));
  const notYetDue = insertAutomationRule(db, scheduleRuleBase({ projectId: "proj2", scheduleTimeUtc: "23:00", toNumber: "222" }));
  const disabledDue = insertAutomationRule(db, scheduleRuleBase({ projectId: "proj1", scheduleTimeUtc: "08:00", toNumber: "333" }));
  updateAutomationRule(db, "proj1", disabledDue.id, { enabled: false });

  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  await runScheduledAutomationsCheck(db, manager, new Date("2026-03-15T09:00:00.000Z"));

  assert.equal(sendCalls.length, 1, "exactly the one due, enabled rule must fire");
  assert.equal(sendCalls[0]!.to, "111");
  assert.equal(getAutomationRule(db, "proj1", due.id)!.lastStatus, "sent");
  assert.equal(getAutomationRule(db, "proj2", notYetDue.id)!.lastStatus, null, "not due yet -- must be untouched");
  assert.equal(getAutomationRule(db, "proj1", disabledDue.id)!.lastStatus, null, "disabled -- must never be considered even though its time has passed");
});

test("isAllowedWebhookUrl accepts a real public http(s) URL and rejects non-http(s) schemes, malformed URLs, and local/private hosts", () => {
  assert.equal(isAllowedWebhookUrl("https://hooks.example.com/abc"), true);
  assert.equal(isAllowedWebhookUrl("http://hooks.example.com/abc"), true);
  assert.equal(isAllowedWebhookUrl("ftp://hooks.example.com/abc"), false, "non-http(s) schemes must be rejected");
  assert.equal(isAllowedWebhookUrl("not a url"), false, "a malformed URL must be rejected, not throw");
  assert.equal(isAllowedWebhookUrl("http://localhost/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://127.0.0.1/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://169.254.169.254/latest/meta-data/"), false, "the cloud instance-metadata IP specifically must be blocked");
  assert.equal(isAllowedWebhookUrl("http://10.0.0.5/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://172.16.0.5/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://192.168.1.5/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://[::1]/abc"), false);
});

test("isAllowedWebhookUrl also blocks an IPv4-mapped IPv6 literal wrapping a blocked IPv4 address, in both dotted and hex form", () => {
  assert.equal(
    isAllowedWebhookUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    false,
    "the cloud instance-metadata IP wrapped as an IPv4-mapped IPv6 literal must still be blocked",
  );
  assert.equal(isAllowedWebhookUrl("http://[::ffff:127.0.0.1]/abc"), false, "loopback wrapped as IPv4-mapped IPv6 (dotted) must still be blocked");
  assert.equal(isAllowedWebhookUrl("http://[::ffff:7f00:1]/abc"), false, "loopback wrapped as IPv4-mapped IPv6 (hex, as Node's URL parser actually normalizes it to) must still be blocked");
  assert.equal(isAllowedWebhookUrl("http://[::ffff:10.0.0.5]/abc"), false, "a private 10.x address wrapped as IPv4-mapped IPv6 must still be blocked");
  assert.equal(isAllowedWebhookUrl("http://[::ffff:192.168.1.5]/abc"), false, "a private 192.168.x address wrapped as IPv4-mapped IPv6 must still be blocked");
  assert.equal(isAllowedWebhookUrl("http://[::ffff:8.8.8.8]/abc"), true, "a genuinely public IPv4 address wrapped as IPv4-mapped IPv6 must still be allowed");
});

/**
 * Round 789: the "::ffff:" unwrapping above misses a second, equally real
 * encoding of the identical hazard -- RFC 6052's well-known NAT64 prefix
 * ("64:ff9b::"), used by any network that actually performs NAT64/DNS64
 * translation to embed an IPv4 destination inside an IPv6 literal the
 * exact same way "::ffff:" does. Node's URL parser canonicalizes
 * "[64:ff9b::169.254.169.254]" to the hex form "[64:ff9b::a9fe:a9fe]"
 * (confirmed empirically), which extractIPv4MappedAddress's original
 * "::ffff:"-only regex never matched at all -- it fell through to
 * BLOCKED_OTHER_HOSTNAME_PATTERNS (none of which know about this prefix
 * either) and isAllowedWebhookUrl wrongly returned true.
 */
test("isAllowedWebhookUrl also blocks an IPv4-mapped IPv6 literal using the RFC 6052 NAT64 prefix ('64:ff9b::'), in both dotted and hex form", () => {
  assert.equal(
    isAllowedWebhookUrl("http://[64:ff9b::169.254.169.254]/latest/meta-data/"),
    false,
    "the cloud instance-metadata IP wrapped as a NAT64-prefixed IPv6 literal must still be blocked",
  );
  assert.equal(isAllowedWebhookUrl("http://[64:ff9b::127.0.0.1]/abc"), false, "loopback wrapped as a NAT64-prefixed IPv6 literal (dotted) must still be blocked");
  assert.equal(
    isAllowedWebhookUrl("http://[64:ff9b::7f00:1]/abc"),
    false,
    "loopback wrapped as a NAT64-prefixed IPv6 literal (hex, as Node's URL parser actually normalizes it to) must still be blocked",
  );
  assert.equal(isAllowedWebhookUrl("http://[64:ff9b::10.0.0.5]/abc"), false, "a private 10.x address wrapped with the NAT64 prefix must still be blocked");
  assert.equal(isAllowedWebhookUrl("http://[64:ff9b::8.8.8.8]/abc"), true, "a genuinely public IPv4 address wrapped with the NAT64 prefix must still be allowed");
});

test("isAllowedWebhookUrl blocks the IPv6 unspecified address ('::'), the analogue of the already-blocked 0.0.0.0, in every equivalent spelling", () => {
  assert.equal(isAllowedWebhookUrl("http://[::]/abc"), false, "the canonical '::' form must be blocked");
  assert.equal(isAllowedWebhookUrl("http://[::0]/abc"), false, "'::0' must be blocked (Node normalizes it to '::')");
  assert.equal(isAllowedWebhookUrl("http://[0:0:0:0:0:0:0:0]/abc"), false, "the fully-expanded all-zero form must be blocked (Node normalizes it to '::')");
  assert.equal(isAllowedWebhookUrl("http://[0::0]/abc"), false, "another all-zero spelling must be blocked (Node normalizes it to '::')");
});

/**
 * Round 757: BLOCKED_WEBHOOK_HOSTNAME_PATTERNS' dotted-decimal entries
 * (/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./,
 * /^169\.254\./) are plain string-prefix regexes with no anchor at the
 * end, so before this fix they matched any hostname merely *starting*
 * with those digits -- not just a genuine private IPv4 literal. A real
 * business could have no way to use a webhook endpoint under a public
 * domain that happened to start the same way, with the generic "no valid
 * webhook URL configured" failure giving no hint why. isAllowedWebhookUrl
 * now only runs these patterns against a hostname node:net's isIP
 * confirms is actually an IPv4 address, so a real public hostname that
 * merely looks similar is correctly allowed, while every genuine private/
 * loopback/link-local IPv4 literal (the whole point of this blocklist) is
 * still blocked exactly as before.
 */
test("isAllowedWebhookUrl allows a real public hostname that merely starts with the same digits as a blocked private IPv4 range, while still blocking the real IPv4 literal", () => {
  assert.equal(isAllowedWebhookUrl("https://10.example.com/webhook"), true, "a public hostname starting with '10.' is not a private 10.x address");
  assert.equal(isAllowedWebhookUrl("https://192.168.mycompany.io/hook"), true, "a public hostname starting with '192.168.' is not a private 192.168.x address");
  assert.equal(isAllowedWebhookUrl("https://172.16.shop.com/x"), true, "a public hostname starting with '172.16.' is not a private 172.16.x address");
  assert.equal(isAllowedWebhookUrl("https://127.company.net/x"), true, "a public hostname starting with '127.' is not the loopback address");
  assert.equal(isAllowedWebhookUrl("https://169.254.example.org/x"), true, "a public hostname starting with '169.254.' is not the link-local/instance-metadata range");
  // The real IPv4 literals these patterns exist for must still be blocked.
  assert.equal(isAllowedWebhookUrl("http://10.0.0.5/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://172.16.0.5/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://192.168.1.5/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://127.0.0.1/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://169.254.169.254/latest/meta-data/"), false);
});

/**
 * Round 758: the IPv6 unique-local (ULA, fc00::/7) and link-local
 * (fe80::/10) patterns only matched the single literal hex group
 * "fc00:"/"fd00:"/"fe80:" exactly -- not the real CIDR ranges they were
 * meant to cover. ULA fc00::/7 covers every address whose first byte is
 * 0xfc or 0xfd (first hex group fc00-fdff); almost every real-world ULA
 * is "locally assigned" with a random 40-bit global ID (RFC 4193), so a
 * real one looks like "fd12:3456:789a::1", never literally "fd00:....".
 * link-local fe80::/10 covers first hex group fe80-febf, and a real
 * link-local address almost always has a non-zero interface identifier
 * (e.g. "fe81::1"). Before the fix, every one of these sailed straight
 * through isAllowedWebhookUrl, bypassing this exact SSRF guard via the
 * IPv6 side -- any project collaborator with write access could point an
 * Automation Rule's webhook at an internal IPv6 ULA/link-local service
 * (common in self-hosted/Docker/Kubernetes deployments) and it would
 * validate and actually be POSTed to by fireWebhookAction's fetch() call.
 */
test("isAllowedWebhookUrl blocks real IPv6 unique-local (fc00::/7) and link-local (fe80::/10) addresses, not just the single literal 'fc00:'/'fd00:'/'fe80:' group", () => {
  // Real-world ULA addresses (RFC 4193's randomly-assigned fd00::/8 in
  // particular) almost never start with the literal group "fd00"/"fc00".
  assert.equal(isAllowedWebhookUrl("http://[fd12:3456:789a::1]/hook"), false, "a randomly-assigned ULA address must be blocked, not just the literal 'fd00::' group");
  assert.equal(isAllowedWebhookUrl("http://[fdab:cdef::1]/hook"), false);
  assert.equal(isAllowedWebhookUrl("http://[fc01::1]/hook"), false, "the ULA range also covers 0xfc-prefixed addresses other than the literal 'fc00::' group");
  // Real-world link-local addresses almost always have a non-zero
  // interface identifier, not the literal group "fe80" alone.
  assert.equal(isAllowedWebhookUrl("http://[fe81::1]/hook"), false, "a link-local address with a real interface identifier must be blocked, not just the literal 'fe80::' group");
  assert.equal(isAllowedWebhookUrl("http://[febf::1]/hook"), false, "the top edge of the real fe80::/10 range must still be blocked");
  // Already-blocked literal cases must still be blocked.
  assert.equal(isAllowedWebhookUrl("http://[fd00::1]/hook"), false);
  assert.equal(isAllowedWebhookUrl("http://[fc00::1]/hook"), false);
  assert.equal(isAllowedWebhookUrl("http://[fe80::1]/hook"), false);
  // Addresses just outside these real ranges are genuinely public and
  // must not be blocked.
  assert.equal(isAllowedWebhookUrl("http://[fe00::1]/hook"), true, "just below the real fe80::/10 range, this is not link-local");
  assert.equal(isAllowedWebhookUrl("http://[fec0::1]/hook"), true, "just above the real fe80::/10 range, this is not link-local");
  assert.equal(isAllowedWebhookUrl("http://[2001:4860:4860::8888]/hook"), true, "a genuinely public IPv6 address must still be allowed");
});

/**
 * New: the "webhook" action type -- fireRule's own branch, reached through
 * the real event-driven path (runAutomationsForRecordChange), not a direct
 * call (fireRule itself isn't exported). Mocks the global fetch this
 * process-wide function calls, the same convention apps/web's own tests
 * already use for client-side fetch, just server-side here.
 */
test("runAutomationsForRecordChange posts a JSON payload to the webhook URL and records a sent outcome on a 2xx response", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    toMode: "static",
    messageTemplate: "New order from {{customerName}}!",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };

  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://hooks.example.com/forge");
  assert.equal(calls[0]!.init.method, "POST");
  const payload = JSON.parse(calls[0]!.init.body as string);
  assert.equal(payload.event, "record_created");
  assert.equal(payload.entity, "Order");
  assert.equal(payload.message, "New order from Dana Levi!");
  assert.deepEqual(payload.record, record);
  assert.equal(payload.project.id, project.id);
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});

/**
 * Round 788: a `file` field's stored value is itself a JSON-encoded
 * descriptor string -- before this round, the webhook payload embedded
 * `record` completely untouched, so this descriptor arrived as a
 * doubly-escaped JSON string nested inside the outer JSON body (not a
 * usable nested object), with a relative `url` the receiving service
 * (the create-rule UI explicitly advertises Zapier/Slack/Make) has no
 * way to resolve against this server's own origin.
 */
test("runAutomationsForRecordChange resolves a 'file' field in the webhook payload's record to a real nested object with a fully-qualified URL, instead of a doubly-encoded string with a relative path", async () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureAutomationRulesTable(db);
  ensureWhatsAppConnectionsTable(db);
  ensureWhatsAppMessagesTable(db);
  const project = {
    ...insertProject(db, {
      id: "proj1",
      ownerId: "owner1",
      name: "Orders",
      description: "An order-tracking app",
      spec: { ...projectSpec, entities: [entityWithInvoice] },
    }),
    status: "built" as const,
  };
  applyMigrations(db, project.id, project.spec);
  markProjectBuilt(db, project.id);

  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    toMode: "static",
    messageTemplate: "New order from {{customerName}}, invoice: {{invoice}}",
  });
  const record = {
    id: 1,
    customerName: "Dana Levi",
    customerPhone: "972501234567",
    status: "New",
    invoice: JSON.stringify({ url: "/api/uploads/proj1/Order/abc123.pdf", name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
  };

  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, project, entityWithInvoice, "created", record, new Set(), UNUSED_UPLOADS_DIR, "https://forge-ai-m7p7.onrender.com");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0]!.init.body as string);
  assert.equal(payload.message, "New order from Dana Levi, invoice: invoice-203.pdf", "the text message itself is unaffected -- still just the filename");
  assert.deepEqual(payload.record.invoice, {
    url: "https://forge-ai-m7p7.onrender.com/api/uploads/proj1/Order/abc123.pdf",
    name: "invoice-203.pdf",
    size: 27,
    mimeType: "application/pdf",
  });
  assert.equal(payload.record.customerName, "Dana Levi", "every non-file field is passed through completely untouched");
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});

test("resolveFileFieldsForWebhook leaves every non-file field untouched and leaves a file field alone when its value is empty or malformed", () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };
  const emptyRecord = { customerName: "Dana", invoice: "" };
  assert.deepEqual(findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "{{invoice}}", emptyRecord), null);
  assert.deepEqual(resolveFileFieldsForWebhook(entityWithInvoice, emptyRecord, "https://example.com"), emptyRecord);

  const malformedRecord = { customerName: "Dana", invoice: "not valid json" };
  assert.deepEqual(resolveFileFieldsForWebhook(entityWithInvoice, malformedRecord, "https://example.com"), malformedRecord);
});

test("runAutomationsForRecordChange records a failed outcome when the webhook responds with a non-2xx status, without throwing", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    toMode: "static",
    messageTemplate: "New order!",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /500/);
});

test("runAutomationsForRecordChange records a failed outcome when the webhook request itself throws (network error/timeout), without throwing", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    toMode: "static",
    messageTemplate: "New order!",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /network down/);
});

test("runAutomationsForRecordChange rejects (records failed, never calls fetch) a webhook rule whose URL points at a blocked local/private host", async () => {
  const { db, project } = setupProject();
  // Bypasses the route-level isAllowedWebhookUrl check on purpose (direct DB
  // insert, not through the validated HTTP route) to prove fireRule's own
  // runtime check is a real, independent guard -- not just a client-facing
  // validation message that could be skipped by any other write path.
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "webhook",
    webhookUrl: "http://169.254.169.254/latest/meta-data/",
    toMode: "static",
    messageTemplate: "New order!",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false, "a blocked host must never actually be fetched");
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
});

test("fireScheduledRule's webhook action sends messageTemplate verbatim with a null record/entity in the payload (there's no triggering record)", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "schedule",
    scheduleTimeUtc: "09:00",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    toMode: "static",
    messageTemplate: "Good morning! {{anything}}",
  });

  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await fireScheduledRule(db, {} as WhatsAppWebManager, project, rule);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0]!.init.body as string);
  assert.equal(payload.event, "schedule");
  assert.equal(payload.entity, null);
  assert.equal(payload.record, null);
  assert.equal(payload.message, "Good morning! {{anything}}", "no record to interpolate {{anything}} from, so it must be left exactly as typed");
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});
