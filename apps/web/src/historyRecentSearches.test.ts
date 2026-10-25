import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addRecentHistorySearch,
  clearRecentHistorySearches,
  getRecentHistorySearches,
  purgeRecentHistorySearchesForProject,
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
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), []);
  });
});

test("addRecentHistorySearch adds a query to the front, and a fresh getRecentHistorySearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addRecentHistorySearch("proj1", "userA", "pricing overhaul");
    assert.deepEqual(after, ["pricing overhaul"]);
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), ["pricing overhaul"], "must actually be written to storage, not just returned");
  });
});

test("addRecentHistorySearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    addRecentHistorySearch("proj1", "userA", "zed");
    const after = addRecentHistorySearch("proj1", "userA", "mid");
    assert.deepEqual(after, ["mid", "zed", "amy"]);
  });
});

test("addRecentHistorySearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "Amy");
    addRecentHistorySearch("proj1", "userA", "zed");
    const after = addRecentHistorySearch("proj1", "userA", "amy");
    assert.deepEqual(after, ["amy", "zed"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addRecentHistorySearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addRecentHistorySearch("proj1", "userA", q);
    }
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), ["six", "five", "four", "three", "two"]);
  });
});

test("addRecentHistorySearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    const after = addRecentHistorySearch("proj1", "userA", "   ");
    assert.deepEqual(after, ["amy"]);
  });
});

test("recent history searches are kept per-project -- one project's searches never leak into another's list", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    addRecentHistorySearch("proj2", "userA", "zed");
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), ["amy"]);
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["zed"]);
  });
});

/**
 * Round 994: the whole point of this round's fix. Before it, the storage
 * key was projectId alone -- two different collaborator accounts sharing
 * the SAME project on the SAME browser saw each other's own typed
 * checkpoint-search text.
 */
test("recent history searches are also kept per-user -- two different accounts on the SAME project never see each other's searches", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "before the pricing overhaul");
    addRecentHistorySearch("proj1", "userB", "unrelated checkpoint");
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), ["before the pricing overhaul"]);
    assert.deepEqual(getRecentHistorySearches("proj1", "userB"), ["unrelated checkpoint"], "userB must never see userA's own typed search text");
  });
});

test("recent history searches are stored separately from Global Search's own recent searches, even for the same project and user", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    assert.equal(localStorage.getItem("forge.recentSearches.proj1:userA"), null, "History's own list must not write into Global Search's storage key");
    assert.equal(localStorage.getItem("forge.historyRecentSearches.proj1:userA"), JSON.stringify(["amy"]));
  });
});

test("clearRecentHistorySearches wipes this project's list for this user only -- never another project's, and never another user's own list for the SAME project", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    addRecentHistorySearch("proj1", "userB", "other-user-query");
    addRecentHistorySearch("proj2", "userA", "zed");
    clearRecentHistorySearches("proj1", "userA");
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), []);
    assert.deepEqual(getRecentHistorySearches("proj1", "userB"), ["other-user-query"], "clearing userA's own list must never touch userB's");
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["zed"]);
  });
});

test("removeRecentHistorySearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getRecentHistorySearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    addRecentHistorySearch("proj1", "userA", "zed");
    addRecentHistorySearch("proj1", "userA", "mid");
    const after = removeRecentHistorySearch("proj1", "userA", "ZED");
    assert.deepEqual(after, ["mid", "amy"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), ["mid", "amy"], "must actually be persisted, not just returned");
  });
});

test("removeRecentHistorySearch is a no-op when the query isn't in the list, and never touches another project's list", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    addRecentHistorySearch("proj2", "userA", "zed");
    const after = removeRecentHistorySearch("proj1", "userA", "nonexistent");
    assert.deepEqual(after, ["amy"]);
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["zed"], "removing from proj1 must never affect proj2's own list");
  });
});

test("getRecentHistorySearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.historyRecentSearches.proj1:userA", "not valid json{{{");
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), []);

    localStorage.setItem("forge.historyRecentSearches.proj1:userA", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), []);

    localStorage.setItem("forge.historyRecentSearches.proj1:userA", JSON.stringify(["amy", 42, null, "zed"]));
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), ["amy", "zed"], "non-string entries must be dropped, not crash the whole read");
  });
});

test("purgeRecentHistorySearchesForProject removes every collaborator account's own list for that project, and never touches another project's entries", async () => {
  await withJsdom(() => {
    addRecentHistorySearch("proj1", "userA", "amy");
    addRecentHistorySearch("proj1", "userB", "other-user-query");
    addRecentHistorySearch("proj2", "userA", "zed");
    purgeRecentHistorySearchesForProject("proj1");
    assert.deepEqual(getRecentHistorySearches("proj1", "userA"), [], "userA's own proj1 list must be gone");
    assert.deepEqual(getRecentHistorySearches("proj1", "userB"), [], "userB's own proj1 list must be gone too, not just userA's");
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["zed"], "a completely different project's own entries must be untouched");
  });
});
