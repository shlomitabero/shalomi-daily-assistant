import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getWhatsAppLogFilter, setWhatsAppLogFilter } from "./whatsappLogFilter.js";

/** Same full-jsdom-swap technique used by viewModePreference.test.ts: real localStorage, not a mock. */
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

test("getWhatsAppLogFilter returns 'all' when no filter has ever been chosen", async () => {
  await withJsdom(() => {
    assert.equal(getWhatsAppLogFilter("proj1"), "all");
  });
});

test("setWhatsAppLogFilter persists a real choice, and a fresh getWhatsAppLogFilter call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setWhatsAppLogFilter("proj1", "failed");
    assert.equal(after, "failed");
    assert.equal(getWhatsAppLogFilter("proj1"), "failed", "must actually be written to storage, not just returned");
  });
});

test("setWhatsAppLogFilter('in') and ('out') also round trip", async () => {
  await withJsdom(() => {
    setWhatsAppLogFilter("proj1", "in");
    assert.equal(getWhatsAppLogFilter("proj1"), "in");
    setWhatsAppLogFilter("proj1", "out");
    assert.equal(getWhatsAppLogFilter("proj1"), "out");
  });
});

test("setWhatsAppLogFilter back to 'all' clears the persisted entry instead of storing it", async () => {
  await withJsdom(() => {
    setWhatsAppLogFilter("proj1", "failed");
    setWhatsAppLogFilter("proj1", "all");
    assert.equal(getWhatsAppLogFilter("proj1"), "all");
    assert.equal(localStorage.getItem("forge.whatsappLogFilter.proj1"), null, "the default 'all' choice should not bloat storage with an explicit entry");
  });
});

test("the filter is scoped per project -- setting one project's filter never affects a different project", async () => {
  await withJsdom(() => {
    setWhatsAppLogFilter("proj1", "failed");
    assert.equal(getWhatsAppLogFilter("proj2"), "all", "a different project must not see proj1's filter choice");
  });
});

test("getWhatsAppLogFilter falls back to 'all' for foreign/corrupted localStorage content, instead of returning it", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.whatsappLogFilter.proj1", "sideways");
    assert.equal(getWhatsAppLogFilter("proj1"), "all");
  });
});
