import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductSpecSchema } from "@forge/shared";
import { TEMPLATES } from "./templates.js";

test("every template exposes a schema-valid ProductSpec", () => {
  for (const template of TEMPLATES) {
    const result = ProductSpecSchema.safeParse(template.spec);
    assert.ok(result.success, `template "${template.id}" has an invalid spec: ${!result.success ? JSON.stringify(result.error.issues) : ""}`);
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
