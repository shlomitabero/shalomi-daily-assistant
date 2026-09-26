import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { clearIdeaDraft, getIdeaDraft, saveIdeaDraft } from "./ideaDraft.js";

/**
 * Same full-jsdom-swap technique used by pinnedProjects.test.ts and
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

test("getIdeaDraft returns an empty string when nothing has ever been saved", async () => {
  await withJsdom(() => {
    assert.equal(getIdeaDraft(), "");
  });
});

test("saveIdeaDraft persists the text, and a fresh getIdeaDraft call sees it -- a real round trip, not just an in-memory value", async () => {
  await withJsdom(() => {
    saveIdeaDraft("A CRM for a flower shop");
    assert.equal(getIdeaDraft(), "A CRM for a flower shop", "must actually be written to storage, not just held in the caller's own variable");
  });
});

test("saveIdeaDraft with blank/whitespace-only text clears the stored draft instead of persisting empty text forever", async () => {
  await withJsdom(() => {
    saveIdeaDraft("something real");
    assert.equal(getIdeaDraft(), "something real");

    saveIdeaDraft("   ");
    assert.equal(getIdeaDraft(), "", "whitespace-only text must clear the draft, not persist as a stored blank string");
  });
});

test("clearIdeaDraft removes a previously saved draft", async () => {
  await withJsdom(() => {
    saveIdeaDraft("A CRM for a flower shop");
    clearIdeaDraft();
    assert.equal(getIdeaDraft(), "");
  });
});

test("saveIdeaDraft overwrites a previously saved draft, not appends to it", async () => {
  await withJsdom(() => {
    saveIdeaDraft("first idea");
    saveIdeaDraft("second, completely different idea");
    assert.equal(getIdeaDraft(), "second, completely different idea");
  });
});
