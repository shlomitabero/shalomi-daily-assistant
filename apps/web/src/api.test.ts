import assert from "node:assert/strict";
import { test } from "node:test";
import { sendWhatsAppMessage } from "./api.js";

/**
 * sendWhatsAppMessage's own send route can answer failure two different
 * ways: a 502 with this route's own {ok:false, error} shape (e.g. the
 * socket write itself failed), or a 409 with the shared {error, code}
 * shape every other route's error middleware uses (e.g. sending before
 * WhatsApp is connected). A caller that only checks `.ok` must see both as
 * a real failure -- see docs/roadmap.md for the bug this covers (the
 * WhatsAppPanel Retry button silently doing nothing on the 409 case,
 * because the raw {error, code} body has no `ok` field at all).
 */
async function withFakeFetch<T>(response: Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("sendWhatsAppMessage passes through a normal successful response unchanged", async () => {
  const result = await withFakeFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }), () =>
    sendWhatsAppMessage("proj1", "972501234567", "hi"),
  );
  assert.deepEqual(result, { ok: true });
});

test("sendWhatsAppMessage passes through this route's own {ok:false, error} failure shape (e.g. a 502 socket failure) unchanged", async () => {
  const result = await withFakeFetch(
    new Response(JSON.stringify({ ok: false, error: "socket write failed" }), { status: 502 }),
    () => sendWhatsAppMessage("proj1", "972501234567", "hi"),
  );
  assert.deepEqual(result, { ok: false, error: "socket write failed" });
});

test("sendWhatsAppMessage normalizes the shared {error, code} error-middleware shape (e.g. a 409 'not connected') into {ok:false, error}, instead of returning a body with no 'ok' field at all", async () => {
  const result = await withFakeFetch(
    new Response(JSON.stringify({ error: "Connect WhatsApp before sending a message", code: "WHATSAPP_NOT_CONNECTED" }), {
      status: 409,
    }),
    () => sendWhatsAppMessage("proj1", "972501234567", "hi"),
  );
  assert.equal(result.ok, false);
  // The raw English error text is never shown directly -- it's translated
  // via the code, same as every other server error in this app.
  assert.equal(result.error, "WhatsApp got disconnected. Reconnect and try again.");
});
