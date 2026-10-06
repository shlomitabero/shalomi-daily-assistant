import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addRecentProjectSearch,
  clearRecentProjectSearches,
  getRecentProjectSearches,
  removeRecentProjectSearch,
} from "./recentProjectSearches.js";

/** Same full-jsdom-swap technique pinnedProjects.test.ts/recentSearches.test.ts use: real localStorage, not a mock. */
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

test("getRecentProjectSearches returns an empty list when nothing has ever been searched", async () => {
  await withJsdom(() => {
    assert.deepEqual(getRecentProjectSearches(), []);
  });
});

test("addRecentProjectSearch adds a query to the front, and a fresh getRecentProjectSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addRecentProjectSearch("acme");
    assert.deepEqual(after, ["acme"]);
    assert.deepEqual(getRecentProjectSearches(), ["acme"], "must actually be written to storage, not just returned");
  });
});

test("addRecentProjectSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("acme");
    addRecentProjectSearch("zeta");
    const after = addRecentProjectSearch("mid");
    assert.deepEqual(after, ["mid", "zeta", "acme"]);
  });
});

test("addRecentProjectSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("Acme");
    addRecentProjectSearch("zeta");
    const after = addRecentProjectSearch("acme");
    assert.deepEqual(after, ["acme", "zeta"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addRecentProjectSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addRecentProjectSearch(q);
    }
    assert.deepEqual(getRecentProjectSearches(), ["six", "five", "four", "three", "two"]);
  });
});

test("addRecentProjectSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("acme");
    const after = addRecentProjectSearch("   ");
    assert.deepEqual(after, ["acme"]);
  });
});

test("clearRecentProjectSearches wipes the whole list", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("acme");
    addRecentProjectSearch("zeta");
    clearRecentProjectSearches();
    assert.deepEqual(getRecentProjectSearches(), []);
  });
});

test("removeRecentProjectSearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getRecentProjectSearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("acme");
    addRecentProjectSearch("zeta");
    addRecentProjectSearch("mid");
    const after = removeRecentProjectSearch("ZETA");
    assert.deepEqual(after, ["mid", "acme"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getRecentProjectSearches(), ["mid", "acme"], "must actually be persisted, not just returned");
  });
});

test("removeRecentProjectSearch is a no-op when the query isn't in the list", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("acme");
    const after = removeRecentProjectSearch("nonexistent");
    assert.deepEqual(after, ["acme"]);
  });
});

test("getRecentProjectSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.recentProjectSearches", "not valid json{{{");
    assert.deepEqual(getRecentProjectSearches(), []);

    localStorage.setItem("forge.recentProjectSearches", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getRecentProjectSearches(), []);

    localStorage.setItem("forge.recentProjectSearches", JSON.stringify(["acme", 42, null, "zeta"]));
    assert.deepEqual(getRecentProjectSearches(), ["acme", "zeta"], "non-string entries must be dropped, not crash the whole read");
  });
});
