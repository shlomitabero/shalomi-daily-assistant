# Roadmap

Full-vision execution is deliberately staged. Building all ~100 sections of
the founding spec at once produces an impressive-looking surface with no
working application underneath it; this repository instead proves one
narrow vertical slice for real before widening.

## Phase 1 — World-class MVP foundation (this repository, today)

- [x] Natural-language idea input
- [x] Product Spec generation (heuristic offline provider + real Anthropic
      provider, auto-selected by whether `ANTHROPIC_API_KEY` is configured)
- [x] "What I understood" review screen: summary, roles, entities,
      assumptions, open questions with quick-pick answers
- [x] Real generated database schema (SQLite, one table per entity, typed
      columns, foreign keys for relations)
- [x] Generic, working CRUD API validated against the generated schema
- [x] Live preview UI: per-entity list + create/edit/delete forms, generated
      from field metadata
- [x] Unit + integration test coverage (spec generation, migrations,
      repository, full API acceptance flow)
- [ ] Authentication / workspaces — **not yet implemented**
- [ ] Git repository per project, checkpoints — **not yet implemented**
- [ ] Deployment (Vercel/Docker) — **not yet implemented**
- [ ] Browser QA agent — verified manually with Playwright this session;
      not yet automated as part of the build flow

### MVP acceptance scenario this slice targets

> "Build an appointment-management application for a beauty clinic. I need
> customers, appointments, employees, services, an admin dashboard and
> automatic appointment status tracking."

Verified end-to-end (automated in `apps/api/src/app.test.ts`, and manually
via Playwright against the real UI): idea → generated spec with the correct
four entities and roles → real SQLite tables created → create/list/update/
delete records through the generated UI, backed by the real API.

## Phase 2

- Real authentication + multi-tenant workspaces
- Multi-agent architecture with visible parallel execution (PM, architect,
  frontend, backend, QA, security as distinct steps with structured
  hand-offs, not one prompt doing everything)
- Actual generated, exportable codebases (Next.js/React) per project instead
  of the shared generic CRUD engine — this is what makes "your app, your
  code" (section 11 of the vision) true
- Git integration (bidirectional sync, checkpoints/Time Machine)
- Visual editor over the generated UI
- Integration marketplace (Stripe, email, etc.)
- Real database migration diffing with a destructive-change guard

## Phase 3

- Self-healing: production observability, automatic diagnosis and patch
  proposals for detected regressions
- Business analytics / outcome engine
- Cost governor + scale simulator
- MCP capability layer generated per project
- Feedback-to-feature pipeline

## Phase 4

- Template/agent marketplace
- Mobile app generation
- Enterprise features (SSO, audit log, private deployment, data residency)
- Multi-app "Business Brain" spanning a company's whole app ecosystem

Each phase assumes the previous one is genuinely working, not merely
scaffolded — see `docs/ADR/0001-initial-architecture.md` for the specific
tradeoffs made to keep Phase 1 real rather than broad.
