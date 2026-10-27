import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getSortKeys, migrateSortKeysForEntityRename, purgeSortKeysForEntity, setSortKeys } from "./sortKeysPreference.js";

/** Same full-jsdom-swap technique used by viewModePreference.test.ts: real localStorage, not a mock. */
async function withJsdom(fn: () => void | Promise<void>): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const originals: Record<string, unknown> = {};
  const keys = ["window", "document", "navigator", "localStorage"];
  for (const key of keys) {
    originals[key] = (globalThis as Record<string, unknown>)[key];
  }
  try {
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] !== undefined) Object.defineProperty(globalThis, key, { value: originals[key], configurable: true });
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("getSortKeys returns [] when no sort has ever been chosen", async () => {
  await withJsdom(() => {
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), []);
  });
});

test("setSortKeys persists a real single-column sort, and a fresh getSortKeys call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setSortKeys("proj1", "Deal", "userA", [{ field: "status", direction: "asc" }]);
    assert.deepEqual(after, [{ field: "status", direction: "asc" }]);
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), [{ field: "status", direction: "asc" }], "must actually be written to storage, not just returned");
  });
});

test("setSortKeys persists a real multi-column sort in priority order", async () => {
  await withJsdom(() => {
    setSortKeys("proj1", "Deal", "userA", [
      { field: "status", direction: "asc" },
      { field: "total", direction: "desc" },
    ]);
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), [
      { field: "status", direction: "asc" },
      { field: "total", direction: "desc" },
    ]);
  });
});

test("setSortKeys back to [] clears the persisted entry instead of storing an empty array", async () => {
  await withJsdom(() => {
    setSortKeys("proj1", "Deal", "userA", [{ field: "status", direction: "asc" }]);
    setSortKeys("proj1", "Deal", "userA", []);
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), []);
    const raw = localStorage.getItem("forge.sortKeys");
    assert.equal(raw, "{}", "the no-sort choice should not bloat storage with an explicit empty entry");
  });
});

test("sort keys are scoped per project+entity -- setting one project's entity never affects a same-named entity in a different project or a different entity in the same project", async () => {
  await withJsdom(() => {
    setSortKeys("proj1", "Deal", "userA", [{ field: "status", direction: "asc" }]);
    assert.deepEqual(getSortKeys("proj2", "Deal", "userA"), [], "a different project must not see proj1's sort choice");
    assert.deepEqual(getSortKeys("proj1", "Customer", "userA"), [], "a different entity in the same project must not see Deal's sort choice");
  });
});

/**
 * Round 1074: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project+entity on the SAME browser silently
 * saw, and could overwrite, each other's own multi-column sort order.
 */
test("sort keys are also kept per-user -- two different accounts on the SAME project+entity never see each other's own sort order", async () => {
  await withJsdom(() => {
    setSortKeys("proj1", "Deal", "userA", [{ field: "status", direction: "asc" }]);
    setSortKeys("proj1", "Deal", "userB", [{ field: "total", direction: "desc" }]);
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), [{ field: "status", direction: "asc" }]);
    assert.deepEqual(getSortKeys("proj1", "Deal", "userB"), [{ field: "total", direction: "desc" }], "userB must never see userA's own sort order");
  });
});

test("getSortKeys falls back to [] for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.sortKeys", "not real json{{{");
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), []);
  });
});

test("getSortKeys ignores an entry that isn't a real sort-key array (foreign data written by something else) instead of returning it", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.sortKeys", JSON.stringify({ "proj1:Deal:userA": [{ field: "status", direction: "sideways" }] }));
    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), []);
  });
});

/**
 * Round 1074: purgeSortKeysForEntity is what entityPreferenceCleanup.ts
 * calls on an entity drop -- there's no single "current user" at drop
 * time, so it must sweep every collaborator's own entry, not just one.
 */
test("purgeSortKeysForEntity removes the entity's own sort choice for EVERY collaborator account, leaving a sibling entity's own choice untouched", async () => {
  await withJsdom(() => {
    setSortKeys("proj1", "Deal", "userA", [{ field: "status", direction: "asc" }]);
    setSortKeys("proj1", "Deal", "userB", [{ field: "total", direction: "desc" }]);
    setSortKeys("proj1", "Customer", "userA", [{ field: "name", direction: "asc" }]);

    purgeSortKeysForEntity("proj1", "Deal");

    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), [], "userA's own sort choice must be gone");
    assert.deepEqual(getSortKeys("proj1", "Deal", "userB"), [], "userB's own sort choice must be gone too, not just userA's");
    assert.deepEqual(getSortKeys("proj1", "Customer", "userA"), [{ field: "name", direction: "asc" }], "a sibling entity's own sort choice must survive untouched");
  });
});

/**
 * Round 1074: migrateSortKeysForEntityRename must remap EVERY
 * collaborator's own entry on a case-only rename, not just one.
 */
test("migrateSortKeysForEntityRename remaps every collaborator's own sort choice to the new casing, leaving a sibling entity's own choice untouched", async () => {
  await withJsdom(() => {
    setSortKeys("proj1", "deal", "userA", [{ field: "status", direction: "asc" }]);
    setSortKeys("proj1", "deal", "userB", [{ field: "total", direction: "desc" }]);
    setSortKeys("proj1", "Customer", "userA", [{ field: "name", direction: "asc" }]);

    migrateSortKeysForEntityRename("proj1", "deal", "Deal");

    assert.deepEqual(getSortKeys("proj1", "Deal", "userA"), [{ field: "status", direction: "asc" }], "userA's sort choice must resolve under the new casing");
    assert.deepEqual(getSortKeys("proj1", "Deal", "userB"), [{ field: "total", direction: "desc" }], "userB's sort choice must resolve under the new casing too");
    assert.deepEqual(getSortKeys("proj1", "deal", "userA"), [], "nothing must remain reachable under the old casing");
    assert.deepEqual(getSortKeys("proj1", "Customer", "userA"), [{ field: "name", direction: "asc" }], "a sibling entity's own sort choice must survive the rename untouched");
  });
});
