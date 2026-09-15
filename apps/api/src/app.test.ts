import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStepEvent } from "@forge/shared";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const db = createStore(":memory:");
  const app = createApp(db);
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
