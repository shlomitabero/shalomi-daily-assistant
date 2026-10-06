import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getEntityTabOrder, setEntityTabOrder } from "./entityTabOrder.js";

/** Same full-jsdom-swap technique columnOrder.test.ts/columnWidths.test.ts/columnVisibility.test.ts already use: real localStorage, not a mock. */
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

test("getEntityTabOrder returns an empty array when tabs have never been reordered", async () => {
  await withJsdom(() => {
    assert.deepEqual(getEntityTabOrder("proj1"), []);
  });
});

test("setEntityTabOrder persists a real order, and a fresh getEntityTabOrder call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setEntityTabOrder("proj1", ["Task", "Deal", "Contact"]);
    assert.deepEqual(after, ["Task", "Deal", "Contact"]);
    assert.deepEqual(getEntityTabOrder("proj1"), ["Task", "Deal", "Contact"], "must actually be written to storage, not just returned");
  });
});

test("entity-tab order is scoped per project only -- reordering one project's tabs never affects another project's", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", ["Task", "Deal"]);
    assert.deepEqual(getEntityTabOrder("proj2"), [], "a different project must not see proj1's reordered tabs");
  });
});

test("getEntityTabOrder falls back to an empty array for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.entityTabOrder", "not real json{{{");
    assert.deepEqual(getEntityTabOrder("proj1"), []);
  });
});
