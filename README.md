# Forge AI

**Describe your business. Get your software company.**

*(Working name — temporary, and not hard-coded into the product.)*

Forge AI is an AI software creation platform. The goal — described in full
in `docs/product-vision.md` — is to be materially more than "prompt → code →
preview": a system that understands a business, generates a real
specification, builds a real working application with a visible AI team,
verifies it, and keeps improving it after launch. That's a multi-year
vision; this repository contains a genuinely working slice of it, not a
demo of the whole thing.

The web UI itself is in Hebrew (RTL) end-to-end, since that's this project's
actual audience today. When you describe a business in Hebrew, the offline
heuristic spec generator also returns Hebrew entity/field names and status
values (e.g. "לקוחות" instead of "Customer") while keeping ASCII identifiers
internally for the real SQL schema — see `packages/spec-engine/src/domainEntities.ts`.

## What actually works right now

1. **Sign up** (email/password) — every project belongs to your account;
   another account can't see or touch it.
2. **Describe a business** in plain language (e.g. *"Build an
   appointment-management application for a beauty clinic. I need
   customers, appointments, employees, services, an admin dashboard and
   automatic appointment status tracking."*). Forge AI generates a real
   **Product Spec**: roles, entities, fields, screens, stated assumptions,
   and open questions with one-click answers — using a real Claude API call
   when `ANTHROPIC_API_KEY` is configured, and a deterministic offline
   heuristic generator otherwise, so the whole thing runs with zero
   configuration.
3. **Click Build App** and watch the **AI Team** actually work, live: an
   Architect agent plans the schema, a Database agent applies a real
   migration, a Seed Data agent inserts real sample records, a QA agent
   runs real smoke tests (and stops the build if one fails), and a Security
   agent runs a real static scan with a real score. Every step is
   genuine, checkable work — not a progress bar standing in for nothing.
4. **Use the generated app**: a tab per entity with a create/edit/delete
   form and table, backed by a real validated CRUD API — not mock data.
5. **Improve it in plain language.** Type "Also track invoices for
   customers" into the Refine box and the same AI Team runs again: it
   re-derives the spec, works out exactly what's new, and applies only
   that — your existing data is never touched.
6. **Time Machine.** Every build and refine saves a checkpoint. Open
   History to see them and restore any earlier version — always safe,
   because this engine's migrations only ever add tables/columns, never
   drop them.

**What this is not (yet):** an exportable per-project codebase, Git
integration, deployment, fully parallel multi-agent orchestration, or
self-healing in production. See `docs/roadmap.md` for the phased plan and
exactly what's deferred and why.

## Architecture

```
apps/
  api/    Express + TypeScript backend
  web/    Vite + React + TypeScript frontend
packages/
  shared/       Shared Zod schemas/types (ProductSpec, Entity, Field, Project, User, Checkpoint, AgentStepEvent)
  spec-engine/  Idea -> ProductSpec (Anthropic provider + offline heuristic fallback)
  db/           SQLite: schema-from-spec migrations, generic CRUD repository, auth, Time Machine
docs/           Product vision, architecture, data model, security, roadmap, ADRs
```

See `docs/architecture.md` for the full request flow and the reasoning
behind each major decision, and `docs/ADR/` for why auth works the way it
does, why the pipeline is a sequence (not yet parallel), and why migrations
are additive-only.

## Running it

```bash
npm install                       # installs every workspace
npm run dev                       # api on :4000, web on :5173 (proxies /api)
```

Open http://localhost:5173, sign up with any email/password (8+ chars), and
describe something you want to build. No environment variables or external
services are required — without `ANTHROPIC_API_KEY` set, spec generation
falls back to the offline heuristic provider automatically.

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

## Getting a live link (no coding required)

The app isn't hosted anywhere by default — it only runs when someone starts
it, like in this development session. The simplest way to get a real web
link you can open from any phone or browser, free, without installing
anything:

1. Go to **render.com** and sign up (you can use your GitHub account).
2. Click **New +** → **Blueprint**, and connect this GitHub repository.
   Render reads `render.yaml` in this repo and fills in everything by
   itself — you don't need to configure anything technical.
3. Click **Deploy**. After a few minutes you'll get a URL like
   `https://forge-ai.onrender.com` — that's your live link. Open it, sign
   up, and start describing what you want to build.

Notes: the free tier sleeps after inactivity (the first open after a while
takes ~30 seconds to wake up), and its storage isn't permanent — a redeploy
or restart resets everything back to a fresh start. That's fine for trying
it out or sharing with someone; a real long-term product would need a
persistent database and is listed on the roadmap.

**Tests:**

```bash
npm test    # spec-engine, db, and api test suites
```

All three suites are self-contained (in-memory SQLite, a faked `fetch` for
the Anthropic provider) — no network access or API key required to run
them.

## Security

Read `docs/security.md` before deploying this anywhere reachable by
untrusted users. Auth and per-owner isolation are real (see
`apps/api/src/app.test.ts`'s cross-user test), but there's no rate
limiting, email verification, or password reset yet.
