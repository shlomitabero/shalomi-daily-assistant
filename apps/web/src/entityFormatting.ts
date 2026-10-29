import type { Entity, EntityRecord, Field } from "@forge/shared";
import type { Lang } from "./i18n/language.js";

export const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

// Mirrors the literal "entity.groupBy.yes"/"entity.groupBy.no" translations
// (i18n/language.ts) -- matchesSearch below has no access to the live t()
// translator (it's a plain function, not a component), the same constraint
// BOOLEAN_TRUE_VALUES/BOOLEAN_FALSE_VALUES further down this file already
// work around with their own hardcoded he/en literals.
const BOOLEAN_DISPLAY: Record<Lang, { true: string; false: string }> = {
  he: { true: "כן", false: "לא" },
  en: { true: "Yes", false: "No" },
};

export interface FileFieldValue {
  url: string;
  name: string;
  size: number;
  mimeType: string;
}

// Round 908: the only `url` shape the server itself ever generates for a
// file field (createUploadMiddleware's response, routes/projects.ts) is
// its own /api/uploads/<projectId>/<entityName>/<filename> route -- and
// since round 908, coerceValue (packages/db/src/repository.ts) rejects
// any other shape at write time. This mirrors that same check here, as
// defense-in-depth against a record whose file field was written before
// that guard shipped: both call sites below render `url` as a real,
// clickable `<a href>`/`<img src>` with no scheme check of their own, so
// an un-caught "javascript:..."/"data:..." value would be a stored-XSS
// primitive against whichever collaborator later clicks the file link.
const SAFE_FILE_URL = /^\/api\/uploads\/[^/]+\/[^/]+\/[^/]+$/;

/**
 * A `file` field's stored value is a JSON-encoded descriptor (set by the
 * upload endpoint's response, see api.ts's uploadRecordFile) rather than a
 * plain string like every other field type -- a record freshly created
 * with no file chosen yet, or one from before this field existed, stores
 * "" or null instead, so this returns null rather than throwing on
 * anything that doesn't parse as the expected shape.
 */
export function parseFileFieldValue(value: unknown): FileFieldValue | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(value) as Partial<FileFieldValue>;
    if (typeof parsed.url === "string" && SAFE_FILE_URL.test(parsed.url) && typeof parsed.name === "string") {
      return { url: parsed.url, name: parsed.name, size: Number(parsed.size) || 0, mimeType: String(parsed.mimeType ?? "") };
    }
  } catch {
    // not a file descriptor -- treated as no file, same as an empty value
  }
  return null;
}

/** Whether a file's MIME type is one a browser can render inline as an <img>. */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

const POSITIVE_WORDS = [
  "won",
  "completed",
  "active",
  "paid",
  "delivered",
  "success",
  "qualified",
  "shipped",
  "confirmed",
  "approved",
];
const NEGATIVE_WORDS = [
  "lost",
  "cancelled",
  "canceled",
  "inactive",
  "overdue",
  "no-show",
  "failed",
  "rejected",
  "declined",
  // The built-in InsuranceClaim domain entity's own status enum (see
  // spec-engine/domainEntities.ts) uses "Denied" right alongside "Approved"
  // -- without this, a denied claim showed the same neutral gray badge as
  // "Submitted"/"UnderReview" instead of reading as negative the way
  // "Rejected" already does elsewhere, even though it's exactly as
  // conclusive an outcome as "Approved" is positive.
  "denied",
  // round 458: no built-in entity uses these today, but this function's
  // whole purpose is to also classify freeform AI-generated enum values
  // (see the doc comment below), and every one of these is an ordinary
  // real-world business-status term that contains a POSITIVE_WORDS entry
  // as a literal substring ("unpaid" contains "paid", etc.) -- without
  // being listed here too, each would be misread as POSITIVE, the exact
  // opposite of its meaning, the same "inactive"/"active" shape already
  // handled above.
  "unpaid",
  "undelivered",
  "unconfirmed",
  "unapproved",
  "disapproved",
  "unqualified",
  "disqualified",
  "unshipped",
  // round 872: "success" and "completed" are both POSITIVE_WORDS entries
  // too, and "unsuccessful"/"notcompleted" (the raw, no-space enum-value
  // shape a PascalCase status like "NotCompleted" lowercases to) each
  // contain one as a literal substring, the identical negated-positive-word
  // shape round 458 already fixed for "unpaid"/"undelivered"/etc. "not
  // completed" (with a space) is also listed, since a freeform AI-generated
  // enum value isn't guaranteed to collapse the space the way a PascalCase
  // name would.
  "unsuccessful",
  "notcompleted",
  "not completed",
  // round 873: "won" and "active" are also POSITIVE_WORDS entries, with the
  // exact same negated-word gap -- "notwon"/"not won" each contain "won" as
  // a literal substring, and "notactive"/"not active" (a different, genuine
  // spelling from "inactive" just above, not merely its no-space/space
  // variant) each contain "active". Deal/Opportunity's own built-in
  // "Won"/"Lost" status pair (see spec-engine/domainEntities.ts) makes
  // "Not Won" an obvious variant a user or AI-generated spec would reach
  // for.
  "notwon",
  "not won",
  "notactive",
  "not active",
];

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Mirrors packages/db/src/repository.ts's identical check on the server
 * side: every date field's canonical stored representation is exactly the
 * YYYY-MM-DD shape an <input type="date"> produces, so this accepts that
 * shape and rejects anything else, including a syntactically-shaped but
 * calendrically impossible date like "2024-13-45" (the Date constructor
 * silently rolls an out-of-range month/day over into a *different*, wrong
 * date instead of rejecting it, so the parsed year/month/day are checked
 * back against what was typed). Used by buildImportRecords below to catch
 * a bad date column immediately with a clear per-row message, instead of
 * only finding out from the server's own generic rejection after every
 * row has already been POSTed.
 */
export function isValidDateString(value: string): boolean {
  const match = DATE_FORMAT.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  // Date.UTC(year, ...) silently adds 1900 to a year in 0-99 (legacy
  // ECMA-262 behavior), which would wrongly reject "0099-01-01" -- so the
  // date is built via setUTCFullYear, whose year argument has no such
  // special-casing, instead of passed through Date.UTC.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export type BadgeTone = "positive" | "negative" | "neutral";

/**
 * Classifies a raw enum value into a visual tone for the status-badge
 * rendering in EntityPanel, without needing per-app configuration: the
 * domain library's own enum values (see spec-engine/domainEntities.ts)
 * already use these common English words, so this covers every built-in
 * entity out of the box and degrades gracefully to neutral for anything
 * else (e.g. a freeform value an AI-generated spec introduced).
 */
export function badgeTone(rawValue: string): BadgeTone {
  const lower = rawValue.toLowerCase();
  // Negative words checked FIRST: "inactive" contains "active" as a
  // substring, so checking POSITIVE_WORDS first would classify the
  // built-in Volunteer/DEFAULT_ENTITY "Inactive" status as a positive
  // (green) badge -- the exact opposite of what it means. No other
  // word pair in these two lists has the reverse collision (a positive
  // word being a substring of a negative one), so this ordering alone
  // fixes it without introducing a new false negative elsewhere.
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) return "negative";
  if (POSITIVE_WORDS.some((w) => lower.includes(w))) return "positive";
  return "neutral";
}

/**
 * Formats a stored "YYYY-MM-DD" date field for display; returns the raw
 * value unchanged if it isn't a valid date. Uses parseFieldDate (defined
 * below), not `new Date(value)` directly -- the same UTC-vs-local mismatch
 * fixed in buildCalendarMonth applies here too: `new Date("2026-03-15")`
 * parses as UTC midnight, so toLocaleDateString (which renders in the
 * viewer's *local* time) would print "3/14/2026" instead of "3/15/2026"
 * for any viewer whose local time is behind UTC -- confirmed empirically
 * under TZ=America/New_York.
 */
export function formatDateValue(value: string, lang: Lang): string {
  const date = parseFieldDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(LOCALE[lang]);
}

const DUE_SOON_WINDOW_DAYS = 3;

/**
 * A field only reads as a deadline a record can be "overdue" against if its
 * own name says so -- a date field in general carries no such meaning (a
 * past dateOfBirth/joinedDate/shipDate is normal, not overdue). Mirrors
 * badgeTone's own word-list approach: "due" also matches "dueDate" (the
 * built-in Invoice/Task domain entities' own field name, see
 * domainEntities.ts), "deadline" matches the built-in Task entity's own
 * "deadline" field.
 */
export function isDeadlineFieldName(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return lower.includes("due") || lower.includes("deadline");
}

export type DateUrgency = "overdue" | "dueSoon" | null;

/**
 * Classifies a deadline-like date field's value relative to `today`
 * (defaults to the real current date; a fixed value is passed in tests so
 * the result doesn't depend on when the suite happens to run). Compares
 * calendar days only (via parseFieldDate's own local-midnight construction,
 * the same one formatDateValue uses), not exact timestamps, so a deadline
 * of today itself reads as "dueSoon" rather than "overdue" for the entire
 * day. Returns null for an unparseable value, matching formatDateValue's
 * own fallback behavior of simply not applying any derived styling.
 */
export function getDateUrgency(value: string, today: Date = new Date()): DateUrgency {
  const date = parseFieldDate(value);
  if (Number.isNaN(date.getTime())) return null;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const daysUntil = Math.round((date.getTime() - startOfToday.getTime()) / dayMs);
  if (daysUntil < 0) return "overdue";
  if (daysUntil < DUE_SOON_WINDOW_DAYS) return "dueSoon";
  return null;
}

/**
 * Formats a record's own `createdAt` (a real server-assigned ISO
 * timestamp -- see repository.ts's insertRecord, which always stamps
 * `new Date().toISOString()`) for display. Unlike formatDateValue above,
 * this is a genuine date+time, not a date-only field, so it goes through
 * plain `new Date(value)`/`toLocaleString` rather than parseFieldDate's
 * own YYYY-MM-DD-specific local-midnight construction -- there's no
 * calendar-day ambiguity to correct for here, since a full timestamp
 * already carries a real time-of-day. Every record the real app ever
 * fetches has this value, but a hand-built test fixture may omit it, so
 * a missing or unparseable value returns "" rather than "Invalid Date".
 */
export function formatRecordCreatedAt(createdAt: string | undefined, lang: Lang): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(LOCALE[lang]);
}

/** Adds locale-appropriate thousands separators to a numeric value. */
export function formatNumberValue(value: number, lang: Lang, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(LOCALE[lang], options);
}

/**
 * Sums every `number`-type field across a set of records -- the table
 * view's own totals row, so an invoice-amount or quantity column doesn't
 * require a business owner to manually add it up by eye or a separate
 * calculator. Driven off whatever `records` is passed in (typically the
 * already-filtered/sorted `visibleRecords` the table itself renders), so
 * the totals always reflect the current search/filter, not the whole
 * entity. A missing/non-numeric value on an otherwise-numeric field (an
 * unset field, or bad data) contributes 0 rather than producing `NaN` and
 * silently poisoning the whole column's total.
 */
export function sumNumericFields(records: EntityRecord[], fields: Field[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const field of fields) {
    if (field.type !== "number") continue;
    totals[field.name] = records.reduce((sum, record) => {
      const value = record[field.name];
      return sum + (typeof value === "number" && !Number.isNaN(value) ? value : 0);
    }, 0);
  }
  return totals;
}

/**
 * True if any of the entity's fields on this record contain the search
 * query (case-insensitive). A relation field is matched against its
 * resolved display label (e.g. "Dana Levi"), the same text a table cell
 * actually shows, rather than the raw stored foreign-key id -- otherwise a
 * search for the customer name shown right there on screen finds nothing.
 * `allEntities`/`relatedRecords` are optional so a caller with no relation
 * data on hand yet (or a plain unit test) still gets the previous,
 * id-only behavior instead of a required-but-unavailable argument.
 *
 * A `number` field has the same gap for a different reason: the table cell
 * actually shown on screen (EntityPanel.tsx) renders it through
 * `formatNumberValue`, which adds locale thousands separators (1500 ->
 * "1,500") -- but this matched against the field's own plain `String(value)`
 * ("1500"), so a user typing back the exact digits they can see on screen,
 * comma included, got zero matches for a value they're looking right at.
 * Checked against both the plain and the formatted string (space-joined),
 * so a search for either "1500" or "1,500" still finds the same row.
 *
 * A `date` field had the identical gap, for the identical reason, and was
 * simply missed when the number/relation fix above was made: the table
 * cell (EntityPanel.tsx) renders it through `formatDateValue`, a real
 * locale-formatted string ("2026-03-15" -> "3/15/2026" in en, "15.3.2026"
 * in he) -- but this matched against the raw stored "YYYY-MM-DD" string,
 * so typing back the exact date shown on screen found nothing.
 *
 * A `boolean` field has a related but distinct gap: isGroupableField/
 * findFilterableFields already treat boolean the same as enum for every
 * other "small, fixed value space" UI (the group-by/Kanban column headers
 * and the per-field filter dropdown both show the real localized "Yes"/"No"
 * -- "כן"/"לא" in Hebrew), but this matched the raw stored JS boolean's
 * `String(value)` form ("true"/"false"), text that appears nowhere in the
 * actual UI (the table cell itself renders a checkmark/dash, not even
 * that). Typing "Yes"/"No" (or "כן"/"לא") -- the exact words shown in the
 * adjacent filter dropdown for the same field -- found nothing.
 *
 * A `file` field has the mirror-image gap of the others above: it was
 * missing the branch entirely, so it fell through to the generic
 * `String(value)` fallback -- but a file field's raw stored value is the
 * upload endpoint's own JSON descriptor (`{"url":...,"name":...,"size":
 * ...,"mimeType":...}`), none of which is what the table cell actually
 * shows (just the chosen filename, via parseFileFieldValue -- see
 * fieldDisplayValue's identical `field.type === "file"` branch). This
 * both over-matched (searching "uploads", a mimetype like "pdf", or the
 * raw byte size matched every record with a file, none of which shows
 * any of that on screen) and under-matched (a filename containing a `"`
 * or `\` is JSON-escaped in the raw stored string, so typing back the
 * exact unescaped name shown on screen could still miss).
 */
export function matchesSearch(
  record: EntityRecord,
  fields: Field[],
  query: string,
  allEntities?: Entity[],
  relatedRecords?: RelatedRecordsByEntity,
  lang: Lang = "en",
): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return fields.some((field) => {
    const value = record[field.name];
    if (value === null || value === undefined) return false;
    const display =
      field.type === "enum"
        ? (field.enumLabels?.[String(value)] ?? String(value))
        : field.type === "relation" && allEntities && relatedRecords
          ? relationDisplayLabel(field, value, allEntities, relatedRecords)
          : field.type === "number" && typeof value === "number"
            ? `${value} ${formatNumberValue(value, lang)}`
            : field.type === "date"
              ? `${value} ${formatDateValue(String(value), lang)}`
              : field.type === "boolean"
                ? BOOLEAN_DISPLAY[lang][value ? "true" : "false"]
                : field.type === "file"
                  ? (parseFileFieldValue(value)?.name ?? "")
                  : String(value);
    return display.toLowerCase().includes(trimmed);
  });
}

export interface LinkSegment {
  text: string;
  /** null for plain text; otherwise the real href to render (a URL as-is, or `mailto:<address>` for an email match). */
  href: string | null;
}

// Deliberately excludes ) and ' and " (common sentence-closing punctuation
// right after a URL, e.g. "(see https://example.com)" or a quoted link)
// -- what those exclude, TRAILING_PUNCTUATION_RE below still has to trim
// off characters like a bare trailing "." or "," that this class doesn't
// exclude, since a URL can legitimately end mid-sentence next to one.
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
// A deliberately simple, practical email match (not the full RFC 5322
// grammar) -- good enough for the overwhelmingly common case of a plain
// address typed into a Customer/Vendor "email" field, which is what this
// is actually for.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

interface RawLinkMatch {
  index: number;
  text: string;
  isEmail: boolean;
}

/**
 * Splits `text` into segments so a table cell can render a real, clickable
 * link for any URL or email address embedded in a plain text/longtext
 * field's value (a "Website" or "Email" field on a Customer/Vendor/Lead-
 * shaped entity is extremely common), while leaving the rest as plain
 * text -- mirrors splitHighlightSegments' own "always returns at least one
 * segment, so callers never need a separate no-match branch" contract.
 * Trims common trailing sentence punctuation (".", ",", etc.) off of a
 * matched URL/email into its own plain segment, so "see https://x.com."
 * doesn't turn the sentence's own trailing period into part of the link.
 */
export function splitLinkSegments(text: string): LinkSegment[] {
  const raw: RawLinkMatch[] = [];
  for (const re of [URL_RE, EMAIL_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      raw.push({ index: match.index, text: match[0], isEmail: re === EMAIL_RE });
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  // A URL match can fully contain what would otherwise also look like an
  // email match to EMAIL_RE (e.g. a mailto: link's own address, or a URL
  // with an "@" in its path) -- sort by position, then drop any match that
  // starts inside a still-open, already-accepted one, so each character of
  // `text` is claimed by at most one segment.
  raw.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const accepted: RawLinkMatch[] = [];
  let claimedUntil = -1;
  for (const m of raw) {
    if (m.index < claimedUntil) continue;
    accepted.push(m);
    claimedUntil = m.index + m.text.length;
  }

  const segments: LinkSegment[] = [];
  let lastIndex = 0;
  for (const m of accepted) {
    if (m.index > lastIndex) segments.push({ text: text.slice(lastIndex, m.index), href: null });
    const trailingMatch = TRAILING_PUNCTUATION_RE.exec(m.text);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const core = trailing ? m.text.slice(0, m.text.length - trailing.length) : m.text;
    if (core) {
      segments.push({ text: core, href: m.isEmail ? `mailto:${core}` : core });
    }
    if (trailing) segments.push({ text: trailing, href: null });
    lastIndex = m.index + m.text.length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), href: null });
  return segments.length > 0 ? segments : [{ text, href: null }];
}

export interface HighlightSegment {
  text: string;
  matched: boolean;
}

/**
 * Splits `text` into segments around every case-insensitive occurrence of
 * `query`, so a table cell can render the parts that actually matched the
 * search box (matchesSearch above already tells you *that* a record
 * matched -- this is what lets the table show *where*). Matching is
 * non-overlapping and left-to-right; a blank query (or no match at all)
 * returns the whole text as a single unmatched segment, so callers can
 * always just map over the result without a special empty-query branch.
 */
export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim();
  if (!trimmed) return [{ text, matched: false }];

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), matched: false });
    }
    segments.push({ text: match[0], matched: true });
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex++; // guard against a zero-width match looping forever
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), matched: false });
  }
  return segments.length > 0 ? segments : [{ text, matched: false }];
}

export interface EntitySearchResult {
  entityName: string;
  entityLabel: string;
  totalMatches: number;
  /** Up to `limit` matching records, in the order they were given. */
  sample: EntityRecord[];
}

/**
 * Entity labels aren't guaranteed unique -- ProductSpecSchema only enforces
 * uniqueness on an entity's `name` (findCaseInsensitiveDuplicateEntityNames/
 * findSanitizedIdentifierCollisions), never its display `label` -- so two
 * different entities (e.g. an active-customers table and an
 * archived-customers one) can legally share the same label. Mirrors
 * fieldLabelOccurrences/fieldDisplayLabel just below for fields, and the
 * same entityLabelOccurrences/entityDisplayLabel pair already used by
 * checkpointDiff.ts/twin.ts/pipeline.ts for entities: count how many
 * entities among the given list share each label, then entityDisplayLabel
 * appends an entity's own (always-unique) name whenever its label isn't
 * unique.
 */
export function entityLabelOccurrences(entities: Entity[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const e of entities) {
    const label = e.label ?? e.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

export function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
  const label = entity.label ?? entity.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
}

/**
 * Finds the one entity+field a phone number from an unmatched WhatsApp
 * message should be pre-filled into, when (and only when) the spec makes
 * that unambiguous: exactly one entity across the whole spec has a
 * phone-shaped field. Multiple candidate entities (e.g. both a "Lead" and
 * an "Agent" entity each with their own phone field) have no reliable way
 * to pick the right one from a bare inbound number alone, so this
 * deliberately returns null rather than guessing -- WhatsAppPanel's own
 * "create new record" button simply doesn't render in that case, the
 * same "don't show a control that can't do the right thing" principle
 * readOnly already applies elsewhere in this app. Reuses findPhoneField
 * (below) per entity rather than re-matching PHONE_FIELD_NAME_HINTS here.
 */
export function findSinglePhoneFieldTarget(entities: Entity[]): { entityName: string; fieldName: string } | null {
  const candidates: { entityName: string; fieldName: string }[] = [];
  for (const entity of entities) {
    const field = findPhoneField(entity.fields);
    if (field) candidates.push({ entityName: entity.name, fieldName: field.name });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Filters one entity's already-fetched records against a global search
 * query -- the building block for project-wide search across every entity
 * tab at once, reusing the exact same match rule `matchesSearch` uses
 * per-tab so "found here" and "found everywhere" never disagree. Returns
 * null for an empty query or when nothing in this entity matched, so a
 * caller can simply filter out the nulls rather than special-casing "no
 * results" per entity.
 *
 * entityLabel is disambiguated against `allEntities` (when given) via
 * entityDisplayLabel, so Global Search's own per-entity result-group header
 * never renders two indistinguishable groups for two entities that happen
 * to share a label -- the same way `matchesSearch` already uses
 * `allEntities` to resolve a relation field to its related record's label.
 */
export function searchEntityRecords(
  entity: Entity,
  records: EntityRecord[],
  query: string,
  limit = 5,
  allEntities?: Entity[],
  relatedRecords?: RelatedRecordsByEntity,
  lang: Lang = "en",
): EntitySearchResult | null {
  if (!query.trim()) return null;
  const matches = records.filter((r) => matchesSearch(r, entity.fields, query, allEntities, relatedRecords, lang));
  if (matches.length === 0) return null;
  return {
    entityName: entity.name,
    entityLabel: allEntities ? entityDisplayLabel(entity, entityLabelOccurrences(allEntities)) : (entity.label ?? entity.name),
    totalMatches: matches.length,
    sample: matches.slice(0, limit),
  };
}

export type SortDirection = "asc" | "desc";

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/**
 * A relation field's own stored value is a foreign-key id, but the column
 * sorts on the label shown in the cell (e.g. "Dana Levi") -- otherwise
 * clicking that header sorts by an internal number no one can see, which
 * looks broken/random. Mirrors matchesSearch's own optional
 * `fields`/`allEntities`/`relatedRecords` params (round 271): a caller
 * with no relation data on hand (or a plain unit test) still gets the
 * previous, raw-value sort instead of a required-but-unavailable argument.
 *
 * An enum field has the same gap for the same reason: the table cell
 * (EntityPanel.tsx) renders `field.enumLabels?.[value] ?? value` -- the
 * translated/human label, not the raw stored enum value -- and
 * matchesSearch already resolves it the same way, but this function never
 * did, so clicking an enum column's header sorted by the raw value instead
 * (e.g. English codes like "P1"/"P2"/"P3" instead of the Hebrew labels
 * shown on screen), landing rows in an order unrelated to what's visible.
 * Unlike relation, this only ever needs `fields` -- an enum's label comes
 * straight from the field definition, no relatedRecords/allEntities to
 * resolve against.
 *
 * A file field has the identical gap: its stored value is the JSON upload
 * descriptor (parseFileFieldValue), but the cell renders just the filename
 * (EntityPanel.tsx's Cell, "file" branch) -- without this, clicking the
 * column header sorts by the descriptor string (dominated by each upload's
 * random url segment), landing rows in an order unrelated to what's shown.
 * Mirrors fieldDisplayValue's own identical "file" branch (CSV export).
 */
function resolveSortValue(
  fieldName: string,
  value: unknown,
  fields?: Field[],
  allEntities?: Entity[],
  relatedRecords?: RelatedRecordsByEntity,
): unknown {
  const field = fields?.find((f) => f.name === fieldName);
  if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? value;
  if (field?.type === "file") return parseFileFieldValue(value)?.name ?? "";
  if (field?.type !== "relation" || !allEntities || !relatedRecords) return value;
  return relationDisplayLabel(field, value, allEntities, relatedRecords);
}

/** Sorts a copy of `records` by `field.name`; returns `records` unchanged (same reference) when `sortField` is null. */
export function sortRecords(
  records: EntityRecord[],
  sortField: string | null,
  direction: SortDirection,
  fields?: Field[],
  allEntities?: Entity[],
  relatedRecords?: RelatedRecordsByEntity,
): EntityRecord[] {
  if (!sortField) return records;
  // Negates the comparator's own result for "desc" rather than sorting
  // ascending then reversing the whole array -- the same fix
  // sortRecordsMulti's own doc comment below already describes: reversing
  // the full array also flips the relative order of any tied pair, which
  // breaks the sort's stability (two records with an equal sort value no
  // longer keep their original relative order in "desc").
  return [...records].sort((a, b) => {
    const cmp = compareValues(
      resolveSortValue(sortField, a[sortField], fields, allEntities, relatedRecords),
      resolveSortValue(sortField, b[sortField], fields, allEntities, relatedRecords),
    );
    return direction === "desc" ? -cmp : cmp;
  });
}

export interface SortKey {
  field: string;
  direction: SortDirection;
}

/**
 * Sorts a copy of `records` by several fields in priority order -- each
 * key after the first only breaks ties the ones before it left standing
 * (e.g. sort by "status", then by "total" among same-status records).
 * Unlike `sortRecords`, direction is applied per-key inside the
 * comparator rather than by reversing the whole result afterward:
 * reversing at the end would also flip the tie-break order of any earlier
 * key, which is wrong whenever two keys don't share the same direction.
 * Returns `records` unchanged (same reference) when `sortKeys` is empty.
 */
export function sortRecordsMulti(
  records: EntityRecord[],
  sortKeys: SortKey[],
  fields?: Field[],
  allEntities?: Entity[],
  relatedRecords?: RelatedRecordsByEntity,
): EntityRecord[] {
  if (sortKeys.length === 0) return records;
  return [...records].sort((a, b) => {
    for (const { field, direction } of sortKeys) {
      const cmp = compareValues(
        resolveSortValue(field, a[field], fields, allEntities, relatedRecords),
        resolveSortValue(field, b[field], fields, allEntities, relatedRecords),
      );
      if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

const BOARD_FIELD_NAME_HINTS = ["status", "stage"];

/**
 * Every enum field with a workable, human-scannable number of distinct
 * values (2-8) -- the same predicate findBoardField below uses to pick its
 * single Kanban-grouping field, but here returning *all* of them, not just
 * one. Used by EntityPanel's own per-field filter dropdowns: an entity with
 * two or more such fields (e.g. a Task with both "Status" and "Priority")
 * previously only ever got a filter for whichever one findBoardField
 * happened to pick, with no way to narrow the table by any other enum
 * field -- the free-text search box matches every field as a substring
 * (including relations), so it can't target one specific field's exact
 * value the way this dropdown does.
 */
export function findFilterableEnumFields(fields: Field[]): Field[] {
  return fields.filter((f) => f.type === "enum" && f.enumValues && f.enumValues.length >= 2 && f.enumValues.length <= 8);
}

/**
 * Every field EntityPanel's own per-field filter dropdown should offer --
 * findFilterableEnumFields's own enum fields, plus every boolean field.
 * isGroupableField (above) already treats enum and boolean as the same
 * "small fixed value space" category for table *grouping*; this toolbar
 * *filter* grew out of the same enum-only predicate findBoardField uses
 * (round 286) and never widened to match, even though a boolean field's
 * two values (Yes/No) are exactly the kind of workable, human-scannable
 * value space the filter was built for -- a person with an "IsActive" or
 * "IsBillable" field could group the table by it but never narrow it down
 * to just the true (or false) rows. findFilterableEnumFields itself is
 * left untouched since findBoardField (Kanban column grouping, inherently
 * a different, enum-shaped question) depends on its exact enum-only scope.
 *
 * A relation field is just as fixed-value-space as an enum -- its options
 * are exactly the related entity's current records -- but had no filter
 * dropdown at all: the free-text search box matches a relation by its
 * resolved display label as a substring, which can't target "exactly this
 * customer" the way an exact-match dropdown does (and over-matches any
 * other field whose text happens to contain the same substring). Only
 * offered once allEntities/relatedRecords confirm the relation actually
 * resolves to a loaded set of records -- the same "resolvable" guard
 * buildImportRecords/FieldInput already use for a relation field, so a
 * stale relationTo pointing at a deleted entity, or data that hasn't
 * finished loading yet, never offers a filter with nothing real to pick.
 */
export function findFilterableFields(fields: Field[], allEntities?: Entity[], relatedRecords?: RelatedRecordsByEntity): Field[] {
  // Round 1178: case-insensitive, mirroring relationDisplayLabel's own
  // round-1162 fix -- without it, a relation field whose relationTo
  // differed from its target entity's current name only by letter case
  // was never even offered in the toolbar's own filter dropdown, even
  // though relatedRecords (keyed by the same raw relationTo string) was
  // already loaded and ready to filter against.
  const relationFields = fields.filter(
    (f) => f.type === "relation" && f.relationTo && allEntities?.some((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase()) && relatedRecords?.[f.relationTo],
  );
  return [...findFilterableEnumFields(fields), ...fields.filter((f) => f.type === "boolean"), ...relationFields];
}

/**
 * Picks the enum field an entity's records should be grouped into columns
 * by, if any -- this is what turns a "Deal" or "Order" entity into a real
 * Kanban board instead of the same table shape every entity gets. Prefers
 * a field literally named "status"/"stage" (the domain library's own
 * convention, see spec-engine/domainEntities.ts), then falls back to the
 * first qualifying enum field (see findFilterableEnumFields); returns null
 * when nothing fits, so a plain entity (like "Customer" with only a text
 * "name" field) never gets forced into a board it doesn't suit. A board
 * still groups by exactly one field -- that's inherent to what a Kanban
 * board is -- unlike the filter dropdowns above, which cover every
 * qualifying field at once.
 */
export function findBoardField(fields: Field[]): Field | null {
  const enumFields = findFilterableEnumFields(fields);
  if (enumFields.length === 0) return null;
  const named = enumFields.find((f) => BOARD_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named ?? enumFields[0];
}

export interface BoardColumn {
  value: string;
  label: string;
  records: EntityRecord[];
  /** True only for the trailing synthetic "(other)" column -- see below. */
  isOther?: boolean;
}

/**
 * FieldSchema.enumValues has no uniqueness constraint (and deliberately
 * isn't given one -- tightening ProductSpecSchema itself would make an
 * already-stored project/checkpoint with this defect fail to parse from
 * now on, too high a cost for what's only a cosmetic/grouping bug, not
 * data corruption). The realistic way a real project ends up with a
 * duplicate is an AI-generated spec, since nothing else in this app ever
 * edits enumValues directly. Every enum <select> in EntityPanel.tsx keys
 * its <option> by the raw value, so an unreconciled duplicate renders the
 * same choice twice; groupByField/groupRecordsByField below are worse --
 * each duplicate value became its own column/group with the exact same
 * `records.filter(...)` result, so a board or "group by" view silently
 * duplicated every matching record's card/row across two identical
 * columns. De-duping here, once, order-preserving, fixes all three
 * shapes of the same root cause without touching the schema or any
 * stored data.
 */
export function uniqueEnumValues(values: string[] | undefined): string[] {
  return Array.from(new Set(values ?? []));
}

/**
 * The "(other)" overflow bucket groupByField/groupRecordsByField add for a
 * record's legacy/unrecognized value needs its own key, distinct from every
 * real declared enum value -- FieldSchema.enumValues has no restriction on
 * its contents (see uniqueEnumValues' own doc comment on the sibling
 * duplicate-values gap), so a spec can legitimately declare "__other__"
 * itself as a real enum value. Without this, that real column and the
 * synthetic overflow column collided on the identical key -- same React
 * list key, same entry in EntityPanel.tsx's collapsedBoardColumns Set --
 * so collapsing one silently collapsed the other too. Appending underscores
 * until the key no longer matches anything in enumValues guarantees no
 * collision, for any finite set of declared values.
 */
function otherGroupKey(enumValues: string[] | undefined): string {
  const known = new Set(enumValues ?? []);
  let key = "__other__";
  while (known.has(key)) key += "_";
  return key;
}

/**
 * Groups records into one column per declared enum value, in the enum's
 * own declared order (not first-seen order) -- including a value with zero
 * matching records, so an empty stage still shows as a column rather than
 * silently disappearing.
 *
 * A record whose stored value isn't in the field's current enumValues (e.g.
 * a legacy value left behind after an AI refine renamed/restructured the
 * field's options -- migrate.ts only ever adds columns, it never rewrites
 * existing row data) used to simply vanish from the board with no trace,
 * while still showing up fine in Table/Calendar views. It's now collected
 * into a trailing "(other)" column instead, mirroring the same bucket
 * groupRecordsByField below already uses for table-view grouping. `t` is
 * optional so existing callers that only care about real enum columns don't
 * need to pass a translator.
 */
export function groupByField(
  records: EntityRecord[],
  field: Field,
  t?: (key: string) => string,
): BoardColumn[] {
  const values = uniqueEnumValues(field.enumValues);
  const columns: BoardColumn[] = values.map((value) => ({
    value,
    label: field.enumLabels?.[value] ?? value,
    records: records.filter((r) => String(r[field.name]) === value),
  }));
  const known = new Set(values);
  const other = records.filter((r) => !known.has(String(r[field.name] ?? "")));
  if (other.length > 0) {
    columns.push({
      value: otherGroupKey(field.enumValues),
      label: t ? t("entity.groupBy.other") : "Other",
      records: other,
      isOther: true,
    });
  }
  return columns;
}

const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduleddate", "eventdate", "duedate", "startdate"];

/**
 * Picks the date field an entity's records should be plotted on a calendar
 * by, if any -- this is what turns an "Appointment" entity into a real
 * month view instead of the same table shape every entity gets. Prefers a
 * field literally named "date" (the domain library's own convention) or a
 * few other common date-ish names, then falls back to the first date
 * field; returns null for an entity with no date field at all.
 *
 * "startdate" (round 573) is in this list for the same reason "enddate" is
 * in END_DATE_FIELD_NAME_HINTS below: without it, a startDate/endDate pair
 * (the domain library's own Rental entity, and any AI-generated spec using
 * that same convention) only picked startDate as the start field by luck
 * of field-declaration order -- an entity declaring endDate before
 * startDate silently picked endDate instead, losing the whole date range.
 */
export function findDateField(fields: Field[]): Field | null {
  const dateFields = fields.filter((f) => f.type === "date");
  if (dateFields.length === 0) return null;
  const named = dateFields.find((f) => DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named ?? dateFields[0];
}

const END_DATE_FIELD_NAME_HINTS = ["enddate", "returndate", "checkoutdate", "untildate", "todate"];

/**
 * Picks the field that pairs with `startField` as a date *range*'s own end,
 * if the entity has one -- the built-in domain library's own "Rental"
 * entity (startDate/endDate) is exactly the shape this exists for: without
 * it, a 5-night rental only ever appeared on the calendar on its first day,
 * and exporting it to a real calendar app produced a single-day event that
 * silently lost the whole point of knowing when the item comes back.
 * Matches by name hint only (the same simple convention DATE_FIELD_NAME_HINTS,
 * PHONE_FIELD_NAME_HINTS, and DISPLAY_FIELD_NAME_HINTS in this file already
 * use), among the entity's OTHER date fields -- never matches startField
 * back to itself. Returns null for an entity with no such pairing, which is
 * the overwhelmingly common case (a plain point-in-time "Appointment" has
 * no end date, and must keep behaving exactly as before).
 */
export function findEndDateField(fields: Field[], startField: Field): Field | null {
  const otherDateFields = fields.filter((f) => f.type === "date" && f.name !== startField.name);
  return otherDateFields.find((f) => END_DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase())) ?? null;
}

// Mirrors apps/api/src/whatsapp.ts's own PHONE_FIELD_NAME_HINTS exactly (a
// duplicated constant, not a shared import -- the same live/exported-app
// duplication convention DATE_FIELD_NAME_HINTS above already follows).
// Matches by field name only, not type: the domain library's own phone
// fields are plain "text" fields, and an AI-generated spec has no
// dedicated "phone" field type to check against.
const PHONE_FIELD_NAME_HINTS = ["phone", "mobile", "phonenumber", "mobilenumber", "cellphone", "cell", "telephone", "tel"];

/**
 * Picks the field a "Send WhatsApp" row action should read a record's
 * number from, if the entity has one -- the client-side counterpart to
 * whatsapp.ts's own findMatchingRecord, which already does this same
 * name-hint match server-side for the opposite (inbound message ->
 * record) direction.
 */
export function findPhoneField(fields: Field[]): Field | null {
  return fields.find((f) => PHONE_FIELD_NAME_HINTS.includes(f.name.toLowerCase())) ?? null;
}

/**
 * Picks the actual phone NUMBER a "Send WhatsApp" row action should use for
 * one specific record -- unlike findPhoneField above (which names a single
 * FIELD for the whole entity, by declaration order only), a record can
 * have ITS OWN phone-like field left blank while a sibling phone-like
 * field on that same record holds a real number (e.g. an entity with both
 * "phone", an office line, and "mobile", the number that actually receives
 * WhatsApp messages -- an entirely ordinary real-world combination).
 * Before this, the "Send WhatsApp" button read only the one field
 * findPhoneField happened to pick for the whole entity, so a record whose
 * office line was blank hid the button entirely even when its own mobile
 * number was right there. Checks every phone-like field on the entity, in
 * declaration order, and returns the first one that actually has a
 * non-empty value on THIS record -- the same "check every candidate field,
 * not just the first" fix round 774 already made to whatsapp.ts's own
 * findMatchingRecord for the opposite (inbound message -> record)
 * direction.
 */
export function findRecordPhoneNumber(fields: Field[], record: EntityRecord): string | null {
  for (const field of fields) {
    if (!PHONE_FIELD_NAME_HINTS.includes(field.name.toLowerCase())) continue;
    const value = record[field.name];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Picks the field the calendar view's day-chip should show as a record's
 * label -- reuses `pickDisplayField`'s own "name"/"title", then first text
 * field" preference (the same rule the table/board views use for a
 * record's label) rather than just grabbing whichever field happens to
 * come first after the date field in the entity's declaration. The two
 * only disagreed for a hand-built test entity, never yet for the built-in
 * domain library (every entry there happens to declare its identifying
 * field before its date field), but an AI-generated spec has no such
 * guarantee, so the calendar chip could otherwise show a boolean, a
 * status, or a foreign-key id instead of a name.
 *
 * Round 778: the last-resort fallback below used to grab the first OTHER
 * field with no type filtering at all -- reachable when `pickDisplayField`
 * itself returns `dateField` (an entity with no name/title/text/longtext
 * field, where the date field happens to be the first field that isn't
 * `relation`/`file`, e.g. `CheckIn { date: date, location: relation,
 * confirmed: boolean }`). In that case the unfiltered fallback could land
 * on a `relation` field -- rendering a raw related-record id (or a blank
 * chip when null) instead of any real label -- or a `file` field, leaking
 * the raw upload descriptor. `pickDisplayField` itself already excludes
 * both types at every one of its own fallback steps for exactly this
 * reason; this fallback now mirrors that same exclusion instead of
 * reintroducing the hazard one function away.
 */
export function calendarChipLabelField(entity: Entity, dateField: Field): Field {
  const preferred = pickDisplayField(entity);
  if (preferred && preferred.name !== dateField.name) return preferred;
  return (
    entity.fields.find((f) => f.name !== dateField.name && f.type !== "relation" && f.type !== "file") ?? dateField
  );
}

/**
 * Resolves calendarChipLabelField's own chosen field to the actual string
 * the live calendar view's day-chip should display for one record --
 * before this, the chip rendered the raw stored value with ZERO type
 * awareness (not even enum, unlike calendarIcs.ts's own SUMMARY line,
 * which round 274 already made enum-aware). A `boolean` display field
 * (e.g. `Consent.signed`, the same no-name/title/text shape round 771
 * fixed for recordDisplayLabel) showed lowercase "true"/"false" instead of
 * this codebase's own uniform "TRUE"/"FALSE" convention; an `enum` display
 * field showed its raw stored key instead of its translated enumLabel.
 *
 * Round 1048: a `date` display field (calendarChipLabelField's own
 * last-resort fallback excludes only `relation`/`file`, same as
 * `pickDisplayField` -- an entity with two+ date fields and no name/
 * title/text/longtext field, e.g. `Flight { departureDate: date,
 * returnDate: date, confirmed: boolean }`, lands here with `returnDate`
 * as the label field for `departureDate`'s own calendar placement)
 * rendered the raw unformatted "YYYY-MM-DD" string instead of a real
 * formatted date -- reuses formatDateValue, this file's own established
 * date-display convention everywhere else a date field is shown to a
 * person (the record form/table), rather than inventing a new one.
 */
export function calendarChipLabelValue(labelField: Field, record: EntityRecord, lang: Lang): string {
  const value = record[labelField.name];
  if (value === null || value === undefined) return "";
  if (labelField.type === "boolean") return value ? "TRUE" : "FALSE";
  if (labelField.type === "enum") return (labelField.enumLabels && labelField.enumLabels[String(value)]) || String(value);
  if (labelField.type === "date" && typeof value === "string") return formatDateValue(value, lang);
  return String(value);
}

export interface CalendarDay {
  /** Midnight, local time, for this cell's date. */
  date: Date;
  inCurrentMonth: boolean;
  records: EntityRecord[];
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whether two dates fall in the same calendar month+year -- used to disable the calendar view's own "Today" button once it's already showing the current month, instead of leaving a pointless no-op click available. */
export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * A stored date field is always the plain "YYYY-MM-DD" shape (see
 * isValidDateString above) -- `new Date("2024-01-15")` parses that as UTC
 * midnight, per the date-only form in the Date Time String Format spec,
 * while the calendar grid's own cells (gridStart/date below) are built with
 * `new Date(year, month, day)`, i.e. *local* midnight. Comparing the two
 * with local getters (getFullYear/getMonth/getDate) then silently shifts a
 * record back by one calendar day for any viewer whose local time is
 * behind UTC (most of the Americas) -- confirmed empirically under
 * TZ=America/New_York. Parsing the YYYY-MM-DD components directly into a
 * *local* Date, the same construction the grid cells use, keeps both sides
 * in the same timezone so the comparison means what it looks like it means.
 */
export function parseFieldDate(raw: string): Date {
  const match = DATE_FORMAT.exec(raw);
  if (match) {
    const [, yearStr, monthStr, dayStr] = match;
    return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  }
  return new Date(raw);
}

/**
 * Builds a fixed 6-week (42-day) month grid for `month` (0-indexed, JS Date
 * convention) of `year`, starting on the Sunday on/before the 1st and
 * ending on the Saturday on/after the last day -- the standard calendar-UI
 * shape, including the leading/trailing days from adjacent months so every
 * week is a full row. Each day carries the records whose `field` value
 * falls on that calendar date; a record with an unparseable date value is
 * simply never matched, not an error.
 *
 * When `endField` is given, a record also matches every day strictly
 * between its start and end (inclusive) instead of only its start day -- so
 * a 5-night Rental shows up across its whole stay, not just check-in. A
 * record whose end is missing/unparseable, or earlier than its own start
 * (an invalid range), falls back to the plain single-day start match.
 */
export function buildCalendarMonth(
  records: EntityRecord[],
  field: Field,
  year: number,
  month: number,
  endField?: Field | null,
): CalendarDay[] {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dayRecords = records.filter((r) => {
      const raw = r[field.name];
      if (raw === null || raw === undefined || raw === "") return false;
      const startDate = parseFieldDate(String(raw));
      if (Number.isNaN(startDate.getTime())) return false;
      if (endField) {
        const rawEnd = r[endField.name];
        if (rawEnd !== null && rawEnd !== undefined && rawEnd !== "") {
          const endDate = parseFieldDate(String(rawEnd));
          if (!Number.isNaN(endDate.getTime()) && endDate.getTime() >= startDate.getTime()) {
            return date.getTime() >= startDate.getTime() && date.getTime() <= endDate.getTime();
          }
        }
      }
      return isSameDay(startDate, date);
    });
    days.push({ date, inCurrentMonth: date.getMonth() === month, records: dayRecords });
  }
  return days;
}

const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];

/**
 * Picks the field that best represents one of an entity's records as a
 * short human label -- this is what lets a relation field show "Dana Levi"
 * in a picker/cell instead of a raw foreign-key id. Prefers a field
 * literally named "name"/"title" (the domain library's own convention),
 * then falls back to the first text field, then to the entity's first
 * non-relation field of any other type, then -- only if literally every
 * field is itself a relation -- the first field regardless; returns null
 * only for an entity with no fields at all.
 *
 * A join/line-item entity (e.g. `Enrollment { studentId: relation,
 * courseId: relation, grade: enum }`) can legitimately have no name/
 * title/text field at all -- `EntitySchema` only requires at least one
 * field, nothing requires a text one. Without the relation exclusion in
 * this last-resort step, recordDisplayLabel would render the *related*
 * record's own raw internal id (e.g. "4") as this record's own label
 * everywhere a record is shown by name -- a relation field's own <option>
 * list, CSV export/import's relation-cell matching, the "Group by"/filter
 * dropdowns' own labels -- indistinguishable from every other record
 * pointing at the same related row.
 *
 * Round 749: the last-resort step also excludes `file` for the exact same
 * reason -- a document-centric join entity like `Enrollment { studentId:
 * relation, courseId: relation, certificate: file }` has no name/title/
 * text field either, and without this exclusion recordDisplayLabel would
 * String() the file's raw JSON upload descriptor ({url,name,size,
 * mimeType}) as this record's own label.
 *
 * Round 762: the "first text field" step also tries `longtext` as a
 * second choice (never a tiebreak over a real `text` field -- a plain
 * `text` field found anywhere still wins, matching every other "free-
 * text field" convention in this codebase: AutomationsPanel.tsx's
 * phoneFields, pipeline.ts's seed-value check, validateAutomationToField,
 * migrate.ts's type_changed branch -- all treat text/longtext as the same
 * free-text kind). An entity like `Feedback { message: longtext, rating:
 * number, submittedDate: date }` has no name/title/text field, and without
 * this, the last-resort step below would land on `rating` (a plain
 * number) instead of `message` -- labeling every record by its numeric
 * rating instead of its actual feedback text.
 *
 * Round 793: the name-hint step itself also excludes `relation`/`file`
 * now, for the identical reason the last-resort step already excludes
 * them -- a field can legitimately be named "title" or "name" while being
 * a relation (e.g. `Employee { title: relation->JobTitle }`, a normalized
 * job-title lookup) or a file (e.g. `Document { name: file }`, an
 * uploaded file whose own field happens to be called "name"). Without
 * this exclusion, that field won by name alone before the type-aware
 * fallback steps ever ran, and recordDisplayLabel below would String() a
 * relation's raw foreign-key id or a file's raw JSON upload descriptor as
 * the record's own label -- the exact hazard this function's later steps
 * already guard against, just reachable one step earlier than they catch.
 */
export function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find(
    (f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()) && f.type !== "relation" && f.type !== "file",
  );
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text") ?? entity.fields.find((f) => f.type === "longtext");
  if (firstText) return firstText;
  const firstDisplayable = entity.fields.find((f) => f.type !== "relation" && f.type !== "file");
  return firstDisplayable ?? entity.fields[0] ?? null;
}

/**
 * Renders one record of `entity` as a short human label using its display
 * field, falling back to "#<id>" when the entity has no usable field or the
 * display field is empty on this particular record. When the picked field
 * is an `enum` (e.g. the last-resort fallback above landing on one, for a
 * join entity with no name/title/text field), resolves it through the
 * field's own `enumLabels` the same way every other enum render path in
 * this file already does (fieldDisplayValue, matchesSearch, etc.) --
 * without this, a record shown by this label elsewhere (a relation
 * picker, Business Twin's narrative sentences) would show the field's raw
 * stored value (e.g. the English enum key "in") instead of its translated
 * display text (e.g. "כניסה").
 *
 * Round 968: the SAME last-resort fallback can also land on a `relation`
 * field -- a pure join/many-to-many entity like `Membership { userId:
 * relation->User, groupId: relation->Group }` has no name/title/text/enum
 * field at all, only relations, so pickDisplayField's own final step picks
 * one regardless ("there's nothing else left to show" -- see its own doc
 * comment). Falling through to `String(value)` here would render that
 * field's raw *target* foreign-key id as if it uniquely identified THIS
 * record -- but it doesn't: every other Membership row for the same user
 * (a different group) shares that exact same userId, so two genuinely
 * different records would render the exact same bare digits (e.g. "4"),
 * indistinguishable in a relation picker's own <option> list, CSV export's
 * relation-cell matching, or a WhatsApp template. Falling back to
 * `#${record.id}` instead -- this record's OWN id, not the relation
 * field's target id -- is always unique per record, exactly matching the
 * same "#<id>" convention this function already uses one line above for
 * a genuinely empty value.
 */
export function recordDisplayLabel(entity: Entity, record: EntityRecord, lang: Lang = "en"): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  if (field?.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  // Round 1072: the SAME last-resort fallback can also land on a `date`
  // field -- an entity with no name/title/text/longtext field, e.g.
  // `DailyLog { loggedAt: date, temperature: number }`, has pickDisplayField
  // fall through to its own final step and pick the date field regardless.
  // Falling through to `String(value)` here would render the raw
  // unformatted "YYYY-MM-DD" string as this record's own label everywhere
  // a record is shown by name (a relation picker/cell, Global Search,
  // Business Twin's narrative sentences, a WhatsApp/email/webhook
  // automation's own message interpolation) -- the exact bug rounds
  // 1048-1071 already fixed for the calendar view's own chip-label
  // functions, never audited for this far more pervasive sibling.
  if (field?.type === "date" && typeof value === "string") return formatDateValue(value, lang);
  if (field?.type === "relation") return `#${record.id}`;
  // Round 982: the SAME last-resort fallback can also land on a `file`
  // field -- an attachment/join entity like `Enrollment { certificate:
  // file, studentId: relation->Student }` has no name/title/text/enum
  // field at all, only a file and a relation, so pickDisplayField's own
  // final step picks whichever was declared first regardless (its own
  // doc comment already calls this hazard out, but only ever fixed the
  // EXCLUSION above, not this safety net). Falling through to
  // `String(value)` here would String() the file's raw JSON upload
  // descriptor (`{"url":...,"name":...,"size":...,"mimeType":...}`,
  // including the server's internal upload path) as the record's own
  // label -- everywhere a record is shown by name (Global Search, a
  // relation picker, CSV export/import's relation-cell matching, an
  // Automation Rule's condition display). `#${record.id}` matches the
  // exact same fallback the relation branch just above already uses, for
  // the identical reason: always unique per record, unlike the file's own
  // name (routinely reused across unrelated uploads).
  if (field?.type === "file") return `#${record.id}`;
  return String(value);
}

/** Related records for a relation field's target entity, keyed by that entity's name. */
export type RelatedRecordsByEntity = Record<string, EntityRecord[]>;

/**
 * relationDisplayLabel is called once per relation field per row -- a
 * table of N records with a relation field pointing at an entity with M
 * records calls it N times, and every call used to `records.find(...)` a
 * full linear scan of that *entire* M-length array, O(N*M) total (see
 * round 385's identical fix for backup.ts's own copy of this exact
 * pattern). Unlike backup.ts, no single call site here owns "the whole
 * operation" to build an index once up front -- this function is called
 * from many independent places (table/board/calendar cell rendering, CSV
 * export, global search, sorting) across EntityPanel.tsx, calendarIcs.ts,
 * and this file itself. Rather than threading a pre-built index through
 * every one of those call sites, this caches the id->record Map per
 * *array instance* in a WeakMap: `relatedRecords[entityName]` is fetched
 * once per data refresh (see EntityPanel.tsx's own `relatedRecords`
 * state) and that exact same array reference is then passed to every
 * call within that refresh cycle, so the first call pays the O(M) cost
 * of building the index and every subsequent call against the same
 * array is O(1) -- turning the whole render/export pass into O(N+M)
 * without changing this function's signature or any caller at all. The
 * WeakMap keys on the array object itself, so a later data refresh that
 * replaces the array (a genuinely new reference) naturally invalidates
 * the cache instead of ever serving stale results, and the old entry is
 * garbage-collected once nothing else references that array.
 */
const relationIndexCache = new WeakMap<EntityRecord[], Map<number, EntityRecord>>();
function relationIndexFor(records: EntityRecord[]): Map<number, EntityRecord> {
  let index = relationIndexCache.get(records);
  if (!index) {
    index = new Map(records.map((r) => [Number(r.id), r]));
    relationIndexCache.set(records, index);
  }
  return index;
}

/**
 * Resolves a relation field's stored id into the human label it should
 * display, using whichever related entity/records are available -- the
 * related entity may legitimately be absent from this project's spec (an
 * optional relation whose target wasn't part of the description), in which
 * case this degrades to the raw id rather than throwing.
 */
export function relationDisplayLabel(
  field: Field,
  value: unknown,
  allEntities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
  lang: Lang = "en",
): string {
  if (value === null || value === undefined || value === "") return "";
  // Round 1162: case-insensitive, mirroring migrate.ts's own round-1159 fix
  // -- without it, a relation field whose relationTo differed from its
  // target entity's current name only by letter case always fell back to
  // "#<id>" here, even once relatedRecords genuinely held the records
  // (EntityPanel.tsx's own round-1162 fix fetches them keyed by the SAME
  // raw relationTo string, so the records[] lookup below still matches).
  const targetEntity = field.relationTo ? allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase()) : undefined;
  const records = field.relationTo ? relatedRecords[field.relationTo] : undefined;
  if (!targetEntity || !records) return `#${value}`;
  const match = relationIndexFor(records).get(Number(value));
  return match ? recordDisplayLabel(targetEntity, match, lang) : `#${value}`;
}

/**
 * Wraps a CSV field in quotes (doubling any interior quotes) only when it
 * contains a comma, quote, or newline. A value starting with =, +, -, @,
 * or a tab/CR is prefixed with a leading single quote first -- spreadsheet
 * apps (Excel, Sheets, LibreOffice) interpret an unguarded cell like that
 * as a formula, so without this a stored field value such as
 * `=HYPERLINK("http://evil.example","click")` would execute when a real
 * business owner opens their own exported data (CSV/formula injection,
 * CWE-1236) -- a field can hold arbitrary text (an AI-generated spec's
 * "notes" field, a WhatsApp-sourced message), not just values this app
 * itself ever wrote.
 *
 * A value that already starts with a literal "'" is also prefixed with
 * one more "'", even though a single leading apostrophe already makes
 * spreadsheet apps treat the cell as plain text on its own. Without this,
 * a value like "'-interesting" (a real leading apostrophe immediately
 * followed by a guarded character) is indistinguishable on import from
 * "-interesting" after csvEscape's own guard -- both produce the exact
 * same exported bytes, "'-interesting" -- so unescapeCsvGuard could not
 * tell "strip the guard" apart from "leave this alone" and silently
 * dropped the real apostrophe. Always bumping the leading-apostrophe count
 * by exactly one keeps that count unambiguous no matter how many literal
 * apostrophes the value actually starts with (see unescapeCsvGuard).
 */
function csvEscape(value: string): string {
  const guarded = /^[=+\-@\t\r']/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/**
 * Renders a field's value the way a human reading a spreadsheet would
 * expect -- the enum's translated label instead of its raw stored value,
 * TRUE/FALSE for booleans (Excel's own convention, language-neutral) --
 * rather than a 1:1 dump of the raw database values.
 *
 * Numbers and dates are deliberately NOT run through formatNumberValue /
 * formatDateValue here, even though those exist and are used for the
 * on-screen table (see EntityPanel.tsx). Those add locale formatting
 * (thousands separators, a locale-ordered date) meant for reading, not
 * for round-tripping: buildImportRecords is this function's designed
 * inverse, and re-parses a number with plain `Number()` and stores a date
 * field's text as-is. A locale-formatted "1,500" fails `Number()`, and a
 * locale-formatted date like "1/2/2024" is ambiguous and doesn't match
 * the ISO format the <input type="date"> field elsewhere in this app
 * expects -- so exporting one of your own records and re-importing it
 * would corrupt or drop it. Plain, unformatted values here keep the
 * export/import round trip exact.
 */
function fieldDisplayValue(
  field: Field,
  value: unknown,
  _lang: Lang,
  allEntities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") return relationDisplayLabel(field, value, allEntities, relatedRecords) || `#${value}`;
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  if (field.type === "date") return String(value);
  if (field.type === "number") return String(value);
  if (field.type === "file") return parseFileFieldValue(value)?.name ?? "";
  return String(value);
}

/**
 * A business owner who's already checked a handful of specific rows (this
 * week's unpaid invoices, leads to hand to a courier) via the table's own
 * bulk-select checkboxes expects "Export CSV"/"Print List" to act on just
 * that selection, not silently discard it and dump the entire filtered
 * table every time -- the exact gap bulk delete/duplicate/update don't
 * have, since they already read `selectedIds`. When anything is selected,
 * returns exactly those records pulled from `allRecords` (the full,
 * unfiltered entity), matching handleBulkDelete/handleBulkDuplicate's own
 * existing behavior of acting on the raw selection regardless of whatever
 * the current search/filter happens to be showing right now -- clearing or
 * changing the search box after selecting rows must not silently drop them
 * from the export. When nothing is selected, returns `visibleRecords`
 * unchanged, preserving today's "export what the table is currently
 * showing" behavior exactly.
 */
export function selectedOrAllRecords(
  allRecords: EntityRecord[],
  visibleRecords: EntityRecord[],
  selectedIds: Set<number>,
): EntityRecord[] {
  if (selectedIds.size === 0) return visibleRecords;
  return allRecords.filter((r) => selectedIds.has(r.id as number));
}

/**
 * A field's display label is never enforced unique (only its name is --
 * see twin.ts's/calendarIcs.ts's own comment on this), so two fields on
 * the same entity can legally share a label via the Field Label editor
 * (e.g. a "subtotal" and a "shipping" field both labeled "Amount"). Every
 * place that renders a field's label as human-facing text -- CSV headers,
 * the calendar export, Business Twin's observations, and (below)
 * EntityPanel's print sheets and board cards -- needs the same
 * disambiguation, so it's centralized here rather than reimplemented at
 * each call site: count how many fields among the given list share each
 * label, then fieldDisplayLabel appends a field's own (always-unique) name
 * whenever its label isn't unique, so a reader can tell two
 * identical-looking labels apart instead of seeing e.g. "Amount" twice
 * with no way to know which field either one actually is.
 */
export function fieldLabelOccurrences(fields: Field[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const f of fields) {
    const label = f.label ?? f.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

export function fieldDisplayLabel(field: Field, occurrences: Map<string, number>): string {
  const label = field.label ?? field.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${field.name})` : label;
}

/**
 * Builds a real, Excel-friendly CSV (CRLF line endings, quoted fields where
 * needed) from an entity's records -- so "download my data" means an
 * actual spreadsheet a business owner can open, not a JSON dump. A relation
 * field resolves to the related record's own display label (e.g. a
 * courier's name), same as the table/board views -- not the raw stored id.
 *
 * `includeId`, when true, prepends each record's own numeric id as a
 * leading "id" column -- "id" is a reserved field name (see packages/
 * shared's RESERVED_FIELD_NAMES), so it can never collide with a real
 * field's header. buildImportRecords below recognizes that same column on
 * the way back in, which is what lets re-importing an edited copy of your
 * own export UPDATE the records it came from instead of only ever
 * creating duplicates. Defaults to false so every other existing caller
 * (and every existing test) keeps producing the exact same id-free CSV it
 * always has -- only EntityPanel's own "Export CSV" file download, the one
 * path actually meant to be re-imported later, opts in.
 */
export function recordsToCsv(
  fields: Field[],
  records: EntityRecord[],
  lang: Lang,
  allEntities: Entity[] = [],
  relatedRecords: RelatedRecordsByEntity = {},
  includeId = false,
): string {
  const labelOccurrences = fieldLabelOccurrences(fields);
  const headerCells = fields.map((f) => fieldDisplayLabel(f, labelOccurrences));
  const header = (includeId ? ["id", ...headerCells] : headerCells).map(csvEscape).join(",");
  const rows = records.map((record) => {
    const cells = fields.map((f) => fieldDisplayValue(f, record[f.name], lang, allEntities, relatedRecords));
    return (includeId ? [String(record.id), ...cells] : cells).map(csvEscape).join(",");
  });
  return [header, ...rows].join("\r\n");
}

/**
 * Round 1217: `recordsToCsv` above is lossy by design -- every value is
 * rendered as the display TEXT a human reading a spreadsheet would want
 * (a relation resolves to the target record's own label, an enum to its
 * enumLabels text, a boolean to "TRUE"/"FALSE"), which throws away the
 * real stored value needed to round-trip this data into another tool or
 * script (the raw relation id, the raw enum value, a real boolean). This
 * sibling export keeps each field's own value exactly as `repository.ts`'s
 * `coerceValue`/row-mapping already store and return it -- a number stays
 * a JS number, a boolean a real JS boolean (not 0/1 -- see repository.ts's
 * own `Boolean(value)` conversion on read), and date/enum/relation-id
 * values stay their raw string, with NO display-label substitution at
 * all. The one exception is `file`: its stored value is itself a JSON-
 * encoded descriptor string (see `parseFileFieldValue`'s own doc comment),
 * so leaving it untouched would produce a doubly-escaped JSON string
 * inside the JSON export; parsing it into a real `{url, name, size,
 * mimeType}` object (or `null` for an empty/invalid one, reusing the same
 * validated parser EntityPanel.tsx already renders with) keeps the output
 * genuinely structured instead of a string a consumer has to re-parse.
 */
export function recordsToJson(fields: Field[], records: EntityRecord[]): string {
  const rows = records.map((record) => {
    const row: Record<string, unknown> = { id: record.id };
    for (const field of fields) {
      row[field.name] = field.type === "file" ? parseFileFieldValue(record[field.name]) : record[field.name];
    }
    return row;
  });
  return JSON.stringify(rows, null, 2);
}

/**
 * Parses CSV text into rows of raw string cells (RFC 4180: quoted fields
 * may contain commas, newlines, and doubled-quote escapes), the reverse of
 * `recordsToCsv` -- this is what lets "import my customer list" mean
 * pasting/uploading an actual spreadsheet export, not a specially
 * formatted file only this app could produce. Handles both CRLF and bare
 * LF line endings, and drops a single trailing blank line (the common
 * "file ends with a newline" case) rather than emitting a phantom empty row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field);
    field = "";
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // A final row with no trailing newline still needs to be flushed; an
  // actual trailing newline already flushed via endRow() above and left
  // field/row empty, so only flush here when there's something pending.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

export interface ImportResult {
  /** Record payloads ready to POST, one per valid data row. */
  records: Record<string, unknown>[];
  /** Human-readable problems, each naming the 1-based data row it came from (or none, for a whole-file problem). */
  errors: string[];
}

function matchesHeader(header: string, field: Field, labelOccurrences: Map<string, number>): boolean {
  const normalized = header.trim().toLowerCase();
  // A blank header can never legitimately refer to any field -- without
  // this, (field.label ?? "").toLowerCase() is itself "" for any field
  // with no label set, so a blank/unnamed CSV column (a stray trailing
  // comma, an unlabeled spreadsheet column) would match the FIRST
  // unlabeled field and silently import unrelated data into it, instead
  // of being ignored the way a column with real, unmatched text already is.
  if (!normalized) return false;
  // recordsToCsv's own header row uses fieldDisplayLabel, not the raw
  // label, whenever two fields share a label -- "Amount (subtotal)", not
  // "Amount". Without also matching that disambiguated form, re-importing
  // a CSV this app itself just exported for an entity with any
  // same-labeled fields silently fails to match either column (it's
  // neither field's bare name nor its bare label), so both fields'
  // columnIndex below resolves to -1 and their data comes back null with
  // no error reported at all.
  return (
    normalized === field.name.toLowerCase() ||
    normalized === (field.label ?? "").toLowerCase() ||
    normalized === fieldDisplayLabel(field, labelOccurrences).toLowerCase()
  );
}

/**
 * Reverses the leading "'" that csvEscape (recordsToCsv's own guard
 * against CSV/formula injection, CWE-1236) prepends to a value starting
 * with =, +, -, @, a tab/CR, or a literal "'" itself. Without this,
 * re-importing a CSV this app itself just exported would permanently bake
 * that guard apostrophe into the data -- a text note like "-1 day late"
 * would come back as the literal string "'-1 day late", and a negative
 * number would fail to parse at all (Number("'-120.5") is NaN), rejecting
 * an otherwise-valid import row. Strips exactly one leading apostrophe
 * whenever what follows is itself one of those same guarded characters --
 * the same condition csvEscape used to add it, now including "'" -- so a
 * value that genuinely starts with a literal "'" followed by an ordinary
 * character (e.g. a name like "'Ohana") is left untouched, while a value
 * that starts with "'" followed by another "'" or by =, +, -, @, tab, or
 * CR correctly loses only the one apostrophe csvEscape added.
 */
function unescapeCsvGuard(raw: string): string {
  return raw[0] === "'" && /^[=+\-@\t\r']/.test(raw.slice(1)) ? raw.slice(1) : raw;
}

/**
 * Unlike number/enum/date below, a boolean cell used to have no rejection
 * path at all: anything outside this exact true-list (including a Hebrew
 * "כן"/"לא", "no", or a plain typo) silently became `false` with zero
 * error reported -- the one field type in this whole import path where an
 * unrecognized value failed closed and quiet instead of surfacing a clear,
 * row-numbered error like every other type does.
 */
const BOOLEAN_TRUE_VALUES = ["true", "1", "yes", "כן"];
const BOOLEAN_FALSE_VALUES = ["false", "0", "no", "לא"];

/**
 * Turns parsed CSV rows into record payloads matching `fields`' types --
 * the reverse of `fieldDisplayValue`, so a file this app exported (or a
 * hand-edited copy of one) round-trips back in. Columns are matched to
 * fields by header text (label or field name, case-insensitive); an
 * unmatched column is simply ignored rather than treated as an error,
 * since a spreadsheet often carries extra notes columns.
 *
 * A relation field's cell (e.g. "Dana Levi") is resolved back to the
 * related record's real id the same way relationDisplayLabel renders it
 * forward: matching recordDisplayLabel case-insensitively against
 * `relatedRecords[field.relationTo]`, or accepting the literal "#<id>"
 * form directly (the same fallback relationDisplayLabel itself renders
 * when a display label can't be resolved), so a file this app exported
 * round-trips even for a record whose label has since changed or gone
 * ambiguous. Zero matches is a row error; more than one match (display
 * labels aren't guaranteed unique -- see fieldLabelOccurrences' own
 * disambiguation for column headers, a different instance of the same
 * problem) asks for the "#<id>" form instead of silently guessing wrong.
 * This resolution needs `allEntities`/`relatedRecords` to actually be
 * passed in with the target entity's records loaded -- a caller that
 * omits them (or a relation whose target isn't part of this project's
 * spec at all) falls back to the original "impossible from a CSV cell"
 * treatment: an optional column is ignored, and a *required* relation
 * field refuses the whole import with one clear error instead of
 * silently producing records that will fail the server's own
 * required-field check one at a time.
 *
 * File fields have the same "impossible from a CSV cell" problem for the
 * opposite reason -- there's no uploaded file to attach, not a missing
 * lookup -- so a required file field always gets the same whole-import
 * refusal, and an optional one is always ignored per row.
 *
 * A header cell literally "id" (case-insensitive) is recognized as
 * recordsToCsv's own re-import-friendly leading column, not matched
 * against `fields` at all -- "id" is a reserved field name, so no real
 * field can ever legitimately claim that header. A row with a valid,
 * non-blank id in that column comes back with an `id` key alongside its
 * other fields; EntityPanel's handleImportFile uses that to PATCH the
 * existing record instead of POSTing a new one. A blank id cell (a row
 * appended below the exported ones, e.g.) is simply a new record, exactly
 * like a file with no id column at all.
 */
export function buildImportRecords(
  fields: Field[],
  rows: string[][],
  allEntities: Entity[] = [],
  relatedRecords: RelatedRecordsByEntity = {},
  lang: Lang = "en",
): ImportResult {
  if (rows.length === 0) return { records: [], errors: [] };

  // A relation field can only be resolved when the caller has already
  // loaded its target entity's records (relatedRecords/allEntities) -- see
  // relationDisplayLabel's own doc comment for why the target may
  // legitimately be absent (an optional relation whose target isn't part
  // of this project's spec, or a caller that never fetched relatedRecords
  // at all). Without that data this field falls back to the original
  // "impossible from a CSV cell" treatment below.
  // Round 1177: case-insensitive, mirroring this same file's own
  // relationDisplayLabel (round 1162) and EntityPanel.tsx's relationTargets
  // (round 1162) -- without it, a relation field whose relationTo differed
  // from its target entity's current name only by letter case was treated
  // as entirely unresolvable here, even once EntityPanel.tsx's own fetch
  // effect had already loaded relatedRecords under that SAME raw
  // relationTo string (so the relatedRecords[] lookup below still matches
  // without any change). A REQUIRED such field blocked the whole import
  // outright; an optional one silently dropped every row's value for it.
  const relationResolvable = (f: Field): boolean =>
    !!f.relationTo && allEntities.some((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase()) && !!relatedRecords[f.relationTo];

  const requiredUnsupported = fields.find(
    (f) => (f.type === "file" && f.required) || (f.type === "relation" && f.required && !relationResolvable(f)),
  );
  if (requiredUnsupported) {
    return {
      records: [],
      errors: [
        `CSV import isn't supported yet for entities with a required ${requiredUnsupported.type} field ("${requiredUnsupported.label ?? requiredUnsupported.name}").`,
      ],
    };
  }

  const [header, ...dataRows] = rows;
  const idColumnIndex = header.findIndex((cell) => cell.trim().toLowerCase() === "id");

  // A field is claimed by at most one column, in header order -- otherwise
  // two fields that share a label (e.g. both renamed to "Status" via
  // FieldLabelEditor, which enforces no uniqueness) would both resolve to
  // whichever field `fields.find` hits first for every matching header
  // cell, silently duplicating that field's data into the other and
  // dropping the other's real column entirely.
  const claimedFieldNames = new Set<string>();
  const labelOccurrences = fieldLabelOccurrences(fields);
  const columnFields: (Field | null)[] = header.map((cell, index) => {
    // The id column is consumed above, not matched against real fields --
    // see this function's own doc comment on why "id" can never be one.
    if (index === idColumnIndex) return null;
    const match = fields.find((f) => !claimedFieldNames.has(f.name) && matchesHeader(cell, f, labelOccurrences));
    if (match) claimedFieldNames.add(match.name);
    return match ?? null;
  });

  // Round 942: a header cell literally "id" is, on its own, nowhere near
  // enough signal that this file is actually one of this app's own
  // re-exports -- CSV import is equally meant for migrating in a
  // genuinely external spreadsheet (this function's own doc comment,
  // "a spreadsheet often carries extra notes columns"), and an ordinary
  // external file can just as plausibly have its own unrelated column
  // literally named "ID" (a membership number, an external reference)
  // with no connection to this app's row ids at all. If that column's
  // values happen to be plain integers that coincide with existing
  // records' real ids in this entity -- near-certain for any import of
  // more than a handful of rows into an entity with small sequential
  // ids -- trusting it blindly would silently PATCH (overwrite) those
  // unrelated real records instead of creating new ones, discarding
  // both the file's own real data AND the external id, with no error
  // anywhere. recordsToCsv(..., includeId: true) always emits a header
  // column for EVERY one of this entity's own fields (even a `file`
  // field, whose own cell is simply its filename/blank) -- something a
  // coincidental external match is vanishingly unlikely to also satisfy
  // in full -- so the id column is only trusted once every real field
  // is actually present in this header too, exactly the shape a genuine
  // re-export always has.
  const idColumnTrusted = idColumnIndex !== -1 && fields.every((f) => columnFields.some((cf) => cf?.name === f.name));

  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];
  // Round 1042: two rows sharing the same trusted id (a duplicated row,
  // copy/pasted as a template for a new one and never blanked out) each
  // become their own independent updateRecord() call (EntityPanel.tsx's
  // handleImportFile), fired concurrently via Promise.allSettled with no
  // optimistic-locking/version check on the server (routes/projects.ts's
  // PATCH route is plain last-write-wins) -- so whichever request lands
  // last silently wins, discarding the other row's edit with both still
  // reported as successful "updated" rows. Caught the same way every
  // other ambiguous-input case in this function already is: as a row
  // error, excluding the later occurrence from `records` instead of
  // letting it fire a second silent-clobber request.
  const seenIds = new Set<number>();

  dataRows.forEach((row, rowIndex) => {
    const isBlank = row.every((cell) => cell.trim() === "");
    if (isBlank) return;

    const record: Record<string, unknown> = {};
    let rowError: string | null = null;

    if (idColumnTrusted) {
      const rawId = (row[idColumnIndex] ?? "").trim();
      if (rawId !== "") {
        const parsedId = Number(rawId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          rowError = `Row ${rowIndex + 1}: "${rawId}" isn't a valid record id.`;
        } else if (seenIds.has(parsedId)) {
          rowError = `Row ${rowIndex + 1}: id ${parsedId} was already used by an earlier row in this file -- only one row per id is supported.`;
        } else {
          seenIds.add(parsedId);
          record.id = parsedId;
        }
      }
    }

    for (const field of rowError ? [] : fields) {
      const columnIndex = columnFields.findIndex((f) => f?.name === field.name);
      const raw = columnIndex === -1 ? "" : unescapeCsvGuard((row[columnIndex] ?? "").trim());

      if (field.type === "file") continue; // no file to attach from a CSV cell

      if (field.type === "relation") {
        if (!relationResolvable(field)) continue; // see doc comment: no related records loaded, keep ignoring the column
        if (raw === "") {
          if (field.required) {
            rowError = `Row ${rowIndex + 1}: missing required field "${field.label ?? field.name}".`;
            break;
          }
          record[field.name] = null;
          continue;
        }
        // Round 1177: case-insensitive, same reason as relationResolvable above.
        const targetEntity = allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase())!;
        const targetRecords = relatedRecords[field.relationTo!]!;
        // A real display-label match always wins over the "#<id>" shorthand below:
        // a record's own display field can legitimately hold text that looks like
        // "#<digits>" (a SKU, ticket or room number), and recordDisplayLabel renders
        // that as a genuine, resolved label rather than its "no label" fallback --
        // treating it as an id reference instead would silently point the import at
        // the wrong record.
        const matches = targetRecords.filter((r) => recordDisplayLabel(targetEntity, r, lang).toLowerCase() === raw.toLowerCase());
        if (matches.length === 1) {
          record[field.name] = Number(matches[0].id);
          continue;
        }
        if (matches.length === 0) {
          const hashMatch = raw.match(/^#(\d+)$/);
          if (hashMatch) {
            const id = Number(hashMatch[1]);
            if (targetRecords.some((r) => Number(r.id) === id)) {
              record[field.name] = id;
              continue;
            }
          }
          rowError = `Row ${rowIndex + 1}: "${raw}" doesn't match any ${targetEntity.label ?? targetEntity.name} record for field "${field.label ?? field.name}".`;
          break;
        }
        rowError = `Row ${rowIndex + 1}: "${raw}" matches more than one ${targetEntity.label ?? targetEntity.name} record for field "${field.label ?? field.name}" -- use its "#<id>" form instead.`;
        break;
      }

      if (raw === "") {
        if (field.required) {
          rowError = `Row ${rowIndex + 1}: missing required field "${field.label ?? field.name}".`;
          break;
        }
        // Round 1151: this was the one field type coerced to a concrete
        // value instead of passing the blank cell through as NULL, same
        // as every other optional type here -- round 1134 already made
        // fieldDisplayValue (this function's own designed inverse, per its
        // doc comment above) export a never-answered boolean as a genuine
        // blank cell, distinguishable from an explicit "FALSE". Re-importing
        // that exact blank cell silently turned it into an explicit `false`,
        // the same "unanswered becomes answered" corruption round 1134
        // fixed on the read/export side, just reopened here on re-import.
        record[field.name] = null;
        continue;
      }

      if (field.type === "boolean") {
        const lower = raw.toLowerCase();
        if (BOOLEAN_TRUE_VALUES.includes(lower)) {
          record[field.name] = true;
        } else if (BOOLEAN_FALSE_VALUES.includes(lower)) {
          record[field.name] = false;
        } else {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a recognized yes/no value for field "${field.label ?? field.name}".`;
          break;
        }
      } else if (field.type === "number") {
        const n = Number(raw);
        // Number.isFinite, not just !Number.isNaN: Number("Infinity") is
        // Infinity, not NaN, so it passes a NaN-only check -- but
        // JSON.stringify silently turns Infinity/-Infinity into null
        // before the record ever leaves the browser, so an un-finite
        // value here would otherwise become silent data loss, not an
        // import error.
        if (!Number.isFinite(n)) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a number for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = n;
      } else if (field.type === "enum") {
        // A real raw-value match always wins over the label match below,
        // the same precedence order the relation branch above gives a
        // real display-label match over the "#<id>" shorthand -- an exact
        // value match can never be genuinely ambiguous (FieldSchema.enumValues
        // has no uniqueness constraint either, see uniqueEnumValues' own
        // doc comment, but two entries sharing the identical raw value
        // would already collide on write long before import ever runs).
        const byValue = field.enumValues?.find((v) => v.toLowerCase() === raw.toLowerCase());
        if (byValue) {
          record[field.name] = byValue;
          continue;
        }
        // Round 1084: FieldSchema.enumLabels is a plain record with no
        // uniqueness constraint of its own, so two different declared
        // values can legitimately share the identical display label --
        // the realistic way this happens is the same "AI-generated spec"
        // precondition uniqueEnumValues' own doc comment already names for
        // the sibling duplicate-raw-value gap, just for labels instead
        // (e.g. a Hebrew refine translating both "new" and "open" statuses
        // to the same word). Unlike the relation branch right above, which
        // explicitly counts matches and rejects an ambiguous one, this used
        // to call .find() and silently resolve to whichever value happened
        // to come first in enumValues -- writing the WRONG status into a
        // re-imported record with zero error or warning. Mirrors the
        // relation branch's own ambiguity handling instead: only resolve
        // by label when exactly one declared value maps to it.
        const labelMatches = field.enumValues?.filter((v) => (field.enumLabels?.[v] ?? v).toLowerCase() === raw.toLowerCase()) ?? [];
        if (labelMatches.length === 0) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a valid option for field "${field.label ?? field.name}".`;
          break;
        }
        if (labelMatches.length > 1) {
          rowError = `Row ${rowIndex + 1}: "${raw}" matches more than one option for field "${field.label ?? field.name}" -- use the option's own underlying value (not its label) instead.`;
          break;
        }
        record[field.name] = labelMatches[0];
      } else if (field.type === "date") {
        if (!isValidDateString(raw)) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a valid date (expected YYYY-MM-DD) for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = raw;
      } else {
        record[field.name] = raw;
      }
    }

    if (rowError) {
      errors.push(rowError);
    } else {
      records.push(record);
    }
  });

  return { records, errors };
}

/**
 * The JSON counterpart to buildImportRecords -- round-trips a file this
 * app exported via recordsToJson (round 1217), or a hand-edited copy of
 * one. Dramatically simpler than the CSV version: recordsToJson's own
 * output already carries every field's REAL typed value (a real
 * number/boolean, the raw relation id, the raw enum value), so there's no
 * display-text-to-value coercion to reverse at all -- just validation. A
 * JSON key this function doesn't recognize (an extra field, one since
 * removed from the entity) is simply ignored, the same "a file often
 * carries extra data" tolerance buildImportRecords already has for an
 * unmatched CSV column.
 *
 * A relation field's value must be the raw numeric id of a record already
 * present in relatedRecords[field.relationTo] -- recordsToJson never
 * emits anything else for a relation field, so a value that doesn't
 * resolve this way means the file was hand-edited incorrectly or
 * exported from a different project (there's no legitimate cross-project
 * id to accept here). Same relationResolvable/required-relation-refusal
 * shape as buildImportRecords when the target entity's records weren't
 * loaded by the caller.
 *
 * File fields have the same "impossible to attach from an import cell"
 * limitation CSV import already has, for a different reason: the
 * exported descriptor only ever carries a URL to an already-uploaded
 * file, never the file's own bytes, and accepting an arbitrary URL
 * string straight into a record would reopen the exact cross-project
 * file-reference injection round 1210 closed. A required file field
 * refuses the whole import with one clear error (mirroring
 * buildImportRecords); an optional one is simply ignored per row.
 *
 * `id` needs none of buildImportRecords' own "only trust the id column
 * once every real field is also present" heuristic -- that defense exists
 * specifically because a CSV header's plain text is ambiguous (an
 * external spreadsheet can coincidentally have its own unrelated "ID"
 * column), but `id` is a reserved field name no real field can ever
 * claim (packages/shared's RESERVED_FIELD_NAMES), so a JSON object's own
 * top-level `id` key is unambiguous on its own.
 */
export function buildImportRecordsFromJson(
  fields: Field[],
  rows: unknown[],
  allEntities: Entity[] = [],
  relatedRecords: RelatedRecordsByEntity = {},
): ImportResult {
  if (rows.length === 0) return { records: [], errors: [] };

  const relationResolvable = (f: Field): boolean =>
    !!f.relationTo && allEntities.some((e) => e.name.toLowerCase() === f.relationTo!.toLowerCase()) && !!relatedRecords[f.relationTo];

  const requiredUnsupported = fields.find(
    (f) => (f.type === "file" && f.required) || (f.type === "relation" && f.required && !relationResolvable(f)),
  );
  if (requiredUnsupported) {
    return {
      records: [],
      errors: [
        `JSON import isn't supported yet for entities with a required ${requiredUnsupported.type} field ("${requiredUnsupported.label ?? requiredUnsupported.name}").`,
      ],
    };
  }

  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const seenIds = new Set<number>();

  rows.forEach((row, rowIndex) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      errors.push(`Row ${rowIndex + 1}: expected a JSON object, got ${Array.isArray(row) ? "an array" : typeof row}.`);
      return;
    }
    const data = row as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    let rowError: string | null = null;

    if (data.id !== undefined && data.id !== null) {
      const parsedId = Number(data.id);
      if (!Number.isInteger(parsedId) || parsedId <= 0) {
        rowError = `Row ${rowIndex + 1}: "${data.id}" isn't a valid record id.`;
      } else if (seenIds.has(parsedId)) {
        rowError = `Row ${rowIndex + 1}: id ${parsedId} was already used by an earlier row in this file -- only one row per id is supported.`;
      } else {
        seenIds.add(parsedId);
        record.id = parsedId;
      }
    }

    for (const field of rowError ? [] : fields) {
      const raw = data[field.name];

      if (field.type === "file") continue; // no file to attach from a JSON cell

      if (field.type === "relation") {
        if (!relationResolvable(field)) continue; // see doc comment: no related records loaded, keep ignoring the field
        if (raw === null || raw === undefined) {
          if (field.required) {
            rowError = `Row ${rowIndex + 1}: missing required field "${field.label ?? field.name}".`;
            break;
          }
          record[field.name] = null;
          continue;
        }
        const id = Number(raw);
        const targetRecords = relatedRecords[field.relationTo!]!;
        if (!Number.isInteger(id) || !targetRecords.some((r) => Number(r.id) === id)) {
          const targetEntity = allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase())!;
          rowError = `Row ${rowIndex + 1}: "${raw}" doesn't match any ${targetEntity.label ?? targetEntity.name} record for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = id;
        continue;
      }

      if (raw === null || raw === undefined) {
        if (field.required) {
          rowError = `Row ${rowIndex + 1}: missing required field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = null;
        continue;
      }

      if (field.type === "boolean") {
        if (typeof raw !== "boolean") {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a true/false value for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = raw;
      } else if (field.type === "number") {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a number for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = raw;
      } else if (field.type === "enum") {
        if (typeof raw !== "string" || !field.enumValues?.includes(raw)) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a valid option for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = raw;
      } else if (field.type === "date") {
        if (typeof raw !== "string" || !isValidDateString(raw)) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a valid date (expected YYYY-MM-DD) for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = raw;
      } else {
        if (typeof raw !== "string") {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't valid text for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = raw;
      }
    }

    if (rowError) {
      errors.push(rowError);
    } else {
      records.push(record);
    }
  });

  return { records, errors };
}

/**
 * A search/filter narrowing the table down loses any sense of how many
 * records actually matched versus how many exist in total -- the count was
 * always computed (`visibleRecords.length` vs `records.length` in
 * EntityPanel) but never shown anywhere. Two distinct phrasings rather than
 * always "shown of total" so the unfiltered, everyday case ("12 records")
 * doesn't read as a redundant "12 of 12 records".
 */
export function formatEntityRecordCount(
  shown: number,
  total: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return shown === total ? t("entity.recordCount.all", { count: total }) : t("entity.recordCount.filtered", { shown, total });
}

/**
 * Reverses a calendar grid cell's own local-midnight Date back into the
 * plain "YYYY-MM-DD" a date field actually stores -- using LOCAL getters
 * (getFullYear/getMonth/getDate), matching parseFieldDate's own local
 * construction above rather than `toISOString()` (UTC), for the exact same
 * reason that function's own doc comment gives: a UTC-based conversion
 * silently shifts the date by a day for any viewer behind UTC.
 */
export function formatDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Reinserts an undone delete's own record at its original position rather
 * than appending it at the end -- EntityPanel's own delete flow removes a
 * record from view optimistically the instant Delete is confirmed (real
 * deletion is delayed behind a short undo window, see EntityPanel.tsx's
 * handleDelete), so clicking Undo needs to put it back exactly where it
 * was, not wherever the array happens to end. The index is clamped since
 * other records may have been created, duplicated, or (for a second,
 * unrelated delete) removed in the meantime, shrinking or growing the
 * array since the original index was captured.
 */
export function restoreRecordAt(records: EntityRecord[], record: EntityRecord, index: number): EntityRecord[] {
  const clampedIndex = Math.max(0, Math.min(index, records.length));
  return [...records.slice(0, clampedIndex), record, ...records.slice(clampedIndex)];
}

/**
 * Drives EntityPanel's own j/k (and ArrowDown/ArrowUp) row navigation --
 * table view previously had no way to move between rows without reaching
 * for the mouse. Deliberately doesn't wrap at either end (unlike
 * GlobalSearchPanel's own arrow-key navigation, round 69): a long table is
 * the common case here, and wrapping from the last row back to the first
 * (or vice versa) after a table refresh/re-sort would silently jump the
 * focus somewhere the user never intended. If the currently-focused id has
 * since scrolled out of the visible set entirely (a search/filter changed,
 * or the record was deleted), treat it the same as "nothing focused yet"
 * and (re)start from the first row, regardless of which direction was
 * pressed -- there's no previous position left to move relative to.
 */
export function computeNextFocusedRowId(
  visibleIds: number[],
  currentFocusedId: number | null,
  direction: "next" | "prev",
): number | null {
  if (visibleIds.length === 0) return null;
  const currentIndex = currentFocusedId == null ? -1 : visibleIds.indexOf(currentFocusedId);
  if (currentIndex === -1) return visibleIds[0];
  const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  const clampedIndex = Math.max(0, Math.min(nextIndex, visibleIds.length - 1));
  return visibleIds[clampedIndex];
}

/** True while the user is actively typing somewhere else on the page (a text field, a select, a contenteditable region) -- j/k must never hijack keystrokes meant for the search box, a filter dropdown, or the add/edit form. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * True when Enter's real DOM target is a button, link, or other element
 * that already has its own native (or React-handled) meaning for Enter --
 * unlike j/k/x/Delete/d, whose keys have no native action on a button, so
 * isTypingTarget alone isn't enough to guard the table view's own Enter
 * shortcut. j/k navigation only ever moves a *visual* "focused row"
 * highlight (setFocusedRowId); it never calls .focus() on anything, so the
 * real DOM focus -- and e.target on this window-level keydown listener --
 * can be sitting on a completely unrelated button the user tabbed to (the
 * form's own Save button, another row's Delete/Duplicate button, a toolbar
 * button) while a row is still visually focused from an earlier j/k press.
 * Without this check, Enter there got hijacked into opening the visually-
 * focused row for editing instead of activating the button the user was
 * actually on -- for a focused Save button specifically, silently
 * discarding whatever unsaved edit or new-record draft was about to be
 * submitted, with no confirmation. e.defaultPrevented covers the one case
 * this closest() walk can't: a React onKeyDown on a non-native
 * role="button" element (EntityLabelEditor's own rename trigger) that
 * already handled this exact Enter and called its own preventDefault.
 * Mirrors the identical hazard round 350 fixed for the calendar day cell's
 * own onKeyDown (`e.target !== e.currentTarget`) -- that fix could compare
 * targets directly because it's a per-element React handler; this one is a
 * single window-level listener, so it has to ask "is the target itself (or
 * an ancestor) a native activation target" instead.
 */
export function enterTargetsInteractiveElement(target: EventTarget | null): boolean {
  const el = target as (Partial<Pick<HTMLElement, "closest">> & { tagName?: string }) | null;
  return Boolean(el?.closest?.('button, a[href], [role="button"], summary'));
}

/**
 * Every scrollIntoView call in this app (arrow-key result navigation,
 * jump-to-record, the "n"/calendar-day/board-column create-new shortcuts)
 * passed `behavior: "smooth"` unconditionally, firing a real scroll
 * animation on every keypress and click regardless of whether the person
 * has their OS/browser set to "prefers-reduced-motion: reduce" -- the
 * exact WCAG 2.3.3 case this app already treats as real for its one CSS
 * keyframe animation (styles.css's `.hero3d-cube`, disabled under the
 * same media query). A `behavior: "smooth"` passed directly as a JS
 * option isn't something that CSS media query can intercept -- it only
 * affects an element's inherited `scroll-behavior`, not an explicit call
 * like this -- so each call site needs its own check instead.
 */
export function scrollIntoViewRespectingMotion(
  el: (Element & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }) | null | undefined,
  options: ScrollIntoViewOptions,
): void {
  if (!el?.scrollIntoView) return;
  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView(prefersReducedMotion ? { ...options, behavior: "auto" } : options);
}

/**
 * Whether a table cell for this field can be edited directly in place with
 * a double-click, instead of always having to open the full add/edit form
 * below the table just to change one value. Relation fields are excluded --
 * their cell already shows a label resolved from a *different* record (see
 * relationDisplayLabel), not the raw stored value the cell would need to
 * edit, so an inline editor there would need the same related-entity
 * picker the full form already gives, with no real space savings.
 */
export function isInlineEditableField(field: Field): boolean {
  // "file" is excluded for the same reason "relation" already is -- its
  // real editing UI (choosing and uploading a file) needs more room and
  // more state than a single inline table cell gives it, so it's only
  // ever edited through the full add/edit form (see EntityPanel.tsx's
  // FieldInput "file" branch, the only one that needs projectId/entityName
  // to reach the upload endpoint at all).
  return field.type !== "relation" && field.type !== "file";
}

/**
 * Whether a field's own value space is small and fixed enough to group the
 * table by -- the Kanban board view (round 47) already groups records into
 * columns, but only ever by one auto-picked "board" field and only in its
 * own separate view. A plain table has no grouping at all, even when a
 * person would rather see every record clustered by, say, a Priority or
 * IsBillable field instead of scrolling a flat list. Free-text/number/date
 * fields are excluded -- with an unbounded value space, "grouping" by one
 * would produce one group per distinct value, which isn't grouping at all.
 *
 * A relation field is exactly as fixed-value-space as an enum -- its own
 * options are the related entity's current records -- and the sibling
 * toolbar filter dropdown (findFilterableFields, round 721) already treats
 * it that way, with the identical "resolvable" guard used here: only once
 * allEntities/relatedRecords confirm the relation actually resolves to a
 * loaded set of records, so a stale relationTo pointing at a deleted
 * entity, or data that hasn't finished loading yet, never offers a group-by
 * option with nothing real to group by. allEntities/relatedRecords are
 * optional so an existing call site that only cares about enum/boolean
 * doesn't need to pass them.
 */
export function isGroupableField(field: Field, allEntities?: Entity[], relatedRecords?: RelatedRecordsByEntity): boolean {
  if (field.type === "enum" || field.type === "boolean") return true;
  // Round 1178: case-insensitive, same reason as findFilterableFields above
  // -- without it, a case-mismatched relation field was never offered in
  // the "Group by" dropdown either.
  return field.type === "relation" && !!field.relationTo && !!allEntities?.some((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase()) && !!relatedRecords?.[field.relationTo];
}

export interface RecordGroup {
  key: string;
  label: string;
  records: EntityRecord[];
}

/**
 * Partitions records into ordered groups by one groupable field's value.
 * For an enum field, groups follow the field's own enumValues order (its
 * declared, human-meaningful order) rather than alphabetical or
 * first-seen, with one final "(other)" bucket for any legacy value no
 * longer in enumValues -- the same "don't silently drop unrecognized data"
 * principle badgeTone's own fallback already follows. For a boolean field,
 * there are only ever the two fixed groups, true then false. For a relation
 * field (see isGroupableField's own doc comment), groups follow the related
 * entity's own current record order, labeled via the same recordDisplayLabel
 * relationDisplayLabel already uses, with any record whose stored id is
 * null/empty or no longer resolves (a dangling reference to a deleted
 * related record) collected into the same "(other)" bucket the enum branch
 * uses, rather than silently dropped. allEntities/relatedRecords are only
 * needed for the relation case; an enum/boolean call site can omit them. A
 * group with zero matching records is omitted entirely rather than rendered
 * empty.
 */
export function groupRecordsByField(
  records: EntityRecord[],
  field: Field,
  t: (key: string, params?: Record<string, string | number>) => string,
  allEntities?: Entity[],
  relatedRecords?: RelatedRecordsByEntity,
  lang: Lang = "en",
): RecordGroup[] {
  if (field.type === "boolean") {
    const groups: RecordGroup[] = [];
    const truthy = records.filter((r) => Boolean(r[field.name]));
    const falsy = records.filter((r) => !r[field.name]);
    if (truthy.length > 0) groups.push({ key: "true", label: t("entity.groupBy.yes"), records: truthy });
    if (falsy.length > 0) groups.push({ key: "false", label: t("entity.groupBy.no"), records: falsy });
    return groups;
  }

  if (field.type === "relation") {
    // Round 1178: case-insensitive, same reason as isGroupableField above
    // -- without it, even a field isGroupableField had already let through
    // would fall straight into the `!targetEntity` early-return below,
    // returning zero groups instead of the real ones.
    const targetEntity = field.relationTo ? allEntities?.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase()) : undefined;
    const relatedList = field.relationTo ? relatedRecords?.[field.relationTo] : undefined;
    if (!targetEntity || !relatedList) return [];
    const groups: RecordGroup[] = [];
    const knownIds = new Set(relatedList.map((r) => r.id));
    for (const related of relatedList) {
      const matched = records.filter((r) => Number(r[field.name]) === related.id);
      if (matched.length > 0) groups.push({ key: String(related.id), label: recordDisplayLabel(targetEntity, related, lang), records: matched });
    }
    const other = records.filter((r) => {
      const v = r[field.name];
      return v === null || v === undefined || v === "" || !knownIds.has(Number(v));
    });
    if (other.length > 0) groups.push({ key: otherGroupKey(undefined), label: t("entity.groupBy.other"), records: other });
    return groups;
  }

  const groups: RecordGroup[] = [];
  const known = new Set(field.enumValues ?? []);
  for (const value of uniqueEnumValues(field.enumValues)) {
    const matched = records.filter((r) => String(r[field.name] ?? "") === value);
    if (matched.length > 0) groups.push({ key: value, label: field.enumLabels?.[value] ?? value, records: matched });
  }
  const other = records.filter((r) => !known.has(String(r[field.name] ?? "")));
  if (other.length > 0) groups.push({ key: otherGroupKey(field.enumValues), label: t("entity.groupBy.other"), records: other });
  return groups;
}
