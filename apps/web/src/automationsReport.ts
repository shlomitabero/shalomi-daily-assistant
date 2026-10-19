import type { Entity } from "@forge/shared";
import { safeDownloadName, type AutomationRuleView } from "./api.js";
import { recordDisplayLabel, type RelatedRecordsByEntity } from "./entityFormatting.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

/**
 * Renders the Automations panel's own already-fetched rule list as a
 * plain, shareable text snapshot -- same "plain UTF-8 text, not a PDF"
 * reasoning as twinReport.ts's own doc comment, and the same gap every
 * other read-heavy diagnostic panel in this app (Business Twin, WhatsApp
 * log, Time Machine, Global Search) already closed for itself. A user
 * debugging why a WhatsApp/webhook automation isn't firing had no way to
 * hand over the rule list and its last-run outcomes (a destination that
 * never got configured, a webhook timeout) without a screenshot.
 *
 * Deliberately self-contained rather than importing AutomationsPanel.tsx's
 * own describeRule/describeDestination/describeLastRun closures -- those
 * close over component state and can't be called from a plain module the
 * way every sibling report module (twinReport.ts, searchReport.ts) is
 * already structured: each formats its own panel's data independently,
 * not by reaching back into that panel's render functions.
 */
function ruleEntity(rule: AutomationRuleView, entities: Entity[]): Entity | undefined {
  return entities.find((e) => e.name === rule.entityName);
}

function entityLabel(rule: AutomationRuleView, entities: Entity[]): string {
  return ruleEntity(rule, entities)?.label ?? rule.entityName;
}

function fieldLabel(rule: AutomationRuleView, fieldName: string | null, entities: Entity[]): string {
  if (!fieldName) return "";
  const field = ruleEntity(rule, entities)?.fields.find((f) => f.name === fieldName);
  return field?.label ?? fieldName;
}

function fieldValueLabel(rule: AutomationRuleView, entities: Entity[], relatedRecords: RelatedRecordsByEntity): string {
  if (!rule.fieldValue) return "";
  const field = ruleEntity(rule, entities)?.fields.find((f) => f.name === rule.fieldName);
  if (field?.type === "enum") return field.enumLabels?.[rule.fieldValue] ?? rule.fieldValue;
  if (field?.type === "relation" && field.relationTo) {
    const targetEntity = entities.find((e) => e.name === field.relationTo);
    const records = relatedRecords[field.relationTo];
    const match = targetEntity && records ? records.find((r) => String(r.id) === rule.fieldValue) : undefined;
    return match && targetEntity ? recordDisplayLabel(targetEntity, match) : rule.fieldValue;
  }
  return rule.fieldValue;
}

function scheduleDayLabel(day: number, lang: Lang): string {
  const reference = new Date(Date.UTC(2024, 0, 7 + day)); // a known Sunday-anchored week
  return new Intl.DateTimeFormat(LOCALE[lang], { weekday: "short", timeZone: "UTC" }).format(reference);
}

function describeSchedule(
  rule: AutomationRuleView,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const days = rule.scheduleDaysOfWeek
    ? rule.scheduleDaysOfWeek.split(",").map(Number).sort().map((d) => scheduleDayLabel(d, lang)).join(", ")
    : t("automations.schedule.everyDay");
  return t("automations.rule.when.schedule", { time: rule.scheduleTimeUtc ?? "", days });
}

function describeRule(
  rule: AutomationRuleView,
  entities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (rule.trigger === "record_created") return t("automations.rule.when.created", { entity: entityLabel(rule, entities) });
  if (rule.trigger === "schedule") return describeSchedule(rule, lang, t);
  return t("automations.rule.when.fieldEquals", {
    field: fieldLabel(rule, rule.fieldName, entities),
    entity: entityLabel(rule, entities),
    value: fieldValueLabel(rule, entities, relatedRecords),
  });
}

function describeDestination(
  rule: AutomationRuleView,
  entities: Entity[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (rule.actionType === "webhook") {
    return t("automations.rule.callsWebhook", { url: rule.webhookUrl ?? "" });
  }
  const destination =
    rule.toMode === "field"
      ? t("automations.rule.sendsField", { field: fieldLabel(rule, rule.toField, entities) })
      : t("automations.rule.sendsStatic", { number: rule.toNumber ?? "" });
  return t("automations.rule.sends", { destination });
}

function describeLastRun(
  rule: AutomationRuleView,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (!rule.lastTriggeredAt) return t("automations.lastRun.never");
  const time = new Date(rule.lastTriggeredAt).toLocaleString(LOCALE[lang]);
  return rule.lastStatus === "sent"
    ? t("automations.lastRun.sent", { time })
    : t("automations.lastRun.failed", { time, error: rule.lastError ?? "" });
}

export function formatAutomationsReport(
  rules: AutomationRuleView[],
  entities: Entity[],
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
  relatedRecords: RelatedRecordsByEntity = {},
): string {
  const lines: string[] = [];
  lines.push(`${t("automations.title")} — ${projectName}`);
  lines.push(t("automations.report.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) }));
  lines.push("");

  if (rules.length === 0) {
    lines.push(t("automations.empty"));
    return lines.join("\n").trimEnd();
  }

  for (const rule of rules) {
    lines.push(`${describeRule(rule, entities, relatedRecords, lang, t)} (${rule.enabled ? t("automations.status.enabled") : t("automations.status.disabled")})`);
    lines.push(describeDestination(rule, entities, t));
    lines.push(rule.messageTemplate);
    lines.push(describeLastRun(rule, lang, t));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Saves the already-rendered report text as a real downloaded .txt file, the same browser-download mechanics twinReport.ts's downloadTwinReport uses. */
export function downloadAutomationsReport(text: string, projectName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(projectName, "forge-app")}-automations.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
