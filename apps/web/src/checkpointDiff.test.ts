import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { computeCheckpointDiff, isCheckpointCurrent } from "./checkpointDiff.js";

function makeSpec(entities: ProductSpec["entities"]): ProductSpec {
  return { summary: "s", personas: [], roles: ["Admin"], entities, screens: [], assumptions: [], openQuestions: [] };
}

test("computeCheckpointDiff reports an entity present now but missing from the checkpoint as removed", () => {
  const current = makeSpec([
    { name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] },
    { name: "Invoice", label: "Invoices", fields: [{ name: "total", type: "number", required: true }] },
  ]);
  const checkpoint = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, [{ name: "Invoice", label: "Invoices" }]);
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
  assert.deepEqual(diff.changedEntities, [{ name: "Customer", label: "Customers", removedFieldNames: ["Loyalty Points"] }]);
});

test("computeCheckpointDiff falls back to the raw name when a field or entity has no label", () => {
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "notes", type: "text", required: false }] }]);
  const checkpoint = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.changedEntities, [{ name: "Customer", label: "Customer", removedFieldNames: ["notes"] }]);
});

test("computeCheckpointDiff reports nothing when the checkpoint has strictly the same or more entities/fields", () => {
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpointWithExtra = makeSpec([
    {
      name: "Customer",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "phone", type: "text", required: false },
      ],
    },
    { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpointWithExtra);
  assert.deepEqual(diff.removedEntities, []);
  assert.deepEqual(diff.changedEntities, []);
});

test("computeCheckpointDiff never flags a brand-new entity in the checkpoint as a removal -- only the reverse direction counts", () => {
  // Restoring a checkpoint that has entities the CURRENT spec doesn't have
  // yet (a "future" checkpoint relative to a refine that later dropped
  // something) is a gain from the current spec's perspective, not a loss --
  // only entities/fields present now and absent from the checkpoint are
  // real removals.
  const current = makeSpec([{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoint = makeSpec([
    { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
    { name: "Invoice", fields: [{ name: "total", type: "number", required: true }] },
  ]);

  const diff = computeCheckpointDiff(current, checkpoint);
  assert.deepEqual(diff.removedEntities, []);
  assert.deepEqual(diff.changedEntities, []);
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
