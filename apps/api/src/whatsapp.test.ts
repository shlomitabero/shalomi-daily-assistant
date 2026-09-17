import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, insertRecord, openDatabase, type WhatsAppSettings } from "@forge/db";
import {
  findMatchingRecord,
  parseIncomingWebhookPayload,
  sendWhatsAppMessage,
  verifyWebhookChallenge,
} from "./whatsapp.js";

const settings: WhatsAppSettings = {
  projectId: "proj1",
  phoneNumberId: "123456123",
  accessToken: "EAAtest",
  verifyToken: "my-verify-token",
  updatedAt: new Date().toISOString(),
};

test("sendWhatsAppMessage builds a real Cloud API request and reports success from a matching mocked response", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ABC123" }] }), { status: 200 });
  }) as typeof fetch;

  const result = await sendWhatsAppMessage(settings, "972501234567", "שלום!", fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(result.messageId, "wamid.ABC123");

  assert.equal(capturedUrl, `https://graph.facebook.com/v21.0/${settings.phoneNumberId}/messages`);
  assert.equal((capturedInit?.headers as Record<string, string>).authorization, `Bearer ${settings.accessToken}`);
  const sentBody = JSON.parse(capturedInit!.body as string);
  assert.deepEqual(sentBody, {
    messaging_product: "whatsapp",
    to: "972501234567",
    type: "text",
    text: { body: "שלום!" },
  });
});

test("sendWhatsAppMessage surfaces Meta's own error message on a real API-error response, not a generic failure", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), { status: 401 })) as typeof fetch;
  const result = await sendWhatsAppMessage(settings, "972501234567", "hi", fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid OAuth access token.");
});

test("sendWhatsAppMessage reports a network failure honestly instead of throwing", async () => {
  const fakeFetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND graph.facebook.com");
  }) as typeof fetch;
  const result = await sendWhatsAppMessage(settings, "972501234567", "hi", fakeFetch);
  assert.equal(result.ok, false);
  assert.match(result.error!, /ENOTFOUND/);
});

test("verifyWebhookChallenge accepts Meta's real handshake shape when the verify token matches", () => {
  const challenge = verifyWebhookChallenge(settings, {
    "hub.mode": "subscribe",
    "hub.verify_token": "my-verify-token",
    "hub.challenge": "1234567890",
  });
  assert.equal(challenge, "1234567890");
});

test("verifyWebhookChallenge refuses a wrong verify token, a wrong mode, or missing settings", () => {
  assert.equal(
    verifyWebhookChallenge(settings, { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "x" }),
    null,
  );
  assert.equal(
    verifyWebhookChallenge(settings, { "hub.mode": "unsubscribe", "hub.verify_token": "my-verify-token", "hub.challenge": "x" }),
    null,
  );
  assert.equal(
    verifyWebhookChallenge(undefined, { "hub.mode": "subscribe", "hub.verify_token": "my-verify-token", "hub.challenge": "x" }),
    null,
  );
});

test("parseIncomingWebhookPayload extracts real text messages from Meta's documented webhook shape", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "123456123" },
              contacts: [{ profile: { name: "Dana Levi" }, wa_id: "972501234567" }],
              messages: [
                { from: "972501234567", id: "wamid.ABC", timestamp: "1700000000", type: "text", text: { body: "מתי התור שלי?" } },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
  const messages = parseIncomingWebhookPayload(payload);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    from: "972501234567",
    to: "15550001111",
    body: "מתי התור שלי?",
    messageId: "wamid.ABC",
    contactName: "Dana Levi",
  });
});

test("parseIncomingWebhookPayload skips non-text message types and malformed payloads without throwing", () => {
  const withImage = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: "1" },
              messages: [{ from: "1", id: "wamid.IMG", type: "image", image: { id: "media123" } }],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(parseIncomingWebhookPayload(withImage), []);
  assert.deepEqual(parseIncomingWebhookPayload({}), []);
  assert.deepEqual(parseIncomingWebhookPayload(null), []);
  assert.doesNotThrow(() => parseIncomingWebhookPayload("not even an object"));
});

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "test",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        label: "לקוחות",
        fields: [
          { name: "name", label: "שם", type: "text", required: true },
          { name: "phone", label: "טלפון", type: "text", required: false },
        ],
      },
    ],
  },
};

test("findMatchingRecord finds a real record whose stored phone matches the incoming number, across differing international-prefix formats", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  const inserted = insertRecord(db, project.id, customer, { name: "Dana Levi", phone: "050-123-4567" });

  const match = findMatchingRecord(db, project, "972501234567");
  assert.ok(match);
  assert.equal(match!.entityName, "Customer");
  assert.equal(match!.recordId, inserted.id);
  assert.equal(match!.label, "Dana Levi");
});

test("findMatchingRecord returns null for a genuinely unknown number instead of guessing", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, project.id, project.spec);
  const customer = project.spec.entities[0];
  insertRecord(db, project.id, customer, { name: "Dana Levi", phone: "0501234567" });

  assert.equal(findMatchingRecord(db, project, "972509999999"), null);
});

test("findMatchingRecord skips entities that have no phone field, rather than throwing", () => {
  const noPhone: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [{ name: "Item", fields: [{ name: "name", type: "text", required: true }] }],
    },
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, noPhone.id, noPhone.spec);
  assert.equal(findMatchingRecord(db, noPhone, "972501234567"), null);
});
