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
