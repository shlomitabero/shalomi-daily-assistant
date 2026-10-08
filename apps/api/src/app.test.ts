import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AgentStepEvent, ProductSpec } from "@forge/shared";
import {
  diffAndMigrate,
  findUserByEmail,
  insertCheckpoint,
  insertProject,
  insertWhatsAppMessage,
  updateProjectSpec,
  type ForgeDatabase,
} from "@forge/db";
import { HeuristicSpecProvider, type SpecProvider } from "@forge/spec-engine";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { WhatsAppWebManager, type BaileysConnectionUpdate, type BaileysMessagesUpsert, type WhatsAppSocket } from "./whatsappWeb.js";

async function withServer(
  fn: (baseUrl: string, db: ForgeDatabase) => Promise<void>,
  opts?: { whatsapp?: (db: ForgeDatabase) => WhatsAppWebManager; provider?: SpecProvider },
) {
  const db = createStore(":memory:");
  const app = createApp(db, opts?.provider, undefined, opts?.whatsapp?.(db));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, db);
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
function createFakeWhatsAppSocket() {
  let connectionUpdateHandler: ((u: BaileysConnectionUpdate) => void) | undefined;
  let messagesUpsertHandler: ((u: BaileysMessagesUpsert) => void) | undefined;
  const sendCalls: { jid: string; text: string }[] = [];
  const sock: WhatsAppSocket = {
    ev: {
      on(event, listener) {
        if (event === "connection.update") connectionUpdateHandler = listener as (u: BaileysConnectionUpdate) => void;
        if (event === "messages.upsert") messagesUpsertHandler = listener as (u: BaileysMessagesUpsert) => void;
      },
    },
    user: null,
    async sendMessage(jid, content) {
      sendCalls.push({ jid, text: content.text });
      return {};
    },
    async logout() {},
  };
  return {
    sock,
    sendCalls,
    emitConnectionUpdate: (u: BaileysConnectionUpdate) => connectionUpdateHandler?.(u),
    emitMessagesUpsert: (u: BaileysMessagesUpsert) => messagesUpsertHandler?.(u),
  };
}

function createTestWhatsAppManager(db: ForgeDatabase) {
  const createdSockets: ReturnType<typeof createFakeWhatsAppSocket>[] = [];
  const manager = new WhatsAppWebManager({
    db,
    sessionsRootDir: "/tmp/forge-whatsapp-apptest-sessions",
    createSocket: async () => {
      const fake = createFakeWhatsAppSocket();
      createdSockets.push(fake);
      return { sock: fake.sock, saveCreds: async () => {} };
    },
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
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
        body: JSON.stringify({ answers: { [question.question]: "Yes, use Stripe for all payments" } }),
      });
      assert.equal(firstRes.status, 200);
      const first = await firstRes.json();
      assert.equal(calls, 1, "the first attempt must actually call generateSpec once");

      const retryRes = await fetch(`${baseUrl}/api/projects/${project.id}/answers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ answers: { [question.question]: "Yes, use Stripe for all payments" } }),
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
      body: JSON.stringify({ answers: { [question.question]: "Yes, use Stripe for all payments" } }),
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
      body: JSON.stringify({ answers: { "some question": "   " } }),
    });
    assert.equal(noopRes.status, 200);
  });
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
      assert.deepEqual(createdSockets[0].sendCalls, [{ jid: "972501234567@s.whatsapp.net", text: "מתי אפשר להגיע?" }]);

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
      spec: specWithBooleanWon,
    });
    // Builds the physical table with "won" as an INTEGER column (boolean).
    diffAndMigrate(db, projectId, undefined, specWithBooleanWon);
    const checkpoint = insertCheckpoint(db, {
      id: randomUUID(),
      projectId,
      label: "Initial build",
      kind: "build",
      spec: specWithBooleanWon,
    });

    // Simulates a later refine that retypes "won" to text under the same
    // name -- diffAndMigrate leaves the physical column as INTEGER (same
    // documented limitation type_changed exists to report), and the spec
    // pointer moves on, exactly like /refine's own route does.
    diffAndMigrate(db, projectId, specWithBooleanWon, specWithTextWon);
    updateProjectSpec(db, projectId, specWithTextWon);

    // Restoring the original checkpoint moves the spec pointer back to
    // "won: boolean", but the physical column was never altered -- this is
    // exactly the hazard type_changed exists to report, and the fix under
    // test is that the restore route must no longer discard it.
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
      "boolean",
      "the restore itself must still move the spec pointer back",
    );
    assert.ok(restoreBody.migrationWarning, "a migrationWarning must be present given the reused column's type mismatch");
    assert.match(restoreBody.migrationWarning!, /won \(text → boolean\)/);
    assert.match(restoreBody.migrationWarning!, /kept the original database column type/);

    // Control: restoring a checkpoint whose spec already matches the
    // current project.spec (the restore above just moved the pointer back
    // to specWithBooleanWon) reports no mismatch, so migrationWarning must
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
