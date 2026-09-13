# Forge AI

**Describe your business. Get your software company.**

*(Working name — temporary, and not hard-coded into the product.)*

Forge AI is an AI software creation platform. The goal — described in full
in `docs/product-vision.md` — is to be materially more than "prompt → code →
preview": a system that understands a business, generates a real
specification, builds a real working application, verifies it, and keeps
operating it after launch. That's a multi-year vision; this repository
contains a genuinely working **Phase 1** vertical slice of it, not a demo of
the whole thing.

## What actually works right now

1. Type a business description in plain language (e.g. *"Build an
   appointment-management application for a beauty clinic. I need
   customers, appointments, employees, services, an admin dashboard and
   automatic appointment status tracking."*).
2. Forge AI generates a real **Product Spec**: roles, entities, fields,
   screens, stated assumptions, and open questions with one-click answers.
   This uses a real Claude API call when `ANTHROPIC_API_KEY` is configured,
   and a deterministic offline heuristic generator otherwise — so the whole
   thing runs with zero configuration.
3. Click **Build App** — Forge AI creates a real SQLite schema: one table
   per entity, typed columns, foreign keys for relations.
4. You get a live, working UI: a tab per entity with a generated
   create/edit/delete form and table, backed by a real validated CRUD API —
   not mock data.

**What this is not (yet):** authentication/multi-tenancy, an exportable
per-project codebase, Git integration, deployment, multi-agent
orchestration, or self-healing. See `docs/roadmap.md` for the phased plan
and exactly what's deferred and why.

## Architecture

```
apps/
  api/    Express + TypeScript backend
  web/    Vite + React + TypeScript frontend
packages/
  shared/       Shared Zod schemas/types (ProductSpec, Entity, Field, Project)
  spec-engine/  Idea -> ProductSpec (Anthropic provider + offline heuristic fallback)
  db/           SQLite: schema-from-spec migrations + generic CRUD repository
docs/           Product vision, architecture, data model, security, roadmap, ADRs
```

See `docs/architecture.md` for the full request flow and the reasoning
behind each major decision (why `node:sqlite`, why a generic CRUD engine
instead of generated codebases yet, why the provider seam is two-way today).

## Running it

```bash
npm install                       # installs every workspace
npm run dev                       # api on :4000, web on :5173 (proxies /api)
```

Open http://localhost:5173. No environment variables or external services
are required — without `ANTHROPIC_API_KEY` set, spec generation falls back
to the offline heuristic provider automatically.

To use real Claude-generated specs instead of the heuristic:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev:api
```

**Production build:**

```bash
npm run build     # builds apps/web/dist
npm start          # builds, then serves the API on :4000 (see apps/api/src/server.ts)
```

Set `DB_PATH` to change where the SQLite file lives (default:
`apps/api/data/forge.sqlite`).

**Tests:**

```bash
npm test    # spec-engine, db, and api test suites
```

All three suites are self-contained (in-memory SQLite, a faked `fetch` for
the Anthropic provider) — no network access or API key required to run
them.

## Security

Read `docs/security.md` before deploying this anywhere reachable by
untrusted users — Phase 1 has no authentication and assumes a single
trusted workspace.
