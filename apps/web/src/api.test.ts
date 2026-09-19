import assert from "node:assert/strict";
import { test } from "node:test";
import { createWakeRefCounter, safeDownloadName, sendWhatsAppMessage } from "./api.js";

test("safeDownloadName keeps Hebrew (and other Unicode) project names intact, instead of collapsing them to the fallback", () => {
  // This product is Hebrew-first (see docs/roadmap.md), and every real
  // project name a user actually sees comes out of Anthropic/heuristic
  // spec generation as Hebrew text -- the <a download> attribute is read
  // directly by the browser and has supported Unicode since HTML5, unlike
  // an HTTP Content-Disposition header (constrained to Latin-1 by Node's
  // http module -- see the matching, deliberately ASCII-only logic in
  // apps/api/src/routes/projects.ts).
  assert.equal(safeDownloadName("אפליקציה לניהול תורים למספרה", "forge-app"), "אפליקציה לניהול תורים למספרה");
  assert.equal(safeDownloadName("My CRM App", "forge-app"), "My CRM App");
});

test("safeDownloadName strips only genuinely unsafe filename characters (path separators, Windows-reserved characters, control characters)", () => {
  assert.equal(safeDownloadName("a/b\\c", "forge-app"), "abc");
  assert.equal(safeDownloadName('Ord*rs: "Q1"?', "forge-app"), "Ordrs Q1");
  assert.equal(safeDownloadName("Name\u0007<>|", "forge-app"), "Name");
});

test("safeDownloadName falls back when nothing safe is left (or the name is blank/whitespace)", () => {
  assert.equal(safeDownloadName("///", "forge-app"), "forge-app");
  assert.equal(safeDownloadName("   ", "forge-app"), "forge-app");
  assert.equal(safeDownloadName("", "forge-app"), "forge-app");
});

/**
 * api.ts wires createWakeRefCounter between fetchApi's per-request
 * fetchWithWakeRetry calls and the single global "waking" listener set
 * App.tsx subscribes to (see docs/roadmap.md for the bug this covers: two
 * concurrent in-flight requests during a real cold start, e.g. a
 * background status poll landing alongside a user action, each ran their
 * own independent retry loop and called onWaking(false) the moment their
 * *own* retries finished -- hiding the "waking up" banner while a sibling
 * request was still genuinely retrying against a server that hadn't woken
 * up yet).
 */
test("createWakeRefCounter only notifies waking(false) once every concurrent caller has released it, not as soon as the first one does", () => {
  const notified: boolean[] = [];
  const counted = createWakeRefCounter((w) => notified.push(w));

  counted(true); // request A starts retrying
  assert.deepEqual(notified, [true]);

  counted(true); // request B starts retrying too, while A is still in flight
  assert.deepEqual(notified, [true]); // no duplicate waking(true)

  counted(false); // A's own retry loop finishes first
  assert.deepEqual(notified, [true]); // B is still waking -- banner must stay up

  counted(false); // B's retry loop finishes too
  assert.deepEqual(notified, [true, false]); // only now is it safe to hide the banner
});

test("createWakeRefCounter never lets its internal count go negative on an unmatched waking(false)", () => {
  const notified: boolean[] = [];
  const counted = createWakeRefCounter((w) => notified.push(w));

  counted(false); // no matching waking(true) yet -- must be a no-op, not an underflow
  assert.deepEqual(notified, []);

  counted(true);
  assert.deepEqual(notified, [true]);
  counted(false);
  assert.deepEqual(notified, [true, false]);
});

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
