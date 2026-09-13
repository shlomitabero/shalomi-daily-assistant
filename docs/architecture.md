# Architecture

## Monorepo layout

```
apps/
  api/    Express + TypeScript backend
  web/    Vite + React + TypeScript frontend
packages/
  shared/       Zod schemas + inferred types shared by every workspace (ProductSpec, Entity, Field, Project)
  spec-engine/  Idea -> ProductSpec generation (heuristic + Anthropic providers)
  db/           SQLite persistence: migrations-from-spec, generic CRUD repository
docs/
  ADR/          Architecture Decision Records
```

npm workspaces wire the packages together; there is no separate build step
in dev — `tsx` transpiles TypeScript (including workspace package sources)
at import time. `apps/web` builds normally through `tsc -b && vite build`.

## Request flow (what exists today)

```
Browser (apps/web)
   │  POST /api/projects { description }
   ▼
Express (apps/api)
   │  generateSpec(description)  — packages/spec-engine
   │    → AnthropicSpecProvider   (if ANTHROPIC_API_KEY set)
   │    → HeuristicSpecProvider   (offline fallback, always available)
   │  insertProject(...)          — packages/db (projects table)
   ▼
Browser shows the generated ProductSpec ("What I understood")
   │  POST /api/projects/:id/build
   ▼
applyMigrations(db, projectId, spec) — packages/db
   creates one real SQLite table per entity, columns from field types,
   foreign keys for relation fields that point at another entity in the
   same spec.
   ▼
Browser renders a generic CRUD UI per entity (EntityPanel.tsx), backed by
   GET/POST/PATCH/DELETE /api/projects/:id/entities/:entityName(/:id)
   which validate against the entity's field definitions (required fields,
   enum membership, type coercion) before touching SQLite.
```

## Key design decisions

- **Model routing seam, not a full router.** `selectProvider()` in
  `packages/spec-engine` picks Anthropic when `ANTHROPIC_API_KEY` is set,
  otherwise a deterministic offline heuristic. This is the seam section 31
  of the product vision ("Model Router") will grow from — today it is a
  two-way choice, intentionally not more, so it stays testable without
  network access or credentials.
- **`node:sqlite` over `better-sqlite3`.** Node 22 ships a synchronous
  SQLite driver in core (`node:sqlite`, still flagged experimental
  upstream). Using it avoids a native-module build step, which matters in
  sandboxed dev/CI environments and keeps "clone and run" true with zero
  system dependencies. See ADR 0001.
- **One generic CRUD engine, not per-project generated code.** Rather than
  generating and compiling a bespoke React/Next.js codebase per project
  (which needs a sandboxed build pipeline, hosting, and a Git-backed
  workspace per app — all Phase 2+ concerns), Phase 1 generates a *real
  SQL schema* and exposes a metadata-driven CRUD engine + UI over it. This
  is an honest, working simplification: real persistence, real validation,
  real APIs — not a mock. It is clearly out of scope to call this "your own
  exportable codebase" (see roadmap.md, Phase 2's "Own Your Code" promise).
- **SQL-injection safety.** Table/column names are never string-concatenated
  from raw user or model input. `packages/db/src/identifiers.ts` sanitizes
  project IDs and entity names into a safe identifier, and asserts (rather
  than sanitizes) field/column names — a field name that isn't already a
  safe identifier is rejected outright, since silently mangling a column
  name a user typed would be more confusing than failing loudly. All *row
  values* go through parameterized `?` placeholders regardless.
- **No framework beyond Express/React.** Kept intentionally boring so the
  vertical slice is easy to read end-to-end in one sitting.

## Testing strategy

- `packages/spec-engine`: unit tests for the heuristic provider's entity/role
  detection, and for the Anthropic provider's response parsing (fenced JSON,
  malformed JSON, non-2xx responses) using a fake `fetch` — no network or API
  key required to run the suite.
- `packages/db`: unit tests for migration SQL generation (including that
  unsafe identifiers are rejected/sanitized rather than reaching raw SQL)
  and for the generic repository's CRUD + validation behavior against an
  in-memory SQLite database.
- `apps/api`: integration tests that boot a real Express server on an
  ephemeral port and drive the exact MVP acceptance scenario (see
  `docs/roadmap.md`) through plain `fetch`, including the "reject writes
  before build" and "reject a record missing a required field" cases.
- End-to-end: manually verified with Playwright driving the built UI in a
  real Chromium instance (idea → spec → build → add/edit/delete a record
  across tabs); not yet wired into CI (see roadmap).
