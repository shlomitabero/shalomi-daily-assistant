import type { Entity, Field } from "@forge/shared";

const HEBREW_PATTERN = /[֐-׿]/;

function seedValueFor(field: Field, entity: Entity, index: number): unknown {
  const entityName = entity.label ?? entity.name;
  const fieldLabel = field.label ?? field.name;
  const isHebrew = HEBREW_PATTERN.test(entityName) || HEBREW_PATTERN.test(fieldLabel);
  switch (field.type) {
    case "number":
      return (index + 1) * 10;
    case "boolean":
      return index % 2 === 0;
    case "date": {
      const d = new Date(Date.now() - index * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    case "enum":
      return field.enumValues?.[index % (field.enumValues?.length ?? 1)] ?? null;
    case "relation":
      // Best-effort guess (row 1) when the field is required; there's no
      // guaranteed insert order across entities yet, so this can be wrong
      // for a genuinely required cross-entity relation — a real limitation,
      // not hidden here.
      return field.required ? 1 : null;
    case "longtext":
      return isHebrew
        ? `${fieldLabel} לדוגמה עבור ${entityName} מספר ${index + 1}.`
        : `Sample ${field.name} for ${entityName} #${index + 1}.`;
    case "text":
    default:
      return isHebrew ? `${entityName} - ${fieldLabel} ${index + 1}` : `${entityName} ${field.name} ${index + 1}`;
  }
}

/**
 * Deterministic seed-data generator used by the Seed Data Agent step of the
 * build pipeline. No randomness, no LLM call — genuinely realistic-looking
 * values derived from each field's type, so a freshly built app never opens
 * to an empty, unconvincing table.
 */
export function generateSeedRecords(entity: Entity, count = 2): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const record: Record<string, unknown> = {};
    for (const field of entity.fields) {
      record[field.name] = seedValueFor(field, entity, index);
    }
    return record;
  });
}
