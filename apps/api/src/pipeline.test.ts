import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStepEvent, Project, ProductSpec } from "@forge/shared";
import { ensureCheckpointsTable, ensureProjectsTable, insertProject, openDatabase } from "@forge/db";
import { runBuildPipeline } from "./pipeline.js";

const brokenSpec: ProductSpec = {
  summary: "test",
  personas: [],
  roles: ["Admin"],
  screens: [],
  assumptions: [],
  openQuestions: [],
  // An unsafe field identifier is a real, guaranteed way to make the
  // Database agent's migration throw -- this is what actually reaching
  // the Debug Agent's recovery path in the pipeline looks like, whatever
  // upstream cause produced a bad spec in practice.
  entities: [{ name: "Customer", fields: [{ name: "name; DROP TABLE x;--", type: "text", required: true }] }],
};

const fixedSpec: ProductSpec = {
  ...brokenSpec,
  entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
};

async function collect(gen: AsyncGenerator<AgentStepEvent>): Promise<AgentStepEvent[]> {
  const events: AgentStepEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("Debug Agent recovers from a real migration failure when ANTHROPIC_API_KEY is set", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec: brokenSpec,
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fixedSpec) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  try {
    const events = await collect(runBuildPipeline(db, project, { nextSpec: brokenSpec, changeLabel: "Initial build" }));

    const databaseEvents = events.filter((e) => e.agent === "Database");
    assert.ok(databaseEvents.some((e) => e.status === "failed"), "Database should report the real failure first");
    assert.ok(databaseEvents.some((e) => e.status === "success"), "Database should end successful after recovery");

    const debugEvents = events.filter((e) => e.agent === "Debug");
    assert.equal(debugEvents.length, 2);
    assert.equal(debugEvents[0].status, "running");
    assert.equal(debugEvents[1].status, "success");

    const forgeEvent = events.find((e) => e.agent === "Forge");
    assert.ok(forgeEvent, "pipeline should reach the Forge finalize step, not stop at the failure");
    assert.equal(forgeEvent!.status, "success");

    const finalProject = (forgeEvent!.detail as { project: Project }).project;
    assert.equal(finalProject.status, "built");
    assert.deepEqual(
      finalProject.spec.entities[0].fields.map((f) => f.name),
      ["name"],
    );
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("Debug Agent honestly reports it can't help when no ANTHROPIC_API_KEY is configured", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec: brokenSpec,
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const events = await collect(runBuildPipeline(db, project, { nextSpec: brokenSpec, changeLabel: "Initial build" }));

    const debugEvent = events.find((e) => e.agent === "Debug");
    assert.ok(debugEvent);
    assert.equal(debugEvent!.status, "failed");
    assert.match(debugEvent!.message, /אין מפתח/);

    assert.ok(!events.some((e) => e.agent === "Forge"), "pipeline must not silently continue past an unrepaired failure");
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

test("Debug Agent reports failure clearly when its own fix attempt is also invalid", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec: brokenSpec,
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  // The "fix" the model proposes is itself broken -- the Debug Agent must
  // not loop forever or silently claim success.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(brokenSpec) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  try {
    const events = await collect(runBuildPipeline(db, project, { nextSpec: brokenSpec, changeLabel: "Initial build" }));
    const lastDebugEvent = events.filter((e) => e.agent === "Debug").at(-1);
    assert.equal(lastDebugEvent!.status, "failed");
    assert.ok(!events.some((e) => e.agent === "Forge"));
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});
