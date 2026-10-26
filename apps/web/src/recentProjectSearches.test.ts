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
    assert.deepEqual(getRecentProjectSearches("userA"), []);
  });
});

test("addRecentProjectSearch adds a query to the front, and a fresh getRecentProjectSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addRecentProjectSearch("userA", "acme");
    assert.deepEqual(after, ["acme"]);
    assert.deepEqual(getRecentProjectSearches("userA"), ["acme"], "must actually be written to storage, not just returned");
  });
});

test("addRecentProjectSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "acme");
    addRecentProjectSearch("userA", "zeta");
    const after = addRecentProjectSearch("userA", "mid");
    assert.deepEqual(after, ["mid", "zeta", "acme"]);
  });
});

test("addRecentProjectSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "Acme");
    addRecentProjectSearch("userA", "zeta");
    const after = addRecentProjectSearch("userA", "acme");
    assert.deepEqual(after, ["acme", "zeta"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addRecentProjectSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addRecentProjectSearch("userA", q);
    }
    assert.deepEqual(getRecentProjectSearches("userA"), ["six", "five", "four", "three", "two"]);
  });
});

test("addRecentProjectSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "acme");
    const after = addRecentProjectSearch("userA", "   ");
    assert.deepEqual(after, ["acme"]);
  });
});

test("clearRecentProjectSearches wipes the whole list", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "acme");
    addRecentProjectSearch("userA", "zeta");
    clearRecentProjectSearches("userA");
    assert.deepEqual(getRecentProjectSearches("userA"), []);
  });
});

test("removeRecentProjectSearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getRecentProjectSearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "acme");
    addRecentProjectSearch("userA", "zeta");
    addRecentProjectSearch("userA", "mid");
    const after = removeRecentProjectSearch("userA", "ZETA");
    assert.deepEqual(after, ["mid", "acme"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getRecentProjectSearches("userA"), ["mid", "acme"], "must actually be persisted, not just returned");
  });
});

test("removeRecentProjectSearch is a no-op when the query isn't in the list", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "acme");
    const after = removeRecentProjectSearch("userA", "nonexistent");
    assert.deepEqual(after, ["acme"]);
  });
});

test("getRecentProjectSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.recentProjectSearches.userA", "not valid json{{{");
    assert.deepEqual(getRecentProjectSearches("userA"), []);

    localStorage.setItem("forge.recentProjectSearches.userA", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getRecentProjectSearches("userA"), []);

    localStorage.setItem("forge.recentProjectSearches.userA", JSON.stringify(["acme", 42, null, "zeta"]));
    assert.deepEqual(getRecentProjectSearches("userA"), ["acme", "zeta"], "non-string entries must be dropped, not crash the whole read");
  });
});

/**
 * Round 1045: this store used to be one single flat key shared by every
 * account on the same browser -- a different user logging into the same
 * shared/public computer (after the first user merely closed the tab
 * instead of logging out, the one path App.tsx's own clear-on-logout never
 * covers) would otherwise inherit the first user's own typed search terms
 * in their own Recent Searches dropdown. Mirrors pinnedProjects.test.ts's
 * own identical cross-account isolation test, and ideaDraft.test.ts's own
 * round-1044 version of the same test for this store's direct sibling.
 */
test("getRecentProjectSearches/addRecentProjectSearch/removeRecentProjectSearch/clearRecentProjectSearches are scoped per user, so one account's searches never leak into another's on the same browser", async () => {
  await withJsdom(() => {
    addRecentProjectSearch("userA", "acme corp");
    assert.deepEqual(getRecentProjectSearches("userB"), [], "userB, a different account on the same browser, must not see userA's search just because userA typed one");

    addRecentProjectSearch("userB", "globex");
    assert.deepEqual(getRecentProjectSearches("userA"), ["acme corp"], "userB searching their own term must never touch userA's own already-saved search");
    assert.deepEqual(getRecentProjectSearches("userB"), ["globex"]);

    removeRecentProjectSearch("userB", "globex");
    assert.deepEqual(getRecentProjectSearches("userA"), ["acme corp"], "removing userB's own search must never touch userA's own search");

    clearRecentProjectSearches("userA");
    assert.deepEqual(getRecentProjectSearches("userA"), [], "clearing userA's own searches must actually clear them");
  });
});
