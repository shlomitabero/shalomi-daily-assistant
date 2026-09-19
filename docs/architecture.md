# Architecture

## Monorepo layout

```
apps/
  api/    Express + TypeScript backend
  web/    Vite + React + TypeScript frontend
packages/
  shared/       Zod schemas + inferred types shared by every workspace
                (ProductSpec, Entity, Field, Project, User, Checkpoint, AgentStepEvent)
  spec-engine/  Idea -> ProductSpec generation (heuristic + Anthropic providers)
  db/           SQLite persistence: migrations-from-spec, generic CRUD repository,
                auth (users/sessions), Time Machine (checkpoints)
docs/
  ADR/          Architecture Decision Records
```

npm workspaces wire the packages together; there is no separate build step
in dev — `tsx` transpiles TypeScript (including workspace package sources)
at import time. `apps/web` builds normally through `tsc -b && vite build`.

## Request flow

```
Browser (apps/web)
   │  POST /api/auth/signup or /api/auth/login
   ▼
Express issues a bearer session token (packages/db: users, sessions tables)
   │  every subsequent request carries Authorization: Bearer <token>
   ▼
   │  POST /api/projects { description }
   ▼
Express (apps/api), behind requireAuth middleware
   │  generateSpec(description)  — packages/spec-engine
   │    → AnthropicSpecProvider   (if ANTHROPIC_API_KEY set)
   │    → HeuristicSpecProvider   (offline fallback, always available)
   │  insertProject(..., ownerId: req.userId)  — packages/db (projects table)
   ▼
Browser shows the generated ProductSpec ("What I understood")
   │  POST /api/projects/:id/build   (Server-Sent Events response)
   ▼
runBuildPipeline(db, project, { nextSpec }) — apps/api/src/pipeline.ts
   Architect   → describes the plan (table/relation counts, or the impact
                 of a refine: new entities / new fields on existing ones)
   Database    → diffAndMigrate(...) — packages/db; real CREATE TABLE /
                 ALTER TABLE ADD COLUMN statements, additive-only
   Seed Data   → generateSeedRecords(...) inserted via the real repository
                 validation path for every newly created table
   QA          → real smoke tests: list endpoint doesn't throw, a required
                 field is genuinely rejected on insert — a failure here
                 stops the build from publishing
   Security    → a real static scan (reserved-SQL-word collisions,
                 plaintext fields that look like secrets) with a real score
   Forge       → persists the spec, marks the project built, saves a
                 Time Machine checkpoint
   Each step is streamed to the browser the moment it completes.
   ▼
Browser renders a generic CRUD UI per entity (EntityPanel.tsx), backed by
   GET/POST/PATCH/DELETE /api/projects/:id/entities/:entityName(/:id)
   which validate against the entity's field definitions (required fields,
   enum membership, type coercion) before touching SQLite.
   ▼
   │  POST /api/projects/:id/refine { instruction }   (also SSE)
   ▼
Same pipeline, called with { previousSpec: project.spec, nextSpec: <regenerated> } —
   the Architect step reports the impact, Database applies only the diff,
   Seed Data seeds only the newly created tables, existing data is untouched.
   ▼
   │  GET /api/projects/:id/checkpoints
   │  POST /api/projects/:id/checkpoints/:id/restore
   ▼
Time Machine: every build/refine's resulting spec is snapshotted
   (packages/db checkpoints table); restoring moves the project's spec
   pointer to an older snapshot. Always safe — see "additive-only
   migrations" below.
```

## Key design decisions

See `docs/ADR/0001-initial-architecture.md` for the original Phase 1
decisions (generic CRUD engine vs. generated codebases, `node:sqlite`,
provider seam) and `docs/ADR/0002-auth-pipeline-time-machine.md` for auth,
the pipeline's shape, and additive-only migrations. Summary:

- **Model routing seam, not a full router.** `selectProvider()` in
  `packages/spec-engine` picks Anthropic when `ANTHROPIC_API_KEY` is set,
  otherwise a deterministic offline heuristic.
- **`node:sqlite` over `better-sqlite3`** — no native-module build step.
- **One generic CRUD engine, not per-project generated code** — real schema,
  real persistence, real validation, but not yet an exportable codebase.
- **Bearer-token sessions**, `scrypt`-hashed passwords, a 404 (not 403) on
  another user's project to avoid confirming its existence.
- **The agent pipeline is a sequential async generator streamed as SSE over
  a plain `fetch`** (not `EventSource`, which can't carry a custom
  `Authorization` header) — not yet the fully parallel, dependency-graph
  team the long-term vision describes.
- **Migrations are additive-only**: a table or column, once created, is
  never dropped or renamed by this engine. This is what makes Time Machine
  restores unconditionally safe.
- **SQL-injection safety.** Table/column names are never string-concatenated
  from raw user or model input. `packages/db/src/identifiers.ts` sanitizes
  project IDs and entity names into a safe identifier, and asserts (rather
  than sanitizes) field/column names — a field name that isn't already a
  safe identifier is rejected outright. All *row values* go through
  parameterized `?` placeholders regardless.
- **No framework beyond Express/React.** Kept intentionally boring so the
  vertical slice is easy to read end-to-end in one sitting.

## Testing strategy

- `packages/spec-engine`: unit tests for the heuristic provider's entity/role
  detection, and for the Anthropic provider's response parsing (fenced JSON,
  malformed JSON, non-2xx responses) using a fake `fetch` — no network or API
  key required to run the suite.
- `packages/db`: unit tests for migration SQL generation (including additive
  diffing — new tables, new nullable columns, existing data surviving), the
  generic repository's CRUD + validation behavior, and seed-record
  generation, all against an in-memory SQLite database.
- `apps/api`: integration tests that boot a real Express server on an
  ephemeral port and drive the full MVP acceptance scenario through plain
  `fetch`, including: signup/login/duplicate-email/wrong-password, a second
  user being unable to see or act on the first user's project, the full
  streaming build pipeline (asserting every agent reports in and none
  fail), seed data actually landing, generic CRUD, a natural-language
  refine that adds a new entity without touching existing data, and
  checkpoint listing/restore.
- End-to-end: manually verified with Playwright driving the built UI in a
  real Chromium instance — signup → describe → watch the AI Team build →
  seeded data appears → Time Machine shows the checkpoint → refine adds new
  entity tabs live → restoring the initial checkpoint makes them disappear
  again. Not yet wired into CI (see roadmap).
