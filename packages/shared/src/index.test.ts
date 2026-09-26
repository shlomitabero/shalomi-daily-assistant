import assert from "node:assert/strict";
import { test } from "node:test";
import { EntitySchema, FieldSchema, ProductSpecSchema } from "./index.js";

/**
 * FieldSchema's two `.refine()` checks -- an enum field must declare
 * enumValues, a relation field must declare relationTo -- had never been
 * exercised by any test in the whole codebase. Every existing fixture that
 * uses an enum or relation field (across packages/db, apps/api, apps/web)
 * already supplies a valid enumValues/relationTo, since those fixtures
 * exist to test *other* behavior, not this validation itself. A refine
 * predicate that silently stopped rejecting (e.g. an inverted condition,
 * a typo'd field name) would have shipped undetected.
 */
test("FieldSchema rejects an enum field with no enumValues at all", () => {
  const result = FieldSchema.safeParse({ name: "status", type: "enum", required: true });
  assert.ok(!result.success);
  assert.match(result.error.issues[0].message, /enum fields must declare enumValues/);
});

test("FieldSchema rejects an enum field with an empty enumValues array", () => {
  const result = FieldSchema.safeParse({ name: "status", type: "enum", required: true, enumValues: [] });
  assert.ok(!result.success);
  assert.match(result.error.issues[0].message, /enum fields must declare enumValues/);
});

test("FieldSchema accepts an enum field with at least one enumValue", () => {
  const result = FieldSchema.safeParse({ name: "status", type: "enum", required: true, enumValues: ["New"] });
  assert.ok(result.success);
});

test("FieldSchema rejects a relation field with no relationTo", () => {
  const result = FieldSchema.safeParse({ name: "customerId", type: "relation", required: false });
  assert.ok(!result.success);
  assert.match(result.error.issues[0].message, /relation fields must declare relationTo/);
});

test("FieldSchema accepts a relation field that declares relationTo", () => {
  const result = FieldSchema.safeParse({ name: "customerId", type: "relation", required: false, relationTo: "Customer" });
  assert.ok(result.success);
});

/**
 * RESERVED_FIELD_NAMES's rejection is already exercised indirectly (via
 * AnthropicSpecProvider's own tests, one case each), but never at the
 * schema itself -- and never for both reserved names together, or for a
 * case variant of "id" specifically (only "createdAt"'s casing was ever
 * tried indirectly).
 */
test("FieldSchema rejects a field literally named 'id', case-insensitively, since every table already has a built-in id column", () => {
  for (const name of ["id", "ID", "Id"]) {
    const result = FieldSchema.safeParse({ name, type: "text", required: false });
    assert.ok(!result.success, `expected "${name}" to be rejected`);
    assert.match(result.error.issues[0].message, /collides with a built-in column/);
  }
});

test("FieldSchema rejects a field literally named 'createdAt', case-insensitively, since every table already has a built-in createdAt column", () => {
  for (const name of ["createdAt", "createdat", "CREATEDAT"]) {
    const result = FieldSchema.safeParse({ name, type: "text", required: false });
    assert.ok(!result.success, `expected "${name}" to be rejected`);
    assert.match(result.error.issues[0].message, /collides with a built-in column/);
  }
});

test("FieldSchema accepts an ordinary field name that merely contains 'id' as a substring, not the whole reserved name", () => {
  const result = FieldSchema.safeParse({ name: "vendorId", type: "text", required: false });
  assert.ok(result.success);
});

function baseSpec(entities: unknown[]) {
  return {
    summary: "A tiny app",
    personas: [],
    roles: ["Admin"],
    entities,
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
}

test("ProductSpecSchema rejects two entities whose names collide case-insensitively", () => {
  const result = ProductSpecSchema.safeParse(
    baseSpec([
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "order", fields: [{ name: "status", type: "text", required: false }] },
    ]),
  );
  assert.ok(!result.success);
  assert.match(result.error.issues[0].message, /collide when compared case-insensitively/);
});

test("ProductSpecSchema accepts entities with genuinely distinct names", () => {
  const result = ProductSpecSchema.safeParse(
    baseSpec([
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
    ]),
  );
  assert.ok(result.success);
});

test("EntitySchema rejects an entity with zero fields", () => {
  const result = EntitySchema.safeParse({ name: "Empty", fields: [] });
  assert.ok(!result.success);
});
