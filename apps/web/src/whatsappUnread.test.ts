import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { countUnreadWhatsAppMessages, getWhatsAppLastSeenId, setWhatsAppLastSeenId } from "./whatsappUnread.js";

/** Same full-jsdom-swap technique used by whatsappLogFilter.test.ts: real localStorage, not a mock. */
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

function msg(id: string, direction: "in" | "out"): WhatsAppMessageLogEntry {
  return {
    id,
    direction,
    fromNumber: direction === "in" ? "+1000" : "+2000",
    toNumber: direction === "in" ? "+2000" : "+1000",
    body: id,
    matchedLabel: null,
    matchedEntityName: null,
    matchedRecordId: null,
    status: direction === "in" ? "received" : "sent",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

test("getWhatsAppLastSeenId returns null when nothing has ever been marked seen", async () => {
  await withJsdom(() => {
    assert.equal(getWhatsAppLastSeenId("proj1"), null);
  });
});

test("setWhatsAppLastSeenId persists a real choice, and a fresh getWhatsAppLastSeenId call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    setWhatsAppLastSeenId("proj1", "m5");
    assert.equal(getWhatsAppLastSeenId("proj1"), "m5", "must actually be written to storage");
  });
});

test("setWhatsAppLastSeenId is scoped per project -- one project's marker never leaks into another's", async () => {
  await withJsdom(() => {
    setWhatsAppLastSeenId("proj1", "m5");
    setWhatsAppLastSeenId("proj2", "m9");
    assert.equal(getWhatsAppLastSeenId("proj1"), "m5");
    assert.equal(getWhatsAppLastSeenId("proj2"), "m9");
  });
});

test("countUnreadWhatsAppMessages returns 0 when lastSeenId is null (never connected/loaded before), instead of treating everything as unread", () => {
  const messages = [msg("m3", "in"), msg("m2", "in"), msg("m1", "in")];
  assert.equal(countUnreadWhatsAppMessages(messages, null), 0);
});

test("countUnreadWhatsAppMessages counts only the inbound messages newer than lastSeenId, stopping at (and excluding) it", () => {
  const messages = [msg("m4", "in"), msg("m3", "out"), msg("m2", "in"), msg("m1", "in")];
  // lastSeenId "m1" -- m4, m3, m2 are all newer; only m4 and m2 are inbound.
  assert.equal(countUnreadWhatsAppMessages(messages, "m1"), 2);
});

test("countUnreadWhatsAppMessages returns 0 once lastSeenId is the newest message -- nothing new has arrived", () => {
  const messages = [msg("m3", "in"), msg("m2", "in"), msg("m1", "in")];
  assert.equal(countUnreadWhatsAppMessages(messages, "m3"), 0);
});

test("countUnreadWhatsAppMessages never counts an outbound message the project itself sent as unread", () => {
  const messages = [msg("m2", "out"), msg("m1", "in")];
  assert.equal(countUnreadWhatsAppMessages(messages, "m1"), 0);
});

test("countUnreadWhatsAppMessages caps the count at what's in this page when lastSeenId isn't found in it at all, instead of guessing a larger number", () => {
  const messages = [msg("m5", "in"), msg("m4", "in"), msg("m3", "in")];
  // lastSeenId "m0" never appears -- every message here counts, capped at the page.
  assert.equal(countUnreadWhatsAppMessages(messages, "m0"), 3);
});
