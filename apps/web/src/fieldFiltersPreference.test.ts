import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  getFieldFilters,
  setFieldFilters,
  purgeFieldFiltersForEntity,
  purgeFieldFiltersForProject,
  migrateFieldFiltersForEntityRename,
} from "./fieldFiltersPreference.js";

/** Same full-jsdom-swap technique entityRecentSearches.test.ts/columnOrder.test.ts use: real localStorage, not a mock. */
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

test("getFieldFilters returns an empty map when nothing has ever been filtered", async () => {
  await withJsdom(() => {
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), {});
  });
});

test("setFieldFilters persists the filter map, and a fresh getFieldFilters call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setFieldFilters("proj1", "Customer", "userA", { status: "overdue" });
    assert.deepEqual(after, { status: "overdue" });
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), { status: "overdue" }, "must actually be written to storage, not just returned");
  });
});

test("filters are scoped per project+entity -- setting one project's entity never affects a same-named entity in a different project, or a different entity in the same project", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "Customer", "userA", { status: "overdue" });
    assert.deepEqual(getFieldFilters("proj2", "Customer", "userA"), {}, "a different project must not see proj1's filter");
    assert.deepEqual(getFieldFilters("proj1", "Order", "userA"), {}, "a different entity in the same project must not see Customer's filter");
  });
});

/**
 * Round 1054: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project+entity on the SAME browser silently
 * saw each other's own typed filter value, with no indication it came
 * from someone else. Mirrors entityRecentSearches.test.ts's own round-994
 * regression test for the identical bug class.
 */
test("filters are also kept per-user -- two different accounts on the SAME project+entity never see each other's own chosen filter value", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "Customer", "userA", { status: "overdue" });
    setFieldFilters("proj1", "Customer", "userB", { status: "paid" });
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), { status: "overdue" });
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userB"), { status: "paid" }, "userB must never see userA's own chosen filter value");
  });
});

test("setFieldFilters drops a field whose value is cleared to empty, rather than persisting an empty-string entry", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "Customer", "userA", { status: "overdue", region: "west" });
    const after = setFieldFilters("proj1", "Customer", "userA", { status: "", region: "west" });
    assert.deepEqual(after, { region: "west" });
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), { region: "west" });
  });
});

test("getFieldFilters tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.fieldFilters", "not valid json{{{");
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), {});

    localStorage.setItem("forge.fieldFilters", JSON.stringify({ not: "an array or object of objects" }));
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), {});

    localStorage.setItem(
      "forge.fieldFilters",
      JSON.stringify({ "proj1:Customer:userA": { status: "overdue", bogus: 42, other: null } }),
    );
    assert.deepEqual(
      getFieldFilters("proj1", "Customer", "userA"),
      { status: "overdue" },
      "non-string values must be dropped, not crash the whole read",
    );
  });
});

test("purgeFieldFiltersForEntity removes every collaborator account's own filter map for that project+entity, leaving a sibling entity's and a different project's entries untouched", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "Customer", "userA", { status: "overdue" });
    setFieldFilters("proj1", "Customer", "userB", { status: "paid" });
    setFieldFilters("proj1", "Order", "userA", { status: "shipped" });
    setFieldFilters("proj2", "Customer", "userA", { status: "closed" });
    purgeFieldFiltersForEntity("proj1", "Customer");
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), {}, "userA's own Customer filter must be gone");
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userB"), {}, "userB's own Customer filter must be gone too, not just userA's");
    assert.deepEqual(getFieldFilters("proj1", "Order", "userA"), { status: "shipped" }, "a sibling entity in the same project must be untouched");
    assert.deepEqual(getFieldFilters("proj2", "Customer", "userA"), { status: "closed" }, "the same-named entity in a different project must be untouched");
  });
});

test("purgeFieldFiltersForProject removes every collaborator account's own filter map across every entity in that project, and never touches another project's entries", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "Customer", "userA", { status: "overdue" });
    setFieldFilters("proj1", "Order", "userB", { status: "shipped" });
    setFieldFilters("proj2", "Customer", "userA", { status: "closed" });
    purgeFieldFiltersForProject("proj1");
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), {});
    assert.deepEqual(getFieldFilters("proj1", "Order", "userB"), {});
    assert.deepEqual(getFieldFilters("proj2", "Customer", "userA"), { status: "closed" }, "a completely different project's own entries must be untouched");
  });
});

test("migrateFieldFiltersForEntityRename moves every collaborator account's own filter map to the entity's new casing, leaving a sibling entity and a different project's same-named entity untouched", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "customer", "userA", { status: "overdue" });
    setFieldFilters("proj1", "customer", "userB", { status: "paid" });
    setFieldFilters("proj1", "Order", "userA", { status: "shipped" });
    setFieldFilters("proj2", "customer", "userA", { status: "closed" });

    migrateFieldFiltersForEntityRename("proj1", "customer", "Customer");

    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), { status: "overdue" }, "userA's filter must resolve under the new casing");
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userB"), { status: "paid" }, "userB's filter must resolve under the new casing too, not just userA's");
    assert.deepEqual(getFieldFilters("proj1", "customer", "userA"), {}, "nothing must remain reachable under the old casing");
    assert.deepEqual(getFieldFilters("proj1", "Order", "userA"), { status: "shipped" }, "a sibling entity must be untouched");
    assert.deepEqual(getFieldFilters("proj2", "customer", "userA"), { status: "closed" }, "an unrelated project's same-named entity must be untouched");
  });
});

test("migrateFieldFiltersForEntityRename is a no-op when the old and new names are identical", async () => {
  await withJsdom(() => {
    setFieldFilters("proj1", "Customer", "userA", { status: "overdue" });
    migrateFieldFiltersForEntityRename("proj1", "Customer", "Customer");
    assert.deepEqual(getFieldFilters("proj1", "Customer", "userA"), { status: "overdue" });
  });
});
