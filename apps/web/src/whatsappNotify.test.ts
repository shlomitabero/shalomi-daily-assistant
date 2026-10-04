import assert from "node:assert/strict";
import { test } from "node:test";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { findNewInboundMessages } from "./whatsappNotify.js";

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
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("findNewInboundMessages returns null when lastNotifiedId is null -- no baseline yet, never notify for pre-existing history", () => {
  const messages = [msg({ id: "m3" }), msg({ id: "m2" }), msg({ id: "m1" })];
  assert.equal(findNewInboundMessages(messages, null), null);
});

test("findNewInboundMessages returns null when nothing new has arrived since lastNotifiedId", () => {
  const messages = [msg({ id: "m2" }), msg({ id: "m1" })];
  assert.equal(findNewInboundMessages(messages, "m2"), null);
});

test("findNewInboundMessages returns the single new inbound message's own details", () => {
  const messages = [msg({ id: "m2", fromNumber: "972529998888", body: "Are you open tomorrow?" }), msg({ id: "m1" })];
  const result = findNewInboundMessages(messages, "m1");
  assert.deepEqual(result, { newestMessageId: "m2", count: 1, fromNumber: "972529998888", snippet: "Are you open tomorrow?" });
});

test("findNewInboundMessages reports the correct count and the NEWEST message's own details when several arrived at once", () => {
  const messages = [
    msg({ id: "m4", fromNumber: "972521110000", body: "newest" }),
    msg({ id: "m3", body: "middle" }),
    msg({ id: "m2", body: "oldest-of-the-new-ones" }),
    msg({ id: "m1" }),
  ];
  const result = findNewInboundMessages(messages, "m1");
  assert.deepEqual(result, { newestMessageId: "m4", count: 3, fromNumber: "972521110000", snippet: "newest" });
});

test("findNewInboundMessages never counts an outbound message the project itself sent as a new inbound message", () => {
  const messages = [msg({ id: "m3", direction: "out", body: "our reply" }), msg({ id: "m2", body: "the real new one" }), msg({ id: "m1" })];
  const result = findNewInboundMessages(messages, "m1");
  assert.deepEqual(result, { newestMessageId: "m2", count: 1, fromNumber: "972521112233", snippet: "the real new one" });
});

test("findNewInboundMessages caps the count at what's in this page when lastNotifiedId isn't found in it at all, instead of throwing or guessing a larger number", () => {
  const messages = [msg({ id: "m3" }), msg({ id: "m2" })];
  const result = findNewInboundMessages(messages, "some-old-id-not-in-this-page");
  assert.deepEqual(result, { newestMessageId: "m3", count: 2, fromNumber: "972521112233", snippet: "hello" });
});
