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
  if (POSITIVE_WORDS.some((w) => lower.includes(w))) return "positive";
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) return "negative";
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

/** True if any of the entity's fields on this record contain the search query (case-insensitive). */
export function matchesSearch(record: EntityRecord, fields: Field[], query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return fields.some((field) => {
    const value = record[field.name];
    if (value === null || value === undefined) return false;
    const display = field.type === "enum" ? (field.enumLabels?.[String(value)] ?? String(value)) : String(value);
    return display.toLowerCase().includes(trimmed);
  });
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
): EntitySearchResult | null {
  if (!query.trim()) return null;
  const matches = records.filter((r) => matchesSearch(r, entity.fields, query));
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

/** Sorts a copy of `records` by `field.name`; returns `records` unchanged (same reference) when `sortField` is null. */
export function sortRecords(records: EntityRecord[], sortField: string | null, direction: SortDirection): EntityRecord[] {
  if (!sortField) return records;
  const sorted = [...records].sort((a, b) => compareValues(a[sortField], b[sortField]));
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
export function sortRecordsMulti(records: EntityRecord[], sortKeys: SortKey[]): EntityRecord[] {
  if (sortKeys.length === 0) return records;
  return [...records].sort((a, b) => {
    for (const { field, direction } of sortKeys) {
      const cmp = compareValues(a[field], b[field]);
      if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

const BOARD_FIELD_NAME_HINTS = ["status", "stage"];

/**
 * Picks the enum field an entity's records should be grouped into columns
 * by, if any -- this is what turns a "Deal" or "Order" entity into a real
 * Kanban board instead of the same table shape every entity gets. Prefers
 * a field literally named "status"/"stage" (the domain library's own
 * convention, see spec-engine/domainEntities.ts), then falls back to the
 * first enum field with a workable number of columns (2-8); returns null
 * when nothing fits, so a plain entity (like "Customer" with only a text
 * "name" field) never gets forced into a board it doesn't suit.
 */
export function findBoardField(fields: Field[]): Field | null {
  const enumFields = fields.filter(
    (f) => f.type === "enum" && f.enumValues && f.enumValues.length >= 2 && f.enumValues.length <= 8,
  );
  if (enumFields.length === 0) return null;
  const named = enumFields.find((f) => BOARD_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named ?? enumFields[0];
}

export interface BoardColumn {
  value: string;
  label: string;
  records: EntityRecord[];
}

/**
 * Groups records into one column per declared enum value, in the enum's
 * own declared order (not first-seen order) -- including a value with zero
 * matching records, so an empty stage still shows as a column rather than
 * silently disappearing.
 */
export function groupByField(records: EntityRecord[], field: Field): BoardColumn[] {
  const values = field.enumValues ?? [];
  return values.map((value) => ({
    value,
    label: field.enumLabels?.[value] ?? value,
    records: records.filter((r) => String(r[field.name]) === value),
  }));
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

function isSameDay(a: Date, b: Date): boolean {
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
function parseFieldDate(raw: string): Date {
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
 */
export function buildCalendarMonth(records: EntityRecord[], field: Field, year: number, month: number): CalendarDay[] {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dayRecords = records.filter((r) => {
      const raw = r[field.name];
      if (raw === null || raw === undefined || raw === "") return false;
      const recordDate = parseFieldDate(String(raw));
      return !Number.isNaN(recordDate.getTime()) && isSameDay(recordDate, date);
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
  const match = records.find((r) => Number(r.id) === Number(value));
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
  const columnFields: (Field | null)[] = header.map((cell) => fields.find((f) => matchesHeader(cell, f)) ?? null);

  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];

  dataRows.forEach((row, rowIndex) => {
    const isBlank = row.every((cell) => cell.trim() === "");
    if (isBlank) return;

    const record: Record<string, unknown> = {};
    let rowError: string | null = null;

    for (const field of fields) {
      const columnIndex = columnFields.findIndex((f) => f?.name === field.name);
      const raw = columnIndex === -1 ? "" : (row[columnIndex] ?? "").trim();

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
