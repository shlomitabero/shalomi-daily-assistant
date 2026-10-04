import type { Entity, EntityRecord, Field } from "@forge/shared";
import { relationDisplayLabel, type RelatedRecordsByEntity } from "./entityFormatting.js";
import { safeDownloadName } from "./api.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYYMMDD, the VALUE=DATE form RFC 5545 requires for an all-day VEVENT's DTSTART/DTEND. */
function formatIcsDate(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

/** UTC "when this file was generated" timestamp (YYYYMMDDTHHMMSSZ) -- not a record's own date, which DTSTART already carries. */
function formatIcsTimestamp(date: Date): string {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

/** RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, and newline must be backslash-escaped, or a real calendar app's parser can misread the field boundary or drop the value outright. */
function icsEscapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * RFC 5545 §3.1 requires folding any content line longer than 75 octets:
 * a CRLF followed by a single leading space starts the continuation.
 * Without this, a long DESCRIPTION (several fields' worth of values on one
 * line) is exactly the kind of line a strict parser -- unlike the
 * permissive ones used while building this -- could reject or truncate.
 */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = rest.slice(75);
  }
  parts.push(rest);
  return parts.join("\r\n ");
}

/**
 * Builds a real RFC 5545 .ics calendar, one all-day VEVENT per record --
 * the calendar view (CalendarView in EntityPanel.tsx) already renders these
 * records as day chips, but the only "take it with you" action anywhere in
 * this app was CSV export of the raw table, which loses the whole point of
 * a calendar: a month of appointments/bookings you can drop straight into
 * your phone's real calendar app. Caller passes exactly the records the
 * calendar grid currently shows (the active month, respecting whatever
 * search/filter is on), so the exported file matches the screen. Every
 * field other than the date/label fields becomes a "Label: value" line in
 * DESCRIPTION, so an event isn't just a bare name once it's out of this app.
 *
 * When `endField` is given and holds a valid date on/after the record's
 * start (e.g. a Rental's endDate), the event spans through that day instead
 * of always being a single day long -- RFC 5545's all-day DTEND is
 * exclusive, so it's set to one day *after* the end field's own date, not
 * the end date itself. A missing/invalid/earlier-than-start end value falls
 * back to the previous single-day behavior.
 */
export function buildCalendarIcs(
  entity: Entity,
  dateField: Field,
  labelField: Field,
  records: EntityRecord[],
  allEntities: Entity[],
  relatedRecords: RelatedRecordsByEntity,
  now: Date = new Date(),
  endField?: Field | null,
): string {
  const dtstamp = formatIcsTimestamp(now);
  const descriptionFields = entity.fields.filter(
    (f) => f.name !== dateField.name && f.name !== labelField.name && f.name !== endField?.name,
  );
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//Forge AI//${icsEscapeText(entity.label ?? entity.name)}//EN`,
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
    const labelRaw = labelField.type === "enum" ? (labelField.enumLabels?.[String(record[labelField.name])] ?? record[labelField.name]) : record[labelField.name];
    const summary = String(labelRaw ?? entity.label ?? entity.name);
    const descriptionLines = descriptionFields
      .map((f) => {
        // Mirrors entityFormatting.ts's own relation/enum resolution (used
        // by CSV export, Kanban, table grouping, and search) -- without
        // this, an enum field like status="shipped" would show its raw
        // stored value in the exported .ics instead of the same Hebrew
        // enumLabels translation every other view of this data already
        // shows, which is exactly the "take it with you" gap this export
        // exists to avoid.
        const value =
          f.type === "relation"
            ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords)
            : f.type === "enum"
              ? (f.enumLabels?.[String(record[f.name])] ?? record[f.name])
              : record[f.name];
        if (value === null || value === undefined || value === "") return null;
        return `${f.label ?? f.name}: ${value}`;
      })
      .filter((line): line is string => line !== null);
    lines.push("BEGIN:VEVENT");
    lines.push(foldIcsLine(`UID:${entity.name}-${record.id}@forge-ai`));
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

/** Real browser download, same Blob+anchor mechanics recordsToCsv's caller and downloadWhatsAppLog already use. */
export function downloadCalendarIcs(ics: string, entityName: string): void {
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(entityName, "calendar")}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
