import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import {
  computeChangedFields,
  decodeMojibakeFilename,
  deriveEntityName,
  deriveFieldName,
  deriveName,
  deriveScreensForNewEntity,
  findAutomationRuleInvariantViolation,
} from "./projects.js";

/**
 * deriveName picks a project's display name from its free-text description
 * whenever the client doesn't supply an explicit `name` (see the `name ??
 * deriveName(description)` call in the POST /projects handler). Every
 * existing test that creates a project either passes an explicit name or a
 * normal multi-word description and never reads back `project.name` at all
 * -- so neither the 6-word truncation nor the empty-input fallback has ever
 * actually been exercised.
 */
test("deriveName joins a short description's words unchanged", () => {
  assert.equal(deriveName("A simple todo app"), "A simple todo app");
});

test("deriveName truncates a description to its first 6 words", () => {
  const description =
    "Build an appointment-management application for a beauty clinic with reminders";
  assert.equal(deriveName(description), "Build an appointment-management application for a");
});

test("deriveName collapses internal newlines/multiple spaces like a single space when counting words", () => {
  assert.equal(deriveName("Build   an\napp  for   dog   walkers  please"), "Build an app for dog walkers");
});

/**
 * A description that is technically non-empty (so it passes the API's own
 * z.string().min(1) validation, which counts raw length before any
 * trimming) but contains no actual words -- e.g. a client that sent pure
 * whitespace -- must not produce an empty or whitespace-only project name.
 */
test("deriveName falls back to 'Untitled Project' for a whitespace-only description", () => {
  assert.equal(deriveName("   "), "Untitled Project");
  assert.equal(deriveName("\n\t "), "Untitled Project");
});

test("deriveName falls back to 'Untitled Project' for a genuinely empty description", () => {
  assert.equal(deriveName(""), "Untitled Project");
});

/**
 * deriveEntityName turns a free-text label typed into AddEntityForm into a
 * valid ASCII entity `name` -- the value both packages/db/src/migrate.ts and
 * apps/api/src/codegen.ts use directly as a SQL table name, so it can't be
 * empty, can't contain spaces/punctuation, and can't collide (even
 * case-insensitively) with an existing entity in the same spec.
 */
test("deriveEntityName title-cases and joins multi-word labels with no separator", () => {
  assert.equal(deriveEntityName("Loyalty Program", []), "LoyaltyProgram");
  assert.equal(deriveEntityName("loyalty-program", []), "LoyaltyProgram");
  assert.equal(deriveEntityName("payment", []), "Payment");
});

test("deriveEntityName falls back to 'Entity' when the label has no ASCII letters/digits at all", () => {
  assert.equal(deriveEntityName("תוכנית נאמנות", []), "Entity");
});

test("deriveEntityName appends the first free numeric suffix on a case-insensitive collision", () => {
  assert.equal(deriveEntityName("Payment", ["Customer"]), "Payment");
  assert.equal(deriveEntityName("Payment", ["Customer", "Payment"]), "Payment2");
  assert.equal(deriveEntityName("payment", ["Customer", "Payment"]), "Payment2");
  assert.equal(deriveEntityName("Payment", ["Payment", "Payment2"]), "Payment3");
});

/**
 * Round 555: unlike deriveFieldName's own numeral-led guard (round 549),
 * deriveEntityName had none -- "2024 Sales" joined to "2024Sales", which
 * passes EntitySchema and builds fine in the live preview (tableNameFor's
 * permanent "entity_" prefix hides the leading digit there), but fails
 * codegen.ts's assertSafe the moment the project is exported, since the
 * exported app uses entity.name directly with no such prefix.
 */
test("deriveEntityName prefixes a numeral-led label so the result never starts with a digit", () => {
  assert.equal(deriveEntityName("2024 Sales", []), "Entity2024Sales");
  assert.equal(deriveEntityName("2024", []), "Entity2024");
  assert.equal(deriveEntityName("3rd Party Vendors", []), "Entity3rdPartyVendors");
});

/**
 * deriveScreensForNewEntity is the entity-add route's own counterpart fix
 * for round 553: without it, a manually-added entity got zero spec.screens
 * entries, permanently undercounting the "N screens" HistoryPanel.tsx/
 * checkpointDiff.ts show for that project's initial-build checkpoint.
 * There's no single universal screens shape across this app's three spec
 * producers (heuristic.ts's List+Form per entity, templates.ts's List-only,
 * or an AI-generated project's own arbitrary shape), so this mirrors
 * whichever existing entity's own screens come last in the entities array.
 */
test("deriveScreensForNewEntity mirrors the last entity's own List+Form screens (heuristic.ts's shape)", () => {
  const entities = [{ name: "Customer", label: "Customer", fields: [] }, { name: "Deal", label: "Deal", fields: [] }];
  const screens = [
    { name: "Dashboard", type: "dashboard" as const },
    { name: "Customer List", type: "list" as const, entity: "Customer" },
    { name: "Customer Form", type: "form" as const, entity: "Customer" },
    { name: "Deal List", type: "list" as const, entity: "Deal" },
    { name: "Deal Form", type: "form" as const, entity: "Deal" },
  ];
  assert.deepEqual(deriveScreensForNewEntity("Invoice", entities, screens), [
    { name: "Invoice List", type: "list", entity: "Invoice" },
    { name: "Invoice Form", type: "form", entity: "Invoice" },
  ]);
});

test("deriveScreensForNewEntity mirrors a List-only shape (templates.ts's shape) instead of always assuming List+Form", () => {
  const entities = [{ name: "Customer", label: "Customer", fields: [] }];
  const screens = [
    { name: "Dashboard", type: "dashboard" as const },
    { name: "Customer", type: "list" as const, entity: "Customer" },
  ];
  assert.deepEqual(deriveScreensForNewEntity("Invoice", entities, screens), [{ name: "Invoice", type: "list", entity: "Invoice" }]);
});

/**
 * Round 1031: this fallback used to emit a single plain List screen --
 * templates.ts's own pre-round-1028 minimal shape. Now that every real
 * generator (heuristic.ts, templates.ts, and anthropic.ts as of this same
 * round) deterministically produces a List+Form pair per entity, a
 * List-only fallback here was the one place left assuming the old,
 * now-abandoned convention.
 */
test("deriveScreensForNewEntity falls back to a List+Form pair when no existing entity has any tagged screens", () => {
  const entities = [{ name: "Customer", label: "Customer", fields: [] }];
  const screens = [{ name: "Dashboard", type: "dashboard" as const }];
  assert.deepEqual(deriveScreensForNewEntity("Invoice", entities, screens), [
    { name: "Invoice List", type: "list", entity: "Invoice" },
    { name: "Invoice Form", type: "form", entity: "Invoice" },
  ]);
});

/**
 * deriveFieldName is deriveEntityName's own counterpart for AddFieldForm --
 * same ASCII-identifier, no-collision requirements (it becomes a real SQL
 * column name in both packages/db/src/migrate.ts and apps/api/src/codegen.ts),
 * just camelCase instead of PascalCase, matching every existing domain-
 * library field's own convention (domainEntities.ts's "customerName",
 * "courierId", etc).
 */
test("deriveFieldName camelCases multi-word labels with no separator", () => {
  assert.equal(deriveFieldName("Phone Number", []), "phoneNumber");
  assert.equal(deriveFieldName("phone-number", []), "phoneNumber");
  assert.equal(deriveFieldName("Email", []), "email");
});

test("deriveFieldName falls back to 'field' when the label has no ASCII letters/digits at all", () => {
  assert.equal(deriveFieldName("מספר טלפון", []), "field");
});

/**
 * Regression test for round 549's finding: a numeral-led label joins to a
 * name that starts with a digit ("2024Sales"), which FieldSchema accepts
 * (no identifier-shape guard) but packages/db/src/identifiers.ts's
 * SAFE_IDENTIFIER (requires a leading letter) rejects at real build time --
 * a field that looked accepted when added then crashes the build with a
 * raw "Unsafe column identifier" error. Prefixing with "field" (the same
 * fallback word the "no ASCII letters at all" case above already uses)
 * guarantees a leading letter, the same protection entity names get for
 * free from tableNameFor's permanent "entity_" prefix.
 */
test("deriveFieldName prefixes a numeral-led label so the result never starts with a digit", () => {
  assert.equal(deriveFieldName("2024 Sales", []), "field2024Sales");
  assert.equal(deriveFieldName("2024", []), "field2024");
  assert.equal(deriveFieldName("3rd Quarter", []), "field3rdQuarter");
});

test("deriveFieldName appends the first free numeric suffix on a case-insensitive collision with an existing field on the same entity", () => {
  assert.equal(deriveFieldName("Phone", ["name"]), "phone");
  assert.equal(deriveFieldName("Phone", ["name", "phone"]), "phone2");
  assert.equal(deriveFieldName("phone", ["name", "phone"]), "phone2");
  assert.equal(deriveFieldName("Phone", ["phone", "phone2"]), "phone3");
});

/**
 * A field named "id" or "createdAt" (in any casing) collides with the two
 * built-in columns every table already has (see FieldSchema's own
 * RESERVED_FIELD_NAMES check in @forge/shared) -- without this, a label
 * like "Id" or "Created At" would hand FieldSchema's refine() a name it
 * rejects, crashing updateProjectSpec's re-read with an uncaught schema
 * error instead of just picking a free name the same way a real collision
 * with another field on the entity does.
 */
test("deriveFieldName treats the built-in 'id'/'createdAt' column names as already taken", () => {
  assert.equal(deriveFieldName("Id", []), "id2");
  assert.equal(deriveFieldName("Created At", []), "createdAt2");
});

/**
 * computeChangedFields backs the PATCH record route's "changed fields" set
 * passed to runAutomationsForRecordChange. Before this fix the route used
 * `new Set(Object.keys(req.body))` -- which EntityPanel.tsx's main edit
 * form (and the exported app's own equivalent) always fully populates with
 * every field on every save, not just the ones the user actually touched.
 * That made a field_equals automation (e.g. "when status becomes
 * Delivered, text the customer") re-fire on every later unrelated edit to
 * an already-matching record, since "status" was always present in the
 * body even though its value never changed. computeChangedFields instead
 * compares the real pre- and post-update field values, so only a field
 * whose value actually transitioned counts as "changed" -- regardless of
 * what keys the request body happened to include.
 */
const order: Entity = {
  name: "Order",
  label: "Order",
  fields: [
    { name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Delivered"] },
    { name: "notes", label: "Notes", type: "text", required: false },
  ],
};

test("computeChangedFields excludes a field whose value is resubmitted unchanged", () => {
  const before = { id: 1, createdAt: "2026-01-01", status: "Delivered", notes: "old" };
  // The full-form resubmit case: every field is present in `after`, but
  // only "notes" actually differs from `before`.
  const after = { id: 1, createdAt: "2026-01-01", status: "Delivered", notes: "new" };
  assert.deepEqual(computeChangedFields(order, before, after), new Set(["notes"]));
});

test("computeChangedFields includes a field that genuinely transitioned value", () => {
  const before = { id: 1, createdAt: "2026-01-01", status: "New", notes: "old" };
  const after = { id: 1, createdAt: "2026-01-01", status: "Delivered", notes: "old" };
  assert.deepEqual(computeChangedFields(order, before, after), new Set(["status"]));
});

test("computeChangedFields returns every field when there is no prior record to compare against", () => {
  const after = { id: 1, createdAt: "2026-01-01", status: "New", notes: "" };
  assert.deepEqual(computeChangedFields(order, undefined, after), new Set(["status", "notes"]));
});

test("computeChangedFields returns an empty set when nothing actually changed", () => {
  const before = { id: 1, createdAt: "2026-01-01", status: "Delivered", notes: "same" };
  const after = { id: 1, createdAt: "2026-01-01", status: "Delivered", notes: "same" };
  assert.deepEqual(computeChangedFields(order, before, after), new Set());
});

/**
 * findAutomationRuleInvariantViolation backs the PATCH automation-rule
 * route's validation of the MERGED result (existing rule + patch), not
 * just the patch in isolation -- CreateAutomationRuleSchema already
 * enforces these same three invariants with zod .refine() on create, but
 * UpdateAutomationRuleSchema's fields are all .optional() (a PATCH only
 * sends what it's changing), so there's no single static shape a zod
 * .refine() can run against; a PATCH that only sends `{"toMode":"field"}`
 * on a rule created with toMode:"static" (so toField is still null) used
 * to save silently without ever checking the two together.
 */
const recordCreatedRule = {
  trigger: "record_created" as const,
  fieldName: null,
  fieldValue: null,
  scheduleTimeUtc: null,
  actionType: "send_whatsapp" as const,
  toMode: "static" as const,
  toNumber: "+15551234567",
  toField: null,
  webhookUrl: null,
};

test("findAutomationRuleInvariantViolation accepts a valid record_created + static-destination rule", () => {
  assert.equal(findAutomationRuleInvariantViolation(recordCreatedRule), null);
});

test("findAutomationRuleInvariantViolation accepts a valid field_equals + field-destination rule", () => {
  assert.equal(
    findAutomationRuleInvariantViolation({
      trigger: "field_equals",
      fieldName: "status",
      fieldValue: "Delivered",
      scheduleTimeUtc: null,
      actionType: "send_whatsapp",
      toMode: "field",
      toNumber: null,
      toField: "customerPhone",
      webhookUrl: null,
    }),
    null,
  );
});

test("findAutomationRuleInvariantViolation rejects field_equals with no fieldName/fieldValue", () => {
  assert.match(
    findAutomationRuleInvariantViolation({ ...recordCreatedRule, trigger: "field_equals" }) ?? "",
    /fieldName and fieldValue are required/,
  );
});

test("findAutomationRuleInvariantViolation rejects toMode:static with no toNumber", () => {
  assert.match(
    findAutomationRuleInvariantViolation({ ...recordCreatedRule, toNumber: null }) ?? "",
    /toNumber is required/,
  );
});

/**
 * The exact repro this fix targets: a PATCH that switches toMode to
 * "field" without also setting toField (because the rule was created
 * with toMode:"static" and has never had a toField value) must be
 * rejected, not silently saved as a rule that can never resolve a
 * destination.
 */
test("findAutomationRuleInvariantViolation rejects toMode:field with no toField, e.g. after a toMode-only PATCH on a static rule", () => {
  const afterToModeOnlyPatch = { ...recordCreatedRule, toMode: "field" as const };
  assert.match(findAutomationRuleInvariantViolation(afterToModeOnlyPatch) ?? "", /toField is required/);
});

test("findAutomationRuleInvariantViolation accepts a valid webhook rule with no toNumber/toField at all", () => {
  assert.equal(
    findAutomationRuleInvariantViolation({
      ...recordCreatedRule,
      actionType: "webhook",
      toNumber: null,
      toField: null,
      webhookUrl: "https://hooks.example.com/forge",
    }),
    null,
  );
});

test("findAutomationRuleInvariantViolation rejects actionType:webhook with no webhookUrl", () => {
  assert.match(
    findAutomationRuleInvariantViolation({ ...recordCreatedRule, actionType: "webhook", webhookUrl: null }) ?? "",
    /webhookUrl is required/,
  );
});

test("findAutomationRuleInvariantViolation rejects actionType:webhook with a webhookUrl pointing at a blocked local/private host", () => {
  assert.match(
    findAutomationRuleInvariantViolation({ ...recordCreatedRule, actionType: "webhook", webhookUrl: "http://127.0.0.1/abc" }) ?? "",
    /local\/private address/,
  );
});

test("findAutomationRuleInvariantViolation never requires toNumber/toField for a webhook rule, even with toMode:field and no toField", () => {
  assert.equal(
    findAutomationRuleInvariantViolation({
      ...recordCreatedRule,
      actionType: "webhook",
      toMode: "field",
      toField: null,
      webhookUrl: "https://hooks.example.com/forge",
    }),
    null,
  );
});

/**
 * Round 782: multer/busboy decodes a multipart `filename="..."` header as
 * raw Latin-1 bytes unless defParamCharset is configured (which
 * createUploadMiddleware never does), but every real browser sends a
 * non-ASCII filename as its raw UTF-8 bytes -- so file.originalname for a
 * Hebrew filename arrives as mojibake, every UTF-8 byte individually
 * mis-mapped to its own Latin-1 code point. decodeMojibakeFilename
 * reverses that exact mis-decoding.
 */
test("decodeMojibakeFilename leaves a plain ASCII filename completely unchanged", () => {
  assert.equal(decodeMojibakeFilename("my resume.pdf"), "my resume.pdf");
});

test("decodeMojibakeFilename recovers a Hebrew filename from its Latin-1-mis-decoded mojibake form", () => {
  const realName = "קורות חיים.pdf";
  // Simulates exactly what busboy's own latin1Slice + nullDecoder produces
  // for a real browser's raw-UTF-8-bytes filename header: the same bytes,
  // reinterpreted one-for-one as Latin-1 code points.
  const mojibake = Buffer.from(realName, "utf8").toString("latin1");
  assert.notEqual(mojibake, realName, "the simulated mojibake must actually differ from the real name, or this test proves nothing");
  assert.equal(decodeMojibakeFilename(mojibake), realName);
});

/**
 * Must never run a second, destructive decode pass on a filename busboy's
 * OWN extended `filename*=UTF-8''...` (RFC 5987) syntax already decoded
 * correctly -- a real Unicode string like this always has at least one
 * character outside the Latin-1 range, which decodeMojibakeFilename's own
 * all-Latin-1-range guard must leave alone.
 */
test("decodeMojibakeFilename never re-decodes a filename that's already correct Unicode text", () => {
  // Real Hebrew (code points above U+00FF) -- the "every character is in
  // the Latin-1 range" guard must reject this immediately, before ever
  // reaching the Buffer re-decode step at all. "café résumé.pdf" would be
  // the wrong fixture here: é is U+00E9, inside the Latin-1 range, so it
  // wouldn't actually exercise this guard (it would instead pass through
  // to the re-decode step and only survive via the OTHER guard below).
  const alreadyCorrect = "קורות חיים.pdf";
  assert.equal(decodeMojibakeFilename(alreadyCorrect), alreadyCorrect);
});

/**
 * A genuine single-byte Latin-1 accented filename (some other, older
 * client sending one real Latin-1 byte per accented character, not UTF-8's
 * multi-byte sequence) would, if "fixed" anyway, decode as invalid UTF-8
 * and introduce the U+FFFD replacement character -- the signal that the
 * bytes were never UTF-8 in the first place, so the original must be
 * returned unchanged instead of being corrupted further.
 */
test("decodeMojibakeFilename leaves a genuine single-byte Latin-1 name alone when re-decoding it as UTF-8 would be invalid", () => {
  const genuineLatin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x70, 0x64, 0x66]).toString("latin1"); // "caf\xE9.pdf"
  assert.equal(decodeMojibakeFilename(genuineLatin1), genuineLatin1);
});
