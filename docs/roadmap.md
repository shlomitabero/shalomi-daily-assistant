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
- [x] **Real bilingual support (Hebrew + English, proper RTL/LTR i18n) —
      every screen converted.** Built the real i18n architecture (no
      library — `apps/web/src/i18n/`: a pure translation dictionary +
      `translate()` with lightweight `{placeholder}` interpolation, a
      `LanguageProvider`/`useTranslation()` context, a language
      switcher), driving a real `dir`/`lang` flip on `<html>` (the
      existing CSS already used only logical properties, so no CSS
      changes were needed for LTR to work). Every screen is now
      converted and was verified live in a real browser: the pre-auth
      screen, the topbar chrome, the home screen, the full spec review
      screen, the AI Team build screen (all 7 agents' captions and
      detail panels), the preview screen (header buttons, Refine box,
      entity tabs, and the full entity record panel), the History panel
      (checkpoint restore, including fixing a real bug found along the
      way — checkpoint timestamps were hardcoded to `he-IL` regardless
      of the selected language, now correctly use `en-US`/`he-IL` based
      on it), and the Business Twin panel. See ADR 0006 for the
      architecture and the deliberate choice to default new visitors to
      Hebrew rather than browser-detect (now that every screen is
      converted, this default is worth revisiting in a future pass —
      see below). One nice side effect confirmed live throughout: since
      the spec and Business Twin observations are already generated in
      whichever language the user typed their description in (existing
      bilingual spec-engine/twin behavior), an English description
      already produces English entity/field names and observations too
      — English users get more coherent content than the UI-chrome
      translation alone would suggest.
      **Known remaining gaps, tracked as follow-ups, not blockers:**
      server-side error messages (e.g. a failed record validation) are
      not localized in any screen; the default language still doesn't
      auto-detect from the browser (a deliberate interim choice from
      when only some screens were converted — worth revisiting now that
      all of them are).
- [x] **Product Manager Agent no longer defaults toward a minimal spec.**
      Direct product feedback: the AI was consistently recommending a
      stripped-down interpretation of what the user described. Traced to
      `packages/spec-engine/src/anthropic.ts`'s system prompt, which
      literally instructed the model to "infer the minimum viable set of
      entities and roles... do not over-engineer." Rewrote the rule to
      instruct thoroughness instead: cover everything the description
      implies, don't trim entities/fields for the sake of a smaller spec,
      and when giving an openQuestions "recommendation," default to the
      option that covers more of what the user is likely to need. Locked
      in with a new regression test asserting the system prompt text
      itself no longer contains "minimum viable"/"do not over-engineer"
      and does instruct thoroughness — this is a prompt-only change (no
      code path to exercise live without a real Anthropic API key
      outside this dev environment), so it's verified that way rather
      than by a claimed browser run.
- [x] **Persistent chat + live-preview split-pane builder (Base44/Lovable-
      style), not a linear screen flow.** Direct product feedback naming
      Base44 specifically. Researched (base44.com itself is blocked by
      this environment's network egress policy, so via search results and
      third-party write-ups, not a direct fetch — that limitation is
      stated honestly, not hidden): Base44's editor keeps an AI chat panel
      on one side and a live app preview on the other, at all times, side
      by side — you keep typing follow-up requests into the same
      persistent chat and watch the preview update, rather than moving
      through separate full-page screens (describe → review → build →
      preview) the way Forge AI does today. Adopting this is a real UI/UX
      architecture change — restructuring `apps/web/src/App.tsx` away
      from its current linear `View` state machine into a persistent
      two-pane layout — not a small tweak, so it will be built the same
      way the bilingual rollout was: staged, verified steps, not one
      pass.
      **Step 1 done:** the preview screen now keeps a real, persistent
      refine conversation history instead of a single-shot input that
      forgets itself after each submit — every refine instruction is
      listed with a one-line summary derived from the actual Architect
      agent event of that refine (e.g. "New screen: Invoice"), not a
      generic re-statement. This is the data-model prerequisite for the
      eventual two-pane layout. Verified live in a real browser: two
      sequential refines (one that added a real new entity, one that
      genuinely changed nothing) both produced accurate, real summaries,
      in order, with zero console errors.
      **Step 2 done:** the preview screen is now a genuine two-column
      split pane on wide viewports — a sticky chat/history column (the
      Refine box + its conversation history from Step 1) next to a live
      entity-preview column (tabs + the record table/form), instead of
      one long stacked column. Falls back to a single stacked column
      below a 760px breakpoint. Verified live in a real browser at both
      1280px and 390px: measured the two panes' actual bounding boxes to
      confirm they sit genuinely side by side on desktop (not just
      visually adjacent by coincidence) and genuinely stacked on mobile
      with no horizontal overflow, and confirmed the chat pane's `sticky`
      positioning actually holds it near the top while scrolling past a
      long entity table (moved only ~50px on screen after a 400px page
      scroll). The two-column breakpoint is intentionally modest (not a
      full-bleed wide layout) because it still lives inside the app's
      existing 880px content container — widening that container is a
      separate, larger decision not made here.
      **Step 3 done — core loop complete:** refining a built app no
      longer navigates away to a full-screen AI Team view at all. The
      chat pane now shows a compact inline version of the AI Team
      activity (`BuildProgress`'s new `compact` prop: same real per-agent
      status/detail, no full-page `<main>`/`<h1>` chrome) in place of the
      Refine input while a refine runs, then returns to the input with
      the completed entry added to the history — the live-preview column
      never disappears. Verified live in a real browser by polling the
      DOM every 20ms through an entire refine: confirmed `.preview-body`
      (the split-pane container) was present the whole time — a real
      measurement that no navigation occurred, not an assumption — and
      confirmed the compact panel was actually observed rendering
      mid-refine, then confirmed the live entity tabs updated with a real
      new entity afterward. Zero console errors.
      **What "core loop complete" means, honestly:** the primary
      interaction — describe once, then keep refining through a
      persistent chat next to a live, never-navigated-away-from preview
      — now genuinely matches the Base44/Lovable pattern that prompted
      this initiative. Not yet ported: the very first build (idea →
      spec review → initial build) still uses the earlier full-page flow
      before any project exists to preview, since there is nothing to
      show in a live pane yet — folding that in too is a possible, but
      not yet started, future step.
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
