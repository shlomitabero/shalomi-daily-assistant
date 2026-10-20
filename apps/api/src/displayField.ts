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
 */
export function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  if (firstText) return firstText;
  const firstNonRelation = entity.fields.find((f) => f.type !== "relation");
  return firstNonRelation ?? entity.fields[0] ?? null;
}

/** Renders a record as a short human label using pickDisplayField, falling back to "#<id>" when there's no usable value. */
export function recordDisplayLabel(entity: Entity, record: EntityRecord): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  return String(value);
}
