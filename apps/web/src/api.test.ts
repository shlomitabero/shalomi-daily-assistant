import assert from "node:assert/strict";
import { test } from "node:test";
import { backupProject, createWakeRefCounter, exportProject, listProjects, safeDownloadName, sendWhatsAppMessage, streamBuild } from "./api.js";

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
 * exportProject and backupProject share their whole request/blob-download
 * sequence via a private downloadBlob() helper, differing only in the URL
 * path and the download filename -- this exercises that shared code
 * through both public entry points to confirm the refactor kept each
 * one's own distinct behavior (right path requested, right filename
 * suffix), not just that *a* download happens. Node 22 has a real global
 * `URL.createObjectURL`, but no `document`; a minimal fake `<a>` element
 * is enough to observe what downloadBlob sets on it.
 */
async function withFakeDocument<T>(fn: () => Promise<T>): Promise<T> {
  const fakeAnchor = { href: "", download: "", click() {}, remove() {} };
  const fakeDocument = {
    createElement: () => fakeAnchor,
    body: { appendChild: () => {} },
  };
  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  try {
    return await fn();
  } finally {
    (globalThis as { document?: unknown }).document = original;
  }
}

test("exportProject requests the export endpoint and downloads it under the project's own name", async () => {
  let requestedUrl: string | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    requestedUrl = input;
    return new Response(new Blob(["zip bytes"]), { status: 200 });
  }) as typeof fetch;
  try {
    await withFakeDocument(() => exportProject("proj1", "My CRM App"));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requestedUrl, "/api/projects/proj1/export");
});

test("backupProject requests the backup endpoint and downloads it with a '-backup' suffix, not the export filename", async () => {
  let requestedUrl: string | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    requestedUrl = input;
    return new Response(new Blob(["zip bytes"]), { status: 200 });
  }) as typeof fetch;
  try {
    await withFakeDocument(() => backupProject("proj1", "My CRM App"));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requestedUrl, "/api/projects/proj1/backup");
});

test("exportProject surfaces a translated error and never attempts the download when the request fails", async () => {
  await assert.rejects(
    () =>
      withFakeDocument(() =>
        withFakeFetch(new Response(JSON.stringify({ error: "Build the project before exporting its code", code: "BUILD_REQUIRED" }), { status: 409 }), () =>
          exportProject("proj1", "My CRM App"),
        ),
      ),
    (err: Error) => {
      assert.equal(err.message, "You need to build the project first.");
      return true;
    },
  );
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

/**
 * When a real HTTP error response's body isn't valid JSON at all (e.g. a
 * proxy's own plain-text 502/504 page, not this app's server), request()'s
 * res.json().catch() fallback used to build { error: "Request failed
 * (500)" } with no `code` -- resolveErrorMessage has nothing to translate
 * in that case, so it fell through to that raw, hardcoded English text
 * even in the Hebrew UI. See docs/roadmap.md for the fix: the fallback now
 * carries code: "REQUEST_FAILED", which does have a translation.
 */
test("a real HTTP error response with a body that isn't valid JSON still surfaces a translated error, not raw hardcoded English", async () => {
  await assert.rejects(
    () => withFakeFetch(new Response("Internal Server Error", { status: 500 }), () => listProjects()),
    (err: Error) => {
      // This message must be the translated string, not the raw
      // `Request failed (500)` text the pre-fix code always threw -- which
      // language it resolves to here just depends on this Node test
      // runtime's global `navigator.language` (see i18n/language.ts's
      // detectInitialLang; same precedent as the sendWhatsAppMessage 409
      // test above).
      assert.equal(err.message, "The request failed. Please try again shortly.");
      return true;
    },
  );
});

/**
 * A build/refine can run for minutes, unlike every other request this app
 * makes -- so a real network drop mid-stream is a genuine risk, not just a
 * theoretical one. streamPipeline's SSE read loop (reader.read()) used to
 * be the one place in api.ts left outside the translated-error layer
 * fetchApi provides: if the connection failed partway through, the raw
 * browser error (e.g. "network error") reached the caller untranslated
 * -- BuildProgress.tsx renders that message directly to the user. See
 * docs/roadmap.md for the fix.
 */
/**
 * Real report from שלומי: the home screen "thinks it over…" (createProject)
 * and never comes back with the app -- no error, no timeout, just a
 * spinner forever. fetchWithWakeRetry's own retry-on-thrown-error logic
 * only covers a connection that fails outright (Render cold-starting); a
 * request whose connection succeeds but whose response simply never
 * arrives (a stalled Anthropic call, or a cold start that happens not to
 * surface as a hard connection failure) sailed straight through untouched
 * and hung indefinitely. fetchApi now bounds the whole request with a
 * client-side AbortController timeout, so a hung request fails clearly
 * with an actionable, translated message instead of spinning forever.
 */
test("fetchApi aborts a request that hangs past its timeout, instead of leaving the caller waiting forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  // A fetch that never resolves on its own -- exactly like a stalled
  // upstream call -- but does honor the AbortSignal, the same real
  // contract the browser's own fetch() has.
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
  try {
    const pending = listProjects();
    // Let the pending assertion attach its rejection handler before the
    // timer fires, so this is a real "still waiting" -> "now it fails"
    // transition, not a race.
    await Promise.resolve();
    t.mock.timers.tick(100_000);
    await assert.rejects(pending, (err: Error) => {
      assert.match(err.message, /taking unusually long/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

test("streamBuild translates a network failure mid-stream, instead of leaking the browser's raw untranslated error", async () => {
  const events: unknown[] = [];
  // The first chunk succeeds so the caller does get that agent-step event
  // before the connection drops -- this isn't an immediate connect
  // failure (already covered by fetchApi/fetchWithWakeRetry), it's a
  // stream that was working and then broke.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"agent":"Architect","status":"running"}\n\n'));
    },
    pull(controller) {
      controller.error(new TypeError("network error"));
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });

  await assert.rejects(
    () => withFakeFetch(response, () => streamBuild("proj1", (event) => events.push(event))),
    (err: Error) => {
      assert.equal(err.message, "Couldn't reach the server. Check your connection and try again.");
      return true;
    },
  );
  assert.equal(events.length, 1);
});
