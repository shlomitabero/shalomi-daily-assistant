import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@forge/shared";
import type { AutomationRuleView } from "./api.js";
import { formatAutomationsReport } from "./automationsReport.js";
import { translate } from "./i18n/language.js";

function makeRule(overrides: Partial<AutomationRuleView> = {}): AutomationRuleView {
  return {
    id: "rule1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    actionType: "send_whatsapp",
    toMode: "field",
    toNumber: null,
    toField: "customerPhone",
    webhookUrl: null,
    messageTemplate: "Hi {{customerName}}, delivered!",
    enabled: true,
    lastTriggeredAt: null,
    lastStatus: null,
    lastError: null,
    ...overrides,
  } as AutomationRuleView;
}

/**
 * Round 772 regression test: the exact same bug class round 770 fixed in
 * AutomationsPanel.tsx's own rule list -- this module (its intentionally
 * independent, hand-duplicated sibling, used only by the Copy/Download
 * report feature) never got the matching fix, so the one artifact meant
 * to be shared/saved for debugging a rule still showed two fields sharing
 * a label ("Amount") as indistinguishable.
 */
const duplicateLabelOrderEntity: Entity = {
  name: "Order",
  label: "Order",
  fields: [
    { name: "subtotal", label: "Amount", type: "number", required: true },
    { name: "shipping", label: "Amount", type: "number", required: false },
  ],
};

/**
 * Round 1181: this module's own fieldValueLabel (mirroring AutomationsPanel.
 * tsx's sibling, round 772's own finding) resolved a relation field's
 * stored id to its target entity's display label by comparing relationTo
 * to entities[].name with exact-case equality -- the same bug class
 * rounds 1159-1180 already fixed across the live table, CSV import, and
 * the entity-delete guard, just never reached this report-formatting
 * function or its AutomationsPanel.tsx sibling. Before the fix, the
 * report fell back to printing the bare, meaningless internal record id
 * whenever relationTo differed from its target entity's real declared
 * name only by letter case.
 */
const relationCaseMismatchOrderEntity: Entity = {
  name: "Order",
  label: "Order",
  fields: [{ name: "courierId", label: "Courier", type: "relation", relationTo: "courier", required: false }],
};
const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };

test("formatAutomationsReport still resolves a relation field's stored id to its display label when relationTo differs from its target entity's name only by letter case", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({ fieldName: "courierId", fieldValue: "9" });

  const report = formatAutomationsReport(
    [rule],
    [relationCaseMismatchOrderEntity, courierEntity],
    "Shop",
    "en",
    t,
    { courier: [{ id: 9, createdAt: "x", name: "Dana Levi" }] },
  );

  assert.match(report, /Dana Levi/, "the report must resolve the relation id to the related record's display label, not the bare id");
  assert.doesNotMatch(report, /"9"/, "the raw stored id must never be shown once the related record's label is resolvable");
});

test("formatAutomationsReport disambiguates two fields that share the same label, in both the condition and the destination", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({ fieldName: "subtotal", fieldValue: "5", toField: "shipping" });

  const report = formatAutomationsReport([rule], [duplicateLabelOrderEntity], "Shop", "en", t);

  assert.match(
    report,
    /Amount \(subtotal\)/,
    "the condition field must be disambiguated by its own unique name, exactly like the live rule list already does",
  );
  assert.match(
    report,
    /Amount \(shipping\)/,
    "the destination field must be disambiguated by its own unique name too",
  );
});

/**
 * Round 1090: V8/ICU's "he-IL" locale silently prepends a real, invisible
 * U+200E LEFT-TO-RIGHT MARK before the minus sign of any negative number
 * -- confirmed directly via Node (`(-50).toLocaleString("he-IL")` embeds
 * it, the identical "en-US" call doesn't). rule.fieldValue is free text
 * from a plain <input type="text"> (AutomationsPanel.tsx), so a
 * field_equals rule on a number field can genuinely be "-50", and this
 * report is the same downloadable plain-text snapshot round 1089 already
 * fixed the identical gap for in automations.ts's interpolateTemplate.
 */
test("formatAutomationsReport strips the invisible bidi mark toLocaleString adds before a negative field_equals value under 'he'", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const balanceOrderEntity: Entity = {
    name: "Order",
    label: "Order",
    fields: [{ name: "balance", label: "יתרה", type: "number", required: true }],
  };
  const rule = makeRule({ fieldName: "balance", fieldValue: "-50" });

  const report = formatAutomationsReport([rule], [balanceOrderEntity], "Shop", "he", t);

  assert.match(report, /-50/, "the negative value must render with a plain minus sign, no invisible character before it");
  assert.ok(!report.includes("‎") && !report.includes("‏"), "the report must contain no invisible bidi mark at all");
});

/**
 * Round 1000: this module's own hand-duplicated describeDestination
 * sibling (AutomationsPanel.tsx's own copy got the matching branch in
 * round 996) never handled actionType "send_email" at all -- a static-
 * destination send_email rule fell into the generic `else` branch, which
 * reads `toNumber` (always null for this action type) instead of the
 * real `toEmail` column, printing an empty destination. The email's own
 * subject line (emailSubject, interpolated independently of
 * messageTemplate) was also never printed anywhere in the report.
 */
test("formatAutomationsReport shows a send_email rule's real toEmail destination and its own subject line, not an empty destination and a dropped subject", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({
    actionType: "send_email",
    toMode: "static",
    toNumber: null,
    toField: null,
    toEmail: "owner@example.com",
    emailSubject: "New order from {{customerName}}",
    messageTemplate: "Your order has shipped!",
  });

  const report = formatAutomationsReport([rule], [], "Shop", "en", t);

  assert.match(report, /emails owner@example\.com/, "must use the real toEmail destination, with the dedicated send_email wording");
  assert.doesNotMatch(report, /sends to\b/, "must not fall into the generic send_whatsapp/webhook destination wording");
  assert.match(report, /Subject: New order from \{\{customerName\}\}/, "the subject line must be included, not silently dropped");
  assert.match(report, /Your order has shipped!/, "the body (messageTemplate) must still be included too");
});

/**
 * Round 969: this module's own hand-duplicated describeRule sibling
 * (AutomationsPanel.tsx's own copy was fixed directly) needed the
 * identical new "record_deleted" branch -- without it, a record_deleted
 * rule would silently fall through to this function's own field_equals
 * description instead, showing a nonsensical "becomes '...'" sentence for
 * a trigger that was never field_equals at all.
 */
test("formatAutomationsReport describes a record_deleted rule with its own distinct wording, not the field_equals fallback", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({ trigger: "record_deleted", fieldName: null, fieldValue: null });

  const report = formatAutomationsReport([rule], [duplicateLabelOrderEntity], "Shop", "en", t);

  assert.match(report, /deleted/i);
  assert.equal(report.includes("becomes"), false, "must not fall through to the field_equals description");
});

/**
 * Round 1330: same hand-duplicated describeRule sibling needed the new
 * "record_updated" branch too (AutomationsPanel.tsx's own copy was fixed
 * directly) -- without it, a record_updated rule would silently fall
 * through to this function's own field_equals description.
 */
test("formatAutomationsReport describes a record_updated rule with its own distinct wording, not the field_equals fallback", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({ trigger: "record_updated", fieldName: null, fieldValue: null });

  const report = formatAutomationsReport([rule], [duplicateLabelOrderEntity], "Shop", "en", t);

  assert.match(report, /updated/i);
  assert.equal(report.includes("becomes"), false, "must not fall through to the field_equals description");
});

/**
 * Round 952 regression test: the entity-level counterpart of the round-772
 * test just above -- the exact same bug class round 864 fixed in
 * AutomationsPanel.tsx's own live rule list (entityLabelOccurrences/
 * entityDisplayLabel), never ported into this module's own hand-duplicated
 * entityLabel. Two entities (e.g. an active-customers table and an
 * archived-customers table) can legally share a label since the Entity
 * Label editor enforces no uniqueness, same as the Field Label editor --
 * without disambiguation, this report's "When a 'X' record is..." line
 * showed two rules targeting two differently-named-but-same-labeled
 * entities as textually identical, with no way to tell which rule
 * actually does what.
 */
test("formatAutomationsReport disambiguates two entities that share the same label, in the rule's own condition line", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const customerActive: Entity = { name: "CustomerActive", label: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const customerArchived: Entity = { name: "CustomerArchived", label: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const rule = makeRule({ entityName: "CustomerArchived", trigger: "record_created", fieldName: null, fieldValue: null });

  const report = formatAutomationsReport([rule], [customerActive, customerArchived], "Shop", "en", t);

  assert.match(
    report,
    /Customer \(CustomerArchived\)/,
    "the rule's own targeted entity must be disambiguated by its own unique name, exactly like the live rule list already does",
  );
});

/**
 * Round 935: this module's own describeLastRun -- deliberately a
 * hand-duplicated sibling of AutomationsPanel.tsx's own version (see
 * this file's top comment) -- interpolated a send_whatsapp rule's own
 * failed-run error verbatim, the exact raw snake_case code
 * apps/api/src/automations.ts stores (e.g. "missing_country_code", the
 * COMMON case for a toMode:"field" rule reading a locally-formatted
 * phone field), instead of the already-written, already-translated
 * message api.ts's own sendWhatsAppMessage shows one click away in the
 * manual "Send WhatsApp" panel.
 */
test("formatAutomationsReport translates a send_whatsapp rule's known raw error code instead of showing the bare code", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({ lastTriggeredAt: "2026-03-15T09:00:00Z", lastStatus: "failed", lastError: "missing_country_code" });

  const report = formatAutomationsReport([rule], [], "Shop", "en", t);

  assert.match(report, /missing a country code/, "the report must show the translated message");
  assert.equal(report.includes("missing_country_code"), false, "the bare raw error code must never leak into the report");
});

/**
 * Round 1080: the send_email counterpart to the round-935 test above --
 * apps/api/src/automations.ts's fireEmailAction now records this exact
 * stable snake_case code when a toMode:"field" rule's resolved destination
 * value isn't a valid email address (see KNOWN_EMAIL_SEND_ERROR_CODES's
 * own doc comment in api.ts).
 */
test("formatAutomationsReport translates a send_email rule's known raw error code (invalid_email_address) instead of showing the bare code", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({
    actionType: "send_email",
    toField: "customerPhone",
    emailSubject: "Order update",
    lastTriggeredAt: "2026-03-15T09:00:00Z",
    lastStatus: "failed",
    lastError: "invalid_email_address",
  });

  const report = formatAutomationsReport([rule], [], "Shop", "en", t);

  assert.match(report, /valid email address/, "the report must show the translated message");
  assert.equal(report.includes("invalid_email_address"), false, "the bare raw error code must never leak into the report");
});

/**
 * Round 1166: rounds 935/1080 above only ever translated the stable
 * snake_case codes a per-send ATTEMPT failure stores. This mirrors
 * AutomationsPanel.tsx's own identical fix (see its own comment) for the
 * sibling gap: apps/api/src/automations.ts also stores whole-rule/
 * whole-record MISCONFIGURATION errors as fixed, untranslated English
 * sentences (WHATSAPP_NOT_CONNECTED_ERROR among them) -- before this
 * round, the downloaded/copied report showed this raw sentence verbatim.
 */
test("formatAutomationsReport translates a send_whatsapp rule's WhatsApp-not-connected misconfiguration error instead of showing the bare server sentence", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({
    actionType: "send_whatsapp",
    lastTriggeredAt: "2026-03-15T09:00:00Z",
    lastStatus: "failed",
    lastError: "WhatsApp is not connected",
  });

  const report = formatAutomationsReport([rule], [], "Shop", "en", t);

  assert.match(report, /Reconnect and try again/, "the report must show the same translated WhatsApp-disconnected message the manual send panel already uses");
  assert.equal(report.includes("WhatsApp is not connected"), false, "the bare raw server sentence must never leak into the report");
});

/**
 * Round 1381: mirrors AutomationsPanel.tsx's own identical fix (see its own
 * comment) -- round 1166 above only ever covered AUTOMATION_CONFIG_ERROR_CODES'
 * fixed literal sentences; a webhook rule's own two dynamic failure shapes
 * (fireWebhookAction's non-2xx-response message and its catch-all
 * network-error message, apps/api/src/automations.ts) were never covered
 * and leaked raw English straight into the downloaded/copied report.
 */
test("formatAutomationsReport translates a webhook rule's HTTP-status failure and its network-error failure instead of showing the bare English sentence", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const httpErrorRule = makeRule({
    id: "http-error-rule",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    lastTriggeredAt: "2026-03-15T09:00:00Z",
    lastStatus: "failed",
    lastError: "Webhook responded with status 500",
  });
  const networkErrorRule = makeRule({
    id: "network-error-rule",
    actionType: "webhook",
    webhookUrl: "https://hooks.example.com/forge",
    lastTriggeredAt: "2026-03-15T09:00:00Z",
    lastStatus: "failed",
    lastError: "fetch failed",
  });

  const report = formatAutomationsReport([httpErrorRule, networkErrorRule], [], "Shop", "en", t);

  assert.match(report, /status 500/, "the report must still surface the actual status code for the HTTP-status failure");
  assert.equal(report.includes("Webhook responded with status 500"), false, "the bare raw HTTP-status sentence must never leak into the report");
  assert.match(report, /network error/i, "the report must show a translated network-error message for the catch-all failure");
  assert.equal(report.includes("fetch failed"), false, "the bare raw network-error text must never leak into the report");
});

/**
 * Round 948: same fix as AutomationsPanel.tsx's own identical regression
 * (see its own comment) -- editing a rule's actionType never
 * retroactively clears/updates its own already-stored lastError
 * (updateAutomationRule never touches it), so the rule's CURRENT
 * actionType (now "webhook") is not what was actually in effect when
 * lastError was recorded. lastActionType is the snapshot taken at that
 * moment; without falling back to it, this report would stop translating
 * a still-WhatsApp-specific code the instant the rule's action type is
 * edited.
 */
test("formatAutomationsReport still translates a known WhatsApp error code after the rule's own actionType was edited away from send_whatsapp, using the snapshotted lastActionType instead of the rule's current one", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({
    actionType: "webhook",
    webhookUrl: "https://example.com/hook",
    lastTriggeredAt: "2026-03-15T09:00:00Z",
    lastStatus: "failed",
    lastError: "missing_country_code",
    lastActionType: "send_whatsapp",
  });

  const report = formatAutomationsReport([rule], [], "Shop", "en", t);

  assert.match(report, /missing a country code/, "lastActionType, not the rule's now-webhook actionType, must still be used to translate the stale lastError");
  assert.equal(report.includes("missing_country_code"), false, "the bare raw error code must never leak into the report even after the rule was edited");
});

/**
 * Round 959: mirrors AutomationsPanel.tsx's own "paused for today" chip --
 * without this, a schedule rule the server reports as pausedForToday
 * printed as plain "Enabled" in a downloaded/copied report, identical to
 * one still actively retrying every minute.
 */
test("formatAutomationsReport shows a distinct 'Paused for today' suffix for a rule the server reports as pausedForToday, but not for an otherwise-identical enabled rule", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const pausedRule = makeRule({ id: "paused-rule", trigger: "schedule", scheduleTimeUtc: "09:00", scheduleDaysOfWeek: null, pausedForToday: true });
  const activeRule = makeRule({ id: "active-rule", trigger: "schedule", scheduleTimeUtc: "10:00", scheduleDaysOfWeek: null, pausedForToday: false });

  const report = formatAutomationsReport([pausedRule, activeRule], [], "Shop", "en", t);
  const lines = report.split("\n");
  const pausedLine = lines.find((l) => l.includes("09:00"))!;
  const activeLine = lines.find((l) => l.includes("10:00"))!;

  assert.match(pausedLine, /\(Enabled, Paused for today\)/, "the paused rule's own line must name both its enabled state and the paused-for-today suffix");
  assert.match(activeLine, /\(Enabled\)$/, "an active, non-paused rule's line must show only its plain enabled state, with no paused suffix");
});

test("formatAutomationsReport shows a field's bare label unchanged when no other field on the entity shares it", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const entity: Entity = {
    name: "Order",
    label: "Order",
    fields: [
      { name: "status", label: "Status", type: "text", required: true },
      { name: "customerPhone", label: "Customer Phone", type: "text", required: false },
    ],
  };
  const rule = makeRule();

  const report = formatAutomationsReport([rule], [entity], "Shop", "en", t);

  assert.match(report, /"Status"/);
  assert.match(report, /field "Customer Phone"/);
  assert.ok(!report.includes("(status)"), "a uniquely-labeled field must not gain a disambiguating suffix");
});

/**
 * Round 1116's finding: the report (Copy/Download, round 679) only ever
 * showed a rule's single latest outcome via describeLastRun -- round 682
 * added a whole separate run-history feature (GET .../runs) three rounds
 * later, but nobody ever extended this report to include it, unlike
 * searchReport.ts's own expandedSamples param for the identical situation.
 * Confirms a passed-in runsByRuleId entry appends every one of that rule's
 * runs (oldest AND newest failures, not just the latest), each translated
 * using its OWN actionType snapshot -- not the rule's current one, the
 * same round-948 "actionType can be edited after the fact" rule
 * describeLastRun already respects, just now proven per-run too.
 */
test("formatAutomationsReport includes a rule's full run history when runsByRuleId is passed, each run translated using its own actionType snapshot", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const rule = makeRule({
    actionType: "webhook",
    webhookUrl: "https://example.com/hook",
    lastTriggeredAt: "2026-03-15T09:00:00Z",
    lastStatus: "sent",
  });
  const runs = [
    { id: "run3", ruleId: "rule1", status: "sent" as const, error: null, actionType: "webhook" as const, recordId: 1, triggeredAt: "2026-03-15T09:00:00Z" },
    {
      id: "run2",
      ruleId: "rule1",
      status: "failed" as const,
      error: "missing_country_code",
      actionType: "send_whatsapp" as const,
      recordId: 1,
      triggeredAt: "2026-03-14T09:00:00Z",
    },
    { id: "run1", ruleId: "rule1", status: "sent" as const, error: null, actionType: "send_whatsapp" as const, recordId: 1, triggeredAt: "2026-03-13T09:00:00Z" },
  ];

  const withoutHistory = formatAutomationsReport([rule], [], "Shop", "en", t);
  assert.equal(withoutHistory.includes("missing a country code"), false, "without runsByRuleId, the report must stay exactly as before -- only the single latest outcome");

  const withHistory = formatAutomationsReport([rule], [], "Shop", "en", t, {}, { rule1: runs });
  assert.match(withHistory, /Run history:/);
  assert.match(withHistory, /missing a country code/, "an older failed run's error must be translated using ITS OWN actionType (send_whatsapp), not the rule's current webhook actionType");
  assert.equal(withHistory.includes("missing_country_code"), false, "the bare raw error code must never leak into the report");
});
