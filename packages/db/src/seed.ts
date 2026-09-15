import type { Entity, Field } from "@forge/shared";

const HEBREW_PATTERN = /[֐-׿]/;

// Believable-looking sample values for the specific field names this
// platform's own domain entity library actually generates (see
// packages/spec-engine/src/domainEntities.ts) — picked cyclically by
// record index so a freshly built app's first table doesn't read as
// "Lorem Ipsum" (e.g. "Customer - name 1"). This is still fabricated demo
// data, not real business data — it's just no longer obviously a
// placeholder formula.
const PERSON_NAMES_HE = ["דנה לוי", "יוסי כהן", "מיכל אברהם", "רון פרץ", "נועה שרון", "אלון מזרחי"];
const PERSON_NAMES_EN = ["Dana Levi", "Yossi Cohen", "Michal Abraham", "Ron Peretz", "Noa Sharon", "Alon Mizrahi"];
const ITEM_NAMES_HE = ["חבילת בסיס", "שדרוג פרימיום", "טיפול סטנדרטי", "מנוי חודשי"];
const ITEM_NAMES_EN = ["Basic Package", "Premium Upgrade", "Standard Treatment", "Monthly Plan"];
const EMAIL_LOCAL_PARTS = ["dana.levi", "yossi.cohen", "michal.abraham", "ron.peretz", "noa.sharon", "alon.mizrahi"];
const PHONES_HE = ["050-123-4567", "052-987-6543", "054-222-1188", "058-765-4321"];
const PHONES_EN = ["(555) 123-4567", "(555) 987-6543", "(555) 222-1188", "(555) 765-4321"];
const SOURCES_HE = ["אתר האינטרנט", "המלצה מלקוח", "פייסבוק", "חיפוש בגוגל"];
const SOURCES_EN = ["Website", "Customer referral", "Facebook Ads", "Google Search"];
const ROLES_HE = ["מוכר/ת", "טכנאי/ת", "מנהל/ת משמרת", "רכז/ת שירות"];
const ROLES_EN = ["Sales Associate", "Technician", "Shift Manager", "Service Coordinator"];
const DEAL_TITLES_HE = ["שדרוג חבילת שירות", "התקנה ראשונית", "חוזה שנתי", "הרחבת מנוי"];
const DEAL_TITLES_EN = ["Service upgrade", "Initial setup", "Annual contract", "Plan expansion"];

function pick(pool: string[], index: number): string {
  return pool[index % pool.length];
}

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
      return textSeedValueFor(field.name, entity.name, isHebrew, index);
  }
}

function textSeedValueFor(fieldName: string, entityName: string, isHebrew: boolean, index: number): string {
  switch (fieldName) {
    case "email":
      return `${pick(EMAIL_LOCAL_PARTS, index)}@example.com`;
    case "phone":
      return pick(isHebrew ? PHONES_HE : PHONES_EN, index);
    case "source":
      return pick(isHebrew ? SOURCES_HE : SOURCES_EN, index);
    case "role":
      return pick(isHebrew ? ROLES_HE : ROLES_EN, index);
    case "sku":
      return `SKU-${1000 + index * 42}`;
    case "title":
      return pick(isHebrew ? DEAL_TITLES_HE : DEAL_TITLES_EN, index);
    case "customerName":
    case "owner":
      return pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    case "service":
      return pick(isHebrew ? ITEM_NAMES_HE : ITEM_NAMES_EN, index);
    case "name":
      // "name" means a person for people-shaped entities and a thing for
      // catalog-shaped ones — the same field name, two different meanings.
      return entityName === "Service" || entityName === "Product"
        ? pick(isHebrew ? ITEM_NAMES_HE : ITEM_NAMES_EN, index)
        : pick(isHebrew ? PERSON_NAMES_HE : PERSON_NAMES_EN, index);
    default:
      // No specific pool for this field name (a custom entity from an
      // AI-generated or refined spec, not the built-in domain library) —
      // fall back to a labeled placeholder rather than guessing wrong.
      return isHebrew ? `${entityName} - ${fieldName} ${index + 1}` : `${entityName} ${fieldName} ${index + 1}`;
  }
}

/**
 * Deterministic seed-data generator used by the Seed Data Agent step of the
 * build pipeline. No randomness, no LLM call — genuinely realistic-looking
 * values derived from each field's type and name, so a freshly built app
 * never opens to an empty, unconvincing table.
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
