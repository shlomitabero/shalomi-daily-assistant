import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AgentStepEvent, Project, ProductSpec } from "@forge/shared";
import {
  applyMigrations,
  countRecords,
  deleteRecord,
  diffAndMigrate,
  ensureCheckpointsTable,
  ensureProjectsTable,
  insertProject,
  insertRecord,
  listCheckpoints,
  listRecords,
  openDatabase,
} from "@forge/db";
import { carryForwardLabels, cleanupFileFieldsRetypedAway, describeImpactHazards, runBuildPipeline, runQaChecks, runSecurityScan } from "./pipeline.js";

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
  // upstream cause produced a bad spec in practice. Round 856 closed this
  // exact shape at the schema layer (FieldSchema's own new identifier-shape
  // refine, mirroring assertSafeIdentifier's SAFE_IDENTIFIER), so this
  // object can no longer survive a real ProductSpecSchema.parse -- it's
  // only ever passed as `nextSpec` below (runBuildPipeline never
  // re-validates that against the schema; it hands it straight to
  // diffAndMigrate, which is where the real throw this test exercises still
  // happens, exactly as it did for an already-stored legacy spec that
  // predates this validation existing -- see insertProject below, which now
  // stores `fixedSpec` instead so the project row itself still round-trips
  // through getProject's own ProductSpecSchema.parse cleanly).
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
    // Stored as fixedSpec, not brokenSpec: insertProject round-trips
    // through getProject's own ProductSpecSchema.parse, which round 856's
    // new identifier-shape refine now rejects brokenSpec against (see
    // brokenSpec's own comment above) -- brokenSpec is still what actually
    // drives the real migration failure below, passed as `nextSpec`
    // (runBuildPipeline never re-validates that against the schema).
    spec: fixedSpec,
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
    // Stored as fixedSpec, not brokenSpec: insertProject round-trips
    // through getProject's own ProductSpecSchema.parse, which round 856's
    // new identifier-shape refine now rejects brokenSpec against (see
    // brokenSpec's own comment above) -- brokenSpec is still what actually
    // drives the real migration failure below, passed as `nextSpec`
    // (runBuildPipeline never re-validates that against the schema).
    spec: fixedSpec,
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const events = await collect(runBuildPipeline(db, project, { nextSpec: brokenSpec, changeLabel: "Initial build" }));

    const debugEvent = events.find((e) => e.agent === "Debug");
    assert.ok(debugEvent);
    assert.equal(debugEvent!.status, "failed");
    assert.match(debugEvent!.message, /No Claude API key/);

    assert.ok(!events.some((e) => e.agent === "Forge"), "pipeline must not silently continue past an unrepaired failure");
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

/**
 * New in this round: the four Debug Agent messages (no-API-key, running,
 * fix-failed, fix-succeeded) were hardcoded Hebrew strings, unlike every
 * other agent's messages in this pipeline (Architect/Database/Seed
 * Data/QA/Security/Forge), which are always plain English regardless of
 * the request's own UI language -- runBuildPipeline never even receives a
 * lang parameter, and BuildProgress.tsx renders every event's message
 * verbatim with no server-side localization (see httpError.ts's own
 * documented policy: server text is never localized, only stable error
 * `code`s are). A collaborator viewing a shared project with English UI
 * would see raw untranslated Hebrew mid-build. Scans every event from
 * both the successful-recovery run and the no-API-key run for any Hebrew
 * character (U+0590-U+05FF) to catch this whole class of bug, not just
 * the four strings that happened to trigger it this time.
 */
test("every pipeline event message is plain English, even on the Debug Agent's recovery path -- no leftover Hebrew text", async () => {
  const HEBREW_CHAR = /[֐-׿]/;
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    // Stored as fixedSpec, not brokenSpec: insertProject round-trips
    // through getProject's own ProductSpecSchema.parse, which round 856's
    // new identifier-shape refine now rejects brokenSpec against (see
    // brokenSpec's own comment above) -- brokenSpec is still what actually
    // drives the real migration failure below, passed as `nextSpec`
    // (runBuildPipeline never re-validates that against the schema).
    spec: fixedSpec,
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fixedSpec) }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  try {
    const recoveryEvents = await collect(runBuildPipeline(db, project, { nextSpec: brokenSpec, changeLabel: "Initial build" }));
    const hebrewInRecovery = recoveryEvents.filter((e) => HEBREW_CHAR.test(e.message));
    assert.deepEqual(
      hebrewInRecovery.map((e) => `${e.agent}/${e.status}: ${e.message}`),
      [],
      "no event message on the recovery path should contain Hebrew text",
    );
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }

  const noKeyDb = openDatabase(":memory:");
  ensureProjectsTable(noKeyDb);
  const noKeyProject = insertProject(noKeyDb, {
    id: "proj2",
    ownerId: "user1",
    name: "test",
    description: "test",
    // Stored as fixedSpec, not brokenSpec: insertProject round-trips
    // through getProject's own ProductSpecSchema.parse, which round 856's
    // new identifier-shape refine now rejects brokenSpec against (see
    // brokenSpec's own comment above) -- brokenSpec is still what actually
    // drives the real migration failure below, passed as `nextSpec`
    // (runBuildPipeline never re-validates that against the schema).
    spec: fixedSpec,
  });
  const originalKey2 = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const noKeyEvents = await collect(runBuildPipeline(noKeyDb, noKeyProject, { nextSpec: brokenSpec, changeLabel: "Initial build" }));
    const hebrewInNoKey = noKeyEvents.filter((e) => HEBREW_CHAR.test(e.message));
    assert.deepEqual(
      hebrewInNoKey.map((e) => `${e.agent}/${e.status}: ${e.message}`),
      [],
      "no event message on the no-API-key path should contain Hebrew text",
    );
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey2;
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

/**
 * Regression test: the checkpoint's own `kind` (CheckpointSchema) is what
 * getCheckpointType (checkpointDiff.ts) now reads directly instead of
 * re-deriving it from the checkpoint's label -- a user-renameable field
 * (CheckpointLabelEditor) that used to be the only signal, and silently
 * misclassified a renamed checkpoint. This confirms the real wiring: an
 * actual build's checkpoint is inserted with kind "build" and an actual
 * refine's checkpoint is inserted with kind "refine", driven by whether
 * previousSpec is set on the very call that created it (routes/projects.ts
 * never sets it for /build, always sets it to project.spec for /refine) --
 * not just the isolated insertCheckpoint/getCheckpointType unit behavior
 * already covered in packages/db/src/checkpoints.test.ts and
 * apps/web/src/checkpointDiff.test.ts.
 */
test("a real build's checkpoint is inserted with kind 'build' and a real refine's checkpoint is inserted with kind 'refine'", async () => {
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
  const project = insertProject(db, { id: "proj1", ownerId: "user1", name: "test", description: "test", spec });

  await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const afterBuild = listCheckpoints(db, project.id);
  assert.equal(afterBuild.length, 1);
  assert.equal(afterBuild[0].kind, "build", "an initial build's own checkpoint must be kind 'build'");

  const refinedSpec: ProductSpec = {
    ...spec,
    entities: [...spec.entities, { name: "Order", fields: [{ name: "total", type: "number", required: true }] }],
  };
  await collect(runBuildPipeline(db, project, { previousSpec: spec, nextSpec: refinedSpec, changeLabel: "Refine: add orders" }));
  const afterRefine = listCheckpoints(db, project.id);
  assert.equal(afterRefine.length, 2);
  assert.equal(afterRefine[0].kind, "refine", "the refine's own checkpoint (newest first) must be kind 'refine', regardless of what its label says");
  assert.equal(afterRefine[1].kind, "build", "the original build's checkpoint must still be kind 'build'");
});

/**
 * Round 797: every earlier step in this exact generator is deliberately
 * guarded so it can never throw once headers are already sent on the SSE
 * response (the Database step's own try/catch+auto-fix-retry just above,
 * Seed Data's per-record try/catch, runQaChecks' own internal try/catches)
 * -- but the finalize block's own real DB writes (updateProjectSpec,
 * markProjectBuilt, insertCheckpoint, getProject) had no such guard. A
 * genuine write failure there (this app's own ephemeral-disk Render
 * deployment makes a disk-full write failure a real, not hypothetical,
 * case) used to propagate straight out of this async generator -- with
 * streamPipeline's own `for await` (routes/projects.ts) having no
 * try/catch of its own, it reached Express's error middleware (app.ts)
 * *after* this response's headers were already written, which (before
 * this round) called res.status(500).json(...) there too, throwing its
 * own synchronous ERR_HTTP_HEADERS_SENT instead of ever reaching the
 * client -- the build appeared to die with no real error message, after
 * the user had already watched every earlier step render as a green
 * "success".
 */
test("a DB write failure while finalizing the build is reported as a failed Forge event, not thrown out of the generator", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const project = insertProject(db, { id: "proj1", ownerId: "user1", name: "test", description: "test", spec });

  const gen = runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" });
  const events: AgentStepEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    if (step.value.agent === "Security" && step.value.status === "success") {
      // Everything up to and including Security has already succeeded and
      // streamed to the client -- closing the db now simulates the exact
      // kind of real write failure (disk full, DB unavailable) the
      // finalize block's own updateProjectSpec/markProjectBuilt/
      // insertCheckpoint calls can genuinely hit, without needing to fake
      // a disk-full condition directly.
      db.close();
    }
    step = await gen.next();
  }

  const forgeEvents = events.filter((e) => e.agent === "Forge");
  assert.equal(forgeEvents.length, 1, "the generator must yield exactly one Forge event, not throw past it");
  assert.equal(forgeEvents[0]!.status, "failed", "a DB write failure while finalizing must be reported as a failed event, not thrown out of the generator");
  assert.match(forgeEvents[0]!.message, /database is not open/i);
});

/**
 * Regression test: a required relation field is seeded with a best-effort
 * `id=1` guess (packages/db/src/seed.ts's seedValueFor) -- correct only if
 * its target entity already has a real row 1 by the time it's attempted.
 * Before this round, the Seed Data step seeded entities in whatever order
 * they appear in the spec, with no notion of dependency order at all. A
 * spec listing the dependent entity FIRST (e.g. [Invoice, Customer], with
 * Invoice.customerId a required relation to Customer -- an entirely
 * ordinary, correct data model; an AI-generated or refined spec can easily
 * produce this even though the built-in domain library never does) made
 * every one of Invoice's own seed inserts throw a real FK-constraint
 * violation (Customer had zero rows yet). Worse, the pipeline's Seed Data
 * step never stopped the build on that failure, so by the time QA's
 * required-field smoke test ran, Customer had since been seeded by its own
 * later turn in the original loop -- making the SAME guessed id=1 succeed
 * there and masking the fact that Invoice's own table was left with zero
 * demo rows, silently defeating the entire point of seeding.
 */
test("seeding a spec that lists a dependent entity before its required relation target still seeds both tables, not just the target", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Invoice",
        fields: [
          { name: "amount", type: "number", required: true },
          { name: "customerId", type: "relation", relationTo: "Customer", required: true },
        ],
      },
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
    ],
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
  const [invoice, customer] = spec.entities;

  const events = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const forgeEvent = events.find((e) => e.agent === "Forge");
  assert.ok(forgeEvent && forgeEvent.status === "success", "the build should still succeed overall");

  const seedEvent = events.find((e) => e.agent === "Seed Data" && e.status !== "running");
  assert.equal(seedEvent!.status, "success", "seeding must not report any failed inserts");

  assert.ok(countRecords(db, project.id, invoice) > 0, "Invoice must actually have seeded rows, not be left empty");
  assert.ok(countRecords(db, project.id, customer) > 0, "Customer must also have its own seeded rows");

  const qaEvent = events.find((e) => e.agent === "QA" && e.status !== "running");
  assert.equal(qaEvent!.status, "success", "QA must still pass once seeding genuinely succeeds");
});

/**
 * Round 753: seedValueFor (seed.ts) deliberately leaves every "file" field
 * null -- there's no real uploaded file to point a seeded record at. For
 * an entity with a REQUIRED file field, that used to mean every single
 * generated seed record was rejected by insertRecord with the identical
 * `Field "resume" is required` error, piling up one duplicate error per
 * record instead of skipping the entity upfront with one clear,
 * structural reason -- the same "file field makes the operation
 * impossible" case buildImportRecords (CSV import) and
 * handleDuplicate/handleBulkDuplicate already handle by refusing outright
 * rather than attempting a doomed operation.
 */
test("seeding an entity with a required 'file' field skips it with one clear message instead of piling up one identical insert error per generated record", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Applicant",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "resume", label: "Resume", type: "file", required: true },
        ],
      },
    ],
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
  const [applicant] = spec.entities;

  const events = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const forgeEvent = events.find((e) => e.agent === "Forge");
  assert.ok(forgeEvent && forgeEvent.status === "success", "the build must still succeed overall -- an unseedable entity is not a build failure");

  const seedEvent = events.find((e) => e.agent === "Seed Data" && e.status !== "running");
  assert.equal(seedEvent!.status, "failed", "an entirely unseedable entity is still a real Seed Data failure, just an honest, upfront one");
  assert.deepEqual(
    seedEvent!.detail,
    ['Applicant: skipped seeding -- required file field "Resume" has no real uploaded file to point a sample record at; add its first record(s) by hand once the app is live.'],
    "exactly one clear, structural message -- not one identical insert-rejection error repeated per generated record",
  );

  assert.equal(countRecords(db, project.id, applicant), 0, "Applicant correctly has zero seeded rows, not partial/garbage data");
});

/**
 * Regression test: the old Seed Data eligibility filter only seeded an
 * entity if it was BOTH brand-new (per this diff's new_table changes) AND
 * currently empty. An existing entity the user had emptied out (e.g. she
 * deleted every Customer record through the normal UI) was never eligible
 * again -- so when a later refine adds a new entity with a required
 * relation to that now-empty existing entity, seedValueFor's best-effort
 * id=1 guess for the required relation violates a real FK constraint on
 * every single insert, permanently leaving the new entity with zero seeded
 * rows and no error ever surfacing to the user. Walking the required-
 * relation graph out from every new entity to also reseed any existing but
 * currently-empty target fixes this without touching an existing entity
 * that genuinely still has real data.
 */
test("refining to add an entity with a required relation to an existing-but-emptied entity still seeds both", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const project = insertProject(db, { id: "proj1", ownerId: "user1", name: "test", description: "test", spec });
  const customer = spec.entities[0];

  await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  assert.ok(countRecords(db, project.id, customer) > 0, "the initial build should have seeded Customer");

  // The user deletes every Customer record through the normal UI, leaving
  // the table empty but not "new" by any later diff.
  for (const record of listRecords(db, project.id, customer)) {
    deleteRecord(db, project.id, customer, record.id as number);
  }
  assert.equal(countRecords(db, project.id, customer), 0, "Customer must genuinely be empty before the refine");

  const refinedSpec: ProductSpec = {
    ...spec,
    entities: [
      ...spec.entities,
      {
        name: "Invoice",
        fields: [
          { name: "amount", type: "number", required: true },
          { name: "customerId", type: "relation", relationTo: "Customer", required: true },
        ],
      },
    ],
  };
  const events = await collect(
    runBuildPipeline(db, project, { previousSpec: spec, nextSpec: refinedSpec, changeLabel: "Refine: add invoices" }),
  );
  const forgeEvent = events.find((e) => e.agent === "Forge");
  assert.ok(forgeEvent && forgeEvent.status === "success", "the refine should still succeed overall");

  const seedEvent = events.find((e) => e.agent === "Seed Data" && e.status !== "running");
  assert.equal(
    seedEvent!.status,
    "success",
    "seeding must not report any FK-constraint-violation failures for Invoice's required relation",
  );

  const invoice = refinedSpec.entities[1];
  assert.ok(countRecords(db, project.id, invoice) > 0, "Invoice must actually have seeded rows");
  assert.ok(countRecords(db, project.id, customer) > 0, "Customer must be reseeded too, since it was genuinely empty");
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

    type ImpactDetail = { changedEntities: { name: string; newFieldNames: string[]; removedFieldNames: string[]; tightenedFieldNames: string[] }[] };
    const finalImpact = architectSuccesses[architectSuccesses.length - 1].detail as ImpactDetail;
    assert.deepEqual(
      finalImpact.changedEntities,
      [{ name: "Customer", label: "Customer", newFieldNames: ["notes"], removedFieldNames: [], tightenedFieldNames: [] }],
      "the re-emitted Architect detail must reflect the corrected field, not the broken one that was never actually built",
    );
  } finally {
    process.env.ANTHROPIC_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});

/**
 * Regression test for a real gap found by round 377's Explore survey: a
 * refine instruction (e.g. "rename Customer to Client" or "remove deals
 * tracking") regenerates the whole spec from plain prose -- the AI
 * provider never receives the previous spec's structure -- so it's a very
 * plausible way for an entity to simply be omitted from the next spec
 * rather than literally renamed/removed in place. Migrations are
 * additive-only, so the entity's table/data survive, but it becomes
 * unreachable through the UI/API the moment this build finishes. Before
 * this fix, computeImpact's own detail/message only ever reported what
 * was newly ADDED -- nothing in the live build stream ever warned about
 * this. Confirms the real pipeline (not a reimplementation) now reports it
 * in both the Architect event's message and its structured detail.
 */
test("a refine that drops an existing entity is reported as a removed entity in the Architect's impact summary, not silently", async () => {
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
    entities: [
      { name: "Customer", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Deal", label: "Deal", fields: [{ name: "amount", type: "number", required: true }] },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [previousSpec.entities[0]],
  };
  applyMigrations(db, "proj1", previousSpec);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec: previousSpec,
  });

  const events = await collect(runBuildPipeline(db, project, { previousSpec, nextSpec, changeLabel: "Refine: drop deals" }));
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);

  assert.match(architectSuccess!.message, /Warning: 1 entities are no longer in the spec \(Deal\)/);

  type ImpactDetail = { removedEntityNames: string[]; removedEntities: { name: string; label: string }[] };
  const detail = architectSuccess!.detail as ImpactDetail;
  assert.deepEqual(detail.removedEntityNames, ["Deal"]);
  assert.deepEqual(detail.removedEntities, [{ name: "Deal", label: "Deal" }]);
});

/**
 * Regression test for a real gap found by round 397's Explore survey:
 * computeImpact's changedEntities already computed removedFieldNames
 * alongside newFieldNames (added in the very same round-377 commit that
 * fixed whole-entity removal above), but architectEvent's own message
 * never read it -- an entity that only LOST a field (gained nothing) still
 * made the message say "1 existing entities gaining fields", actively
 * misleading rather than just silent. This is the same "data structure
 * grew a field but a consumer never reads it" gap rounds 395/396 found in
 * MigrationChange, just inside this file's own message string instead of
 * a separate consumer file.
 */
test("a refine that drops a field from an entity that still exists is reported as a lost field in the Architect's message, not as 'gaining fields'", async () => {
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
    entities: [
      {
        name: "Order",
        label: "Order",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "notes", type: "longtext", required: false },
        ],
      },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [{ ...previousSpec.entities[0], fields: [previousSpec.entities[0].fields[0]] }],
  };
  applyMigrations(db, "proj1", previousSpec);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec: previousSpec,
  });

  const events = await collect(runBuildPipeline(db, project, { previousSpec, nextSpec, changeLabel: "Refine: drop notes" }));
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);

  // The real proof: the message must name the lost field, not just imply
  // (incorrectly) that the entity gained fields. The previous version of
  // this assertion (round 397) used `assert.doesNotMatch` against a regex
  // with a negative lookahead for " Warning" immediately after "gaining
  // fields." -- since the real message DOES have " Warning" right after
  // that phrase, the lookahead always failed to match and `doesNotMatch`
  // passed vacuously, never actually checking the count itself. Assert the
  // exact headline directly instead: Order only lost a field and gained
  // nothing, so the count must read 0, not 1 (round 477's own regression).
  assert.match(architectSuccess!.message, /\+0 new entities \(none\), 0 existing entities gaining fields\./);
  assert.match(architectSuccess!.message, /Warning: Order lost field\(s\): notes/);

  type ImpactDetail = { changedEntities: { name: string; label: string; newFieldNames: string[]; removedFieldNames: string[]; tightenedFieldNames: string[] }[] };
  const detail = architectSuccess!.detail as ImpactDetail;
  assert.deepEqual(detail.changedEntities, [
    { name: "Order", label: "Order", newFieldNames: [], removedFieldNames: ["notes"], tightenedFieldNames: [] },
  ]);
});

/**
 * Round 641: a field's display label is never enforced unique (only its
 * name is), so two fields on an entity can legally share a label via the
 * Field Label editor. Removing only ONE of two same-labeled fields used
 * to make the Architect's message claim that shared label is "no longer
 * reachable through the app" -- false, since a different field with the
 * identical label is still live on the entity. The genuinely-removed
 * field couldn't even be identified from the message at all.
 */
test("removing one of two same-labeled fields names the real removed field, not the shared label that's still live on a sibling field", async () => {
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
    entities: [
      {
        name: "Order",
        label: "Order",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "subtotal", label: "Amount", type: "number", required: true },
          { name: "shipping", label: "Amount", type: "number", required: true },
        ],
      },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      { ...previousSpec.entities[0], fields: previousSpec.entities[0].fields.filter((f) => f.name !== "shipping") },
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

  const events = await collect(runBuildPipeline(db, project, { previousSpec, nextSpec, changeLabel: "Refine: drop shipping" }));
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);

  assert.match(architectSuccess!.message, /Warning: Order lost field\(s\): Amount \(shipping\)/);
  assert.doesNotMatch(
    architectSuccess!.message,
    /lost field\(s\): Amount(?! \()/,
    "the warning must disambiguate which 'Amount' field was lost, not name the bare shared label still live on 'subtotal'",
  );

  type ImpactDetail = { changedEntities: { name: string; label: string; newFieldNames: string[]; removedFieldNames: string[]; tightenedFieldNames: string[] }[] };
  const detail = architectSuccess!.detail as ImpactDetail;
  assert.deepEqual(detail.changedEntities, [
    { name: "Order", label: "Order", newFieldNames: [], removedFieldNames: ["Amount (shipping)"], tightenedFieldNames: [] },
  ]);
});

/**
 * Round 642: round 641's fix disambiguated same-labeled FIELDS, but an
 * entity's own display label is just as unenforced-unique (the Entity
 * Label editor's PATCH route accepts any non-empty string, with no
 * collision check against sibling entities' labels). Dropping a field
 * from one of two entities that share a label used to make the
 * Architect's warning name the bare shared label -- indistinguishable
 * from the OTHER, untouched entity sharing that same label.
 */
test("dropping a field from one of two same-labeled entities names the real changed entity, not the shared label that also belongs to an untouched sibling entity", async () => {
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
    entities: [
      {
        name: "Product",
        label: "Items",
        fields: [{ name: "name", type: "text", required: true }, { name: "price", type: "number", required: true }],
      },
      {
        name: "Service",
        label: "Items",
        fields: [{ name: "name", type: "text", required: true }],
      },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      { ...previousSpec.entities[0], fields: [previousSpec.entities[0].fields[0]] },
      previousSpec.entities[1],
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

  const events = await collect(runBuildPipeline(db, project, { previousSpec, nextSpec, changeLabel: "Refine: drop price" }));
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);

  assert.match(architectSuccess!.message, /Warning: Items \(Product\) lost field\(s\): price/);
  assert.doesNotMatch(
    architectSuccess!.message,
    /Warning: Items lost field\(s\)/,
    "the warning must disambiguate which 'Items' entity lost the field, not name the bare shared label that also belongs to the untouched 'Service' entity",
  );

  type ImpactDetail = { changedEntities: { name: string; label: string; newFieldNames: string[]; removedFieldNames: string[]; tightenedFieldNames: string[] }[] };
  const detail = architectSuccess!.detail as ImpactDetail;
  assert.deepEqual(detail.changedEntities, [
    { name: "Product", label: "Items (Product)", newFieldNames: [], removedFieldNames: ["price"], tightenedFieldNames: [] },
  ]);
});

/**
 * Regression test for a real gap found by round 398's Explore survey: a
 * same-named field that keeps existing on both sides of a refine is
 * invisible to computeImpact's new/removed field checks, but can still
 * become more restrictive -- flipping from optional to required, or (for
 * an enum) losing a value existing records may already be storing. Before
 * this fix, nothing in the live build stream ever reported this: the
 * Architect message said "0 existing entities gaining fields" with zero
 * indication anything changed at all, even though repository.ts's own
 * updateRecord comment explains exactly why this kind of change matters
 * (a future edit to that field on an existing row must now satisfy the
 * new, stricter rule).
 *
 * Deliberately distinct from checkpointDiff.ts's own fieldSignature: round
 * 275 explicitly decided a required-flag or label change is NOT a
 * structural diff for Time Machine's "what would restoring this change"
 * question (see its own dedicated test) -- but this is a different
 * question entirely ("what did my refine instruction just do"), asked by
 * a different function (pipeline.ts's computeImpact) for a different UI
 * (the live build stream), so the two are not in conflict.
 */
test("a refine that makes a field required or narrows an enum on an entity that still exists is reported as a tightened constraint, not silently", async () => {
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
    entities: [
      {
        name: "Deal",
        label: "Deal",
        fields: [
          { name: "title", type: "text", required: false },
          { name: "stage", type: "enum", required: true, enumValues: ["Open", "Won", "Lost"] },
        ],
      },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        ...previousSpec.entities[0],
        fields: [
          { name: "title", type: "text", required: true },
          { name: "stage", type: "enum", required: true, enumValues: ["Open", "Won"] },
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

  const events = await collect(
    runBuildPipeline(db, project, { previousSpec, nextSpec, changeLabel: "Refine: tighten Deal rules" }),
  );
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);

  assert.match(architectSuccess!.message, /Warning: Deal now enforces stricter rules on: title, stage/);

  type ImpactDetail = { changedEntities: { name: string; label: string; newFieldNames: string[]; removedFieldNames: string[]; tightenedFieldNames: string[] }[] };
  const detail = architectSuccess!.detail as ImpactDetail;
  assert.deepEqual(detail.changedEntities, [
    { name: "Deal", label: "Deal", newFieldNames: [], removedFieldNames: [], tightenedFieldNames: ["title", "stage"] },
  ]);
});

test("a refine that only widens a field (optional stays optional, an enum gains a value) is never reported as tightened", async () => {
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
    entities: [
      {
        name: "Deal",
        label: "Deal",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "stage", type: "enum", required: true, enumValues: ["Open", "Won"] },
        ],
      },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        ...previousSpec.entities[0],
        fields: [
          { name: "title", type: "text", required: true },
          { name: "stage", type: "enum", required: true, enumValues: ["Open", "Won", "Lost"] },
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

  const events = await collect(
    runBuildPipeline(db, project, { previousSpec, nextSpec, changeLabel: "Refine: widen Deal rules" }),
  );
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);

  assert.doesNotMatch(architectSuccess!.message, /now enforces stricter rules/);
});

/**
 * Companion to the test above: an INITIAL build has no previousSpec, so
 * there is nothing to have removed -- computeImpact must never report a
 * phantom removal just because previousSpec is undefined.
 */
test("an initial build (no previous spec) never reports a removed entity", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", label: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    spec,
  });

  const events = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const architectSuccess = events.find((e) => e.agent === "Architect" && e.status === "success");
  assert.ok(architectSuccess);
  assert.doesNotMatch(architectSuccess!.message, /Warning/);

  type ImpactDetail = { removedEntityNames: string[] };
  assert.deepEqual((architectSuccess!.detail as ImpactDetail).removedEntityNames, []);
});

/**
 * Regression test for round 406: /refine's own generateSpec() call
 * produces a providerName (routes/projects.ts) that previously had nowhere
 * to go once handed to this generator -- it's now carried on the very
 * first ("Architect"/"running") event's own `detail`, so the client can
 * read it back out of the raw SSE stream without a second event shape.
 */
test("runBuildPipeline attaches providerName to the first Architect/running event's detail when options.providerName is set", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const spec: ProductSpec = { summary: "test", personas: [], roles: ["Admin"], screens: [], assumptions: [], openQuestions: [], entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] };
  const project = insertProject(db, { id: "proj1", ownerId: "user1", name: "test", description: "test", spec });

  const events = await collect(
    runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Refine: add a field", providerName: "anthropic-fallback" }),
  );
  const firstEvent = events[0];
  assert.equal(firstEvent.agent, "Architect");
  assert.equal(firstEvent.status, "running");
  assert.deepEqual(firstEvent.detail, { providerName: "anthropic-fallback" });
});

/**
 * /build never calls generateSpec() at all (it builds whatever spec the
 * project already has), so it never passes options.providerName -- this
 * confirms that case leaves the first event exactly as it was before this
 * round, with no `detail` key at all (not even one holding `undefined`),
 * matching every other "running"-status event in this file.
 */
test("runBuildPipeline's first event has no detail key at all when options.providerName is omitted", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const spec: ProductSpec = { summary: "test", personas: [], roles: ["Admin"], screens: [], assumptions: [], openQuestions: [], entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] };
  const project = insertProject(db, { id: "proj1", ownerId: "user1", name: "test", description: "test", spec });

  const events = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const firstEvent = events[0];
  assert.deepEqual(firstEvent, { agent: "Architect", status: "running", message: "Designing schema from the product spec…" });
});

test("Debug Agent reports failure clearly when its own fix attempt is also invalid", async () => {
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  const project = insertProject(db, {
    id: "proj1",
    ownerId: "user1",
    name: "test",
    description: "test",
    // Stored as fixedSpec, not brokenSpec: insertProject round-trips
    // through getProject's own ProductSpecSchema.parse, which round 856's
    // new identifier-shape refine now rejects brokenSpec against (see
    // brokenSpec's own comment above) -- brokenSpec is still what actually
    // drives the real migration failure below, passed as `nextSpec`
    // (runBuildPipeline never re-validates that against the schema).
    spec: fixedSpec,
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

/**
 * Regression test for the QA gap this round fixes: runQaChecks previously
 * picked only the FIRST required field via `entity.fields.find((f) =>
 * f.required)`, so an entity with 2+ required fields (e.g. "name" and
 * "email" both required) got real insertRecord-backed validation coverage
 * for just the first one -- the "3/3 entity checks passed" message a real
 * build reports implied every required field was exercised, which was
 * never actually true. Confirms every required field on a multi-required-
 * field entity now produces its own "required-field validation enforced"
 * check, not just the first.
 */
test("runQaChecks validates every required field of an entity, not just the first one found", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "text", required: true },
          { name: "phone", type: "text", required: true },
          { name: "notes", type: "text", required: false },
        ],
      },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const qa = runQaChecks(db, "proj1", spec);

  assert.equal(qa.allPassed, true);
  const customerChecks = qa.results.find((r) => r.entity === "Customer")!.checks;
  assert.ok(
    customerChecks.includes('required-field validation enforced for "name"'),
    "the first required field must still be checked",
  );
  assert.ok(
    customerChecks.includes('required-field validation enforced for "email"'),
    "the SECOND required field must also be checked -- this is exactly what was missing before this round's fix",
  );
  assert.ok(
    customerChecks.includes('required-field validation enforced for "phone"'),
    "the THIRD required field must also be checked",
  );
  assert.ok(
    !customerChecks.some((c) => c.includes('"notes"')),
    "an optional field must never be reported as a required-field check",
  );
  assert.equal(
    countRecords(db, "proj1", spec.entities[0]),
    0,
    "every per-field QA insert is expected to be rejected, so none of them should leave a real row behind",
  );
});

/**
 * Regression test for a real bug found by this round's Explore survey: the
 * Security step's SENSITIVE_FIELD_HINTS list flagged fields via a plain
 * substring check (`lowerName.includes("secret")`), so an entirely ordinary
 * field named "secretary" (a real, plausible field for an office/school/
 * clinic-admin entity) tripped a false "looks sensitive" warning and
 * silently docked 10 points from the build's displayed Security score --
 * both the warning text and the score are rendered directly on the AI
 * Team build screen's Security step (see BuildProgress.tsx). Same
 * substring-collision class already fixed in domainEntities.ts's keyword
 * matching (rounds 279-280), but field names are camelCase/snake_case
 * identifiers rather than prose, so the same \b-bounded-regex-on-lowercased-
 * text trick doesn't transfer directly: `\bsecret\b` would also reject the
 * legitimate "secretKey"/"apiSecret" field names this scan is actually
 * meant to catch, since lowercasing erases the capitalization that marks a
 * fresh word start in an identifier. Fixed with a regex that runs against
 * the field's original, un-lowercased name instead.
 */
test("Security scan's 'secret' hint doesn't spuriously flag 'secretary', but still catches secretKey/apiSecret/secret_key", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Employee",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "secretary", type: "text", required: false },
          { name: "secretKey", type: "text", required: false },
          { name: "apiSecret", type: "text", required: false },
          { name: "secret_key", type: "text", required: false },
        ],
      },
    ],
  };

  const security = runSecurityScan("proj1", spec);

  assert.ok(
    !security.warnings.some((w) => w.includes('"Employee.secretary"')),
    "an ordinary 'secretary' field must not be flagged as looking sensitive",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Employee.secretKey"')),
    "'secretKey' must still be flagged -- it's a genuinely sensitive-sounding field name",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Employee.apiSecret"')),
    "'apiSecret' must still be flagged",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Employee.secret_key"')),
    "'secret_key' must still be flagged",
  );
  assert.equal(security.warnings.length, 3, "exactly the 3 genuinely sensitive-sounding fields should be flagged, not 'secretary' too");
});

/**
 * Regression test for a real bug found by a round 459 Explore survey: the
 * same SENSITIVE_FIELD_HINTS array's bare "ssn" hint flagged fields via a
 * plain substring check (`lowerName.includes("ssn")`), so entirely ordinary
 * fields "businessName" and "className" (lowercased: "busine**ssn**ame",
 * "cla**ssn**ame") tripped a false "looks sensitive" warning -- the exact
 * same collision class as "secret"/"secretary" fixed just above in this same
 * array, left unfixed on this sibling hint. Fixed the same way: a regex
 * against the field's original, un-lowercased name, checking for a
 * word-start lowercase "ssn" or the "SSN" acronym form, each not
 * immediately followed by a lowercase letter.
 */
test("Security scan's 'ssn' hint doesn't spuriously flag 'businessName'/'className', but still catches ssn/userSSN/ssn_number", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Vendor",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "businessName", type: "text", required: false },
          { name: "className", type: "text", required: false },
          { name: "ssn", type: "text", required: false },
          { name: "userSSN", type: "text", required: false },
          { name: "ssn_number", type: "text", required: false },
        ],
      },
    ],
  };

  const security = runSecurityScan("proj1", spec);

  assert.ok(
    !security.warnings.some((w) => w.includes('"Vendor.businessName"')),
    "an ordinary 'businessName' field must not be flagged as looking sensitive",
  );
  assert.ok(
    !security.warnings.some((w) => w.includes('"Vendor.className"')),
    "an ordinary 'className' field must not be flagged as looking sensitive",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Vendor.ssn"')),
    "'ssn' must still be flagged -- it's a genuinely sensitive field name",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Vendor.userSSN"')),
    "'userSSN' must still be flagged",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Vendor.ssn_number"')),
    "'ssn_number' must still be flagged",
  );
  assert.equal(security.warnings.length, 3, "exactly the 3 genuinely sensitive-sounding fields should be flagged, not 'businessName'/'className' too");
});

/**
 * Regression test for a real bug found by a round 590 survey: the same
 * SENSITIVE_FIELD_HINTS array's bare "token" hint flagged fields via a
 * plain substring check (`lowerName.includes("token")`), so entirely
 * ordinary fields "tokenizer" and "detokenize" (lowercased:
 * "**token**izer", "de**token**ize") tripped a false "looks sensitive"
 * warning -- the exact same collision class as "secret"/"secretary" and
 * "ssn"/"businessName" fixed just above in this same array, left unfixed
 * on this sibling hint. Fixed the same way "secret" was: a regex against
 * the field's original, un-lowercased name, checking for a word-start
 * lowercase "token" or the capitalized "Token" form, each not immediately
 * followed by a lowercase letter.
 */
test("Security scan's 'token' hint doesn't spuriously flag 'tokenizer'/'detokenize', but still catches token/authToken/token_value", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Document",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "tokenizer", type: "text", required: false },
          { name: "detokenize", type: "text", required: false },
          { name: "token", type: "text", required: false },
          { name: "authToken", type: "text", required: false },
          { name: "token_value", type: "text", required: false },
        ],
      },
    ],
  };

  const security = runSecurityScan("proj1", spec);

  assert.ok(
    !security.warnings.some((w) => w.includes('"Document.tokenizer"')),
    "an ordinary 'tokenizer' field must not be flagged as looking sensitive",
  );
  assert.ok(
    !security.warnings.some((w) => w.includes('"Document.detokenize"')),
    "an ordinary 'detokenize' field must not be flagged as looking sensitive",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Document.token"')),
    "'token' must still be flagged -- it's a genuinely sensitive field name",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Document.authToken"')),
    "'authToken' must still be flagged",
  );
  assert.ok(
    security.warnings.some((w) => w.includes('"Document.token_value"')),
    "'token_value' must still be flagged",
  );
  assert.equal(security.warnings.length, 3, "exactly the 3 genuinely sensitive-sounding fields should be flagged, not 'tokenizer'/'detokenize' too");
});

/**
 * Real end-to-end proof of the same fix, run through the actual
 * runBuildPipeline a real build/refine uses (real migrations, real seed
 * data, every real agent step) rather than calling runSecurityScan in
 * isolation. A live browser click-through was deliberately not used for
 * this one: BuildProgress.tsx's own comment (search "never actually
 * reachable") documents that a SUCCESSFUL build's UI navigates away in the
 * very same tick the Forge step succeeds, right after Security -- so there
 * is no real moment a person could ever click "show details" on the
 * Security step of a build that succeeds. This test instead drains the
 * pipeline's own real event stream (exactly what the UI consumes) and reads
 * the Security event's `detail` directly, which is the only way to
 * genuinely observe it.
 */
test("a real build's Security step event never flags an ordinary 'secretary' field, and still flags 'secretKey'", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Employee",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "secretary", type: "text", required: false },
          { name: "secretKey", type: "text", required: false },
        ],
      },
    ],
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

  const events = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));
  const forge = events.find((e) => e.agent === "Forge");
  assert.ok(forge && forge.status === "success", "the build must genuinely succeed for this to be a meaningful check");

  const securityEvent = events.find((e) => e.agent === "Security" && e.status === "success");
  assert.ok(securityEvent, "the real pipeline must emit a completed Security step");
  const warnings = securityEvent!.detail as string[];

  assert.ok(
    !warnings.some((w) => w.includes('"Employee.secretary"')),
    "a real build must not flag the ordinary 'secretary' field as sensitive",
  );
  assert.ok(
    warnings.some((w) => w.includes('"Employee.secretKey"')),
    "a real build must still flag the genuinely sensitive-sounding 'secretKey' field",
  );
});

/**
 * Confirms the omitted-field record generateSeedRecords + delete produces
 * is otherwise genuinely valid -- if it weren't (e.g. a stray invalid value
 * on some other field), insertRecord would throw for the WRONG reason and
 * this check would misreport an unrelated failure as if it were the
 * intended required-field rejection.
 */
test("runQaChecks's per-required-field check omits only the field under test, leaving every other field validly filled", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Order",
        fields: [
          { name: "total", type: "number", required: true },
          { name: "placedOn", type: "date", required: true },
          { name: "status", type: "enum", required: true, enumValues: ["Pending", "Shipped"] },
        ],
      },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const qa = runQaChecks(db, "proj1", spec);

  assert.equal(qa.allPassed, true);
  const orderChecks = qa.results.find((r) => r.entity === "Order")!.checks;
  for (const fieldName of ["total", "placedOn", "status"]) {
    assert.ok(
      orderChecks.includes(`required-field validation enforced for "${fieldName}"`),
      `expected a real, correctly-attributed rejection for "${fieldName}", not a misattributed failure from some other field's seed value being invalid`,
    );
  }
});

/**
 * Round 753: a required "file" field is the one case the test just above
 * didn't cover -- generateSeedRecords (seed.ts) always leaves a "file"
 * field null (there's no real uploaded file to synthesize), so
 * runQaChecks' own validRecord baseline was NOT actually valid for every
 * other field when the entity had one, breaking the exact invariant the
 * comment above this function describes. Declaring the file field BEFORE
 * the field under test in entity.fields order reproduces the real bug:
 * coerceValue processes fields in array order and throws on the file
 * field first, so testing "signedDate" (deleting it) actually got
 * rejected for "attachment" instead -- and the old code only checked
 * `err instanceof ValidationError`, never which field the message
 * actually named, so it credited "signedDate" with a check that never
 * really ran.
 */
test("runQaChecks correctly attributes a required field's own check even when a required 'file' field is declared earlier on the same entity", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Contract",
        fields: [
          { name: "attachment", type: "file", required: true },
          { name: "signedDate", type: "date", required: true },
        ],
      },
    ],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const qa = runQaChecks(db, "proj1", spec);

  assert.equal(qa.allPassed, true);
  const contractChecks = qa.results.find((r) => r.entity === "Contract")!.checks;
  assert.ok(
    contractChecks.includes('required-field validation enforced for "attachment"'),
    "the required file field's own check must still be correctly attributed",
  );
  assert.ok(
    contractChecks.includes('required-field validation enforced for "signedDate"'),
    'signedDate\'s own required-check must be genuinely exercised and correctly attributed, not masked by "attachment" being rejected first',
  );
});

/**
 * Real end-to-end proof through the actual build pipeline (not just the
 * isolated runQaChecks call above): a real multi-required-field entity,
 * run through the genuine runBuildPipeline generator exactly as a real
 * build would, must reach a real QA "success" event whose own detail
 * shows every required field individually validated -- proving the fix
 * reaches the actual event stream BuildProgress.tsx renders, not just a
 * unit-tested function in isolation.
 */
test("a real build with a multi-required-field entity reaches a genuine QA success event covering every required field", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Applicant",
        fields: [
          { name: "fullName", type: "text", required: true },
          { name: "email", type: "text", required: true },
          { name: "role", type: "text", required: true },
        ],
      },
    ],
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

  const events = await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));

  const qaEvent = events.find((e) => e.agent === "QA" && e.status === "success");
  assert.ok(qaEvent, "a real build of a valid multi-required-field spec must reach a successful QA event");
  const applicantChecks = (qaEvent!.detail as { entity: string; checks: string[] }[]).find((r) => r.entity === "Applicant")!.checks;
  for (const fieldName of ["fullName", "email", "role"]) {
    assert.ok(
      applicantChecks.includes(`required-field validation enforced for "${fieldName}"`),
      `the real build's own QA event must show "${fieldName}" individually validated, not just the first required field`,
    );
  }
});

test("runQaChecks reports an entity with no required fields as having nothing to validate, without touching insertRecord", () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Tag", fields: [{ name: "label", type: "text", required: false }] }],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, "proj1", spec);

  const qa = runQaChecks(db, "proj1", spec);

  assert.equal(qa.allPassed, true);
  assert.deepEqual(qa.results.find((r) => r.entity === "Tag")!.checks, [
    "list endpoint returns data without error",
    "no required fields to validate",
  ]);
  assert.equal(countRecords(db, "proj1", spec.entities[0]), 0, "a QA smoke test must never leave a real row behind in the entity's own table");
});

/**
 * Round 787: describeImpactHazards is architectEvent's own "Warning: ..."
 * clauses extracted into a standalone, directly-testable function, reused
 * by the checkpoint-restore route (routes/projects.ts) which has no
 * "Impact: +N new entities..." headline of its own to attach them to.
 */
test("describeImpactHazards reports a removed entity, a removed field, and a tightened field all at once", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "text", required: false },
          { name: "phone", type: "text", required: false },
        ],
      },
      { name: "Invoice", fields: [{ name: "total", type: "number", required: true }] },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        name: "Customer",
        fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: true }],
      },
    ],
  };

  const hazards = describeImpactHazards(previousSpec, nextSpec);
  assert.match(hazards, /entities are no longer in the spec \(Invoice\)/);
  assert.match(hazards, /Customer lost field\(s\): phone/);
  assert.match(hazards, /Customer now enforces stricter rules on: email/);
});

test("describeImpactHazards returns an empty string when nothing structurally hazardous changed", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  };
  // A brand-new field being ADDED is never a hazard -- only removed/
  // tightened fields and removed entities are.
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "phone", type: "text", required: false }] }],
  };

  assert.equal(describeImpactHazards(previousSpec, previousSpec), "", "identical specs must report no hazards");
  assert.equal(describeImpactHazards(previousSpec, nextSpec), "", "a purely additive change (a new optional field) must report no hazards");
});

/**
 * Round 947: ProductSpecSchema's case-insensitive-duplicate check only
 * rejects a collision WITHIN one spec, so an ordinary refine can genuinely
 * regenerate a field (or entity) whose name only changed letter case (e.g.
 * "email" -> "Email") -- the exact scenario migrate.ts had to harden
 * against across rounds 617-620, since it's the same physical SQLite
 * column, same data, a true no-op. Before this fix, computeImpact's own
 * exact-string name matching missed that case-only rename in BOTH
 * directions at once, reporting the SAME field as newly added AND removed
 * -- which this function turns into a false, alarming "lost field(s) --
 * data no longer reachable" warning for a change that loses nothing.
 */
test("describeImpactHazards reports no hazard at all for a field or entity renamed only by letter case, since it's the same physical column/table per migrate.ts's own treatment", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      { name: "customer", fields: [{ name: "email", type: "text", required: false }] },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [{ name: "Customer", fields: [{ name: "Email", type: "text", required: false }] }],
  };

  assert.equal(
    describeImpactHazards(previousSpec, nextSpec),
    "",
    "a case-only entity/field rename alone must report no hazard -- it is a true no-op, not a loss",
  );
});

test("describeImpactHazards still reports a genuinely tightened field even when it was ALSO renamed only by letter case, instead of masking the real change as a false add+remove", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: false }] }],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "Email", type: "text", required: true }] }],
  };

  const hazards = describeImpactHazards(previousSpec, nextSpec);
  assert.match(hazards, /Customer now enforces stricter rules on: Email/);
  assert.doesNotMatch(hazards, /lost field/, "a case-only rename that also genuinely tightened must never be reported as a lost field too");
});

/**
 * Round 947: carryForwardLabels' own counterpart to the describeImpactHazards
 * tests above -- a case-only entity/field rename must still carry the
 * user's own prior label forward, the exact same label-loss regression
 * class rounds 915/917 fixed for an identically-cased refine, just reopened
 * via the case-rename path neither of those rounds considered.
 */
test("carryForwardLabels keeps a surviving entity's/field's own prior label across a refine that renames either one only by letter case", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      { name: "customer", label: "Clients", fields: [{ name: "email", type: "text", required: false, label: "Email Address" }] },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [{ name: "Customer", fields: [{ name: "Email", type: "text", required: false }] }],
  };

  carryForwardLabels(previousSpec, nextSpec);

  const customer = nextSpec.entities[0];
  assert.equal(customer.label, "Clients", "a case-only renamed entity must still keep its own prior label");
  assert.equal(customer.fields[0].label, "Email Address", "a case-only renamed field must still keep its own prior label");
});

/**
 * Round 915's finding: SpecProvider.generate (both HeuristicSpecProvider
 * and AnthropicSpecProvider) has no previousSpec parameter at all, so a
 * freshly regenerated nextSpec never carries a user's post-build
 * EntityLabelEditor/FieldLabelEditor customization forward -- every
 * /refine silently reverted it, with no hazard warning anywhere.
 * carryForwardLabels mirrors diffAndMigrate's own name-matching
 * convention: an entity/field that survives a refine under the same name
 * keeps its own prior label (and an enum field's own prior enumLabels).
 */
test("carryForwardLabels keeps a surviving entity's/field's own prior label (and an enum field's own prior enumLabels), but never invents one for a genuinely new entity/field", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        label: "Clients",
        fields: [
          { name: "name", type: "text", required: true, label: "Full Name" },
          { name: "status", type: "enum", required: true, enumValues: ["Active", "Inactive"], enumLabels: { Active: "פעיל", Inactive: "לא פעיל" } },
        ],
      },
    ],
  };
  // Simulates a fresh regeneration: the same two entities/fields by name,
  // but with none of the customized labels (exactly what
  // HeuristicSpecProvider/AnthropicSpecProvider actually produce, since
  // neither has any way to know about a prior customization), plus one
  // genuinely NEW entity and NEW field this refine actually added.
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "status", type: "enum", required: true, enumValues: ["Active", "Inactive"] },
          { name: "notes", type: "longtext", required: false },
        ],
      },
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
    ],
  };

  carryForwardLabels(previousSpec, nextSpec);

  const customer = nextSpec.entities.find((e) => e.name === "Customer")!;
  assert.equal(customer.label, "Clients", "a surviving entity must keep its own prior label");
  const nameField = customer.fields.find((f) => f.name === "name")!;
  assert.equal(nameField.label, "Full Name", "a surviving field must keep its own prior label");
  const statusField = customer.fields.find((f) => f.name === "status")!;
  assert.deepEqual(statusField.enumLabels, { Active: "פעיל", Inactive: "לא פעיל" }, "a surviving enum field must keep its own prior enumLabels");

  const notesField = customer.fields.find((f) => f.name === "notes")!;
  assert.equal(notesField.label, undefined, "a genuinely NEW field has no prior label to carry forward");
  const order = nextSpec.entities.find((e) => e.name === "Order")!;
  assert.equal(order.label, undefined, "a genuinely NEW entity has no prior label to carry forward");
});

/**
 * Round 917's finding: the test just above keeps the enum field's own
 * enumValues IDENTICAL across the refine -- it never exercises the far
 * more common everyday case of a refine that adds/removes/renames one of
 * that same field's own options (round 887's own named hazard class),
 * which the original carryForwardLabels (round 915) got wrong: it copied
 * the ENTIRE prior enumLabels map verbatim, discarding the fresh
 * generation's own correct label for a genuinely NEW value and leaving a
 * stale label behind for a removed one. Confirms the fix merges instead:
 * an unchanged value keeps its own PRIOR label, a brand-new value keeps
 * whatever label the fresh generation already supplied for it.
 */
test("carryForwardLabels merges enumLabels by value when a refine changes that same field's own enumValues, instead of overwriting the fresh generation's own labels wholesale", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Order",
        fields: [
          {
            name: "status",
            type: "enum",
            required: true,
            enumValues: ["pending", "shipped"],
            enumLabels: { pending: "ממתין", shipped: "נשלח" },
          },
        ],
      },
    ],
  };
  // Simulates exactly what the real HeuristicSpecProvider/
  // AnthropicSpecProvider actually produce for a refine instruction like
  // "add a cancelled status" -- a fresh, complete enumLabels for the NEW
  // value set, correctly including the brand-new value's own label.
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        name: "Order",
        fields: [
          {
            name: "status",
            type: "enum",
            required: true,
            enumValues: ["pending", "shipped", "cancelled"],
            enumLabels: { pending: "ממתין", shipped: "נשלח", cancelled: "בוטל" },
          },
        ],
      },
    ],
  };

  carryForwardLabels(previousSpec, nextSpec);

  const statusField = nextSpec.entities[0].fields[0];
  assert.deepEqual(
    statusField.enumLabels,
    { pending: "ממתין", shipped: "נשלח", cancelled: "בוטל" },
    "unchanged values keep their own prior label, and the brand-new value keeps the fresh generation's own label for it -- neither gets lost",
  );
});

/**
 * The symmetric case: a refine that REMOVES one of the field's own
 * options must not leave that removed value's stale label sitting in the
 * persisted enumLabels map.
 */
test("carryForwardLabels drops a removed enum value's own stale label, rather than leaving it behind forever", () => {
  const previousSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Order",
        fields: [
          {
            name: "status",
            type: "enum",
            required: true,
            enumValues: ["pending", "shipped", "cancelled"],
            enumLabels: { pending: "ממתין", shipped: "נשלח", cancelled: "בוטל" },
          },
        ],
      },
    ],
  };
  const nextSpec: ProductSpec = {
    ...previousSpec,
    entities: [
      {
        name: "Order",
        fields: [
          { name: "status", type: "enum", required: true, enumValues: ["pending", "shipped"], enumLabels: { pending: "ממתין", shipped: "נשלח" } },
        ],
      },
    ],
  };

  carryForwardLabels(previousSpec, nextSpec);

  const statusField = nextSpec.entities[0].fields[0];
  assert.deepEqual(statusField.enumLabels, { pending: "ממתין", shipped: "נשלח" }, "the removed value's own stale label must not survive");
});

test("carryForwardLabels is a harmless no-op for a plain /build (no previousSpec)", () => {
  const nextSpec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
  };
  carryForwardLabels(undefined, nextSpec);
  assert.equal(nextSpec.entities[0].label, undefined);
});

/**
 * End-to-end through the real pipeline (not just the unit-level function
 * above): a label set via EntityLabelEditor's own real route survives an
 * unrelated refine that regenerates the entity from scratch with no label
 * at all -- exactly the reachable sequence round 915 found: rename an
 * entity's label, then make ANY unrelated refine, and the rename used to
 * vanish silently.
 */
test("a real refine through runBuildPipeline preserves an entity's previously-set label, even though the freshly regenerated nextSpec has none", async () => {
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Customer", label: "Clients", fields: [{ name: "name", type: "text", required: true }] }],
  };
  const db = openDatabase(":memory:");
  ensureProjectsTable(db);
  ensureCheckpointsTable(db);
  const project = insertProject(db, { id: "proj1", ownerId: "user1", name: "test", description: "test", spec });
  await collect(runBuildPipeline(db, project, { nextSpec: spec, changeLabel: "Initial build" }));

  // The freshly regenerated spec for this refine, exactly as the real
  // HeuristicSpecProvider/AnthropicSpecProvider would actually produce it
  // -- the same entity by name, a genuinely new field, but no label at
  // all (neither provider has any way to know "Clients" was ever set).
  const refinedSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "notes", type: "longtext", required: false },
        ],
      },
    ],
  };
  const events = await collect(runBuildPipeline(db, project, { previousSpec: spec, nextSpec: refinedSpec, changeLabel: "Refine: add notes" }));

  const forgeEvent = events.find((e) => e.agent === "Forge");
  assert.ok(forgeEvent, "pipeline should reach the Forge finalize step");
  assert.equal(forgeEvent!.status, "success");
  const finalProject = (forgeEvent!.detail as { project: Project }).project;
  assert.equal(
    finalProject.spec.entities[0].label,
    "Clients",
    "the previously-set label must survive this unrelated refine, not silently revert to unset",
  );
});

/**
 * Round 977: diffAndMigrate's own type_changed detection (migrate.ts) is
 * deliberately additive-only -- it never touches a retyped field's
 * existing column DATA -- but a field moving AWAY from "file" leaves every
 * record's old upload permanently unreachable garbage, since
 * deleteReplacedFileFields (routes/projects.ts, the only other cleanup
 * mechanism for a file-field upload) only ever matches the field's CURRENT
 * type. Direct unit coverage of the new cleanup helper itself, separate
 * from app.test.ts's own end-to-end checkpoint-restore test for the same
 * fix.
 */
test("cleanupFileFieldsRetypedAway deletes real uploads for columns that retyped away from 'file', and leaves everything else alone", async () => {
  const uploadsDir = mkdtempSync(path.join(tmpdir(), "forge-pipeline-cleanup-test-"));
  const projectId = "proj1";
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
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
  const db = openDatabase(":memory:");
  applyMigrations(db, projectId, spec);

  const fileDir = path.join(uploadsDir, projectId, "Document");
  mkdirSync(fileDir, { recursive: true });

  const realFilename = `${randomUUID()}.pdf`;
  const realFilePath = path.join(fileDir, realFilename);
  writeFileSync(realFilePath, "%PDF-fake-contents");
  insertRecord(db, projectId, spec.entities[0], {
    title: "Contract",
    attachment: JSON.stringify({ url: `/api/uploads/${projectId}/Document/${realFilename}`, name: "contract.pdf", size: 19, mimeType: "application/pdf" }),
  });

  // A record whose "attachment" was never a real file descriptor at all
  // (e.g. the field was blank, or a value written AFTER a later retype
  // under some other new type) -- deleteUploadedFile's own JSON-shape
  // check must no-op on this rather than throwing.
  insertRecord(db, projectId, spec.entities[0], { title: "No attachment", attachment: null });

  const nextSpec: ProductSpec = {
    ...spec,
    entities: [
      {
        name: "Document",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "attachment", type: "text", required: false },
        ],
      },
    ],
  };
  const changes = diffAndMigrate(db, projectId, spec, nextSpec);
  assert.ok(
    changes.some((c) => c.type === "type_changed" && c.entityName === "Document" && c.fromType === "file" && c.toType === "text"),
    "expected diffAndMigrate to report the exact type_changed entry this fix depends on",
  );

  await cleanupFileFieldsRetypedAway(db, uploadsDir, projectId, changes);

  assert.equal(existsSync(realFilePath), false, "the real orphaned upload must actually be deleted from disk");
});

test("cleanupFileFieldsRetypedAway is a no-op when no field retyped away from 'file'", async () => {
  const uploadsDir = mkdtempSync(path.join(tmpdir(), "forge-pipeline-cleanup-test-"));
  const projectId = "proj1";
  const spec: ProductSpec = {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [{ name: "Document", fields: [{ name: "title", type: "text", required: true }] }],
  };
  const db = openDatabase(":memory:");
  applyMigrations(db, projectId, spec);

  const fileDir = path.join(uploadsDir, projectId, "Document");
  mkdirSync(fileDir, { recursive: true });
  const filename = `${randomUUID()}.pdf`;
  const filePath = path.join(fileDir, filename);
  writeFileSync(filePath, "%PDF-fake-contents");

  // No type_changed entries at all -- a plain additive refine.
  const nextSpec: ProductSpec = {
    ...spec,
    entities: [{ name: "Document", fields: [{ name: "title", type: "text", required: true }, { name: "notes", type: "longtext", required: false }] }],
  };
  const changes = diffAndMigrate(db, projectId, spec, nextSpec);

  await cleanupFileFieldsRetypedAway(db, uploadsDir, projectId, changes);

  assert.equal(existsSync(filePath), true, "a file with no matching type_changed entry must never be touched");
});
