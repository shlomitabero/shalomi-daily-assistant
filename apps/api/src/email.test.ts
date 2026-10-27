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
    // This test makes 3 sequential sends and only cares about each one's
    // own request body -- no real-world spacing delay needed here.
    sendSpacingMs: 0,
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

/**
 * Round 1073: mirrors whatsappWeb.ts's own identical round-794 test for
 * sendMessage's sendQueue -- EntityPanel.tsx's bulk-update "Apply to N"
 * can fire many concurrent PATCH requests, each independently triggering
 * a matching send_email automation rule (fireEmailAction in
 * automations.ts), all calling send() on the same ResendEmailSender
 * instance at once. Before this round, nothing serialized them -- they
 * all raced Resend's own API in the same instant, a real burst pattern
 * that routinely exceeds Resend's per-API-key rate limit and comes back
 * 429, silently dropping real customer notification emails. The fake
 * fetchImpl here holds its own response open for a few milliseconds
 * (unlike the other tests above, which resolve instantly and so could
 * never actually observe an overlap) so a real concurrency violation
 * would be caught instead of coincidentally passing.
 */
test("send serializes concurrent sends so Resend's API never sees two requests in flight at once", async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const sender = new ResendEmailSender({
    apiKey: "re_test_key",
    // No real-world delay needed to prove ordering/non-overlap -- only
    // the fake fetchImpl's own artificial 5ms hold-open below matters.
    sendSpacingMs: 0,
    fetchImpl: async (_input, init) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const body = JSON.parse(init!.body as string);
      order.push(body.subject);
      active--;
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    },
  });

  await Promise.all([
    sender.send("dana@example.com", "one", "text"),
    sender.send("dana@example.com", "two", "text"),
    sender.send("dana@example.com", "three", "text"),
  ]);

  assert.equal(maxActive, 1, "Resend's API must never see two sends in flight at the same time");
  assert.deepEqual(order, ["one", "two", "three"], "sends must go out in call order, one at a time, not interleaved");
});

/**
 * The spacing half of the same fix: a real (non-zero) sendSpacingMs must
 * actually delay the next queued send until after the previous one's
 * network call resolves, not just serialize them back-to-back.
 */
test("send waits sendSpacingMs after each send before letting the next queued send go out", async () => {
  const sendTimestamps: number[] = [];
  const sender = new ResendEmailSender({
    apiKey: "re_test_key",
    sendSpacingMs: 50,
    fetchImpl: async () => {
      sendTimestamps.push(Date.now());
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    },
  });

  await Promise.all([
    sender.send("dana@example.com", "one", "text"),
    sender.send("dana@example.com", "two", "text"),
  ]);

  assert.equal(sendTimestamps.length, 2);
  assert.ok(
    sendTimestamps[1] - sendTimestamps[0] >= 45,
    `expected at least ~50ms between queued sends, got ${sendTimestamps[1] - sendTimestamps[0]}ms`,
  );
});

/**
 * A failed send (Resend returning a non-2xx) must not jam the queue --
 * the next queued send still goes out, mirroring whatsappWeb.ts's own
 * identical "a failed send doesn't block the queue" guarantee (the
 * `.catch(() => {})` on the queue-advancing chain, distinct from the
 * rejection the failed call's own caller still sees).
 */
test("a failed send still rejects its own caller, but does not block the next queued send", async () => {
  let call = 0;
  const sender = new ResendEmailSender({
    apiKey: "re_test_key",
    sendSpacingMs: 0,
    fetchImpl: async () => {
      call++;
      if (call === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    },
  });

  const [first, second] = await Promise.allSettled([
    sender.send("dana@example.com", "one", "text"),
    sender.send("dana@example.com", "two", "text"),
  ]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "fulfilled");
});
