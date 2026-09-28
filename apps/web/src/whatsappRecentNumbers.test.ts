import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  addRecentWhatsAppNumber,
  clearRecentWhatsAppNumbers,
  getRecentWhatsAppNumbers,
  removeRecentWhatsAppNumber,
} from "./whatsappRecentNumbers.js";

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

test("getRecentWhatsAppNumbers returns an empty list when nothing has ever been sent to", async () => {
  await withJsdom(() => {
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), []);
  });
});

test("addRecentWhatsAppNumber adds a number to the front, and a fresh getRecentWhatsAppNumbers call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = addRecentWhatsAppNumber("proj1", "972501234567");
    assert.deepEqual(after, ["972501234567"]);
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), ["972501234567"], "must actually be written to storage, not just returned");
  });
});

test("addRecentWhatsAppNumber puts the newest number first, pushing older ones back", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    addRecentWhatsAppNumber("proj1", "222");
    const after = addRecentWhatsAppNumber("proj1", "333");
    assert.deepEqual(after, ["333", "222", "111"]);
  });
});

test("addRecentWhatsAppNumber moves an already-present number to the front instead of duplicating it", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    addRecentWhatsAppNumber("proj1", "222");
    const after = addRecentWhatsAppNumber("proj1", "111");
    assert.deepEqual(after, ["111", "222"], "there must be only one entry for the repeated number");
  });
});

test("addRecentWhatsAppNumber caps the list at 5 entries, dropping the oldest", async () => {
  await withJsdom(() => {
    for (const n of ["1", "2", "3", "4", "5", "6"]) {
      addRecentWhatsAppNumber("proj1", n);
    }
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), ["6", "5", "4", "3", "2"]);
  });
});

test("addRecentWhatsAppNumber ignores an empty or whitespace-only number, leaving the list unchanged", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    const after = addRecentWhatsAppNumber("proj1", "   ");
    assert.deepEqual(after, ["111"]);
  });
});

test("recent WhatsApp numbers are kept per-project -- one project's numbers never leak into another's list", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    addRecentWhatsAppNumber("proj2", "222");
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), ["111"]);
    assert.deepEqual(getRecentWhatsAppNumbers("proj2"), ["222"]);
  });
});

test("clearRecentWhatsAppNumbers wipes this project's list but never touches another project's", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    addRecentWhatsAppNumber("proj2", "222");
    clearRecentWhatsAppNumbers("proj1");
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), []);
    assert.deepEqual(getRecentWhatsAppNumbers("proj2"), ["222"]);
  });
});

test("removeRecentWhatsAppNumber drops only the matching number, leaving the rest -- and a fresh getRecentWhatsAppNumbers call sees it gone, not just the return value", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    addRecentWhatsAppNumber("proj1", "222");
    addRecentWhatsAppNumber("proj1", "333");
    const after = removeRecentWhatsAppNumber("proj1", "222");
    assert.deepEqual(after, ["333", "111"], "must remove the matching number and leave the other two, in order");
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), ["333", "111"], "must actually be persisted, not just returned");
  });
});

test("removeRecentWhatsAppNumber is a no-op when the number isn't in the list, and never touches another project's list", async () => {
  await withJsdom(() => {
    addRecentWhatsAppNumber("proj1", "111");
    addRecentWhatsAppNumber("proj2", "222");
    const after = removeRecentWhatsAppNumber("proj1", "999");
    assert.deepEqual(after, ["111"]);
    assert.deepEqual(getRecentWhatsAppNumbers("proj2"), ["222"], "removing from proj1 must never affect proj2's own list");
  });
});

test("getRecentWhatsAppNumbers tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.whatsappRecentNumbers.proj1", "not valid json{{{");
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), []);

    localStorage.setItem("forge.whatsappRecentNumbers.proj1", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), []);

    localStorage.setItem("forge.whatsappRecentNumbers.proj1", JSON.stringify(["111", 42, null, "222"]));
    assert.deepEqual(getRecentWhatsAppNumbers("proj1"), ["111", "222"], "non-string entries must be dropped, not crash the whole read");
  });
});
