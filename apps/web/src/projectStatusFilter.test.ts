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
    assert.equal(getProjectStatusFilter("userA"), "all");
  });
});

test("setProjectStatusFilter persists 'built', and a fresh getProjectStatusFilter call sees it -- a real round trip, not just the in-memory value", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("userA", "built");
    assert.equal(getProjectStatusFilter("userA"), "built");
  });
});

test("setProjectStatusFilter persists 'draft' too", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("userA", "draft");
    assert.equal(getProjectStatusFilter("userA"), "draft");
  });
});

test("setProjectStatusFilter('all') persists back to 'all' after having been 'built'", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("userA", "built");
    setProjectStatusFilter("userA", "all");
    assert.equal(getProjectStatusFilter("userA"), "all");
  });
});

/**
 * Round 1057: the whole point of this round's fix, and the more severe of
 * the pair -- before it, the storage key was one flat key shared by every
 * account on the browser, so a shared/public computer could leave one
 * account's own "Built"/"Draft" filter silently applied to the next
 * account's own "Your projects" list, with no visible indicator a filter
 * (not a real absence of projects) is the reason the list looks empty.
 */
test("status filter is kept per-user -- two different accounts on the SAME browser never see each other's own chosen filter", async () => {
  await withJsdom(() => {
    setProjectStatusFilter("userA", "built");
    setProjectStatusFilter("userB", "draft");
    assert.equal(getProjectStatusFilter("userA"), "built");
    assert.equal(getProjectStatusFilter("userB"), "draft", "userB must never see userA's own chosen filter");
  });
});

test("getProjectStatusFilter falls back to 'all' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.projectStatusFilter.userA", "not-a-real-status");
    assert.equal(getProjectStatusFilter("userA"), "all");
  });
});
