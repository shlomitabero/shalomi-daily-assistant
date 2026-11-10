import assert from "node:assert/strict";
import { test } from "node:test";
import { EntitySchema, FieldSchema, OpenQuestionSchema, ProductSpecSchema, findOversizedGeneratedSpecField, GENERATED_SPEC_LABEL_MAX_LENGTH, GENERATED_SPEC_PHRASE_MAX_LENGTH, GENERATED_SPEC_SUMMARY_MAX_LENGTH, GENERATED_SPEC_MAX_ENTITIES, GENERATED_SPEC_MAX_FIELDS_PER_ENTITY, GENERATED_SPEC_MAX_ENUM_VALUES, GENERATED_SPEC_MAX_LIST_ITEMS } from "./index.js";

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

/**
 * Round 1215: same bug class as round 1213/1214's `label`/`roles`/etc.
 * fixes -- the array-length refine above only guarantees enumValues is
 * non-empty, never that each element is. An empty element here becomes
 * real stored data via seed.ts's cycling-index seeder, and breaks the
 * enum <select>'s own "clear value" placeholder in EntityPanel.tsx.
 */
test("FieldSchema rejects an enum field with an empty-string enumValues element, but still accepts genuinely non-empty ones", () => {
  const empty = FieldSchema.safeParse({ name: "status", type: "enum", required: true, enumValues: ["New", ""] });
  assert.ok(!empty.success, "expected an empty-string enumValues element to be rejected");

  const genuine = FieldSchema.safeParse({ name: "status", type: "enum", required: true, enumValues: ["New", "Active", "סגור"] });
  assert.ok(genuine.success, "expected genuinely non-empty enumValues to still be accepted");
});

/**
 * Round 1246: same bug class as round 1215's enumValues-element fix just
 * above, for the sibling enumLabels field instead. Every render site in
 * this app falls back with `field.enumLabels?.[value] ?? value`, which
 * only falls back on null/undefined, never on "" -- an AI-generated spec
 * emitting an empty-string override rendered a literally blank label
 * everywhere that enum value appeared.
 */
test("FieldSchema rejects an enum field with an empty-string enumLabels value, but still accepts genuinely non-empty ones", () => {
  const empty = FieldSchema.safeParse({ name: "status", type: "enum", required: true, enumValues: ["Active"], enumLabels: { Active: "" } });
  assert.ok(!empty.success, "expected an empty-string enumLabels value to be rejected");

  const genuine = FieldSchema.safeParse({ name: "status", type: "enum", required: true, enumValues: ["Active"], enumLabels: { Active: "פעיל" } });
  assert.ok(genuine.success, "expected a genuinely non-empty enumLabels value to still be accepted");
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

/**
 * Round 1614: closes a real self-caused gap -- round 1613 added
 * createdByUserId as a third universal built-in column (the
 * record-creation audit trail) but never added it to RESERVED_FIELD_NAMES,
 * so a field literally named "Created By User Id" sailed through this
 * refine untouched and only hit the real "duplicate column name" SQLite
 * error at build time, mirroring the exact "id"/"createdAt" cases above.
 */
test("FieldSchema rejects a field literally named 'createdByUserId', case-insensitively, since every table already has a built-in createdByUserId column", () => {
  for (const name of ["createdByUserId", "createdbyuserid", "CREATEDBYUSERID"]) {
    const result = FieldSchema.safeParse({ name, type: "text", required: false });
    assert.ok(!result.success, `expected "${name}" to be rejected`);
    assert.match(result.error.issues[0].message, /collides with a built-in column/);
  }
});

/**
 * Round 1617: the direct sibling of round 1614's createdByUserId test
 * above, added in the SAME round that introduced updatedByUserId (the
 * record-update audit trail) -- not as a follow-up round, the mistake
 * round 1613 made with createdByUserId and that round 1614 then had to
 * fix after the fact.
 */
test("FieldSchema rejects a field literally named 'updatedByUserId', case-insensitively, since every table already has a built-in updatedByUserId column", () => {
  for (const name of ["updatedByUserId", "updatedbyuserid", "UPDATEDBYUSERID"]) {
    const result = FieldSchema.safeParse({ name, type: "text", required: false });
    assert.ok(!result.success, `expected "${name}" to be rejected`);
    assert.match(result.error.issues[0].message, /collides with a built-in column/);
  }
});

/**
 * Round 1672: the direct sibling of round 1617's updatedByUserId test just
 * above, added in the SAME round that introduced updatedAt (the WHEN half
 * of that same record-update fact) -- not as a follow-up round.
 */
test("FieldSchema rejects a field literally named 'updatedAt', case-insensitively, since every table already has a built-in updatedAt column", () => {
  for (const name of ["updatedAt", "updatedat", "UPDATEDAT"]) {
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

/**
 * Round 1214: same bug class as round 1213's `label` fix, applied to
 * `roles`/`personas`/`assumptions`/`openQuestions.options` -- a stray
 * empty-string element in one of these free-text arrays rendered as a
 * ghost chip (RoleChip/PersonaItem/AssumptionItem render the string
 * directly, with no fallback at all).
 */
test("ProductSpecSchema rejects an empty-string element in roles/personas/assumptions, but still accepts genuinely non-empty ones", () => {
  const emptyRole = ProductSpecSchema.safeParse({ ...baseSpec([{ name: "Order", fields: [{ name: "total", type: "number", required: true }] }]), roles: ["Admin", ""] });
  assert.ok(!emptyRole.success, "expected an empty-string role to be rejected");

  const emptyPersona = ProductSpecSchema.safeParse({ ...baseSpec([{ name: "Order", fields: [{ name: "total", type: "number", required: true }] }]), personas: [""] });
  assert.ok(!emptyPersona.success, "expected an empty-string persona to be rejected");

  const emptyAssumption = ProductSpecSchema.safeParse({ ...baseSpec([{ name: "Order", fields: [{ name: "total", type: "number", required: true }] }]), assumptions: [""] });
  assert.ok(!emptyAssumption.success, "expected an empty-string assumption to be rejected");

  const genuine = ProductSpecSchema.safeParse({
    ...baseSpec([{ name: "Order", fields: [{ name: "total", type: "number", required: true }] }]),
    personas: ["Shop owner"],
    assumptions: ["Payments are handled offline"],
  });
  assert.ok(genuine.success, "expected genuinely non-empty personas/assumptions to still be accepted");
});

test("OpenQuestionSchema rejects an empty-string option, but still accepts genuinely non-empty ones", () => {
  const empty = OpenQuestionSchema.safeParse({ question: "Which payment methods?", options: ["Cash", ""] });
  assert.ok(!empty.success, "expected an empty-string option to be rejected");

  const genuine = OpenQuestionSchema.safeParse({ question: "Which payment methods?", options: ["Cash", "Credit card"] });
  assert.ok(genuine.success, "expected genuinely non-empty options to still be accepted");
});

/**
 * Round 1426: ProductSpecSchema itself must never gain a `.max()` on an
 * existing field (see findOversizedGeneratedSpecField's own doc comment
 * for why -- every stored spec is re-validated against this exact schema
 * on every read), so this is a separate function, not a schema change.
 * These tests confirm it flags each kind of field this bug class can
 * reach, and leaves an ordinary, correctly-sized spec untouched.
 */
test("findOversizedGeneratedSpecField flags an oversized summary, phrase array element, entity/field name or label, and leaves a normal spec alone", () => {
  const normalEntity = { name: "Order", fields: [{ name: "total", type: "number", required: true }] };

  assert.equal(findOversizedGeneratedSpecField(ProductSpecSchema.parse(baseSpec([normalEntity]))), null, "an ordinary, correctly-sized spec must not be flagged");

  const oversizedSummary = ProductSpecSchema.parse({ ...baseSpec([normalEntity]), summary: "x".repeat(GENERATED_SPEC_SUMMARY_MAX_LENGTH + 1) });
  assert.match(findOversizedGeneratedSpecField(oversizedSummary)!, /summary/);

  const oversizedRole = ProductSpecSchema.parse({ ...baseSpec([normalEntity]), roles: ["x".repeat(GENERATED_SPEC_PHRASE_MAX_LENGTH + 1)] });
  assert.match(findOversizedGeneratedSpecField(oversizedRole)!, /role/);

  const oversizedQuestion = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    openQuestions: [{ question: "x".repeat(GENERATED_SPEC_PHRASE_MAX_LENGTH + 1), options: [] }],
  });
  assert.match(findOversizedGeneratedSpecField(oversizedQuestion)!, /openQuestions question/);

  const oversizedEntityName = ProductSpecSchema.parse({
    ...baseSpec([{ name: "x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1), fields: normalEntity.fields }]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedEntityName)!, /entity name/);

  const oversizedEntityDescription = ProductSpecSchema.parse({
    ...baseSpec([{ name: "Order", description: "x".repeat(GENERATED_SPEC_PHRASE_MAX_LENGTH + 1), fields: normalEntity.fields }]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedEntityDescription)!, /entity "Order"'s description/);

  const oversizedFieldLabel = ProductSpecSchema.parse({
    ...baseSpec([{ name: "Order", fields: [{ name: "total", label: "x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1), type: "number", required: true }] }]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedFieldLabel)!, /field "total"'s label/);

  const oversizedEnumValue = ProductSpecSchema.parse({
    ...baseSpec([
      { name: "Order", fields: [{ name: "status", type: "enum", required: true, enumValues: ["x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1)] }] },
    ]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedEnumValue)!, /enumValue/);

  const oversizedEnumLabelKey = ProductSpecSchema.parse({
    ...baseSpec([
      {
        name: "Order",
        fields: [
          {
            name: "status",
            type: "enum",
            required: true,
            enumValues: ["Active"],
            enumLabels: { ["x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1)]: "Active" },
          },
        ],
      },
    ]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedEnumLabelKey)!, /enumLabel key/);

  const oversizedRelationTo = ProductSpecSchema.parse({
    ...baseSpec([
      { name: "Order", fields: [{ name: "customer", type: "relation", required: true, relationTo: "x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1) }] },
    ]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedRelationTo)!, /field "customer"'s relationTo/);
});

/**
 * Round 1695: every check above only guards a STRING's length -- a
 * token-repetition loop is just as capable of repeating a whole list
 * element (the same array item, or an entity/field block, many times)
 * as it is of repeating characters within one string. These tests cover
 * the new array-count checks this round added, one per list this
 * function now guards.
 */
test("findOversizedGeneratedSpecField flags an oversized roles/openQuestions/openQuestions.options/entities/fields/enumValues list, and leaves a normal spec alone", () => {
  const normalEntity = { name: "Order", fields: [{ name: "total", type: "number", required: true }] };

  const oversizedRoles = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    roles: Array.from({ length: GENERATED_SPEC_MAX_LIST_ITEMS + 1 }, (_, i) => `Role ${i}`),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedRoles)!, /roles list/);

  const oversizedOpenQuestions = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    openQuestions: Array.from({ length: GENERATED_SPEC_MAX_LIST_ITEMS + 1 }, (_, i) => ({ question: `Q${i}?`, options: [] })),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedOpenQuestions)!, /openQuestions list/);

  const oversizedOpenQuestionOptions = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    openQuestions: [{ question: "Which?", options: Array.from({ length: GENERATED_SPEC_MAX_LIST_ITEMS + 1 }, (_, i) => `Option ${i}`) }],
  });
  assert.match(findOversizedGeneratedSpecField(oversizedOpenQuestionOptions)!, /openQuestions options list/);

  const oversizedEntities = ProductSpecSchema.parse(
    baseSpec(
      Array.from({ length: GENERATED_SPEC_MAX_ENTITIES + 1 }, (_, i) => ({
        name: `Entity${i}`,
        fields: [{ name: "total", type: "number", required: true }],
      })),
    ),
  );
  assert.match(findOversizedGeneratedSpecField(oversizedEntities)!, /entities list/);

  const oversizedFields = ProductSpecSchema.parse({
    ...baseSpec([
      {
        name: "Order",
        fields: Array.from({ length: GENERATED_SPEC_MAX_FIELDS_PER_ENTITY + 1 }, (_, i) => ({ name: `field${i}`, type: "number", required: true })),
      },
    ]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedFields)!, /entity "Order"'s fields list/);

  const oversizedEnumValues = ProductSpecSchema.parse({
    ...baseSpec([
      {
        name: "Order",
        fields: [{ name: "status", type: "enum", required: true, enumValues: Array.from({ length: GENERATED_SPEC_MAX_ENUM_VALUES + 1 }, (_, i) => `v${i}`) }],
      },
    ]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedEnumValues)!, /enumValues list/);
});

/**
 * Round 1878: round 1695's own "sweep every array" fix never actually
 * covered `screens`, ProductSpecSchema's own 8th top-level array
 * (declared right alongside entities/roles/personas/assumptions/
 * openQuestions) -- it's just as exposed to the token-repetition failure
 * mode this whole function exists to catch.
 */
test("findOversizedGeneratedSpecField flags an oversized screens list or an oversized screen name/entity, and leaves a normal spec alone", () => {
  const normalEntity = { name: "Order", fields: [{ name: "total", type: "number", required: true }] };

  const normalScreens = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    screens: [{ name: "Orders", type: "list", entity: "Order" }],
  });
  assert.equal(findOversizedGeneratedSpecField(normalScreens), null, "a normal, correctly-sized screens list must not be flagged");

  const oversizedScreens = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    screens: Array.from({ length: GENERATED_SPEC_MAX_LIST_ITEMS + 1 }, (_, i) => ({ name: `Screen ${i}`, type: "list", entity: "Order" })),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedScreens)!, /screens list/);

  const oversizedScreenName = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    screens: [{ name: "x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1), type: "dashboard" }],
  });
  assert.match(findOversizedGeneratedSpecField(oversizedScreenName)!, /screen name/);

  const oversizedScreenEntity = ProductSpecSchema.parse({
    ...baseSpec([normalEntity]),
    screens: [{ name: "Orders", type: "list", entity: "x".repeat(GENERATED_SPEC_LABEL_MAX_LENGTH + 1) }],
  });
  assert.match(findOversizedGeneratedSpecField(oversizedScreenEntity)!, /screen "Orders"'s entity/);
});

/**
 * Round 1710: round 1695's own array-count sweep above never touched
 * enumLabels -- a z.record (FieldSchema's own declaration), not an array --
 * even though it's exposed to the identical token-repetition failure mode:
 * many distinct, individually-short entries still balloon this field's
 * total size with nothing to catch it, since nothing anywhere ties its key
 * count to enumValues' own (already-capped) one either.
 */
test("findOversizedGeneratedSpecField flags an oversized enumLabels map, and leaves a normal one alone", () => {
  const normalEnumLabels = ProductSpecSchema.parse({
    ...baseSpec([
      {
        name: "Order",
        fields: [{ name: "status", type: "enum", required: true, enumValues: ["Active"], enumLabels: { Active: "פעיל" } }],
      },
    ]),
  });
  assert.equal(findOversizedGeneratedSpecField(normalEnumLabels), null, "a normal, correctly-sized enumLabels map must not be flagged");

  const oversizedEnumLabels = ProductSpecSchema.parse({
    ...baseSpec([
      {
        name: "Order",
        fields: [
          {
            name: "status",
            type: "enum",
            required: true,
            enumValues: ["Active"],
            enumLabels: Object.fromEntries(Array.from({ length: GENERATED_SPEC_MAX_ENUM_VALUES + 1 }, (_, i) => [`v${i}`, `Label ${i}`])),
          },
        ],
      },
    ]),
  });
  assert.match(findOversizedGeneratedSpecField(oversizedEnumLabels)!, /enumLabels map/);
});

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
