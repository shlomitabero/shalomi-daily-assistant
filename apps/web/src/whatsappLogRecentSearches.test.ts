import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addWhatsAppLogRecentSearch,
  clearWhatsAppLogRecentSearches,
  getWhatsAppLogRecentSearches,
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
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), []);
  });
});

test("addWhatsAppLogRecentSearch adds a query to the front, and a fresh getWhatsAppLogRecentSearches call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addWhatsAppLogRecentSearch("proj1", "failed");
    assert.deepEqual(after, ["failed"]);
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), ["failed"], "must actually be written to storage, not just returned");
  });
});

test("addWhatsAppLogRecentSearch puts the newest query first, pushing older ones back", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "acme");
    addWhatsAppLogRecentSearch("proj1", "zeta");
    const after = addWhatsAppLogRecentSearch("proj1", "mid");
    assert.deepEqual(after, ["mid", "zeta", "acme"]);
  });
});

test("addWhatsAppLogRecentSearch moves an already-present query (case-insensitively) to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "Acme");
    addWhatsAppLogRecentSearch("proj1", "zeta");
    const after = addWhatsAppLogRecentSearch("proj1", "acme");
    assert.deepEqual(after, ["acme", "zeta"], "the newer casing wins, and there must be only one entry for it");
  });
});

test("addWhatsAppLogRecentSearch caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) {
      addWhatsAppLogRecentSearch("proj1", q);
    }
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), ["six", "five", "four", "three", "two"]);
  });
});

test("addWhatsAppLogRecentSearch ignores an empty or whitespace-only query, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "acme");
    const after = addWhatsAppLogRecentSearch("proj1", "   ");
    assert.deepEqual(after, ["acme"]);
  });
});

test("recent log searches are scoped per project -- searching one project's log never affects a different project's own list", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "failed");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj2"), [], "a different project must not see proj1's recent searches");
  });
});

test("clearWhatsAppLogRecentSearches wipes the whole list", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "acme");
    addWhatsAppLogRecentSearch("proj1", "zeta");
    clearWhatsAppLogRecentSearches("proj1");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), []);
  });
});

test("removeWhatsAppLogRecentSearch drops only the matching query (case-insensitively), leaving the rest -- and a fresh getWhatsAppLogRecentSearches call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "acme");
    addWhatsAppLogRecentSearch("proj1", "zeta");
    addWhatsAppLogRecentSearch("proj1", "mid");
    const after = removeWhatsAppLogRecentSearch("proj1", "ZETA");
    assert.deepEqual(after, ["mid", "acme"], "must remove case-insensitively and leave the other two, in order");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), ["mid", "acme"], "must actually be persisted, not just returned");
  });
});

test("removeWhatsAppLogRecentSearch is a no-op when the query isn't in the list", async () => {
  await withJsdom(() => {
    addWhatsAppLogRecentSearch("proj1", "acme");
    const after = removeWhatsAppLogRecentSearch("proj1", "nonexistent");
    assert.deepEqual(after, ["acme"]);
  });
});

test("getWhatsAppLogRecentSearches tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.whatsappLogRecentSearches.proj1", "not valid json{{{");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), []);

    localStorage.setItem("forge.whatsappLogRecentSearches.proj1", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), []);

    localStorage.setItem("forge.whatsappLogRecentSearches.proj1", JSON.stringify(["acme", 42, null, "zeta"]));
    assert.deepEqual(getWhatsAppLogRecentSearches("proj1"), ["acme", "zeta"], "non-string entries must be dropped, not crash the whole read");
  });
});
