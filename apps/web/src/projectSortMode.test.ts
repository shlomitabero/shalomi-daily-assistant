import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getProjectSortMode, setProjectSortMode } from "./projectSortMode.js";

/** Same full-jsdom-swap technique pinnedProjects.test.ts/recentSearches.test.ts use: real localStorage, not a mock. */
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

test("getProjectSortMode defaults to 'recent' when nothing has ever been set", async () => {
  await withJsdom(() => {
    assert.equal(getProjectSortMode(), "recent");
  });
});

test("setProjectSortMode persists 'alphabetical', and a fresh getProjectSortMode call sees it -- a real round trip, not just the in-memory value", async () => {
  await withJsdom(() => {
    setProjectSortMode("alphabetical");
    assert.equal(getProjectSortMode(), "alphabetical");
  });
});

test("setProjectSortMode('recent') persists back to 'recent' after having been 'alphabetical'", async () => {
  await withJsdom(() => {
    setProjectSortMode("alphabetical");
    setProjectSortMode("recent");
    assert.equal(getProjectSortMode(), "recent");
  });
});

test("getProjectSortMode falls back to 'recent' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.projectSortMode", "not-a-real-mode");
    assert.equal(getProjectSortMode(), "recent");
  });
});
