import type { Entity, EntityRecord, Project } from "@forge/shared";
import {
  getProject,
  insertWhatsAppMessage,
  listEnabledAutomationRulesForEntity,
  recordAutomationRun,
  type AutomationRule,
  type ForgeDatabase,
} from "@forge/db";
import { findMatchingRecord } from "./whatsapp.js";
import type { WhatsAppWebManager } from "./whatsappWeb.js";

/**
 * Interpolates {{fieldName}} placeholders in a message template from a
 * record's own field values, e.g. "Hi {{customerName}}, ..." -- an
 * unmatched placeholder (a typo'd field name, or one removed by a later
 * refine) is left untouched verbatim rather than silently collapsing to
 * an empty string, so a broken template is visible in the sent message
 * instead of reading as grammatically fine but wrong.
 */
export function interpolateTemplate(template: string, record: EntityRecord): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, fieldName: string) => {
    const value = record[fieldName];
    return value === null || value === undefined ? match : String(value);
  });
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
      await fireRule(db, whatsapp, project, rule, record);
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
  const message = interpolateTemplate(rule.messageTemplate, record);
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
