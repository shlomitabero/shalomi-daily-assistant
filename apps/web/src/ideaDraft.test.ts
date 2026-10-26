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
    assert.equal(getIdeaDraft("userA"), "");
  });
});

test("saveIdeaDraft persists the text, and a fresh getIdeaDraft call sees it -- a real round trip, not just an in-memory value", async () => {
  await withJsdom(() => {
    saveIdeaDraft("userA", "A CRM for a flower shop");
    assert.equal(getIdeaDraft("userA"), "A CRM for a flower shop", "must actually be written to storage, not just held in the caller's own variable");
  });
});

test("saveIdeaDraft with blank/whitespace-only text clears the stored draft instead of persisting empty text forever", async () => {
  await withJsdom(() => {
    saveIdeaDraft("userA", "something real");
    assert.equal(getIdeaDraft("userA"), "something real");

    saveIdeaDraft("userA", "   ");
    assert.equal(getIdeaDraft("userA"), "", "whitespace-only text must clear the draft, not persist as a stored blank string");
  });
});

test("clearIdeaDraft removes a previously saved draft", async () => {
  await withJsdom(() => {
    saveIdeaDraft("userA", "A CRM for a flower shop");
    clearIdeaDraft("userA");
    assert.equal(getIdeaDraft("userA"), "");
  });
});

test("saveIdeaDraft overwrites a previously saved draft, not appends to it", async () => {
  await withJsdom(() => {
    saveIdeaDraft("userA", "first idea");
    saveIdeaDraft("userA", "second, completely different idea");
    assert.equal(getIdeaDraft("userA"), "second, completely different idea");
  });
});

/**
 * Round 1044: this store used to be one single flat key with no user
 * dimension at all -- a half-typed, thoughtfully-written business
 * description left behind on a shared/public computer (closing the tab
 * without logging out, the one way this app's own in-page logout/
 * account-deletion/session-expiry clears never cover) would otherwise
 * show up pre-filled in a completely different account's own idea
 * textarea on that same browser's next fresh page load. Mirrors
 * pinnedProjects.test.ts's own identical cross-account isolation test.
 */
test("getIdeaDraft/saveIdeaDraft/clearIdeaDraft are scoped per user, so one account's draft never leaks into another's on the same browser", async () => {
  await withJsdom(() => {
    saveIdeaDraft("userA", "userA's own private business idea");
    assert.equal(getIdeaDraft("userB"), "", "userB, a different account on the same browser, must not see userA's draft just because userA typed one");

    saveIdeaDraft("userB", "userB's own completely different idea");
    assert.equal(getIdeaDraft("userA"), "userA's own private business idea", "userB saving their own draft must never overwrite or clear userA's own already-saved draft");
    assert.equal(getIdeaDraft("userB"), "userB's own completely different idea");

    clearIdeaDraft("userA");
    assert.equal(getIdeaDraft("userA"), "", "clearing userA's own draft must actually clear it");
    assert.equal(getIdeaDraft("userB"), "userB's own completely different idea", "clearing userA's own draft must never touch userB's own draft");
  });
});
