import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "./recentSearches.js";

/** Same full-jsdom-swap technique pinnedProjects.test.ts uses: real localStorage, not a mock. */
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

test("getRecentSearches returns an empty list when nothing has ever been searched", async () => {
  await withJsdom(() => {
    assert.deepEqual(getRecentSearches("proj1"), []);
  });
});

test("addRecentSearch adds a query to the front, and a fresh getRecentSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addRecentSearch("proj1", "amy");
    assert.deepEqual(after, ["amy"]);
    assert.deepEqual(getRecentSearches("proj1"), ["amy"], "must actually be written to storage, not just returned");
  });
});

test("addRecentSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addRecentSearch("proj1", "amy");
    addRecentSearch("proj1", "zed");
    const after = addRecentSearch("proj1", "mid");
    assert.deepEqual(after, ["mid", "zed", "amy"]);
  });
});

test("addRecentSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addRecentSearch("proj1", "Amy");
    addRecentSearch("proj1", "zed");
    const after = addRecentSearch("proj1", "amy");
    assert.deepEqual(after, ["amy", "zed"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addRecentSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addRecentSearch("proj1", q);
    }
    assert.deepEqual(getRecentSearches("proj1"), ["six", "five", "four", "three", "two"]);
  });
});

test("addRecentSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addRecentSearch("proj1", "amy");
    const after = addRecentSearch("proj1", "   ");
    assert.deepEqual(after, ["amy"]);
  });
});

test("recent searches are kept per-project -- one project's searches never leak into another's list", async () => {
  await withJsdom(() => {
    addRecentSearch("proj1", "amy");
    addRecentSearch("proj2", "zed");
    assert.deepEqual(getRecentSearches("proj1"), ["amy"]);
    assert.deepEqual(getRecentSearches("proj2"), ["zed"]);
  });
});

test("clearRecentSearches wipes this project's list but never touches another project's", async () => {
  await withJsdom(() => {
    addRecentSearch("proj1", "amy");
    addRecentSearch("proj2", "zed");
    clearRecentSearches("proj1");
    assert.deepEqual(getRecentSearches("proj1"), []);
    assert.deepEqual(getRecentSearches("proj2"), ["zed"]);
  });
});

test("getRecentSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.recentSearches.proj1", "not valid json{{{");
    assert.deepEqual(getRecentSearches("proj1"), []);

    localStorage.setItem("forge.recentSearches.proj1", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getRecentSearches("proj1"), []);

    localStorage.setItem("forge.recentSearches.proj1", JSON.stringify(["amy", 42, null, "zed"]));
    assert.deepEqual(getRecentSearches("proj1"), ["amy", "zed"], "non-string entries must be dropped, not crash the whole read");
  });
});
