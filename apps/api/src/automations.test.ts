import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Entity, Project } from "@forge/shared";
import {
  applyMigrations,
  deleteProject,
  ensureAutomationRulesTable,
  ensureCheckpointsTable,
  ensureProjectCollaboratorsTable,
  ensureProjectsTable,
  ensureWhatsAppConnectionsTable,
  ensureWhatsAppMessagesTable,
  EMAIL_NOT_CONFIGURED_ERROR,
  getAutomationRule,
  insertAutomationRule,
  insertProject,
  insertRecord,
  listAutomationRuns,
  listWhatsAppMessages,
  markProjectBuilt,
  openDatabase,
  updateAutomationRule,
} from "@forge/db";
import {
  fireRule,
  fireScheduledRule,
  findAllTemplateFileAttachments,
  findTemplateFileAttachment,
  hasTooManyConsecutiveFailuresToday,
  interpolateTemplate,
  isAllowedWebhookUrl,
  isScheduledRuleDue,
  matchesTrigger,
  resolveFileFieldsForWebhook,
  runAutomationsForRecordChange,
  runScheduledAutomationsCheck,
  startScheduledAutomationsLoop,
} from "./automations.js";
import type { EmailAttachment, EmailSender } from "./email.js";
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

/**
 * None of the existing fixtures below fire a "send_email" rule (round 996's
 * own dedicated tests construct their own real, inspectable EmailSender
 * double instead), so every pre-existing runAutomationsForRecordChange/
 * fireScheduledRule/runScheduledAutomationsCheck/startScheduledAutomationsLoop
 * call site just needs a value to pass for the new emailSender parameter --
 * `configured: false` so a test that accidentally exercises a "send_email"
 * rule fails loudly (a recorded "not configured" failure) rather than
 * silently invoking `send` and getting away with it.
 */
const UNUSED_EMAIL_SENDER: EmailSender = {
  configured: false,
  async send() {
    throw new Error("UNUSED_EMAIL_SENDER.send() should never be called by a test that doesn't fire a send_email rule");
  },
};

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

/**
 * Round 1089's finding: V8/ICU's Number.prototype.toLocaleString("he-IL")
 * silently prepends a real, invisible U+200E LEFT-TO-RIGHT MARK right
 * before the minus sign of any negative number -- confirmed directly via
 * `Number(-150).toLocaleString("he-IL")`, whose codepoints include 0x200e
 * immediately before "-150", with no such character for the identical
 * call under "en-US". interpolateTemplate builds the literal, final text
 * of a real outbound WhatsApp/email message, with no bidi-rendering
 * context left to protect once it leaves the app -- so a Hebrew-project
 * rule referencing a negative "number" field (a balance due, a refund)
 * would otherwise embed this invisible character into a real recipient's
 * message. Confirms the number branch strips it for "he" while leaving
 * "en" (which never had the mark) and a positive "he" value unaffected.
 */
test("interpolateTemplate strips the invisible bidi mark toLocaleString adds before a negative number's minus sign under the 'he' locale", () => {
  const invoiceEntity: Entity = {
    name: "Invoice",
    label: "Invoice",
    fields: [{ name: "balance", type: "number", required: true }],
  };

  const he = interpolateTemplate("Balance: {{balance}}", invoiceEntity, { balance: -150 }, "he");
  assert.equal(he, "Balance: -150");
  assert.ok(!he.includes("‎") && !he.includes("‏"), "must contain no invisible bidi mark at all");

  const hePositive = interpolateTemplate("Balance: {{balance}}", invoiceEntity, { balance: 150 }, "he");
  assert.equal(hePositive, "Balance: 150", "a positive number under 'he' never had the mark and must be unaffected");

  const en = interpolateTemplate("Balance: {{balance}}", invoiceEntity, { balance: -150 }, "en");
  assert.equal(en, "Balance: -150", "'en' never had the mark and must be unaffected");
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
  assert.equal(matchesTrigger(rule, "created", { status: "New" }, new Set(), orderEntity), true);
  assert.equal(matchesTrigger(rule, "updated", { status: "New" }, new Set(["status"]), orderEntity), false);
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
  assert.equal(matchesTrigger(rule, "created", { status: "Delivered" }, new Set(["status"]), orderEntity), true);
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
  assert.equal(matchesTrigger(rule, "updated", { status: "Delivered" }, new Set(["customerPhone"]), orderEntity), false);
  assert.equal(matchesTrigger(rule, "updated", { status: "Delivered" }, new Set(["status"]), orderEntity), true);
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
  assert.equal(matchesTrigger(rule, "updated", { status: "Cancelled" }, new Set(["status"]), orderEntity), false);
});

/**
 * Round 969: the new "record_deleted" trigger -- fires on the "deleted"
 * event only, mirroring record_created's own "created"-only matching
 * exactly.
 */
test("matchesTrigger: record_deleted only matches the 'deleted' event, never 'created' or 'updated'", () => {
  const rule = insertAutomationRule(openDbForRuleOnly(), {
    projectId: "p",
    entityName: "Order",
    trigger: "record_deleted",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972500000000",
    messageTemplate: "Order {{orderId}} was deleted.",
  });
  assert.equal(matchesTrigger(rule, "deleted", { orderId: "A1" }, new Set(), orderEntity), true);
  assert.equal(matchesTrigger(rule, "created", { orderId: "A1" }, new Set(), orderEntity), false);
  assert.equal(matchesTrigger(rule, "updated", { orderId: "A1" }, new Set(["orderId"]), orderEntity), false);
});

/**
 * Round 969: a "deleted" event must never match a field_equals rule, even
 * when the record's own value matches that rule's target -- a record
 * about to be deleted isn't "being set to" its own current field values,
 * and a user who wants an automation specifically on deletion has the
 * explicit "record_deleted" trigger (tested above) for exactly that.
 * Without this exclusion, every field_equals rule whose target value
 * happened to match a deleted record's last stored value would silently
 * fire on every deletion too -- an unrelated trigger firing for a reason
 * nobody configured it for.
 */
test("matchesTrigger: a 'deleted' event never matches a field_equals rule, even when the record's stored value matches the rule's target", () => {
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
  assert.equal(matchesTrigger(rule, "deleted", { status: "Delivered" }, new Set(), orderEntity), false);
});

/**
 * Round 1098: nothing in this function's own structure ever actually
 * enforced its own doc comment's claim that "schedule... never matches
 * any record event at all" -- it relied entirely on fieldName being null
 * for a schedule rule, an invariant the PATCH route's own
 * `{ ...existing, ...parsed.data }` merge could leave stale (a trigger
 * changed away from field_equals without the caller also explicitly
 * nulling fieldName/fieldValue -- routes/projects.ts's own
 * findAutomationRuleInvariantViolation is now hardened against writing
 * this state too, but matchesTrigger must not trust that alone).
 * insertAutomationRule (the DB layer) has no schema validation of its
 * own, so it's used directly here to construct exactly that
 * otherwise-unreachable-through-the-API stale state.
 */
test("matchesTrigger: a schedule rule never matches a record event, even when it still carries a stale fieldName/fieldValue left over from being field_equals", () => {
  const rule = insertAutomationRule(openDbForRuleOnly(), {
    projectId: "p",
    entityName: "Order",
    trigger: "schedule",
    fieldName: "status",
    fieldValue: "urgent",
    scheduleTimeUtc: "09:00",
    actionType: "send_whatsapp",
    toMode: "static",
    toNumber: "972500000000",
    messageTemplate: "Daily digest",
  });
  assert.equal(matchesTrigger(rule, "created", { status: "urgent" }, new Set(), orderEntity), false);
  assert.equal(matchesTrigger(rule, "updated", { status: "urgent" }, new Set(["status"]), orderEntity), false);
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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]!.to, "972501234567");
  assert.equal(sendCalls[0]!.body, "Hi Dana, your order has been delivered!");
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.status, "sent");
  assert.equal(messages[0]!.toNumber, "972501234567");
});

/**
 * Round 1321: a toMode:"field" destination's toField can resolve to a
 * field the AI spec generator typed "number" instead of "text" -- a phone
 * number "looks numeric", and EntitySchema/FieldSchema impose no
 * restriction tying a field's name to its type. repository.ts's
 * rowToRecord returns a "number"-typed field's value as a real JS
 * number, never a string, so this rule's own `typeof to !== "string"`
 * check used to always fail with "no value in the configured
 * phone-number field" -- even though the record plainly has a valid
 * phone number -- and the message was never sent. Mirrors the identical
 * fix already made for the same underlying defect in two other call
 * sites: whatsapp.ts's findMatchingRecord (round 1278, inbound message ->
 * record) and entityFormatting.ts's findRecordPhoneNumber (round 1286,
 * the "Send WhatsApp" button's own visibility check) -- this is the third,
 * distinct call site that never got it.
 */
test("runAutomationsForRecordChange sends a WhatsApp message when a toMode:\"field\" rule's toField resolves to a number-typed phone field", async () => {
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
  // customerPhone typed "number" instead of "text" -- the exact shape an
  // AI spec generator could plausibly produce for a numeric-looking field.
  const numberPhoneEntity: Entity = {
    ...orderEntity,
    fields: orderEntity.fields.map((f) => (f.name === "customerPhone" ? { ...f, type: "number" as const } : f)),
  };
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 1, customerName: "Dana", customerPhone: 972501234567, status: "Delivered" };

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, numberPhoneEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(sendCalls.length, 1, "the message must actually be sent, not silently fail with 'no value in the configured phone-number field'");
  assert.equal(sendCalls[0]!.to, "972501234567");
  const { messages } = listWhatsAppMessages(db, project.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.status, "sent");
  assert.equal(messages[0]!.toNumber, "972501234567");
});

/**
 * Round 1188: packages/db/src/migrate.ts explicitly treats a case-only
 * field rename (type unchanged) as "the same field" and deliberately does
 * NOT disable a referencing rule for it (its own prevFieldByLowerName
 * leniency, migrate.ts:470-473) -- but rule.fieldName is a string
 * persisted at rule-creation time, and repository.ts's rowToRecord keys
 * every record strictly by the entity's CURRENT field.name. Without
 * resolveStoredFieldName, a rule created while the field was named
 * "status" would silently stop matching anything at all the moment a live
 * refine recased that same field to "Status" -- not because the field was
 * removed, but because changedFields.has(rule.fieldName) and
 * record[rule.fieldName] both missed the new casing entirely. The
 * template's own {{status}} placeholder (authored against the same old
 * casing) has the identical gap in interpolateTemplate.
 */
test("runAutomationsForRecordChange still fires a field_equals rule and interpolates its own template placeholder after the entity's field was renamed only by letter case", async () => {
  const { db, project } = setupProject();
  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status", // stored at rule-creation time, lowercase "s"
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "field",
    toField: "customerPhone",
    messageTemplate: "Hi {{customerName}}, your {{status}} order is ready!",
  });
  // Simulates the entity AFTER a live refine recased "status" to "Status"
  // (same type, same position) -- the real shape repository.ts's
  // rowToRecord keys the record object by.
  const renamedEntity: Entity = {
    ...orderEntity,
    fields: orderEntity.fields.map((f) => (f.name === "status" ? { ...f, name: "Status" } : f)),
  };
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });
  const record = { id: 1, customerName: "Dana", customerPhone: "972501234567", Status: "Delivered" };

  await runAutomationsForRecordChange(
    db,
    manager,
    UNUSED_EMAIL_SENDER,
    project,
    renamedEntity,
    "updated",
    record,
    new Set(["Status"]),
    UNUSED_UPLOADS_DIR,
    UNUSED_BASE_URL,
  );

  assert.equal(sendCalls.length, 1, "the rule must still fire even though its own stored fieldName is the field's OLD casing");
  assert.equal(sendCalls[0]!.to, "972501234567");
  assert.equal(
    sendCalls[0]!.body,
    "Hi Dana, your Delivered order is ready!",
    "the template's own {{status}} placeholder (also authored against the old casing) must still resolve to the record's real value",
  );
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
    const storedFilename = "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf";
    await mkdir(path.join(uploadsDir, project.id, "Order"), { recursive: true });
    await writeFile(path.join(uploadsDir, project.id, "Order", storedFilename), "%PDF-fake-invoice-contents");

    const record = {
      id: 1,
      customerName: "Dana",
      customerPhone: "972501234567",
      status: "Delivered",
      invoice: JSON.stringify({ url: `/api/uploads/${project.id}/Order/${storedFilename}`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
    };

    await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, entityWithInvoice, "updated", record, new Set(["status"]), uploadsDir, UNUSED_BASE_URL);

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

/**
 * Round 1013: the identical gap round 786 fixed for send_whatsapp above,
 * just never ported to the send_email action added ten rounds later
 * (round 996) -- fireEmailAction had no uploadsDir parameter at all, so a
 * message/subject template referencing a `file` field only ever sent the
 * bare filename as plain text, the same silent degradation round 786
 * closed for WhatsApp. Confirms the real file on disk is base64-encoded
 * and handed to EmailSender.send() as a real attachment.
 */
test("runAutomationsForRecordChange attaches a real uploaded file to a send_email rule when its message template references a 'file' field", async () => {
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
    actionType: "send_email",
    toMode: "field",
    toField: "customerEmail",
    emailSubject: "Your order is on its way",
    messageTemplate: "Hi {{customerName}}, here's your invoice: {{invoice}}",
  });
  const emailSender = createFakeEmailSender();
  const manager = {} as WhatsAppWebManager;

  const uploadsDir = await mkdtemp(path.join(tmpdir(), "forge-automations-email-attachment-test-"));
  try {
    const storedFilename = "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf";
    await mkdir(path.join(uploadsDir, project.id, "Order"), { recursive: true });
    await writeFile(path.join(uploadsDir, project.id, "Order", storedFilename), "%PDF-fake-invoice-contents");

    const record = {
      id: 1,
      customerName: "Dana",
      customerEmail: "dana@example.com",
      status: "Delivered",
      invoice: JSON.stringify({ url: `/api/uploads/${project.id}/Order/${storedFilename}`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
    };

    await runAutomationsForRecordChange(db, manager, emailSender, project, entityWithInvoice, "updated", record, new Set(["status"]), uploadsDir, UNUSED_BASE_URL);

    assert.equal(emailSender.sentTo.length, 1);
    assert.equal(emailSender.sentTo[0]!.text, "Hi Dana, here's your invoice: invoice-203.pdf", "the plain text itself still only names the file, same as before this round");
    assert.equal(emailSender.sentTo[0]!.attachments?.length, 1, "expected exactly one real attachment");
    assert.equal(emailSender.sentTo[0]!.attachments![0]!.filename, "invoice-203.pdf");
    assert.equal(
      emailSender.sentTo[0]!.attachments![0]!.content,
      Buffer.from("%PDF-fake-invoice-contents").toString("base64"),
      "expected the real file's own bytes, base64-encoded, not a placeholder",
    );
  } finally {
    await rm(uploadsDir, { recursive: true, force: true });
  }
});

test("runAutomationsForRecordChange sends a send_email rule with no attachment (not a failure) when the referenced upload is missing from disk", async () => {
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
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_email",
    toMode: "field",
    toField: "customerEmail",
    emailSubject: "Your order is on its way",
    messageTemplate: "Hi {{customerName}}, here's your invoice: {{invoice}}",
  });
  const emailSender = createFakeEmailSender();
  const manager = {} as WhatsAppWebManager;

  // Deliberately a real, existing-but-empty directory -- the referenced
  // upload itself was never written into it, mirroring an upload that was
  // deleted/replaced since this rule last ran.
  const uploadsDir = await mkdtemp(path.join(tmpdir(), "forge-automations-email-missing-attachment-test-"));
  try {
    const record = {
      id: 1,
      customerName: "Dana",
      customerEmail: "dana@example.com",
      status: "Delivered",
      invoice: JSON.stringify({ url: `/api/uploads/${project.id}/Order/missing.pdf`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
    };

    await runAutomationsForRecordChange(db, manager, emailSender, project, entityWithInvoice, "updated", record, new Set(["status"]), uploadsDir, UNUSED_BASE_URL);

    assert.equal(emailSender.sentTo.length, 1, "a missing attachment must degrade to a plain send, never block the email entirely");
    assert.equal(emailSender.sentTo[0]!.attachments, undefined, "no attachment must be sent when the real file can't be read from disk");
    assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent", "a missing attachment must never be reported as a failed run");
  } finally {
    await rm(uploadsDir, { recursive: true, force: true });
  }
});

/**
 * Round 1014: round 1013's own fix only ever scanned messageTemplate
 * (the body) for a file-field reference -- but emailSubject interpolates
 * its own {{field}} placeholders completely independently of the body
 * (round 1000), with no restriction anywhere on which field types can
 * appear in it. A rule whose subject (not body) names a file field got
 * a subject line implying an attached file with nothing actually
 * attached. Confirms a file field referenced ONLY in emailSubject is now
 * found and attached too.
 */
test("runAutomationsForRecordChange attaches a real uploaded file to a send_email rule when the file field is referenced only in emailSubject, not the body", async () => {
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
    actionType: "send_email",
    toMode: "field",
    toField: "customerEmail",
    emailSubject: "Invoice attached: {{invoice}}",
    // Deliberately never references {{invoice}} -- only the subject does.
    messageTemplate: "Thanks for your order, {{customerName}}!",
  });
  const emailSender = createFakeEmailSender();
  const manager = {} as WhatsAppWebManager;

  const uploadsDir = await mkdtemp(path.join(tmpdir(), "forge-automations-email-subject-attachment-test-"));
  try {
    const storedFilename = "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf";
    await mkdir(path.join(uploadsDir, project.id, "Order"), { recursive: true });
    await writeFile(path.join(uploadsDir, project.id, "Order", storedFilename), "%PDF-fake-invoice-contents");

    const record = {
      id: 1,
      customerName: "Dana",
      customerEmail: "dana@example.com",
      status: "Delivered",
      invoice: JSON.stringify({ url: `/api/uploads/${project.id}/Order/${storedFilename}`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
    };

    await runAutomationsForRecordChange(db, manager, emailSender, project, entityWithInvoice, "updated", record, new Set(["status"]), uploadsDir, UNUSED_BASE_URL);

    assert.equal(emailSender.sentTo.length, 1);
    assert.equal(emailSender.sentTo[0]!.subject, "Invoice attached: invoice-203.pdf");
    assert.equal(emailSender.sentTo[0]!.text, "Thanks for your order, Dana!");
    assert.equal(emailSender.sentTo[0]!.attachments?.length, 1, "a file field referenced only in the subject must still produce a real attachment");
    assert.equal(emailSender.sentTo[0]!.attachments![0]!.filename, "invoice-203.pdf");
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
    invoice: JSON.stringify({
      url: "/api/uploads/proj1/Order/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
      name: "invoice-203.pdf",
      size: 27,
      mimeType: "application/pdf",
    }),
  };
  const attachment = findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "Hi {{customerName}}, here's {{invoice}}", record);
  assert.deepEqual(attachment, {
    filePath: "/uploads/proj1/Order/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
    fileName: "invoice-203.pdf",
    mimeType: "application/pdf",
  });
});

/**
 * Round 1325: unlike findTemplateFileAttachment above (correctly scoped
 * to WhatsApp's own real one-attachment-per-message limitation),
 * findAllTemplateFileAttachments is email's own sibling -- email has no
 * such limitation (EmailAttachment[]/the Resend payload already support
 * multiple attachments end to end), so a template referencing two
 * distinct file fields must resolve both, in placeholder order, not just
 * the first. Also confirms the SAME field referenced twice in the
 * template (once in a hypothetical subject, once in the body -- modeled
 * here as two placeholders in one combined string, matching how
 * fireEmailAction actually calls this function) is deduplicated to a
 * single attachment, not sent twice.
 */
test("findAllTemplateFileAttachments resolves every distinct file-type field referenced in the template, not just the first, and never duplicates a field referenced twice", () => {
  const entityWithTwoFiles: Entity = {
    ...orderEntity,
    fields: [
      ...orderEntity.fields,
      { name: "invoice", type: "file", required: false },
      { name: "receipt", type: "file", required: false },
    ],
  };
  const record = {
    customerName: "Dana",
    invoice: JSON.stringify({
      url: "/api/uploads/proj1/Order/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
      name: "invoice-203.pdf",
      size: 27,
      mimeType: "application/pdf",
    }),
    receipt: JSON.stringify({
      url: "/api/uploads/proj1/Order/b2c3d4e5-f6a7-8901-bcde-f12345678901.pdf",
      name: "receipt-203.pdf",
      size: 19,
      mimeType: "application/pdf",
    }),
  };
  const attachments = findAllTemplateFileAttachments(
    "/uploads",
    "proj1",
    entityWithTwoFiles,
    "Hi {{customerName}}, here's {{invoice}} and {{receipt}}, see {{invoice}} again",
    record,
  );
  assert.deepEqual(attachments, [
    { filePath: "/uploads/proj1/Order/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf", fileName: "invoice-203.pdf", mimeType: "application/pdf" },
    { filePath: "/uploads/proj1/Order/b2c3d4e5-f6a7-8901-bcde-f12345678901.pdf", fileName: "receipt-203.pdf", mimeType: "application/pdf" },
  ]);
});

test("runAutomationsForRecordChange attaches every distinct referenced file field to a send_email rule, not just the first", async () => {
  const entityWithTwoFiles: Entity = {
    ...orderEntity,
    fields: [
      ...orderEntity.fields,
      { name: "invoice", type: "file", required: false },
      { name: "receipt", type: "file", required: false },
    ],
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
      spec: { ...projectSpec, entities: [entityWithTwoFiles] },
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
    actionType: "send_email",
    toMode: "field",
    toField: "customerEmail",
    emailSubject: "Invoice attached: {{invoice}}",
    messageTemplate: "Thanks for your order, {{customerName}}! Your receipt is {{receipt}}.",
  });
  const emailSender = createFakeEmailSender();
  const manager = {} as WhatsAppWebManager;

  const uploadsDir = await mkdtemp(path.join(tmpdir(), "forge-automations-email-two-attachments-test-"));
  try {
    const invoiceFilename = "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf";
    const receiptFilename = "b2c3d4e5-f6a7-8901-bcde-f12345678901.pdf";
    await mkdir(path.join(uploadsDir, project.id, "Order"), { recursive: true });
    await writeFile(path.join(uploadsDir, project.id, "Order", invoiceFilename), "%PDF-fake-invoice-contents");
    await writeFile(path.join(uploadsDir, project.id, "Order", receiptFilename), "%PDF-fake-receipt-contents");

    const record = {
      id: 1,
      customerName: "Dana",
      customerEmail: "dana@example.com",
      status: "Delivered",
      invoice: JSON.stringify({ url: `/api/uploads/${project.id}/Order/${invoiceFilename}`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
      receipt: JSON.stringify({ url: `/api/uploads/${project.id}/Order/${receiptFilename}`, name: "receipt-203.pdf", size: 19, mimeType: "application/pdf" }),
    };

    await runAutomationsForRecordChange(db, manager, emailSender, project, entityWithTwoFiles, "updated", record, new Set(["status"]), uploadsDir, UNUSED_BASE_URL);

    assert.equal(emailSender.sentTo.length, 1);
    assert.equal(
      emailSender.sentTo[0]!.attachments?.length,
      2,
      "a template referencing two distinct file fields across subject and body must attach both, not just the first",
    );
    const attachmentNames = emailSender.sentTo[0]!.attachments!.map((a) => a.filename).sort();
    assert.deepEqual(attachmentNames, ["invoice-203.pdf", "receipt-203.pdf"]);
  } finally {
    await rm(uploadsDir, { recursive: true, force: true });
  }
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

/**
 * Round 918's finding: `deleteUploadedFile` (routes/projects.ts) already
 * requires the filename's own final segment to match UPLOADED_FILENAME --
 * the one shape this server itself ever actually generates -- but this
 * function never got the same guard, despite building the identical path
 * from the identical unrestricted entity.name. `isPathInsideDir` alone
 * only bounds the resolved path to uploadsDir ITSELF, not to this
 * specific project+entity's own subdirectory within it, so (matching
 * round 849's own documented caveat for the delete primitive) this guard
 * doesn't fully close a crafted entity name resolving into a DIFFERENT
 * project's own folder -- it confines what can be read-and-exfiltrated
 * there to a file some upload, somewhere, was really once named, never
 * an arbitrary filename a crafted descriptor could otherwise invent.
 */
test("findTemplateFileAttachment returns null when the stored filename doesn't match this server's own UPLOADED_FILENAME shape", () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };
  const record = {
    customerName: "Dana",
    invoice: JSON.stringify({ url: "/api/uploads/proj1/Order/not-a-real-upload-name.pdf", name: "invoice.pdf", size: 27, mimeType: "application/pdf" }),
  };
  const attachment = findTemplateFileAttachment("/uploads", "proj1", entityWithInvoice, "Here's {{invoice}}", record);
  assert.equal(attachment, null, "a filename this server itself never actually generated must never be read and attached");
});

/**
 * Round 1270: migrate.ts's own case-insensitive rename detection treats a
 * case-only entity rename (e.g. "customer" -> "Customer") as a true no-op
 * at the db layer -- but createUploadMiddleware wrote this file's real
 * upload to a directory cased to match whatever was canonical AT UPLOAD
 * TIME, and nothing ever moves or renames that directory on a later
 * refine. Before resolveUploadedFilePath's own case-insensitive fallback
 * (same round), this function rebuilt the path from the entity's CURRENT
 * canonical name, which no longer matched the real, lowercase-cased
 * directory still sitting on disk -- silently dropping the attachment
 * from a WhatsApp automation message that should have included it.
 */
test("findTemplateFileAttachment still finds the real uploaded file after the entity's name was later changed by letter case only", async () => {
  const entityWithInvoice: Entity = {
    name: "Customer",
    label: "Customer",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "invoice", type: "file", required: false },
    ],
  };
  const uploadsDir = await mkdtemp(path.join(tmpdir(), "forge-automations-case-rename-attachment-test-"));
  try {
    const storedFilename = "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf";
    // The real upload physically lives under the LOWERCASE directory --
    // whatever "Customer" was canonically cased as at the time this file
    // was actually uploaded, before a later refine recased it.
    await mkdir(path.join(uploadsDir, "proj1", "customer"), { recursive: true });
    await writeFile(path.join(uploadsDir, "proj1", "customer", storedFilename), "%PDF-fake-invoice-contents");

    const record = {
      name: "Dana",
      invoice: JSON.stringify({ url: `/api/uploads/proj1/customer/${storedFilename}`, name: "invoice-203.pdf", size: 27, mimeType: "application/pdf" }),
    };
    const attachment = findTemplateFileAttachment(uploadsDir, "proj1", entityWithInvoice, "Here's {{invoice}}", record);
    assert.deepEqual(attachment, {
      filePath: path.join(uploadsDir, "proj1", "customer", storedFilename),
      fileName: "invoice-203.pdf",
      mimeType: "application/pdf",
    });
  } finally {
    await rm(uploadsDir, { recursive: true, force: true });
  }
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
  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.ok(after.lastTriggeredAt);
  assert.equal(after.lastStatus, "sent");
  assert.equal(after.lastError, null);
  // Round 948: confirms fireRule's own real recordAutomationRun call site
  // actually passes rule.actionType through end-to-end -- not just that
  // the lower-level recordAutomationRun function accepts it in isolation
  // (packages/db/src/automations.test.ts already covers that).
  assert.equal(after.lastActionType, "send_whatsapp");
});

/**
 * Round 1276: routes/projects.ts's POST .../test route fires a
 * record-triggered rule (field_equals/record_created/record_deleted)
 * through fireRule directly, passing isManualTest=true -- mirroring
 * fireScheduledRule's own round-1261 protection. Before this fix, a
 * manual Test click unconditionally updated the rule's own
 * lastTriggeredAt/lastStatus, which App.tsx's failing-automations badge
 * and its round-1218 "newly failing" desktop notification both key off
 * (lastStatus === "failed") -- so testing a rule against bad/unexpected
 * data (or hitting any real, incidental failure while testing) falsely
 * reported a working rule as newly broken in production monitoring.
 * Confirms both halves: the rule's own summary columns stay untouched,
 * AND the run still shows up in the rule's real history either way.
 */
test("fireRule called with isManualTest=true records a real run but leaves the rule's own lastTriggeredAt/lastStatus untouched", async () => {
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
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true, sendResult: { ok: false, error: "recipient not found" } });
  const record = { id: 4, customerName: "Yael", customerPhone: null, status: "New" };

  await fireRule(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, rule, record, UNUSED_UPLOADS_DIR, UNUSED_BASE_URL, true);

  assert.equal(sendCalls.length, 1, "a manual test must still genuinely attempt the real send, not a fake dry run");
  const afterTest = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(afterTest.lastTriggeredAt, null, "a manual test must never update the rule's own lastTriggeredAt");
  assert.equal(afterTest.lastStatus, null, "a manual test must never update the rule's own lastStatus");

  const [run] = listAutomationRuns(db, project.id, rule.id);
  assert.equal(run!.status, "failed", "the test's own outcome must still show up as a real run in the rule's history");
});

test("fireRule called with isManualTest omitted (the real triggers' own call shape) updates the rule's own lastTriggeredAt/lastStatus as before", async () => {
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
  const record = { id: 5, customerName: "Itay", customerPhone: null, status: "New" };

  await fireRule(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, rule, record, UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.ok(after.lastTriggeredAt, "a real record-triggered fire (and the existing manual Retry route, round 971/972) must still update lastTriggeredAt, unchanged by this round's fix");
  assert.equal(after.lastStatus, "sent");
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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(Object.keys(record)), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, orderEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, dealEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(sendCalls.length, 1);
  assert.equal(
    sendCalls[0]!.body,
    "Congrats Dana Levi, your deal is Won!",
    "the message must carry the related customer's own name, not the bare numeric id it's actually stored as",
  );
});

/**
 * Round 1160: mirrors the test above exactly, except the relation field's
 * own relationTo ("customer") differs from its real target entity's name
 * ("Customer") only by letter case -- the same genuinely plausible
 * AI-generated-spec scenario migrate.ts's own round-1159 fix addresses for
 * FK generation. Before this round, resolveRelationFieldsForTemplate's own
 * exact-case `e.name === field.relationTo` lookup would have left the sent
 * message carrying the raw "#<id>" instead of the related customer's name.
 */
test("runAutomationsForRecordChange interpolates a relation field's display label even when relationTo differs from its target entity's name only by letter case", async () => {
  const customerEntity: Entity = {
    name: "Customer",
    label: "Customer",
    fields: [{ name: "name", type: "text", required: true }],
  };
  const dealEntity: Entity = {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "customer", type: "relation", relationTo: "customer", required: true },
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
  const inserted = insertProject(db, { id: "proj-case", ownerId: "owner1", name: "Deals", description: "A deals app", spec });
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

  await runAutomationsForRecordChange(db, manager, UNUSED_EMAIL_SENDER, project, dealEntity, "updated", record, new Set(["status"]), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(sendCalls.length, 1);
  assert.equal(
    sendCalls[0]!.body,
    "Congrats Dana Levi, your deal is Won!",
    "the message must carry the related customer's own name even though relationTo is lowercase customer, not Customer",
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

/**
 * Round 967: the exact bug the survey that prompted this round flagged --
 * before scheduleTimezone existed, scheduleDaysOfWeek/scheduleTimeUtc were
 * always literal UTC, so a business in a timezone AHEAD of UTC (e.g.
 * Israel) wanting a message at their own local midnight-ish had to select
 * the PREVIOUS day's checkbox, not the day they actually meant -- a wrong-
 * day send with no error anywhere. These two UTC instants are chosen so
 * the UTC calendar day and the Asia/Jerusalem calendar day actually
 * disagree: 2026-01-04T22:30:00.000Z is UTC Sunday, but already
 * Asia/Jerusalem Monday 00:30 (confirmed directly against Intl, not
 * assumed). A rule whose scheduleDaysOfWeek is "1" (Monday only) and
 * scheduleTimezone "Asia/Jerusalem" must fire at that instant -- the
 * moment a Jerusalem-based owner actually means by "Monday at 00:30" --
 * even though the OLD, UTC-only logic (now.getUTCDay()) would have called
 * this exact instant "Sunday" and refused to fire for a whole extra day.
 */
test("isScheduledRuleDue evaluates scheduleDaysOfWeek and scheduleTimeUtc as wall-clock values in the rule's own scheduleTimezone, not literal UTC", () => {
  const mondayMidnightJerusalem = {
    ...scheduleRuleBase({ scheduleTimeUtc: "00:30", scheduleDaysOfWeek: "1", scheduleTimezone: "Asia/Jerusalem" }),
    id: "r1",
    createdAt: "",
    updatedAt: "",
    lastTriggeredAt: null,
    lastStatus: null,
    lastError: null,
    enabled: true,
  } as unknown as Parameters<typeof isScheduledRuleDue>[0];

  assert.equal(
    isScheduledRuleDue(mondayMidnightJerusalem, new Date("2026-01-04T22:30:00.000Z")),
    true,
    "this instant is already Monday 00:30 in Asia/Jerusalem (winter, UTC+2), even though its own UTC calendar date is still Sunday",
  );
  assert.equal(
    isScheduledRuleDue(mondayMidnightJerusalem, new Date("2026-01-04T21:29:00.000Z")),
    false,
    "one minute before Jerusalem's own local Monday 00:30 (still Sunday 23:29 there) must not be due yet",
  );

  // Same real-world local moment, but in July -- Israel observes DST
  // (IDT, UTC+3) then, a full hour different from January's UTC+2. A
  // fixed UTC offset baked in once at creation time could never get both
  // of these right from the same stored scheduleTimeUtc/scheduleTimezone;
  // only asking the real IANA tzdata what time it actually is in that
  // zone, for the specific date in question, can.
  assert.equal(
    isScheduledRuleDue(mondayMidnightJerusalem, new Date("2026-07-05T21:30:00.000Z")),
    true,
    "this instant is already Monday 00:30 in Asia/Jerusalem (summer, UTC+3 under DST), even though its own UTC calendar date is still Sunday",
  );
  assert.equal(
    isScheduledRuleDue(mondayMidnightJerusalem, new Date("2026-07-05T20:29:00.000Z")),
    false,
    "one minute before Jerusalem's own local Monday 00:30 in July (still Sunday 23:29 there under DST) must not be due yet",
  );
});

/**
 * Round 967: the "already fired today" gate (lastTriggeredAt/lastStatus)
 * must compare the rule's own LOCAL calendar date, not the UTC one --
 * otherwise a rule whose local day rolls over at a different moment than
 * UTC's could either re-fire twice on the same local day, or stay
 * wrongly gated into what's already its next local day. Uses the same
 * Asia/Jerusalem local-Monday-00:30 instant as the test above.
 */
test("isScheduledRuleDue's 'already fired today' gate compares the rule's own local calendar date, not the UTC one", () => {
  const rule = {
    ...scheduleRuleBase({ scheduleTimeUtc: "00:30", scheduleDaysOfWeek: null, scheduleTimezone: "Asia/Jerusalem" }),
    id: "r1",
    createdAt: "",
    updatedAt: "",
    // Fired at Asia/Jerusalem Monday 00:35 (UTC Sunday 22:35).
    lastTriggeredAt: "2026-01-04T22:35:00.000Z",
    lastStatus: "sent" as const,
    lastError: null,
    enabled: true,
  } as unknown as Parameters<typeof isScheduledRuleDue>[0];

  assert.equal(
    isScheduledRuleDue(rule, new Date("2026-01-05T08:00:00.000Z")),
    false,
    "still the same Jerusalem-local Monday (now 10:00 local) as when it already successfully fired -- must not fire again",
  );
  assert.equal(
    isScheduledRuleDue(rule, new Date("2026-01-05T22:30:00.000Z")),
    true,
    "Jerusalem's own local Tuesday 00:30 has arrived -- a new local day, so it's due again",
  );
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

  await fireScheduledRule(db, manager, UNUSED_EMAIL_SENDER, project, rule);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]!.to, "972501234567");
  assert.equal(sendCalls[0]!.body, "Reminder: check {{anything}} today.", "a schedule rule has no record, so a {{field}} placeholder must be left exactly as typed, not interpolated or stripped");
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});

test("fireScheduledRule records a failed outcome with no destination configured when toNumber is empty", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase({ toNumber: null }));
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });

  await fireScheduledRule(db, manager, UNUSED_EMAIL_SENDER, project, rule);

  assert.equal(sendCalls.length, 0);
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /no destination phone number/);
});

test("fireScheduledRule records a failed outcome when WhatsApp isn't connected, without attempting to send", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase());
  const { manager, sendCalls } = createFakeWhatsApp({ connected: false });

  await fireScheduledRule(db, manager, UNUSED_EMAIL_SENDER, project, rule);

  assert.equal(sendCalls.length, 0);
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "failed");
});

/**
 * Round 1261: routes/projects.ts's POST .../test route fires a
 * schedule-trigger rule through this exact function, passing
 * isManualTest=true specifically so a successful test never marks today's
 * REAL scheduled occurrence as already sent -- isScheduledRuleDue reads
 * exactly the two columns (lastTriggeredAt/lastStatus) an ordinary call
 * updates. Before this fix, a rule tested successfully in the morning
 * would never actually fire at its own scheduled time later that same
 * day. Confirms both halves: the rule's own summary columns stay
 * untouched, AND isScheduledRuleDue genuinely still considers the rule
 * due afterward (not just that the columns look right in isolation).
 */
test("fireScheduledRule called with isManualTest=true records a real run but leaves the rule's own lastTriggeredAt/lastStatus untouched, so isScheduledRuleDue still considers it due later the same day", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase());
  const { manager, sendCalls } = createFakeWhatsApp({ connected: true });

  await fireScheduledRule(db, manager, UNUSED_EMAIL_SENDER, project, rule, new Date(), true);

  assert.equal(sendCalls.length, 1, "a manual test must still genuinely attempt the real send, not a fake dry run");
  const afterTest = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(afterTest.lastTriggeredAt, null, "a manual test must never update the rule's own lastTriggeredAt");
  assert.equal(afterTest.lastStatus, null, "a manual test must never update the rule's own lastStatus");

  const [run] = listAutomationRuns(db, project.id, rule.id);
  assert.equal(run!.status, "sent", "the test's own outcome must still show up as a real run in the rule's history");

  assert.equal(
    isScheduledRuleDue({ ...afterTest, scheduleTimeUtc: "00:00" }, new Date()),
    true,
    "the real scheduler must still consider this rule due right now, exactly as if the test had never happened",
  );
});

test("fireScheduledRule called with isManualTest omitted (the real scheduler's own call shape) updates the rule's own lastTriggeredAt/lastStatus as before", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase());
  const { manager } = createFakeWhatsApp({ connected: true });

  await fireScheduledRule(db, manager, UNUSED_EMAIL_SENDER, project, rule);

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.ok(after.lastTriggeredAt, "the real scheduler's own call must still update lastTriggeredAt, unchanged by this round's fix");
  assert.equal(after.lastStatus, "sent");
});

/**
 * Round 1263: round 1261 stopped a manual Test from marking today's real
 * occurrence as "already sent" (isScheduledRuleDue), but every Test call
 * still inserted a fully real automation_runs row with no way to tell it
 * apart from a genuine scheduler-tick failure -- so repeatedly Testing a
 * broken rule while debugging it (five failed Test clicks while
 * iterating on a fix is an entirely ordinary troubleshooting flow) could
 * trip hasTooManyConsecutiveFailuresToday on nothing but Test clicks,
 * silently skipping that day's real scheduled send even after the real
 * misconfiguration was fixed. Confirms 5 consecutive Test-originated
 * failures never trip the cap, while 5 consecutive REAL failures (via
 * the real scheduler, isManualTest omitted) still do, exactly as before.
 */
test("5 consecutive isManualTest=true failures never trip hasTooManyConsecutiveFailuresToday, but 5 consecutive real scheduler failures still do", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase());
  const { manager: brokenManager } = createFakeWhatsApp({ connected: true, sendResult: { ok: false, error: "recipient not found" } });

  for (let i = 0; i < 5; i++) {
    await fireScheduledRule(db, brokenManager, UNUSED_EMAIL_SENDER, project, rule, new Date("2026-03-15T09:00:00.000Z"), true);
  }
  assert.equal(
    hasTooManyConsecutiveFailuresToday(db, getAutomationRule(db, project.id, rule.id)!, new Date("2026-03-15T09:00:00.000Z")),
    false,
    "5 consecutive Test-originated failures must never trip the real scheduler's own daily failure-pause cap",
  );

  // The real misconfiguration gets fixed, and the real scheduler ticks --
  // must still actually attempt the send, not stay falsely paused.
  const { manager: fixedManager, sendCalls } = createFakeWhatsApp({ connected: true });
  await runScheduledAutomationsCheck(db, fixedManager, UNUSED_EMAIL_SENDER, new Date("2026-03-15T09:01:00.000Z"));
  assert.equal(sendCalls.length, 1, "the real scheduler must still fire this rule -- Test clicks alone must never pause it");

  // A SEPARATE rule, failing for real via the scheduler itself (never
  // Tested), must still trip the cap exactly as before this round.
  const realRule = insertAutomationRule(db, scheduleRuleBase({ toNumber: "972509999999" }));
  const { manager: stillBrokenManager } = createFakeWhatsApp({ connected: true, sendResult: { ok: false, error: "recipient not found" } });
  for (const minute of ["09:00", "09:01", "09:02", "09:03", "09:04"]) {
    await runScheduledAutomationsCheck(db, stillBrokenManager, UNUSED_EMAIL_SENDER, new Date(`2026-03-15T${minute}:00.000Z`));
  }
  assert.equal(
    hasTooManyConsecutiveFailuresToday(db, getAutomationRule(db, project.id, realRule.id)!, new Date("2026-03-15T09:05:00.000Z")),
    true,
    "5 consecutive REAL scheduler failures must still trip the cap, unchanged by this round's fix",
  );
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
  await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, new Date("2026-03-15T09:00:00.000Z"));

  assert.equal(sendCalls.length, 1, "exactly the one due, enabled rule must fire");
  assert.equal(sendCalls[0]!.to, "111");
  assert.equal(getAutomationRule(db, "proj1", due.id)!.lastStatus, "sent");
  assert.equal(getAutomationRule(db, "proj2", notYetDue.id)!.lastStatus, null, "not due yet -- must be untouched");
  assert.equal(getAutomationRule(db, "proj1", disabledDue.id)!.lastStatus, null, "disabled -- must never be considered even though its time has passed");
});

/**
 * Round 989: isScheduledRuleDue's own "already sent today" guard
 * (lastTriggeredAt/lastStatus) only becomes true once recordAutomationRun
 * writes it, which only happens AFTER fireScheduledRule's own send call
 * resolves -- nothing previously stopped startScheduledAutomationsLoop's
 * setInterval from starting a brand new tick while a PREVIOUS tick was
 * still mid-flight awaiting a slow send. A webhook rule's own 10s-per-rule
 * timeout, or several schedule rules queued through a WhatsApp
 * per-project sendQueue, can easily push one tick's real runtime past a
 * 60s interval -- not a contrived scenario. Without a guard, the next
 * tick's own listEnabledScheduledRules read still sees the same
 * pre-update rule, isScheduledRuleDue returns true again, and
 * fireScheduledRule fires a SECOND time concurrently with the first --
 * sending the same scheduled WhatsApp message twice to the same real
 * recipient. Uses a deliberately short real interval (not fake timers --
 * see this file's own established avoidance of combining those with
 * polling) and a send call that stays held open until the test releases
 * it, to let several would-be ticks elapse while the very first is still
 * in flight.
 */
test("startScheduledAutomationsLoop never starts a new tick while the previous tick is still awaiting a slow send, preventing a duplicate WhatsApp send for the same scheduled rule", async () => {
  const { db } = setupProject();
  insertAutomationRule(db, scheduleRuleBase({ scheduleTimeUtc: "00:00", toNumber: "972501234567" }));

  const sendCalls: string[] = [];
  let releaseSend: (() => void) | undefined;
  const manager = {
    getStatus(): WhatsAppConnectionState {
      return { status: "connected", qrDataUrl: null, phoneNumber: "972500000000", error: null };
    },
    async sendMessage(_projectId: string, to: string): Promise<WhatsAppSendResult> {
      sendCalls.push(to);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      return { ok: true };
    },
  } as unknown as WhatsAppWebManager;

  const stop = startScheduledAutomationsLoop(db, manager, UNUSED_EMAIL_SENDER, 20);
  try {
    // Several 20ms ticks would fire during this window without the guard --
    // the very first send is still held open throughout.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      sendCalls.length,
      1,
      "only the first tick's send must ever have started -- every later tick must have been skipped while it was still in flight",
    );
    releaseSend?.();
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    stop();
  }
});

/**
 * Round 924: isScheduledRuleDue deliberately keeps retrying a failed
 * attempt on every subsequent tick for the rest of the day (to recover
 * from a transient WhatsApp disconnect), but before this round's fix
 * there was no cap at all -- a destination that fails PERMANENTLY (wrong
 * number, blocked recipient) got hit again every single 60s tick,
 * forever. Fires the same due, failing rule many times across the same
 * UTC day and confirms it stops sending after
 * MAX_CONSECUTIVE_SCHEDULE_FAILURES_PER_DAY (5) real attempts, not every
 * tick -- then confirms a genuinely new UTC day gives it a fresh start.
 */
test("runScheduledAutomationsCheck stops retrying a scheduled rule after 5 consecutive failures the same day, and retries again fresh the next day", async () => {
  const { db } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase({ scheduleTimeUtc: "09:00", toNumber: "972501234567" }));

  const { manager, sendCalls } = createFakeWhatsApp({ connected: true, sendResult: { ok: false, error: "recipient not found" } });

  // Six ticks across the same day, each past the scheduled time -- a
  // real 60s-interval scheduler would fire on every one of these if
  // nothing capped it.
  for (const minute of ["09:00", "09:01", "09:02", "09:03", "09:04", "09:05"]) {
    await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, new Date(`2026-03-15T${minute}:00.000Z`));
  }

  assert.equal(sendCalls.length, 5, "must stop sending after the 5th consecutive failure, not keep retrying every tick");
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.lastStatus, "failed");

  // One more tick, still the same day -- must still be suppressed.
  await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, new Date("2026-03-15T09:06:00.000Z"));
  assert.equal(sendCalls.length, 5, "a later tick the same day must still be suppressed, not add a 6th attempt");

  // A genuinely new UTC day -- must get a fresh start, same as
  // isScheduledRuleDue's own "retry today, fresh tomorrow" contract.
  await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, new Date("2026-03-16T09:00:00.000Z"));
  assert.equal(sendCalls.length, 6, "a new day must retry again, not stay suppressed forever");
});

/**
 * Round 934: a WhatsApp disconnect (not a genuinely broken destination)
 * must never trip hasTooManyConsecutiveFailuresToday's cap -- that would
 * directly contradict isScheduledRuleDue's own documented guarantee of
 * recovering "even after the owner reconnects minutes later." Before
 * this round, 5 ticks landing during a disconnect tripped the cap
 * exactly like 5 genuine send failures would, and -- since the cap, once
 * tripped, suppresses every later tick before it can record a NEW run
 * that would change the window -- there was no way to recover the same
 * day even the instant WhatsApp reconnected.
 */
test("runScheduledAutomationsCheck still fires a scheduled rule the same day once WhatsApp reconnects, even after 5 consecutive disconnect-caused failures", async () => {
  const { db } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase({ scheduleTimeUtc: "09:00", toNumber: "972501234567" }));

  const sendCalls: { to: string; body: string }[] = [];
  let connected = false;
  const manager = {
    getStatus() {
      return { status: connected ? "connected" : "disconnected", qrDataUrl: null, phoneNumber: connected ? "972500000000" : null, error: null };
    },
    async sendMessage(_projectId: string, to: string, body: string) {
      sendCalls.push({ to, body });
      return { ok: true };
    },
  } as unknown as WhatsAppWebManager;

  // 5 consecutive ticks while WhatsApp is disconnected -- exactly as many
  // as the cap's own threshold, which a genuinely broken destination
  // would trip on.
  for (const minute of ["09:00", "09:01", "09:02", "09:03", "09:04"]) {
    await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, new Date(`2026-03-15T${minute}:00.000Z`));
  }
  assert.equal(sendCalls.length, 0, "no send should have been attempted while disconnected");
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.lastStatus, "failed");

  // The owner reconnects, and the next tick arrives -- still the same day.
  connected = true;
  await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, new Date("2026-03-15T09:05:00.000Z"));

  assert.equal(sendCalls.length, 1, "must actually attempt the send now that WhatsApp is connected again, not stay suppressed for the rest of the day");
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.lastStatus, "sent");
});

/**
 * Round 951: recordAutomationRun's own run-retention prune
 * (packages/db/src/automations.ts) used to cut a single top-20 window
 * across BOTH "WhatsApp is not connected" rows and genuine-failure rows
 * together. isScheduledRuleDue keeps a rule "due" on every single 60s
 * tick for the rest of the day after ANY failure, disconnect included --
 * so one ordinary, multi-tick outage (round 934's own "no auto-reconnect"
 * reality) can genuinely produce dozens of consecutive disconnect rows,
 * comfortably past that old single-bucket cap of 20. That volume alone
 * could evict an earlier GENUINE failure from the table entirely, before
 * a second genuine failure ever got the chance to join it in
 * hasTooManyConsecutiveFailuresToday's own lookback window -- silently
 * defeating the round-924 cap for the very ordinary real-world
 * combination of a permanently wrong destination plus a long outage.
 * Alternates one genuine connected failure with a 25-tick disconnect
 * burst (past the old single-bucket retention of 20) seven times over,
 * all within one UTC day, and confirms the cap still stops genuine send
 * attempts at exactly 5 -- not all 7.
 */
test("runScheduledAutomationsCheck's 5-per-day failure cap survives a long WhatsApp outage interleaved between genuine failures, not just a brief one", async () => {
  const { db } = setupProject();
  const rule = insertAutomationRule(db, scheduleRuleBase({ scheduleTimeUtc: "09:00", toNumber: "972501234567" }));

  let connected = true;
  const sendCalls: { to: string }[] = [];
  const manager = {
    getStatus() {
      return { status: connected ? "connected" : "disconnected", qrDataUrl: null, phoneNumber: connected ? "972500000000" : null, error: null };
    },
    async sendMessage(_projectId: string, to: string) {
      sendCalls.push({ to });
      return { ok: false, error: "recipient not found" };
    },
  } as unknown as WhatsAppWebManager;

  const startedAt = new Date("2026-03-15T09:00:00.000Z").getTime();
  let minute = 0;
  const tickAt = () => new Date(startedAt + minute * 60_000);

  for (let rep = 0; rep < 7; rep++) {
    connected = true;
    await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, tickAt());
    minute += 1;
    connected = false;
    for (let i = 0; i < 25; i++) {
      await runScheduledAutomationsCheck(db, manager, UNUSED_EMAIL_SENDER, tickAt());
      minute += 1;
    }
  }

  assert.equal(
    sendCalls.length,
    5,
    "a long disconnect burst interleaved between genuine failures must never let more than 5 real send attempts through in one day",
  );
});

/**
 * Round 1032: EMAIL_NOT_CONFIGURED_ERROR (no RESEND_API_KEY set for this
 * deployment, fireEmailAction's own check) is the exact send_email
 * sibling of WHATSAPP_NOT_CONNECTED_ERROR -- a deployment-level, not
 * per-rule, fault. Mirrors the WhatsApp reconnect test above exactly: 5
 * consecutive ticks while no EmailSender is configured must never trip
 * hasTooManyConsecutiveFailuresToday's cap, or the rule would stay stuck
 * for the rest of the day even once an admin adds the key minutes later.
 */
test("runScheduledAutomationsCheck still fires a scheduled send_email rule the same day once an EmailSender becomes configured, even after 5 consecutive not-configured failures", async () => {
  const { db } = setupProject();
  const rule = insertAutomationRule(
    db,
    scheduleRuleBase({ actionType: "send_email", toMode: "static", toEmail: "owner@example.com", emailSubject: "Daily report" }),
  );
  const manager = {} as WhatsAppWebManager;

  for (const minute of ["09:00", "09:01", "09:02", "09:03", "09:04"]) {
    await runScheduledAutomationsCheck(db, manager, createFakeEmailSender({ configured: false }), new Date(`2026-03-15T${minute}:00.000Z`));
  }
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.lastStatus, "failed");
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.lastError, EMAIL_NOT_CONFIGURED_ERROR);

  // RESEND_API_KEY gets configured, and the next tick arrives -- still the same day.
  const emailSender = createFakeEmailSender({ configured: true });
  await runScheduledAutomationsCheck(db, manager, emailSender, new Date("2026-03-15T09:05:00.000Z"));

  assert.equal(emailSender.sentTo.length, 1, "must actually attempt the send now that an EmailSender is configured, not stay suppressed for the rest of the day");
  assert.equal(getAutomationRule(db, "proj1", rule.id)!.lastStatus, "sent");
});

/**
 * Round 1032: mirrors the WhatsApp-outage retention test above exactly,
 * for EMAIL_NOT_CONFIGURED_ERROR's own identical flood risk -- without
 * its own retention bucket (recordAutomationRun, packages/db/src/
 * automations.ts), a long stretch of "not configured" rows could evict a
 * genuine failure (e.g. a bad toEmail on a different firing) from the
 * same catch-all bucket before hasTooManyConsecutiveFailuresToday's own
 * lookback ever saw it, silently defeating the round-924 cap.
 */
test("runScheduledAutomationsCheck's 5-per-day failure cap survives a long EmailSender-not-configured stretch interleaved between genuine failures, not just a brief one", async () => {
  const { db } = setupProject();
  const rule = insertAutomationRule(
    db,
    scheduleRuleBase({ actionType: "send_email", toMode: "static", toEmail: "owner@example.com", emailSubject: "Daily report" }),
  );
  const manager = {} as WhatsAppWebManager;
  const failingConfiguredSender = createFakeEmailSender({ failWith: new Error("Resend API request failed (500): internal error") });
  const notConfiguredSender = createFakeEmailSender({ configured: false });

  const startedAt = new Date("2026-03-15T09:00:00.000Z").getTime();
  let minute = 0;
  const tickAt = () => new Date(startedAt + minute * 60_000);

  for (let rep = 0; rep < 7; rep++) {
    await runScheduledAutomationsCheck(db, manager, failingConfiguredSender, tickAt());
    minute += 1;
    for (let i = 0; i < 25; i++) {
      await runScheduledAutomationsCheck(db, manager, notConfiguredSender, tickAt());
      minute += 1;
    }
  }

  const runs = listAutomationRuns(db, "proj1", rule.id, 1000);
  const genuineFailures = runs.filter((r) => r.error !== EMAIL_NOT_CONFIGURED_ERROR);
  assert.equal(
    genuineFailures.length,
    5,
    "a long not-configured stretch interleaved between genuine failures must never let more than 5 genuine attempts through in one day",
  );
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
 * Round 899: 100.64.0.0/10 (RFC 6598's shared/CGNAT address space) was
 * entirely open before this fix, despite hosting Alibaba Cloud's own
 * instance-metadata endpoint at 100.100.100.200 -- the Alibaba-cloud
 * equivalent of the AWS/GCP/Azure 169.254.169.254 metadata IP this guard
 * already blocks. Any project collaborator could point an Automation
 * Rule's webhook at it and fireWebhookAction would actually POST there.
 */
test("isAllowedWebhookUrl blocks the 100.64.0.0/10 shared address space (CGNAT), including Alibaba Cloud's instance-metadata IP", () => {
  assert.equal(isAllowedWebhookUrl("http://100.100.100.200/latest/meta-data/"), false, "Alibaba Cloud's instance-metadata IP specifically must be blocked");
  assert.equal(isAllowedWebhookUrl("http://100.64.0.0/abc"), false, "the bottom edge of the real 100.64.0.0/10 range must be blocked");
  assert.equal(isAllowedWebhookUrl("http://100.64.0.1/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://100.100.0.1/abc"), false);
  assert.equal(isAllowedWebhookUrl("http://100.127.255.255/abc"), false, "the top edge of the real 100.64.0.0/10 range must be blocked");
  // Just outside the real range on either side is genuinely public and
  // must not be blocked.
  assert.equal(isAllowedWebhookUrl("http://100.63.255.255/abc"), true, "just below the real 100.64.0.0/10 range, this is not shared address space");
  assert.equal(isAllowedWebhookUrl("http://100.128.0.0/abc"), true, "just above the real 100.64.0.0/10 range, this is not shared address space");
  // A public hostname merely starting with the same digits must not be
  // wrongly blocked (same false-positive guard as the other ranges above).
  assert.equal(isAllowedWebhookUrl("https://100.example.com/webhook"), true, "a public hostname starting with '100.' is not shared address space");
  assert.equal(isAllowedWebhookUrl("https://100.64.example.com/webhook"), true, "a public hostname starting with '100.64.' is not shared address space");
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
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
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, undefined, "no webhookSecret was configured -- no Authorization header at all");
});

/**
 * Round 1207: fireRule's own WhatsApp branch already re-checks the project
 * still exists after its own genuine network await (see its own comment,
 * a few hundred lines up), to guard against deleteProject's synchronous
 * deleteAutomationRulesForProject (which removes every automation_runs row
 * for the project) finishing WHILE this exact fetch is still in flight --
 * without the same guard here, recordAutomationRun would resurrect a
 * permanently orphaned row for a project id automation_runs' own lack of
 * any foreign key/cascade can never clean up on its own. The real
 * deletion happens from inside the mocked fetch itself, so it genuinely
 * races the awaited call the production code is actually suspended on,
 * not a contrived ordering.
 */
test("runAutomationsForRecordChange's webhook action never resurrects an automation_runs row for a project deleted while the webhook request was in flight", async () => {
  const { db, project } = setupProject();
  // deleteProject itself also touches checkpoints/project_collaborators
  // (both plain DELETEs, no IF EXISTS) -- setupProject's own table set
  // doesn't include them since no other existing test here ever needed
  // to actually call deleteProject.
  ensureCheckpointsTable(db);
  ensureProjectCollaboratorsTable(db);
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
  globalThis.fetch = (async () => {
    deleteProject(db, project.id);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(listAutomationRuns(db, project.id, rule.id, 10).length, 0, "no run row must exist for a project that was deleted while this exact request was still in flight");
});

/**
 * Round 1165: before this round, the webhook payload carried no ruleId and
 * no per-delivery id at all -- this feature's own doc comments advertise
 * compatibility with "Zapier, Slack, Make, or any other system", every one
 * of which documents itself as expecting a stable delivery id precisely so
 * the receiver can correlate (and eventually deduplicate) a specific
 * attempt. Confirms the payload's own deliveryId is exactly the id the
 * resulting automation_runs row actually got -- not merely present, but
 * genuinely the same identifier a receiver could use to look that exact
 * attempt up again later (e.g. via GET .../runs) -- and that ruleId
 * identifies which configured rule fired it (useful when one destination
 * URL receives payloads from more than one rule/project).
 */
test("runAutomationsForRecordChange's webhook payload carries a ruleId and a deliveryId that exactly matches the resulting automation_runs row's own id", async () => {
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const payload = JSON.parse(calls[0]!.init.body as string);
  assert.equal(payload.ruleId, rule.id);
  assert.equal(typeof payload.deliveryId, "string");
  assert.ok(payload.deliveryId.length > 0);

  const [run] = listAutomationRuns(db, project.id, rule.id, 1);
  assert.equal(run!.id, payload.deliveryId, "the payload's own deliveryId must be the exact id this attempt's automation_runs row got, not an unrelated value");
});

/**
 * Round 1165: a manual Retry (POST .../runs/:runId/retry) re-invokes this
 * exact same fireRule/fireWebhookAction logic against the same rule and
 * record (see routes/projects.ts's own doc comment on that route) --
 * simulated here by calling runAutomationsForRecordChange twice in a row
 * against the identical record, the same way the real create-then-retry
 * flow fires this function's underlying logic twice. Confirms the retry's
 * own deliveryId is genuinely distinct from the original attempt's, since
 * each is tracked as its own separate automation_runs row (round 971) --
 * reusing the original's id here would collide with that row's own
 * primary key, so a fresh id per attempt is the only option that doesn't
 * corrupt the run history the Retry feature itself depends on.
 */
test("runAutomationsForRecordChange's webhook payload gets a genuinely different deliveryId on a second (retry-like) fire against the same rule and record", async () => {
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  const firstPayload = JSON.parse(calls[0]!.init.body as string);
  const secondPayload = JSON.parse(calls[1]!.init.body as string);
  assert.notEqual(firstPayload.deliveryId, secondPayload.deliveryId);
  assert.equal(firstPayload.ruleId, secondPayload.ruleId, "both attempts fired the same rule, so ruleId itself must stay identical across them");

  const runs = listAutomationRuns(db, project.id, rule.id, 10);
  assert.equal(runs.length, 2, "each attempt must be tracked as its own distinct run row, never collapsed or overwritten");
  assert.notEqual(runs[0]!.id, runs[1]!.id);
});

/**
 * Round 974: before this round, fireWebhookAction's outbound request carried
 * no auth of any kind -- every real destination that requires one (bearer
 * token, HMAC signature header) would simply reject it. Confirms a rule
 * with `webhookSecret` set actually sends it as a real `Authorization:
 * Bearer <secret>` header on the real outbound request.
 */
test("runAutomationsForRecordChange sends the rule's webhookSecret as an Authorization: Bearer header when configured", async () => {
  const { db, project } = setupProject();
  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    webhookSecret: "s3cr3t-token",
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer s3cr3t-token");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "application/json", "the existing content-type header must still be sent");
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, entityWithInvoice, "created", record, new Set(), UNUSED_UPLOADS_DIR, "https://forge-ai-m7p7.onrender.com");
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

/**
 * Round 916's finding: coerceValue (packages/db/src/repository.ts, round
 * 908) rejects a file-field url outside this server's own upload-route
 * shape only at WRITE time -- it never retroactively sanitizes a row
 * written before that guard existed. `new URL(parsed.url, baseUrl)`
 * silently ignores `baseUrl` whenever `parsed.url` is itself absolute
 * (has its own scheme), so a pre-908 "javascript:"/attacker-controlled
 * descriptor passed straight through, verbatim, into this webhook's own
 * JSON payload -- the one read sink round 908's own entityFormatting.ts/
 * codegen.ts scheme-check sweep missed. Confirms the descriptor is left
 * untouched (the same "malformed -> leave as-is" convention the test
 * just above already covers), not resolved into a followable url, while
 * a genuine relative upload path still resolves correctly.
 */
test("resolveFileFieldsForWebhook never resolves a scripted-scheme or attacker-controlled absolute url -- new URL() would silently ignore baseUrl for it", () => {
  const entityWithInvoice: Entity = {
    ...orderEntity,
    fields: [...orderEntity.fields, { name: "invoice", type: "file", required: false }],
  };

  const scriptedRecord = {
    customerName: "Dana",
    invoice: JSON.stringify({ url: "javascript:alert(document.cookie)", name: "invoice.pdf", size: 1, mimeType: "application/pdf" }),
  };
  assert.deepEqual(
    resolveFileFieldsForWebhook(entityWithInvoice, scriptedRecord, "https://example.com"),
    scriptedRecord,
    "a javascript: url must be left untouched, not passed through into the webhook payload",
  );

  const absoluteRecord = {
    customerName: "Dana",
    invoice: JSON.stringify({ url: "https://attacker.example/steal", name: "invoice.pdf", size: 1, mimeType: "application/pdf" }),
  };
  assert.deepEqual(
    resolveFileFieldsForWebhook(entityWithInvoice, absoluteRecord, "https://example.com"),
    absoluteRecord,
    "an attacker-controlled absolute url must be left untouched too -- new URL() would otherwise ignore baseUrl entirely for it",
  );

  const realRecord = {
    customerName: "Dana",
    invoice: JSON.stringify({ url: "/api/uploads/proj1/Order/abc123.pdf", name: "invoice.pdf", size: 1, mimeType: "application/pdf" }),
  };
  assert.deepEqual(resolveFileFieldsForWebhook(entityWithInvoice, realRecord, "https://example.com"), {
    customerName: "Dana",
    invoice: { url: "https://example.com/api/uploads/proj1/Order/abc123.pdf", name: "invoice.pdf", size: 1, mimeType: "application/pdf" },
  });
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /500/);
});

/**
 * Round 859: isAllowedWebhookUrl only ever validates rule.webhookUrl
 * itself, once, before the fetch -- without redirect: "manual", Node's
 * own fetch (undici) silently follows up to 20 redirects, re-requesting
 * whatever Location a 3xx response names with NO re-validation against
 * that guard at all. An attacker only needs to control (or compromise)
 * any ordinary public HTTP(S) endpoint -- trivially passing the hostname
 * check -- then respond to the POST with a redirect to the cloud
 * instance-metadata address (169.254.169.254) or any other blocked
 * target, defeating every bit of isAllowedWebhookUrl's hardening in one
 * hop. This is the single most common real-world SSRF bypass technique,
 * strictly easier than the DNS-rebinding attack that function's own
 * comment already discloses as out of scope. Confirms the actual wiring
 * at the real call site: fetch is invoked with redirect: "manual".
 */
test("runAutomationsForRecordChange's webhook fetch call passes redirect: \"manual\", so a malicious redirect target is never silently followed", async () => {
  const { db, project } = setupProject();
  insertAutomationRule(db, {
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
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.redirect, "manual", "the webhook fetch must never silently follow a redirect -- isAllowedWebhookUrl is never re-checked against a redirect target");
});

/**
 * Round 859: a real redirect response, with redirect: "manual" in effect
 * (confirmed empirically against Node's own undici: status/ok reflect
 * the 3xx response itself, not an opaque browser-only type), is a
 * perfectly ordinary non-2xx Response as far as this function's own
 * res.ok check is concerned -- so no separate branch is needed to reject
 * it; it already falls into the exact same "failed" path the 500 case
 * above does. This confirms that path specifically for a 3xx, so a
 * redirect is reported as a failure (never silently treated as success)
 * even though the earlier test only checks the request's own options.
 */
test("runAutomationsForRecordChange records a failed outcome when the (unfollowed, thanks to redirect: \"manual\") webhook response is itself a redirect, not success", async () => {
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
  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /302/);
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastError ?? "", /network down/);
});

/**
 * Round 1327: unlike the "network down" test above, where fetch rejects
 * immediately with its own real error, this one simulates a destination
 * that simply never responds -- the real failure mode fireWebhookAction's
 * own 10s AbortController timeout exists to bound. The fake fetch below
 * never resolves on its own, only reacting to the signal being aborted
 * (the same pattern email.test.ts's identical ResendEmailSender timeout
 * test already uses), confirming the stored error is the clear, stable
 * "Webhook request timed out after 10000ms" message fireWebhookAction's
 * own catch block now special-cases -- not fetch/undici's generic,
 * untranslatable AbortError text that used to leak straight through.
 */
test("runAutomationsForRecordChange records a clear 'timed out' message, not fetch's raw AbortError text, when the webhook destination hangs past its own timeout", async () => {
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
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof fetch;
  try {
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
  assert.equal(after.lastError, "Webhook request timed out after 10000ms");
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
    await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false, "a blocked host must never actually be fetched");
  const after = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(after.lastStatus, "failed");
});

/**
 * Round 1076: mirrors whatsappWeb.test.ts's own round-794 test for
 * sendMessage's sendQueue (and this round's own identical fix ported to
 * email.ts in round 1073) -- EntityPanel.tsx's bulk-update "Apply to N"
 * can fire many concurrent PATCH requests, each independently triggering
 * a matching webhook automation rule pointed at the SAME destination URL
 * (e.g. the same Slack/Zapier endpoint), all calling fetch at once.
 * Before this round, nothing serialized them -- they all raced the
 * destination's own API in the same instant, a real burst pattern that
 * routinely exceeds a webhook destination's own rate limit (Slack's
 * Incoming Webhooks allow roughly one message per second per channel) and
 * comes back 429/5xx, silently dropping the notification (a record-
 * triggered rule gets exactly one delivery attempt, per round 971's own
 * doc comment). Uses fireScheduledRule directly (rather than
 * runAutomationsForRecordChange, whose own rule loop already awaits each
 * rule sequentially) to fire multiple INDEPENDENT rules concurrently,
 * mirroring the real concurrency shape -- N separate requests, each
 * firing its own automation check. The fake fetch here holds its own
 * response open for a few milliseconds (unlike every other webhook test
 * in this file, which resolves instantly and so could never actually
 * observe an overlap) so a real concurrency violation would be caught
 * instead of coincidentally passing.
 */
test("fireScheduledRule's webhook action serializes concurrent sends to the SAME destination URL so it never sees two requests in flight at once", async () => {
  const { db, project } = setupProject();
  const makeRule = (messageTemplate: string) =>
    insertAutomationRule(db, {
      projectId: project.id,
      entityName: "Order",
      trigger: "schedule",
      scheduleTimeUtc: "09:00",
      actionType: "webhook",
      webhookUrl: "https://hooks.example.com/forge",
      toMode: "static",
      messageTemplate,
    });
  const ruleA = makeRule("one");
  const ruleB = makeRule("two");
  const ruleC = makeRule("three");

  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(JSON.parse(init!.body as string).message);
    active--;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await Promise.all([
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleA),
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleB),
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleC),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(maxActive, 1, "the destination URL must never see two webhook requests in flight at the same time");
  assert.deepEqual(order, ["one", "two", "three"], "sends must go out in call order, one at a time, not interleaved");
});

/**
 * Same mechanism, the other half: serializing sends for ONE destination
 * URL must never block a completely unrelated destination's own sends
 * behind it -- webhookSendQueue is keyed by webhookUrl precisely so two
 * rules pointed at different destinations stay fully independent, the
 * same reasoning whatsappWeb.test.ts's own per-project independence test
 * already covers for WhatsApp.
 */
test("fireScheduledRule's webhook action for one destination URL does not wait behind a slow in-flight send for a different destination URL", async () => {
  const { db, project } = setupProject();
  const slowRule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "schedule",
    scheduleTimeUtc: "09:00",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/slow",
    toMode: "static",
    messageTemplate: "slow",
  });
  const fastRule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "schedule",
    scheduleTimeUtc: "09:00",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/fast",
    toMode: "static",
    messageTemplate: "fast",
  });

  const order: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "https://hooks.example.com/slow") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    order.push(url);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await Promise.all([
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, slowRule),
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, fastRule),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(order, ["https://hooks.example.com/fast", "https://hooks.example.com/slow"], "the fast destination must complete first, never waiting behind the slow one");
});

/**
 * A failed send (the destination returning a non-2xx) must not jam the
 * queue for that URL -- the next queued send to the SAME URL still goes
 * out, mirroring whatsappWeb.ts's own identical "a failed send doesn't
 * block the queue" guarantee (the `.catch(() => {})` on the queue-
 * advancing chain, distinct from the rejection/failed-run recording the
 * failed call's own caller still sees).
 */
test("a failed webhook send to a URL still records failed for its own rule, but does not block the next queued send to the SAME URL", async () => {
  const { db, project } = setupProject();
  const makeRule = (messageTemplate: string) =>
    insertAutomationRule(db, {
      projectId: project.id,
      entityName: "Order",
      trigger: "schedule",
      scheduleTimeUtc: "09:00",
      actionType: "webhook",
      webhookUrl: "https://hooks.example.com/forge",
      toMode: "static",
      messageTemplate,
    });
  const ruleA = makeRule("one");
  const ruleB = makeRule("two");

  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) return new Response(null, { status: 500 });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await Promise.all([
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleA),
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleB),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(getAutomationRule(db, project.id, ruleA.id)!.lastStatus, "failed");
  assert.equal(getAutomationRule(db, project.id, ruleB.id)!.lastStatus, "sent", "the second rule's own send to the same URL must still go through, not be jammed by the first one's failure");
});

/**
 * Round 1096: the test above covers a destination returning a non-2xx
 * Response (fetch itself still resolves, so queuedFetch's own `.then`
 * fulfillment handler -- and its spacing delay -- always ran). This
 * covers the distinct case the old queue-advancing chain
 * (`queuedFetch.then(() => delay(...)).catch(() => {})`) got wrong: a
 * REJECTING fetch (a real network failure, or fireWebhookAction's own
 * 10s AbortController timeout for a hanging destination) skipped the
 * `.then`'s fulfillment handler entirely, so WEBHOOK_SEND_SPACING_MS was
 * silently never applied right after exactly the kind of failure most
 * likely to recur on an immediate retry.
 */
test("a webhook send that REJECTS (network failure, not just a non-2xx response) still waits the full spacing delay before the next queued send to the same URL", async () => {
  const { db, project } = setupProject();
  const makeRule = (messageTemplate: string) =>
    insertAutomationRule(db, {
      projectId: project.id,
      entityName: "Order",
      trigger: "schedule",
      scheduleTimeUtc: "09:00",
      actionType: "webhook",
      webhookUrl: "https://hooks.example.com/forge-reject",
      toMode: "static",
      messageTemplate,
    });
  const ruleA = makeRule("one");
  const ruleB = makeRule("two");

  const callTimestamps: number[] = [];
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    callTimestamps.push(Date.now());
    call++;
    if (call === 1) throw new Error("network error");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await Promise.allSettled([
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleA),
      fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, ruleB),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(callTimestamps.length, 2);
  assert.ok(
    callTimestamps[1] - callTimestamps[0] >= 550,
    `expected the full ~600ms spacing delay even after a rejecting fetch, got ${callTimestamps[1] - callTimestamps[0]}ms`,
  );
  assert.equal(getAutomationRule(db, project.id, ruleA.id)!.lastStatus, "failed");
  assert.equal(getAutomationRule(db, project.id, ruleB.id)!.lastStatus, "sent");
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
    await fireScheduledRule(db, {} as WhatsAppWebManager, UNUSED_EMAIL_SENDER, project, rule);
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

/**
 * Round 996: a controllable EmailSender double for the send_email action
 * tests below -- mirrors app.test.ts's own createFakeEmailSender (the
 * login-code tests' identical need), just local to this file since nothing
 * else here needs it.
 */
function createFakeEmailSender(opts?: { configured?: boolean; failWith?: Error }): EmailSender & {
  sentTo: { to: string; subject: string; text: string; attachments?: EmailAttachment[] }[];
} {
  const sentTo: { to: string; subject: string; text: string; attachments?: EmailAttachment[] }[] = [];
  return {
    configured: opts?.configured ?? true,
    sentTo,
    async send(to, subject, text, attachments) {
      if (opts?.failWith) throw opts.failWith;
      sentTo.push({ to, subject, text, attachments });
    },
  };
}

test("runAutomationsForRecordChange sends a 'send_email' rule's email to a static toEmail, interpolating both subject and body, and records a sent outcome", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "static",
    toEmail: "owner@example.com",
    emailSubject: "New order from {{customerName}}",
    messageTemplate: "Order status: {{status}}",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };
  const emailSender = createFakeEmailSender();

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(emailSender.sentTo.length, 1);
  assert.equal(emailSender.sentTo[0]!.to, "owner@example.com");
  assert.equal(emailSender.sentTo[0]!.subject, "New order from Dana Levi");
  assert.equal(emailSender.sentTo[0]!.text, "Order status: New");
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});

/**
 * Round 1207: the send_email sibling of the identical webhook-action test
 * above -- fireEmailAction's own await (a real Resend API round-trip) has
 * the same hazard fireRule's WhatsApp branch and fireWebhookAction above
 * both already guard against. The real deletion happens from inside the
 * fake sender's own send() call, genuinely racing the awaited call the
 * production code is actually suspended on.
 */
test("runAutomationsForRecordChange's send_email action never resurrects an automation_runs row for a project deleted while the email send was in flight", async () => {
  const { db, project } = setupProject();
  ensureCheckpointsTable(db);
  ensureProjectCollaboratorsTable(db);
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "static",
    toEmail: "owner@example.com",
    emailSubject: "New order from {{customerName}}",
    messageTemplate: "Order status: {{status}}",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };
  const emailSender: EmailSender = {
    configured: true,
    async send() {
      deleteProject(db, project.id);
    },
  };

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(listAutomationRuns(db, project.id, rule.id, 10).length, 0, "no run row must exist for a project that was deleted while this exact send was still in flight");
});

test("runAutomationsForRecordChange sends a 'send_email' rule's email to a toField-resolved destination when toMode is field", async () => {
  const { db, project } = setupProject();
  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "field",
    toField: "customerPhone",
    emailSubject: "Order update",
    messageTemplate: "Hi {{customerName}}!",
  });
  // customerPhone is just a plain text field -- reused here to hold an
  // email address, same as toNumber/toField's own existing convention of
  // not caring about a field's own name, only its type (text/longtext).
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "dana@example.com", status: "New" };
  const emailSender = createFakeEmailSender();

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(emailSender.sentTo.length, 1);
  assert.equal(emailSender.sentTo[0]!.to, "dana@example.com");
  assert.equal(emailSender.sentTo[0]!.text, "Hi Dana Levi!");
});

/**
 * Round 1188: the send_email sibling of the WhatsApp/field_equals test
 * above -- a toMode:"field" destination's own toField is likewise a
 * string persisted at rule-creation time, with the identical stale-casing
 * gap after a live case-only field rename (see that test's own doc
 * comment for the full chain).
 */
test("runAutomationsForRecordChange still resolves a 'send_email' rule's toField destination after the entity's field was renamed only by letter case", async () => {
  const { db, project } = setupProject();
  insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "field",
    toField: "customerPhone", // stored at rule-creation time, lowercase "p"
    emailSubject: "Order update",
    messageTemplate: "Hi {{customerName}}!",
  });
  // Simulates the entity AFTER a live refine recased "customerPhone" to
  // "CustomerPhone" (same type, same position).
  const renamedEntity: Entity = {
    ...orderEntity,
    fields: orderEntity.fields.map((f) => (f.name === "customerPhone" ? { ...f, name: "CustomerPhone" } : f)),
  };
  // Reused here to hold an email address, same as the pre-existing test
  // above's own convention of not caring about a field's own name.
  const record = { id: 1, customerName: "Dana Levi", CustomerPhone: "dana@example.com", status: "New" };
  const emailSender = createFakeEmailSender();

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, renamedEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(emailSender.sentTo.length, 1, "the email must still be sent even though toField is the field's OLD casing");
  assert.equal(emailSender.sentTo[0]!.to, "dana@example.com");
});

/**
 * Regression test for a real bug found by round 1080's Explore survey: a
 * toMode:"static" destination is validated at rule-creation time by
 * CreateAutomationRuleSchema's own z.string().email() (routes/projects.ts),
 * but a toMode:"field" destination's value is only known per-record at
 * send time, so it never passes through that schema at all -- unlike the
 * WhatsApp sibling action (whatsappWeb.ts's own sendMessage normalizePhone/
 * leading-zero checks, see its doc comment), fireEmailAction only ever
 * checked that the resolved value was a non-empty string, so a field
 * picked off a record that doesn't actually hold an email address (an easy
 * mis-pick: AutomationsPanel.tsx's toField dropdown for both WhatsApp and
 * email shares the exact same type-only-filtered field list, with nothing
 * distinguishing "looks like an email" from "looks like a phone number")
 * was POSTed straight to Resend's API as-is.
 */
test("runAutomationsForRecordChange records a failed outcome, never calls send, when a 'send_email' rule's toField-resolved value isn't a valid email address", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "field",
    toField: "customerPhone",
    emailSubject: "Order update",
    messageTemplate: "Hi {{customerName}}!",
  });
  // customerPhone holds an ordinary phone number here, not an email address
  // -- exactly the mis-pick scenario the WhatsApp/email toField dropdowns'
  // shared, unfiltered field list makes easy to reach.
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };
  const emailSender = createFakeEmailSender();

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(emailSender.sentTo.length, 0, "Resend's API must never be called with a non-email destination");
  const updated = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(updated.lastStatus, "failed");
  assert.equal(updated.lastError, "invalid_email_address");
});

test("runAutomationsForRecordChange records a failed outcome, never calls send, when a 'send_email' rule has no destination email configured", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "static",
    emailSubject: "Subject",
    messageTemplate: "Body",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };
  const emailSender = createFakeEmailSender();

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(emailSender.sentTo.length, 0);
  const updated = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(updated.lastStatus, "failed");
  assert.match(updated.lastError ?? "", /no destination email address/);
});

test("runAutomationsForRecordChange records a failed outcome, never calls send, when no EmailSender is configured for this deployment", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "static",
    toEmail: "owner@example.com",
    emailSubject: "Subject",
    messageTemplate: "Body",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };
  const emailSender = createFakeEmailSender({ configured: false });

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  assert.equal(emailSender.sentTo.length, 0);
  const updated = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(updated.lastStatus, "failed");
  assert.match(updated.lastError ?? "", /not configured/);
});

test("runAutomationsForRecordChange records a failed outcome with the real error message when EmailSender.send() itself throws, without throwing", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "record_created",
    actionType: "send_email",
    toMode: "static",
    toEmail: "owner@example.com",
    emailSubject: "Subject",
    messageTemplate: "Body",
  });
  const record = { id: 1, customerName: "Dana Levi", customerPhone: "972501234567", status: "New" };
  const emailSender = createFakeEmailSender({ failWith: new Error("Resend API request failed (401): invalid api key") });

  await runAutomationsForRecordChange(db, {} as WhatsAppWebManager, emailSender, project, orderEntity, "created", record, new Set(), UNUSED_UPLOADS_DIR, UNUSED_BASE_URL);

  const updated = getAutomationRule(db, project.id, rule.id)!;
  assert.equal(updated.lastStatus, "failed");
  assert.equal(updated.lastError, "Resend API request failed (401): invalid api key");
});

test("fireScheduledRule's send_email action sends messageTemplate/emailSubject verbatim with no record to interpolate from", async () => {
  const { db, project } = setupProject();
  const rule = insertAutomationRule(db, {
    projectId: project.id,
    entityName: "Order",
    trigger: "schedule",
    scheduleTimeUtc: "09:00",
    actionType: "send_email",
    toMode: "static",
    toEmail: "owner@example.com",
    emailSubject: "Daily report {{anything}}",
    messageTemplate: "Good morning! {{anything}}",
  });
  const emailSender = createFakeEmailSender();

  await fireScheduledRule(db, {} as WhatsAppWebManager, emailSender, project, rule);

  assert.equal(emailSender.sentTo.length, 1);
  assert.equal(emailSender.sentTo[0]!.to, "owner@example.com");
  assert.equal(emailSender.sentTo[0]!.subject, "Daily report {{anything}}", "no record to interpolate {{anything}} from, so it must be left exactly as typed");
  assert.equal(emailSender.sentTo[0]!.text, "Good morning! {{anything}}");
  assert.equal(getAutomationRule(db, project.id, rule.id)!.lastStatus, "sent");
});
