import type { Entity, EntityRecord, Field } from "@forge/shared";
import { parseFieldDate, parseFileFieldValue, relationDisplayLabel, type RelatedRecordsByEntity } from "./entityFormatting.js";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

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

/**
 * Mirrors apps/api/src/automations.ts's own interpolateTemplate branches
 * for these two types -- see this file's own call-site comment above for
 * why the CSV-export rationale for leaving date/number raw doesn't apply
 * to a one-way .ics export. Falls back to the raw stored value when it
 * isn't a parseable date, the same "never show nothing" behavior
 * interpolateTemplate itself uses.
 */
function formatIcsDescriptionDate(value: unknown, lang: Lang): unknown {
  if (typeof value !== "string") return value;
  const date = parseFieldDate(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(LOCALE[lang]);
}

function formatIcsDescriptionNumber(value: unknown, lang: Lang): unknown {
  return typeof value === "number" ? value.toLocaleString(LOCALE[lang]) : value;
}

/** RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, and newline must be backslash-escaped, or a real calendar app's parser can misread the field boundary or drop the value outright. */
function icsEscapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * RFC 5545 §3.1's 75-octet limit counts bytes of the UTF-8-encoded line,
 * not JS string length (UTF-16 code units) -- a distinction that matters
 * immediately for this Hebrew-primary app: every Hebrew character is 1
 * UTF-16 unit (so `.length` counts it as 1) but 2 UTF-8 bytes, so counting
 * characters let a DESCRIPTION/SUMMARY line up to 150 real bytes through
 * completely unfolded, or folded a longer one into still-150-byte chunks --
 * exactly the "a strict parser could reject or truncate" failure
 * foldIcsLine exists to prevent, defeated for its own primary audience.
 * TextEncoder (not Buffer, which doesn't exist in this file's actual
 * browser runtime) gives the real UTF-8 byte length in both the browser
 * and this file's Node-based test runner.
 */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * RFC 5545 §3.1 requires folding any content line longer than 75 octets:
 * a CRLF followed by a single leading space starts the continuation. That
 * leading space is part of the printed physical line, so a continuation
 * chunk can only hold 74 bytes of real content -- the first chunk (which
 * gets no leading space) is the only one allowed the full 75. Missing this
 * meant every continuation line printed at 76 octets, one over budget,
 * regardless of character set -- caught by this round's own new Hebrew
 * test asserting every folded physical line, not just the first.
 * Splits on whole characters (Array.from, not raw indices, so a surrogate
 * pair is never torn in half) while tracking UTF-8 bytes, so each physical
 * output line -- not just its character count -- stays within budget.
 */
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
 *
 * `orderedFields` -- defaulting to `entity.fields` so every existing
 * caller/test keeps its exact current behavior -- is this module's own
 * version of the `orderedFields` convention rounds 615/621/670/678/684
 * already enforce across EntityPanel.tsx's whole-record render paths
 * (CSV export, print, the Columns menu, board cards, the record form, the
 * bulk-edit/filter/group-by pickers): the DESCRIPTION lines below list
 * fields in the user's drag-reordered column order, not the entity's raw
 * declared order, matching the calendar grid's own chips right next to
 * this export button.
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
  orderedFields: Field[] = entity.fields,
  lang: Lang = "en",
): string {
  const dtstamp = formatIcsTimestamp(now);
  const descriptionFields = orderedFields.filter(
    (f) => f.name !== dateField.name && f.name !== labelField.name && f.name !== endField?.name,
  );
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    // PRODID's own content (entity.label) is exactly as unbounded and
    // user-controlled as UID/SUMMARY/DESCRIPTION below (EntitySchema.label
    // has no length cap) -- missed when this line was first added, since a
    // short, developer-chosen name never came close to the 75-octet limit
    // foldIcsLine exists to enforce (round 551).
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
    const labelRaw = labelField.type === "enum" ? (labelField.enumLabels?.[String(record[labelField.name])] ?? record[labelField.name]) : record[labelField.name];
    const summary = String(labelRaw ?? entity.label ?? entity.name);
    // Same label-collision gap twin.ts's Business Twin observations had
    // (round 635 fixed it there): only field.name is unique, never .label,
    // so two description fields here can legally share a label (e.g. two
    // number fields both renamed to "Amount"). Disambiguated with each
    // field's own (always-unique) name, the same fix round 635 already
    // applied, so a real calendar app doesn't show two identical-looking
    // "Amount: ..." lines with no way to tell them apart.
    const descriptionLabelOccurrences = new Map<string, number>();
    for (const f of descriptionFields) {
      const label = f.label ?? f.name;
      descriptionLabelOccurrences.set(label, (descriptionLabelOccurrences.get(label) ?? 0) + 1);
    }
    const descriptionLines = descriptionFields
      .map((f) => {
        // Mirrors entityFormatting.ts's own relation/enum resolution (used
        // by CSV export, Kanban, table grouping, and search) -- without
        // this, an enum field like status="shipped" would show its raw
        // stored value in the exported .ics instead of the same Hebrew
        // enumLabels translation every other view of this data already
        // shows, which is exactly the "take it with you" gap this export
        // exists to avoid.
        // A "file" field's stored value is a JSON-encoded descriptor
        // (url/name/size/mimeType), not a plain string -- without this
        // branch, it falls into the generic `record[f.name]` case below
        // and writes that raw JSON verbatim into the exported .ics,
        // visibly broken in any real calendar app and leaking the
        // server's internal upload URL path structure into a file a user
        // might forward or publish. Mirrors entityFormatting.ts's own
        // fieldDisplayValue, which already has this exact branch.
        // A "boolean" field's stored value is a real JS boolean
        // (rowToRecord/repository.ts always yields one) -- without this
        // branch it falls into the generic `record[f.name]` case below and
        // template-literal-interpolates straight to JS's own lowercase
        // "true"/"false", inconsistent with the uppercase "TRUE"/"FALSE"
        // this app uses everywhere else a boolean becomes display text
        // (fieldDisplayValue/CSV export, interpolateTemplate/automation
        // messages, twin.ts's enum-distribution insight).
        // "date"/"number" are locale-formatted the same way apps/api/src/
        // automations.ts's own interpolateTemplate already does for a
        // WhatsApp message referencing the same field -- that function's
        // own doc comment explains why: fieldDisplayValue (CSV export)
        // deliberately leaves these two raw ONLY so a CSV round-trips
        // exactly through buildImportRecords' re-parse; this .ics export
        // is never re-imported by this app either, exactly like a
        // WhatsApp message, so the CSV rationale for leaving them raw
        // doesn't apply here -- without this, a number field like
        // "budget" exported "50000" into a real calendar app's event
        // description instead of this same field's own on-screen
        // "50,000" (formatNumberValue) or WhatsApp-message formatting.
        const value =
          f.type === "relation"
            ? relationDisplayLabel(f, record[f.name], allEntities, relatedRecords)
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
    // entity.name is exactly as unbounded and AI/user-controlled as
    // entity.label already is in PRODID above (EntitySchema.name is a
    // bare z.string().min(1), with no character restriction actually
    // enforced -- see backup.ts's sanitizeZipEntryName comment for the
    // same gap already defended against for ZIP paths) -- missed when
    // this line was first written, even though PRODID's own round-551
    // fix comment already described UID as one of the lines that
    // *should* be escaped like SUMMARY/DESCRIPTION.
    lines.push(foldIcsLine(`UID:${icsEscapeText(entity.name)}-${record.id}@forge-ai`));
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
