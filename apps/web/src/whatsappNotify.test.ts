import assert from "node:assert/strict";
import { test } from "node:test";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { findNewInboundMessages, type LastNotifiedWhatsAppMessage } from "./whatsappNotify.js";

/** Derives a distinct, strictly-increasing timestamp from the numeric suffix of `id` (m1 < m2 < m5 < ...), mirroring whatsappUnread.test.ts's own identical convention -- so callers don't need to spell out a real timestamp for every single message, and round-1019's own createdAt-fallback tests below can rely on genuine chronological ordering. */
function timeFor(id: string): string {
  const minute = Number(id.replace(/\D/g, "")) || 0;
  return new Date(2024, 0, 1, 0, minute).toISOString();
}

function msg(overrides: Partial<WhatsAppMessageLogEntry> & { id: string }): WhatsAppMessageLogEntry {
  return {
    direction: "in",
    fromNumber: "972521112233",
    toNumber: "972501234567",
    body: "hello",
    matchedLabel: null,
    matchedEntityName: null,
    matchedRecordId: null,
    status: "received",
    createdAt: timeFor(overrides.id),
    ...overrides,
  };
}

/** Builds a LastNotifiedWhatsAppMessage baseline, mirroring whatsappUnread.test.ts's own seen() helper for the identical shape. */
function lastNotified(id: string, createdAt: string = timeFor(id)): LastNotifiedWhatsAppMessage {
  return { id, createdAt };
}

test("findNewInboundMessages returns null when lastNotified is null -- no baseline yet, never notify for pre-existing history", () => {
  const messages = [msg({ id: "m3" }), msg({ id: "m2" }), msg({ id: "m1" })];
  assert.equal(findNewInboundMessages(messages, null), null);
});

test("findNewInboundMessages returns null when nothing new has arrived since lastNotified", () => {
  const messages = [msg({ id: "m2" }), msg({ id: "m1" })];
  assert.equal(findNewInboundMessages(messages, lastNotified("m2")), null);
});

test("findNewInboundMessages returns the single new inbound message's own details", () => {
  const messages = [msg({ id: "m2", fromNumber: "972529998888", body: "Are you open tomorrow?" }), msg({ id: "m1" })];
  const result = findNewInboundMessages(messages, lastNotified("m1"));
  assert.deepEqual(result, { newestMessageId: "m2", count: 1, fromNumber: "972529998888", matchedLabel: null, snippet: "Are you open tomorrow?" });
});

test("findNewInboundMessages reports the correct count and the NEWEST message's own details when several arrived at once", () => {
  const messages = [
    msg({ id: "m4", fromNumber: "972521110000", body: "newest" }),
    msg({ id: "m3", body: "middle" }),
    msg({ id: "m2", body: "oldest-of-the-new-ones" }),
    msg({ id: "m1" }),
  ];
  const result = findNewInboundMessages(messages, lastNotified("m1"));
  assert.deepEqual(result, { newestMessageId: "m4", count: 3, fromNumber: "972521110000", matchedLabel: null, snippet: "newest" });
});

test("findNewInboundMessages never counts an outbound message the project itself sent as a new inbound message", () => {
  const messages = [msg({ id: "m3", direction: "out", body: "our reply" }), msg({ id: "m2", body: "the real new one" }), msg({ id: "m1" })];
  const result = findNewInboundMessages(messages, lastNotified("m1"));
  assert.deepEqual(result, { newestMessageId: "m2", count: 1, fromNumber: "972521112233", matchedLabel: null, snippet: "the real new one" });
});

test("findNewInboundMessages caps the count at what's in this page when lastNotified's id isn't found and its own timestamp is older than everything shown (genuine pagination overflow)", () => {
  const messages = [msg({ id: "m3" }), msg({ id: "m2" })];
  // A baseline id genuinely older than everything on this page (its own
  // timestamp is older than m2, the oldest message shown) means the real
  // gap is further back than this one page reaches -- every message
  // shown here is new, capped at the page, same as before this round.
  const result = findNewInboundMessages(messages, lastNotified("some-old-id-not-in-this-page", timeFor("m0")));
  assert.deepEqual(result, { newestMessageId: "m3", count: 2, fromNumber: "972521112233", matchedLabel: null, snippet: "hello" });
});

/**
 * Round 750: the newest inbound message's matchedLabel must be carried
 * through verbatim -- App.tsx's desktop notification relies on it to show
 * the same "matchedLabel ?? fromNumber" human label whatsappLog.ts and
 * WhatsAppPanel.tsx already show for this exact message everywhere else.
 */
test("findNewInboundMessages carries the newest message's matchedLabel through, when it was matched to a real CRM record", () => {
  const messages = [msg({ id: "m2", fromNumber: "972529998888", matchedLabel: "Sarah Cohen", body: "Are you open tomorrow?" }), msg({ id: "m1" })];
  const result = findNewInboundMessages(messages, lastNotified("m1"));
  assert.deepEqual(result, { newestMessageId: "m2", count: 1, fromNumber: "972529998888", matchedLabel: "Sarah Cohen", snippet: "Are you open tomorrow?" });
});

/**
 * Round 1019: the exact bug this round fixes, mirroring
 * countUnreadWhatsAppMessages' own identical round-940 fix. lastNotified
 * tracked "m3" (the newest inbound message at the time a desktop
 * notification last fired for it), but it was then deleted -- by this
 * same owner from a different tab/device, or by any other collaborator
 * (WhatsApp messages are per-project, not per-user) -- with nothing new
 * having arrived since. The next fetched page no longer contains "m3" at
 * all, but DOES still reach back far enough in time to cover it (m2 and
 * m1 are both older than m3 ever was). The old id-only walk couldn't tell
 * this apart from genuine overflow and returned the whole page as "new",
 * which App.tsx's maybeNotifyNewWhatsAppMessages would have turned into a
 * real desktop notification re-announcing already-read messages as brand
 * new. This must correctly return null, since nothing has actually
 * arrived since the last notification.
 */
test("findNewInboundMessages returns null, not the whole page, when lastNotified's own tracked message was deleted and nothing genuinely new has arrived since", () => {
  const messages = [msg({ id: "m2" }), msg({ id: "m1" })]; // "m3" (the deleted, previously-newest message) is gone from this page
  assert.equal(findNewInboundMessages(messages, lastNotified("m3")), null);
});

/**
 * Sibling of the test above: lastNotified's own tracked message was
 * deleted the exact same way, but real new messages DID arrive since --
 * those must still be reported correctly, not swallowed by the same fix
 * that stops the phantom-notification case.
 */
test("findNewInboundMessages still reports real new messages correctly when lastNotified's own tracked message was deleted, but genuinely new ones arrived since", () => {
  const messages = [
    msg({ id: "m5", body: "genuinely new" }),
    msg({ id: "m4", body: "also genuinely new" }),
    msg({ id: "m2" }),
    msg({ id: "m1" }),
  ]; // "m3" (the deleted, previously-newest message at notify-time) is gone
  const result = findNewInboundMessages(messages, lastNotified("m3"));
  assert.deepEqual(
    result,
    { newestMessageId: "m5", count: 2, fromNumber: "972521112233", matchedLabel: null, snippet: "genuinely new" },
    "m5 and m4 are genuinely newer than the deleted m3 and must still be reported, not swallowed by the deleted-tracked-message fix",
  );
});
