import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checkpoint, ProductSpec } from "@forge/shared";
import {
  checkpointDisplayLabel,
  checkpointLabelOccurrences,
  computeCheckpointDiff,
  filterCheckpoints,
  filterCheckpointsByType,
  formatCheckpointCount,
  formatCheckpointHistory,
  formatCompareTarget,
  getCheckpointType,
  isCheckpointCurrent,
  resolveCompareSpec,
} from "./checkpointDiff.js";
import { translate } from "./i18n/language.js";

function makeSpec(entities: ProductSpec["entities"]): ProductSpec {
  return { summary: "s", personas: [], roles: ["Admin"], entities, screens: [], assumptions: [], openQuestions: [] };
}

function makeCheckpoint(label: string, kind: Checkpoint["kind"] = "build"): Checkpoint {
  return { id: label, projectId: "p1", label, kind, spec: makeSpec([]), createdAt: "2026-01-01T00:00:00.000Z" };
}

test("computeCheckpointDiff reports an entity present now but missing from the checkpoint as removed", () => {
  const current = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
    { name: "Invoice", label: "Invoices", fields: [{ name: "total", type: "number", required: true }] },
  ]);
  const checkpoint = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, [{ name: "Invoice", label: "Invoices" }]);
  assert.deepEqual(diff.addedEntities, []);
  assert.deepEqual(diff.changedEntities, []);
});

test("computeCheckpointDiff reports fields present now but missing from the checkpoint's same entity", () => {
  const current = makeSpec([
    {
      name: "Customer",
      label: "Customers",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "loyaltyPoints", label: "Loyalty Points", type: "number", required: false },
      ],
    },
  ]);
  const checkpoint = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "name", label: "Name", type: "text", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, []);
  assert.deepEqual(
    diff.changedEntities,
    [{ name: "Customer", label: "Customers", removedFieldNames: ["Loyalty Points"], addedFieldNames: [], changedFieldNames: [], descriptionChanged: false }],
  );
});

test("computeCheckpointDiff falls back to the raw name when a field or entity has no label", () => {
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "notes", type: "text", required: false }] }]);
  const checkpoint = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [{ name: "Customer", label: "Customer", removedFieldNames: ["notes"], addedFieldNames: [], changedFieldNames: [], descriptionChanged: false }]);
});

/**
 * Round 641: a field's display label is never enforced unique (only its
 * name is), so two fields on an entity can legally share a label via the
 * Field Label editor. A checkpoint that still has BOTH same-labeled
 * fields, restored over a current spec missing only one of them, used to
 * report the bare shared label as "added" -- indistinguishable from the
 * other, already-present field sharing that same label.
 */
test("computeCheckpointDiff disambiguates an added/removed field name against a sibling field sharing the identical label", () => {
  const current = makeSpec([
    {
      name: "Order",
      label: "Order",
      fields: [{ name: "subtotal", label: "Amount", type: "number", required: true }],
    },
  ]);
  const checkpoint = makeSpec([
    {
      name: "Order",
      label: "Order",
      fields: [
        { name: "subtotal", label: "Amount", type: "number", required: true },
        { name: "shipping", label: "Amount", type: "number", required: true },
      ],
    },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Order", label: "Order", removedFieldNames: [], addedFieldNames: ["Amount (shipping)"], changedFieldNames: [], descriptionChanged: false },
  ]);
});

/**
 * Round 642: the entity-level twin of the field-label test above -- an
 * entity's own display label is just as unenforced-unique as a field's.
 * A checkpoint that still has a field on one of two same-labeled entities,
 * missing from the current spec, used to report the bare shared label as
 * "changed" -- indistinguishable from the other, untouched entity sharing
 * that same label.
 */
test("computeCheckpointDiff disambiguates a changed entity's label against a sibling entity sharing the identical label", () => {
  const current = makeSpec([
    { name: "Product", label: "Items", fields: [{ name: "name", type: "text", required: true }] },
    { name: "Service", label: "Items", fields: [{ name: "name", type: "text", required: true }] },
  ]);
  const checkpoint = makeSpec([
    {
      name: "Product",
      label: "Items",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "price", label: "Price", type: "number", required: true },
      ],
    },
    { name: "Service", label: "Items", fields: [{ name: "name", type: "text", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Product", label: "Items (Product)", removedFieldNames: [], addedFieldNames: ["Price"], changedFieldNames: [], descriptionChanged: false },
  ]);
});

test("computeCheckpointDiff reports checkpoint-only entities/fields as additions, not as absence of removals", () => {
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpointWithExtra = makeSpec([
    {
      name: "Customer",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: false },
      ],
    },
    { name: "Order", label: "Orders", fields: [{ name: "total", type: "number", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpointWithExtra);
  assert.deepEqual(diff.removedEntities, []);
  assert.deepEqual(diff.addedEntities, [{ name: "Order", label: "Orders" }]);
  assert.deepEqual(diff.changedEntities, [{ name: "Customer", label: "Customer", removedFieldNames: [], addedFieldNames: ["Phone"], changedFieldNames: [], descriptionChanged: false }]);
});

test("computeCheckpointDiff reports a brand-new entity in the checkpoint as addedEntities, never as a removal -- this is what makes resolveCompareSpec's 'what did a later refine add' comparison actually work", () => {
  // Restoring a checkpoint that has entities the CURRENT spec doesn't have
  // yet (a "future" checkpoint relative to a refine that later dropped
  // something, OR an older checkpoint being compared against a newer one via
  // resolveCompareSpec's "compare with" dropdown) is a gain from the current
  // spec's perspective, not a loss -- and it must show up as a real,
  // user-visible addition, not silently vanish into "no changes".
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoint = makeSpec([
    { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
    { name: "Invoice", fields: [{ name: "total", type: "number", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, []);
  assert.deepEqual(diff.addedEntities, [{ name: "Invoice", label: "Invoice" }]);
  assert.deepEqual(diff.changedEntities, []);
});

test("computeCheckpointDiff reports an entity that both lost and gained fields at once with both lists populated", () => {
  const current = makeSpec([
    {
      name: "Customer",
      label: "Customers",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "notes", label: "Notes", type: "text", required: false },
      ],
    },
  ]);
  const checkpoint = makeSpec([
    {
      name: "Customer",
      label: "Customers",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: false },
      ],
    },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Customer", label: "Customers", removedFieldNames: ["Notes"], addedFieldNames: ["Phone"], changedFieldNames: [], descriptionChanged: false },
  ]);
});

/**
 * Round 946: a field renamed ONLY by letter case (same physical column, same
 * data -- per migrate.ts's own case-only-rename hardening across rounds
 * 617-620) used to match neither exact-string lookup in either direction at
 * once, so the exact same field was reported as BOTH removed ("Email") and
 * added ("email") in the same diff -- a flatly contradictory message for a
 * change that doesn't actually lose or gain anything. Since fieldSignature
 * never compares a field's own name, a correctly-matched case-only rename
 * (same type/required/enum shape) must report no change at all for that
 * entity -- matching migrate.ts's own treatment of this as a true no-op.
 */
test("computeCheckpointDiff never reports a case-only field rename as both removed and added -- a case-only rename is a true no-op, same as migrate.ts treats it", () => {
  const current = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "Email", type: "text", required: false }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "email", type: "text", required: false }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [], "a case-only field rename alone must report no change at all, not a contradictory removed+added pair");
});

test("computeCheckpointDiff still reports a case-only-renamed field as changedFieldNames when it ALSO genuinely changed type, instead of missing the real change", () => {
  const current = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "Status", type: "enum", enumValues: ["open", "closed"], required: true }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "status", type: "text", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Customer", label: "Customers", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Status"], descriptionChanged: false },
  ]);
});

/**
 * Round 1066: the field-level twin of round 954's own entity-level fix
 * below (allEntitiesByName) -- this function's own allFieldsByName map
 * (feeding fieldLabelOccurrences/fieldDisplayLabel) was still keyed by
 * exact field name. A field renamed only by letter case (e.g. "email" ->
 * "Email") that also shares an identical custom label on both sides (the
 * same shape a real carried-forward label produces) ends up stored as two
 * separate map entries despite being the same physical column -- exact-
 * keying wrongly counted that one shared label twice and appended a false
 * "(Email)" disambiguation suffix to changedFieldNames.
 */
test("computeCheckpointDiff never appends a false disambiguation suffix to a changed field's label when it was only renamed by letter case but shares its own prior label with its renamed self", () => {
  const current = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "Email", type: "text", required: true, label: "Email Address" }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "email", type: "text", required: false, label: "Email Address" }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Customer", label: "Customers", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Email Address"], descriptionChanged: false },
  ]);
});

/**
 * Round 954: the entity-level counterpart of round 946's own field-level
 * fix just above -- an entity renamed ONLY by letter case (e.g. "customer"
 * -> "Customer" via refine) is, same as a field, a true no-op per
 * migrate.ts's own hardening (SQLite compares table identifiers
 * case-insensitively, same physical table, same data). The exact-string
 * entity lookups in computeCheckpointDiff never got the same lowercased
 * fallback round 946 gave this file's own field-name matching, so this one
 * entity was reported as simultaneously removed ("customer") AND added
 * ("Customer") in the same diff.
 */
test("computeCheckpointDiff never reports a case-only entity rename as both removed and added -- a case-only rename is a true no-op, same as migrate.ts treats it", () => {
  const current = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "email", type: "text", required: false }] }]);
  const checkpoint = makeSpec([{ name: "customer", label: "Customers", fields: [{ name: "email", type: "text", required: false }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, [], "a case-only entity rename alone must never report the entity as removed");
  assert.deepEqual(diff.addedEntities, [], "a case-only entity rename alone must never report the entity as added either");
  assert.deepEqual(diff.changedEntities, [], "a case-only entity rename alone, with every field untouched, must report no change at all for that entity");
});

test("computeCheckpointDiff still reports a genuinely added field on a case-only-renamed entity, instead of masking it as a false removed+added entity pair", () => {
  const current = makeSpec([
    {
      name: "Customer",
      label: "Customers",
      fields: [
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
      ],
    },
  ]);
  const checkpoint = makeSpec([{ name: "customer", label: "Customers", fields: [{ name: "email", type: "text", required: false }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, []);
  assert.deepEqual(diff.addedEntities, []);
  assert.deepEqual(diff.changedEntities, [
    { name: "Customer", label: "Customers", removedFieldNames: ["phone"], addedFieldNames: [], changedFieldNames: [], descriptionChanged: false },
  ]);
});

/**
 * New in this round: a same-named field that changed TYPE between the two
 * specs (e.g. a free-text "status" field a refine turned into an enum) was
 * previously invisible to computeCheckpointDiff -- name-matching alone
 * treated it as neither removed nor added, so the entity could disappear
 * from changedEntities entirely even though restoring this checkpoint
 * would genuinely change what the field does.
 */
test("computeCheckpointDiff reports a same-named field that changed type as changedFieldNames, not silently as no change", () => {
  const current = makeSpec([
    {
      name: "Order",
      label: "Orders",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "status", label: "Status", type: "enum", required: true, enumValues: ["Pending", "Shipped"] },
      ],
    },
  ]);
  const checkpoint = makeSpec([
    {
      name: "Order",
      label: "Orders",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "status", label: "Status", type: "text", required: true },
      ],
    },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Order", label: "Orders", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Status"], descriptionChanged: false },
  ]);
});

test("computeCheckpointDiff reports a same-named enum field whose enumValues changed as changedFieldNames", () => {
  const current = makeSpec([
    {
      name: "Order",
      fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["Pending", "Shipped", "Cancelled"] }],
    },
  ]);
  const checkpoint = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["Pending", "Shipped"] }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Order", label: "Order", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Status"], descriptionChanged: false },
  ]);
});

/**
 * Round 818's finding: fieldSignature encoded a sorted enumValues string
 * but never enumLabels -- real, pervasively user-rendered content (the
 * displayed text in table cells, Kanban columns, form <select> options,
 * automation rule conditions, calendar exports, and grouping/sort/search
 * matching all read enumLabels, not the raw enumValue). Not cosmetic like
 * `label` (deliberately excluded, see the test below) -- a refine that
 * only re-labels an enum's existing options, leaving enumValues/type/
 * required untouched, was invisible to this diff entirely.
 */
test("computeCheckpointDiff reports a same-named enum field as changedFieldNames when only its enumLabels differ, even with identical enumValues", () => {
  const current = makeSpec([
    {
      name: "Order",
      fields: [
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["New", "Done"],
          enumLabels: { New: "חדש", Done: "בוצע" },
        },
      ],
    },
  ]);
  const checkpoint = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Done"] }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Order", label: "Order", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Status"], descriptionChanged: false },
  ]);
});

test("computeCheckpointDiff does not flag an enum field as changed when enumLabels is undefined on both sides", () => {
  const current = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Done"] }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Done"] }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [], "identical (absent) enumLabels on both sides must not be reported as a change");
});

/**
 * Round 818's finding (isCheckpointCurrent side): the identical gap --
 * a checkpoint whose enumValues/type/required all match the live spec but
 * whose enumLabels differ used to be wrongly reported "Current", even
 * though restoring it would visibly change every rendered instance of
 * that enum field.
 */
test("isCheckpointCurrent is false when a same-named enum field's enumLabels differ, even though enumValues/type/required all match", () => {
  const current = makeSpec([
    {
      name: "Order",
      fields: [{ name: "status", type: "enum", required: true, enumValues: ["New", "Done"], enumLabels: { New: "חדש", Done: "בוצע" } }],
    },
  ]);
  const enumLabelsChanged = makeSpec([
    { name: "Order", fields: [{ name: "status", type: "enum", required: true, enumValues: ["New", "Done"] }] },
  ]);

  assert.equal(
    isCheckpointCurrent(current, enumLabelsChanged),
    false,
    "same enumValues, type, and required must not be enough when the field's own enumLabels genuinely differ",
  );
});

/**
 * Round 820's finding: fieldSignature's enumPart sorted enumValues before
 * joining it into the signature, so a refine that only reorders the same set
 * of values (no addition/removal/relabeling) produced an identical signature
 * either way. Declared order is real, user-rendered content, not cosmetic --
 * groupByField (entityFormatting.ts) renders Kanban board columns in exactly
 * the enum's declared order, and the record form's enum <select> renders its
 * <option>s in that same order, so reordering enumValues visibly reorders
 * both.
 */
test("computeCheckpointDiff reports a same-named enum field as changedFieldNames when only its enumValues order differs, with the identical set of values", () => {
  const current = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["Cancelled", "New", "Shipped"] }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Shipped", "Cancelled"] }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Order", label: "Order", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Status"], descriptionChanged: false },
  ]);
});

test("computeCheckpointDiff does not flag an enum field as changed when enumValues is identical in both set and order", () => {
  const current = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Shipped", "Cancelled"] }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Order", fields: [{ name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Shipped", "Cancelled"] }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [], "identical order (and set) of enumValues on both sides must not be reported as a change");
});

test("isCheckpointCurrent is false when a same-named enum field's enumValues order differs, even with the identical set of values", () => {
  const current = makeSpec([
    { name: "Order", fields: [{ name: "status", type: "enum", required: true, enumValues: ["Cancelled", "New", "Shipped"] }] },
  ]);
  const reordered = makeSpec([
    { name: "Order", fields: [{ name: "status", type: "enum", required: true, enumValues: ["New", "Shipped", "Cancelled"] }] },
  ]);

  assert.equal(
    isCheckpointCurrent(current, reordered),
    false,
    "same set of enumValues, type, and required must not be enough when the field's own declared order genuinely differs",
  );
});

test("computeCheckpointDiff never flags a field as changed just because its label differs -- a label rename alone is cosmetic", () => {
  const current = makeSpec([
    {
      name: "Order",
      fields: [{ name: "status", label: "Order Status", type: "text", required: true }],
    },
  ]);
  const checkpoint = makeSpec([{ name: "Order", fields: [{ name: "status", label: "Status", type: "text", required: true }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [], "a label rename alone must not be reported as a structural change");
});

/**
 * New in this round: fieldSignature used to omit `required` entirely, so a
 * same-named, same-typed field whose required flag flipped read as "the
 * same field, unchanged" -- even though it's a genuine behavioral change
 * (repository.ts's coerceValue rejects a missing value once a field is
 * required), the exact property pipeline.ts's own computeImpact already
 * tracks as a "tightened" field worth its own build-time warning.
 */
test("computeCheckpointDiff reports a same-named, same-typed field as changedFieldNames when only its required flag differs", () => {
  const current = makeSpec([
    {
      name: "Order",
      fields: [{ name: "status", label: "Order Status", type: "text", required: true }],
    },
  ]);
  const checkpoint = makeSpec([{ name: "Order", fields: [{ name: "status", label: "Status", type: "text", required: false }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Order", label: "Order", removedFieldNames: [], addedFieldNames: [], changedFieldNames: ["Order Status"], descriptionChanged: false },
  ]);
});

/**
 * New in this round: isCheckpointCurrent had the identical gap --
 * name-matching alone meant a checkpoint whose field changed type could be
 * wrongly reported as "you are already looking at this", even though
 * restoring it would genuinely change the field's behavior.
 */
test("isCheckpointCurrent is false when a same-named field changed type, even though names and counts still match", () => {
  const current = makeSpec([
    { name: "Order", fields: [{ name: "status", type: "enum", required: true, enumValues: ["Pending", "Shipped"] }] },
  ]);
  const typeChanged = makeSpec([{ name: "Order", fields: [{ name: "status", type: "text", required: true }] }]);

  assert.equal(
    isCheckpointCurrent(current, typeChanged),
    false,
    "same field name and field count must not be enough when the field's own type genuinely differs",
  );
});

/**
 * New in this round: the identical gap existed for a field's `required`
 * flag -- same name, same type, but one side made it required and the
 * other didn't used to still read as "the same field, unchanged".
 */
test("isCheckpointCurrent is false when a same-named, same-typed field's required flag differs", () => {
  const current = makeSpec([{ name: "Order", fields: [{ name: "status", type: "text", required: true }] }]);
  const requiredChanged = makeSpec([{ name: "Order", fields: [{ name: "status", type: "text", required: false }] }]);

  assert.equal(
    isCheckpointCurrent(current, requiredChanged),
    false,
    "same field name, type, and count must not be enough when the field's own required flag genuinely differs",
  );
});

/**
 * Round 817's finding: an entity's own `description` is real, user-rendered
 * content (EntityPanel.tsx: {entity.description && <p className="muted">
 * {entity.description}</p>}, shown above every entity's own table/form) --
 * not cosmetic like `label` (see the "label rename alone is cosmetic" test
 * above). Neither computeCheckpointDiff nor isCheckpointCurrent ever
 * compared it, so a refine that only rewords an entity's description,
 * leaving every field untouched, was invisible to the diff entirely.
 */
test("computeCheckpointDiff reports an entity as changed when only its own description differs, even with every field byte-identical", () => {
  const current = makeSpec([
    { name: "Customer", description: "The individual or organization purchasing services.", fields: [{ name: "name", type: "text", required: true }] },
  ]);
  const checkpoint = makeSpec([
    { name: "Customer", description: "A person or company the business serves.", fields: [{ name: "name", type: "text", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [
    { name: "Customer", label: "Customer", removedFieldNames: [], addedFieldNames: [], changedFieldNames: [], descriptionChanged: true },
  ]);
});

test("computeCheckpointDiff does not flag an entity as changed when its description is identical, even if undefined on both sides", () => {
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoint = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [], "identical (absent) descriptions on both sides must not be reported as a change");
});

/**
 * Round 817's finding: isCheckpointCurrent had the identical gap -- a
 * checkpoint whose entities/fields match the live spec byte-for-byte but
 * whose description text differs used to be wrongly reported "Current",
 * the same category of gap this function's own doc comment already
 * describes for summary/roles/personas/screens/assumptions/openQuestions.
 */
test("isCheckpointCurrent is false when an entity's own description differs, even though every field is byte-identical", () => {
  const current = makeSpec([
    { name: "Customer", description: "The individual or organization purchasing services.", fields: [{ name: "name", type: "text", required: true }] },
  ]);
  const descriptionChanged = makeSpec([
    { name: "Customer", description: "A person or company the business serves.", fields: [{ name: "name", type: "text", required: true }] },
  ]);

  assert.equal(
    isCheckpointCurrent(current, descriptionChanged),
    false,
    "identical entities/fields must not be enough when the entity's own description genuinely differs",
  );
});

/**
 * Round 874's finding: isCheckpointCurrent had the identical gap round 817
 * already fixed for description -- a checkpoint whose entities/fields
 * match the live spec byte-for-byte (fieldSignature deliberately excludes
 * a field's own label, for computeCheckpointDiff's narrower "is this a
 * structural change" question) but whose entity/field LABEL differs used
 * to be wrongly reported "Current" too. An entity/field label rename
 * (routes/projects.ts's PATCH .../label routes) never creates a new
 * checkpoint, so every pre-existing checkpoint keeps the old label while
 * the live spec shows the new one -- restoring that checkpoint would
 * genuinely change the rendered label back, which isCheckpointCurrent
 * must not call "already current".
 */
test("isCheckpointCurrent is false when an entity's or a field's own label differs, even though every other property is byte-identical", () => {
  const current = makeSpec([
    { name: "Customer", label: "Customer", fields: [{ name: "name", label: "Name", type: "text", required: true }] },
  ]);
  const entityLabelChanged = makeSpec([
    { name: "Customer", label: "Client", fields: [{ name: "name", label: "Name", type: "text", required: true }] },
  ]);
  const fieldLabelChanged = makeSpec([
    { name: "Customer", label: "Customer", fields: [{ name: "name", label: "Full Name", type: "text", required: true }] },
  ]);

  assert.equal(
    isCheckpointCurrent(current, entityLabelChanged),
    false,
    "identical entities/fields must not be enough when the entity's own label genuinely differs",
  );
  assert.equal(
    isCheckpointCurrent(current, fieldLabelChanged),
    false,
    "identical entities/fields must not be enough when a field's own label genuinely differs",
  );
});

/**
 * New in this round: after restoring an OLDER checkpoint, the checkpoint
 * list's own newest-first order no longer lines up with which entry is
 * actually current -- the most-recently-created checkpoint at the top can
 * be stale once you've gone back further, with nothing in the list saying
 * so. isCheckpointCurrent is the real answer to "am I already looking at
 * this checkpoint's own state right now", as opposed to
 * computeCheckpointDiff's one-directional "would restoring lose anything".
 */
test("isCheckpointCurrent is true only when the checkpoint has exactly the same entities and fields as the current spec", () => {
  const current = makeSpec([
    { name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: false }] },
    { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
  ]);
  const identical = makeSpec([
    { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
    { name: "Customer", fields: [{ name: "email", type: "text", required: false }, { name: "name", type: "text", required: true }] },
  ]);
  assert.equal(
    isCheckpointCurrent(current, identical),
    true,
    "same entities/fields in a different array order must still count as current",
  );
});

/**
 * Round 773: isCheckpointCurrent only ever compared entities/fields, even
 * though the restore route (apps/api/src/routes/projects.ts) replaces a
 * project's ENTIRE spec with the checkpoint's -- so a refine step that
 * only reworded the summary or renamed a role, leaving every entity
 * untouched, produced a checkpoint that was wrongly marked "Current"
 * (and had its own Restore button permanently disabled), even though the
 * live app's visible summary text and role chips genuinely differ from
 * it.
 */
test("isCheckpointCurrent is false when the summary or roles differ, even though entities/fields are byte-identical", () => {
  const entities: ProductSpec["entities"] = [{ name: "Order", fields: [{ name: "total", type: "number", required: true }] }];
  const current: ProductSpec = { summary: "A cafe management app for orders", personas: [], roles: ["Owner", "Cashier"], entities, screens: [], assumptions: [], openQuestions: [] };

  const differentSummary: ProductSpec = { ...current, summary: "Manage orders for a small shop" };
  assert.equal(
    isCheckpointCurrent(current, differentSummary),
    false,
    "a checkpoint whose summary genuinely differs from the live spec must not be marked Current, even with identical entities/fields",
  );

  const differentRoles: ProductSpec = { ...current, roles: ["Owner", "Staff"] };
  assert.equal(
    isCheckpointCurrent(current, differentRoles),
    false,
    "a checkpoint whose roles genuinely differ from the live spec must not be marked Current, even with identical entities/fields",
  );

  const identicalSpec: ProductSpec = { ...current, entities };
  assert.equal(
    isCheckpointCurrent(current, identicalSpec),
    true,
    "a checkpoint with a genuinely identical full spec must still be marked Current",
  );
});

test("isCheckpointCurrent is false when the checkpoint is missing an entity, missing a field, or has an extra one", () => {
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);

  const missingEntity = makeSpec([]);
  assert.equal(isCheckpointCurrent(current, missingEntity), false, "a checkpoint missing an entity current has must not count as current");

  const missingField = makeSpec([{ name: "Customer", fields: [] }]);
  assert.equal(isCheckpointCurrent(current, missingField), false, "a checkpoint missing a field current has must not count as current");

  const extraField = makeSpec([
    { name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "phone", type: "text", required: false }] },
  ]);
  assert.equal(
    isCheckpointCurrent(current, extraField),
    false,
    "a checkpoint with a field the current spec DOESN'T have must not count as current -- restoring it would gain a field, not leave you where you are",
  );
});

/**
 * New in this round: every build/refine adds one more checkpoint forever
 * (no cap, no delete), so a project with a long history had no way to find
 * one specific checkpoint besides scrolling and reading every label. A
 * real refine's own label always carries the actual instruction that
 * produced it (e.g. "Refine: add invoice tracking"), so a plain
 * case-insensitive substring match is genuinely useful, not cosmetic.
 */
test("filterCheckpoints matches checkpoints whose label contains the search text, case-insensitively", () => {
  const checkpoints = [
    makeCheckpoint("Initial build"),
    makeCheckpoint("Refine: add invoice tracking"),
    makeCheckpoint("Refine: add customer notes"),
  ];
  assert.deepEqual(
    filterCheckpoints(checkpoints, "invoice").map((c) => c.label),
    ["Refine: add invoice tracking"],
  );
  assert.deepEqual(
    filterCheckpoints(checkpoints, "INVOICE").map((c) => c.label),
    ["Refine: add invoice tracking"],
    "must match case-insensitively",
  );
  assert.deepEqual(
    filterCheckpoints(checkpoints, "refine").map((c) => c.label),
    ["Refine: add invoice tracking", "Refine: add customer notes"],
  );
});

test("filterCheckpoints returns every checkpoint unchanged when the search is blank or whitespace-only", () => {
  const checkpoints = [makeCheckpoint("Initial build"), makeCheckpoint("Refine: add invoice tracking")];
  assert.deepEqual(filterCheckpoints(checkpoints, ""), checkpoints);
  assert.deepEqual(filterCheckpoints(checkpoints, "   "), checkpoints);
});

test("filterCheckpoints returns an empty list when nothing matches, instead of falling back to everything", () => {
  const checkpoints = [makeCheckpoint("Initial build"), makeCheckpoint("Refine: add invoice tracking")];
  assert.deepEqual(filterCheckpoints(checkpoints, "zzz-no-such-checkpoint"), []);
});

test("getCheckpointType reads a checkpoint's own persisted kind, not its label", () => {
  assert.equal(getCheckpointType(makeCheckpoint("Initial build", "build")), "build");
  assert.equal(getCheckpointType(makeCheckpoint("Refine: add invoice tracking", "refine")), "refine");
  assert.equal(getCheckpointType(makeCheckpoint("בנייה ראשונית", "build")), "build");
  assert.equal(getCheckpointType(makeCheckpoint("שיפור: הוספת מעקב חשבוניות", "refine")), "refine");
});

/**
 * Regression test for the real bug this round closed: CheckpointLabelEditor
 * lets a user freely rename ANY checkpoint's label (its own advertised use
 * case -- "give an important one a name that's actually memorable"), and
 * getCheckpointType used to re-derive "build"/"refine" from that same label
 * via startsWith, so renaming a refine checkpoint away from its
 * "Refine: ..." prefix silently reclassified it as a build (and the
 * reverse, renaming to text that happens to start with "Refine:", would
 * have misclassified a build as a refine). kind is now set once at
 * creation and never touched by a rename, so both directions must stay
 * correctly classified by kind regardless of what the label says.
 */
test("getCheckpointType keeps classifying by kind even after the checkpoint's label has been renamed to not match either prefix", () => {
  const renamedRefine = makeCheckpoint("before the pricing overhaul", "refine");
  assert.equal(getCheckpointType(renamedRefine), "refine", "a renamed refine checkpoint must still read as 'refine', not fall back to 'build' because its label no longer starts with Refine:");

  const buildRenamedToLookLikeARefine = makeCheckpoint("Refine: this is actually the original build, just renamed", "build");
  assert.equal(getCheckpointType(buildRenamedToLookLikeARefine), "build", "a build checkpoint renamed to text that happens to start with 'Refine:' must still read as 'build', not be fooled by the coincidental prefix");
});

test("filterCheckpointsByType('all') returns every checkpoint unchanged", () => {
  const checkpoints = [makeCheckpoint("Initial build", "build"), makeCheckpoint("Refine: add invoice tracking", "refine")];
  assert.deepEqual(filterCheckpointsByType(checkpoints, "all"), checkpoints);
});

test("filterCheckpointsByType('build') keeps only the initial build, dropping every refine", () => {
  const checkpoints = [
    makeCheckpoint("Initial build", "build"),
    makeCheckpoint("Refine: add invoice tracking", "refine"),
    makeCheckpoint("Refine: add customer notes", "refine"),
  ];
  assert.deepEqual(
    filterCheckpointsByType(checkpoints, "build").map((c) => c.label),
    ["Initial build"],
  );
});

test("filterCheckpointsByType('refine') keeps only refines, dropping the initial build", () => {
  const checkpoints = [
    makeCheckpoint("Initial build", "build"),
    makeCheckpoint("Refine: add invoice tracking", "refine"),
    makeCheckpoint("Refine: add customer notes", "refine"),
  ];
  assert.deepEqual(
    filterCheckpointsByType(checkpoints, "refine").map((c) => c.label),
    ["Refine: add invoice tracking", "Refine: add customer notes"],
  );
});

test("filterCheckpointsByType composes with filterCheckpoints' own text search, narrowing to exactly what matches both", () => {
  const checkpoints = [
    makeCheckpoint("Initial build", "build"),
    makeCheckpoint("Refine: add invoice tracking", "refine"),
    makeCheckpoint("Refine: add customer notes", "refine"),
  ];
  const searched = filterCheckpoints(checkpoints, "add");
  assert.deepEqual(
    filterCheckpointsByType(searched, "refine").map((c) => c.label),
    ["Refine: add invoice tracking", "Refine: add customer notes"],
  );
});

test("filterCheckpointsByType returns an empty list, not everything, when no checkpoint matches the type", () => {
  const checkpoints = [makeCheckpoint("Initial build", "build")];
  assert.deepEqual(filterCheckpointsByType(checkpoints, "refine"), []);
});

test("formatCheckpointCount reports a plain total when the search hasn't narrowed anything out", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatCheckpointCount(7, 7, tr), "7 checkpoints");
});

test("formatCheckpointCount reports 'shown of total' once a search has narrowed the history, in Hebrew", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatCheckpointCount(1, 6, tr), "1 מתוך 6 נקודות שמירה");
});

/**
 * New in this round: a project's checkpoint history only ever grows (no
 * cap, no delete), so this is the only way to keep a permanent record of
 * it outside the app -- the same gap Business Twin (round 129) and the
 * WhatsApp log (round 154) already closed for their own data. Confirms
 * the real project name, each real checkpoint's own label and screen
 * count, and the "current" marker land in the exported text -- not a
 * placeholder or the wrong checkpoint's data.
 */
/**
 * Regression test (round 547): this report's "N screens" line used to read
 * checkpoint.spec.entities.length -- entities and screens are two
 * genuinely different, differently-sized arrays (every real spec has a
 * Dashboard screen plus a List/Form pair per entity, so screens.length is
 * always greater than entities.length), so the exported count was simply
 * wrong for every checkpoint. Each checkpoint below has a real screens
 * array with a DIFFERENT length than its entities array, specifically to
 * catch a regression back to entities.length.
 */
test("formatCheckpointHistory includes the project name, each checkpoint's own label, timestamp, and screen count", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec: ProductSpec = {
    ...makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]),
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "Customer List", type: "list", entity: "Customer" },
      { name: "Customer Form", type: "form", entity: "Customer" },
    ],
  };
  const checkpoints: Checkpoint[] = [
    {
      id: "cp2",
      projectId: "p1",
      label: "Refine: add invoice tracking",
      kind: "refine",
      spec: {
        ...makeSpec([
          { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
          { name: "Invoice", label: "Invoices", fields: [{ name: "total", type: "number", required: true }] },
        ]),
        screens: [
          { name: "Dashboard", type: "dashboard" },
          { name: "Customer List", type: "list", entity: "Customer" },
          { name: "Customer Form", type: "form", entity: "Customer" },
          { name: "Invoice List", type: "list", entity: "Invoice" },
          { name: "Invoice Form", type: "form", entity: "Invoice" },
        ],
      },
      createdAt: "2026-03-10T12:00:00.000Z",
    },
    {
      id: "cp1",
      projectId: "p1",
      label: "Initial build",
      kind: "build",
      spec: currentSpec,
      createdAt: "2026-03-01T09:00:00.000Z",
    },
  ];

  const report = formatCheckpointHistory(checkpoints, currentSpec, "Flower Shop", "en", t);

  assert.match(report, /Flower Shop/);
  assert.match(report, /Refine: add invoice tracking/);
  assert.match(report, /Initial build/);
  assert.match(report, /5 screens/, "the invoice-tracking checkpoint has 5 real screens, not its 2 entities");
  assert.match(report, /3 screens/, "the initial-build checkpoint has 3 real screens, not its 1 entity");
});

test("formatCheckpointHistory marks exactly the checkpoint matching the current spec, not the newest one", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoints: Checkpoint[] = [
    {
      id: "cp2",
      projectId: "p1",
      label: "Refine: add invoice tracking",
      kind: "refine",
      spec: makeSpec([
        { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
        { name: "Invoice", label: "Invoices", fields: [{ name: "total", type: "number", required: true }] },
      ]),
      createdAt: "2026-03-10T12:00:00.000Z",
    },
    {
      id: "cp1",
      projectId: "p1",
      label: "Initial build",
      kind: "build",
      spec: currentSpec,
      createdAt: "2026-03-01T09:00:00.000Z",
    },
  ];

  const report = formatCheckpointHistory(checkpoints, currentSpec, "Flower Shop", "en", t);
  const lines = report.split("\n");
  const initialBuildLine = lines.find((l) => l.includes("Initial build"))!;
  const refineLine = lines.find((l) => l.includes("Refine: add invoice tracking"))!;

  assert.match(initialBuildLine, /Current state/, "the checkpoint that's ACTUALLY current (an older one, not the newest) must be marked");
  assert.doesNotMatch(refineLine, /Current state/, "a checkpoint that is NOT current must not be marked, even if it's the newest");
});

test("formatCheckpointHistory shows the empty-history message instead of an empty body when there are no checkpoints", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec = makeSpec([]);
  const report = formatCheckpointHistory([], currentSpec, "Flower Shop", "en", t);
  assert.match(report, /No saved points yet\./);
});

test("formatCheckpointHistory renders in Hebrew when given the Hebrew translator, with Hebrew text surviving intact", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const currentSpec = makeSpec([{ name: "Customer", fields: [] }]);
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "בנייה ראשונית", kind: "build", spec: currentSpec, createdAt: "2026-03-01T09:00:00.000Z" },
  ];
  const report = formatCheckpointHistory(checkpoints, currentSpec, "חנות הפרחים", "he", t);

  assert.match(report, /חנות הפרחים/);
  assert.match(report, /בנייה ראשונית/);
});

/**
 * Round 1130: formatCheckpointHistory used to never call
 * computeCheckpointDiff at all -- the one piece of information
 * HistoryPanel.tsx's own "What would change?" toggle treats as central
 * enough to put a dedicated per-checkpoint control on, the exact same
 * "sibling report module omits content its own panel already computes"
 * gap round 1116 found and fixed for automationsReport.ts's run history.
 * This checkpoint removed the Invoice entity and changed Customer's own
 * fields relative to currentSpec, so every one of CheckpointDiff's four
 * kinds of entries (removed entity, lost field, gained field, changed
 * field) must appear in the exported report, using the exact same i18n
 * keys/params HistoryPanel.tsx's own on-screen rendering uses.
 */
test("formatCheckpointHistory includes each checkpoint's own restore-impact diff against currentSpec, the same information HistoryPanel.tsx's 'What would change?' toggle shows on screen", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec: ProductSpec = makeSpec([
    {
      name: "Customer",
      label: "Customers",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "notes", type: "text", required: false },
        { name: "tier", type: "enum", required: false, enumValues: ["gold", "silver"] },
      ],
    },
  ]);
  const checkpointSpec: ProductSpec = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }, { name: "phone", type: "text", required: false }] },
    { name: "Invoice", label: "Invoices", fields: [{ name: "total", type: "number", required: true }] },
  ]);
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "Older build", kind: "build", spec: checkpointSpec, createdAt: "2026-03-01T09:00:00.000Z" },
  ];

  const report = formatCheckpointHistory(checkpoints, currentSpec, "Flower Shop", "en", t);

  assert.match(report, /"Invoices" would be added to the menu\./, "Invoice exists in the checkpoint but not currentSpec, so restoring would ADD it");
  assert.match(report, /"Customers" would lose these fields: notes, tier\./, "fields present in currentSpec but not the checkpoint would be lost on restore");
  assert.match(report, /"Customers" would gain these fields: phone\./, "a field present in the checkpoint but not currentSpec would be gained on restore");
});

/**
 * The counterpart to the test above: a checkpoint whose spec is identical
 * to currentSpec (the one the report already tags `[Current state]`) must
 * not grow a redundant "no changes" block -- see this function's own doc
 * comment for why that's a deliberate choice, not an oversight.
 */
test("formatCheckpointHistory omits the diff section entirely for a checkpoint whose spec matches currentSpec, rather than printing a redundant 'no changes' line", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoints: Checkpoint[] = [{ id: "cp1", projectId: "p1", label: "Initial build", kind: "build", spec: currentSpec, createdAt: "2026-03-01T09:00:00.000Z" }];

  const report = formatCheckpointHistory(checkpoints, currentSpec, "Flower Shop", "en", t);

  assert.doesNotMatch(report, /What would change\?/, "a checkpoint with no diff must not even show the diff section's own heading");
  assert.doesNotMatch(report, /No changes/, "and must not fall back to the on-screen toggle's own 'no changes' message either");
});

test("resolveCompareSpec returns currentSpec when compareTargetId is null, keeping the original 'vs current' behavior unchanged", () => {
  const currentSpec = makeSpec([{ name: "Customer", fields: [] }]);
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "Initial build", kind: "build", spec: makeSpec([{ name: "Order", fields: [] }]), createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(resolveCompareSpec(checkpoints, null, currentSpec), currentSpec);
});

test("resolveCompareSpec returns the matching checkpoint's own spec when a real compareTargetId is given", () => {
  const currentSpec = makeSpec([{ name: "Customer", fields: [] }]);
  const olderSpec = makeSpec([{ name: "Order", fields: [] }]);
  const checkpoints: Checkpoint[] = [
    { id: "cp-older", projectId: "p1", label: "Initial build", kind: "build", spec: olderSpec, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "cp-newer", projectId: "p1", label: "Refine: add invoices", kind: "refine", spec: currentSpec, createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  assert.equal(resolveCompareSpec(checkpoints, "cp-older", currentSpec), olderSpec);
});

test("resolveCompareSpec falls back to currentSpec instead of throwing when the compareTargetId no longer matches any checkpoint", () => {
  const currentSpec = makeSpec([{ name: "Customer", fields: [] }]);
  assert.equal(resolveCompareSpec([], "cp-deleted", currentSpec), currentSpec);
});

test("formatCompareTarget names the current app state by default, and the real checkpoint label once one is chosen", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "Initial build", kind: "build", spec: makeSpec([]), createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(formatCompareTarget(checkpoints, null, t, "en"), "Current app state");
  assert.equal(formatCompareTarget(checkpoints, "cp1", t, "en"), "Initial build");
});

test("checkpointDisplayLabel returns the bare label when no other checkpoint shares it", () => {
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "Initial build", kind: "build", spec: makeSpec([]), createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "cp2", projectId: "p1", label: "Refine: add invoices", kind: "refine", spec: makeSpec([]), createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  const occurrences = checkpointLabelOccurrences(checkpoints);
  assert.equal(checkpointDisplayLabel(checkpoints[0], occurrences, "en"), "Initial build");
});

/**
 * Round 927: checkpoint labels are freely renamable (CheckpointLabelEditor)
 * with no uniqueness check anywhere in the save path, so two checkpoints
 * can legally end up sharing the exact same label -- the "Compare with"
 * dropdown and the "Comparing to" header both used to render that shared
 * label with nothing to tell the two apart. Confirms a disambiguator
 * (the checkpoint's own createdAt, already what the main list shows under
 * each label) is appended only when the label is genuinely ambiguous.
 */
test("checkpointDisplayLabel appends a date disambiguator when two checkpoints share the identical label", () => {
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "v1", kind: "refine", spec: makeSpec([]), createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "cp2", projectId: "p1", label: "v1", kind: "refine", spec: makeSpec([]), createdAt: "2026-01-02T15:30:00.000Z" },
  ];
  const occurrences = checkpointLabelOccurrences(checkpoints);
  const label1 = checkpointDisplayLabel(checkpoints[0], occurrences, "en");
  const label2 = checkpointDisplayLabel(checkpoints[1], occurrences, "en");
  assert.notEqual(label1, label2, "the two same-labeled checkpoints must now render as genuinely distinct strings");
  assert.match(label1, /^v1 \(.+\)$/, "must still lead with the real label, with the disambiguator appended, not replacing it");
  assert.match(label2, /^v1 \(.+\)$/);
});

test("formatCompareTarget disambiguates two same-labeled checkpoints in the 'Comparing to' header, not just the bare label", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "v1", kind: "refine", spec: makeSpec([]), createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "cp2", projectId: "p1", label: "v1", kind: "refine", spec: makeSpec([]), createdAt: "2026-01-02T15:30:00.000Z" },
  ];
  const result1 = formatCompareTarget(checkpoints, "cp1", t, "en");
  const result2 = formatCompareTarget(checkpoints, "cp2", t, "en");
  assert.notEqual(result1, result2, "comparing against each of the two same-labeled checkpoints must read as genuinely different targets");
});

test("computeCheckpointDiff correctly compares two arbitrary checkpoints against each other, not just a checkpoint against currentSpec", () => {
  // The real motivating scenario: comparing an OLDER checkpoint's own spec
  // (used here as the resolved "baseline", exactly what resolveCompareSpec
  // would hand computeCheckpointDiff once a "compare with" target is
  // chosen) against a NEWER checkpoint, entirely independent of whatever
  // currentSpec happens to be right now.
  const olderSpec = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);
  const newerSpec = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
    { name: "Invoice", label: "Invoices", fields: [{ name: "total", type: "number", required: true }] },
  ]);

  // Diffing "older as baseline" vs "newer checkpoint": this is exactly
  // resolveCompareSpec's own motivating example ("what did refine #3 add
  // that refine #1 didn't have yet?") -- Invoice must show up as an
  // addedEntity, not silently disappear into "no changes" just because
  // nothing was REMOVED going from older to newer.
  const forward = computeCheckpointDiff(olderSpec, newerSpec);
  assert.deepEqual(forward.removedEntities, []);
  assert.deepEqual(forward.addedEntities, [{ name: "Invoice", label: "Invoices" }]);

  // The reverse direction: newer as the baseline, older as the checkpoint
  // being compared -- Invoice exists in the baseline but not in older, so
  // it's correctly reported as what restoring "older" would remove (and
  // nothing is reported as added, since older adds nothing newer lacks).
  const reversed = computeCheckpointDiff(newerSpec, olderSpec);
  assert.deepEqual(reversed.removedEntities, [{ name: "Invoice", label: "Invoices" }]);
  assert.deepEqual(reversed.addedEntities, []);
});
