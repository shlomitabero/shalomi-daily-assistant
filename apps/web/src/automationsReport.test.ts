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
