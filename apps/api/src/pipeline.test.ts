import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStepEvent, Project, ProductSpec } from "@forge/shared";
import { applyMigrations, countRecords, ensureCheckpointsTable, ensureProjectsTable, insertProject, listRecords, openDatabase } from "@forge/db";
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

test("re-running the pipeline for the same project doesn't re-seed a table that already has data", async () => {
  // POST /projects/:id/build (apps/api/src/routes/projects.ts) always calls
  // runBuildPipeline with previousSpec undefined -- there's no previous spec
  // for an initial build. That also means a retry after a failure (the UI's
  // "back" button returns to the spec screen, from where the real Build
  // button re-POSTs the same spec) calls this pipeline exactly the same way
  // as the first attempt: previousSpec is still undefined both times.
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", label: "Customers", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec,
  });
  const customer = spec.entities[0];

  const firstRun = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const firstForge = firstRun.find((e) => e.agent === "Forge");
  assert.ok(firstForge && firstForge.status === "success", "first build should succeed");
  const countAfterFirstBuild = countRecords(db, project.id, customer);
  assert.ok(countAfterFirstBuild > 0, "the first build should have seeded some sample records");

  // Same project, same spec, previousSpec still undefined -- a real retry.
  const secondRun = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const secondSeedEvent = secondRun.find((e) => e.agent === "Seed Data" && e.status === "success");
  assert.ok(secondSeedEvent);
  assert.deepEqual(
    (secondSeedEvent!.detail as { entities: string[] }).entities,
    [],
    "the retry must not report re-seeding a table that already has data",
  );

  const countAfterRetry = countRecords(db, project.id, customer);
  assert.equal(countAfterRetry, countAfterFirstBuild, "retrying the same build must not duplicate the sample records");
  assert.equal(listRecords(db, project.id, customer).length, countAfterFirstBuild);
});

test("the Architect step's impact summary is re-emitted with the corrected spec after a Debug Agent recovery, not left stale", async () => {
  // requestSpecFix is free to rename/add/remove entities and fields while
  // fixing the error -- the Architect event already streamed to the
  // client before the Database step even ran reflects the pre-fix spec,
  // so it can end up describing a field that was never actually built.
  // Uses a refine (previousSpec set) so the field-name change shows up in
  // detail.changedEntities, which a same-entity-set initial build can't
  // exercise (a whole new entity's field names aren't itemized in detail).
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const brokenNextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "bad; DROP TABLE x;--", type: "text", required: false },
        ],
      },
    ],
  };
  const fixedNextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "notes", type: "text", required: false },
        ],
      },
    ],
  };
  applyMigrations(db, "proj1", previousSpec);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec: previousSpec,
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fixedNextSpec) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  try {
    const events = await collect(
      runBuildPipeline(db, project, { previousSpec, nextSpec: brokenNextSpec, changeLabel: "Refine: add a field" }),
    );

    const architectSuccesses = events.filter((e) => e.agent === "Architect" && e.status === "success");
    assert.equal(architectSuccesses.length, 2, "the Architect step must report again once the spec is corrected");

    type ImpactDetail = { changedEntities: { name: string; newFieldNames: string[] }[] };
    const finalImpact = architectSuccesses[architectSuccesses.length - 1].detail as ImpactDetail;
    assert.deepEqual(
      finalImpact.changedEntities,
      [{ name: "Customer", label: "Customer", newFieldNames: ["notes"] }],
      "the re-emitted Architect detail must reflect the corrected field, not the broken one that was never actually built",
    );
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
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
