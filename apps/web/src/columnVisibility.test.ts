import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";

/** Same full-jsdom-swap technique used by pinnedProjects.test.ts: real localStorage, not a mock, so these tests prove the actual persistence contract. */
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

test("getHiddenFields returns an empty set when nothing has ever been hidden", async () => {
  await withJsdom(() => {
    assert.deepEqual(getHiddenFields("proj1", "Customer"), new Set());
  });
});

test("toggleFieldVisibility hides a shown field, and a fresh getHiddenFields call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = toggleFieldVisibility("proj1", "Customer", "notes");
    assert.deepEqual(after, new Set(["notes"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer"), new Set(["notes"]), "must actually be written to storage, not just returned");
  });
});

test("toggleFieldVisibility re-shows an already-hidden field", async () => {
  await withJsdom(() => {
    toggleFieldVisibility("proj1", "Customer", "notes");
    toggleFieldVisibility("proj1", "Customer", "phone");
    const after = toggleFieldVisibility("proj1", "Customer", "notes");
    assert.deepEqual(after, new Set(["phone"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer"), new Set(["phone"]));
  });
});

test("hidden columns are scoped per project+entity -- hiding a field in one project's entity never hides a same-named field in a different project's same-named entity", async () => {
  await withJsdom(() => {
    toggleFieldVisibility("proj1", "Customer", "notes");
    assert.deepEqual(getHiddenFields("proj2", "Customer"), new Set(), "a different project must not see proj1's hidden columns");
    assert.deepEqual(getHiddenFields("proj1", "Order"), new Set(), "a different entity in the same project must not see Customer's hidden columns");
  });
});

test("getHiddenFields tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.hiddenColumns", "not valid json{{{");
    assert.deepEqual(getHiddenFields("proj1", "Customer"), new Set());

    localStorage.setItem("forge.hiddenColumns", JSON.stringify(["an", "array", "not", "an", "object"]));
    assert.deepEqual(getHiddenFields("proj1", "Customer"), new Set());

    localStorage.setItem(
      "forge.hiddenColumns",
      JSON.stringify({ "proj1:Customer": ["notes", 42, null, "phone"] }),
    );
    assert.deepEqual(
      getHiddenFields("proj1", "Customer"),
      new Set(["notes", "phone"]),
      "non-string entries must be dropped, not crash the whole read",
    );
  });
});
