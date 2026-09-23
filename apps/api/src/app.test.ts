import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStepEvent } from "@forge/shared";
import type { ForgeDatabase } from "@forge/db";
import { HeuristicSpecProvider, type SpecProvider } from "@forge/spec-engine";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { WhatsAppWebManager, type BaileysConnectionUpdate, type BaileysMessagesUpsert, type WhatsAppSocket } from "./whatsappWeb.js";

async function withServer(
  fn: (baseUrl: string) => Promise<void>,
  opts?: { whatsapp?: (db: ForgeDatabase) => WhatsAppWebManager; provider?: SpecProvider },
) {
  const db = createStore(":memory:");
  const app = createApp(db, opts?.provider, undefined, opts?.whatsapp?.(db));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
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

    const removeAsCollab = await fetch(`${baseUrl}/api/projects/${project.id}/collaborators/anyone`, {
      method: "DELETE",
      headers: authHeaders(collabToken),
    });
    assert.equal(removeAsCollab.status, 404);
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
