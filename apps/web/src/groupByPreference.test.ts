import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getGroupByField, setGroupByField } from "./groupByPreference.js";

/** Same full-jsdom-swap technique used by columnOrder.test.ts/columnWidths.test.ts: real localStorage, not a mock. */
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

test("getGroupByField returns '' when no group-by choice has ever been made", async () => {
  await withJsdom(() => {
    assert.equal(getGroupByField("proj1", "Deal"), "");
  });
});

test("setGroupByField persists a real choice, and a fresh getGroupByField call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setGroupByField("proj1", "Deal", "status");
    assert.equal(after, "status");
    assert.equal(getGroupByField("proj1", "Deal"), "status", "must actually be written to storage, not just returned");
  });
});

test("setGroupByField with '' clears a previously persisted choice back to 'no grouping'", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "Deal", "status");
    setGroupByField("proj1", "Deal", "");
    assert.equal(getGroupByField("proj1", "Deal"), "", "clearing must actually remove the stored entry, not just return ''");
  });
});

test("group-by field is scoped per project+entity -- setting one project's entity never affects a same-named entity in a different project or a different entity in the same project", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "Deal", "status");
    assert.equal(getGroupByField("proj2", "Deal"), "", "a different project must not see proj1's group-by choice");
    assert.equal(getGroupByField("proj1", "Customer"), "", "a different entity in the same project must not see Deal's group-by choice");
  });
});

test("getGroupByField falls back to '' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.groupByField", "not real json{{{");
    assert.equal(getGroupByField("proj1", "Deal"), "");
  });
});

test("getGroupByField ignores a non-string value under its key (foreign data written by something else) instead of returning it", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.groupByField", JSON.stringify({ "proj1:Deal": 42 }));
    assert.equal(getGroupByField("proj1", "Deal"), "");
  });
});
