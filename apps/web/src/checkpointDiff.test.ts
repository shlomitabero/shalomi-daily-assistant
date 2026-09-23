import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { computeCheckpointDiff } from "./checkpointDiff.js";

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
