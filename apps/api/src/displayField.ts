import type { Entity, EntityRecord, Field } from "@forge/shared";

type Lang = "he" | "en";
const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };
const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Mirrors calendarFeed.ts's own parseFieldDate exactly -- see its doc comment for the local-vs-UTC-midnight rationale. */
function parseFieldDate(raw: string): Date {
  const match = DATE_FORMAT.exec(raw);
  if (match) {
    const [, yearStr, monthStr, dayStr] = match;
    return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  }
  return new Date(raw);
}

/**
 * Mirrors automations.ts's own stripBidiMarks exactly -- see its doc
 * comment for the full "V8/ICU's toLocaleString('he-IL') silently
 * prepends an invisible bidi mark before a negative number's minus sign"
 * rationale. Needed here because recordDisplayLabel's own output (below)
 * isn't only shown on-screen (where that invisible mark is harmless) --
 * it also flows into automations.ts's own relation-placeholder resolver,
 * which embeds it verbatim into a real outbound WhatsApp/email/webhook
 * message with no RTL bidi context left to protect.
 */
function stripBidiMarks(s: string): string {
  return s.replace(/[‎‏]/g, "");
}

const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];

/**
 * Picks the field that best represents a record as a short human label --
 * prefers "name"/"title", then the first text field. A join/line-item
 * entity (e.g. `Enrollment { studentId: relation, courseId: relation,
 * grade: enum }`) can legitimately have no name/title/text field at all --
 * `EntitySchema` only requires at least one field, nothing requires a
 * text one -- so the last-resort fallback explicitly skips `relation`
 * fields too: without this, recordDisplayLabel would render the *related*
 * record's own raw internal id (e.g. "4") as if it were this record's own
 * label, everywhere a record is shown by name (a relation picker's own
 * <option> list, CSV export/import's relation-cell matching, WhatsApp
 * template interpolation) -- indistinguishable from every other record
 * pointing at the same related row. Only once every single field is
 * itself a relation does this fall back to the first one regardless --
 * there's nothing else left to show.
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
 * Renders a record as a short human label using pickDisplayField, falling
 * back to "#<id>" when there's no usable value. When the picked field is
 * an `enum` (e.g. the last-resort fallback above landing on one, for a
 * join entity with no name/title/text field), resolves it through the
 * field's own `enumLabels` the same way every other enum render path in
 * this codebase already does (EntityPanel.tsx's cells, entityFormatting.
 * ts's own fieldDisplayValue/matchesSearch, etc.) -- without this, a
 * record shown by this label elsewhere (a relation picker, an Automation
 * Rule's WhatsApp message, Business Twin's narrative sentences) would
 * show the field's raw stored value (e.g. the English enum key "in")
 * instead of its translated display text (e.g. "כניסה").
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
  // field -- see entityFormatting.ts's own identical fix for the full
  // "no name/title/text/longtext field" reasoning. Mirrors calendarFeed.ts's
  // own date-formatting convention exactly.
  if (field?.type === "date" && typeof value === "string") {
    const date = parseFieldDate(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(LOCALE[lang]);
  }
  // Round 1227: the SAME last-resort fallback can also land on a `number`
  // field -- a measurement-only entity like `StockLevel { quantity:
  // number, warehouseId: relation }` has no name/title/text/longtext/
  // enum/boolean/date field at all, so pickDisplayField's own final step
  // picks the number field regardless. Falling through to `String(value)`
  // here would render the raw, un-grouped digits ("1500" instead of
  // "1,500") as this record's own label everywhere one is shown by name --
  // inconsistent with interpolateTemplate's (automations.ts) own
  // established `number` branch, which already locale-formats for the
  // identical "one-way human reading" reason. stripBidiMarks matches that
  // same branch's own convention exactly.
  if (field?.type === "number" && typeof value === "number") return stripBidiMarks(value.toLocaleString(LOCALE[lang]));
  if (field?.type === "relation") return `#${record.id}`;
  // Round 982: the SAME last-resort fallback can also land on a `file`
  // field -- an attachment/join entity like `Enrollment { certificate:
  // file, studentId: relation->Student }` has no name/title/text/enum
  // field at all, only a file and a relation, so pickDisplayField's own
  // final step picks whichever was declared first regardless (round
  // 749's own doc comment above already calls this hazard out, but only
  // ever fixed the EXCLUSION in pickDisplayField, not this safety net
  // here). Falling through to `String(value)` here would String() the
  // file's raw JSON upload descriptor (including the server's internal
  // upload path) as the record's own label. `#${record.id}` matches the
  // exact same fallback the relation branch just above already uses, for
  // the identical reason: always unique per record, unlike the file's own
  // name (routinely reused across unrelated uploads).
  if (field?.type === "file") return `#${record.id}`;
  return String(value);
}
