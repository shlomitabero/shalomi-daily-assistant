import type { Project } from "@forge/shared";
import { listRecords, type ForgeDatabase } from "@forge/db";
import { recordDisplayLabel } from "./displayField.js";

/**
 * Phone-number-to-record matching, shared by the WhatsApp Web connection
 * manager (`whatsappWeb.ts`): whenever a message arrives from a WhatsApp
 * number, this looks for the entity record that number belongs to, so the
 * message log can show "דנה לוי" instead of a bare phone number.
 */

const PHONE_FIELD_NAME = "phone";

/**
 * Keeps only digits, then strips a single leading trunk "0" -- the local
 * dialing prefix most countries' national format uses (e.g. Israeli
 * "050-123-4567") is *replaced* by the country code in international
 * format ("972501234567"), not merely prefixed with it, so a naive
 * digit-only comparison would never match a real number entered in local
 * format against the same number as WhatsApp delivers it internationally.
 */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "").replace(/^0/, "");
}

export interface MatchedRecord {
  entityName: string;
  entityLabel: string;
  recordId: number;
  label: string;
}

/**
 * Best-effort match: looks across every entity that has a field literally
 * named "phone" (the domain library's own convention -- see
 * spec-engine/domainEntities.ts) for a record whose phone number
 * normalizes to the same digits as the incoming message's sender.
 * International prefixes (a stored "050-..." vs. an incoming
 * "972 50 ..." from the same real number) are reconciled by comparing
 * digit suffixes, not exact equality -- a genuine, common mismatch this
 * app's own seed data and real phone entry habits both produce. Returns
 * null rather than guessing when nothing matches, which is the normal
 * case for a brand-new contact.
 */
export function findMatchingRecord(db: ForgeDatabase, project: Project, fromNumber: string): MatchedRecord | null {
  const normalizedFrom = normalizePhone(fromNumber);
  if (!normalizedFrom) return null;

  for (const entity of project.spec.entities) {
    const phoneField = entity.fields.find((f) => f.name === PHONE_FIELD_NAME);
    if (!phoneField) continue;
    const records = listRecords(db, project.id, entity);
    for (const record of records) {
      const raw = record[phoneField.name];
      if (typeof raw !== "string" || !raw) continue;
      const normalizedStored = normalizePhone(raw);
      if (!normalizedStored) continue;
      const shorter = normalizedStored.length <= normalizedFrom.length ? normalizedStored : normalizedFrom;
      const longer = normalizedStored.length <= normalizedFrom.length ? normalizedFrom : normalizedStored;
      if (shorter.length >= 7 && longer.endsWith(shorter)) {
        return {
          entityName: entity.name,
          entityLabel: entity.label ?? entity.name,
          recordId: record.id as number,
          label: recordDisplayLabel(entity, record),
        };
      }
    }
  }
  return null;
}
