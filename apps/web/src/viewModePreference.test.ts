import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getViewMode, removeViewModeForUserProject, setViewMode } from "./viewModePreference.js";

/** Same full-jsdom-swap technique used by groupByPreference.test.ts: real localStorage, not a mock. */
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

test("getViewMode returns 'table' when no view choice has ever been made", async () => {
  await withJsdom(() => {
    assert.equal(getViewMode("proj1", "Deal", "userA"), "table");
  });
});

test("setViewMode persists a real choice, and a fresh getViewMode call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setViewMode("proj1", "Deal", "userA", "board");
    assert.equal(after, "board");
    assert.equal(getViewMode("proj1", "Deal", "userA"), "board", "must actually be written to storage, not just returned");
  });
});

test("setViewMode('calendar') also round trips", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Event", "userA", "calendar");
    assert.equal(getViewMode("proj1", "Event", "userA"), "calendar");
  });
});

test("setViewMode back to 'table' clears the persisted entry instead of storing it", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Deal", "userA", "board");
    setViewMode("proj1", "Deal", "userA", "table");
    assert.equal(getViewMode("proj1", "Deal", "userA"), "table");
    const raw = localStorage.getItem("forge.viewMode");
    assert.equal(raw, "{}", "the default 'table' choice should not bloat storage with an explicit entry");
  });
});

test("view mode is scoped per project+entity -- setting one project's entity never affects a same-named entity in a different project or a different entity in the same project", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Deal", "userA", "board");
    assert.equal(getViewMode("proj2", "Deal", "userA"), "table", "a different project must not see proj1's view choice");
    assert.equal(getViewMode("proj1", "Customer", "userA"), "table", "a different entity in the same project must not see Deal's view choice");
  });
});

/**
 * Round 1064: the whole point of this round's fix. Before it, the storage
 * key was projectId:entityName alone -- two different collaborator
 * accounts sharing the SAME project on the SAME browser silently saw each
 * other's own chosen Table/Board/Calendar view.
 */
test("view mode is also kept per-user -- two different accounts on the SAME project+entity never see each other's own chosen view", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Deal", "userA", "board");
    setViewMode("proj1", "Deal", "userB", "calendar");
    assert.equal(getViewMode("proj1", "Deal", "userA"), "board");
    assert.equal(getViewMode("proj1", "Deal", "userB"), "calendar", "userB must never see userA's own chosen view");
  });
});

test("getViewMode falls back to 'table' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.viewMode", "not real json{{{");
    assert.equal(getViewMode("proj1", "Deal", "userA"), "table");
  });
});

test("getViewMode ignores a value that isn't a real view mode (foreign data written by something else) instead of returning it", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.viewMode", JSON.stringify({ "proj1:Deal:userA": "kanban" }));
    assert.equal(getViewMode("proj1", "Deal", "userA"), "table");
  });
});

test("removeViewModeForUserProject removes only this one user's own Table/Board/Calendar choice across every entity of one project, leaving every other collaborator's own choice for the SAME project (and this user's own choice for another project) untouched", async () => {
  await withJsdom(() => {
    setViewMode("proj1", "Deal", "userA", "board");
    setViewMode("proj1", "Customer", "userA", "calendar");
    setViewMode("proj1", "Deal", "userB", "calendar");
    setViewMode("proj2", "Deal", "userA", "board");

    removeViewModeForUserProject("proj1", "userA");

    assert.equal(getViewMode("proj1", "Deal", "userA"), "table", "userA's own Deal choice for the left project must be cleared");
    assert.equal(getViewMode("proj1", "Customer", "userA"), "table", "userA's own Customer choice for the SAME left project must also be cleared, not just one entity");
    assert.equal(getViewMode("proj1", "Deal", "userB"), "calendar", "userB's own choice for the SAME still-shared project must survive");
    assert.equal(getViewMode("proj2", "Deal", "userA"), "board", "userA's own choice for an UNRELATED project must survive untouched");
  });
});

test("removeViewModeForUserProject is a no-op, not an error, when this user never chose a view mode in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeViewModeForUserProject("proj1", "userA"));
    assert.equal(getViewMode("proj1", "Deal", "userA"), "table");
  });
});
