import assert from "node:assert/strict";
import { test } from "node:test";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { translate } from "./i18n/language.js";
import { filterWhatsAppMessages, formatWhatsAppLog, formatWhatsAppMessageCount } from "./whatsappLog.js";

function makeMessage(overrides: Partial<WhatsAppMessageLogEntry> = {}): WhatsAppMessageLogEntry {
  return {
    id: "m1",
    direction: "in",
    fromNumber: "972501234567",
    toNumber: "972500000000",
    body: "שלום, מתי פתוח?",
    matchedLabel: null,
    matchedEntityName: null,
    matchedRecordId: null,
    status: "received",
    createdAt: "2026-01-15T10:30:00.000Z",
    ...overrides,
  };
}

test("formatWhatsAppLog includes the project name, each message's direction, sender, body, and timestamp", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const messages = [
    makeMessage({ id: "m1", direction: "in", body: "Hi, are you open?", matchedLabel: "Dana Cohen" }),
    makeMessage({ id: "m2", direction: "out", body: "Yes, until 6pm.", fromNumber: "972500000000", toNumber: "972501234567" }),
  ];
  const report = formatWhatsAppLog(messages, "Flower Shop", "en", t);

  assert.match(report, /Flower Shop/);
  assert.match(report, /Hi, are you open\?/);
  assert.match(report, /Dana Cohen/);
  assert.match(report, /Yes, until 6pm\./);
  assert.match(report, /Incoming message/);
  assert.match(report, /Outgoing message/);
});

test("formatWhatsAppLog falls back to the raw phone number when a message has no matched contact name", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const messages = [makeMessage({ direction: "in", fromNumber: "972501234567", matchedLabel: null })];
  const report = formatWhatsAppLog(messages, "Flower Shop", "en", t);

  assert.match(report, /972501234567/);
});

test("formatWhatsAppLog marks a failed message so it's distinguishable in the exported text, not silently identical to a sent one", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const messages = [makeMessage({ direction: "out", status: "failed", body: "This one failed" })];
  const report = formatWhatsAppLog(messages, "Flower Shop", "en", t);

  assert.match(report, /Failed/);
  assert.match(report, /This one failed/);
});

test("formatWhatsAppLog shows the empty-log message instead of an empty body when there are no messages", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const report = formatWhatsAppLog([], "Flower Shop", "en", t);

  assert.match(report, /No messages sent or received yet\./);
});

test("formatWhatsAppLog renders in Hebrew when given the Hebrew translator, with Hebrew text surviving intact", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const messages = [makeMessage({ body: "שלום, מתי פתוח?", matchedLabel: "דנה כהן" })];
  const report = formatWhatsAppLog(messages, "חנות הפרחים", "he", t);

  assert.match(report, /חנות הפרחים/);
  assert.match(report, /שלום, מתי פתוח\?/);
  assert.match(report, /דנה כהן/);
});

/**
 * New in this round: a WhatsApp conversation only ever grows (no cap, no
 * delete besides "Clear history" wiping the whole thing), so a search box
 * was added above the log once it passes a threshold, matching
 * filterCheckpoints' own convention in checkpointDiff.ts for Time Machine.
 */
test("filterWhatsAppMessages matches a message whose body contains the search text, case-insensitively", () => {
  const messages = [
    makeMessage({ id: "m1", body: "מתי אתם פתוחים היום?" }),
    makeMessage({ id: "m2", body: "אשמח להזמין זר ורדים" }),
  ];
  assert.deepEqual(filterWhatsAppMessages(messages, "ורדים").map((m) => m.id), ["m2"]);
  assert.deepEqual(filterWhatsAppMessages(messages, "פתוחים").map((m) => m.id), ["m1"]);
});

test("filterWhatsAppMessages also matches the displayed sender/recipient (matched contact name, or the raw phone number when nothing matched)", () => {
  const messages = [
    makeMessage({ id: "m1", body: "unrelated text", matchedLabel: "Dana Cohen" }),
    makeMessage({ id: "m2", body: "also unrelated", matchedLabel: null, fromNumber: "972501234567" }),
  ];
  assert.deepEqual(filterWhatsAppMessages(messages, "dana").map((m) => m.id), ["m1"], "must match a contact name, case-insensitively");
  assert.deepEqual(filterWhatsAppMessages(messages, "972501234567").map((m) => m.id), ["m2"], "must match the raw phone number when there's no matched contact");
});

test("filterWhatsAppMessages returns every message unchanged when the search is blank or whitespace-only", () => {
  const messages = [makeMessage({ id: "m1" }), makeMessage({ id: "m2" })];
  assert.deepEqual(filterWhatsAppMessages(messages, ""), messages);
  assert.deepEqual(filterWhatsAppMessages(messages, "   "), messages);
});

test("filterWhatsAppMessages returns an empty list when nothing matches, instead of falling back to everything", () => {
  const messages = [makeMessage({ id: "m1", body: "שלום" })];
  assert.deepEqual(filterWhatsAppMessages(messages, "zzz-no-such-text"), []);
});

test("formatWhatsAppMessageCount reports a plain total when the search hasn't narrowed anything out", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatWhatsAppMessageCount(6, 6, tr), "6 messages");
});

test("formatWhatsAppMessageCount reports 'shown of total' once a search has narrowed the log, in Hebrew", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatWhatsAppMessageCount(2, 9, tr), "2 מתוך 9 הודעות");
});
