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
];

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

/** Formats an ISO date string for display; returns the raw value unchanged if it isn't a valid date. */
export function formatDateValue(value: string, lang: Lang): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(LOCALE[lang]);
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

const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduledat", "eventdate", "duedate"];

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

export interface CalendarDay {
  /** Midnight, local time, for this cell's date. */
  date: Date;
  inCurrentMonth: boolean;
  records: EntityRecord[];
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
      const recordDate = new Date(String(raw));
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

/** Wraps a CSV field in quotes (doubling any interior quotes) only when it contains a comma, quote, or newline. */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Renders a field's value the way a human reading a spreadsheet would
 * expect -- the enum's translated label instead of its raw stored value,
 * a locale-formatted date/number, TRUE/FALSE for booleans (Excel's own
 * convention, language-neutral) -- rather than a 1:1 dump of the raw
 * database values.
 */
function fieldDisplayValue(
  field: Field,
  value: unknown,
  lang: Lang,
  allEntities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") return relationDisplayLabel(field, value, allEntities, relatedRecords) || `#${value}`;
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  if (field.type === "date") return formatDateValue(String(value), lang);
  if (field.type === "number") return formatNumberValue(Number(value), lang);
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
