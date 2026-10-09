import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductSpecSchema } from "@forge/shared";
import { TEMPLATES } from "./templates.js";

test("every template exposes a schema-valid ProductSpec, in both languages", () => {
  for (const template of TEMPLATES) {
    const result = ProductSpecSchema.safeParse(template.spec);
    assert.ok(result.success, `template "${template.id}" has an invalid spec: ${!result.success ? JSON.stringify(result.error.issues) : ""}`);
    const resultEn = ProductSpecSchema.safeParse(template.specEn);
    assert.ok(resultEn.success, `template "${template.id}" has an invalid specEn: ${!resultEn.success ? JSON.stringify(resultEn.error.issues) : ""}`);
  }
});

/**
 * Round 492's finding: `/projects/from-template`'s own doc comment says
 * `lang` was designed to pick a whole language, but only ever translated
 * the template's name/description -- `spec` (the actual entities/fields a
 * project is built from) stayed Hebrew-only even when `lang: "en"` was
 * requested. `specEn` fixes that, but only if it genuinely describes the
 * *same* entities as `spec` (same names, field names, types, relationTo,
 * enumValues) with just the display text swapped -- otherwise an English
 * pick could silently diverge in shape from its Hebrew counterpart.
 */
test("spec and specEn describe the exact same entity/field shape, with only display text differing", () => {
  for (const template of TEMPLATES) {
    assert.deepEqual(
      template.spec.entities.map((e) => e.name),
      template.specEn.entities.map((e) => e.name),
      `template "${template.id}": spec and specEn must declare entities in the same order with the same names`,
    );
    for (let i = 0; i < template.spec.entities.length; i++) {
      const he = template.spec.entities[i];
      const en = template.specEn.entities[i];
      assert.ok(he.label && he.label.trim().length > 0, `template "${template.id}" entity "${he.name}" is missing a Hebrew label`);
      assert.ok(en.label && en.label.trim().length > 0, `template "${template.id}" entity "${he.name}" is missing an English label`);
      assert.notEqual(en.label, he.label, `template "${template.id}" entity "${he.name}": specEn's label must actually differ from spec's`);
      assert.deepEqual(
        en.fields.map((f) => [f.name, f.type, f.relationTo ?? null, "enumValues" in f ? f.enumValues : null]),
        he.fields.map((f) => [f.name, f.type, f.relationTo ?? null, "enumValues" in f ? f.enumValues : null]),
        `template "${template.id}" entity "${he.name}": specEn's fields must match spec's fields (name/type/relationTo/enumValues), with only labels differing`,
      );
      for (let j = 0; j < he.fields.length; j++) {
        const heField = he.fields[j];
        const enField = en.fields[j];
        assert.ok(enField.label && enField.label.trim().length > 0, `template "${template.id}" entity "${he.name}" field "${heField.name}" is missing an English label`);
        if ("enumLabels" in heField && heField.enumLabels) {
          assert.ok("enumLabels" in enField && enField.enumLabels, `template "${template.id}" entity "${he.name}" field "${heField.name}" is missing English enumLabels`);
          assert.deepEqual(
            Object.keys(enField.enumLabels as Record<string, string>).sort(),
            Object.keys(heField.enumLabels as Record<string, string>).sort(),
            `template "${template.id}" entity "${he.name}" field "${heField.name}": specEn's enumLabels keys must match spec's`,
          );
        }
      }
    }
  }
});

test("template ids are unique", () => {
  const ids = TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test("every template has non-empty Hebrew and English display text", () => {
  for (const template of TEMPLATES) {
    assert.ok(template.name.trim().length > 0, `template "${template.id}" is missing an English name`);
    assert.ok(template.nameHe.trim().length > 0, `template "${template.id}" is missing a Hebrew name`);
    assert.ok(template.description.trim().length > 0, `template "${template.id}" is missing an English description`);
    assert.ok(template.descriptionHe.trim().length > 0, `template "${template.id}" is missing a Hebrew description`);
    assert.ok(template.icon.trim().length > 0, `template "${template.id}" is missing an icon`);
  }
});

/**
 * Round 513's finding: the "Appointments & Clients" template's Appointment.date
 * field was labeled "תאריך ושעה"/"Date & Time" even though no field "type" in
 * this whole system (see @forge/shared's FieldType) captures a time-of-day --
 * `type: "date"` renders as a plain browser <input type="date">
 * (apps/web/src/EntityPanel.tsx) and stores as a date-only TEXT column
 * (packages/db/src/migrate.ts's sqlTypeFor). A curated template's label
 * promising a capability the field type can never deliver is a one-click,
 * permanent user-facing lie, not a one-off AI-generated mistake -- generalized
 * here so any future "date" field whose label claims a time component gets
 * caught immediately, not just this one template's one field.
 */
test("no \"date\"-type field's label claims a time-of-day capability the field can't actually hold", () => {
  const TIME_CLAIM_HINTS_HE = ["ושעה", "שעה "];
  const TIME_CLAIM_HINTS_EN = ["time", "& time"];
  for (const template of TEMPLATES) {
    for (const entity of template.spec.entities) {
      for (const field of entity.fields) {
        if (field.type !== "date") continue;
        const labelLower = field.label.toLowerCase();
        for (const hint of TIME_CLAIM_HINTS_HE) {
          assert.ok(
            !field.label.includes(hint),
            `template "${template.id}" entity "${entity.name}" field "${field.name}": Hebrew label "${field.label}" claims a time component but type:"date" has no time-of-day support`,
          );
        }
        for (const hint of TIME_CLAIM_HINTS_EN) {
          assert.ok(
            !labelLower.includes(hint),
            `template "${template.id}" entity "${entity.name}" field "${field.name}": label "${field.label}" claims a time component but type:"date" has no time-of-day support`,
          );
        }
      }
    }
    for (const entity of template.specEn.entities) {
      for (const field of entity.fields) {
        if (field.type !== "date") continue;
        const labelLower = field.label.toLowerCase();
        for (const hint of TIME_CLAIM_HINTS_EN) {
          assert.ok(
            !labelLower.includes(hint),
            `template "${template.id}" entity "${entity.name}" field "${field.name}": English label "${field.label}" claims a time component but type:"date" has no time-of-day support`,
          );
        }
      }
    }
  }
});

test("every relation field's relationTo names an entity that actually exists in the same template", () => {
  for (const template of TEMPLATES) {
    const entityNames = new Set(template.spec.entities.map((e) => e.name));
    for (const entity of template.spec.entities) {
      for (const field of entity.fields) {
        if (field.type === "relation") {
          assert.ok(
            field.relationTo && entityNames.has(field.relationTo),
            `template "${template.id}" entity "${entity.name}" field "${field.name}" relates to missing entity "${field.relationTo}"`,
          );
        }
      }
    }
  }
});
