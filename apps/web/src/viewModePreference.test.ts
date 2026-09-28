import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getViewMode, setViewMode } from "./viewModePreference.js";

/** Same full-jsdom-swap technique used by groupByPreference.test.ts: real localStorage, not a mock. */
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

test("getViewMode returns 'table' when no view choice has ever been made", async () => {
  await withJsdom(() => {
    assert.equal(getViewMode("proj1", "Deal"), "table");
  });
});

test("setViewMode persists a real choice, and a fresh getViewMode call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setViewMode("proj1", "Deal", "board");
    assert.equal(after, "board");
    assert.equal(getViewMode("proj1", "Deal"), "board", "must actually be written to storage, not just returned");
  });
});

test("setViewMode('calendar') also round trips", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Event", "calendar");
    assert.equal(getViewMode("proj1", "Event"), "calendar");
  });
});

test("setViewMode back to 'table' clears the persisted entry instead of storing it", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Deal", "board");
    setViewMode("proj1", "Deal", "table");
    assert.equal(getViewMode("proj1", "Deal"), "table");
    const raw = localStorage.getItem("forge.viewMode");
    assert.equal(raw, "{}", "the default 'table' choice should not bloat storage with an explicit entry");
  });
});

test("view mode is scoped per project+entity -- setting one project's entity never affects a same-named entity in a different project or a different entity in the same project", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Deal", "board");
    assert.equal(getViewMode("proj2", "Deal"), "table", "a different project must not see proj1's view choice");
    assert.equal(getViewMode("proj1", "Customer"), "table", "a different entity in the same project must not see Deal's view choice");
  });
});

test("getViewMode falls back to 'table' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.viewMode", "not real json{{{");
    assert.equal(getViewMode("proj1", "Deal"), "table");
  });
});

test("getViewMode ignores a value that isn't a real view mode (foreign data written by something else) instead of returning it", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.viewMode", JSON.stringify({ "proj1:Deal": "kanban" }));
    assert.equal(getViewMode("proj1", "Deal"), "table");
  });
});
