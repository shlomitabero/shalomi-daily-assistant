import type { Entity, EntityRecord, Field } from "@forge/shared";

/**
 * Round 1006: backs the live calendar subscription feed
 * (routes/calendar.ts's public GET .../feed.ics route) -- a "Subscribe"
 * URL a user pastes once into Google/Apple Calendar or their phone, which
 * that calendar app then re-fetches on its own schedule forever, unlike
 * apps/web/src's existing one-shot "Export ICS" button (EntityPanel.tsx/
 * calendarIcs.ts), which only ever snapshots the records visible in
 * whichever calendar month happens to be open at the moment it's clicked.
 *
 * This file duplicates (deliberately, not imported) the small set of pure
 * field-picking/ICS-formatting helpers calendarIcs.ts and entityFormatting.ts
 * already have on the client side -- the same apps/api-never-imports-
 * apps/web/src convention codegen.ts already follows for the exact same
 * reason (these are two genuinely separate runtimes/packages).
 *
 * Round 1034: DESCRIPTION parity with the one-shot export. allEntities/
 * relatedRecords are optional (default to `[]`/`{}`) so a caller that
 * hasn't fetched relation data (or an existing test) still gets every
 * non-relation DESCRIPTION line, with a relation field degrading to its
 * raw `#<id>` the same way relationDisplayLabel itself degrades when its
 * target entity/records aren't available. `lang` has no per-request
 * session to read (this route has no cookie/auth beyond the feed token
 * itself) -- callers derive it the same way automations.ts/twin.ts/
 * backup.ts already do for their own no-session server-side text,
 * `isHebrewText(project.description)`, rather than this module guessing.
 */

type Lang = "he" | "en";
const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

/** Mirrors apps/web/src/entityFormatting.ts's own RelatedRecordsByEntity exactly. */
export type RelatedRecordsByEntity = Record<string, EntityRecord[]>;

const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduleddate", "eventdate", "duedate", "startdate"];
const END_DATE_FIELD_NAME_HINTS = ["enddate", "returndate", "checkoutdate", "untildate", "todate"];
const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];
const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
// Mirrors entityFormatting.ts's own SAFE_FILE_URL exactly -- see its doc
// comment for why a file field's `url` is checked against this shape
// before ever being trusted (defense-in-depth against a pre-round-908
// record storing something other than this server's own upload route).
const SAFE_FILE_URL = /^\/api\/uploads\/[^/]+\/[^/]+\/[^/]+$/;

export function findDateField(fields: Field[]): Field | null {
  const dateFields = fields.filter((f) => f.type === "date");
  if (dateFields.length === 0) return null;
  const named = dateFields.find((f) => DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named ?? dateFields[0];
}

export function findEndDateField(fields: Field[], startField: Field): Field | null {
  const otherDateFields = fields.filter((f) => f.type === "date" && f.name !== startField.name);
  return otherDateFields.find((f) => END_DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase())) ?? null;
}

function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find(
    (f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()) && f.type !== "relation" && f.type !== "file",
  );
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text") ?? entity.fields.find((f) => f.type === "longtext");
  if (firstText) return firstText;
  const firstDisplayable = entity.fields.find((f) => f.type !== "relation" && f.type !== "file");
  return firstDisplayable ?? entity.fields[0] ?? null;
}

function calendarChipLabelField(entity: Entity, dateField: Field): Field {
  const preferred = pickDisplayField(entity);
  if (preferred && preferred.name !== dateField.name) return preferred;
  return (
    entity.fields.find((f) => f.name !== dateField.name && f.type !== "relation" && f.type !== "file") ?? dateField
  );
}

// Round 1048: mirrors entityFormatting.ts's own identical date-branch fix
// -- a `date` label field (reachable the same way the boolean/enum
// branches above it already are: an entity with two+ date fields and no
// name/title/text/longtext field) rendered the raw unformatted
// "YYYY-MM-DD" string in the subscription feed's own SUMMARY line instead
// of a real formatted date.
function calendarChipLabelValue(labelField: Field, record: EntityRecord, lang: Lang): string {
  const value = record[labelField.name];
  if (value === null || value === undefined) return "";
  if (labelField.type === "boolean") return value ? "TRUE" : "FALSE";
  if (labelField.type === "enum") return (labelField.enumLabels && labelField.enumLabels[String(value)]) || String(value);
  if (labelField.type === "date" && typeof value === "string") return String(formatIcsDescriptionDate(value, lang));
  return String(value);
}

/** Mirrors entityFormatting.ts's own parseFieldDate exactly -- see its doc comment for the local-vs-UTC-midnight rationale. */
function parseFieldDate(raw: string): Date {
  const match = DATE_FORMAT.exec(raw);
  if (match) {
    const [, yearStr, monthStr, dayStr] = match;
    return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  }
  return new Date(raw);
}

/** Mirrors entityFormatting.ts's own parseFileFieldValue exactly. */
function parseFileFieldValue(value: unknown): { name: string } | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(value) as { url?: unknown; name?: unknown };
    if (typeof parsed.url === "string" && SAFE_FILE_URL.test(parsed.url) && typeof parsed.name === "string") {
      return { name: parsed.name };
    }
  } catch {
    // not a file descriptor -- treated as no file, same as an empty value
  }
  return null;
}

/** Mirrors calendarIcs.ts's own formatIcsDescriptionDate exactly. */
function formatIcsDescriptionDate(value: unknown, lang: Lang): unknown {
  if (typeof value !== "string") return value;
  const date = parseFieldDate(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(LOCALE[lang]);
}

/** Round 1090: see calendarIcs.ts's own doc comment for the full rationale -- "he-IL" silently embeds an invisible U+200E before a negative number's minus sign. */
function stripBidiMarks(s: string): string {
  return s.replace(/[‎‏]/g, "");
}

/** Mirrors calendarIcs.ts's own formatIcsDescriptionNumber exactly. */
function formatIcsDescriptionNumber(value: unknown, lang: Lang): unknown {
  return typeof value === "number" ? stripBidiMarks(value.toLocaleString(LOCALE[lang])) : value;
}

/**
 * Mirrors entityFormatting.ts's own recordDisplayLabel exactly (the subset
 * relationDisplayLabel below actually needs -- a relation target record's
 * own label, not a full record's display-everywhere label).
 */
function recordDisplayLabelForRelation(entity: Entity, record: EntityRecord, lang: Lang = "en"): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  if (field?.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  // Round 1072: mirrors entityFormatting.ts's own recordDisplayLabel fix
  // (and this file's own calendarChipLabelValue round-1048 fix just
  // above) -- see their doc comments for the full "no name/title/text/
  // longtext field" reasoning.
  if (field?.type === "date" && typeof value === "string") return String(formatIcsDescriptionDate(value, lang));
  if (field?.type === "relation") return `#${record.id}`;
  if (field?.type === "file") return `#${record.id}`;
  return String(value);
}

/**
 * Mirrors entityFormatting.ts's own relationDisplayLabel exactly, except
 * the id->record index isn't cached in a module-level WeakMap (that exists
 * there to amortize cost across the many independent call sites sharing
 * one render cycle's `relatedRecords` -- table/board/calendar cells, CSV
 * export, search, sorting; this module has exactly one call site per feed
 * request). `indexCache` is passed in instead, built once per
 * buildCalendarFeedIcs call and reused across every record in that same
 * call's loop, which is enough to keep the whole feed O(N+M) rather than
 * O(N*M) without needing a WeakMap's cross-call lifetime at all.
 */
function relationDisplayLabelLocal(
  field: Field,
  value: unknown,
  allEntities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
  indexCache: Map<EntityRecord[], Map<number, EntityRecord>>,
  lang: Lang = "en",
): string {
  if (value === null || value === undefined || value === "") return "";
  const targetEntity = field.relationTo ? allEntities.find((e) => e.name === field.relationTo) : undefined;
  const records = field.relationTo ? relatedRecords[field.relationTo] : undefined;
  if (!targetEntity || !records) return `#${value}`;
  let index = indexCache.get(records);
  if (!index) {
    index = new Map(records.map((r) => [Number(r.id), r]));
    indexCache.set(records, index);
  }
  const match = index.get(Number(value));
  return match ? recordDisplayLabelForRelation(targetEntity, match, lang) : `#${value}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatIcsDate(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function formatIcsTimestamp(date: Date): string {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function icsEscapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function foldIcsLine(line: string): string {
  if (utf8ByteLength(line) <= 75) return line;
  const chars = Array.from(line);
  const parts: string[] = [];
  let current = "";
  let limit = 75;
  for (const ch of chars) {
    const candidate = current + ch;
    if (current !== "" && utf8ByteLength(candidate) > limit) {
      parts.push(current);
      current = ch;
      limit = 74;
    } else {
      current = candidate;
    }
  }
  if (current !== "") parts.push(current);
  return parts.join("\r\n ");
}

/**
 * Builds a real RFC 5545 .ics calendar for EVERY record of `entity` that
 * has a valid value in its auto-detected date field -- not just the
 * records a client happened to pass in for one visible month, the way
 * buildCalendarIcs's one-shot export caller scopes it. Returns null when
 * the entity has no date field at all (nothing for a calendar app to ever
 * subscribe to), so the caller can 404 instead of serving an always-empty
 * feed that looks broken to the subscriber.
 */
export function buildCalendarFeedIcs(
  entity: Entity,
  records: EntityRecord[],
  projectId: string,
  now: Date = new Date(),
  allEntities: Entity[] = [],
  relatedRecords: RelatedRecordsByEntity = {},
  lang: Lang = "en",
): string | null {
  const dateField = findDateField(entity.fields);
  if (!dateField) return null;
  const endField = findEndDateField(entity.fields, dateField);
  const labelField = calendarChipLabelField(entity, dateField);
  // Mirrors calendarIcs.ts's own descriptionFields exactly, minus its
  // orderedFields parameter -- there's no per-user column-order
  // preference to read here (that state lives client-side, keyed by a
  // logged-in collaborator, and this route has no such session), so this
  // always uses the entity's own declared field order.
  const descriptionFields = entity.fields.filter((f) => f.name !== dateField.name && f.name !== labelField.name && f.name !== endField?.name);
  const descriptionLabelOccurrences = new Map<string, number>();
  for (const f of descriptionFields) {
    const label = f.label ?? f.name;
    descriptionLabelOccurrences.set(label, (descriptionLabelOccurrences.get(label) ?? 0) + 1);
  }
  const relationIndexCache = new Map<EntityRecord[], Map<number, EntityRecord>>();
  const dtstamp = formatIcsTimestamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    foldIcsLine(`PRODID:-//Forge AI//${icsEscapeText(entity.label ?? entity.name)}//EN`),
    "CALSCALE:GREGORIAN",
  ];
  for (const record of records) {
    const raw = record[dateField.name];
    if (raw === null || raw === undefined || raw === "") continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw));
    if (!match) continue;
    const [, y, m, d] = match;
    const start = new Date(Number(y), Number(m) - 1, Number(d));
    if (Number.isNaN(start.getTime())) continue;
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    if (endField) {
      const rawEnd = record[endField.name];
      const endMatch = rawEnd === null || rawEnd === undefined || rawEnd === "" ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(String(rawEnd));
      if (endMatch) {
        const [, ey, em, ed] = endMatch;
        const explicitEnd = new Date(Number(ey), Number(em) - 1, Number(ed));
        if (!Number.isNaN(explicitEnd.getTime()) && explicitEnd.getTime() >= start.getTime()) {
          end.setTime(explicitEnd.getTime());
          end.setDate(end.getDate() + 1);
        }
      }
    }
    // Round 1022: calendarIcs.ts's own identical summary computation
    // (the one-shot "Export ICS" button, for the exact same blank-label
    // case) used to fall back to entity.label/entity.name here too -- two
    // calendar-export surfaces disagreeing on what title the same record
    // gets. Falls back to `#<id>` instead, matching the one established
    // "no usable label" convention recordDisplayLabel/displayField.ts
    // already use everywhere else in this app -- always unique per
    // record, unlike entity.label/name, which every unnamed record
    // sharing this entity would otherwise show identically.
    const chipLabel = calendarChipLabelValue(labelField, record, lang);
    const summary = chipLabel === "" ? `#${record.id}` : chipLabel;
    // Mirrors calendarIcs.ts's own descriptionLines computation exactly,
    // including the field-label-collision disambiguation (round 635's
    // fix, applied here the same way calendarIcs.ts already applies it).
    const descriptionLines = descriptionFields
      .map((f) => {
        const value =
          f.type === "relation"
            ? relationDisplayLabelLocal(f, record[f.name], allEntities, relatedRecords, relationIndexCache, lang)
            : f.type === "enum"
              ? (f.enumLabels?.[String(record[f.name])] ?? record[f.name])
              : f.type === "file"
                ? parseFileFieldValue(record[f.name])?.name ?? null
                : f.type === "boolean"
                  ? (record[f.name] ? "TRUE" : "FALSE")
                  : f.type === "date"
                    ? formatIcsDescriptionDate(record[f.name], lang)
                    : f.type === "number"
                      ? formatIcsDescriptionNumber(record[f.name], lang)
                      : record[f.name];
        if (value === null || value === undefined || value === "") return null;
        const fieldLabel = f.label ?? f.name;
        const ambiguous = (descriptionLabelOccurrences.get(fieldLabel) ?? 0) > 1;
        return `${fieldLabel}${ambiguous ? ` (${f.name})` : ""}: ${value}`;
      })
      .filter((line): line is string => line !== null);
    lines.push("BEGIN:VEVENT");
    lines.push(foldIcsLine(`UID:${icsEscapeText(entity.name)}-${record.id}@${projectId}.forge-ai`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDate(end)}`);
    lines.push(foldIcsLine(`SUMMARY:${icsEscapeText(summary)}`));
    if (descriptionLines.length > 0) {
      lines.push(foldIcsLine(`DESCRIPTION:${icsEscapeText(descriptionLines.join("\n"))}`));
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
