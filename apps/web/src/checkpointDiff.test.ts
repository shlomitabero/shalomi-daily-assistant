import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checkpoint, ProductSpec } from "@forge/shared";
import {
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

function makeCheckpoint(label: string): Checkpoint {
  return { id: label, projectId: "p1", label, spec: makeSpec([]), createdAt: "2026-01-01T00:00:00.000Z" };
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

test("getCheckpointType reads 'build' vs 'refine' from a checkpoint's own label, in both English and Hebrew", () => {
  assert.equal(getCheckpointType(makeCheckpoint("Initial build")), "build");
  assert.equal(getCheckpointType(makeCheckpoint("Refine: add invoice tracking")), "refine");
  assert.equal(getCheckpointType(makeCheckpoint("בנייה ראשונית")), "build");
  assert.equal(getCheckpointType(makeCheckpoint("שיפור: הוספת מעקב חשבוניות")), "refine");
});

test("filterCheckpointsByType('all') returns every checkpoint unchanged", () => {
  const checkpoints = [makeCheckpoint("Initial build"), makeCheckpoint("Refine: add invoice tracking")];
  assert.deepEqual(filterCheckpointsByType(checkpoints, "all"), checkpoints);
});

test("filterCheckpointsByType('build') keeps only the initial build, dropping every refine", () => {
  const checkpoints = [
    makeCheckpoint("Initial build"),
    makeCheckpoint("Refine: add invoice tracking"),
    makeCheckpoint("Refine: add customer notes"),
  ];
  assert.deepEqual(
    filterCheckpointsByType(checkpoints, "build").map((c) => c.label),
    ["Initial build"],
  );
});

test("filterCheckpointsByType('refine') keeps only refines, dropping the initial build", () => {
  const checkpoints = [
    makeCheckpoint("Initial build"),
    makeCheckpoint("Refine: add invoice tracking"),
    makeCheckpoint("Refine: add customer notes"),
  ];
  assert.deepEqual(
    filterCheckpointsByType(checkpoints, "refine").map((c) => c.label),
    ["Refine: add invoice tracking", "Refine: add customer notes"],
  );
});

test("filterCheckpointsByType composes with filterCheckpoints' own text search, narrowing to exactly what matches both", () => {
  const checkpoints = [
    makeCheckpoint("Initial build"),
    makeCheckpoint("Refine: add invoice tracking"),
    makeCheckpoint("Refine: add customer notes"),
  ];
  const searched = filterCheckpoints(checkpoints, "add");
  assert.deepEqual(
    filterCheckpointsByType(searched, "refine").map((c) => c.label),
    ["Refine: add invoice tracking", "Refine: add customer notes"],
  );
});

test("filterCheckpointsByType returns an empty list, not everything, when no checkpoint matches the type", () => {
  const checkpoints = [makeCheckpoint("Initial build")];
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
test("formatCheckpointHistory includes the project name, each checkpoint's own label, timestamp, and screen count", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoints: Checkpoint[] = [
    {
      id: "cp2",
      projectId: "p1",
      label: "Refine: add invoice tracking",
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
      spec: currentSpec,
      createdAt: "2026-03-01T09:00:00.000Z",
    },
  ];

  const report = formatCheckpointHistory(checkpoints, currentSpec, "Flower Shop", "en", t);

  assert.match(report, /Flower Shop/);
  assert.match(report, /Refine: add invoice tracking/);
  assert.match(report, /Initial build/);
  assert.match(report, /2 screens/, "the invoice-tracking checkpoint has 2 entities, must show '2 screens'");
  assert.match(report, /1 screens/, "the initial-build checkpoint has 1 entity");
});

test("formatCheckpointHistory marks exactly the checkpoint matching the current spec, not the newest one", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const currentSpec = makeSpec([{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }]);
  const checkpoints: Checkpoint[] = [
    {
      id: "cp2",
      projectId: "p1",
      label: "Refine: add invoice tracking",
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
    { id: "cp1", projectId: "p1", label: "בנייה ראשונית", spec: currentSpec, createdAt: "2026-03-01T09:00:00.000Z" },
  ];
  const report = formatCheckpointHistory(checkpoints, currentSpec, "חנות הפרחים", "he", t);

  assert.match(report, /חנות הפרחים/);
  assert.match(report, /בנייה ראשונית/);
});

test("resolveCompareSpec returns currentSpec when compareTargetId is null, keeping the original 'vs current' behavior unchanged", () => {
  const currentSpec = makeSpec([{ name: "Customer", fields: [] }]);
  const checkpoints: Checkpoint[] = [
    { id: "cp1", projectId: "p1", label: "Initial build", spec: makeSpec([{ name: "Order", fields: [] }]), createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(resolveCompareSpec(checkpoints, null, currentSpec), currentSpec);
});

test("resolveCompareSpec returns the matching checkpoint's own spec when a real compareTargetId is given", () => {
  const currentSpec = makeSpec([{ name: "Customer", fields: [] }]);
  const olderSpec = makeSpec([{ name: "Order", fields: [] }]);
  const checkpoints: Checkpoint[] = [
    { id: "cp-older", projectId: "p1", label: "Initial build", spec: olderSpec, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "cp-newer", projectId: "p1", label: "Refine: add invoices", spec: currentSpec, createdAt: "2026-01-02T00:00:00.000Z" },
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
    { id: "cp1", projectId: "p1", label: "Initial build", spec: makeSpec([]), createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(formatCompareTarget(checkpoints, null, t), "Current app state");
  assert.equal(formatCompareTarget(checkpoints, "cp1", t), "Initial build");
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

  // Diffing "older as baseline" vs "newer checkpoint": nothing in older is
  // missing from newer (newer only adds Invoice), so no changes reported.
  assert.deepEqual(computeCheckpointDiff(olderSpec, newerSpec), { removedEntities: [], changedEntities: [] });

  // The reverse direction: newer as the baseline, older as the checkpoint
  // being compared -- Invoice exists in the baseline but not in older, so
  // it's correctly reported as what restoring "older" would remove.
  const reversed = computeCheckpointDiff(newerSpec, olderSpec);
  assert.deepEqual(reversed.removedEntities, [{ name: "Invoice", label: "Invoices" }]);
});
