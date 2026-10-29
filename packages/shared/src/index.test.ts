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

/**
 * Round 856: unlike an entity name (sanitized via tableNameFor before
 * ever reaching assertSafeIdentifier -- see
 * packages/db/src/identifiers.ts -- and so deliberately ACCEPTED here
 * even when non-ASCII, per the round-283 tests below), a field name was
 * passed to assertSafeIdentifier completely raw, with no sanitization
 * step anywhere, in both migrate.ts and repository.ts's fieldColumns.
 * Only the two literal reserved words were ever rejected here; a space,
 * a hyphen, a leading digit, or a non-ASCII character (plausible for
 * this app's Hebrew-primary users, where `label` -- not `name` -- is
 * meant to carry the Hebrew display text) reached that assert unguarded
 * and threw a raw, uncaught-by-design Error during a real build/refine
 * instead of being caught here, at the one point every spec is
 * validated, where a rejected safeParse falls back to the heuristic
 * provider invisibly (see RESERVED_FIELD_NAMES's own comment above for
 * why that's the designed outcome for exactly this class of risk).
 * routes/projects.ts's own deriveFieldName (the manual "add field" UI
 * path) already produces a name guaranteed to pass this check -- its own
 * comment documents finding this exact gap at round 549 and closing it
 * for that one call path only; this closes it at the schema itself, so
 * every caller (the AI provider's raw JSON output included) is covered.
 */
test("FieldSchema rejects a field name that isn't a plain ASCII identifier", () => {
  for (const name of ["due date", "e-mail", "2024Budget", "תאריך", "", " "]) {
    if (name === "") continue; // z.string().min(1) already rejects this one with a different message
    const result = FieldSchema.safeParse({ name, type: "text", required: false });
    assert.ok(!result.success, `expected ${JSON.stringify(name)} to be rejected`);
    assert.match(result.error.issues[0].message, /must be a plain ASCII identifier/);
  }
});

test("FieldSchema accepts a field name with a leading letter, digits, and underscores -- the shape every real field name already uses", () => {
  for (const name of ["dueDate", "amount2", "customer_id", "a"]) {
    const result = FieldSchema.safeParse({ name, type: "text", required: false });
    assert.ok(result.success, `expected ${JSON.stringify(name)} to be accepted`);
  }
});

/**
 * Round 1213: `label` is optional (a field/entity may legitimately omit it
 * and fall back to `name`), but every display site's own fallback is
 * `label ?? name`, which only triggers for `null`/`undefined` -- never for
 * an explicit `""`. Before this fix, `label: ""` passed this schema
 * cleanly and then rendered as a literally blank string everywhere a label
 * is shown. Mirrors round 856's identical `.min(1)` treatment for `name`.
 */
test("FieldSchema rejects an empty-string label, but still accepts one that's simply absent", () => {
  const empty = FieldSchema.safeParse({ name: "dueDate", label: "", type: "text", required: false });
  assert.ok(!empty.success, "expected an empty-string label to be rejected");

  const absent = FieldSchema.safeParse({ name: "dueDate", type: "text", required: false });
  assert.ok(absent.success, "expected an absent label to still be accepted");

  const real = FieldSchema.safeParse({ name: "dueDate", label: "תאריך", type: "text", required: false });
  assert.ok(real.success, "expected a genuine, non-empty label to still be accepted");
});

test("EntitySchema rejects an empty-string label, but still accepts one that's simply absent", () => {
  const empty = EntitySchema.safeParse({
    name: "Customer",
    label: "",
    fields: [{ name: "name", type: "text", required: true }],
  });
  assert.ok(!empty.success, "expected an empty-string label to be rejected");

  const absent = EntitySchema.safeParse({
    name: "Customer",
    fields: [{ name: "name", type: "text", required: true }],
  });
  assert.ok(absent.success, "expected an absent label to still be accepted");
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

/**
 * Regression test for a real bug found by round 282's Explore survey and
 * fixed in round 283: packages/db/src/identifiers.ts's tableNameFor
 * silently sanitizes a non-ASCII entity name (replacing every non-ASCII-
 * alphanumeric character with "_") rather than rejecting it, so two
 * entities with completely different non-ASCII names -- a real,
 * everyday case for a Hebrew business idea whose AI-generated spec
 * doesn't perfectly follow its own "ASCII names only" prompt instruction
 * -- can silently collapse onto the exact same underlying SQL table,
 * corrupting one entity's data into the other's. This is the same
 * failure class the case-insensitive-duplicate check above already
 * guards against, just reached through sanitization instead of casing.
 */
test("ProductSpecSchema rejects two entities whose non-ASCII names collapse to the same sanitized table name", () => {
  const result = ProductSpecSchema.safeParse(
    baseSpec([
      { name: "לקוח", fields: [{ name: "name", type: "text", required: true }] },
      { name: "מוצר", fields: [{ name: "price", type: "number", required: true }] },
    ]),
  );
  assert.ok(!result.success, "two different non-ASCII names that sanitize to the same table name must be rejected");
  assert.match(result.error.issues[0].message, /collapse to the same underlying SQL table name/);
});

test("ProductSpecSchema still accepts non-ASCII entity names that don't actually collide with each other", () => {
  const result = ProductSpecSchema.safeParse(
    baseSpec([
      { name: "לקוח", fields: [{ name: "name", type: "text", required: true }] },
      { name: "הזמנה", fields: [{ name: "total", type: "number", required: true }] },
    ]),
  );
  assert.ok(result.success, "distinct non-ASCII names that don't collide must not be penalized by this check");
});

test("EntitySchema rejects an entity with zero fields", () => {
  const result = EntitySchema.safeParse({ name: "Empty", fields: [] });
  assert.ok(!result.success);
});

/**
 * round 410: the entity-name-level checks above (case-insensitive and
 * sanitized-identifier collisions) have no field-level counterpart, even
 * though SQLite compares column names case-insensitively too -- the exact
 * same failure class, just one level down. routes/projects.ts's own
 * deriveFieldName (the manual "add field" UI path) already de-duplicates
 * case-insensitively, so this gap is specific to an AI/heuristic-generated
 * spec, which has no equivalent guard before reaching migrate.ts's
 * CREATE TABLE / ALTER TABLE ADD COLUMN.
 */
test("EntitySchema rejects two fields on the same entity whose names collide case-insensitively", () => {
  const result = EntitySchema.safeParse({
    name: "Customer",
    fields: [
      { name: "email", type: "text", required: true },
      { name: "Email", type: "text", required: false },
    ],
  });
  assert.ok(!result.success, "two same-entity field names differing only by case must be rejected");
  assert.match(result.error.issues[0].message, /collide when compared case-insensitively/);
});

test("EntitySchema accepts fields with genuinely distinct names", () => {
  const result = EntitySchema.safeParse({
    name: "Customer",
    fields: [
      { name: "email", type: "text", required: true },
      { name: "phone", type: "text", required: false },
    ],
  });
  assert.ok(result.success);
});

test("ProductSpecSchema still accepts the exact same field name reused across two different entities", () => {
  // Fields are scoped per-table, not per-spec -- "name" on both Customer
  // and Vendor is two entirely separate columns in two separate tables,
  // not a collision at all.
  const result = ProductSpecSchema.safeParse(
    baseSpec([
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Vendor", fields: [{ name: "name", type: "text", required: true }] },
    ]),
  );
  assert.ok(result.success);
});
