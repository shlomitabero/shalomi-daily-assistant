import type { Entity } from "@forge/shared";
import {
  AUTOMATION_CONFIG_ERROR_CODES,
  KNOWN_EMAIL_SEND_ERROR_CODES,
  KNOWN_WHATSAPP_SEND_ERROR_CODES,
  safeDownloadName,
  type AutomationActionType,
  type AutomationRuleView,
  type AutomationRunView,
} from "./api.js";
import { fieldDisplayLabel, fieldLabelOccurrences, parseFieldDate, recordDisplayLabel, type RelatedRecordsByEntity } from "./entityFormatting.js";
import { resolveErrorMessage, type Lang } from "./i18n/language.js";

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

// Round 952: mirrors (rather than imports, matching this codebase's
// established per-surface convention -- see checkpointDiff.ts's/
// pipeline.ts's own identical pair, and AutomationsPanel.tsx's own
// entityLabelOccurrences/entityDisplayLabel this is ported from) the
// entity-level twin of fieldLabel's own field-disambiguation just below.
// Two entities can legally share a label (the Entity Label editor doesn't
// enforce uniqueness any more than the Field Label editor does --
// routes/projects.ts's PATCH /entities/:entityName/label accepts any
// non-empty string with no collision check against siblings) -- without
// this, this report's own "When a 'X' record is..." line showed two
// different rules targeting two differently-named-but-same-labeled
// entities as textually identical, with no way to tell which rule does
// what, directly undermining the one thing this shareable report exists
// for. Round 864 already fixed the identical gap in AutomationsPanel.tsx's
// own live rule list; this self-contained sibling module never got the
// matching fix.
function entityLabelOccurrences(entities: Entity[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const e of entities) {
    const label = e.label ?? e.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
  const label = entity.label ?? entity.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
}

function entityLabel(rule: AutomationRuleView, entities: Entity[]): string {
  const entity = ruleEntity(rule, entities);
  return entity ? entityDisplayLabel(entity, entityLabelOccurrences(entities)) : rule.entityName;
}

function fieldLabel(rule: AutomationRuleView, fieldName: string | null, entities: Entity[]): string {
  if (!fieldName) return "";
  const ruleFields = ruleEntity(rule, entities)?.fields ?? [];
  const field = ruleFields.find((f) => f.name === fieldName);
  if (!field) return fieldName;
  return fieldDisplayLabel(field, fieldLabelOccurrences(ruleFields));
}

// Mirrors AutomationsPanel.tsx's own fieldValueLabel (see its comment) --
// including the date/number branches that mirror apps/api/src/
// automations.ts's interpolateTemplate, so a date/number field_equals
// rule's value shows locale-formatted in this report the same way it now
// does in the live rule list, instead of the raw stored string. Same for
// boolean's uppercase "TRUE"/"FALSE" convention -- the create-form's own
// checkbox stores the raw lowercase string "true"/"false" as fieldValue.
function fieldValueLabel(rule: AutomationRuleView, entities: Entity[], relatedRecords: RelatedRecordsByEntity, lang: Lang): string {
  if (!rule.fieldValue) return "";
  const field = ruleEntity(rule, entities)?.fields.find((f) => f.name === rule.fieldName);
  if (field?.type === "enum") return field.enumLabels?.[rule.fieldValue] ?? rule.fieldValue;
  if (field?.type === "relation" && field.relationTo) {
    const targetEntity = entities.find((e) => e.name === field.relationTo);
    const records = relatedRecords[field.relationTo];
    const match = targetEntity && records ? records.find((r) => String(r.id) === rule.fieldValue) : undefined;
    return match && targetEntity ? recordDisplayLabel(targetEntity, match, lang) : rule.fieldValue;
  }
  if (field?.type === "date") {
    const date = parseFieldDate(rule.fieldValue);
    return Number.isNaN(date.getTime()) ? rule.fieldValue : date.toLocaleDateString(LOCALE[lang]);
  }
  // Round 1090: "he-IL" silently embeds an invisible U+200E before a
  // negative number's minus sign (see calendarIcs.ts's own doc comment
  // for the full rationale) -- rule.fieldValue is free-text from a plain
  // <input type="text"> (AutomationsPanel.tsx), so a field_equals rule on
  // a number field can genuinely be "-50", and this report is the same
  // downloadable plain-text snapshot round 1089 already fixed the
  // identical gap for (this file's own doc comment: "a plain, shareable
  // text snapshot"). AutomationsPanel.tsx's own on-screen fieldValueLabel
  // is deliberately left untouched -- that one renders into live React
  // UI, where the mark is doing its real, intended bidi job.
  if (field?.type === "number") return stripBidiMarks(Number(rule.fieldValue).toLocaleString(LOCALE[lang]));
  if (field?.type === "boolean") return rule.fieldValue === "true" ? "TRUE" : "FALSE";
  return rule.fieldValue;
}

function stripBidiMarks(s: string): string {
  return s.replace(/[‎‏]/g, "");
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
  return t("automations.rule.when.schedule", { time: rule.scheduleTimeUtc ?? "", days, timezone: rule.scheduleTimezone ?? "UTC" });
}

function describeRule(
  rule: AutomationRuleView,
  entities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (rule.trigger === "record_created") return t("automations.rule.when.created", { entity: entityLabel(rule, entities) });
  if (rule.trigger === "record_deleted") return t("automations.rule.when.deleted", { entity: entityLabel(rule, entities) });
  if (rule.trigger === "schedule") return describeSchedule(rule, lang, t);
  return t("automations.rule.when.fieldEquals", {
    field: fieldLabel(rule, rule.fieldName, entities),
    entity: entityLabel(rule, entities),
    value: fieldValueLabel(rule, entities, relatedRecords, lang),
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
  // Round 1000: mirrors AutomationsPanel.tsx's own identical "send_email"
  // branch -- this report is deliberately self-contained (see this
  // file's own top comment), so it never got the matching branch round
  // 996 added there, and fell into the `else` below instead: that reads
  // `rule.toNumber` (always null for a send_email rule) instead of the
  // actual `rule.toEmail` column, printing an empty destination for
  // every send_email rule's downloaded report.
  if (rule.actionType === "send_email") {
    const emailDestination =
      rule.toMode === "field"
        ? t("automations.rule.sendsField", { field: fieldLabel(rule, rule.toField, entities) })
        : t("automations.rule.sendsStatic", { number: rule.toEmail ?? "" });
    return t("automations.rule.sendsEmail", { destination: emailDestination });
  }
  const destination =
    rule.toMode === "field"
      ? t("automations.rule.sendsField", { field: fieldLabel(rule, rule.toField, entities) })
      : t("automations.rule.sendsStatic", { number: rule.toNumber ?? "" });
  return t("automations.rule.sends", { destination });
}

// Round 935: mirrors AutomationsPanel.tsx's own translateAutomationError
// (see its comment) -- this report is deliberately self-contained (see
// this file's own top comment), so it gets its own copy rather than
// importing that panel's closure, but reuses the exact same canonical
// KNOWN_WHATSAPP_SEND_ERROR_CODES list and error.WHATSAPP_SEND_<CODE>
// i18n keys so the downloaded report never disagrees with the live panel
// about which errors are known or how they're phrased.
// Round 948: same fix as AutomationsPanel.tsx's own identical helper (see
// its comment) -- rule.actionType is the rule's CURRENT, possibly
// since-edited value, not necessarily what it was when lastError was
// actually recorded. lastActionType is that snapshot; falls back to the
// current actionType only for a legacy row recorded before that column
// existed.
// Round 1116: now takes the already-resolved actionType directly instead
// of a whole rule, so this same function also serves describeRunStatus
// below (a past run's own actionType snapshot, not necessarily the
// rule's lastActionType) without a second near-duplicate copy.
function translateAutomationError(actionType: AutomationActionType | null, error: string, lang: Lang): string {
  if (actionType === "send_whatsapp" && KNOWN_WHATSAPP_SEND_ERROR_CODES.has(error)) {
    return resolveErrorMessage(lang, { code: `WHATSAPP_SEND_${error.toUpperCase()}`, error });
  }
  // Round 1080: the send_email counterpart to the send_whatsapp branch
  // above -- see KNOWN_EMAIL_SEND_ERROR_CODES's own doc comment (api.ts).
  if (actionType === "send_email" && KNOWN_EMAIL_SEND_ERROR_CODES.has(error)) {
    return resolveErrorMessage(lang, { code: `EMAIL_SEND_${error.toUpperCase()}`, error });
  }
  // Round 1166: see AUTOMATION_CONFIG_ERROR_CODES's own doc comment
  // (api.ts) -- the whole-rule/whole-record misconfiguration sibling of
  // the two per-send-attempt code sets just above, which never covered
  // these plain-English sentences at all.
  const configCode = AUTOMATION_CONFIG_ERROR_CODES[error];
  if (configCode) {
    return resolveErrorMessage(lang, { code: configCode, error });
  }
  return error;
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
    : t("automations.lastRun.failed", {
        time,
        error: translateAutomationError(rule.lastActionType ?? rule.actionType, rule.lastError ?? "", lang),
      });
}

/**
 * Round 1116: mirrors AutomationsPanel.tsx's own describeRunStatus exactly
 * (see its comment on why a run's own actionType, not the rule's current
 * one, must drive error translation) -- the per-run twin of describeLastRun
 * above, which only ever covers the single most recent outcome.
 */
function describeRunStatus(
  run: AutomationRunView,
  ruleActionType: AutomationActionType,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const time = new Date(run.triggeredAt).toLocaleString(LOCALE[lang]);
  return run.status === "sent"
    ? t("automations.lastRun.sent", { time })
    : t("automations.lastRun.failed", { time, error: translateAutomationError(run.actionType ?? ruleActionType, run.error ?? "", lang) });
}

export function formatAutomationsReport(
  rules: AutomationRuleView[],
  entities: Entity[],
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
  relatedRecords: RelatedRecordsByEntity = {},
  // Round 1116: mirrors searchReport.ts's own expandedSamples param --
  // AutomationsPanel.tsx was the one panel left whose Copy/Download report
  // (round 679, three rounds BEFORE round 682 added the whole run-history
  // feature) only ever showed a rule's single latest outcome
  // (describeLastRun above), never the fuller history a user may have
  // already expanded in the live panel -- data already sitting in React
  // state, zero extra fetch needed to include it here too. Keyed by rule
  // id, exactly like AutomationsPanel.tsx's own runsByRuleId state.
  runsByRuleId: Record<string, AutomationRunView[]> = {},
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
    // Round 959: mirrors AutomationsPanel.tsx's own "paused for today" chip --
    // without this, a schedule rule the server has actually stopped retrying
    // for the rest of today (hasTooManyConsecutiveFailuresToday's cap) would
    // print as plain "Enabled" in a downloaded report, identical to one still
    // actively retrying every minute.
    const status = rule.enabled ? t("automations.status.enabled") : t("automations.status.disabled");
    const statusSuffix = rule.pausedForToday ? `, ${t("automations.status.pausedForToday")}` : "";
    lines.push(`${describeRule(rule, entities, relatedRecords, lang, t)} (${status}${statusSuffix})`);
    lines.push(describeDestination(rule, entities, t));
    // Round 1000: a "send_email" rule's own subject line (round 996,
    // emailSubject) is interpolated and sent completely independently of
    // messageTemplate (the email body) -- required server-side for every
    // send_email rule, yet never appeared anywhere in this report at all
    // before this, silently dropping it from the one artifact meant to
    // be shared/saved for debugging a rule.
    if (rule.actionType === "send_email") {
      lines.push(t("automations.rule.subject", { subject: rule.emailSubject ?? "" }));
    }
    lines.push(rule.messageTemplate);
    lines.push(describeLastRun(rule, lang, t));
    const runs = runsByRuleId[rule.id];
    if (runs && runs.length > 0) {
      lines.push(t("automations.history.heading"));
      for (const run of runs) {
        lines.push(`- ${describeRunStatus(run, rule.actionType, lang, t)}`);
      }
    }
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
