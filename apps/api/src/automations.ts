import type { Entity, EntityRecord, Project } from "@forge/shared";
import {
  getProject,
  getRecord,
  insertWhatsAppMessage,
  listEnabledAutomationRulesForEntity,
  recordAutomationRun,
  type AutomationRule,
  type ForgeDatabase,
} from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { recordDisplayLabel } from "./displayField.js";
import { findMatchingRecord } from "./whatsapp.js";
import type { WhatsAppWebManager } from "./whatsappWeb.js";

type Lang = "he" | "en";
const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };
const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Mirrors entityFormatting.ts's own parseFieldDate: a stored "YYYY-MM-DD"
 * date field parsed at local midnight (not `new Date(value)` directly,
 * which parses as UTC midnight and can print the wrong calendar day for a
 * viewer/recipient behind UTC).
 */
function parseFieldDate(raw: string): Date {
  const match = DATE_FORMAT.exec(raw);
  if (match) {
    const [, yearStr, monthStr, dayStr] = match;
    return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  }
  return new Date(raw);
}

/**
 * Interpolates {{fieldName}} placeholders in a message template from a
 * record's own field values, e.g. "Hi {{customerName}}, ..." -- an
 * unmatched placeholder (a typo'd field name, or one removed by a later
 * refine) is left untouched verbatim rather than silently collapsing to
 * an empty string, so a broken template is visible in the sent message
 * instead of reading as grammatically fine but wrong.
 *
 * `record` must already have every relation field's value resolved to its
 * display-label string (see resolveRelationFieldsForTemplate below) --
 * this function itself never touches the database. Enum (translated
 * label) and boolean (TRUE/FALSE) format the same way
 * entityFormatting.ts's/backup.ts's own fieldDisplayValue does for CSV
 * export, but date/number deliberately do NOT follow fieldDisplayValue's
 * lead of leaving those two raw -- that function's own doc comment
 * explains its raw values exist only so a CSV export/import round-trips
 * exactly (a locale-formatted "1,500"/"1/2/2024" would fail buildImportRecords'
 * re-parse). A WhatsApp message is never re-imported; it's pure one-way
 * human reading, the same situation the on-screen table cell (via
 * formatDateValue/formatNumberValue) is already in, so date/number here
 * follow THAT convention instead -- locale-formatted, using `lang` (no
 * stored per-project language preference exists, so this is picked the
 * same way twin.ts already does via isHebrewText(project.description)).
 */
export function interpolateTemplate(template: string, entity: Entity, record: EntityRecord, lang: Lang): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, fieldName: string) => {
    const value = record[fieldName];
    if (value === null || value === undefined) return match;
    const field = entity.fields.find((f) => f.name === fieldName);
    if (field?.type === "boolean") return value ? "TRUE" : "FALSE";
    if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
    if (field?.type === "date") {
      const date = parseFieldDate(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(LOCALE[lang]);
    }
    if (field?.type === "number") return Number(value).toLocaleString(LOCALE[lang]);
    return String(value);
  });
}

/**
 * A message template's {{fieldName}} placeholder has no way to tell a
 * relation field apart from a text field (the create-rule UI's own hint
 * explicitly invites referencing any field by name) -- but a relation
 * field's own stored, raw value is just the target record's numeric id
 * (see repository.ts's rowToRecord/coerceValue), not anything a real
 * WhatsApp recipient could read. Resolves every relation field on `record`
 * to the same human display label the UI itself would show (falling back
 * to "#<id>" exactly like relationDisplayLabel does when the target entity
 * or record can't be found), so interpolateTemplate above never has to
 * touch the database and stays trivially unit-testable.
 */
function resolveRelationFieldsForTemplate(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  allEntities: Entity[],
  record: EntityRecord,
): EntityRecord {
  const resolved: EntityRecord = { ...record };
  for (const field of entity.fields) {
    if (field.type !== "relation") continue;
    const value = record[field.name];
    if (value === null || value === undefined) continue;
    const targetEntity = field.relationTo ? allEntities.find((e) => e.name === field.relationTo) : undefined;
    const targetRecord = targetEntity ? getRecord(db, projectId, targetEntity, Number(value)) : undefined;
    resolved[field.name] = targetRecord ? recordDisplayLabel(targetEntity!, targetRecord) : `#${value}`;
  }
  return resolved;
}

/**
 * Whether a rule's own trigger matches this particular record create/
 * update. "field_equals" only fires on an update when the matching field
 * was actually part of this update's own payload (changedFields) -- not
 * merely whenever its current value happens to equal the target value --
 * so a rule for status="Delivered" fires once, the moment status is set
 * to "Delivered", not again on every later unrelated edit to that same
 * already-delivered record.
 */
export function matchesTrigger(
  rule: AutomationRule,
  event: "created" | "updated",
  record: EntityRecord,
  changedFields: Set<string>,
): boolean {
  if (rule.trigger === "record_created") {
    return event === "created";
  }
  if (!rule.fieldName) return false;
  if (event === "updated" && !changedFields.has(rule.fieldName)) return false;
  const actual = record[rule.fieldName];
  if (actual === null || actual === undefined) return false;
  return String(actual) === rule.fieldValue;
}

/**
 * Evaluates every enabled automation rule for one entity against a single
 * record create/update, and fires any that match. Deliberately not meant
 * to be awaited inline on the record create/update route's own hot path
 * (see routes/projects.ts's own comment at the call site) -- a WhatsApp
 * send is a real network round-trip, and this side effect must never add
 * latency to, or fail, the record-save response the user is actually
 * waiting on. Every failure mode below (no destination number, not
 * connected, send error, project deleted mid-flight) is caught and
 * recorded on the rule itself via recordAutomationRun, never thrown --
 * this function itself never rejects.
 */
export async function runAutomationsForRecordChange(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  project: Project,
  entity: Entity,
  event: "created" | "updated",
  record: EntityRecord,
  changedFields: Set<string>,
): Promise<void> {
  const rules = listEnabledAutomationRulesForEntity(db, project.id, entity.name);
  for (const rule of rules) {
    if (!matchesTrigger(rule, event, record, changedFields)) continue;
    try {
      await fireRule(db, whatsapp, project, entity, rule, record);
    } catch (err) {
      // Defensive only -- fireRule's own try/catch below already handles
      // every expected failure mode. This exists so a genuinely
      // unexpected error (e.g. a storage error from recordAutomationRun
      // itself) can never escape and crash whatever fire-and-forget
      // caller triggered this, since nothing downstream is awaiting or
      // handling this promise's rejection.
      console.error(`Automation rule ${rule.id} on project ${project.id} failed unexpectedly`, err);
    }
  }
}

async function fireRule(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  project: Project,
  entity: Entity,
  rule: AutomationRule,
  record: EntityRecord,
): Promise<void> {
  const to = rule.toMode === "static" ? rule.toNumber : rule.toField ? record[rule.toField] : null;
  if (!to || typeof to !== "string" || !to.trim()) {
    recordAutomationRun(db, project.id, rule.id, {
      status: "failed",
      error: "This record has no value in the configured phone-number field",
    });
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(db, project.id, rule.id, { status: "failed", error: "WhatsApp is not connected" });
    return;
  }
  const templateRecord = resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record);
  const lang: Lang = isHebrewText(project.description) ? "he" : "en";
  const message = interpolateTemplate(rule.messageTemplate, entity, templateRecord, lang);
  const result = await whatsapp.sendMessage(project.id, to, message);
  // Same re-check-after-await hazard the manual send route already
  // documents (routes/projects.ts's POST .../whatsapp/send) -- sendMessage
  // above is a genuine await (a real network round-trip), during which
  // this project could have been deleted. Without this, insertWhatsAppMessage
  // and recordAutomationRun below would silently recreate rows for a
  // project id that no longer exists.
  if (!getProject(db, project.id)) return;
  const match = project.status === "built" ? findMatchingRecord(db, project, to) : null;
  insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "out",
    fromNumber: status.phoneNumber ?? "",
    toNumber: to,
    body: message,
    matchedEntityName: match?.entityName ?? null,
    matchedRecordId: match?.recordId ?? null,
    matchedLabel: match?.label ?? null,
    status: result.ok ? "sent" : "failed",
  });
  recordAutomationRun(db, project.id, rule.id, {
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : (result.error ?? "Send failed"),
  });
}
