# Roadmap

Full-vision execution is deliberately staged. Building all ~100 sections of
the founding spec at once produces an impressive-looking surface with no
working application underneath it; this repository instead proves one
narrow vertical slice for real, then widens it deliberately.

## Phase 1 — World-class MVP foundation

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

### MVP acceptance scenario this phase targets

> "Build an appointment-management application for a beauty clinic. I need
> customers, appointments, employees, services, an admin dashboard and
> automatic appointment status tracking."

Verified end-to-end (automated in `apps/api/src/app.test.ts`, and manually
via Playwright against the real UI): idea → generated spec with the correct
four entities and roles → real SQLite tables created → create/list/update/
delete records through the generated UI, backed by the real API.

## Phase 2 — real auth, an AI team you can watch, and iteration (this repository, today)

- [x] Real authentication (email/password, scrypt-hashed, bearer sessions)
      and multi-tenant project ownership — every project belongs to exactly
      one user; a second user gets a 404, not a 403, on someone else's
      project (see `security.md`)
- [x] A real multi-agent build pipeline, streamed live to the browser over
      Server-Sent Events: **Architect** (plans the schema/impact),
      **Database** (applies a real migration), **Seed Data** (inserts real
      generated sample records into newly created tables), **QA** (runs
      real smoke tests — list endpoints, required-field rejection — and
      stops the build from publishing if one fails), **Security** (a real
      static scan: reserved-SQL-word collisions, plaintext fields that look
      like secrets, scored out of 100), **Forge** (finalizes: saves spec,
      marks built, snapshots a checkpoint). Every step reports genuinely
      verifiable work, not a timed placeholder — see `apps/api/src/pipeline.ts`.
- [x] Time Machine: every build and refine snapshots a checkpoint; the
      History panel lists them and can restore any of them. Restoring is
      always safe because migrations in this engine are additive-only
      (never drop a table/column), a deliberate simplification documented
      in ADR 0002.
- [x] Natural-language **Refine** loop: describe a change to an already-built
      app ("Also track invoices and orders for customers") and the pipeline
      re-derives the spec, diffs it against the current one, and applies
      only the new tables/columns — existing data is untouched (verified in
      `apps/api/src/app.test.ts`).
- [x] **Standalone code export, upgraded to a real multi-file React
      codebase**: `GET /api/projects/:id/export` generates a real Vite +
      React + Express project — one real, editable component file per
      entity (`web/src/entities/<Entity>.jsx`, with that entity's exact
      field list as literal code), a shared list/form component, and the
      same real Express + `node:sqlite` backend from the original export
      — zipped with the existing dependency-free ZIP writer, with zero
      runtime dependency on Forge AI. `npm install && npm start` still
      works as one command (`start` runs `vite build` first). Verified by
      a real `npm install` against the public registry in a directory
      with no relationship to this repo, a real `vite build`, and a real
      browser driving CRUD against the built app standalone — see
      ADR 0005 (supersedes the file shape, not the intent, of ADR 0003).
      This satisfies the "full generated React codebase per project" item
      previously listed below as not yet implemented.
- [x] **AI Team agent detail.** Each build/refine agent step in the UI can be
      expanded ("מה בדיוק נעשה?") to show the real data behind its summary
      message — the Architect's exact new/changed entities, the Database
      agent's literal schema changes, QA's per-entity check results, the
      Security agent's warning list — using the same `detail` payload the
      pipeline already emits, not a re-statement of the headline.
- [x] **Business Twin (basic).** `GET /api/projects/:id/twin` and a "🧠 תמונת
      העסק" panel report real, live record counts per entity and a small
      number of observations that follow directly from those counts (most
      active entity, entities with zero records) — a first, honest version
      of the vision's larger Business Twin idea (section 58): no fabricated
      business insight, no simulated personas, just facts from your actual
      data. Verified in `apps/api/src/twin.test.ts` and via a live browser.
- [x] **Migration idempotency hardening.** `diffAndMigrate` now checks
      `PRAGMA table_info` before issuing `ALTER TABLE ... ADD COLUMN`,
      so calling it twice with the same additive change (e.g. a retried
      build, or a refine that re-derives a spec already applied) can never
      crash with a "duplicate column name" error — a real bug class closed,
      not worked around. Verified by a new idempotency test in
      `packages/db/src/migrate.test.ts`.
- [x] **Debug Agent.** When the Database step's migration throws for any
      reason, the pipeline no longer just stops: a `Debug` agent step sends
      the failing spec and the exact error to Claude, asking for a corrected
      spec, then retries the migration with the fix. If no
      `ANTHROPIC_API_KEY` is configured, or the model's own fix also fails,
      the pipeline reports the real failure honestly instead of pretending
      to succeed or looping — see ADR 0004. This is a first, narrow version
      of "a system like Claude Code, and better" for this platform's own
      build pipeline: self-diagnosis and self-repair for one well-defined
      failure class (schema migration errors), not a general autonomous
      coding agent. Verified in `apps/api/src/pipeline.test.ts` (recovers
      with a mocked model fix, reports honestly with no API key, reports
      honestly when the model's own fix is also broken — no infinite loop).
- [x] **Open-ended answers to clarifying questions.** The "כדאי שתחליטו"
      review screen previously only offered fixed quick-pick chips, and —
      a real pre-existing bug — picking one didn't actually do anything: it
      only highlighted the chip, with no effect on the spec that got built.
      Both are fixed: each open question now also has a free-text input for
      an answer in your own words, and `POST /projects/:id/answers`
      regenerates the spec from the original description plus your answers
      before the build runs, so an answer genuinely changes what gets
      built. Verified in `apps/api/src/app.test.ts` (a free-text answer
      mentioning a payment keyword changes the regenerated spec's own
      recommendation, and that change carries through to the built
      project) and live in a real browser: answering "use Stripe for all
      payments" in free text caused a real Invoice table to be added to
      the built app. The same screen also has a free-standing "יש עוד
      משהו שתרצו לבקש?" box, not tied to any specific question, so a
      request doesn't have to wait for Forge AI to think to ask about it
      — verified the same way (a request with no matching open question
      still added a real Invoice entity to the built app, live in a
      browser).
- [x] **Product quality audit + believable seed data.** In response to a
      direct request to benchmark against Lovable/Base44-class products,
      ran a real audit — a real browser at mobile/tablet/desktop widths
      against every major screen, not a checklist filled in from memory —
      and wrote the honest findings to `docs/product-quality-audit.md`
      (P0/P1/P2). The clearest, most visible P1 found: every freshly built
      app's first screen showed placeholder rows like "לקוחות - שם 1" /
      "Customer phone 2" — fixed by giving `packages/db/src/seed.ts` real
      believable value pools (names, emails, phones, sources, roles, item
      names) keyed by field name and entity context. Verified with new
      unit tests and live in a browser across three entity types.
- [~] **Real bilingual support (Hebrew + English, proper RTL/LTR i18n) —
      Steps 1–2 done.** Built the real i18n architecture (no library —
      `apps/web/src/i18n/`: a pure translation dictionary + `translate()`,
      a `LanguageProvider`/`useTranslation()` context, a language
      switcher), driving a real `dir`/`lang` flip on `<html>` (the
      existing CSS already used only logical properties, so no CSS
      changes were needed for LTR to work). Converted and verified live:
      the pre-auth screen, the authenticated topbar chrome, the home
      ("what do you want to build") screen, and the full spec review
      screen (including the open-questions and free-text-request boxes).
      See ADR 0006 for why the default stays Hebrew until more is
      converted. One nice side effect confirmed live: since the spec
      itself is already generated in whichever language the user typed
      their description in (existing bilingual spec-engine behavior), an
      English description already produces English entity/field names in
      the spec review screen too — so English users get more coherent
      English content than the "chrome-only" conversion alone would
      suggest. **Still not yet implemented:** the AI Team build screen,
      preview/entity panel, History, and Business Twin panel all still
      show hardcoded Hebrew regardless of the selected language — each is
      a queued next step, one (or a small group) per cycle, using the
      same architecture.
- [ ] Multi-agent **parallel** execution (today's pipeline is a sequence, not
      parallel branches with real dependency scheduling) — **not yet implemented**
- [ ] Git integration (bidirectional sync) — **not yet implemented**
- [ ] Visual editor over the generated UI — **not yet implemented**
- [ ] Integration marketplace (Stripe, email, etc.) — **not yet implemented**
- [ ] Deployment (Vercel/Docker) — **not yet implemented**

## Phase 3

- Self-healing: production observability, automatic diagnosis and patch
  proposals for detected regressions
- Business analytics / outcome engine
- Cost governor + scale simulator
- MCP capability layer generated per project
- Feedback-to-feature pipeline
- Real parallel agent execution with a dependency graph, not a fixed sequence

## Phase 4

- Template/agent marketplace
- Mobile app generation
- Enterprise features (SSO, audit log, private deployment, data residency)
- Multi-app "Business Brain" spanning a company's whole app ecosystem

Each phase assumes the previous one is genuinely working, not merely
scaffolded — see `docs/ADR/0001-initial-architecture.md` and
`docs/ADR/0002-auth-pipeline-time-machine.md` for the specific tradeoffs
made to keep each phase real rather than broad.
