import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getPinnedIds, sortByPinned, togglePinned } from "./pinnedProjects.js";

/**
 * Same full-jsdom-swap technique used by ProjectNameEditor.test.ts and
 * friends: real localStorage, not a mock, so these tests prove the actual
 * persistence contract (survives being read back by a fresh call), not
 * just that some in-memory stand-in was called correctly.
 */
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

test("getPinnedIds returns an empty set when nothing has ever been pinned", async () => {
  await withJsdom(() => {
    assert.deepEqual(getPinnedIds(), new Set());
  });
});

test("togglePinned pins an unpinned project, and a fresh getPinnedIds call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = togglePinned("proj1");
    assert.deepEqual(after, new Set(["proj1"]));
    assert.deepEqual(getPinnedIds(), new Set(["proj1"]), "must actually be written to storage, not just returned");
  });
});

test("togglePinned unpins an already-pinned project", async () => {
  await withJsdom(() => {
    togglePinned("proj1");
    togglePinned("proj2");
    const after = togglePinned("proj1");
    assert.deepEqual(after, new Set(["proj2"]));
    assert.deepEqual(getPinnedIds(), new Set(["proj2"]));
  });
});

test("getPinnedIds tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.pinnedProjects", "not valid json{{{");
    assert.deepEqual(getPinnedIds(), new Set());

    localStorage.setItem("forge.pinnedProjects", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getPinnedIds(), new Set());

    localStorage.setItem("forge.pinnedProjects", JSON.stringify(["proj1", 42, null, "proj2"]));
    assert.deepEqual(getPinnedIds(), new Set(["proj1", "proj2"]), "non-string entries must be dropped, not crash the whole read");
  });
});

test("sortByPinned moves pinned projects to the front, keeping each group's own original relative order", () => {
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const pinned = new Set(["c", "a"]);
  const sorted = sortByPinned(projects, pinned);
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["a", "c", "b", "d"],
  );
});

test("sortByPinned returns projects unchanged (as a new array) when nothing is pinned", () => {
  const projects = [{ id: "a" }, { id: "b" }];
  const sorted = sortByPinned(projects, new Set());
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["a", "b"],
  );
});
