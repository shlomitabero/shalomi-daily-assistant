import type { Project } from "@forge/shared";
import { listRecords, type ForgeDatabase } from "@forge/db";
import { recordDisplayLabel } from "./displayField.js";

/**
 * Phone-number-to-record matching, shared by the WhatsApp Web connection
 * manager (`whatsappWeb.ts`): whenever a message arrives from a WhatsApp
 * number, this looks for the entity record that number belongs to, so the
 * message log can show "דנה לוי" instead of a bare phone number.
 */

/**
 * Mirrors entityFormatting.ts's own DATE_FIELD_NAME_HINTS/
 * BOARD_FIELD_NAME_HINTS convention (a hint array + case-insensitive
 * compare) rather than a single hardcoded name -- the domain library's
 * own entities all happen to name this field exactly "phone", but an
 * AI-generated spec from a freeform idea description has no such
 * guarantee, and a field named "Phone", "mobile", or "phoneNumber" is
 * an entirely plausible, common alternative a real business owner's
 * own description would produce.
 */
const PHONE_FIELD_NAME_HINTS = ["phone", "mobile", "phonenumber", "mobilenumber", "cellphone", "cell", "telephone", "tel"];

/**
 * Keeps only digits, then strips every leading zero -- the local dialing
 * prefix most countries' national format uses (e.g. Israeli
 * "050-123-4567") is *replaced* by the country code in international
 * format ("972501234567"), not merely prefixed with it, so a naive
 * digit-only comparison would never match a real number entered in local
 * format against the same number as WhatsApp delivers it internationally.
 *
 * Stripping *every* leading zero, not just one, also handles the "00"
 * international access code some countries' dialing convention uses
 * (e.g. "00972-50-..." instead of "+972-50-..."): that's a two-digit
 * prefix, not the same one-digit national trunk prefix above, and
 * stripping only one zero left a spurious leading "0" baked into the
 * result. The two cases never combine (a number is either typed in local
 * format with one trunk zero, or in one of the international formats
 * with none), so this is a strict generalization with no new false
 * matches for real phone numbers.
 */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Round 926: normalizePhone's own leading-zero strip only ever catches a
 * trunk zero sitting at the very START of the digit string -- a number
 * stored with BOTH the country code and the local trunk zero still in
 * place (e.g. "+972-050-1234567", an entirely ordinary way for a business
 * owner to type a familiar local number with a country code tacked on the
 * front without remembering to drop the 0) normalizes to "9720501234567",
 * one digit LONGER than the exact same number as WhatsApp actually
 * delivers it ("972501234567") -- the extra "0" sits in the middle, past
 * where normalizePhone's own `/^0+/` can see it, so the plain `endsWith`
 * suffix check below never matches, and that customer's real messages
 * never auto-match their own record, silently, forever.
 *
 * Tries removing exactly one "0" character from `longer` (one position at
 * a time) and checking for EXACT equality with `shorter` -- not just
 * another suffix check -- which is why this stays safe against false
 * positives: two genuinely different numbers would need to be identical
 * in every other digit for a single dropped "0" to produce a false match,
 * which real phone numbers essentially never are. Only tried when the
 * lengths already differ by exactly one, the shape this specific embedded-
 * trunk-zero case always produces.
 */
function matchesWithOneEmbeddedZeroRemoved(shorter: string, longer: string): boolean {
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < longer.length; i++) {
    if (longer[i] === "0" && longer.slice(0, i) + longer.slice(i + 1) === shorter) {
      return true;
    }
  }
  return false;
}

export interface MatchedRecord {
  entityName: string;
  entityLabel: string;
  recordId: number;
  label: string;
}

/**
 * Best-effort match: looks across every entity that has one or more
 * fields whose name matches a common phone-field convention (see
 * PHONE_FIELD_NAME_HINTS -- "phone" is the domain library's own
 * convention, see spec-engine/domainEntities.ts, but "mobile"/
 * "phoneNumber"/etc. are just as plausible from an AI-generated spec),
 * checking EVERY such field on a record, not just the first one found --
 * an entity can plausibly have both e.g. "phone" (an office line) and
 * "mobile" (the number that actually receives WhatsApp messages), and a
 * record whose "mobile" matches the incoming sender must still be found
 * even if its "phone" doesn't, or isn't even set.
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
    const phoneFields = entity.fields.filter((f) => PHONE_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
    if (phoneFields.length === 0) continue;
    const records = listRecords(db, project.id, entity);
    for (const record of records) {
      for (const phoneField of phoneFields) {
        const raw = record[phoneField.name];
        if (typeof raw !== "string" || !raw) continue;
        const normalizedStored = normalizePhone(raw);
        if (!normalizedStored) continue;
        const shorter = normalizedStored.length <= normalizedFrom.length ? normalizedStored : normalizedFrom;
        const longer = normalizedStored.length <= normalizedFrom.length ? normalizedFrom : normalizedStored;
        if (shorter.length >= 7 && (longer.endsWith(shorter) || matchesWithOneEmbeddedZeroRemoved(shorter, longer))) {
          return {
            entityName: entity.name,
            entityLabel: entity.label ?? entity.name,
            recordId: record.id as number,
            label: recordDisplayLabel(entity, record),
          };
        }
      }
    }
  }
  return null;
}
