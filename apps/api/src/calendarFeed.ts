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
 * reason (these are two genuinely separate runtimes/packages). Scoped down
 * from the client-side export in one deliberate way: this feed's own
 * VEVENTs carry only SUMMARY/DTSTART/DTEND, not the full per-field
 * DESCRIPTION dump buildCalendarIcs produces (which needs relation/enum/
 * file-field resolution against the whole project's related records) --
 * a real, useful subscription feed (see every record's date/title live,
 * auto-updating) without that extra duplicated surface. A future round
 * can add DESCRIPTION parity if it's ever actually wanted.
 */

const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduleddate", "eventdate", "duedate", "startdate"];
const END_DATE_FIELD_NAME_HINTS = ["enddate", "returndate", "checkoutdate", "untildate", "todate"];
const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];

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

function calendarChipLabelValue(labelField: Field, record: EntityRecord): string {
  const value = record[labelField.name];
  if (value === null || value === undefined) return "";
  if (labelField.type === "boolean") return value ? "TRUE" : "FALSE";
  if (labelField.type === "enum") return (labelField.enumLabels && labelField.enumLabels[String(value)]) || String(value);
  return String(value);
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
export function buildCalendarFeedIcs(entity: Entity, records: EntityRecord[], projectId: string, now: Date = new Date()): string | null {
  const dateField = findDateField(entity.fields);
  if (!dateField) return null;
  const endField = findEndDateField(entity.fields, dateField);
  const labelField = calendarChipLabelField(entity, dateField);
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
    const summary = calendarChipLabelValue(labelField, record) || entity.label || entity.name;
    lines.push("BEGIN:VEVENT");
    lines.push(foldIcsLine(`UID:${icsEscapeText(entity.name)}-${record.id}@${projectId}.forge-ai`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDate(end)}`);
    lines.push(foldIcsLine(`SUMMARY:${icsEscapeText(summary)}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
