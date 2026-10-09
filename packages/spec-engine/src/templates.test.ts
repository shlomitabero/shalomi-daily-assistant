import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductSpecSchema } from "@forge/shared";
import { isHebrewText } from "./domainEntities.js";
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

/**
 * Round 516's finding: the "Appointments & Clients" template's Hebrew
 * Appointment.status enum mapped "scheduled" to "קבוע" (meaning "fixed" /
 * "permanent" / "standing" in Hebrew), not "scheduled". This codebase
 * already translates this exact concept correctly and consistently
 * elsewhere -- domainEntities.ts's own heuristic Appointment entity uses
 * "מתוכנן" and its WorkOrder entity uses "מתוזמנת" -- and "קבוע" appeared
 * nowhere else in spec-engine, confirming it was an isolated mistranslation,
 * not an intentional alternate wording. A Hebrew-UI user booking a one-off
 * appointment would see its status rendered as "standing/recurring", a
 * materially different and misleading meaning.
 */
test("the Appointments template's Hebrew status enum doesn't mistranslate \"scheduled\" as \"recurring/standing\"", () => {
  const appointmentsTemplate = TEMPLATES.find((t) => t.id === "appointments");
  assert.ok(appointmentsTemplate, "expected an \"appointments\" template to exist");
  const appointmentEntity = appointmentsTemplate!.spec.entities.find((e) => e.name === "Appointment");
  assert.ok(appointmentEntity, "expected the Appointments template to declare an Appointment entity");
  const statusField = appointmentEntity!.fields.find((f) => f.name === "status");
  assert.ok(statusField && "enumLabels" in statusField && statusField.enumLabels, "expected Appointment.status to have enumLabels");
  const scheduledLabel = (statusField as { enumLabels: Record<string, string> }).enumLabels.scheduled;
  assert.notEqual(scheduledLabel, "קבוע", "\"scheduled\" must not be mistranslated as \"קבוע\" (fixed/permanent/standing)");
  assert.equal(scheduledLabel, "מתוכנן", "\"scheduled\" should match this codebase's own established translation (domainEntities.ts's Appointment entity)");
});

/**
 * Round 517's finding: every template's `roles` array was plain English,
 * reused byte-for-byte between the Hebrew `spec` and the English `specEn`
 * -- unlike every other display field (entity/field labels, enumLabels,
 * summary), which already has a real Hebrew/English split. heuristic.ts's
 * own matchRoles() already translates roles to Hebrew via ROLE_RULES's
 * labelHe when isHebrew is true, so templates were the one spec-generation
 * path that skipped this established convention. A Hebrew-UI user picking
 * any template (POST /projects/from-template) saw English role chips (e.g.
 * "Manager", "Staff") on the otherwise fully-Hebrew spec review screen
 * (apps/web/src/App.tsx's spec.roles.heading section).
 */
test("every template's Hebrew spec.roles are genuinely Hebrew, not reused English strings from specEn", () => {
  for (const template of TEMPLATES) {
    assert.ok(template.spec.roles.length > 0, `template "${template.id}" has an empty roles array`);
    assert.deepEqual(
      template.spec.roles.length,
      template.specEn.roles.length,
      `template "${template.id}": spec and specEn must declare the same number of roles`,
    );
    for (const role of template.spec.roles) {
      assert.ok(isHebrewText(role), `template "${template.id}": Hebrew spec.roles contains a non-Hebrew role "${role}"`);
    }
    assert.notDeepEqual(
      template.spec.roles,
      template.specEn.roles,
      `template "${template.id}": spec.roles must not be byte-identical to specEn.roles`,
    );
  }
});
