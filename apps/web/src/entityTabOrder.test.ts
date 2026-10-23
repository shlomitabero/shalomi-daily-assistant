import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getEntityTabOrder, setEntityTabOrder, purgeEntityNameFromTabOrder } from "./entityTabOrder.js";

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

/**
 * Round 865: a refine that drops one entity from a project never removed
 * that entity's name from this project's own persisted tab order -- the
 * one sibling store entityPreferenceCleanup.ts's round-853 sweep missed,
 * since this store is keyed by projectId alone rather than
 * `${projectId}:${entityName}`. Without this, a later refine that
 * reintroduces an entity with the SAME name would silently inherit the
 * stale position.
 */
test("purgeEntityNameFromTabOrder removes exactly one entity name from a project's tab order, leaving the rest of that order and a sibling project's order untouched", async () => {
  await withJsdom(() => {
    setEntityTabOrder("proj1", ["Task", "Deal", "Contact"]);
    setEntityTabOrder("proj2", ["Deal", "Task"]);

    purgeEntityNameFromTabOrder("proj1", "Deal");

    assert.deepEqual(getEntityTabOrder("proj1"), ["Task", "Contact"], "the dropped entity's name must be removed, the rest of the order preserved");
    assert.deepEqual(getEntityTabOrder("proj2"), ["Deal", "Task"], "an unrelated project's own order, including its own \"Deal\" entry, must survive untouched");
  });
});

test("purgeEntityNameFromTabOrder is a no-op, not an error, when the project was never reordered or the name isn't present", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => purgeEntityNameFromTabOrder("proj1", "Deal"));
    assert.deepEqual(getEntityTabOrder("proj1"), []);

    setEntityTabOrder("proj1", ["Task"]);
    purgeEntityNameFromTabOrder("proj1", "Deal");
    assert.deepEqual(getEntityTabOrder("proj1"), ["Task"]);
  });
});
