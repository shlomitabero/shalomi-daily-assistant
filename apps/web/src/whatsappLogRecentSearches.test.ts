import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addWhatsAppLogRecentSearch,
  clearWhatsAppLogRecentSearches,
  getWhatsAppLogRecentSearches,
  purgeWhatsAppLogRecentSearchesForProject,
  removeWhatsAppLogRecentSearch,
} from "./whatsappLogRecentSearches.js";

/** Same full-jsdom-swap technique recentSearches.test.ts/recentProjectSearches.test.ts use: real localStorage, not a mock. */
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

test("getWhatsAppLogRecentSearches returns an empty list when nothing has ever been searched", async () => {
  await withJsdom(() => {
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), []);
  });
});

test("addWhatsAppLogRecentSearch adds a query to the front, and a fresh getWhatsAppLogRecentSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addWhatsAppLogRecentSearch("proj1", "userA", "failed");
    assert.deepEqual(after, ["failed"]);
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), ["failed"], "must actually be written to storage, not just returned");
  });
});

test("addWhatsAppLogRecentSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    addWhatsAppLogRecentSearch("proj1", "userA", "zeta");
    const after = addWhatsAppLogRecentSearch("proj1", "userA", "mid");
    assert.deepEqual(after, ["mid", "zeta", "acme"]);
  });
});

test("addWhatsAppLogRecentSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "Acme");
    addWhatsAppLogRecentSearch("proj1", "userA", "zeta");
    const after = addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    assert.deepEqual(after, ["acme", "zeta"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addWhatsAppLogRecentSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addWhatsAppLogRecentSearch("proj1", "userA", q);
    }
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), ["six", "five", "four", "three", "two"]);
  });
});

test("addWhatsAppLogRecentSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    const after = addWhatsAppLogRecentSearch("proj1", "userA", "   ");
    assert.deepEqual(after, ["acme"]);
  });
});

test("recent log searches are scoped per project -- searching one project's log never affects a different project's own list", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "failed");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj2", "userA"), [], "a different project must not see proj1's recent searches");
  });
});

/**
 * Round 994: the whole point of this round's fix. Before it, the storage
 * key was projectId alone -- two different collaborator accounts sharing
 * the SAME project on the SAME browser saw each other's own typed
 * message-log search text.
 */
test("recent log searches are also kept per-user -- two different accounts on the SAME project never see each other's searches", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "refund dispute");
    addWhatsAppLogRecentSearch("proj1", "userB", "unrelated query");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), ["refund dispute"]);
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userB"), ["unrelated query"], "userB must never see userA's own typed search text");
  });
});

test("clearWhatsAppLogRecentSearches wipes this user's own list for this project only, leaving another collaborator's own list for the SAME project untouched", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    addWhatsAppLogRecentSearch("proj1", "userA", "zeta");
    addWhatsAppLogRecentSearch("proj1", "userB", "other-user-query");
    clearWhatsAppLogRecentSearches("proj1", "userA");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), []);
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userB"), ["other-user-query"], "clearing userA's own list must never touch userB's");
  });
});

test("removeWhatsAppLogRecentSearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getWhatsAppLogRecentSearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    addWhatsAppLogRecentSearch("proj1", "userA", "zeta");
    addWhatsAppLogRecentSearch("proj1", "userA", "mid");
    const after = removeWhatsAppLogRecentSearch("proj1", "userA", "ZETA");
    assert.deepEqual(after, ["mid", "acme"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), ["mid", "acme"], "must actually be persisted, not just returned");
  });
});

test("removeWhatsAppLogRecentSearch is a no-op when the query isn't in the list", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    const after = removeWhatsAppLogRecentSearch("proj1", "userA", "nonexistent");
    assert.deepEqual(after, ["acme"]);
  });
});

test("getWhatsAppLogRecentSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.whatsappLogRecentSearches.proj1:userA", "not valid json{{{");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), []);

    localStorage.setItem("forge.whatsappLogRecentSearches.proj1:userA", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), []);

    localStorage.setItem("forge.whatsappLogRecentSearches.proj1:userA", JSON.stringify(["acme", 42, null, "zeta"]));
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), ["acme", "zeta"], "non-string entries must be dropped, not crash the whole read");
  });
});

test("purgeWhatsAppLogRecentSearchesForProject removes every collaborator account's own list for that project, and never touches another project's entries", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "userA", "acme");
    addWhatsAppLogRecentSearch("proj1", "userB", "other-user-query");
    addWhatsAppLogRecentSearch("proj2", "userA", "zeta");
    purgeWhatsAppLogRecentSearchesForProject("proj1");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userA"), [], "userA's own proj1 list must be gone");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1", "userB"), [], "userB's own proj1 list must be gone too, not just userA's");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj2", "userA"), ["zeta"], "a completely different project's own entries must be untouched");
  });
});
