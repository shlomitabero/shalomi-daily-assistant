import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { applyColumnOrder, getColumnOrder, reorderColumns, setColumnOrder } from "./columnOrder.js";

/** Same full-jsdom-swap technique used by columnWidths.test.ts/columnVisibility.test.ts: real localStorage, not a mock. */
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

test("getColumnOrder returns an empty array when columns have never been reordered", async () => {
  await withJsdom(() => {
    assert.deepEqual(getColumnOrder("proj1", "Customer"), []);
  });
});

test("setColumnOrder persists a real order, and a fresh getColumnOrder call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setColumnOrder("proj1", "Customer", ["email", "name", "phone"]);
    assert.deepEqual(after, ["email", "name", "phone"]);
    assert.deepEqual(getColumnOrder("proj1", "Customer"), ["email", "name", "phone"], "must actually be written to storage, not just returned");
  });
});

test("column order is scoped per project+entity -- reordering one project's entity never affects a same-named entity in a different project", async () => {
  await withJsdom(() => {
    setColumnOrder("proj1", "Customer", ["email", "name"]);
    assert.deepEqual(getColumnOrder("proj2", "Customer"), [], "a different project must not see proj1's reordered columns");
    assert.deepEqual(getColumnOrder("proj1", "Order"), [], "a different entity in the same project must not see Customer's reordered columns");
  });
});

test("getColumnOrder falls back to an empty array for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.columnOrder", "not real json{{{");
    assert.deepEqual(getColumnOrder("proj1", "Customer"), []);
  });
});

const F = (name: string) => ({ name });

test("applyColumnOrder reorders known fields to match the persisted order", () => {
  const fields = [F("name"), F("email"), F("phone")];
  const result = applyColumnOrder(fields, ["phone", "name", "email"]);
  assert.deepEqual(result.map((f) => f.name), ["phone", "name", "email"]);
});

test("applyColumnOrder appends a field the persisted order doesn't mention (newly added since the order was saved) at the end, in the entity's own original order", () => {
  const fields = [F("name"), F("email"), F("phone")];
  const result = applyColumnOrder(fields, ["email", "name"]);
  assert.deepEqual(result.map((f) => f.name), ["email", "name", "phone"]);
});

test("applyColumnOrder drops a persisted name the entity no longer has (a removed field), without crashing or leaving a hole", () => {
  const fields = [F("name"), F("email")];
  const result = applyColumnOrder(fields, ["ghostField", "email", "name"]);
  assert.deepEqual(result.map((f) => f.name), ["email", "name"]);
});

test("applyColumnOrder with an empty persisted order falls back to the entity's own natural field order", () => {
  const fields = [F("name"), F("email"), F("phone")];
  assert.deepEqual(applyColumnOrder(fields, []).map((f) => f.name), ["name", "email", "phone"]);
});

test("reorderColumns moves the source field to just before the target field", () => {
  assert.deepEqual(reorderColumns(["name", "email", "phone"], "phone", "email"), ["name", "phone", "email"]);
  assert.deepEqual(reorderColumns(["name", "email", "phone"], "name", "phone"), ["email", "name", "phone"]);
});

test("reorderColumns dropping a column onto itself is a real no-op", () => {
  const order = ["name", "email", "phone"];
  assert.equal(reorderColumns(order, "email", "email"), order);
});

test("reorderColumns is a no-op if either name isn't actually in the order", () => {
  const order = ["name", "email", "phone"];
  assert.equal(reorderColumns(order, "ghost", "email"), order);
  assert.equal(reorderColumns(order, "name", "ghost"), order);
});
