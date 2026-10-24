import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { countUnreadWhatsAppMessages, getWhatsAppLastSeen, setWhatsAppLastSeen, type WhatsAppLastSeen } from "./whatsappUnread.js";

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

/** Derives a distinct, strictly-increasing timestamp from the numeric suffix of `id` (m1 < m2 < m5 < ...), matching every existing test's own id-ordering convention, so callers don't need to spell out a real timestamp for every single message. */
function timeFor(id: string): string {
  const minute = Number(id.replace(/\D/g, "")) || 0;
  return new Date(2024, 0, 1, 0, minute).toISOString();
}

function msg(id: string, direction: "in" | "out", createdAt: string = timeFor(id)): WhatsAppMessageLogEntry {
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
    createdAt,
  };
}

function seen(id: string, createdAt: string = timeFor(id)): WhatsAppLastSeen {
  return { id, createdAt };
}

test("getWhatsAppLastSeen returns null when nothing has ever been marked seen", async () => {
  await withJsdom(() => {
    assert.equal(getWhatsAppLastSeen("proj1"), null);
  });
});

test("setWhatsAppLastSeen persists a real choice, and a fresh getWhatsAppLastSeen call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    setWhatsAppLastSeen("proj1", seen("m5"));
    assert.deepEqual(getWhatsAppLastSeen("proj1"), seen("m5"), "must actually be written to storage");
  });
});

test("setWhatsAppLastSeen is scoped per project -- one project's marker never leaks into another's", async () => {
  await withJsdom(() => {
    setWhatsAppLastSeen("proj1", seen("m5"));
    setWhatsAppLastSeen("proj2", seen("m9"));
    assert.deepEqual(getWhatsAppLastSeen("proj1"), seen("m5"));
    assert.deepEqual(getWhatsAppLastSeen("proj2"), seen("m9"));
  });
});

/**
 * Round 940: a pre-round-940 marker is still a bare id string in
 * localStorage, not the new JSON {id, createdAt} shape -- JSON.parse on
 * it throws, and the old bare id is never usable as a fallback (it has
 * no timestamp to compare against). Confirms this degrades safely to
 * null rather than crashing or returning garbage; the owner's very next
 * real panel-open re-seeds a fresh, correct marker regardless.
 */
test("getWhatsAppLastSeen returns null (not a crash) for a pre-round-940 marker still stored as a bare id string", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.whatsappLastSeenId.proj1", "m5");
    assert.equal(getWhatsAppLastSeen("proj1"), null);
  });
});

test("countUnreadWhatsAppMessages returns 0 when lastSeen is null (never connected/loaded before), instead of treating everything as unread", () => {
  const messages = [msg("m3", "in"), msg("m2", "in"), msg("m1", "in")];
  assert.equal(countUnreadWhatsAppMessages(messages, null), 0);
});

test("countUnreadWhatsAppMessages counts only the inbound messages newer than lastSeen, stopping at (and excluding) it", () => {
  const messages = [msg("m4", "in"), msg("m3", "out"), msg("m2", "in"), msg("m1", "in")];
  // lastSeen "m1" -- m4, m3, m2 are all newer; only m4 and m2 are inbound.
  assert.equal(countUnreadWhatsAppMessages(messages, seen("m1")), 2);
});

test("countUnreadWhatsAppMessages returns 0 once lastSeen is the newest message -- nothing new has arrived", () => {
  const messages = [msg("m3", "in"), msg("m2", "in"), msg("m1", "in")];
  assert.equal(countUnreadWhatsAppMessages(messages, seen("m3")), 0);
});

test("countUnreadWhatsAppMessages never counts an outbound message the project itself sent as unread", () => {
  const messages = [msg("m2", "out"), msg("m1", "in")];
  assert.equal(countUnreadWhatsAppMessages(messages, seen("m1")), 0);
});

test("countUnreadWhatsAppMessages caps the count at what's in this page when lastSeen's id isn't found and its own timestamp is older than everything shown (genuine pagination overflow)", () => {
  const messages = [msg("m5", "in"), msg("m4", "in"), msg("m3", "in")];
  // lastSeen "m0" never appears, and its own timestamp (older than m3,
  // the oldest message on this page) means the real gap is genuinely
  // further back than this one page reaches -- every message shown here
  // counts, capped at the page, exactly like before this round.
  assert.equal(countUnreadWhatsAppMessages(messages, seen("m0")), 3);
});

/**
 * Round 940: the exact bug this round fixes. lastSeen tracked "m3" (the
 * newest message at the time), but it was then deleted -- by this same
 * owner from a different device, or by any other collaborator (WhatsApp
 * messages are per-project, not per-user) -- with no new message having
 * arrived since. The next fetched page no longer contains "m3" at all,
 * but DOES still reach back far enough in time to cover it (m2 and m1
 * are both older than m3 ever was). The old id-only walk couldn't tell
 * this apart from genuine overflow and counted the whole page (2) as
 * phantom unread; this must correctly read 0, since nothing has
 * actually arrived since the owner last looked.
 */
test("countUnreadWhatsAppMessages returns 0, not the whole page, when lastSeen's own tracked message was deleted and nothing genuinely new has arrived since", () => {
  const messages = [msg("m2", "in"), msg("m1", "in")]; // "m3" (the deleted, previously-newest message) is gone from this page
  assert.equal(countUnreadWhatsAppMessages(messages, seen("m3")), 0);
});

/**
 * Sibling of the test above: lastSeen's own tracked message was deleted
 * the exact same way, but real new messages DID arrive since -- those
 * must still be counted correctly, not swallowed by the same fix that
 * stops the phantom-unread case.
 */
test("countUnreadWhatsAppMessages still counts real new messages correctly when lastSeen's own tracked message was deleted, but genuinely new ones arrived since", () => {
  const messages = [msg("m5", "in"), msg("m4", "in"), msg("m2", "in"), msg("m1", "in")]; // "m3" (the deleted, previously-newest message at seen-time) is gone
  assert.equal(countUnreadWhatsAppMessages(messages, seen("m3")), 2, "m5 and m4 are genuinely newer than the deleted m3 and must still count as unread");
});
