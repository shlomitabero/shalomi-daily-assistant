import type { Entity, EntityRecord, Field } from "@forge/shared";

const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];

/** Picks the field that best represents a record as a short human label -- prefers "name"/"title", then the first text field. */
export function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText ?? entity.fields[0] ?? null;
}

/** Renders a record as a short human label using pickDisplayField, falling back to "#<id>" when there's no usable value. */
export function recordDisplayLabel(entity: Entity, record: EntityRecord): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  return String(value);
}
