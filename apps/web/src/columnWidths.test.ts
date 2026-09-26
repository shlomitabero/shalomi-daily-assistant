import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { computeResizedWidth, getColumnWidths, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, setColumnWidth } from "./columnWidths.js";

/** Same full-jsdom-swap technique used by columnVisibility.test.ts/pinnedProjects.test.ts: real localStorage, not a mock. */
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

test("getColumnWidths returns an empty record when no column has ever been resized", async () => {
  await withJsdom(() => {
    assert.deepEqual(getColumnWidths("proj1", "Customer"), {});
  });
});

test("setColumnWidth persists a field's width, and a fresh getColumnWidths call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setColumnWidth("proj1", "Customer", "name", 220);
    assert.deepEqual(after, { name: 220 });
    assert.deepEqual(getColumnWidths("proj1", "Customer"), { name: 220 }, "must actually be written to storage, not just returned");
  });
});

test("setColumnWidth keeps other already-resized fields' widths untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "name", 220);
    const after = setColumnWidth("proj1", "Customer", "email", 300);
    assert.deepEqual(after, { name: 220, email: 300 });
  });
});

test("column widths are scoped per project+entity -- resizing a field in one project's entity never affects a same-named field in a different project's same-named entity", async () => {
  await withJsdom(() => {
    setColumnWidth("proj1", "Customer", "name", 220);
    assert.deepEqual(getColumnWidths("proj2", "Customer"), {}, "a different project must not see proj1's resized columns");
    assert.deepEqual(getColumnWidths("proj1", "Order"), {}, "a different entity in the same project must not see Customer's resized columns");
  });
});

test("getColumnWidths falls back to an empty record for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.columnWidths", "not real json{{{");
    assert.deepEqual(getColumnWidths("proj1", "Customer"), {});
  });
});

test("computeResizedWidth adds the drag delta to the starting width in LTR", () => {
  assert.equal(computeResizedWidth(200, 40), 240);
  assert.equal(computeResizedWidth(200, -40), 160);
});

test("computeResizedWidth flips the delta's sign in RTL, so dragging the same direction narrows instead of widens", () => {
  assert.equal(computeResizedWidth(200, 40, "rtl"), 160);
  assert.equal(computeResizedWidth(200, -40, "rtl"), 240);
});

test("computeResizedWidth clamps to MIN_COLUMN_WIDTH, never producing an unreadably narrow column", () => {
  assert.equal(computeResizedWidth(70, -1000), MIN_COLUMN_WIDTH);
});

test("computeResizedWidth clamps to MAX_COLUMN_WIDTH, never producing a runaway-wide column", () => {
  assert.equal(computeResizedWidth(400, 1000), MAX_COLUMN_WIDTH);
});
