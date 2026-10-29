import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationRuleView } from "./api.js";
import { findNewlyFailingAutomations } from "./automationsNotify.js";

/** Builds a minimal AutomationRuleView -- only the fields findNewlyFailingAutomations reads are given real values. */
function rule(overrides: Partial<AutomationRuleView> & { id: string }): AutomationRuleView {
  return {
    entityName: "Order",
    trigger: "schedule",
    fieldName: null,
    fieldValue: null,
    scheduleTimeUtc: null,
    scheduleDaysOfWeek: null,
    scheduleTimezone: null,
    actionType: "webhook",
    toMode: "static",
    toNumber: null,
    toField: null,
    webhookUrl: "https://example.com/hook",
    webhookSecret: null,
    toEmail: null,
    emailSubject: null,
    messageTemplate: "",
    enabled: true,
    lastTriggeredAt: null,
    lastStatus: null,
    lastError: null,
    lastActionType: null,
    pausedForToday: false,
    ...overrides,
  };
}

test("findNewlyFailingAutomations returns null when previouslyFailingIds is null -- no baseline yet, never notify for a pre-existing failure", () => {
  const rules = [rule({ id: "r1", lastStatus: "failed" })];
  assert.equal(findNewlyFailingAutomations(rules, null), null);
});

test("findNewlyFailingAutomations returns null when the failing rule was already in the previous baseline", () => {
  const rules = [rule({ id: "r1", lastStatus: "failed" })];
  assert.equal(findNewlyFailingAutomations(rules, new Set(["r1"])), null);
});

test("findNewlyFailingAutomations returns null when nothing is currently failing", () => {
  const rules = [rule({ id: "r1", lastStatus: "sent" })];
  assert.equal(findNewlyFailingAutomations(rules, new Set()), null);
});

test("findNewlyFailingAutomations reports a rule that started failing since the last check", () => {
  const rules = [rule({ id: "r1", entityName: "Invoice", lastStatus: "failed" })];
  const result = findNewlyFailingAutomations(rules, new Set());
  assert.deepEqual(result, { count: 1, entityName: "Invoice" });
});

test("findNewlyFailingAutomations ignores a DISABLED rule even if its lastStatus is 'failed'", () => {
  const rules = [rule({ id: "r1", lastStatus: "failed", enabled: false })];
  assert.equal(findNewlyFailingAutomations(rules, new Set()), null);
});

test("findNewlyFailingAutomations counts only the rules that are newly failing, not every currently-failing rule", () => {
  const rules = [
    rule({ id: "r1", lastStatus: "failed" }),
    rule({ id: "r2", lastStatus: "failed" }),
    rule({ id: "r3", lastStatus: "failed" }),
  ];
  const result = findNewlyFailingAutomations(rules, new Set(["r1"]));
  assert.deepEqual(result, { count: 2, entityName: "Order" });
});

test("findNewlyFailingAutomations treats a rule missing from the current set entirely (deleted) as simply not failing -- no crash, no false positive", () => {
  const rules: AutomationRuleView[] = [];
  assert.equal(findNewlyFailingAutomations(rules, new Set(["r1"])), null);
});
