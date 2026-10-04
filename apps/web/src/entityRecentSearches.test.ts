import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addEntityRecentSearch,
  clearEntityRecentSearches,
  getEntityRecentSearches,
  removeEntityRecentSearch,
} from "./entityRecentSearches.js";

/** Same full-jsdom-swap technique columnOrder.test.ts/recentProjectSearches.test.ts use: real localStorage, not a mock. */
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

test("getEntityRecentSearches returns an empty list when nothing has ever been searched", async () => {
  await withJsdom(() => {
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), []);
  });
});

test("addEntityRecentSearch adds a query to the front, and a fresh getEntityRecentSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addEntityRecentSearch("proj1", "Customer", "unpaid");
    assert.deepEqual(after, ["unpaid"]);
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), ["unpaid"], "must actually be written to storage, not just returned");
  });
});

test("addEntityRecentSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "acme");
    addEntityRecentSearch("proj1", "Customer", "zeta");
    const after = addEntityRecentSearch("proj1", "Customer", "mid");
    assert.deepEqual(after, ["mid", "zeta", "acme"]);
  });
});

test("addEntityRecentSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "Acme");
    addEntityRecentSearch("proj1", "Customer", "zeta");
    const after = addEntityRecentSearch("proj1", "Customer", "acme");
    assert.deepEqual(after, ["acme", "zeta"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addEntityRecentSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addEntityRecentSearch("proj1", "Customer", q);
    }
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), ["six", "five", "four", "three", "two"]);
  });
});

test("addEntityRecentSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "acme");
    const after = addEntityRecentSearch("proj1", "Customer", "   ");
    assert.deepEqual(after, ["acme"]);
  });
});

test("recent searches are scoped per project+entity -- searching one project's entity never affects a same-named entity in a different project, or a different entity in the same project", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "unpaid");
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer"), [], "a different project must not see proj1's recent searches");
    assert.deepEqual(getEntityRecentSearches("proj1", "Order"), [], "a different entity in the same project must not see Customer's recent searches");
  });
});

test("clearEntityRecentSearches wipes only this project+entity's list, leaving a sibling entity's list untouched", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "acme");
    addEntityRecentSearch("proj1", "Customer", "zeta");
    addEntityRecentSearch("proj1", "Order", "paid");
    clearEntityRecentSearches("proj1", "Customer");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), []);
    assert.deepEqual(getEntityRecentSearches("proj1", "Order"), ["paid"], "clearing Customer must not touch Order's own list");
  });
});

test("removeEntityRecentSearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getEntityRecentSearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "acme");
    addEntityRecentSearch("proj1", "Customer", "zeta");
    addEntityRecentSearch("proj1", "Customer", "mid");
    const after = removeEntityRecentSearch("proj1", "Customer", "ZETA");
    assert.deepEqual(after, ["mid", "acme"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), ["mid", "acme"], "must actually be persisted, not just returned");
  });
});

test("removeEntityRecentSearch is a no-op when the query isn't in the list", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("proj1", "Customer", "acme");
    const after = removeEntityRecentSearch("proj1", "Customer", "nonexistent");
    assert.deepEqual(after, ["acme"]);
  });
});

test("getEntityRecentSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.entityRecentSearches", "not valid json{{{");
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), []);

    localStorage.setItem("forge.entityRecentSearches", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getEntityRecentSearches("proj1", "Customer"), []);

    localStorage.setItem(
      "forge.entityRecentSearches",
      JSON.stringify({ "proj1:Customer": ["acme", 42, null, "zeta"] }),
    );
    assert.deepEqual(
      getEntityRecentSearches("proj1", "Customer"),
      ["acme", "zeta"],
      "non-string entries must be dropped, not crash the whole read",
    );
  });
});
