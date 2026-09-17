import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStepEvent } from "@forge/shared";
import type { ForgeDatabase } from "@forge/db";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { WhatsAppWebManager, type BaileysConnectionUpdate, type BaileysMessagesUpsert, type WhatsAppSocket } from "./whatsappWeb.js";

async function withServer(fn: (baseUrl: string) => Promise<void>, opts?: { whatsapp?: (db: ForgeDatabase) => WhatsAppWebManager }) {
  const db = createStore(":memory:");
  const app = createApp(db, undefined, undefined, opts?.whatsapp?.(db));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
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
