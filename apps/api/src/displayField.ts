import type { Entity, EntityRecord, Field } from "@forge/shared";

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
 */
export function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
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
 */
export function recordDisplayLabel(entity: Entity, record: EntityRecord): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  if (field?.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  return String(value);
}
