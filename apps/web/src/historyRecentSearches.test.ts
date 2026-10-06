import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addRecentHistorySearch,
  clearRecentHistorySearches,
  getRecentHistorySearches,
  removeRecentHistorySearch,
} from "./historyRecentSearches.js";

/** Same full-jsdom-swap technique recentSearches.test.ts uses: real localStorage, not a mock. */
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

test("getRecentHistorySearches returns an empty list when nothing has ever been searched", async () => {
  await withJsdom(() => {
    assert.deepEqual(getRecentHistorySearches("proj1"), []);
  });
});

test("addRecentHistorySearch adds a query to the front, and a fresh getRecentHistorySearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addRecentHistorySearch("proj1", "pricing overhaul");
    assert.deepEqual(after, ["pricing overhaul"]);
    assert.deepEqual(getRecentHistorySearches("proj1"), ["pricing overhaul"], "must actually be written to storage, not just returned");
  });
});

test("addRecentHistorySearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    addRecentHistorySearch("proj1", "zed");
    const after = addRecentHistorySearch("proj1", "mid");
    assert.deepEqual(after, ["mid", "zed", "amy"]);
  });
});

test("addRecentHistorySearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "Amy");
    addRecentHistorySearch("proj1", "zed");
    const after = addRecentHistorySearch("proj1", "amy");
    assert.deepEqual(after, ["amy", "zed"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addRecentHistorySearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addRecentHistorySearch("proj1", q);
    }
    assert.deepEqual(getRecentHistorySearches("proj1"), ["six", "five", "four", "three", "two"]);
  });
});

test("addRecentHistorySearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    const after = addRecentHistorySearch("proj1", "   ");
    assert.deepEqual(after, ["amy"]);
  });
});

test("recent history searches are kept per-project -- one project's searches never leak into another's list", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    addRecentHistorySearch("proj2", "zed");
    assert.deepEqual(getRecentHistorySearches("proj1"), ["amy"]);
    assert.deepEqual(getRecentHistorySearches("proj2"), ["zed"]);
  });
});

test("recent history searches are stored separately from Global Search's own recent searches, even for the same project", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    assert.equal(localStorage.getItem("forge.recentSearches.proj1"), null, "History's own list must not write into Global Search's storage key");
    assert.equal(localStorage.getItem("forge.historyRecentSearches.proj1"), JSON.stringify(["amy"]));
  });
});

test("clearRecentHistorySearches wipes this project's list but never touches another project's", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    addRecentHistorySearch("proj2", "zed");
    clearRecentHistorySearches("proj1");
    assert.deepEqual(getRecentHistorySearches("proj1"), []);
    assert.deepEqual(getRecentHistorySearches("proj2"), ["zed"]);
  });
});

test("removeRecentHistorySearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getRecentHistorySearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    addRecentHistorySearch("proj1", "zed");
    addRecentHistorySearch("proj1", "mid");
    const after = removeRecentHistorySearch("proj1", "ZED");
    assert.deepEqual(after, ["mid", "amy"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getRecentHistorySearches("proj1"), ["mid", "amy"], "must actually be persisted, not just returned");
  });
});

test("removeRecentHistorySearch is a no-op when the query isn't in the list, and never touches another project's list", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "amy");
    addRecentHistorySearch("proj2", "zed");
    const after = removeRecentHistorySearch("proj1", "nonexistent");
    assert.deepEqual(after, ["amy"]);
    assert.deepEqual(getRecentHistorySearches("proj2"), ["zed"], "removing from proj1 must never affect proj2's own list");
  });
});

test("getRecentHistorySearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.historyRecentSearches.proj1", "not valid json{{{");
    assert.deepEqual(getRecentHistorySearches("proj1"), []);

    localStorage.setItem("forge.historyRecentSearches.proj1", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getRecentHistorySearches("proj1"), []);

    localStorage.setItem("forge.historyRecentSearches.proj1", JSON.stringify(["amy", 42, null, "zed"]));
    assert.deepEqual(getRecentHistorySearches("proj1"), ["amy", "zed"], "non-string entries must be dropped, not crash the whole read");
  });
});
