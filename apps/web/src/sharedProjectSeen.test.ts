import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getSeenSharedProjectIds, markSharedProjectSeen, removeSeenSharedProject } from "./sharedProjectSeen.js";

/** Same real-localStorage-via-jsdom-swap technique as pinnedProjects.test.ts. */
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

test("getSeenSharedProjectIds returns an empty set when nothing has ever been acknowledged", async () => {
  await withJsdom(() => {
    assert.deepEqual(getSeenSharedProjectIds(), new Set());
  });
});

test("markSharedProjectSeen records a project, and a fresh getSeenSharedProjectIds call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = markSharedProjectSeen("proj1");
    assert.deepEqual(after, new Set(["proj1"]));
    assert.deepEqual(getSeenSharedProjectIds(), new Set(["proj1"]), "must actually be written to storage, not just returned");
  });
});

test("markSharedProjectSeen is idempotent -- marking an already-seen project again doesn't duplicate its entry", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("proj1");
    const after = markSharedProjectSeen("proj1");
    assert.deepEqual(after, new Set(["proj1"]));
  });
});

test("removeSeenSharedProject removes one project's entry while leaving every other project's own entry untouched", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("proj1");
    markSharedProjectSeen("proj2");
    const after = removeSeenSharedProject("proj1");
    assert.deepEqual(after, new Set(["proj2"]));
    assert.deepEqual(getSeenSharedProjectIds(), new Set(["proj2"]));
  });
});

test("removeSeenSharedProject is a no-op when the project was never marked seen", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("proj2");
    const after = removeSeenSharedProject("proj1");
    assert.deepEqual(after, new Set(["proj2"]));
  });
});

test("getSeenSharedProjectIds tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.seenSharedProjects", "not valid json{{{");
    assert.deepEqual(getSeenSharedProjectIds(), new Set());

    localStorage.setItem("forge.seenSharedProjects", JSON.stringify({ not: "an array" }));
    assert.deepEqual(getSeenSharedProjectIds(), new Set());

    localStorage.setItem("forge.seenSharedProjects", JSON.stringify(["proj1", 42, null, "proj2"]));
    assert.deepEqual(getSeenSharedProjectIds(), new Set(["proj1", "proj2"]), "non-string entries must be dropped, not crash the whole read");
  });
});
