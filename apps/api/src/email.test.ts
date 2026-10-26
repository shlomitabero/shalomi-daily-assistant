import assert from "node:assert/strict";
import { test } from "node:test";
import { ResendEmailSender } from "./email.js";

test("ResendEmailSender.configured is false when no API key is supplied and RESEND_API_KEY isn't set in the environment", () => {
  const sender = new ResendEmailSender({ apiKey: undefined, fetchImpl: async () => new Response("", { status: 200 }) });
  assert.equal(sender.configured, false);
});

test("ResendEmailSender.configured is true once an API key is supplied", () => {
  const sender = new ResendEmailSender({ apiKey: "re_test_key", fetchImpl: async () => new Response("", { status: 200 }) });
  assert.equal(sender.configured, true);
});

test("ResendEmailSender.send rejects immediately (no network call at all) when it isn't configured", async () => {
  let called = false;
  const sender = new ResendEmailSender({
    apiKey: undefined,
    fetchImpl: async () => {
      called = true;
      return new Response("", { status: 200 });
    },
  });
  await assert.rejects(() => sender.send("a@example.com", "subj", "text"), /RESEND_API_KEY is not configured/);
  assert.equal(called, false);
});

test("ResendEmailSender.send posts to Resend's API with the right auth header and body shape, and resolves on a 2xx response", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const sender = new ResendEmailSender({
    apiKey: "re_test_key",
    fromEmail: "Forge AI <onboarding@resend.dev>",
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    },
  });

  await sender.send("dana@example.com", "Your login code: 123456", "Your Forge AI login code is: 123456");

  assert.equal(capturedUrl, "https://api.resend.com/emails");
  assert.equal(capturedInit!.method, "POST");
  const headers = capturedInit!.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  const body = JSON.parse(capturedInit!.body as string);
  assert.deepEqual(body, {
    from: "Forge AI <onboarding@resend.dev>",
    to: "dana@example.com",
    subject: "Your login code: 123456",
    text: "Your Forge AI login code is: 123456",
  });
});

/**
 * Round 1013: backs automations.ts's own fireEmailAction attaching a real
 * uploaded file to an outgoing send_email automation -- confirms the
 * attachment actually reaches Resend's real request body in the shape its
 * API expects, and that omitting it (the existing, pre-round behavior)
 * never adds an empty/undefined `attachments` key that wasn't there
 * before.
 */
test("ResendEmailSender.send includes a real attachments array in the request body when given one, and omits the key entirely when not", async () => {
  let capturedBody: string | undefined;
  const sender = new ResendEmailSender({
    apiKey: "re_test_key",
    fromEmail: "Forge AI <onboarding@resend.dev>",
    fetchImpl: async (_input, init) => {
      capturedBody = init!.body as string;
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    },
  });

  await sender.send("dana@example.com", "Your invoice", "Attached is your invoice.", [
    { filename: "invoice-203.pdf", content: "JVBERi1mYWtl" },
  ]);
  assert.deepEqual(JSON.parse(capturedBody!).attachments, [{ filename: "invoice-203.pdf", content: "JVBERi1mYWtl" }]);

  await sender.send("dana@example.com", "No attachment here", "Just text.");
  assert.equal("attachments" in JSON.parse(capturedBody!), false, "omitting attachments must never send an empty/undefined attachments key");

  await sender.send("dana@example.com", "Empty array too", "Just text.", []);
  assert.equal("attachments" in JSON.parse(capturedBody!), false, "an empty attachments array must also be omitted, not sent as []");
});

test("ResendEmailSender.send rejects with the response status/body when Resend's API returns a non-2xx response", async () => {
  const sender = new ResendEmailSender({
    apiKey: "re_test_key",
    fetchImpl: async () => new Response("invalid api key", { status: 401 }),
  });

  await assert.rejects(
    () => sender.send("dana@example.com", "subj", "text"),
    /Resend API request failed \(401\): invalid api key/,
  );
});
