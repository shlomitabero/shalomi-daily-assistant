import type { Entity, EntityRecord, Field } from "@forge/shared";
import type { Lang } from "./i18n/language.js";

export const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

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
function isValidDateString(value: string): boolean {
  const match = DATE_FORMAT.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const parsed = new Date(Date.UTC(year, month - 1, day));
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
export function formatNumberValue(value: number, lang: Lang): string {
  return value.toLocaleString(LOCALE[lang]);
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
 * Filters one entity's already-fetched records against a global search
 * query -- the building block for project-wide search across every entity
 * tab at once, reusing the exact same match rule `matchesSearch` uses
 * per-tab so "found here" and "found everywhere" never disagree. Returns
 * null for an empty query or when nothing in this entity matched, so a
 * caller can simply filter out the nulls rather than special-casing "no
 * results" per entity.
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
    entityLabel: entity.label ?? entity.name,
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
  const sorted = [...records].sort((a, b) =>
    compareValues(
      resolveSortValue(sortField, a[sortField], fields, allEntities, relatedRecords),
      resolveSortValue(sortField, b[sortField], fields, allEntities, relatedRecords),
    ),
  );
  return direction === "desc" ? sorted.reverse() : sorted;
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
 */
export function findFilterableFields(fields: Field[]): Field[] {
  return [...findFilterableEnumFields(fields), ...fields.filter((f) => f.type === "boolean")];
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
  const values = field.enumValues ?? [];
  const columns: BoardColumn[] = values.map((value) => ({
    value,
    label: field.enumLabels?.[value] ?? value,
    records: records.filter((r) => String(r[field.name]) === value),
  }));
  const known = new Set(values);
  const other = records.filter((r) => !known.has(String(r[field.name] ?? "")));
  if (other.length > 0) {
    columns.push({
      value: "__other__",
      label: t ? t("entity.groupBy.other") : "Other",
      records: other,
      isOther: true,
    });
  }
  return columns;
}

const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduleddate", "eventdate", "duedate"];

/**
 * Picks the date field an entity's records should be plotted on a calendar
 * by, if any -- this is what turns an "Appointment" entity into a real
 * month view instead of the same table shape every entity gets. Prefers a
 * field literally named "date" (the domain library's own convention) or a
 * few other common date-ish names, then falls back to the first date
 * field; returns null for an entity with no date field at all.
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
 */
export function calendarChipLabelField(entity: Entity, dateField: Field): Field {
  const preferred = pickDisplayField(entity);
  if (preferred && preferred.name !== dateField.name) return preferred;
  return entity.fields.find((f) => f.name !== dateField.name) ?? dateField;
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
 * field of any type; returns null only for an entity with no fields at all.
 */
export function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText ?? entity.fields[0] ?? null;
}

/**
 * Renders one record of `entity` as a short human label using its display
 * field, falling back to "#<id>" when the entity has no usable field or the
 * display field is empty on this particular record.
 */
export function recordDisplayLabel(entity: Entity, record: EntityRecord): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
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
): string {
  if (value === null || value === undefined || value === "") return "";
  const targetEntity = field.relationTo ? allEntities.find((e) => e.name === field.relationTo) : undefined;
  const records = field.relationTo ? relatedRecords[field.relationTo] : undefined;
  if (!targetEntity || !records) return `#${value}`;
  const match = relationIndexFor(records).get(Number(value));
  return match ? recordDisplayLabel(targetEntity, match) : `#${value}`;
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
 */
function csvEscape(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
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
 * Builds a real, Excel-friendly CSV (CRLF line endings, quoted fields where
 * needed) from an entity's records -- so "download my data" means an
 * actual spreadsheet a business owner can open, not a JSON dump. A relation
 * field resolves to the related record's own display label (e.g. a
 * courier's name), same as the table/board views -- not the raw stored id.
 */
export function recordsToCsv(
  fields: Field[],
  records: EntityRecord[],
  lang: Lang,
  allEntities: Entity[] = [],
  relatedRecords: RelatedRecordsByEntity = {},
): string {
  const header = fields.map((f) => csvEscape(f.label ?? f.name)).join(",");
  const rows = records.map((record) =>
    fields.map((f) => csvEscape(fieldDisplayValue(f, record[f.name], lang, allEntities, relatedRecords))).join(","),
  );
  return [header, ...rows].join("\r\n");
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

function matchesHeader(header: string, field: Field): boolean {
  const normalized = header.trim().toLowerCase();
  return normalized === field.name.toLowerCase() || normalized === (field.label ?? "").toLowerCase();
}

/**
 * Reverses the leading "'" that csvEscape (recordsToCsv's own guard
 * against CSV/formula injection, CWE-1236) prepends to a value starting
 * with =, +, -, @, or a tab/CR. Without this, re-importing a CSV this app
 * itself just exported would permanently bake that guard apostrophe into
 * the data -- a text note like "-1 day late" would come back as the
 * literal string "'-1 day late", and a negative number would fail to
 * parse at all (Number("'-120.5") is NaN), rejecting an otherwise-valid
 * import row. Only strips the apostrophe when the character right after
 * it is one of the guarded ones -- the same condition csvEscape used to
 * add it -- so a value that genuinely starts with a literal "'" (e.g. a
 * name like "'Ohana") is left untouched.
 */
function unescapeCsvGuard(raw: string): string {
  return raw[0] === "'" && /^[=+\-@\t\r]/.test(raw.slice(1)) ? raw.slice(1) : raw;
}

/**
 * Turns parsed CSV rows into record payloads matching `fields`' types --
 * the reverse of `fieldDisplayValue`, so a file this app exported (or a
 * hand-edited copy of one) round-trips back in. Columns are matched to
 * fields by header text (label or field name, case-insensitive); an
 * unmatched column is simply ignored rather than treated as an error,
 * since a spreadsheet often carries extra notes columns.
 *
 * Relation fields are not supported yet -- resolving a CSV cell like
 * "Dana Levi" back to the right foreign-key id needs the related entity's
 * own records loaded, which the caller may not have fetched. A *required*
 * relation field makes every row impossible to satisfy, so this refuses
 * the whole import with one clear error instead of silently producing
 * records that will fail the server's own required-field check one at a
 * time. An *optional* relation column, if present, is ignored per row.
 */
export function buildImportRecords(fields: Field[], rows: string[][]): ImportResult {
  if (rows.length === 0) return { records: [], errors: [] };

  const requiredRelation = fields.find((f) => f.type === "relation" && f.required);
  if (requiredRelation) {
    return {
      records: [],
      errors: [
        `CSV import isn't supported yet for entities with a required relation field ("${requiredRelation.label ?? requiredRelation.name}").`,
      ],
    };
  }

  const [header, ...dataRows] = rows;
  // A field is claimed by at most one column, in header order -- otherwise
  // two fields that share a label (e.g. both renamed to "Status" via
  // FieldLabelEditor, which enforces no uniqueness) would both resolve to
  // whichever field `fields.find` hits first for every matching header
  // cell, silently duplicating that field's data into the other and
  // dropping the other's real column entirely.
  const claimedFieldNames = new Set<string>();
  const columnFields: (Field | null)[] = header.map((cell) => {
    const match = fields.find((f) => !claimedFieldNames.has(f.name) && matchesHeader(cell, f));
    if (match) claimedFieldNames.add(match.name);
    return match ?? null;
  });

  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];

  dataRows.forEach((row, rowIndex) => {
    const isBlank = row.every((cell) => cell.trim() === "");
    if (isBlank) return;

    const record: Record<string, unknown> = {};
    let rowError: string | null = null;

    for (const field of fields) {
      const columnIndex = columnFields.findIndex((f) => f?.name === field.name);
      const raw = columnIndex === -1 ? "" : unescapeCsvGuard((row[columnIndex] ?? "").trim());

      if (field.type === "relation") continue; // see doc comment: not supported per-row yet

      if (raw === "") {
        if (field.required) {
          rowError = `Row ${rowIndex + 1}: missing required field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = field.type === "boolean" ? false : null;
        continue;
      }

      if (field.type === "boolean") {
        record[field.name] = ["true", "1", "yes"].includes(raw.toLowerCase());
      } else if (field.type === "number") {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a number for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = n;
      } else if (field.type === "enum") {
        const byValue = field.enumValues?.find((v) => v.toLowerCase() === raw.toLowerCase());
        const byLabel = field.enumValues?.find((v) => (field.enumLabels?.[v] ?? v).toLowerCase() === raw.toLowerCase());
        const resolved = byValue ?? byLabel;
        if (!resolved) {
          rowError = `Row ${rowIndex + 1}: "${raw}" isn't a valid option for field "${field.label ?? field.name}".`;
          break;
        }
        record[field.name] = resolved;
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
 * Whether a table cell for this field can be edited directly in place with
 * a double-click, instead of always having to open the full add/edit form
 * below the table just to change one value. Relation fields are excluded --
 * their cell already shows a label resolved from a *different* record (see
 * relationDisplayLabel), not the raw stored value the cell would need to
 * edit, so an inline editor there would need the same related-entity
 * picker the full form already gives, with no real space savings.
 */
export function isInlineEditableField(field: Field): boolean {
  return field.type !== "relation";
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
 */
export function isGroupableField(field: Field): boolean {
  return field.type === "enum" || field.type === "boolean";
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
 * there are only ever the two fixed groups, true then false. A group with
 * zero matching records is omitted entirely rather than rendered empty.
 */
export function groupRecordsByField(
  records: EntityRecord[],
  field: Field,
  t: (key: string, params?: Record<string, string | number>) => string,
): RecordGroup[] {
  if (field.type === "boolean") {
    const groups: RecordGroup[] = [];
    const truthy = records.filter((r) => Boolean(r[field.name]));
    const falsy = records.filter((r) => !r[field.name]);
    if (truthy.length > 0) groups.push({ key: "true", label: t("entity.groupBy.yes"), records: truthy });
    if (falsy.length > 0) groups.push({ key: "false", label: t("entity.groupBy.no"), records: falsy });
    return groups;
  }

  const groups: RecordGroup[] = [];
  const known = new Set(field.enumValues ?? []);
  for (const value of field.enumValues ?? []) {
    const matched = records.filter((r) => String(r[field.name] ?? "") === value);
    if (matched.length > 0) groups.push({ key: value, label: field.enumLabels?.[value] ?? value, records: matched });
  }
  const other = records.filter((r) => !known.has(String(r[field.name] ?? "")));
  if (other.length > 0) groups.push({ key: "__other__", label: t("entity.groupBy.other"), records: other });
  return groups;
}
