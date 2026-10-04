import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getProjectStatusFilter, setProjectStatusFilter } from "./projectStatusFilter.js";

/** Same full-jsdom-swap technique projectSortMode.test.ts/columnOrder.test.ts use: real localStorage, not a mock. */
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

test("getProjectStatusFilter defaults to 'all' when nothing has ever been set", async () => {
  await withJsdom(() => {
    assert.equal(getProjectStatusFilter(), "all");
  });
});

test("setProjectStatusFilter persists 'built', and a fresh getProjectStatusFilter call sees it -- a real round trip, not just the in-memory value", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("built");
    assert.equal(getProjectStatusFilter(), "built");
  });
});

test("setProjectStatusFilter persists 'draft' too", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("draft");
    assert.equal(getProjectStatusFilter(), "draft");
  });
});

test("setProjectStatusFilter('all') persists back to 'all' after having been 'built'", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("built");
    setProjectStatusFilter("all");
    assert.equal(getProjectStatusFilter(), "all");
  });
});

test("getProjectStatusFilter falls back to 'all' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.projectStatusFilter", "not-a-real-status");
    assert.equal(getProjectStatusFilter(), "all");
  });
});
