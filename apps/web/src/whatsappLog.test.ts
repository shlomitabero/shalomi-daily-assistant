import assert from "node:assert/strict";
import { test } from "node:test";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { translate } from "./i18n/language.js";
import { formatWhatsAppLog } from "./whatsappLog.js";

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
