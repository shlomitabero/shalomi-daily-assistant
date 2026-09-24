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
      (Browser-language auto-detection — the other gap noted here
      previously — is now enabled; see below. Server-side error message
      localization — the last known gap — is also now closed; see
      "Localize server-side error messages" further down.)
- [x] **Browser-language auto-detection.** Now that every screen is
      translated, `detectInitialLang` picks the visitor's language from
      `navigator.language` when nothing is stored yet (Hebrew locale →
      Hebrew, anything else → English), instead of always defaulting to
      Hebrew regardless of browser — a stored preference still always
      wins. See ADR 0006's update section. Verified with 4 new unit
      tests and live across 4 real Playwright browser contexts with
      different locales (`en-US`, `he-IL`, `fr-FR`, and `en-US` with a
      stored Hebrew preference) — each produced the correct language,
      including confirming the override case works and that an
      unsupported locale (French) correctly falls back to English rather
      than erroring or defaulting to Hebrew.
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
- [x] Precompile `apps/api` to a bundled JS file for production instead of
      transpiling TypeScript at every boot — see "Production hardening"
      below.
- [x] **Prompt Architect Agent: "enhance my idea, then build it" loop.**
      Direct user request: write a rough idea, have the app's AI turn it
      into a proper, detailed prompt, then run that AI-written prompt
      through the app itself automatically (a Base44/Lovable-style
      "improve my prompt" step, taken one step further into full
      automation). New `packages/spec-engine/src/promptEnhancer.ts`
      mirrors the existing `SpecProvider` seam exactly:
      `AnthropicPromptEnhancer` (real Claude call, dedicated system prompt,
      used when `ANTHROPIC_API_KEY` is set) and `HeuristicPromptEnhancer`
      (deterministic, offline — reuses the same keyword-matched domain
      library the heuristic spec generator already uses, so it works with
      zero configuration), picked by `selectEnhancer` the same way
      `selectProvider` already works. New `POST /api/ideas/enhance`
      endpoint (auth-required, 400 on an empty idea). On the home screen, a
      new "✨ Enhance & build with AI" button sends the typed idea to this
      endpoint, **replaces the textarea with the AI's rewritten prompt so
      the user sees exactly what it wrote** (nothing hidden or silently
      substituted), and immediately continues through the normal
      create-project pipeline with that rewritten text — the app builds
      its own prompt, then builds itself from it, in one click. The
      original "Let's get started" button is untouched and still builds
      whatever is currently in the textarea (raw or AI-rewritten,
      user-edited or not), so nothing about the existing flow changed.
      Verified: 28 spec-engine unit tests (both providers, empty-input and
      API-failure error paths, `selectEnhancer`'s key-based provider
      choice) + a new API integration test (401 without auth, 400 on an
      empty idea, and a full round trip proving the enhanced text is a
      real, usable description by feeding it straight into project
      creation) + `npm run build` clean + a real Playwright run against a
      real running server: typed a two-word Hebrew idea for a hair salon,
      clicked the new button, watched it land directly on the spec review
      screen with detected entities, zero console errors. Also checked at
      390px mobile width — the new button and hint text lay out cleanly,
      no clipping.

## Generated-app quality

Direct, blunt user feedback: the apps this platform builds looked cheap
and generic, with no real features. This is accurate and structural —
every business type (a CRM, a barbershop, a delivery app) rendered
through one shared, generic table+form component with no visual
distinction between field types and no interactivity beyond CRUD. This
section tracks closing that gap for real, one verified step at a time —
not a single "make it perfect" claim.

- [x] **Step 1: upgrade the entity list view (badges, formatting, search,
      sort).** `EntityPanel.tsx`'s table used to render every field as
      plain text and had no way to find or order records. New
      `entityFormatting.ts` (pure, unit-tested functions, no React) adds:
      color-coded status badges for enum fields (a lightweight classifier
      recognizes common positive/negative words like "Won"/"Lost" from
      the domain library and any AI-generated spec, falling back to
      neutral for anything else — no per-app configuration needed), a ✓/–
      icon for booleans instead of "Yes"/"No" text, locale-formatted
      dates and thousands-separated numbers instead of raw values, a
      real search box that filters across every field (case-insensitive,
      matches translated enum labels too), and click-to-sort column
      headers (asc/desc, correct for numbers/strings/booleans/nulls). A
      real bug was found and fixed along the way, unrelated to this
      feature: the test glob in every workspace's `package.json`
      (`src/**/*.test.ts`, unquoted) was being pre-expanded by the shell
      inconsistently across workspaces, silently dropping any test file
      placed directly in `src/` (not a subdirectory) in some workspaces
      but not others — exposed the moment this work added the first such
      file in `apps/web`. Fixed by quoting the glob everywhere so the
      test runner's own (correct) recursive matching is always used;
      re-ran the full suite before and after to confirm no test was
      silently lost elsewhere. Also found and fixed a CSS specificity bug
      while verifying live: the new sort-header buttons briefly flashed
      solid accent-orange on hover instead of a subtle text-color change,
      because the generic `button:hover:not(:disabled)` rule was
      (surprisingly) more specific than the new `.sort-header:hover`
      override. Verified: 8 new unit tests for `entityFormatting.ts` +
      full suite green (109 tests, up from 101) + `npm run build` clean +
      a real Playwright run against a real running server: built a CRM,
      added customer records with varied statuses, confirmed the color
      badges render correctly (red for "Lost", neutral for "New"),
      confirmed search correctly found records by name across both
      manually-added and seed data, confirmed clicking the status header
      sorts correctly, and confirmed the hover-color bug is gone —
      checked in light mode, dark mode, and at mobile width (390px), zero
      console errors throughout.
- [x] **Step 2: bring the same upgrade to the exported standalone app.**
      Step 1 only reached the live in-app preview; the code a user
      actually downloads via "Export Code" (`apps/api/src/codegen.ts`,
      a separate, dependency-free React codebase with zero runtime
      connection to Forge AI) still generated the old plain table. Since
      the export can't import Forge AI's own packages, the same
      badge-classification/search/sort logic from `entityFormatting.ts`
      was ported as literal, readable JS directly into the generated
      `EntityView.jsx` template (and matching CSS into the generated
      `styles.css`) — duplicated intentionally, not shared, because the
      whole point of this export is that it owes nothing to Forge AI at
      runtime. Verified: a new codegen test asserts the generated file
      contains the badge/search/sort code and no longer contains the old
      `formatCell` helper, full test suite green (110 tests) + `npm run
      build` clean, and — the most rigorous check available — an actual
      end-to-end run: signed up, built a real CRM project through the
      live API, downloaded the real export .zip, unzipped it, ran `npm
      install` and `npm start` on it as a **completely standalone
      project** (no Forge AI code involved at all), and drove it with a
      real Playwright browser: added customer records, saw the green
      "Won" status badges render correctly, confirmed search correctly
      filtered to 1 matching row, and confirmed clicking a column header
      sorts without error. Zero console errors. This closes both
      identified steps of the generated-app-quality effort for now — see
      "Step 3 candidates" below for what's still not done.
- [x] **Step 3: a real Kanban board for stage-like entities (live preview
      only).** Every entity still rendered as the same table shape,
      whether or not it actually represented a pipeline (a "Deal" moving
      through stages, an "Order" moving through statuses). New
      `findBoardField`/`groupByField` in `entityFormatting.ts` (pure,
      unit-tested) pick the best enum field to group by — preferring one
      literally named `status`/`stage` (the domain library's own
      convention), falling back to the first workable enum field (2-8
      values), and returning `null` for a genuinely flat entity like
      "Customer" with no enum field, so nothing is forced into a board it
      doesn't suit. `EntityPanel.tsx` gained a Table/Board toggle (shown
      only when a board field exists) and a real board: one column per
      declared enum value (including empty ones, not hidden), a card per
      record showing its other fields, and a `<select>` on each card that
      moves it to a different stage with one real `PATCH` call — search
      still filters the board same as the table. Verified: 5 new unit
      tests for the grouping/field-selection logic + full suite green
      (120 tests) + `npm run build` clean + a real Playwright run against
      a real running server: built a CRM, switched the "Deal" entity
      (with its real `stage` enum: Lead/Negotiation/Won/Lost) to board
      view, confirmed all 4 columns render with correct counts, added a
      real deal, moved it from the "Lead" column to "Won" via the select,
      and confirmed via direct DOM inspection (not just a screenshot)
      that it actually left the Lead column's card list and appeared in
      Won's — a real, persisted state change, not a visual-only move.
      Checked at 390px mobile width and in dark mode too, zero console
      errors.
- [x] **Step 4: the same Kanban board in the exported standalone app.**
      Ported `findBoardField`/`groupByField`/`BoardCard` into
      `codegen.ts`'s generated `EntityView.jsx` template as literal JS
      (same duplication-by-design reasoning as the earlier badges/search/
      sort port — the export owes nothing to Forge AI at runtime), plus
      the matching CSS into the generated `styles.css`. Verified: 2 new
      codegen tests (the generated file contains the board code/CSS) +
      full suite green (121 tests) + `npm run build` clean + the same
      rigorous end-to-end check as before: built a real CRM project
      through the live API, downloaded the actual export `.zip`, unzipped
      it, ran `npm install` + `npm start` as a **fully standalone app**,
      and drove it with a real browser — added a "Customer" record,
      switched to board view, moved it from the "New" column to "Won" via
      its card's select, and confirmed via direct column-count inspection
      that it genuinely left one column and landed in the other (1→0 in
      "New", 0→1 in "Won"), not just visually. Zero console errors. This
      closes the parity gap between the live preview and the exported
      code for the Kanban feature.
- [x] **Step 5: a real month-calendar view for date-heavy entities (live
      preview only).** An entity like "Appointment" still only offered
      table/board views, with no way to see records laid out by date. New
      `findDateField`/`buildCalendarMonth` in `entityFormatting.ts` (pure,
      unit-tested) pick the best date field (preferring one literally
      named `date`, falling back to the first date field, `null` for an
      entity with none) and build a fixed 42-day (6-week) month grid with
      each record placed on its matching calendar day — a record with a
      missing/unparseable date is silently skipped, never a crash.
      `EntityPanel.tsx` gained a `CalendarView` component and a third
      "📅 Calendar" toggle (shown independently of the board toggle, since
      an entity can have both a status field and a date field), with
      prev/next month navigation, locale-correct month labels and weekday
      headers (via `toLocaleDateString`/`Intl.DateTimeFormat`, so this
      works in both Hebrew and English without hardcoding either), and a
      chip per record per day (click to jump straight into editing that
      record) with a "+N more" overflow instead of an ever-growing cell.
      Verified: 7 new unit tests for the grid/date-matching logic + full
      suite green (128 tests) + `npm run build` clean + a real Playwright
      run against a real running server in both Hebrew and English
      locales: built a salon-appointments project, added two real
      appointment records on a specific day, switched to calendar view,
      confirmed the grid is exactly 42 days, confirmed both new records'
      chips render on the correct day (and only that day) alongside
      pre-existing seed data, confirmed clicking a chip opens the edit
      form pre-filled with that exact record (not a neighboring one),
      confirmed navigating to the next month shows zero chips for the
      records that belong to the current month (no leakage across
      months) and navigating back returns to the original month label,
      and confirmed the month label/weekday headers/chip text all
      correctly localize in an English browser context too. Zero console
      errors, zero failed network requests.
- [x] **Step 6: the same month-calendar view in the exported standalone
      app.** Ported `findDateField`/`buildCalendarMonth`/`CalendarView`
      into `codegen.ts`'s generated `EntityView.jsx` template as literal
      JS (same duplication-by-design reasoning as the badges/search/sort
      and Kanban ports — the export owes nothing to Forge AI at runtime),
      plus the matching CSS into the generated `styles.css`. The exported
      app has no i18n of its own, so month/weekday labels use the
      browser's default locale via `toLocaleDateString`/
      `Intl.DateTimeFormat` rather than a Forge AI language context.
      Verified: 1 new codegen test (the generated file contains the
      calendar component/CSS, using a project with a real date field) +
      full suite green (129 tests) + `npm run build` clean + the same
      rigorous end-to-end check as the earlier ports: built a real
      salon-appointments project through the live API, downloaded the
      actual export `.zip` via a real browser download event, unzipped
      it, ran `npm install` + `npm start` as a **fully standalone app**
      (zero connection to Forge AI, verified by the app running from a
      bare temp directory with its own SQLite file), and drove it with a
      real Playwright browser: switched to calendar view, added two real
      appointment records on a specific day, confirmed the grid is
      exactly 42 days, confirmed both records' chips render on the
      correct day and nowhere else, confirmed clicking a chip opens the
      edit form pre-filled with that exact record, and confirmed month
      navigation moves off that day's chips with no leakage. Zero console
      errors beyond an unrelated pre-existing favicon 404. This closes
      the parity gap between the live preview and the exported code for
      the calendar feature — badges/search/sort, Kanban board, and
      calendar view are now all present in both the live preview and the
      exported standalone app.
- [x] **Step 7: real CSV export for entities (live preview only).** There
      was no way to get an entity's data out of Forge AI except reading it
      off the screen. New `recordsToCsv(fields, records, lang)` in
      `entityFormatting.ts` (pure, unit-tested) builds an actual
      Excel-friendly CSV — CRLF line endings, comma/quote values correctly
      quoted (with interior quotes doubled), and human-friendly cell
      values matching what the table already shows (an enum's translated
      label, a locale-formatted date/number, `TRUE`/`FALSE` for booleans)
      rather than a 1:1 dump of raw stored values. `EntityPanel.tsx`
      gained a "⬇️ Export CSV" button in the toolbar (disabled when the
      current search has zero matching rows) that exports exactly the
      currently visible (search-filtered, sorted) records — "what you see
      is what you export" — as a real client-side file download, with a
      UTF-8 byte-order mark prepended so Hebrew text renders correctly in
      Excel instead of as mojibake (a real, easy-to-miss correctness
      requirement for a Hebrew-first product). Verified: 5 new unit tests
      for the CSV-building logic (header from labels, enum/date/number/
      boolean formatting, comma/quote escaping and doubling, null/
      undefined/empty all render as an empty field, `false` still renders
      as `FALSE` rather than being mistaken for "missing") + full suite
      green (134 tests) + `npm run build` clean + a real Playwright run
      against a real running server: built a CRM, added a record with a
      comma and embedded quotes in its name specifically to exercise
      escaping, clicked the real export button, captured the actual
      browser download event (not a mocked one), read the downloaded
      file's real bytes, and confirmed the BOM is present, the row count
      matches the table exactly, the Hebrew enum label renders correctly,
      and the escaped value round-trips as `"Cohen, Yossi ""The
      Great"""` — exactly correct CSV per RFC 4180. Also confirmed the
      button correctly disables when a search matches nothing, and
      checked it at 390px mobile width and in dark mode. Zero console
      errors.
- [x] **Step 8: the same CSV export in the exported standalone app.**
      Ported `csvEscape`/`fieldDisplayValue`/`recordsToCsv` and a
      `handleExportCsv` handler into `codegen.ts`'s generated
      `EntityView.jsx` template as literal JS (same duplication-by-design
      reasoning as the three earlier ports), plus a matching
      `.csv-export-btn` style into the generated `styles.css`. **Found
      and fixed a real bug while porting, not just copying:** the
      generator's own outer TypeScript template literal silently
      interprets `\r`, `\n`, and `\u` escape sequences meant for the
      *generated* file's own source — writing `"\r\n"` in `codegen.ts`
      produces a raw, literal carriage-return/newline character baked
      directly into the generated file's text at codegen time (not the
      two-character escape sequence), which breaks a regex literal or
      unterminated string wherever it lands in the *output* source. This
      exact bug appeared during this port (an "Unterminated regular
      expression" and then an "Unterminated string literal" from
      esbuild's real-parser test) and was fixed by escaping the
      backslash — `"\\r\\n"` in `codegen.ts` — so the generated file's
      source contains the literal two-character escape sequence for its
      *own* runtime to interpret. Verified: 1 new codegen test (the
      generated file contains the CSV-building code/button/CSS) + full
      suite green (135 tests) + `npm run build` clean + the same
      end-to-end rigor as the earlier three ports: built a CRM through
      the live API, downloaded the real export `.zip` via an actual
      browser download event, unzipped it, ran `npm install` + `npm
      start` as a **fully standalone app**, added a record with a comma
      and embedded quotes specifically to re-exercise the escaping logic
      in the *exported* code path, clicked the real export button,
      captured the real download event, read the file's actual bytes,
      and confirmed the BOM, row count, Hebrew header/enum-label
      rendering, and exact RFC-4180 quote-doubling are all correct. This
      closes the parity gap for CSV export — badges/search/sort, Kanban
      board, calendar view, and CSV export are now all present in both
      the live preview and the exported standalone app.
- [x] **Step 9: bulk-select + bulk-delete for entity records (live
      preview only).** Deleting several records meant clicking Delete one
      row at a time. `EntityPanel.tsx`'s table view gained a checkbox per
      row plus a header checkbox that selects every currently *visible*
      row (search-filtered) — with a real `indeterminate` state (set via
      a ref, since React has no `indeterminate` prop) when some but not
      all visible rows are selected, not just a plain checked/unchecked
      toggle. Selecting one or more rows shows a bulk-actions bar with
      the live count ("2 selected") and a delete button; deleting asks
      for confirmation first (a real `window.confirm`, since this is a
      genuinely destructive, unrecoverable action) naming exactly how
      many records will be removed, then deletes them all and clears the
      selection. Selection is scoped correctly: deleting a single record
      via its own row button also prunes it out of any active selection,
      so a stale selected-but-deleted ID can never linger. Verified: full
      suite green (135 tests, no new pure logic needed here beyond what
      existing tests already cover) + `npm run build` clean + a real
      Playwright run against a real running server: built a CRM, added 3
      distinctly-named test records, selected 2 of them, confirmed the
      bulk bar showed the correct count and the header checkbox was
      genuinely `indeterminate` (checked via the real DOM property, not
      inferred from a screenshot), accepted the real confirm dialog,
      verified exactly those 2 records were removed and the untouched
      third one remained, confirmed the bulk bar disappeared afterward,
      and confirmed the header "select all" checkbox correctly selects
      every remaining visible row. Checked at 390px mobile width and in
      dark mode too, zero console errors.
- [x] **Step 10: bulk-select + bulk-delete in the exported standalone
      app.** Ported the checkbox-selection state, `toggleSelected`/
      `toggleSelectAllVisible`/`handleBulkDelete`, and the bulk-actions
      bar into `codegen.ts`'s generated `EntityView.jsx` template as
      literal JS (same duplication-by-design pattern as the four earlier
      ports), plus matching `.bulk-actions-bar`/`.select-col` CSS.
      **Found and fixed a second real, pre-existing gap while porting,
      not just copying:** the exported app's generic
      `input, select, textarea { width: 100%; }` CSS rule had no
      `input[type="checkbox"] { width: auto; }` override — unlike the
      live-preview app, which already has one — so every checkbox in the
      exported app (including the pre-existing boolean-field checkboxes
      in the record form, not just the new bulk-select ones) would have
      rendered stretched to its container's full width. Fixed by adding
      the same override used in the live app. Verified: 1 new codegen
      test (the generated file contains the bulk-select code/CSS/
      checkbox-width override) + full suite green (136 tests) + `npm run
      build` clean + the same end-to-end rigor as the earlier four
      ports: built a CRM through the live API, downloaded the real
      export `.zip`, unzipped it, ran `npm install` + `npm start` as a
      **fully standalone app**, added 3 real records, selected 2,
      confirmed the header checkbox was genuinely `indeterminate`,
      accepted the real confirm dialog, confirmed exactly those 2
      records were removed and the third remained, confirmed
      select-all worked afterward, and directly measured the rendered
      checkbox width (13px, not stretched) to confirm the CSS fix
      actually took effect in the generated output, not just in source.
      This closes the parity gap for bulk-select/delete — all five
      generated-app-quality features (badges/search/sort, Kanban board,
      calendar view, CSV export, bulk-select/delete) are now present in
      both the live preview and the exported standalone app.

## Production hardening

- [x] **Cold-start retry with a "waking up" message.** The user reported
      "Load failed" again — this time correctly root-caused (not just
      theorized) as a raw browser network error, thrown by `fetch()`
      itself before any server response — no HTTP status code, no JSON
      body, nothing our existing server-error-code translation could see.
      This matches Render's free-tier behavior exactly: after inactivity
      the very first request can take 50+ seconds while the instance
      wakes up, and a browser's default patience for a connection to even
      open is far shorter than that. The earlier boot-time fix
      (esbuild bundle instead of `tsx` at runtime) made the *server's own*
      startup faster but did nothing for the *platform's* wake-up delay,
      which is what this is. New `wakeRetry.ts` (pure, unit-tested, no
      DOM) retries a request that fails at the network level — never one
      that gets a real HTTP response, even an error one — with backoff
      (~49s total, matching Render's own quoted window), and reports a
      `waking` status via a small callback so `api.ts` can surface it.
      `App.tsx` shows a visible, translated "🔥 Waking up the server…"
      banner during a retry, on every screen (auth, loading, and the main
      app) — and if the backend is genuinely down (not just cold-starting)
      it still gives up after the backoff and shows a normal, translated
      error instead of hanging forever. Verified: 4 new unit tests for
      the retry logic itself (succeeds immediately without waking anyone,
      retries and recovers, gives up and rethrows, never retries a real
      HTTP error response) + full suite green (115 tests) + `npm run
      build` clean + three real Playwright runs against a real server,
      using request interception to simulate an actual cold start (the
      first N requests genuinely refused at the connection level, not
      mocked): confirmed the waking banner appears, confirmed it clears
      and the user lands on the real signed-in screen once the retry
      succeeds, confirmed a fully-exhausted retry still resolves to a
      normal translated error rather than hanging, and confirmed the
      banner text is correctly translated in a Hebrew browser context too.

- [x] **Fix mobile Refine box placeholder clipping (P2 finding).** The
      input and its submit button shared one row with a 160px input
      minimum; below 480px they now stack vertically, and the example
      placeholder copy was shortened in both languages to fit
      comfortably. Verified live at 390px in Hebrew and English. This
      closes the last known finding from the original quality audit —
      see `docs/product-quality-audit.md` for the full detail.
- [x] **Add a dark mode toggle (P2 finding).** `styles.css` already had
      dark-mode-ready tokens (auto-applied via `prefers-color-scheme`)
      but no manual switch. Added `theme/theme.ts` + `theme/ThemeContext.tsx`
      + `theme/ThemeSwitcher.tsx`, mirroring the existing i18n
      architecture exactly: a stored choice always wins, otherwise falls
      back to the system preference. Shown in the topbar and on the auth
      screen. Verified with 3 new unit tests and live in a real browser —
      see `docs/product-quality-audit.md`'s P2 section for the full
      verification detail. Only remaining known P2 item: the mobile
      Refine-box input clipping (cosmetic only).
- [x] **Fix the desktop empty-void visual design (P1 finding).** See
      `docs/product-quality-audit.md` finding #3 for the full detail: a
      subtle fixed radial-gradient background anchors every screen, and
      the auth screen gained a real two-column "What you get" panel at
      ≥900px with four honestly-scoped feature highlights. This was the
      last open P1 finding from the quality audit — no known P0/P1
      findings remain.
- [x] **Localize server-side error messages** — the last remaining known
      i18n gap (see ADR 0006), freshly and concretely motivated: the live
      "Internal server error" incident (see the fallback entry just below)
      showed a raw, untranslated English string sitting on an otherwise
      all-Hebrew page. Every `HttpError` the API can throw (auth, project
      ownership, build-order, validation) now carries a stable `code`
      (e.g. `"BUILD_REQUIRED"`, `"INVALID_CREDENTIALS"`) alongside its
      existing English `message` (see `apps/api/src/httpError.ts`); the
      global error handler in `app.ts` adds the same for `ValidationError`
      (`"VALIDATION_ERROR"`), `NotFoundError` (`"NOT_FOUND"`), and the
      generic 500 fallback (`"INTERNAL_ERROR"`). A new pure
      `resolveErrorMessage(lang, body)` in `i18n/language.ts` translates a
      known code into the current UI language, falling back to the raw
      English text for any code not yet in the dictionary (so nothing
      goes silently blank as new error paths are added later) — `api.ts`
      wraps it with the same stored-preference/browser-locale detection
      `LanguageProvider` uses, since it runs outside the React tree. Field-
      level validation detail (raw zod messages) is intentionally
      collapsed into one generic "the submitted data isn't valid" message
      per language rather than translated field-by-field — a reasonable,
      explicitly scoped tradeoff for this pass. Verified: 5 new pure-
      function unit tests (including a regression test asserting every
      code actually thrown anywhere in `apps/api/src` has both a Hebrew
      and an English dictionary entry, so a future throw site without a
      translation fails loudly instead of silently showing English again)
      + `code` assertions added to 4 existing real API integration tests
      (wrong password, duplicate signup, missing/invalid session, build-
      before-ready) + full test suite green (98 tests) + `npm run build`
      clean + two real Playwright runs against a real running server, one
      with an `he-IL` browser context and one with `en-US`: triggered a
      real login failure and confirmed the on-screen error text reads
      "אימייל או סיסמה שגויים." in the Hebrew context and "Incorrect email
      or password." in the English one — not the old raw "Invalid email
      or password" either way.
- [x] **Graceful fallback when the real Anthropic call fails.** The user
      reported "Internal server error" on the live site right after using
      the new "Enhance & build with AI" feature — the first real use of
      the Anthropic-backed path in production (this sandbox has no
      `ANTHROPIC_API_KEY`, so it had only ever been tested against the
      heuristic fallback and a mocked Anthropic response, never a live
      API call). `generateSpec` and `enhancePrompt` now catch a failure
      from a non-heuristic provider/enhancer (network error, rate limit,
      or the model's output not matching `ProductSpecSchema`), log the
      real error server-side for diagnosis, and transparently retry with
      the deterministic heuristic instead of surfacing a raw 500 —
      `providerName` comes back tagged `"<name>-fallback"` so this is
      never confused with a normal response. Verified: 4 new unit tests
      (fallback triggers and returns a valid result; a heuristic failure
      still propagates, i.e. this doesn't loop or hide every error) +
      full test suite green + a real Playwright run against a real
      running server with a **deliberately invalid** `ANTHROPIC_API_KEY`
      (to force a genuine live API failure, not a mock): the server logs
      show a real `401 invalid x-api-key` from `api.anthropic.com`, and
      the user still lands cleanly on the spec review screen with a
      working, if less tailored, generated app — zero error banner, zero
      console errors. This strongly suggests the live incident's likely
      cause: if the real key configured in Render's environment is
      invalid/expired, this exact 401 would occur — worth the user
      double-checking `ANTHROPIC_API_KEY` in the Render dashboard's
      Environment tab, though the app itself no longer breaks either way.

- [x] **Faster production boot for `apps/api`.** Investigated a live
      "Load failed" report on the deployed site. Render's own dashboard
      showed the `forge-ai` service itself was deployed successfully
      (green, no failed build) and no error logs — the actual cause was
      Render's free-tier instance spinning down after inactivity, which
      can add 50+ seconds to the very next request while it wakes back up;
      a client that gives up before that finishes sees exactly this error.
      That spin-up delay is a Render free-tier platform behavior, not
      something this codebase can eliminate — but the app's own boot time
      was a real, fixable contributor: production was running
      `tsx --experimental-sqlite src/server.ts`, which transpiles every
      TypeScript file (including the three workspace packages it imports)
      from source on every single process start. Added a real build step
      (`apps/api`'s `build` script bundles `src/server.ts` and its
      workspace-package imports into a single plain-JS file with esbuild,
      already an unused devDependency; `express`/`cors`/`zod` stay external
      since they're real npm dependencies present after `npm install`) and
      changed `start` to run the bundle directly with plain `node`. Local
      measurement across 3 runs each: old (`tsx`, live transpile) booted in
      837–964ms; new (precompiled bundle, plain `node`) booted in
      171–196ms — roughly 5x faster. Verified: full test suite (77 tests
      across all 4 workspaces) still passes; a clean-room clone + fresh
      `npm install` + `npm run build` + `npm start` (mirroring Render's
      exact `buildCommand`/`startCommand` from `render.yaml`) produced a
      working server (`/api/health` returns ok, static assets serve) that
      a real Playwright browser loaded with zero console errors. `dev`
      still runs via `tsx watch` unchanged, so local development is
      unaffected.
- [x] **Fill the home screen's empty desktop void with clickable example
      ideas.** A direct user complaint ("works, but not at the level of
      Base44") led to a real visual audit (screenshots of every main
      screen, light + dark, desktop + mobile) rather than guessing —
      which found the home/idea screen was still the single most glaring
      "cheap" impression: on a normal desktop viewport, the entire
      bottom two-thirds of the screen was empty background below the
      textarea and two buttons, with nothing to guide a first-time user
      on what a good description even looks like. Added `IDEA_EXAMPLES`
      (5 real business types — salon, restaurant-with-delivery, fitness
      studio, online shop, sales CRM) rendered as a responsive grid of
      clickable cards below the form; clicking one fills the textarea
      with a full example description in the current language (the user
      can still edit before submitting) instead of auto-submitting.
      This both fills the dead space with genuinely useful content (a
      pattern Base44/Lovable/v0 all use) and lowers the barrier for a
      non-technical user who doesn't know what to type. Verified: full
      suite green (135 tests) + `npm run build` clean + a real Playwright
      run: confirmed all 5 chips render, confirmed clicking one actually
      fills the textarea with the matching example text, confirmed
      building all the way through from a clicked example reaches the
      spec-review screen, checked English labels/text render correctly,
      and checked screenshots at 390px mobile width (single-column
      stack, no overflow) and in dark mode (correct hover/selected
      border color, no white-on-white or contrast issues). Zero console
      errors. This is one concrete, scoped step toward a more polished
      first impression — not a full redesign, which "Base44-level"
      would honestly require more than one round to reach.
- [x] **Expand the heuristic domain-entity library — fix the real root
      cause behind generic, shallow generated apps.** A direct follow-up
      complaint ("not just the home screen — the CODE isn't at the
      level") led to investigating what actually gets *built*, not just
      how the builder screens look. Found the real cause: the offline
      heuristic spec generator (used whenever no `ANTHROPIC_API_KEY` is
      configured, which is how this always ran in this sandbox and
      appears to be how production has been running too) only recognized
      8 business-entity types (Customer, Appointment, Employee, Invoice,
      Order, Service, Product, Deal). Any description it didn't
      recognize — including the user's own literal report, "אפליקציה
      משלוחים כמו wolt" (a delivery app like Wolt) — silently fell back
      to one single generic "Item" entity (name/description/status),
      which is exactly the "cheap, generic" impression the user
      described, not a cosmetic issue. Added 7 new domain entities
      (MenuItem, Courier, Property, Student, Course, Patient, Project,
      Task — covering restaurants/delivery, real estate, education,
      healthcare, and agencies/project-management) each with real,
      sensible fields and full Hebrew labels, and extended the existing
      Order rule's keywords to recognize "delivery"/"משלוחים"/"wolt" too
      (a delivery is fundamentally a kind of order). Verified: 4 new
      unit tests including a direct regression test using the user's
      exact reported phrase, a combined "restaurant with delivery"
      description that now correctly produces 3 tailored entities
      together (MenuItem + Order + Courier) instead of one generic
      fallback, coverage for the other 4 new domains, and a specific
      test proving the new "Course" keyword doesn't spuriously trigger
      on the common English phrase "of course" (a real substring-match
      pitfall caught before it shipped). Full suite green (140 tests) +
      `npm run build` clean + `npm run test` in `packages/spec-engine`
      alone (36/36) + a real Playwright run against a real server:
      re-ran the user's exact original phrase and confirmed the spec
      review screen now shows a real "הזמנות" (Orders) entity with
      real fields instead of the generic "פריטים" (Items) fallback, and
      built a fuller "מסעדה עם משלוחים, כולל תפריט מנות ושליחים"
      (restaurant with delivery, including a menu and couriers)
      description all the way through a real build, confirming the
      live app ends up with 3 real, distinct, correctly-fielded entity
      tabs (Orders, Menu Items, Couriers) — not a single flat list.
      **Scope note, stated honestly:** this materially improves what the
      free, no-API-key heuristic path produces for many more common
      business types, but it is still a keyword-matching heuristic, not
      true language understanding — a genuinely novel business
      description can still fall back to the generic entity, and the
      Anthropic-backed provider (when a real API key is configured)
      remains the path to real accuracy for arbitrary descriptions.
- [x] **Second domain-entity expansion round: 4 more common business
      types.** Continuing the same initiative (the recurring automated
      round picked up the previous round's own top-priority suggestion):
      added Vehicle (garages, mechanics, fleets), Event (event planners,
      weddings, conferences), Pet (veterinary clinics), and Rental
      (equipment rental businesses) — bringing the domain library from
      15 to 19 recognized entity types. **Found and fixed a real
      false-positive bug while writing the safety tests for this round
      (the same discipline that caught the "of course"/Course collision
      last round):** the bare English keyword "events" is a literal
      substring of the common word "prevents" — a description like "this
      prevents double bookings" would have spuriously matched the new
      Event entity. Caught by a dedicated test before it shipped and
      fixed by dropping the bare "events" keyword in favor of the more
      specific phrases already in the rule ("event planning",
      "conference", "wedding", "weddings", "trade show" — plus the
      Hebrew "אירוע"/"אירועים", which have no such collision risk).
      Verified: 2 new tests (one covering all 4 new entity types end to
      end, one specifically proving the new keywords don't spuriously
      trigger on "prevents"/"current") + full suite green (142 tests) +
      `npm run build` clean + a real Playwright run against a real
      server: built a Hebrew "מרפאה וטרינרית" (veterinary clinic)
      description all the way through a real build and confirmed the
      live app has real "תורים" (Appointments) and "חיות מחמד" (Pets)
      entity tabs with correctly-labeled fields, not a generic fallback.
- [x] **Fix broken seed data for the newer domain entities.** A real
      follow-on bug from the two domain-entity expansion rounds above,
      found by tracing through the seed-data generator's code rather
      than assuming it "just worked" for the new entity types. The
      Seed Data Agent's value picker (`packages/db/src/seed.ts`) has a
      hardcoded switch on field *names*, and it only recognized the
      original 8 entities' field vocabulary (`customerName`, `service`,
      `sku`, ...). None of the 11 newer entities' field names
      (`licensePlate`, `make`, `model`, `address`, `venue`, `species`,
      `instructor`, `client`, `itemName`, `renterName`, `ownerName`,
      `assignee`) were recognized, so a freshly built Vehicle/Property/
      Course/Event/Rental/Pet app would have opened to rows of raw
      placeholder text like "Vehicle - licensePlate 1" instead of a
      believable "12-345-67". Worse, the `name` field specifically would
      have shown a random *person's* name for a MenuItem, Project, Event,
      Course, or Pet ("Dana Levi" as a dish, a project, or a dog's name),
      because the existing catalog-vs-person branch only knew about
      Service/Product. Added dedicated value pools for each new field
      (vehicle makes/models/plates, addresses, venues, species, dish
      names, project names, event names, course names/instructors) and
      routed every new field name to its matching pool. Verified: 1 new
      test asserting real values (not the `"<Entity> - <field> N"`
      placeholder pattern) for all 7 newer entity types with previously-
      unhandled fields + full suite green (143 tests) + `npm run build`
      clean + a real Playwright run: built a garage+restaurant+agency
      description through a real build and read every generated row for
      all 3 resulting entity tabs directly from the live table — real
      dish names with correct categories, real project names with real
      client names, real vehicle plates/makes/models — zero raw
      placeholder text anywhere.
- [x] **Relation fields now render as a real picker, not a raw numeric ID
      input.** A direct response to a user complaint that the generated
      code "isn't at the level" of a real app builder. The database/
      migration layer (`packages/db`) has always fully supported relation
      fields — real foreign keys, `PRAGMA foreign_keys = ON` enforcement —
      but the live-preview UI (`EntityPanel.tsx`) rendered every relation
      field as a bare `<input type="number">` asking the user to type a
      raw row id, and the table/board views just printed that raw number
      back. No domain entity actually used a relation field yet either, so
      this whole code path was both unfinished and unreachable. Fixed
      both: added `pickDisplayField`/`recordDisplayLabel` to
      `entityFormatting.ts` (prefers a field named "name"/"title", falls
      back sensibly, never throws for an entity with no fields), wired
      `EntityPanel` to fetch the related entity's records and render a
      real `<select>` of human-readable options in the create/edit form,
      and resolve the same human label in table cells and board cards
      instead of the raw id. Also gave the `Order` entity a real,
      *optional* `courierId` relation field to `Courier` (kept optional
      deliberately: a plain "orders" description has no `Courier` table
      at all, and the seeding pipeline doesn't guarantee entities seed in
      dependency order, so a required relation could fail seeding — see
      the code comment in `domainEntities.ts`). Verified: 5 new unit tests
      (`pickDisplayField`/`recordDisplayLabel` happy paths and fallbacks,
      an Order-gets-courierId regression test including the case where no
      courier is mentioned at all) + full suite green (147 tests) +
      `npm run build` clean + a real Playwright run against a real
      server: built a restaurant-with-delivery app, confirmed the Order
      form's courier field is a real `<select>` populated with the
      actual seeded courier names (not "type an ID"), picked one and
      submitted a new order, confirmed the table cell showed the
      courier's real name — then edited one of the seeded orders (whose
      `courierId` started `null`), assigned a courier there too, and
      confirmed that cell updated from the empty-state dash to the real
      name. **Scope note, stated honestly:** this round only covers the
      live preview; the exported/codegen standalone app still needs the
      same relation-picker treatment (same two-step pattern used for
      Kanban/calendar/CSV/bulk-select earlier in this log) — tracked as
      the next candidate. CSV export also still prints the raw id for a
      relation field rather than the resolved name; a known, minor,
      pre-existing gap this round didn't touch.
- [x] **Ported the relation-field picker to the exported/codegen app, and
      fixed CSV export to resolve a relation field's name (both live
      preview and export).** Follow-through on the previous round's
      explicitly stated scope gap. `apps/api/src/codegen.ts` gained the
      same `pickDisplayField`/`recordDisplayLabel`/`relationDisplayLabel`
      logic as the live preview (a small `ALL_ENTITIES` manifest baked
      into `EntityView.jsx`, since each exported entity file only knows
      its own fields), so a relation field in a *downloaded, standalone*
      app also renders a real `<select>` instead of a raw id input.
      `entityFormatting.ts`'s `recordsToCsv`/`fieldDisplayValue` (live
      preview) and `codegen.ts`'s equivalents (export) now both resolve a
      relation field to the related record's display name in the CSV too,
      not the raw stored id — closing the exact gap the previous round's
      entry flagged.
      **Found and fixed a real, independent, higher-severity bug while
      doing the actual "download the zip and run it standalone"
      verification this discipline requires:** `Order` — a real Forge AI
      domain entity, not a contrived case — is a reserved SQL keyword.
      Every table/column name in the exported `server.js` was interpolated
      into raw SQL unquoted, so `CREATE TABLE Order (...)` crashed the
      *entire* exported app at startup with a SQL syntax error, before it
      ever reached `app.listen`. This is not new breakage from this
      round's relation work — it's a latent bug that's existed since
      "Order" was added as a domain entity, invisible until an exported
      Order app was actually built, unzipped, `npm install`ed, and run
      (the live preview never hits it, since its own table names are
      internally prefixed as `entity_<projectId>_<name>`, never a bare
      keyword). Fixed by double-quoting every table/column identifier in
      the generated `server.js` (`` `"${id}"` ``, safe because `assertSafe`
      already guarantees no quote characters can appear in the name).
      Verified: 6 new unit/integration tests — codegen tests asserting
      the exported entity file carries `relationTo` and the manifest/
      picker/CSV-resolver functions exist, an `entityFormatting.ts` test
      for the CSV relation-resolution (and its backward-compatible
      default when no related-records are passed), and, critically, **a
      real execution test** (not just a syntax check) that generates a
      server.js for an `Order` entity with a `group` field (also a SQL
      keyword), spawns it as a real child process against a real SQLite
      database via a `node_modules` symlink (avoiding a slow `npm
      install` in the test itself), and makes real HTTP requests against
      it — this is the test that would have caught the table-name bug
      before it ever shipped. Full suite green (150 tests) + `npm run
      build` clean + the actual manual verification that found the bug in
      the first place, re-run after the fix: built a real "restaurant
      with delivery" project through the real API, downloaded the export
      ZIP, unzipped it, ran `npm install && npm start` as a genuinely
      standalone app, and drove it with a real Playwright browser --
      added a courier, confirmed the Order form's courier field is a real
      `<select>` with the real courier's name, submitted a new order,
      confirmed the table cell resolved to the real name, downloaded the
      CSV export via a real browser download event, and confirmed the CSV
      file itself contains the courier's real name.
- [x] **Third domain-entity expansion round: Ticket (support desk),
      Subscription (recurring billing), and JobApplicant (recruitment) --
      three more common business verticals, chosen to be genuinely
      different from the 20 entities already covered (delivery,
      real estate, education, healthcare, automotive, events, etc.), not
      more of the same.** Both `Ticket.customerId` and
      `Subscription.customerId` are real, optional relation fields to
      `Customer` — the first production use of the relation-picker work
      from the last two rounds beyond the original `Order.courierId`
      example, and it worked without any extra wiring, which is the actual
      proof that feature is genuinely general-purpose rather than
      special-cased for Order/Courier.
      **Found and fixed a real Hebrew-morphology bug while doing the
      actual browser verification, not just running the unit tests:** the
      natural, idiomatic way to say "customer support" in Hebrew is
      "תמיכת לקוחות" (construct state / סמיכות), not "תמיכה ללקוחות". The
      `Ticket` rule's keyword was only "תמיכה", and Hebrew's construct
      state changes the word's ending, so "תמיכה" is not a substring of
      "תמיכת" — the exact same class of bug as the earlier "of course"/
      "prevents" substring pitfalls, but the Hebrew-specific variant of it,
      not previously documented. Confirmed live: typing the natural phrase
      "אפליקציית תמיכת לקוחות" into a real build produced no Ticket entity
      at all before the fix. Fixed by also listing "תמיכת" as its own
      keyword, and added a permanent comment on `DOMAIN_ENTITY_RULES`
      itself documenting the general rule (prefixes like ה/ו/ב/כ/ל/מ don't
      break substring matching since the root stays contiguous at the end;
      suffix inflections like construct state do, so list each inflected
      form explicitly) so the next Hebrew keyword addition doesn't repeat
      it. Verified: 5 new unit tests (entity/field shape for all three,
      the Hebrew construct-state regression using the exact phrase that
      failed, and two substring-collision-avoidance tests proving
      JobApplicant's keywords were deliberately written as "hiring" not
      "hiring pipeline" (Deal's own keyword) and "גיוס" not "גיוס עובדים"
      (Employee's own keyword)) + a seed-data test for all three entities'
      new field names + full suite green (153 tests) + `npm run build`
      clean + two real Playwright runs against a real server: the first
      one is what caught the Hebrew bug (no Ticket tab appeared for the
      natural phrasing), the second one (after the fix) confirmed all four
      resulting entity tabs (Customer, Ticket, Subscription, JobApplicant)
      render with real seed values — real ticket subjects, real plan
      names, real job titles — and confirmed the Ticket→Customer relation
      picker itself: edited a seeded ticket (customerId started null),
      assigned a real customer from a real `<select>` of actual customer
      names, saved, and confirmed the table cell resolved to the
      customer's real name instead of staying blank or showing a raw id.

- [x] **Real one-click deployment: a `render.yaml` Blueprint + a "Deploy
      it" README section in every exported app.** A different kind of gap
      than the last several rounds — not a data-quality or UI-quality
      issue, but a genuine "own your code" completeness gap: the exported
      app told you how to run it locally but nothing about actually
      putting it online. `apps/api/src/codegen.ts` now emits a
      `render.yaml` in the same proven structure this platform's own
      `render.yaml` (repo root) already uses in production — not a
      speculative format — with a safe slugified service name (reusing
      the same slug function `package.json`'s `name` field already used,
      so this is one proven code path, not a second one to get right).
      The README gained a real "## Deploy it" section explaining the
      Render Blueprint auto-detection, plus honest guidance for any other
      long-lived-Node host (explicitly *not* a serverless/edge host,
      since this app keeps its data in a local SQLite file) via the same
      `npm install`/`npm start`/`process.env.PORT` contract already
      documented for running it locally — deployment isn't a third way
      to run the app, it's the same one, hosted. **Verification note,
      stated honestly:** this sandbox has the `docker` CLI but no
      reachable daemon and no network path to Render itself, so an actual
      Render deployment could not be run end-to-end here. What *was*
      verified for real, not just string-matched: downloaded a real
      export ZIP, confirmed `render.yaml` and the README section are
      actually present and correctly filled in, then ran the *exact*
      `buildCommand`/`startCommand` `render.yaml` declares (`npm install`,
      then `npm start`) as literal shell commands against the unzipped
      app — the same two commands Render would run — and confirmed the
      resulting server listens on `process.env.PORT` (Render's own
      contract) and serves both the frontend and a working `/api/Customer`
      response. Verified: 2 new unit tests (render.yaml structure/content,
      and a slug-safety test using a Hebrew/punctuation-heavy project name)
      + full suite green (155 tests) + `npm run build` clean + the
      real build/start verification above.

- [x] **Business Twin now reports relation-field coverage** ("In "Support
      Tickets", 2 of 2 records have no "Customer" set") — a real,
      genuinely new analytics observation, not more data-quality or
      export-infra work like the last several rounds. Follows the exact
      same honesty discipline the rest of `computeBusinessTwin`
      (`apps/api/src/twin.ts`) already uses: it reports a plain count
      derived from live data, never a guess at *why* a relation is unset.
      Generic across every entity/relation field in a project, not
      special-cased to Ticket/Customer — it only happened to be Ticket
      that made a good example this round. The observation disappears
      once a relation field is fully populated, so it's a real signal,
      not a permanent nag. Verified: 1 new unit test (asserts the
      observation appears with the right counts, then confirms it
      disappears once every record has the relation set — catching a
      real `FOREIGN KEY constraint failed` while writing the test itself,
      since the relation target row has to actually exist first) + full
      suite green (156 tests) + `npm run build` clean + a real Playwright
      run: built a support-ticket app, opened the Business Twin panel
      before assigning any customer and confirmed the "2 of 2" observation
      appeared, then assigned a customer to one ticket through the
      relation picker, reopened the Twin panel, and confirmed the
      observation live-updated to "1 of 2".

- [x] **Fourth domain-entity expansion round: Donation (nonprofit),
      Shipment (logistics/warehouse), and InsuranceClaim — three more
      distinct verticals, bringing the library to 26 recognized entity
      types.** Seed-data pools were wired in from the start this time
      (the lesson from the very first "domain entities shipped without
      seed data" bug two rounds ago), and verified with a real build
      before this entry was written, not after.
      **Found and fixed two real Hebrew substring-collision bugs while
      doing that verification, both from words that were never tested
      together before because the relevant domains didn't coexist until
      now:**
      1. "תורם"/"תורמים" (donor/donors) both *start with* "תור"
         ("turn/appointment") — a coincidental shared root, not the
         construct-state/suffix-inflection pattern from an earlier
         round's Hebrew bug. A donation-app description mentioning donors
         spuriously also produced an Appointment entity. Fixed by
         dropping the bare singular "תור" keyword from Appointment (kept
         "תורים", the plural every real test and description already
         uses, which has no such collision) rather than avoiding "תורם"
         in Donation's own keywords, since "תורם" is the actual Hebrew
         word for "donor" and dropping it there would have just made
         Donation harder to trigger for no real gain.
      2. "גיוס כספים" (fundraising) was deliberately never added as a
         Donation keyword in the first place — "גיוס" is JobApplicant's
         own keyword (recruitment), and Hebrew overloads that root for
         both "recruiting people" and "recruiting money" — caught before
         shipping by the same discipline, not after.
      Also reused "שילוח" (dispatch/freight) instead of the more obvious
      "משלוח" (parcel/delivery, already Order's keyword) for Shipment, so
      a warehouse/logistics description doesn't spuriously also match
      Order. Verified: 5 new unit tests (entity recognition for all three
      in English and Hebrew, a false-positive test for the Donation/
      JobApplicant collision that was avoided, a false-positive test for
      the Shipment/Order collision that was avoided, and a dedicated
      regression test reproducing the exact "תורמים"/Appointment bug using
      the phrase that caused it) + a seed-data test for all three entities'
      new field names + full suite green (160 tests) + `npm run build`
      clean + a real Playwright run: built an app from a description
      combining all three verticals, confirmed exactly three entity tabs
      appeared (no spurious Appointment tab), and read every generated
      row directly from the live table — real donor names and campaign
      names, real tracking numbers/carriers/destinations, real
      claimant names and policy numbers, zero raw placeholder text.

- [x] **Business Twin's second relation-aware insight: the most-linked
      record across the whole project** (e.g. "'Dana Levi' (Customers) is
      the most-linked record: 3 links total — 2 in Subscriptions, 1 in
      Tickets"). Builds directly on the relation-coverage observation
      from two rounds ago, aggregating across *every* relation field in
      the project that points to the same target entity — not just one
      field on one entity — so a customer referenced from both
      Subscriptions and Tickets gets counted once, correctly. Same
      honesty discipline as the rest of `computeBusinessTwin`: a plain
      count with a real per-source breakdown, never a guess at
      significance. Only reported when a record is actually referenced
      more than once, so a project with no real cross-entity activity
      yet stays quiet instead of reporting a meaningless single link.
      Verified: 1 new unit test (three relation fields across two source
      entities pointing at the same Customer, asserting the correct
      total and the correct per-entity breakdown counts, and that a
      customer with only 1 link is correctly *not* reported as the hub)
      + full suite green (161 tests) + `npm run build` clean + a real
      Playwright run: built a support-desk-plus-subscriptions app,
      manually linked the same seeded customer to 2 subscriptions and 1
      ticket through the relation pickers, opened the Business Twin
      panel, and confirmed the observation read exactly "3 links total —
      1 in \"Tickets\", 2 in \"Subscriptions\"" with the correct customer
      name, not a fabricated or rounded figure.
- [x] **Fresh full-app re-verification pass (2026-09-16), no code
      change.** After nine consecutive rounds of additive work above, ran
      a real Playwright pass across 390px/768px/1440px exercising several
      of the newest features together for the first time in one flow
      (multi-entity build with relation fields, table search, CSV export,
      board-view toggle, both Business Twin insights, Time Machine, dark
      mode). Found no new P0/P1 — a genuine negative result, recorded
      honestly rather than manufacturing a finding. Full details in
      `docs/product-quality-audit.md`'s "Re-verification pass" section.
- [x] **Global search across all entities (live preview).** Previously,
      finding a record meant guessing which entity tab it lived in and
      using that tab's own search box — with 26 possible entity types on
      a single build, that's real friction. Added one search panel
      (`apps/web/src/GlobalSearchPanel.tsx`, opened via a new "🔍 חיפוש"
      button next to the Business Twin button) that queries every entity
      in the project at once and groups matches by entity, each with a
      "מעבר לטאב" (jump to tab) action. The matching logic itself
      (`searchEntityRecords` in `entityFormatting.ts`) is a small pure
      function, independently unit-tested, that reuses the exact same
      `matchesSearch` rule the per-tab search already used — so a record
      that matches in one place matches in the other, by construction,
      not by convention. Verified with a real Playwright run: built a
      customers/appointments/employees app, read a real seeded customer's
      name off the table, searched for it globally, confirmed the
      "לקוחות" result group and a matching hit rendered, clicked "jump to
      tab" and confirmed the panel closed and the correct tab activated,
      then searched a deliberately non-matching string and confirmed the
      "no results" message appeared. (The first run of this script itself
      had a bug — a stray leading space from a naive
      `split(/\s+/).slice(0, 2)` on table text — which is a test-script
      defect, not a product one; fixed by filtering empty tokens before
      re-running, and the second run passed clean.) Full suite green
      (163 tests: 44 spec-engine + 24 db + 41 api + 54 web) + both builds
      clean + a from-scratch clean-room clone/install/test/build/start
      cycle, including a live `/api/health` check against the freshly
      built server.
- [x] **Ctrl/Cmd+K shortcut for global search, Escape to close panels.**
      Immediate follow-up to the global search feature above: added a
      `keydown` listener (scoped to the preview view only, so it can't
      fire while typing in the home-screen idea box or the spec-review
      form) that opens the search panel on Ctrl+K or Cmd+K — a
      command-palette convention from other tools — with `preventDefault`
      so it doesn't fall through to the browser's own address-bar
      shortcut. Escape closes whichever overlay is currently open
      (Search, Business Twin, or History), all three of which reuse the
      same overlay markup. A small "Ctrl+K" hint badge next to the search
      button makes the shortcut discoverable rather than hidden;
      `.shortcut-hint` is hidden below 640px since the affordance means
      nothing on a touch device and the header row is already tight
      there. Verified with a real Playwright run: built a real app,
      pressed Ctrl+K with focus nowhere in particular and confirmed the
      panel opened with its input auto-focused, typed the literal
      character "k" into that focused input and confirmed it lands as
      text rather than re-triggering anything, pressed Escape and
      confirmed the panel closed, repeated the open+close check against
      the Business Twin panel to prove Escape isn't wired to one specific
      panel, and pressed Meta+K to confirm the Mac modifier path works
      too. Full suite green (163 tests, unchanged — this feature is pure
      event-handling glue with no new pure-function logic to unit-test)
      + both builds clean + a from-scratch clean-room clone/install/test/
      build/start cycle with a live `/api/health` check.
- [x] **Keyboard navigation (arrow keys + Enter) in global search
      results.** Third round building out the search feature: Down/Up now
      move a highlight across the result *groups* (not individual
      records — jumping always lands on an entity tab, so the group is
      the right unit to navigate), clamped at the first/last group rather
      than wrapping, and Enter jumps to whichever group is highlighted
      and closes the panel. Deliberately left plain Enter with nothing
      highlighted alone — it still just runs the search, exactly as
      before — so nobody who types a query and hits Enter once gets
      unexpectedly bounced to a tab. A small hint line appears once
      results exist so the behavior is discoverable. Verified with a real
      Playwright run: built an app with three entities that all match a
      single-letter query (so there are multiple groups to navigate
      between), pressed ArrowDown and confirmed the first group gets a
      highlight class, pressed it again and confirmed the highlight
      moved to the second group, pressed it several more times past the
      end and confirmed it clamps on the last group instead of erroring
      or wrapping, pressed ArrowUp and confirmed it moves back, pressed
      Enter and confirmed it both closed the panel and switched to the
      correct entity tab, then re-opened search and confirmed a plain
      Enter with no prior arrow-key press still just runs the search and
      leaves the panel open (a regression check against the Ctrl+K round
      above). Full suite green (163 tests, unchanged) + both builds clean
      + a from-scratch clean-room clone/install/test/build/start cycle
      with a live `/api/health` check.
- [x] **Ported global search + Ctrl/Cmd+K + keyboard navigation to the
      exported codegen app.** The last three rounds built global search
      into the Forge AI *live preview* only — the downloadable "own your
      code" export was missing it, the same gap every other live-preview
      feature (relation picker, Kanban, calendar, CSV export, bulk-select)
      had before its own porting round. Added `web/src/components/
      GlobalSearch.jsx` to the generated app, reusing `matchesSearch` and
      `recordDisplayLabel` that `EntityView.jsx` already had (now
      exported instead of module-private) so the exported app's per-tab
      search and its new global search can never disagree about what
      counts as a match — same principle as the live preview's own
      `searchEntityRecords`. `App.jsx` gained the same Ctrl/Cmd+K
      listener, Escape-to-close, and a visible shortcut hint. Verified
      with the full real pipeline this kind of change requires: built a
      real app in the live Forge AI preview, clicked the actual "⬇️ ייצוא
      קוד" button to trigger a real browser download of the exported zip,
      unzipped it, ran a real `npm install` and `vite build`, started the
      generated `server.js` as a real child process, then opened a
      *second* real browser against that standalone server (not the
      generated code in isolation) and exercised the ported feature
      there: created a real record through the exported app's own add-record
      form (the export never carries over Forge AI's own live-preview demo
      data, so there was nothing to search until a record existed),
      confirmed the "Ctrl+K" hint renders, pressed Ctrl+K to open search,
      searched for that record and got a real hit, pressed ArrowDown and
      confirmed a result group highlighted, pressed Enter and confirmed it
      jumped to the entity's tab and closed the panel, then re-opened with
      Ctrl+K and confirmed Escape closes it too. Also added unit-level
      content tests to `codegen.test.ts` (19 tests now, up from 18) that
      would catch a broken import/export wiring between `GlobalSearch.jsx`
      and `EntityView.jsx` without needing the full browser cycle every
      time. Full suite green (164 tests: 44 spec-engine + 24 db + 42 api +
      54 web) + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.
- [x] **CSV import for entities (live preview).** The natural complement
      to the CSV export added a few rounds ago — "download my data" only
      goes one direction without a way to bring a spreadsheet *in*, and
      that's exactly the "I have my customer list in Excel" case a real
      small business runs into. Two new pure functions in
      `entityFormatting.ts`: `parseCsv` (a real RFC-4180 parser — quoted
      fields with embedded commas/newlines, doubled-quote escapes, both
      CRLF and bare LF line endings) and `buildImportRecords` (matches
      CSV columns to fields by header text — label or field name,
      case-insensitively — then coerces each cell to the field's real
      type: booleans, numbers, and enum values resolved from either their
      raw value or translated label). Deliberately scoped: a relation
      column is ignored if optional, and the whole import is refused with
      one clear message (not attempted row-by-row) when the entity has a
      *required* relation field, since resolving a label like "Dana Levi"
      back to the right foreign-key id needs the related entity's records
      loaded — an honest "not supported yet" rather than silently
      producing broken records. The import button (⬆️ ייבוא מ-CSV) is
      always visible in `EntityPanel.tsx`, including on an entity with
      zero records, unlike CSV export which needs something to export
      first. Invalid rows (missing required field, bad number, unknown
      enum option) are skipped individually with a per-row reason, shown
      on demand behind a "Show errors" toggle rather than blocking the
      valid rows from importing. Verified with a real Playwright run:
      built a Customer app, uploaded a real 4-row CSV file (two valid
      rows, one missing the required name, one with an invalid status
      value) through the actual file input, confirmed exactly 2 records
      were created and appear in the table, confirmed the 2 invalid rows
      were correctly rejected and did NOT appear, and confirmed both
      rejection reasons show up correctly worded under "Show errors".
      12 new unit tests for `parseCsv`/`buildImportRecords` (including a
      round-trip test against `recordsToCsv`'s own output). Full suite
      green (176 tests: 44 spec-engine + 24 db + 42 api + 66 web) + both
      builds clean + a from-scratch clean-room clone/install/test/
      build/start cycle with a live `/api/health` check.
- [x] **Ported CSV import to the exported codegen app.** Immediate
      follow-up to the CSV import round above, same porting pattern as
      global search before it: added `parseCsv`/`buildImportRecords` (the
      same RFC-4180 parser and header-matched type coercion, translated
      to plain JS) directly into the generated `EntityView.jsx`, plus an
      always-visible import file input, per-row error reporting behind a
      "Show errors" toggle, and the same up-front refusal for a required
      relation field. Verified with the full real pipeline codegen
      changes require: built a real Customer app, clicked the actual
      export button for a real browser download, unzipped it, ran a real
      `npm install` and `vite build`, started the generated `server.js`
      as a real child process, then opened a second real browser against
      that standalone server and uploaded an actual 4-row CSV file (2
      valid rows, one missing the required name, one with an invalid
      enum value) through the exported app's own file input — confirmed
      exactly 2 records were created and appear in its table, the 2
      invalid rows were correctly rejected, and both rejection reasons
      show up under "Show errors", all inside the standalone exported
      app with zero dependency on Forge AI. Added one content test to
      `codegen.test.ts` (20 tests now, up from 19) checking the generated
      `EntityView.jsx` actually contains the ported functions and CSS.
      Full suite green (177 tests: 44 spec-engine + 24 db + 43 api + 66
      web) + both builds clean + a from-scratch clean-room clone/install/
      test/build/start cycle with a live `/api/health` check.
- [x] **Confirmation dialog before deleting a single record.** A real
      inconsistency, not a new feature: bulk-delete already asked
      "Delete 3 records? This can't be undone." before running, but a
      single row's own Delete button just deleted immediately with no
      chance to back out — one careless click and a record was gone. Both
      `EntityPanel.tsx` (live preview) and the generated
      `EntityView.jsx` (exported app) now show a `window.confirm` naming
      the specific record by its own display label (reusing
      `recordDisplayLabel`, the same function relation pickers and CSV
      export already use) before deleting it, matching the bulk-delete
      pattern exactly. Verified with a real Playwright run covering both
      apps: built a live Customer app, clicked Delete on a row, confirmed
      the dialog text named that exact customer, dismissed it and
      confirmed the row was still there, then clicked Delete again and
      accepted, confirming the row was actually removed — then exported
      that same app for a real download+unzip+npm install+vite build+
      server start cycle and repeated the identical dismiss/accept check
      against the standalone exported app's own Delete button, with the
      same result. One content test added to `codegen.test.ts` (21 tests
      now, up from 20). Full suite green (178 tests: 44 spec-engine + 24
      db + 44 api + 66 web) + both builds clean + a from-scratch
      clean-room clone/install/test/build/start cycle with a live
      `/api/health` check.
- [x] **Vendor, Expense, and Review domain entities.** Three more entities
      for `domainEntities.ts`, filling gaps the existing 26 didn't cover:
      Vendor/Supplier (who the business buys *from*, the mirror of
      Customer, who it sells *to*), Expense (business expense tracking:
      description/amount/category/vendor/date/status), and Review
      (customer feedback with a rating). Caught a real collision risk
      before it ever shipped, not after: bare "rating" is a substring of
      "operating"/"collaborating"/"generating" and bare "review" is a
      substring of "preview" — the exact "events" ⊂ "prevents" pitfall
      this file's own header has warned about since the Donation/Shipment
      round, and the same reason Event's own keywords use "event
      planning"/"conference" instead of bare "event". Used the safe
      multi-word phrases ("customer review", "customer feedback",
      "product review", "testimonial", Hebrew "ביקורת"/"משוב"/"דירוג")
      instead, and added two regression tests that build real descriptions
      containing "operating" and "preview" and assert Review does NOT
      spuriously appear. Also improved `packages/db/src/seed.ts`: a
      "rating" field now seeds a real 1-5 value instead of every other
      numeric field's generic `(index+1)*10` formula (which would have
      produced an obviously-broken rating of 10 or 20), Vendor's own
      "name" field gets a real business-name pool instead of falling into
      the generic person-name default every unrecognized "name" field
      gets, and new pools cover contactPerson/reviewerName (person names)
      and Expense's own description/vendor fields. Verified with a real
      Playwright run: built an app from a Hebrew description combining
      all three ("ניהול ספקים ורכש, מעקב הוצאות של העסק, ואיסוף ביקורות
      ומשוב מלקוחות"), confirmed all three tabs appeared with genuinely
      realistic seed data (a real vendor company name, a real expense
      description referencing a real vendor, and a rating value
      confirmed in the real 1-5 range) rather than a raw placeholder
      string. 8 new tests across spec-engine (entity detection + the two
      collision regressions) and db (seed-value pools). Full suite green
      (181 tests: 46 spec-engine + 25 db + 44 api + 66 web) + both builds
      clean + a from-scratch clean-room clone/install/test/build/start
      cycle with a live `/api/health` check.
- [x] **"Backup All Data" — one ZIP with every entity's CSV.** Until now,
      getting your data out meant visiting every entity tab and clicking
      its own CSV export button one at a time. A new "⬇️ גיבוי כל הנתונים"
      button on the preview screen hits a new `GET /projects/:id/backup`
      endpoint that fetches every entity's records once, builds one real
      Excel-friendly CSV per entity (BOM + CRLF, relation fields resolved
      to the related record's display label, enum values shown as their
      translated label — the same formatting rules the per-tab CSV export
      already uses), and zips them with the exact same dependency-free
      `zip.ts` writer the code-export endpoint has used since round 4 —
      no new zip logic, no new dependency. The formatting logic
      (`apps/api/src/backup.ts`) intentionally mirrors rather than imports
      `entityFormatting.ts`'s `recordsToCsv`, following this codebase's
      established pattern of duplicating small, self-contained formatting
      helpers per surface (live preview, exported codegen app, and now
      the server) rather than a cross-package dependency for a few dozen
      lines of pure formatting. Verified with a real Playwright run: built
      a customers/appointments app, clicked the real backup button,
      caught the real browser download, unzipped it, and confirmed
      exactly one correctly-named CSV per entity tab, each containing a
      real header row and real seeded data rows — not an empty or
      placeholder file. 5 new unit tests for `backup.ts` (header
      generation, real record formatting, relation-label resolution, CSV
      escaping) plus a route-level test in `app.test.ts` mirroring the
      existing export-endpoint test (refuses before build with 409,
      returns a real ZIP with a `<EntityName>.csv` entry for every entity
      in the built spec). Full suite green (187 tests: 46 spec-engine +
      25 db + 50 api + 66 web) + both builds clean + a from-scratch
      clean-room clone/install/test/build/start cycle with a live
      `/api/health` check.
- [x] **WhatsApp two-way sync — direct user request** ("שהאפליקציה תדע
      להסתנכרן עם ואטסאפ"), **replaced mid-flight by a second, explicit user
      decision.** The first version of this feature (round 19) was built
      against Meta's official WhatsApp Business Platform (Cloud API) —
      real settings storage, a real webhook verification handshake, real
      Cloud API send calls. The user rejected that approach outright
      ("לא רוצה שתבנה תלות בחשבון Meta Business" — "I don't want you to
      build a dependency on a Meta Business account") before ever using it
      live, and explicitly approved the only real alternative once its
      trade-off was disclosed to her: connecting the way WhatsApp Web/
      Desktop does — scanning a QR code with your own phone links this
      server as an additional device, no Meta account of any kind. This is
      an **unofficial method**, against WhatsApp's own official terms of
      service (written around their official clients and the Business
      API), carrying a real, if usually small, risk that a number showing
      automated behavior gets flagged. She confirmed she understood that
      risk and wanted this built anyway. The entire Meta-based
      implementation (settings table, Cloud API client, webhook route) was
      removed and replaced, not kept alongside, since she does not want
      that dependency to exist at all:
      - `packages/db/src/whatsapp.ts`: `whatsapp_settings` (Meta
        credentials) replaced by `whatsapp_connections`, which only
        remembers each project's last-known linked phone number for
        display — the live connected/disconnected state always comes from
        the in-memory connection manager below, since a real process
        restart drops any live socket regardless of what a DB row says.
        `whatsapp_messages` (the in/out log) is unchanged.
      - New `apps/api/src/whatsappWeb.ts` (`WhatsAppWebManager`): manages
        one real `@whiskeysockets/baileys` WhatsApp Web socket per
        connected project — QR-code pairing, auth-state persistence to
        disk (survives a same-process reconnect; a real redeploy still
        requires re-scanning, exactly like unplugging a linked device),
        sending text messages, and logging/matching incoming messages
        using the same phone-number-matching logic from round 19
        (`apps/api/src/whatsapp.ts`, trimmed to just that logic once the
        Meta-specific code was removed). The socket/QR-encoder factories
        are injectable, the same testability seam this codebase has used
        throughout (e.g. `fetchImpl` in round 19, `SpecProvider`
        elsewhere).
      - New routes replacing the old settings/webhook pair: `GET
        .../whatsapp/status` (poll target), `POST .../connect`, `POST
        .../disconnect`, `POST .../send`, `GET .../messages`. No public
        webhook route exists any more — Baileys delivers incoming messages
        as a direct socket event, not an HTTP callback from a third party.
      - The "💬 WhatsApp" panel was rebuilt around this flow: a Connect
        button, a live QR code image once one arrives, a connected state
        showing the linked phone number with a Disconnect button, and the
        same test-send form and message log as before. The prerequisite
        text now explains the QR-link method and states the ToS/risk
        trade-off plainly instead of asking for Meta credentials.
      - **A real, disclosed limitation found while building this, not
        after:** this development sandbox's outbound network only tunnels
        HTTPS through a proxy — a direct probe against the real
        `@whiskeysockets/baileys` library confirmed the raw WebSocket
        connection it needs to reach WhatsApp's own servers is not
        reachable from here at all, so no real QR code could be generated
        or verified end-to-end in this environment. Everything upstream of
        that one live network call — connection state machine
        (connecting → qr → connected → disconnected), QR encoding,
        message send/receive wiring, phone-to-record matching, every HTTP
        route, the UI — is fully real and fully tested (24 new unit tests
        across `whatsapp.test.ts`/`whatsappWeb.test.ts`/db tests, using an
        injected fake socket, plus 4 new route tests in `app.test.ts`
        exercising the real HTTP connect/status/send/disconnect surface
        end-to-end). A real Playwright run confirmed the UI correctly
        reaches and stays in an honest "מתחבר…" (connecting) state when no
        QR arrives, rather than fabricating one. On Render's normal
        internet access this should work; **that specific claim is
        unverified from here and needs a real scan on the live site to
        confirm** — flagged plainly to the user rather than claimed as
        proven.
      - Known v1 limitation carried over honestly: no automatic reconnect
        after a transient socket drop — the project owner clicks Connect
        again. A production-grade version would reconnect automatically
        and only give up on an explicit logout.
      - Full suite green (214 tests: 46 spec-engine + 34 db + 68 api + 66
        web) + both builds clean + a from-scratch clean-room clone/
        install/test/build/start cycle with a live `/api/health` check.
      - **Self-review hardening pass (same round, before the user ever
        tried it live):** ran the `code-review` skill at high effort
        against the four new WhatsApp files, which surfaced four real
        bugs, all fixed with regression tests: (1) event handlers were
        wired with a bare `void asyncFn()`, discarding the promise
        without a rejection handler — a DB error mid-handler (e.g.
        `SQLITE_BUSY`, a disk error) would have become an unhandled
        promise rejection and **crashed the entire API process**, not
        just the WhatsApp feature; every handler now has a real
        `.catch()` into a new `logHandlerError`, verified by a test that
        closes the DB mid-handler and asserts on a real
        `process.on("unhandledRejection", ...)` listener that nothing
        escapes. (2) `connection.update`/`messages.upsert` handlers
        looked a session up by project id alone, so a late event from an
        already-disconnected socket (a real, plausible timing — logout()
        sends the request, the socket's own close event follows async)
        could clobber a *newer* session created by a fast reconnect;
        handlers now close over the exact session object they were
        registered for and no-op if the map no longer holds that same
        object, verified by a disconnect-then-reconnect-then-stale-close
        test. (3) the WhatsAppPanel's disconnected-state view never
        rendered `status.error`, so a connect attempt that failed
        immediately showed no explanation — fixed. (4) a single dropped
        status poll (one network blip) permanently stopped polling with
        no retry and no visible error, stranding the QR screen forever;
        polling now tolerates transient failures and only gives up (with
        a visible error) after 5 consecutive misses. Full suite green
        again (218 tests: +2 db-error/race regression tests) + both
        builds clean + a from-scratch clean-room clone/install/test/
        build/start cycle + a real Playwright re-check that the connect
        flow still reaches the same "connecting" state with no
        regression.
- [x] **"Backup All Data" ported to the exported standalone app.** Round
      21's live-preview backup feature now also exists in every app
      generated by `GET /projects/:id/export`: the exported `server.js`
      gets its own `GET /api/backup` route, and the exported `App.jsx`
      gets a "⬇️ Backup All Data" link next to the search button. Follows
      this codebase's established rule for this feature — duplicate the
      small formatting/zip logic per surface rather than share it across
      a package boundary — so the generated `server.js` embeds its own
      copy of the dependency-free ZIP writer (`buildZip`/`crc32`, same
      design as `apps/api/src/zip.ts`) and its own CSV-building logic
      (mirroring `apps/api/src/backup.ts`: BOM + CRLF, relation fields
      resolved to a display label, enum values to their translated
      label). The server's own `ENTITIES` manifest gained a `relationTo`
      field it was missing (already present in each entity's own
      generated file) so relation labels can resolve server-side.
      Verified two ways: a new codegen test spawns the real generated
      `server.js`, creates real records over its own CRUD API, hits its
      real `/api/backup` endpoint, and unzips the response with the
      system `unzip` utility to confirm a correct BOM, real inserted
      data, and a correctly-translated enum label — not a placeholder.
      Then, per this project's standing rule for any `codegen.ts` change,
      a full separate Playwright run: built an app in the live product,
      clicked the real "⬇️ ייצוא קוד" button and caught the real browser
      download, unzipped it, ran a real `npm install` and `npx vite
      build` in a directory with no relationship to this repo, started
      the real generated server, and — in a genuine second browser page
      — loaded the standalone app, confirmed the Backup All Data link is
      present, clicked it, caught a second real browser download, and
      unzipped it to confirm real `Customer.csv`/`Service.csv` entries.
      Full suite green (216 tests) + both builds clean + a from-scratch
      clean-room clone/install/test/build/start cycle with a live
      `/api/health` check.
- [x] **"Duplicate record" quick action (live preview).** A new "שכפול"
      (Duplicate) button next to Edit/Delete on both the table and Kanban
      board views copies a record's own field values into a real new
      record via the existing `createRecord` call — useful for a
      recurring appointment or a near-identical order without retyping
      the whole form. No confirmation dialog, unlike delete, since
      duplicating creates rather than destroys data. Verified with a real
      Playwright run: duplicated one of the build pipeline's own seeded
      records, confirmed exactly one new row appeared with the same
      value, then edited the duplicate's name and confirmed the
      original stayed unchanged — proving the two are genuinely
      independent records, not the same row rendered twice. Full suite
      green (218 tests) + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.
- [x] **"Duplicate record" ported to the exported standalone app.** Same
      Duplicate button and `handleDuplicate` logic as the live preview
      (copy a record's own field values into a real new record via
      `createRecord`, no confirmation dialog), now generated into every
      exported app's `EntityView.jsx`, wired into both the table row
      actions and the Kanban `BoardCard`. Verified with a real codegen
      test (checks the generated source for the handler, its real
      `createRecord` call, the absence of `window.confirm` in it, and
      both wiring sites) plus a full Playwright run per this codebase's
      standing rule for any `codegen.ts` change: exported a real app,
      downloaded the real zip, ran a real `npm install` and `npx vite
      build` in a directory unrelated to this repo, started the real
      generated server, and — in a genuine second browser page — created
      a real record through the exported app's own form (the export has
      no build-pipeline seed data, unlike the live preview, so this
      round's test creates one directly, skipping any disabled
      placeholder `<option>` when picking an enum value), clicked
      Duplicate, and confirmed exactly one new row appeared with the
      same value. Full suite green (219 tests) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with
      a live `/api/health` check.
- [x] **Accessibility pass: real dialog semantics + missing labels.** A
      general audit of the live preview (no user complaint prompted this
      — the same self-directed quality-check pattern as the earlier
      full-app audit round) found that all four overlay panels (History,
      Business Twin, WhatsApp, global search) were CSS overlays with no
      real dialog behavior: no `role="dialog"`/`aria-modal`, no focus
      moved into the panel on open, no focus trap (Tab could walk
      straight through the panel into the live-preview content
      "underneath" it), and no focus returned to whatever opened it on
      close. Also found: three search/instruction inputs relying on
      `placeholder` alone with no `aria-label` (a screen reader
      announces those as unlabeled fields), sortable table headers
      exposing sort direction only as a `▲`/`▼` glyph (no `aria-sort`),
      and the WhatsApp message log's inbound/outbound icons carrying no
      text alternative.
      - New `apps/web/src/useDialogFocusTrap.ts`: a small shared hook
        (not a UI library) that moves focus into a panel on mount unless
        something inside it already has focus (so `GlobalSearchPanel`'s
        existing `autoFocus` search box keeps working, unchanged), traps
        Tab/Shift+Tab within the panel's own focusable elements, and
        restores focus to the previously-focused element (the trigger
        button) on unmount.
      - Applied to all four panels with `role="dialog"`, `aria-modal`,
        and `aria-labelledby` pointing at each panel's own `<h2>` (given
        a real `id`) — no new translation strings needed, since the
        heading text already exists.
      - `aria-label` added to the per-entity search box, the global
        search box, and the refine-instruction input; `aria-sort` added
        to sortable table headers; `aria-label` added to the WhatsApp
        log's inbound/outbound icons (two new translated strings).
      - Verified with a real Playwright run driving actual keyboard
        events (not a simulated/mocked focus check): opened the History
        panel, confirmed `role="dialog"`/`aria-modal="true"`, confirmed
        focus moved into it on open, pressed Tab 15 times in a row and
        confirmed focus never left the panel (a genuine trap, not just
        the first Tab), pressed Escape and confirmed the panel closed
        *and* focus returned to the exact trigger button that opened it,
        then spot-checked the other three panels for the same
        `role="dialog"` wiring and confirmed the global search box's
        `autoFocus` still wins over the trap's own focus-on-open logic.
        Full suite green (219 tests, unaffected) + both builds clean + a
        from-scratch clean-room clone/install/test/build/start cycle
        with a live `/api/health` check.
- [x] **Three more domain entities: WorkOrder, Volunteer, Case.** Extends
      the heuristic (offline, no-LLM) domain library with three
      previously-uncovered small-business categories: **WorkOrder**
      (field-service/repair jobs — plumbers, electricians, AC
      technicians; deliberately does *not* reuse Vehicle's own
      "מוסך"/"מכונאי"/"garage"/"mechanic" keywords, so a garage idea
      doesn't ambiguously blur into an unrelated WorkOrder match),
      **Volunteer** (a nonprofit's own people who donate time, distinct
      from a Donor and pairing naturally with the existing Donation
      entity), and **Case** (a law firm/legal consultant's case files —
      the one professional-services domain not yet covered; Patient
      covers healthcare, Student covers education). Every new keyword
      was checked by hand against this file's own documented pitfalls
      (English short-substring collisions, Hebrew construct-state suffix
      inflection) before being added — caught one for real while writing
      the tests: the natural plural phrasing a real idea would use
      ("קריאות שירות", "תיקים משפטיים") is *not* a substring of the
      singular/construct keyword form ("קריאת שירות", "תיק משפטי"), so
      both forms are now listed explicitly, the same fix already applied
      to `תמיכה`/`תמיכת` for Ticket in an earlier round.
      `packages/db/src/seed.ts`'s existing `technician`-shaped-field
      branch was extended to route through the real person-name pool
      instead of the generic placeholder formula (one line — `technician`
      genuinely is a person's name, same reasoning as `assignee`/`owner`).
      Verified with new `heuristic.test.ts` tests (positive match in
      English and Hebrew for all three, plus a regression test proving
      WorkOrder does *not* spuriously fire on bare "garage"/"mechanic"),
      a new `seed.test.ts` test confirming real seed values (not the
      generic placeholder) for all three, and a real Playwright run: built
      three separate real apps (one per new domain, in Hebrew), opened
      each entity's live tab, and confirmed real non-empty seeded rows
      rendered with no console errors — including confirming the
      technician name fix landed (a real Hebrew name, not
      "WorkOrder - technician 2"). Full suite green (222 tests) + both
      builds clean + a from-scratch clean-room clone/install/test/build/
      start cycle with a live `/api/health` check.

- [x] **Retry button for a failed WhatsApp send.** A message that failed to
      send (e.g. a momentary socket write error on the unofficial QR-based
      Baileys connection) sat in the message log forever with only a
      "Failed" badge — the only way to try again was retyping it into the
      test-send form. `WhatsAppPanel.tsx` now shows a "Retry" button next
      to each failed *outgoing* log entry while connected; clicking it
      re-sends the exact same recipient and body already stored on that
      log entry (`sendWhatsAppMessage(projectId, m.toNumber, m.body)`) and
      refreshes the log. The original failed entry is intentionally left
      as-is — the log is an append-only history, so a successful retry
      shows up as a second, separate "sent" entry rather than mutating the
      first one, matching how every other message in the log already
      behaves. Also fixed a stale comment in `api.ts` left over from the
      earlier Meta Business API version (referred to Meta rejecting the
      token/number; the unofficial QR/Baileys connection has no such
      thing). New backend test in `app.test.ts` drives the real HTTP
      send route with a fake socket that fails once then succeeds,
      asserting the failed entry survives untouched and the retry lands as
      a new "sent" entry. Verified live in the browser too: booted a real
      local server with the fake-socket `WhatsAppWebManager` injected
      (same DI seam the backend tests use, since a real Baileys/WhatsApp
      connection is unreachable from this sandbox), drove the actual UI
      with Playwright end to end — signed up, built a real project,
      connected WhatsApp, armed the fake socket to fail one send, watched
      the "Failed" badge and Retry button appear, clicked Retry, and
      confirmed a second, successfully-sent entry appeared without
      disturbing the original failed one. Full suite green (223 tests
      total, 74 of them in `apps/api`) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with a
      live `/api/health` check.

- [x] **"Clear history" for the WhatsApp message log.** The log had no
      ceiling and no way to wipe it — a project used for a while just
      accumulated every test and real message forever. Added a real
      `DELETE /projects/:id/integrations/whatsapp/messages` route (goes
      through the same `requireOwnedProject` ownership check as every
      other project route, so one user can never clear another's log), a
      `clearWhatsAppMessages(db, projectId)` helper in
      `packages/db/src/whatsapp.ts`, and a "Clear history" button in
      `WhatsAppPanel.tsx` next to the log heading — only rendered when
      there's actually something to clear — guarded by a
      `window.confirm()`, the same confirmation pattern already used for
      record deletion elsewhere in the app (`EntityPanel.tsx`). New
      `whatsapp.test.ts` DB-level tests (wipes only the target project's
      rows, leaves another project's untouched; a harmless no-op on an
      empty log) and a new `app.test.ts` route-level test driving the
      real HTTP DELETE end to end across two separate connected projects,
      asserting only the targeted one's log was wiped. Verified live too:
      booted a real local server with the fake-socket `WhatsAppWebManager`
      injected (same DI seam as the retry-button round, since a real
      Baileys/WhatsApp connection is unreachable from this sandbox), and
      drove the real UI with Playwright — confirmed the Clear button is
      hidden while the log is empty, sent two real messages, clicked
      Clear, confirmed the panel shows the empty state, then made a
      completely independent `GET /messages` call (not the panel's own
      client state) to confirm the delete really happened server-side.
      Full suite green (226 tests total) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with a
      live `/api/health` check.

- [x] **Self-review pass on the last two WhatsApp rounds (retry + clear
      history) — found and fixed a real bug.** Ran the `code-review` skill
      at high effort over the diff since the domain-entity round, following
      the standing practice recorded after the earlier WhatsApp self-review
      (see the "Fix crash risk and race condition" entry above). It found
      one real issue: `sendWhatsAppMessage()` always did `res.json()` and
      returned the body as `WhatsAppSendResult`, but a `409` "not
      connected" response — thrown by the route *before* it ever calls
      `insertWhatsAppMessage()` — comes back as the shared `{error, code}`
      shape every other route's error middleware uses, not this route's own
      `{ok, error}` shape. `handleRetry()` in `WhatsAppPanel.tsx` never
      checked `.ok`, so if WhatsApp disconnected between a message failing
      and the user clicking Retry, the button just silently flipped back to
      "Retry" with zero feedback and no change to the log — a real,
      plausible sequence, since the panel's status polling stops the
      moment it first reaches "connected" and has no way to notice a later
      drop. Fixed by having `sendWhatsAppMessage()` normalize any response
      missing an `ok` field into `{ok: false, error: <translated message>}`
      via the same `error.<CODE>` translation path every other route's
      errors already use (also added the missing
      `error.WHATSAPP_NOT_CONNECTED` translation, which had been silently
      falling back to raw English text), and having `handleRetry()` show
      that error next to the log instead of swallowing it. New
      `apps/web/src/api.test.ts` (first real unit test file for `api.ts`)
      covers all three response shapes `sendWhatsAppMessage()` can see: a
      normal success, this route's own `{ok:false, error}` 502 shape
      (passed through unchanged), and the shared `{error, code}` 409 shape
      (normalized). Verified live too: booted a real local server with the
      fake-socket `WhatsAppWebManager` injected, drove Playwright through
      the exact bug scenario — failed a send to get a Retry button,
      dropped the fake connection to simulate WhatsApp disconnecting in
      the background, clicked Retry, and confirmed a real, visible error
      message now appears (and the log's entry count correctly stays
      unchanged, matching the server never inserting a row on that path) —
      instead of the old silent no-op. Full suite green (229 tests total)
      + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Fix the WhatsApp panel's root cause for going stale: it never
      noticed a disconnect after the fact.** Direct follow-up to the
      previous round's fix, which patched the *symptom* (Retry silently
      doing nothing on a stale "connected" status) — this round fixes the
      actual cause. `WhatsAppPanel.tsx`'s status polling (`startPolling`)
      stopped for good the instant it first reached `"connected"`, so if
      WhatsApp dropped the link *later* — the phone loses signal, the user
      unlinks the device from their phone's own WhatsApp settings, the
      account gets flagged — with zero action inside this app, the panel
      had no way to ever find out; it would just keep showing "Connected"
      indefinitely. Added a second, slower background poll
      (`CONNECTED_POLL_INTERVAL_MS = 10000`, vs. the fast 1.5s poll used
      only while waiting for a QR scan) that runs for the whole time
      status is `"connected"`, refreshing the real status and switching
      the panel back to the disconnected/connect view the moment it
      notices the drop — wired in everywhere the panel can first reach
      "connected" (initial mount, the tail end of the fast poll, matching
      `stopPolling()`/cleanup calls added everywhere the fast poll already
      stopped, including a new `stopConnectedPolling()` call in
      `handleDisconnect` for a manual disconnect). Verified live: booted a
      real local server with the fake-socket `WhatsAppWebManager`
      injected, drove Playwright through the actual scenario this fixes —
      connected the panel, then dropped the fake connection from the
      *server* side with **zero** action in the browser — and confirmed
      that within 15 seconds, with nothing clicked, the panel's background
      poll noticed on its own and switched back to the disconnected view.
      Both builds clean + full suite still green (no test file changed
      this round; the added logic is pure client-side polling scheduling,
      verified live instead) + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Self-review of the auth module — first self-review of anything
      outside WhatsApp this session — found and fixed 2 real bugs.**
      Every prior self-review round had focused on the WhatsApp code
      specifically; the auth module (`apps/api/src/routes/auth.ts`,
      `apps/api/src/auth/middleware.ts`, `apps/api/src/auth/password.ts`)
      had never been reviewed on its own. Ran `code-review` at high
      effort and found: (1) **email casing was never normalized** —
      `createUser`'s uniqueness check and `findUserByEmail`'s lookup
      (`packages/db/src/users.ts`) both do an exact-match SQL comparison
      against whatever casing was stored, so signing up as
      `"User@Example.com"` and later logging in as `"user@example.com"`
      (something anyone could naturally type) failed with 401, and it let
      two accounts exist for what a human would consider the same
      address; (2) **a validation failure sent `ZodError.message`
      directly as the error text**, which is `JSON.stringify()` of the
      internal issues array, not a sentence — `httpError.ts` documents
      `message` as the readable fallback for any error code a client
      doesn't recognize, so any consumer other than this app's own web
      client (which happens to always prefer its own translated
      `VALIDATION_ERROR` message) would see a raw JSON blob instead of
      "password must be at least 8 characters". Fixed both: emails are
      now lowercased in `CredentialsSchema` itself — the one point every
      signup/login request already passes through — and a small
      `formatValidationError()` joins the real per-issue messages instead
      of dumping the whole `ZodError`. Two more findings from the same
      review were deliberately left for later: a login timing
      side-channel (verifying the password only when the email exists)
      adds no real new risk here, since signup's own `EMAIL_TAKEN`
      response already lets anyone enumerate registered emails; and
      `/auth/logout` re-parsing the `Authorization` header instead of
      sharing extraction logic with `requireAuth` isn't currently causing
      a bug, just a maintainability coupling. New `app.test.ts` tests:
      signing up as `"Dana@Example.com"`, logging in as
      `"dana@example.com"`, and a second signup as `"DANA@EXAMPLE.COM"`
      correctly bouncing as `EMAIL_TAKEN`; and an invalid signup payload
      getting back a real sentence, asserted to not even look like JSON.
      Verified live too: booted the real built server, signed up through
      the actual UI form with a mixed-case email, then in a fresh browser
      context logged in with the fully-lowercased version of the same
      email and reached the real home screen. Full suite green (231
      tests total) + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Cleaned up the two smaller findings the auth self-review left
      open.** Extracted a single `extractBearerToken(req)` in
      `auth/middleware.ts`, now used by both `requireAuth` and
      `/auth/logout` instead of `/auth/logout` re-parsing the
      `Authorization` header on its own — a fragile coupling where the two
      call sites could silently drift apart if the extraction logic ever
      changed in only one place. While unifying it, also fixed the
      case-sensitive `"Bearer "` scheme match the same review flagged:
      RFC 7235 treats the scheme name itself as case-insensitive, so a
      client sending `bearer <token>` (lowercase) was wrongly rejected —
      now matched with `/^Bearer\s+(.+)$/i`. This also closed a real test
      gap: there was no test at all for `/auth/logout`, or for scheme-name
      casing. New `app.test.ts` test drives the real HTTP routes end to
      end — a lowercase `bearer` header is accepted, and after a real
      logout the very same token is rejected on the next request (not
      just asserted against a mock). Verified live too: booted the real
      built server from a fresh clean-room clone and ran actual `curl`
      requests against it — signed up, hit `/api/projects` with a
      lowercase `bearer` header (200), logged out (204), then hit
      `/api/projects` again with the exact same token and got a real 401
      `SESSION_EXPIRED`. (The remaining finding from that review — the
      login timing side-channel — stays deliberately unaddressed: signup's
      own `EMAIL_TAKEN` response already lets anyone enumerate registered
      emails, so fixing only the login path's timing wouldn't remove any
      real risk in this app's actual threat model.) Full suite green (232
      tests total) + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Self-review of `codegen.ts` — the largest file in the codebase,
      never reviewed before — found a real crash bug and rejected a
      colliding field name at the source.** `codegen.ts` (the exported
      standalone-app generator, ~1,900 lines) had never had a dedicated
      review pass. Ran `code-review` at high effort and it found that
      every generated table hardcodes `id` and `createdAt` as built-in
      columns — true both for the live preview's own migration code
      (`packages/db/src/migrate.ts`) and the exported app's generated
      `server.js` (`codegen.ts`) — and nothing anywhere stopped an
      entity's own field from being named either one. An AI-generated
      spec with a field literally named `id` or `createdAt` (plausible:
      plenty of real business entities naturally have a creation-date-like
      field) produces a duplicate-column `CREATE TABLE`, which throws
      uncaught; for the exported app specifically, that means the whole
      generated server crashes before it can even start listening, with
      no Debug Agent safety net the way the live preview sometimes has.
      Fixed at the one point every spec — heuristic, the real Anthropic
      provider, and its own repair path in `debug.ts` — already gets
      validated: `FieldSchema` in `packages/shared/src/index.ts` now
      rejects a field named `id` or `createdAt` in any casing. This plugs
      straight into `generateSpec`'s existing fallback machinery for
      free — a bad name from the AI now just falls back to the heuristic
      provider (which never produces one, confirmed by grep across every
      curated entity template) instead of ever reaching either database
      layer. New tests in `spec-engine`'s `index.test.ts` use the real
      `AnthropicSpecProvider` class itself (not a hand-rolled stand-in
      that would skip its own internal validation) to prove both the
      direct rejection and the full end-to-end fallback. Verified live
      too — and this surfaced a genuinely useful side-finding: an initial
      verification attempt used a naive hand-written fake provider that
      skipped the real validation step, and that let a colliding spec
      reach `insertProject`, where it was stored successfully and then
      crashed on the very next read — because
      `packages/db/src/projects.ts`'s `rowToProject()` re-validates every
      stored spec against the *current* schema on every single read with
      a hard `.parse()`. Tightening the schema is only safe here because
      no spec that would now be rejected could ever have been
      successfully created via either *real* provider (both already
      validate before returning) — but the general fragility of
      re-validating old stored data against an evolving schema is a real,
      separate architectural question, noted for a future round rather
      than patched as a rushed afterthought here. Re-ran the verification
      correctly with the real `AnthropicSpecProvider` class (only its
      `fetchImpl` swapped, its own internal `safeParse` intact) against a
      real running server: `providerName` came back `"anthropic-fallback"`
      and the saved project's entities never contained the colliding
      field. Full suite green (234 tests total) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with a
      live `/api/health` check. (Two smaller, unrelated bugs the same
      review found in `codegen.ts`'s CSV export/import round-trip — a
      number formatted with `toLocaleString()` on export doesn't re-parse
      with plain `Number()` on import, and a locale-formatted date export
      doesn't round-trip either — are left for a dedicated CSV round-trip
      fix later.)

- [x] **Fixed the CSV export/import round-trip bug the previous round
      found, in all three places it was duplicated.** `recordsToCsv`
      formatted numbers with `toLocaleString()` (adding a thousands
      separator) and dates with `toLocaleDateString()` (locale date
      order) for CSV export — in the live preview
      (`apps/web/src/entityFormatting.ts`), the exported standalone app's
      own copy (`apps/api/src/codegen.ts`), and the "Backup All Data" ZIP
      (`apps/api/src/backup.ts`, whose own doc comment already says it
      "intentionally mirrors" the other two). None of the three
      round-trip: `buildImportRecords` re-parses a number with plain
      `Number()`, which chokes on the comma in `"1,234"`, and a
      locale-formatted date like `"1/2/2024"` is ambiguous and doesn't
      match the ISO format the app's own `<input type="date">` expects —
      so exporting one of your own records and re-importing it silently
      corrupted or dropped the row. Fixed all three by writing numbers
      and dates to CSV as their plain stored value instead — no locale
      formatting — which `buildImportRecords` already parses correctly.
      The on-screen table view is untouched: it calls the same
      `formatNumberValue`/`formatDateValue` helpers, but through a
      separate function that was never part of the CSV round trip, so
      locale-friendly reading in the UI itself is unaffected. New tests:
      a real `recordsToCsv` → `parseCsv` → `buildImportRecords` round
      trip for a number ≥ 1000 plus a date field
      (`entityFormatting.test.ts`), a matching test in `backup.test.ts`,
      and the one existing test that had been asserting the old, buggy
      `"1,234"` output was fixed to match the corrected behavior.
      Verified live too: built a real Invoice project through the actual
      UI (an idea worded to reliably hit the heuristic's `Invoice` entity,
      which has both an `amount` and a `dueDate` field), created a record
      with `amount=12345` and a due date, downloaded the real exported
      CSV and confirmed it contains the raw `12345` and `2024-01-15` (not
      `12,345` or a locale-reordered date), then re-uploaded that exact
      downloaded file through the real "Import CSV" button and confirmed
      no `"isn't a number"` error and a second row with the same amount.
      Full suite green (236 tests total) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with a
      live `/api/health` check.

- [x] **Prune expired sessions instead of letting the table grow
      forever.** The last remaining open finding from the earlier auth
      self-review: `getSessionUser` filters expired sessions out of its
      own query, but nothing ever deleted them — every login/signup
      inserts a new 30-day session row and none are ever pruned, so a
      long-running deployment's `sessions` table only ever grows. Added
      `deleteExpiredSessions(db)` in `packages/db/src/users.ts`, called
      opportunistically from `createSession` — the one write path every
      login and signup already goes through — instead of adding a
      separate scheduled job for what's a small, low-stakes cleanup.
      Also wrote the first-ever direct unit tests for this module
      (`packages/db/src/users.test.ts` didn't exist before; it had only
      been exercised indirectly through `app.test.ts`'s HTTP-level auth
      tests) covering the cleanup in isolation and through the real
      `createSession` write path, plus a sanity check that
      `getSessionUser` still resolves a real, unexpired session
      correctly. Verified live too: pre-seeded a real file-based sqlite
      database with an already-expired session row, booted the actual
      built server against that same file, made one real signup HTTP
      request, and confirmed the pre-existing expired row was gone
      afterward — a real login pruning a real stale row it had no other
      reason to touch. Full suite green (240 tests total) + both builds
      clean + a from-scratch clean-room clone/install/test/build/start
      cycle with a live `/api/health` check.

- [x] **Business Twin: harden the "most-linked record" insight against a
      stale relation id, and use a point lookup instead of a full scan.**
      Self-reviewed `apps/api/twin.ts` and got a finding worth checking
      carefully rather than taking at face value: the claim was that
      `computeRelationHubObservation` picks only the single
      highest-linked id and, if that id no longer resolves to a real
      row (e.g. after the linked record is deleted), the whole insight
      silently disappears instead of falling back to the next real
      candidate. Writing the regression test for it turned up something
      the finding got wrong: calling `deleteRecord` on a Customer still
      referenced by Order/Ticket rows doesn't leave a dangling id at
      all — it throws a real `FOREIGN KEY constraint failed` error.
      Reading `packages/db/src/migrate.ts` and `connection.ts` confirmed
      why: every relation column gets a genuine SQL `REFERENCES`
      constraint, `openDatabase` turns `PRAGMA foreign_keys` on, and
      `diffAndMigrate` never drops a table — so this codebase's own code
      paths cannot currently produce the exact state the finding
      described. Shipped the fix anyway, reframed honestly: it's cheap
      defensive insurance against a future code path (or a bug in a
      different layer) ever handing this function a stale id, plus a
      genuine, unrelated efficiency win — the old code called
      `listRecords(...).find(id)` (a full table scan) to resolve the top
      candidate; the new code ranks all candidates above the "more than
      one link" threshold and walks them with the existing indexed
      `getRecord(db, projectId, entity, id)` point lookup, stopping at
      the first one that still resolves to a real row. The regression
      test in `apps/api/twin.test.ts` simulates the dangling-id state
      directly (`PRAGMA foreign_keys = OFF`, a raw delete, `PRAGMA
      foreign_keys = ON`) since the app's real `deleteRecord` path
      cannot reach it — the test says so in its own comment, so nobody
      mistakes it for a reproduction of a live bug. Full suite green
      (246 tests total) + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Fix a real bug: retrying a failed initial build duplicates every
      table's sample data.** Self-reviewed `apps/api/pipeline.ts` (never
      reviewed before) and this time the finding held up under an actual
      regression test, unlike the previous round's twin.ts finding.
      `POST /projects/:id/build` always calls `runBuildPipeline` with
      `previousSpec` undefined — there's no previous spec for an initial
      build — and `diffAndMigrate` reports *every* entity as `new_table`
      whenever `previousSpec` is undefined (by design, so a first build's
      migration report is complete). The Seed Data step used that
      `new_table` list alone to decide what to seed. If a build gets
      partway through (schema created, sample rows inserted) and then a
      later step fails — QA is the one step that can genuinely fail and
      halt the pipeline — the UI's "back" button returns to the spec
      screen, and clicking "Build" again re-POSTs the identical request:
      same undefined `previousSpec`, so every entity is reported as
      `new_table` again, and the old code re-seeded a full duplicate
      round of sample rows into tables that already had them, with no
      de-dup. Verified this was real, not theoretical, before touching
      anything: wrote a regression test that runs the real pipeline
      twin the exact way the route calls it (twice, `previousSpec`
      always undefined) and confirmed it failed against the old code —
      it asserted the second run's Seed Data step should report seeding
      nothing, and instead saw the same table re-seeded. Fixed by also
      requiring the table to be genuinely empty right now
      (`countRecords(db, project.id, entity) === 0`) before seeding it,
      not just "new" per the diff — cheap, uses the existing indexed
      count query, and doesn't need previousSpec threaded through at
      all. Verified live end-to-end too: signed up, created a real
      project via the heuristic provider, called the real build endpoint
      twice over actual HTTP against a clean-room-built server — the
      first call's real SSE stream reported "Seeded 2 sample record(s)"
      for the new table, the second (retry) call reported "No new tables
      to seed" with `seededCount: 0`, exactly the fix working end to
      end. Full suite green (242 tests total across all 4 workspaces) +
      both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Announce the "waking up the server" banner to screen readers.**
      A small, focused accessibility fix, diversifying away from the
      last few self-review rounds. The banner in `App.tsx` that tells a
      user the free-tier backend is cold-starting (up to ~60 seconds,
      per its own copy) was a plain `<p>` with no `aria-live` or
      `role="status"` anywhere — confirmed there isn't a single one in
      the whole web app. A sighted user sees it appear/disappear; a
      screen reader user got total silence for up to a minute, with no
      way to tell a slow cold start from a hang, and since the banner is
      often the only content on screen at that point (the
      session-checking and login screens), it could go completely
      undiscovered if not proactively announced. Fixed with one
      attribute: `role="status"` on the banner's `<p>`, which implies
      `aria-live="polite"` — assistive tech announces the text as soon
      as it mounts, no extra wiring needed since toggling `waking`
      already mounts/unmounts the element. Verified live with a real
      Playwright run against real dev servers: signed up for a real
      token, then intercepted the very first `/api/auth/me` request to
      abort it (genuinely reproducing the connection failure that
      triggers `fetchWithWakeRetry`'s cold-start retry), confirmed a
      `[role="status"]` element appeared with the exact translated
      banner text, and confirmed it was removed from the DOM again once
      the retry succeeded. Full suite green (242 tests) + both builds
      clean + a from-scratch clean-room clone/install/test/build/start
      cycle with a live `/api/health` check.

- [x] **Resolved the open `rowToProject` hard-parse architectural
      question: isolate one bad stored project instead of crashing the
      whole list.** `rowToProject` (`packages/db/src/projects.ts`)
      re-validates every stored project's `spec_json` against the
      *current* `ProductSpecSchema` on every read — there's no migration
      step for old rows the way `diffAndMigrate` handles the SQL schema.
      `listProjectsForOwner` mapped every row through it directly, so a
      single project whose stored spec doesn't parse against today's
      schema (the schema can only get stricter over time — a field
      going from optional to required, a new `.min()`, etc.) would throw
      and take down the *entire* list for that owner, not just that one
      project. Proved this with a real regression test before touching
      anything: inserted one valid project plus one row with an
      intentionally incompatible `spec_json` (via raw SQL, standing in
      for a spec written under an older, looser version of the schema),
      and confirmed `listProjectsForOwner` threw for the whole call.
      Fixed with a `tryRowToProject` wrapper that catches a parse
      failure per row, logs it loudly (with the project id) so it's
      discoverable and fixable, and excludes just that project from the
      list — the stored row itself is never touched, so nothing here is
      destructive, consistent with the "never destroy work" principle
      migrations already follow. `getProject` (the single-project fetch
      every other route needs a *valid* project from) deliberately keeps
      throwing — there's no reasonable project to substitute there, so
      a clear failure is correct. Also documented the actual rule this
      enforces directly on `ProductSpecSchema` in `packages/shared`:
      new fields must be optional or carry a default, and no field may
      later become required or gain a stricter validator, because
      there's no migration path for already-stored specs. Verified live
      end-to-end against a real running server, not just unit tests:
      signed up, created a real project via HTTP, confirmed
      `GET /api/projects` listed it, then inserted a second, genuinely
      corrupted row directly into that same running server's actual
      SQLite file, and confirmed the same `GET /api/projects` call still
      returned `200` with the one valid project intact. First-ever
      direct unit tests for `projects.ts`
      (`packages/db/src/projects.test.ts` didn't exist before — this
      module had only been exercised indirectly through
      `apps/api/app.test.ts`'s HTTP-level tests). Full suite green (244
      tests total across all 4 workspaces) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with
      a live `/api/health` check.

- [x] **Deduplicated `pickDisplayField`/`recordDisplayLabel`, tracked as
      an open cleanup item since the `twin.ts` self-review.** Three
      files in `apps/api/src` — `twin.ts`, `whatsapp.ts`, `backup.ts` —
      each carried a byte-identical copy of the same small helper (pick
      a record's best display field, then render it as a short label,
      falling back to `#<id>`). Unlike the CSV-formatting duplication
      fixed earlier (which turned out to have three legitimately
      different consumers — live preview, the exported standalone app,
      and the backup ZIP — where a real bug had already crept into two
      of the three copies independently), these three were genuinely
      identical with zero divergence, inside the same server package, so
      there was no "per-surface" reason to keep them separate.
      `codegen.ts`'s own copy was deliberately left alone — it's a
      string template generating the *exported* app's own JS file, the
      same different-surface case as the CSV logic, not something this
      package can import from. Extracted a real shared module,
      `apps/api/src/displayField.ts`, and updated all three call sites
      to import from it instead of keeping their own copy — one file
      fewer to keep in sync the next time this logic needs a fix. Wrote
      the first-ever direct unit tests for the new module
      (`displayField.test.ts`) covering the name/title preference, the
      first-text-field fallback, the last-resort first-field fallback,
      and the `#<id>` fallback for a missing/empty value. A pure
      refactor — no behavior change, confirmed by the full pre-existing
      test suite (which already exercises this logic indirectly through
      `computeBusinessTwin`, `findMatchingRecord`, and the backup ZIP
      export) staying green throughout. Full suite green (248 tests
      total across all 4 workspaces) + both builds clean (the API bundle
      shrank slightly, from 223.7kb to 222.6kb, consistent with the
      removed duplicate code) + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Self-review of `whatsappWeb.ts` (never reviewed before): fixed a
      real socket leak on a connect/disconnect race, and rejected a
      garbage phone number before it ever reaches Baileys.** Two real
      findings, both confirmed by regression tests against the actual
      manager (using the same injectable-`createSocket` test double the
      rest of this module's tests already use) before being fixed:
      (1) `connect()` awaits `createSocket()` and only afterward assigns
      `session.sock` and wires up the socket's event handlers — if a
      concurrent `disconnect()` (or a fresh `connect()`) replaces or
      deletes that session from the manager's map while `createSocket()`
      is still in flight, the newly created real socket had nothing left
      in the app that could ever close it: it would stay linked to the
      real WhatsApp account indefinitely, silently consuming a
      linked-device slot, since every event it fires gets correctly
      ignored by the existing stale-session identity check but nothing
      ever calls `logout()` on it. Fixed by re-checking that identity
      immediately after `createSocket()` resolves and logging the socket
      out right there if the session is no longer the live one, before
      ever wiring up its handlers. (2) `sendMessage()` built the WhatsApp
      JID from `normalizePhone(to)` without checking the result was
      non-empty — the route's own zod schema only enforces a non-empty
      string, not that it contains any digits, so a value like `"abc"`
      would silently become `"@s.whatsapp.net"`, an obviously-invalid
      JID, and reach the real socket instead of being rejected with a
      clear reason. Fixed with an explicit empty-phone check returning
      `invalid_phone_number`. Confirmed both were real by watching each
      new test fail against the pre-fix code first. Verified live
      end-to-end too, beyond the unit tests: a standalone script booted a
      real HTTP server via `createApp`/`createStore`, drove a real
      signup and project creation, then made real HTTP calls to
      `/connect` and `/disconnect` with an injected socket factory whose
      resolution was held open to force the exact race window, confirming
      the orphaned socket's `logout()` was actually called and the final
      status stayed `disconnected`; a second real HTTP call to `/send`
      with `{"to": "abc"}` confirmed a `502` with `invalid_phone_number`
      and that the real socket's `sendMessage` was never invoked. Full
      suite green (250 tests total across all 4 workspaces) + both
      builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Fixed the last open `pipeline.ts` self-review finding: a Debug
      Agent recovery could silently under-report which schema changes
      actually happened.** `diffAndMigrate` (`packages/db/src/migrate.ts`)
      conflated two separate questions in one check: whether a column
      physically needs `ALTER TABLE` (it doesn't, if a prior call already
      added it) and whether that column counts as a *change* relative to
      `previousSpec` (it does, regardless of whether it physically exists
      yet). This matters because `pipeline.ts` calls `diffAndMigrate`
      twice with the *same* `previousSpec` whenever the Debug Agent
      recovers from a migration failure: a first call can genuinely add
      a real column to one entity, then throw on a later entity (e.g. an
      unsafe field name), and the retry — after the Debug Agent fixes the
      spec — used to see that first column already present in the DB and
      silently drop it from the returned change list, even though it's a
      real difference from `previousSpec` the "N schema change(s)
      applied" build-log message and detail list should have reported.
      Confirmed with a regression test that failed against the old code
      first (asserting a retry's changes equal the first run's; the old
      code returned `[]`). Fixed by only using the "does it already exist
      physically" check to skip the `ALTER TABLE` call itself, while
      always reporting the column as a change whenever it's new relative
      to `previousSpec` — no longer conflating "already applied" with
      "not a change." Verified live through the actual, unmodified build
      pipeline, not just the isolated function: a scratch script ran a
      real two-entity refine through `runBuildPipeline` with a real fake
      Anthropic Debug Agent (same pattern `pipeline.test.ts` already
      uses) where the first entity's column genuinely gets added before
      an unsafe field name on the second entity throws, and confirmed the
      final Database step's reported changes correctly include *both*
      the column applied before the throw and the one applied on the
      retry after the fix. This resolves one of the two remaining
      findings from the `pipeline.ts` self-review a few rounds back — the
      "N schema change(s) applied" message and its detail list are now
      accurate in every case that pipeline actually exercises. The other
      finding (the Architect step's impact summary is computed before
      the Debug Agent might rewrite the spec, so its already-streamed
      message can describe entities/fields that don't match what actually
      got built) is still open, left for a future round. Full suite green (251
      tests total across all 4 workspaces) + both builds clean + a
      from-scratch clean-room clone/install/test/build/start cycle with
      a live `/api/health` check.

- [x] **Fixed the last remaining `pipeline.ts` self-review finding: the
      Architect step's impact summary could describe entities/fields
      that were never actually built.** The Architect event streams to
      the client (with its full `detail: impact` — new entities, and
      per-entity new field names) before the Database step even runs.
      When the Database step then fails and the Debug Agent recovers
      by asking Claude for a corrected spec, `requestSpecFix` is
      explicitly allowed to rename or restructure whatever caused the
      error — so the already-streamed Architect detail could end up
      describing a field name (or entity) that was never actually
      created, with nothing correcting it afterward. Confirmed with a
      regression test that failed against the old code first: a real
      refine adding an unsafely-named field to an existing entity,
      recovered by a real fake Debug Agent that renames the field,
      asserted there should be *two* successful Architect events (the
      original and a corrected one) with the second one's
      `changedEntities` reflecting the actually-built field name — the
      old code only ever emitted one, still showing the broken name.
      Fixed by factoring the Architect event's construction into a small
      `architectEvent()` helper and calling it again with the corrected
      `nextSpec` right after the Debug Agent's fix succeeds; the web
      UI's `BuildProgress` component already keeps only the latest event
      per agent (a `Map`), so the corrected event replaces the stale one
      automatically — no UI changes needed. This closes out every
      finding raised by the original `pipeline.ts` self-review. Full
      suite green (252 tests total across all 4 workspaces) + both
      builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Self-review of `heuristic.ts` (the offline spec generator, never
      reviewed before): found and honestly resolved a case of misleading
      dead code, not a functional bug.** The code-review found that
      `buildScreens`'s `hasElevatedRole` parameter — meant to gate the
      Dashboard screen on whether the description implied an Admin/Manager
      role — always evaluates `true`: `matchRoles` unconditionally adds an
      Admin role to every generated spec regardless of what the
      description says, so the "elevated role" check can never come out
      false. Confirmed empirically (both via a direct script and a real
      HTTP request against a running server) that even a trivial,
      purely-personal description ("I want to organize my hobby
      collection") comes back with `roles: ["Admin", "Member"]` and a
      Dashboard screen. Investigated whether this is actually wrong
      before touching anything: every Forge AI project has exactly one
      owner account (see the "single demo workspace" assumption every
      generated spec already states), and that owner is always an admin
      of their own app — so always including Admin, and therefore always
      showing a Dashboard, is genuinely correct behavior, not an
      oversight. The existing test suite already asserted
      `roles.includes("Admin")` unconditionally, confirming this has been
      the accepted, shipped behavior all along. So this wasn't a bug to
      fix — it was dead conditional logic pretending to make a decision
      it can never actually make, which could mislead a future reader
      into thinking Dashboard is genuinely optional. Simplified: removed
      the `hasElevatedRole` parameter and computation entirely, made
      `buildScreens` add the Dashboard screen directly (matching the
      real, always-true behavior), and documented the actual reasoning
      (single-owner model) directly on `matchRoles` and `buildScreens` so
      it isn't mistaken for an oversight again. Added the first direct
      test asserting this behavior explicitly for a no-role-language
      description, since nothing previously pinned it down beyond an
      incidental assertion in an unrelated test. A pure refactor — no
      behavior change, confirmed by the full existing test suite staying
      green and by a real HTTP request against a from-scratch
      clean-room-built server returning the identical roles/screens
      before and after. Full suite green (253 tests total across all 4
      workspaces) + both builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Fixed the last remaining `whatsappWeb.ts` self-review finding: a
      concurrent connect() could race a disconnect()'s auth-dir cleanup.**
      `disconnect()` (and `handleConnectionUpdate`'s logged-out "close"
      branch) deletes the session from the in-memory map synchronously —
      which is what makes `getStatus()` correctly report "disconnected"
      right away — but only removes the auth dir from disk asynchronously
      afterward. That left a real window where a `connect()` arriving in
      that gap saw no session, and started `useMultiFileAuthState()` on
      the very directory still being deleted underneath it: real risk of
      an unnecessary QR re-scan (freshly-written credential files
      force-deleted out from under the new connection) or an unexpected
      filesystem error neither code path accounted for. Confirmed with a
      regression test that failed against the old code first: an injected,
      holdable `removeAuthDir` proved `connect()` called `createSocket`
      again before the pending cleanup had actually finished. Fixed by
      tracking each project's in-flight cleanup in a `pendingCleanup` map
      (a new `cleanupAuthDir()` helper shared by both call sites) and
      having `connect()` await it before proceeding — `getStatus()`'s
      immediacy is untouched since the session map deletion still happens
      synchronously; only the *next* `connect()` for that same project
      now waits for the disk cleanup already in flight. This resolves the
      last of the three real findings raised across the whole
      `whatsappWeb.ts` self-review a few rounds back (the socket-leak and
      invalid-phone-number fixes landed earlier); all are now closed.
      Full suite green (254 tests total across all 4 workspaces) + both
      builds clean + a from-scratch clean-room
      clone/install/test/build/start cycle with a live `/api/health`
      check.

- [x] **Announce EntityPanel's form-error and CSV-import status messages
      to screen readers.** Diversifying away from the last several
      backend self-review rounds, used a research agent to find a real
      frontend accessibility gap instead. Found: `EntityPanel.tsx`'s
      save/delete/duplicate/bulk-delete error message (`{error && <p
      className="error">...}`) and its CSV-import result message
      (`{importMessage && <span>...}`) were both plain, non-live DOM
      nodes — the same class of gap as the "waking up the server" banner
      fixed a few rounds ago, just in a different component that fix
      didn't touch. A sighted user sees the message appear right next to
      the button they just used; a screen-reader user whose focus has
      moved on (the natural resting place after a submit or an import)
      gets no announcement that a save failed, a required field was
      rejected, or how many CSV rows imported — confirmed via grep that
      these were the only two remaining `role="status"`-less transient
      status messages in the whole web app. Fixed with `role="status"`
      on both elements, mirroring the exact pattern already established
      on the waking banner. Verified live with a real Playwright run
      against real dev servers: signed up, built a real project through
      the actual UI, uploaded a genuinely malformed CSV through the real
      file input, and confirmed a `[role="status"]` element appeared
      with the real server-reported message ("Import failed: 1 errors.
      No records were created."). Full suite green (254 tests — this was
      a UI-only change with no existing component-test infrastructure to
      extend, consistent with the same real-Playwright verification
      approach used for the earlier waking-banner fix) + both builds
      clean + a from-scratch clean-room clone/install/test/build/start
      cycle with a live `/api/health` check.

- Self-review (code-review skill, high effort) of
  `packages/spec-engine/src/domainEntities.ts` (1023 lines, never directly
  reviewed before, exports the offline heuristic provider's keyword-matched
  entity library). Found 4 real substring-collision bugs in the
  `lower.includes(kw)` matching used by `matchEntities`/`matchRoles` in
  `heuristic.ts` — exactly the pitfall class the file's own header comment
  already documents and had partially guarded against (e.g. תור/תורם), but
  missed here: (1) Customer's bare `"lead"` is a substring of
  "leaders"/"leadership", so a description about team leadership spuriously
  got a Customer entity; (2) Deal's bare `"deal"` is a substring of "ideal",
  so any description saying "ideal customer(s)" spuriously got a Deal
  entity; (3) that same `"deal"` keyword is also a substring of Vehicle's
  own "car dealership" keyword, so a car-dealership CRM description
  spuriously got an unrelated Deal entity too; (4) MenuItem's bare Hebrew
  `"מנה"` (mem-nun-heh, "dish/portion") is the exact 3-letter prefix of
  "מנהל"/"מנהלת"/"מנהלים" (manager/manageress/managers — one of the most
  common words in Hebrew business descriptions, and this same file's own
  ROLE_RULES keyword for Admin), so almost any Hebrew description
  mentioning a manager role spuriously got a restaurant MenuItem entity.
  Each empirically confirmed with a regression test proven to fail against
  the pre-fix code first (via `git stash` on just the source file, keeping
  the new tests): "leaders and their schedules" incorrectly matched
  Customer, "ideal customers" and "car dealership...vehicles" incorrectly
  matched Deal, and "מעקב אחרי מנהלים" incorrectly matched MenuItem — all
  four confirmed failing, then confirmed passing after the fix. Fixed
  following the file's own established convention (already used for
  תור/תורם and "review"/"preview"): remove the colliding bare keyword,
  keep or substitute a safe form that doesn't have the same substring
  problem, and document why in a comment. Concretely: Customer's `"lead"`
  → `"sales lead"`; Deal's `"deal"` → `"deals"` (plural doesn't appear as a
  substring of either "ideal" or "dealership" — fixes both collisions with
  one change); MenuItem's bare `"מנה"` removed, keeping the already-present
  plural `"מנות"` (mem-nun-vav-tav — Hebrew plural formation drops the ה
  and adds ות, so it never contains the מנהל root). Added 3 new regression
  tests to `heuristic.test.ts`, each also checking the real business term
  still matches correctly after the fix (e.g. "sales deals through our
  pipeline" still matches Deal). Full suite green (257 tests, up from 254 —
  spec-engine went 51→54) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Self-review (code-review skill, high effort) of
  `packages/spec-engine/src/anthropic.ts` (114 lines, zero existing direct
  tests — this is `AnthropicSpecProvider`, the real production LLM-backed
  spec generator used whenever `ANTHROPIC_API_KEY` is configured; falls
  back to the heuristic provider on any failure, per `index.ts`). Fixed the
  two findings that were concretely reachable and independently testable
  without depending on real model behavior, each confirmed with a
  regression test proven to fail against the pre-fix code first:
  (1) `extractJson`'s fence-stripping regex was anchored to the whole
  trimmed string (`^```...```$`), so it only unwrapped a fenced block when
  the model's entire response was exactly that block — any incidental
  prose the model added around it (e.g. "Here's the spec:\n```json\n...")
  despite the system prompt's explicit "no prose" instruction made
  fence-stripping silently no-op, handing raw prose+fences to `JSON.parse`
  and causing a spurious fallback to the heuristic provider. Fixed by
  un-anchoring the regex to find a fenced block anywhere in the text, with
  a further fallback to the substring between the first `{` and the last
  `}` when there's no fenced block at all. (2) `await response.json()` was
  the only failure path in `generate()` not wrapped in a try/catch, so a
  malformed/truncated-but-200 response body threw a raw, unwrapped
  `SyntaxError` instead of the descriptive `Error()` every other failure
  path in this function produces — this matters because `index.ts`'s
  `generateSpec` logs the caught error server-side before falling back to
  the heuristic provider, so the message quality directly affects
  production diagnosability. Fixed by wrapping it in try/catch with a
  message consistent with the function's other error messages. Added
  `anthropic.test.ts` (new file, first direct tests for this provider) —
  7 tests covering the happy path, both fence-stripping cases (clean fence,
  fence-with-prose), and all four existing error paths (malformed body,
  HTTP failure, empty text, schema mismatch). Full suite green (264 tests,
  up from 257 — spec-engine went 54→61) + both builds clean + a
  from-scratch clean-room clone/install/test/build/start cycle with a live
  `/api/health` check.

  This review is not fully closed: it also surfaced three findings that
  are real but weren't fixed this round because they need either a product
  decision or real-model verification this sandbox can't do (no network
  access to api.anthropic.com) rather than a scoped code fix — noting them
  honestly for a future round instead of overstating this as "done":
  `max_tokens` is hardcoded to 4096 with no `stop_reason` check, so a
  thorough multi-entity spec (which the system prompt explicitly asks for)
  could get silently truncated mid-JSON with no diagnostic signal that
  truncation (vs. a genuinely malformed response) was the cause; a safety
  refusal (`stop_reason: "refusal"`) is indistinguishable from any other
  empty-text response, losing the API's actual refusal category/
  explanation; and `ProductSpecSchema.roles` requires `min(1)` but the
  system prompt never says roles must be non-empty, so a single-user-app
  description could plausibly get a valid-but-empty `roles: []` from the
  model and fail schema validation — this one in particular needs
  observing real model behavior to confirm before deciding whether a
  system-prompt tweak or a schema/parsing change is the right fix.
  `debug.ts`'s `requestSpecFix` (the Debug Agent's repair path) duplicates
  this same fetch/parse/validate sequence near-verbatim, including the
  same `max_tokens`/`extractJson` characteristics, so any future fix to
  the open items above should also be applied there to avoid the two
  copies drifting out of sync.

- Closed the safest of the three `anthropic.ts` findings left open above:
  `SYSTEM_PROMPT` never told the model that `roles` must be non-empty, even
  though `ProductSpecSchema.roles` requires `min(1)` — a schema/prompt
  mismatch that could make a perfectly reasonable single-user-app response
  (`roles: []`) fail validation and get silently downgraded to the
  heuristic fallback. Added an explicit rule to the system prompt: every
  app has at least one role (whoever owns/runs it), so even a single-user
  app must still return one role (e.g. "Admin"/"Owner") rather than an
  empty array — this also aligns the LLM provider's behavior with
  `heuristic.ts`'s own established design (`matchRoles` always adds an
  Admin role, confirmed by an earlier round's regression test). Honest
  caveat, unchanged from the finding as originally reported: this sandbox
  has no network access to `api.anthropic.com`, so there's no way to
  observe whether a real model call would actually have hit this — the fix
  is a documentation/prompt-alignment change verified via a text
  assertion on `SYSTEM_PROMPT`, not a runtime behavior test (unlike the
  two fetch/parse bugs closed in the prior round, which were fully
  reproducible with a fake `fetchImpl`). The regression test was still
  written and proven to fail against the pre-fix prompt text first, same
  discipline as every other fix this session. The other two open findings
  (`max_tokens`/`stop_reason` truncation handling, refusal detection) and
  the `debug.ts` duplication remain open — noted as candidates for a
  future round. Full suite green (265 tests, up from 264 — spec-engine
  went 61→62) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Closed the remaining two of the three `anthropic.ts` findings, both of
  which turned out to be fully testable with a fake `fetchImpl` after all
  (the earlier round's caveat that they needed real-model observation
  applied to confirming the model *actually returns* these `stop_reason`
  values, not to whether the code can correctly react to them once it
  does — that part only needed controlling the response payload, which a
  fake `fetchImpl` does directly). `generate()` never looked at the
  response's `stop_reason` field: (1) a response truncated mid-JSON by
  hitting `max_tokens` and a response containing genuinely malformed JSON
  both failed at the same `JSON.parse` call with the same generic "was
  not valid JSON" message, even though they're different, differently-
  actionable failures (raise `max_tokens` vs. a real parsing bug);
  (2) a safety refusal (`stop_reason: "refusal"`, empty `content`) was
  indistinguishable from any other empty-content response, surfacing the
  unhelpful generic "contained no text content" instead of naming the
  refusal. Fixed by checking `payload.stop_reason` in both places: a
  `refusal` is now caught immediately with its own error before the text
  extraction even runs, and a `JSON.parse` failure with
  `stop_reason === "max_tokens"` gets a message naming truncation
  specifically instead of the generic parse-error text (a genuinely
  malformed response with any other `stop_reason` still gets the original
  generic message, confirmed by a dedicated test). Added 4 new tests to
  `anthropic.test.ts` (truncation-specific message, refusal-specific
  message, and a check that the plain-malformed-JSON path is unchanged),
  each proven to fail against the pre-fix code first via the same
  git-stash technique used all session. This closes the `anthropic.ts`
  self-review from two rounds ago in full — the only item left from it is
  `debug.ts`'s near-identical duplication of this same fetch/parse logic,
  which still doesn't have any of these three fixes and is a candidate for
  its own future round. Full suite green (268 tests, up from 265 —
  spec-engine went 62→65) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Ported the exact same three fixes from `anthropic.ts`'s self-review to
  `packages/spec-engine/src/debug.ts` (`requestSpecFix`, the Debug Agent's
  repair path), which the earlier round had already flagged as a
  near-verbatim duplicate of `anthropic.ts`'s fetch/parse logic and
  confirmed carried the same bugs unpatched. Read the file directly rather
  than re-running the code-review skill, since the bugs to check for were
  already known exactly: `extractJson`'s fence regex was anchored to the
  whole string (same "prose around a fenced block" failure), `await
  response.json()` wasn't wrapped in try/catch (same raw-SyntaxError-
  instead-of-descriptive-error failure), and `stop_reason` was never
  inspected (same generic message for both truncation and a genuinely
  malformed response, and no refusal-specific handling). Applied the
  identical fixes as `anthropic.ts`. Added 4 new tests to `debug.test.ts`
  (fence-with-prose, malformed response body, `max_tokens`-truncation
  naming, refusal naming), each proven to fail against the pre-fix code
  first — all 4 failed exactly as expected before the fix. `debug.ts`'s
  `roles.min(1)` equivalent (the `anthropic.ts` prompt-wording fix) was
  deliberately not ported: `requestSpecFix`'s prompt already asks for "the
  exact same shape as spec" starting from a spec that already has valid
  roles, a materially different situation from generating a fresh spec
  from a bare description, so that particular finding doesn't transfer.
  Full suite green (272 tests, up from 268 — spec-engine went 65→69) +
  both builds clean + a from-scratch clean-room clone/install/test/build/
  start cycle with a live `/api/health` check.

- Checked `promptEnhancer.ts`'s `AnthropicPromptEnhancer` (the third and
  last file in the codebase that calls the Anthropic Messages API
  directly) for the same bug class fixed in `anthropic.ts` and `debug.ts`.
  Two of the three applied here and two didn't, for a reason worth
  recording rather than blindly copy-pasting all three: `extractJson`'s
  anchored-fence-regex bug doesn't exist here at all, because this
  enhancer returns a plain rewritten paragraph, not JSON — there's no
  `JSON.parse`/`extractJson` step to have that bug in the first place. For
  the same reason, `stop_reason === "max_tokens"` can't cause a JSON parse
  failure here either (though a truncated-but-nonempty response would
  still be silently accepted as a shorter, cut-off paragraph rather than
  treated as a failure — a real but different, more debatable finding,
  left open rather than guessed at, since deciding whether a truncated
  enhancement should fail or degrade gracefully is a product call, not a
  bug fix). The other two *did* apply, identically to the other two files:
  `await response.json()` wasn't wrapped in try/catch (malformed body threw
  a raw SyntaxError instead of the established descriptive-error pattern),
  and a safety refusal (`stop_reason: "refusal"`, empty content) fell into
  the same generic "no text content" message as any other empty response.
  Fixed both the same way as `anthropic.ts`/`debug.ts`. Added 2 new tests
  to `promptEnhancer.test.ts`, both proven to fail against the pre-fix code
  first. This closes out the Anthropic-API-direct-call review across the
  whole codebase — all three call sites (`anthropic.ts`, `debug.ts`,
  `promptEnhancer.ts`) now handle malformed responses and refusals
  consistently, each fixed to the extent its own shape of work (JSON spec
  vs. plain text) actually needs. Full suite green (274 tests, up from
  272 — spec-engine went 69→71) + both builds clean + a from-scratch
  clean-room clone/install/test/build/start cycle with a live
  `/api/health` check.

- Self-review of `packages/db/src/checkpoints.ts` (58 lines, zero direct
  tests before this round — the Time Machine's storage layer: every
  successful build or refine snapshots the resulting spec here). Found and
  fixed 2 real bugs, both confirmed with a regression test proven to fail
  against the pre-fix code first: (1) `listCheckpoints` had the identical
  "one corrupt row takes down the whole list" vulnerability already fixed
  in `projects.ts`'s `listProjectsForOwner` earlier this session — since
  `ProductSpecSchema` can only get stricter over time, a checkpoint written
  by an older version of the app and no longer parseable against today's
  schema is a real, expected future case, and `rowToCheckpoint` threw
  uncaught for every row in the loop, so one bad checkpoint made the entire
  Time Machine history for that project vanish behind a 500 instead of
  just hiding the one unparseable entry. Fixed with the identical pattern
  already established for projects: a `tryRowToCheckpoint` wrapper that
  catches, logs, and excludes just that row; `getCheckpoint` (fetching one
  specific checkpoint, e.g. for a restore) is left throwing intentionally,
  same reasoning as `getProject`. (2) A second, independently-discovered
  bug while writing the ordering test for the fix above: `createdAt` is a
  `new Date().toISOString()` string with only millisecond resolution, and
  `listCheckpoints` ordered purely by `ORDER BY createdAt DESC` with no
  tiebreaker — two checkpoints inserted within the same millisecond (e.g.
  a build's checkpoint immediately followed by a refine's) got a
  genuinely undefined relative order, confirmed to reproduce on every one
  of 5 repeated test runs, not a one-off flake. Fixed by adding `, rowid
  DESC` as a tiebreaker: SQLite's implicit rowid strictly increases with
  insertion order on this table (not declared `WITHOUT ROWID`), so ties
  now deterministically resolve to most-recently-inserted-first, matching
  what "newest first" actually means for a tie. Added `checkpoints.test.ts`
  (new file, 6 tests: insert, list ordering, get-missing, the two bug
  fixes). Full suite green (279 tests, up from 274 — db package went
  44→49) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Followed up on the checkpoint-ordering fix by grepping the rest of
  `packages/db/src` for the same two bug shapes (`spec_json` parsed
  without a per-row try/catch in a list function; `ORDER BY ...createdAt`
  with no tiebreaker). `spec_json` only appears in `projects.ts` and
  `checkpoints.ts` — both already resilient — but `projects.ts`'s own
  `listProjectsForOwner` turned out to have the identical missing-
  tiebreaker ordering bug just fixed in `checkpoints.ts`, in the very file
  that pattern originated from. (`whatsapp.ts`'s message list already has
  a `rowid DESC` tiebreaker from an earlier round, so it was already
  clean.) Added a regression test inserting two projects synchronously
  (no `await` between them, so they land in the same `createdAt`
  millisecond) — reproduced in 2 of 3 runs before the fix (less
  deterministic than the checkpoints case, but still clearly the same
  real bug, not a coincidence) and 0 of 5 runs after. Fixed identically:
  `ORDER BY createdAt DESC, rowid DESC`. Full suite green (280 tests, up
  from 279 — db package went 49→50) + both builds clean + a from-scratch
  clean-room clone/install/test/build/start cycle with a live
  `/api/health` check.

- Followed up with a broader `ORDER BY` grep across the whole codebase
  (`apps/` and `packages/`, not just `createdAt`) to check whether the
  same missing-tiebreaker bug shape existed anywhere else. It didn't:
  `repository.ts` and `codegen.ts`'s own entity-record tables both use
  `id INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite's rowid alias, guaranteed
  unique and monotonically increasing per insert), so their `ORDER BY id
  DESC` was never actually at risk of a tie in the first place — closing
  this bug class out with a negative result, not just the two positive
  fixes already made. Then self-reviewed `apps/api/src/zip.ts` (103 lines,
  the dependency-free ZIP writer used for code export and "Backup All
  Data") at high effort. Found a real ZIP-spec-compliance bug: the
  general-purpose bit flag was always written as `0`, never setting bit
  11 (`0x0800`, the language-encoding flag) that tells a reader the
  filename bytes are UTF-8 rather than the legacy CP437 code page. This
  project explicitly supports non-ASCII (Hebrew) entity/field labels, so
  a general-purpose zip writer should set this correctly rather than
  relying on a reader's own UTF-8-guessing heuristics. Confirmed with a
  genuinely independent check: the existing test in this file already
  verifies against the system `unzip`, but modern `unzip` auto-detects
  valid UTF-8 regardless of this flag, so it wouldn't have caught a
  regression here — the new test instead shells out to Python's `zipfile`
  module, which is spec-strict and only decodes as UTF-8 when the flag is
  actually set. Built a zip with a Hebrew filename (`לקוחות.csv`) and
  confirmed it came back as visible mojibake before the fix
  (`╫£╫º╫ò╫ù╫ò╫¬.csv`) and the correct Hebrew string after. Fixed by
  setting flags to `0x0800` in both the local and central directory
  headers. Honest note: this isn't reachable through the app's current
  callers today — `generateBackupZipEntries`/`generateExportFiles` only
  ever build paths from `entity.name`, which the system prompt and this
  session's earlier fixes already enforce as plain ASCII — so this is
  correctness insurance in a general-purpose module, not a fix for an
  observed production failure, stated plainly rather than overclaimed.
  The code-review also surfaced two lower-priority, unfixed findings
  worth recording for a future round: no Zip64 support (entry
  count/size/offset fields hard-cap at 16-bit/32-bit limits with a raw
  `RangeError` instead of a controlled failure once a backup exceeds
  65,535 files or 4GB — plausible only for a very large, long-lived
  project, not a near-term risk) and an inconsistent "version made by"
  host byte vs. the embedded Unix permission bits in the central
  directory (cosmetic on every extractor tested so far, but not strictly
  spec-clean). Full suite green (281 tests, up from 280 — api package
  went 89→90) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Closed the safer of the two findings left open from that `zip.ts`
  review: `buildZip` had no guard for exceeding the 65,535-entry limit of
  its non-Zip64 format, so building an archive with more entries than
  that failed deep inside `Buffer#writeUInt16LE` with that method's own
  generic "value... must be <= 65535" `RangeError`, giving a caller (the
  backup/export routes) no indication this was specifically an
  entry-count problem. Added an upfront check that throws a descriptive
  error naming the actual cause ("N entries exceeds the 65535-entry limit
  of this writer (no Zip64 support)") before any work begins — this is
  the defensive-error-message fix noted as a candidate last round, not
  full Zip64 support, which stays a real but much larger, not-near-term
  piece of work. Added a regression test building a 65,536-entry archive;
  proven to fail against the pre-fix code first (it did throw, but with
  the raw generic message rather than one containing "Zip64" — the test
  deliberately matches on that word rather than on "65535", since the
  Buffer's own accidental message also happens to contain that number and
  would have made the test pass even without the fix). The size/offset
  32-bit limits and the "version made by" host-byte inconsistency remain
  open, still far lower priority than the entry-count case since they'd
  need a single file over 4GB or a cumulative archive over 4GB to
  trigger. Full suite green (282 tests, up from 281 — api package went
  90→91) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Self-review of `packages/db/src/identifiers.ts` (20 lines, zero direct
  tests before this round — the allowlist gate every table/column name
  must pass before ending up in a raw SQL string). Found and fixed a real,
  quite plausibly reachable bug: `assertSafeIdentifier` only checks
  character composition (`^[A-Za-z][A-Za-z0-9_]*$`), never against
  SQLite's reserved-word list, and every raw SQL string in
  `migrate.ts`/`repository.ts` interpolated table/column names unquoted.
  Table names are always safe in practice (`tableNameFor` prefixes every
  one with `entity_<projectId>_`, so the actual identifier can never
  literally *be* a bare keyword), but column names — which come straight
  from `field.name` with no such prefix — are not, and a field plausibly
  named `order` (sort order), `group`, `key`, `index`, `default`,
  `references`, or any of SQLite's ~130 other reserved words is an
  entirely ordinary business field name an LLM-generated or heuristic
  spec could produce. Confirmed with `node:sqlite` directly: `CREATE
  TABLE t (id INTEGER PRIMARY KEY, order TEXT)` fails with `near "order":
  syntax error`. Notably, this exact bug was already independently
  discovered and fixed once before — but only in the exported standalone
  app's own codegen output (`apps/api/src/codegen.ts`'s `q()` helper,
  whose own comment literally cites "an entity or field name that happens
  to be a SQL keyword (e.g. an 'Order' entity)" as the reason it exists)
  — never in the live app's own database layer, which this round closes.
  Added `quoteIdentifier` to `identifiers.ts` (double-quotes an already-
  validated identifier — safe since `assertSafeIdentifier` guarantees no
  quote characters to escape, same reasoning as `codegen.ts`'s `q()`) and
  applied it to every raw-SQL identifier interpolation in `migrate.ts`
  (`CREATE TABLE`, column definitions, `REFERENCES`, the `PRAGMA
  table_info` used by the additive-migration diff, `ALTER TABLE ADD
  COLUMN`) and `repository.ts` (`SELECT`/`INSERT`/`UPDATE`/`DELETE`,
  including the dynamically-built `SET` clause). Swept the rest of the
  codebase for the same unquoted-interpolation pattern first
  (`twin.ts`/`backup.ts` build no raw SQL of their own — they go through
  `repository.ts` — so they're covered by this same fix). Added a
  regression test in `repository.test.ts` exercising a `Task` entity with
  an `order` field through the complete real create/read/update/delete
  cycle via the actual `node:sqlite` engine (not a mock), plus a focused
  test in `migrate.test.ts` on `generateCreateTableStatements` itself;
  both proven to fail against the pre-fix code first with the exact same
  `near "order": syntax error`. This also required updating one existing
  `migrate.test.ts` assertion that had been checking the literal unquoted
  SQL string — a legitimate, expected consequence of the fix rather than
  a regression. Full suite green (284 tests, up from 282 — db package
  went 50→52) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- Self-review (code-review skill, high effort) of `packages/db/src/seed.ts`
  (215 lines, already had substantial tests — 308 lines — but never
  reviewed). Fixed 2 of the 4 findings, both confirmed with a regression
  test proven to fail against the pre-fix code first, then verified live
  through the real UI (not just unit tests, since this file's whole output
  is directly what a freshly built app's tables show): (1) `seedValueFor`'s
  `"date"` case computed the seeded value purely from the record index,
  ignoring the field's own name, so an entity with two date fields —
  Rental's `startDate`/`endDate`, part of the built-in domain library, not
  a hypothetical — got the exact same date for both on every seeded
  record, i.e. every demo rental looked like a 0-day rental. Fixed by
  detecting an "end"-like field name and offsetting it to land 3 days
  closer to today than its record's other date field(s), with a base
  spacing that guarantees no collision even at record index 0. (2) The
  generic fallback entity used whenever a description matches no domain
  keyword is literally named `"Item"` (`DEFAULT_ENTITY` in
  `domainEntities.ts`), but `CATALOG_NAME_ENTITIES` only listed
  `"Service"`/`"Product"`, so `Item`'s `"name"` field fell through to the
  person-name pool — every unrecognized-description app's demo data
  showed a generic item literally named "Dana Levi". Fixed by adding
  `"Item"` to `CATALOG_NAME_ENTITIES`. Added 2 new tests to
  `seed.test.ts`. Verified live end-to-end through the real UI against
  real dev servers, using the real build pipeline (not just
  `generateSeedRecords` in isolation): built a real project from the
  description "עסק להשכרת ציוד לאירועים" (an equipment-rental business)
  and confirmed the seeded Rental rows show real, distinct, chronologically
  ordered dates (e.g. 9/12/2026 → 9/15/2026); separately built a project
  from a deliberately unclassifiable description and confirmed the
  fallback Item entity's seeded rows show real item-like names ("Premium
  Upgrade", "Basic Package") instead of person names. The other 2 findings
  from the review — required relation fields seeded with an unverified
  `id=1` guess that can violate a real FK constraint, and dates always
  being in the past regardless of field semantics (`dueDate`, `scheduled`)
  — are left open: neither is reachable through the built-in domain
  library today (every built-in relation field is `required: false`;
  confirmed by grepping `domainEntities.ts`), and properly fixing either
  needs a real design decision (topological seed ordering, or field-name-
  aware forward/backward date semantics) rather than a one-line safe fix,
  so they're noted honestly for a future round instead of rushed. Full
  suite green (286 tests, up from 284 — db package went 52→54) + both
  builds clean + a from-scratch clean-room clone/install/test/build/start
  cycle with a live `/api/health` check.

- **Self-review found and fixed a calendar-view label bug (fragile against
  AI-generated specs, not currently reachable through the built-in domain
  library).** `CalendarView`'s day-chip label (`apps/web/src/EntityPanel.tsx`,
  and its ported twin in the exported-app template,
  `apps/api/src/codegen.ts`) picked "whichever field happens to come first
  after the date field" as the record's display label, instead of reusing
  the same `pickDisplayField` rule ("name"/"title", then first text field)
  every other view (table, board, relation picker, CSV) already uses for a
  record's label. Checked reachability first, the same discipline as
  earlier rounds this window: wrote a script that ran `findDateField` and
  `pickDisplayField` against all 18 built-in domain entities with a date
  field, and every single one happens to declare its identifying field
  before its date field, so the two rules have always coincidentally
  agreed there — this is real insurance against a future/AI-generated spec
  ordering fields differently, not (yet) a currently-visible bug for any
  built-in entity. Added `calendarChipLabelField(entity, dateField)` to
  `apps/web/src/entityFormatting.ts` (prefers `pickDisplayField`'s result,
  falling back to the old "first other field" rule only in the edge case
  where `pickDisplayField` itself would have resolved to the date field),
  wired it into `EntityPanel.tsx`'s `CalendarView`, and ported the
  equivalent fix into `codegen.ts`'s generated `CalendarView` (which
  already generates `pickDisplayField` earlier in the same template file
  for `recordDisplayLabel`, so no new helper was needed there). Two new
  tests in `entityFormatting.test.ts` using a hand-built entity (date
  field first, then a boolean, then the real "name" field) prove the old
  rule would have shown the boolean; a new codegen test asserts the
  generated `CalendarView` source actually calls `pickDisplayField(entity)`
  instead of the old blind first-field fallback. Both regressions
  confirmed against pre-fix code via `git stash` on just the source files
  (the live-preview test failed with a build error — the export didn't
  exist yet; the codegen test failed on the literal old generated source
  string). Verified live via real Playwright against real dev servers
  (signed up, described an appointment-scheduling hair-salon app, built
  it through the real pipeline, switched the Appointment entity to
  Calendar view): chips correctly show "Yossi Cohen"/"Dana Levi", i.e. no
  regression for the one reachable case. Full suite green (289 tests, up
  from 286) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.

- **Self-review (via the `code-review` skill, high effort) of
  `apps/api/src/pipeline.ts` found a real gap left by an earlier fix, in a
  file nobody had reviewed directly this window.** Commit
  `cf9a206` ("Re-emit the Architect summary after a Debug Agent recovery")
  fixed the pipeline to emit a SECOND, corrected Architect success event
  after a Debug Agent recovery renames/restructures whatever caused a
  Database-step failure, since the first (already-streamed) event can
  describe a field/entity that was never actually built. That commit
  verified `BuildProgress.tsx` (the live AI Team screen) was already safe,
  since its `latestByAgent` map naturally keeps the last event per agent
  — but missed that `App.tsx`'s `summarizeRefineImpact` (the one-line
  summary written into the refine-history/chat panel) is a SEPARATE
  consumer of the same raw event array, and it used `events.find(...)` —
  the FIRST match, not the last — so a recovered refine's history entry
  still showed the broken pre-fix field name. Fixed by replacing the
  `.find()` with a small forward loop that keeps overwriting
  `architectEvent` on every match, so the last one (survives to) wins,
  matching `BuildProgress.tsx`'s existing behavior; also exported the
  previously-unexported `summarizeRefineImpact` so it has real, direct
  unit tests for the first time (`apps/web/src/App.test.ts`, new file).
  Confirmed the specific bug in isolation, not just the missing export:
  reverted only the `.find()` line back to the old logic (keeping the new
  export) and reran the 3 new tests — the 2 ordinary-case tests still
  passed, and only the "prefers the LAST successful event" test failed,
  showing the exact stale value the old code would have displayed; then
  restored the real fix and all 3 passed. Live Playwright verification
  was judged disproportionate here and skipped, honestly: reproducing the
  actual trigger (a Database-step failure the Debug Agent then recovers
  from, mid-refine, through the real UI) would mean deliberately
  engineering a failure through the product surface rather than testing
  it, and the original `cf9a206` fix itself was verified the same way
  this one is — a focused unit/integration test with a fake Debug Agent,
  not a live E2E reproduction — so this follows the same, already-
  established precedent rather than a new lower bar. Full suite green
  (292 tests, up from 289 — web package went 72→75) + both builds clean
  (including `tsc -b`, confirming the manual loop needs no ES2023 lib
  bump `Array.prototype.findLast` would have required) + a from-scratch
  clean-room clone/install/test/build/start cycle with a live
  `/api/health` check.

- **Closed a standing open question from an earlier round's honest
  write-up: `normalizePhone` (`apps/api/src/whatsapp.ts`) stripped only a
  single leading zero, not a full leading "00" international access
  code.** The doc comment explained stripping one zero for the single-
  digit national trunk prefix (Israeli local format "050-..." vs.
  international "972-50-..."), but never addressed the two-digit "00"
  international dialing prefix some countries' convention uses
  ("00972-50-..." instead of "+972-50-..."), which left a spurious
  leading "0" baked into the "normalized" result. Checked both places
  this value is actually used before assuming which one broke: (1)
  `findMatchingRecord`'s incoming-vs-stored comparison uses `endsWith`,
  which turned out to already be robust to the extra digit by
  construction (confirmed by hand-tracing the digit math, not by writing
  a test that would have passed either way and proved nothing — an
  earlier draft of this fix included exactly such a non-isolating test
  and it was removed once traced through); (2) `WhatsAppWebManager.
  sendMessage` (`apps/api/src/whatsappWeb.ts`) builds the outgoing
  WhatsApp JID directly from this value (`${phone}@s.whatsapp.net`),
  where the bug is real and observable: a "00"-prefixed number produced
  an invalid JID with a leading "0" that was never part of the real
  number. Fixed by stripping *every* leading zero (`/^0+/` instead of
  `/^0/`), confirmed to be a strict generalization with no regression for
  the existing single-trunk-zero case (a number is either in local format
  with exactly one trunk zero, or already international with none — the
  two never combine). Confirmed against pre-fix code via `git stash`:
  both the new direct `normalizePhone` unit test and the new
  `sendMessage` JID-construction test failed with the exact wrong value
  (`0972501234567` / `0972501234567@s.whatsapp.net`), then passed after
  restoring the fix. Checked `codegen.ts` for a duplicated copy the way
  earlier rounds kept finding (`anthropic.ts`→`debug.ts`,
  `identifiers.ts`, `entityFormatting.ts`) — none exists, since WhatsApp
  is a live-app-only integration never ported to the exported standalone
  app. Live Playwright verification wasn't attempted: the real trigger
  (an actual WhatsApp Web/Baileys connection) needs a real QR scan,
  unreachable from this sandbox by a known, already-documented
  environment limit; the existing injected-fake-socket unit tests are
  this file's own established, sufficient verification method (same
  pattern the whole `whatsappWeb.test.ts` suite already uses). Full suite
  green (294 tests, up from 292 — api package went 92→94) + both builds
  clean + a from-scratch clean-room clone/install/test/build/start cycle
  with a live `/api/health` check.

- **Self-review (via `code-review`, high effort) of `apps/api/src/twin.ts`
  and `apps/api/src/backup.ts`, the two remaining server files this
  window hadn't looked at directly, found a real security gap in every
  CSV-producing code path in the app.** `twin.ts` came back clean — its
  last substantive fix (`fc148df`/`0ea7fad`) predates this window and
  still holds, confirmed with zero new findings. `backup.ts` surfaced a
  real one: `csvEscape` only quoted a cell containing a comma, quote, or
  newline, never neutralizing a leading `=`, `+`, `-`, or `@` — classic
  CSV/formula injection (CWE-1236). A stored field can hold arbitrary
  text (an AI-generated spec's "notes" field, a WhatsApp-sourced
  message), and Excel/Sheets/LibreOffice execute an unguarded cell like
  that as a formula the moment a real business owner opens their own
  exported data. This exact `csvEscape` is deliberately duplicated 4
  times across the codebase (the established pattern this window kept
  re-discovering) — `apps/api/src/backup.ts`, `apps/web/src/
  entityFormatting.ts` (live-preview per-entity CSV export), and *two*
  copies inside `apps/api/src/codegen.ts` (the exported app's own
  per-entity export button and its own "Backup All Data" endpoint) — so
  the same fix was applied to all 4: a value starting with `=`, `+`, `-`,
  `@`, or a tab/CR is now prefixed with a leading single quote before the
  existing comma/quote/newline wrapping, which spreadsheet apps treat as
  "force text" rather than executing. Confirmed against pre-fix code via
  `git stash`: new unit tests in `entityFormatting.test.ts` and
  `backup.test.ts` failed with the exact unguarded value; the existing
  real end-to-end `codegen.test.ts` test (which boots the actual
  generated `server.js` and hits its real `/api/backup` endpoint over
  HTTP) was extended to insert a formula-like name and failed the same
  way pre-fix, then passed after the fix — real proof for the generated
  app's server-side copy, not just a source-string check; a source-string
  assertion covers the client-side `EntityView.jsx` copy the same way
  earlier codegen fixes in this window did. First mistake caught before
  committing: an initial test value containing both a leading `=` and an
  internal comma/quote produced the wrong expected string (the
  formula-guard and the comma/quote-wrapping compose — the guard is
  applied first, then the result gets quoted like any other value with a
  comma/quote) — recomputed with Node directly rather than guessing, and
  fixed the expectations, including one test that explicitly exercises
  the composition case. Verified LIVE beyond the test suite too: booted
  real dev servers and built a real project. First attempt to add the
  formula-injecting record through the actual Add-record form appeared to
  fail (the DOM showed the typed value but the outgoing POST body was
  empty) -- before writing that up as a newly-found product bug, checked
  it rather than trusted the first impression: the preview screen has
  *two* `<form>` elements (the record-add form and a separate "Improve
  the app" refine form), and the test script's own generic
  `input[type=text]`/`button:has-text("Add")` locators had matched the
  wrong one. A corrected, scoped locator (`form.record-form ...`)
  confirmed the real form works exactly as intended -- no product bug, a
  test-script mistake caught before it was recorded as one. Verification
  then proceeded via a direct authenticated `fetch` to the real live
  server (the same request the (working) form sends) and downloading the
  real "Backup All Data" ZIP from the real live server over HTTP, decoded
  with Python's `zipfile` (spec-strict): the real CSV inside contains the
  guarded value (`'=cmd|' /C calc'!A1`) exactly as the fix intends. Full
  suite green (296 tests, up from 294 — api package went 94→95, web
  package went 75→76) + both builds clean + a from-scratch clean-room
  clone/install/test/build/start cycle with a live `/api/health` check.
  Left open, honestly, for a future round: a second, separate finding
  from the same review — two entities sharing a name (the spec schema
  has no uniqueness constraint on `entities[].name`) would silently
  collide into the same ZIP path — is real but lower-severity and not yet
  confirmed reachable through any current spec-generation path, so it
  wasn't rushed into this round's fix.

- **Self-review (`code-review`, high effort) of `apps/web/src/App.tsx`
  found a real state-leak bug: `handleLogout` never reset several pieces
  of per-project UI state, so the browser tab (which never reloads on
  logout) carried the previous project's leftovers into whatever project
  got built next in the same session.** Two concrete, confirmed symptoms:
  (1) `activeEntity` — `handleBuildComplete`'s `setActiveEntity((prev) =>
  prev ?? builtProject.spec.entities[0]?.name ?? null)` is deliberately
  "only default on a genuinely fresh build" (so a *refine* on the same
  project correctly keeps whatever tab was open) — but after a logout
  with no reset, the *next* project's very first build sees a stale,
  non-null `prev` from the old project, so it never picks the new
  project's first entity; since the entity-panel render filters records
  by `e.name === activeEntity`, an entity name that doesn't exist on the
  new spec renders a completely blank preview pane with no tab
  highlighted, until the user happens to click a tab themselves. (2)
  `refineHistory` was never cleared either, so the old project's refine
  chat-history entries kept showing in the new project's "Refine
  history" panel. Fixed by resetting `description`, `error`,
  `activeEntity`, `selectedAnswers`, `additionalRequest`, `refineText`,
  and `refineHistory` in `handleLogout`. This bug has no unit-testable
  surface (App.tsx has no React Testing Library in this project, and the
  bug is specifically about cross-session in-memory state, not a pure
  function), so it was proven live instead, using the same git-stash
  discipline the unit tests use: booted real dev servers, built a real
  "sales CRM" project (Customer/Order/Courier) as user A, clicked to the
  last tab (Courier) to set a non-default `activeEntity`, logged out,
  signed up as user B in the same browser tab, and built an unrelated
  "veterinary clinic" project (Pet only) — against the pre-fix code
  (restored via `git stash`) this reproduced exactly as predicted: 0
  active tabs, no `record-form` rendered, a genuinely blank preview pane;
  against the fix, 1 active tab and a working form, immediately. Full
  suite green (296 tests, unchanged — a live-only fix) + `tsc -b` clean +
  both builds clean + a from-scratch clean-room clone/install/test/
  build/start cycle with a live `/api/health` check.

- **Self-review (`code-review`, high effort) of the 3 remaining unreviewed
  overlay panels (`GlobalSearchPanel.tsx`, `HistoryPanel.tsx`,
  `BusinessTwinPanel.tsx`) pointed at their shared accessibility hook,
  `useDialogFocusTrap.ts`, and found a real regression in the one thing
  its own doc comment promises: "returns focus to whatever triggered the
  panel once it closes."** The hook captured `previouslyFocused =
  document.activeElement` *inside* its `useEffect`, but a passive effect
  runs after React has already committed the DOM for that render — which
  includes applying any `autoFocus` inside the newly-mounted dialog (only
  `GlobalSearchPanel`'s search input has one). So by the time the effect
  ran, `document.activeElement` was already that autoFocus'd input, not
  the real trigger (the "🔍 Search" toolbar button) — closing the panel
  called `.focus()` on the by-then-unmounted input (a no-op), leaving
  focus stranded on `<body>` instead of back on the button, for the one
  panel with autoFocus content. Fixed by capturing `previouslyFocused` in
  a `useRef` initialized during the *render* phase (before this dialog's
  own DOM exists at all), not inside the effect. A second, related,
  currently-unreachable finding was fixed too: the fallback path
  (`container.focus()` when a dialog has no focusable descendants at all)
  silently no-ops without `tabIndex={-1}` on the container, per the DOM
  spec — every current panel always renders a close button so this never
  fires today, but the hook's own contract should hold for any future
  dialog built on it regardless. A third finding (background content
  isn't marked `aria-hidden`/`inert` while a panel is "modal", so a
  screen-reader's virtual-cursor browse mode can still reach it) was left
  open, honestly: real, but a materially bigger, more invasive change
  (identifying and conditionally hiding every sibling of the active
  overlay across `App.tsx`) than the surgical fix the first two findings
  needed, so it wasn't folded into this round. No unit-testable surface
  again (a focus-management React hook, no RTL in this project) — proven
  live instead, and a genuine surprise turned up doing it: the first live
  attempt (against `npm run dev`'s Vite server) showed the autoFocus
  input immediately losing focus back to the trigger button the instant
  the panel opened, which looked like the fix had made things *worse* --
  investigated rather than assumed, and it was a React 18 `StrictMode`
  dev-only artifact (this app wraps in `<React.StrictMode>`): a
  passive effect's mount→cleanup→remount double-invoke simulation
  triggered the hook's own restore-focus cleanup mid-mount, an artifact
  that does not exist in a production build (`StrictMode`'s double-invoke
  is stripped in production React). Rebuilding the real `apps/web`
  production bundle and serving it from the real API's static-file
  handler (`webDistDir` in `apps/api/src/server.ts`) reproduced a clean,
  StrictMode-free result: pre-fix code showed the exact predicted bug
  (autoFocus correctly lands on the input, but closing leaves focus on
  `<body>`); the fix showed autoFocus still correct, and focus correctly
  restored to the button on close. Full suite green (296 tests,
  unchanged — a live-only fix) + `tsc -b` clean + both builds clean + a
  from-scratch clean-room clone/install/test/build/start cycle with a
  live `/api/health` check.

- **Self-review (`code-review`, high effort) of `WhatsAppPanel.tsx`'s own
  logic (the last unreviewed piece of the WhatsApp integration, separate
  from the shared `useDialogFocusTrap` hook already covered) found a real
  race condition in the background "still connected?" poll added in an
  earlier round.** `startConnectedPolling`'s 10s-interval status check
  awaited `getWhatsAppStatus`, then called `setStatus(next)` unconditionally
  — but `stopConnectedPolling` (called from `handleDisconnect`) only
  cleared the interval timer, never cancelled a check *already in flight*.
  A background check that started just before the user clicked Disconnect
  could resolve just after, silently overwriting the fresh "disconnected"
  state with its now-stale "connected" payload — the UI would flip back to
  showing a live WhatsApp connection with an active Disconnect button, even
  though the backend had already disconnected. Fixed with the same
  `cancelled` closure-flag pattern this codebase already uses elsewhere
  (`EntityPanel.tsx`'s `loadRelated` effect): `startConnectedPolling`
  captures a `cancelled` flag and stores a canceller in a ref;
  `stopConnectedPolling` now calls that canceller before clearing the
  interval, so a check already in flight is a no-op when it resolves. A
  second, related finding from the same review was fixed too: the
  background poll's `catch` block had no failure cap, unlike the fast
  QR-waiting poll it complements (`MAX_CONSECUTIVE_POLL_FAILURES`) — a
  persistently failing background check (backend down, expired session)
  would retry silently forever with the panel stuck showing a "Connected"
  status the code could no longer actually confirm. Added the matching
  `MAX_CONSECUTIVE_CONNECTED_POLL_FAILURES` threshold and error surfacing.
  No unit-testable surface (a React component, no RTL) and the real
  trigger — an actual Baileys/WhatsApp connection — is unreachable from
  this sandbox, so this was verified live with `page.route()` network
  mocking instead: intercepted the panel's own status/messages/disconnect
  endpoints to put it in a "connected" state without any real WhatsApp
  session, delayed the background poll's second tick by 3s to create a
  real in-flight request, clicked Disconnect while it was still pending,
  and checked the UI's state after the delayed response finally resolved.
  Learning the lesson from the immediately preceding round, this was run
  against a real production build (not `npm run dev`) to keep React
  StrictMode's dev-only effect double-invoke out of a test that already
  depends on precise timing and call counts. Pre-fix code reproduced the
  race exactly as predicted (UI reverted to "connected" after the stale
  response landed); the fix left the UI correctly showing "disconnected".
  Full suite green (296 tests, unchanged — a live-only fix) + `tsc -b`
  clean + both builds clean + a from-scratch clean-room clone/install/
  test/build/start cycle with a live `/api/health` check.

- [x] **Downloaded ZIP filenames no longer collapse Hebrew project names to
      "forge-app".** Self-review of `apps/web/src/api.ts` (the client-side
      fetch/download layer) found that both `exportProject` and
      `backupProject` derived the saved filename with
      `projectName.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app"` —
      which strips every character outside that ASCII whitelist. Since this
      product is Hebrew-first and every real project name a user actually
      sees comes out of spec generation as Hebrew text, a name like
      "אפליקציה לניהול תורים למספרה" collapsed entirely to the empty string,
      silently falling back to the generic "forge-app.zip" /
      "forge-app-backup.zip" — the user's own project name never appeared
      in their downloaded file at all. Added `safeDownloadName(projectName,
      fallback)`, which strips only characters genuinely unsafe in a
      filename (path separators, Windows-reserved characters, control
      characters) and otherwise preserves the name as-is; both download
      paths now use it. Deliberately did **not** apply the identical change
      to the matching server-side logic in `apps/api/src/routes/projects.ts`
      (its own `Content-Disposition`-header filename sanitizer, at lines
      262 and 278) — that stays ASCII-only on purpose, for a real technical
      reason rather than an oversight: Node's `res.setHeader()` requires
      header values to stay within the Latin-1 byte range and would throw
      at runtime on raw Hebrew text, and in any case this app's actual
      download flow is `fetch()` + `Blob` + a real `<a download="...">`
      element, so the filename that ends up on disk is the client-side
      `download` attribute (which the browser reads directly and has
      supported arbitrary Unicode since HTML5), not the HTTP header —
      confirmed the existing server-side tests
      (`apps/api/src/app.test.ts`, the `Content-Disposition` assertions
      around lines 565 and 597) only check the generic
      `/attachment; filename=".*\.zip"/` pattern and don't need updating.
      Caught and fixed my own mistake while writing the new unit tests:
      hand-guessed the expected output of `safeDownloadName('Ord*rs:
      "Q1"?', "forge-app")` as `"Orders Q1"` before actually running the
      regex, which was wrong — the real output is `"Ordrs Q1"`; recomputed
      it directly with `node -e` before finalizing the test, re-confirming
      the standing rule to never hand-compute a non-trivial string
      transformation's expected value. 3 new unit tests in
      `apps/web/src/api.test.ts`, proven against the pre-fix code via
      `git stash` (the test file failed to even load, with `SyntaxError:
      the requested module './api.js' does not provide an export named
      'safeDownloadName'`, since the fix introduces the function itself).
      Full suite green (299 tests, up from 296 — `@forge/web` 76 → 79) +
      `tsc -b` clean + both builds clean + a from-scratch clean-room
      worktree clone/install/test/build/start cycle with a live
      `/api/health` check.

- [x] **The "waking up the server" banner could disappear early while the
      server was still genuinely cold-starting.** This was an open finding
      deferred from the previous round's self-review of `apps/web/src/api.ts`:
      `fetchApi`'s `onWaking` callback was wired straight to a single global
      `notifyWaking` boolean. Every in-flight request (auth calls, project
      loads, a WhatsApp status poll, the global-search fetch, etc.) runs its
      *own* independent `fetchWithWakeRetry` retry loop, and each one calls
      `onWaking(false)` the instant *its own* retries finish — with no idea
      whether some other, sibling request (e.g. a background poll landing
      at the same time as a user clicking a button) is still failing and
      retrying. During a real cold start with more than one request in
      flight, whichever one's own retry loop happened to finish first would
      hide the "waking up" banner, even while another request was still
      genuinely retrying against a server that hadn't actually woken up
      yet — misleading the user into thinking the app was ready when it
      wasn't. Added `createWakeRefCounter()`, which wraps the notifier so
      it only fires `waking(false)` once every concurrent caller has
      released it (fires `waking(true)` only on the *first* concurrent
      caller, similarly). While writing the regression test for this fix, I
      caught a real bug in my own first version of it: the initial
      implementation used `active = Math.max(0, active - 1)` and then
      checked `if (active === 0) notify(false)` — but that fires a spurious
      `waking(false)` on an *unmatched* release (i.e. a `false` call
      arriving when the count was already 0), since the clamped result is
      still 0. A genuinely unreachable case in the real call site today
      (each `fetchWithWakeRetry` call always balances its own `true`/`false`
      pair), but wrong on its own terms as a general-purpose counter, and
      exactly the kind of off-by-one a future caller could hit. Fixed by
      only decrementing (and only then checking for zero) when the count is
      already positive — an unmatched release is now a true no-op. 2 new
      unit tests in `apps/web/src/api.test.ts` test `createWakeRefCounter`
      directly and deterministically (no real timers needed, since the
      counting logic itself — not `fetchWithWakeRetry`'s already-tested
      per-call retry behavior — is what changed): one proves `waking(false)`
      only fires after every concurrent caller releases, not the first one
      to finish; the other proves an unmatched release never fires a
      spurious notify. Proven against the pre-fix code via `git stash` (the
      test file failed to even load, since the fix introduces the
      `createWakeRefCounter` export itself). Full suite green (301 tests, up
      from 299 — `@forge/web` 79 → 81) + `tsc -b` clean + both builds clean +
      a from-scratch clean-room worktree clone/install/test/build/start
      cycle with a live `/api/health` check.

- [x] **The JSON-parse-failure fallback error was hardcoded English,
      unlike every other server error in this app.** Another open finding
      deferred from the round-48 `code-review` of `apps/web/src/api.ts`:
      `request()`, `streamPipeline()`, `exportProject()` and
      `backupProject()` all build a fallback error body with
      `res.json().catch(() => ({ error: `Request failed (${res.status})`
      }))` — hit whenever a real HTTP error response's body isn't valid
      JSON at all (e.g. a hosting platform's own plain-text 502/504 error
      page, or any other non-JSON response, rather than this app's own
      `{ error, code }` shape). `resolveErrorMessage` only translates a
      body that carries a recognized `code` — with none present, it fell
      straight through to that literal, hardcoded English string,
      regardless of whether the user's UI was set to Hebrew. Every other
      server error in this app is localized this way (see the
      `error.WHATSAPP_NOT_CONNECTED` precedent from an earlier round); this
      one path was the exception. Fixed by adding `code: "REQUEST_FAILED"`
      to all 4 fallback bodies, with matching entries added to both
      language dictionaries (`error.REQUEST_FAILED` in
      `apps/web/src/i18n/language.ts`), the same pattern already used for
      the client-synthesized `NETWORK_ERROR` code. New tests: a
      dictionary-completeness check in `language.test.ts` mirroring the
      existing `NETWORK_ERROR` test, and an end-to-end test in
      `api.test.ts` that mocks a real HTTP 500 response with a plain-text
      (non-JSON) body and confirms `listProjects()` rejects with the
      translated message, not the raw `Request failed (500)` text. Both
      proven against the pre-fix code via `git stash` (2 failures: the new
      dictionary-completeness test, and the new end-to-end test asserting
      the untranslated string). Caught my own wrong assumption while
      writing the end-to-end test: assumed this Node test runtime would
      resolve to Hebrew (matching `detectInitialLang`'s "no browser info
      → Hebrew" default), but Node 22 actually exposes a global
      `navigator` object with `navigator.language === "en-US"`, so
      `resolveErrorMessage` resolves to English here — matching the
      precedent already set by the existing `sendWhatsAppMessage` 409 test
      a few rounds earlier, which I misread as expecting Hebrew until I
      re-checked it directly. Full suite green (303 tests, up from 301 —
      `@forge/web` 81 → 83) + `tsc -b` clean + both builds clean + a
      from-scratch clean-room worktree clone/install/test/build/start
      cycle with a live `/api/health` check.

- [x] **A network drop partway through a build or refine leaked a raw
      browser error, instead of the translated message every other failure
      in this app shows.** The last open finding from the round-48
      `code-review` of `apps/web/src/api.ts`: `fetchApi` already translates
      a failure to even *connect* (via `fetchWithWakeRetry` and the
      `NETWORK_ERROR` code), but `streamPipeline`'s SSE read loop —
      `reader.read()`, called repeatedly for as long as the build/refine
      stream stays open — was the one place left outside that layer. A
      build or refine is the one request in this app that can legitimately
      run for minutes, so a real network drop mid-stream (not just at
      connect time) is a genuine risk, not a theoretical one; when it
      happened, `reader.read()` threw the browser's own untranslated error
      (e.g. `"network error"` or `"Failed to fetch"`), and
      `BuildProgress.tsx` renders that `Error.message` straight to the
      user with no translation step in between. Fixed by wrapping just the
      `reader.read()` call in a try/catch that re-throws through the same
      `resolveErrorMessage({ code: "NETWORK_ERROR" })` path `fetchApi`
      already uses — deliberately *not* wrapping the `onEvent` callback or
      the SSE frame parsing below it, since a bug there is a different
      kind of failure and misreporting it as a network problem would hide
      the real cause. New test in `apps/web/src/api.test.ts`: builds a real
      `ReadableStream` whose `start()` emits one valid SSE frame (so the
      caller does receive that agent-step event) and whose `pull()` then
      calls `controller.error(...)` on the next read — simulating a stream
      that was genuinely working and then dropped, not a stream that never
      opened. Confirms `streamBuild()` rejects with the translated message
      and that the one pre-drop event still arrived. Before writing the
      assertion, verified the exact `ReadableStream`/`getReader()` timing
      directly with a small Node script (`start()`'s enqueued chunk is
      always delivered by the first `read()` before `pull()` is invoked
      again), rather than assuming it. Proven against the pre-fix code via
      `git stash` (the new test's assertion failed with the raw
      `"network error"` string instead of the translated one). This closes
      out the round-48 `api.ts` self-review: all 6 findings from that
      review are now either fixed (rounds 48–51) or explicitly deferred as
      a documented code-cleanup item (`exportProject`/`backupProject`'s
      duplicated download sequence — not a correctness bug). Full suite
      green (304 tests, up from 303 — `@forge/web` 83 → 84) + `tsc -b`
      clean + both builds clean + a from-scratch clean-room worktree
      clone/install/test/build/start cycle with a live `/api/health` check.

- [x] **Opening a failed Seed Data step's details crashed the whole build
      screen to a blank page.** Self-review (`code-review` skill, high
      effort) of `apps/web/src/BuildProgress.tsx` — a file that had never
      had a dedicated pass before, picked specifically because round 51's
      fix touched the error-message path it renders. `AgentDetail`'s
      "Seed Data" branch always destructured `detail` as
      `{ seededCount, entities }` and immediately read `entities.length` —
      but `apps/api/src/pipeline.ts` (lines 233–239) sends a plain
      `string[]` of per-record errors as `detail` when seeding actually
      fails (a real, reachable path: any seed record that violates a
      constraint, e.g. a duplicate unique field, lands here), and only a
      *successful* seed sends the `{ seededCount, entities }` object shape
      (line 245). Clicking "Show details" on a failed Seed Data row ran
      `entities.length` against `undefined` and threw — and since there is
      no `ErrorBoundary` anywhere in `apps/web/src`, React 18 unmounts the
      whole tree on an uncaught render error with nothing to catch it,
      blanking the entire build screen. Fixed by adding an
      `Array.isArray(detail)` check before the object-shape branch — the
      exact pattern the "Database", "QA" and "Security" branches already
      use for their own array-shaped details — and rendering the real
      per-record error list in that case, the same way "Security"'s
      warnings list already renders raw (untranslated) server-side error
      text. No unit-testable surface (a React component; this project has
      no jsdom/testing-library dependency, so component tests are verified
      live instead, per established practice). Verified against a real
      `npm run dev` server: intercepted the build SSE stream
      (`page.route()`) to force a synthetic Seed Data failure carrying a
      real `string[]` detail, clicked "Show details", and used
      `git stash` on just the source file to confirm the pre-fix code
      threw `Cannot read properties of undefined (reading 'length')`
      (captured via Playwright's `page.on("pageerror")`) and blanked the
      page, while the post-fix code renders the error text with zero
      `pageerror` events. Full suite unchanged (304 tests — a live-only
      fix, no new unit test) + `tsc -b` clean + both builds clean + a
      from-scratch clean-room worktree clone/install/test/build/start
      cycle with a live `/api/health` check.

- [x] **The signup/login mode toggle could leak a stale error into the
      other form, and let an abandoned signup or login silently sign the
      user in mid-request.** Self-review (`code-review` skill, high effort)
      of `apps/web/src/AuthScreen.tsx` (its first dedicated pass). Two
      linked bugs in the same toggle button, fixed together: (1) switching
      between signup and login never cleared `error` — a user who got "An
      account with this email already exists." on signup and clicked
      "I already have an account" saw that same signup error sitting under
      the login form, which is both confusing and factually wrong for the
      action they were about to take (and the reverse case, a login error
      bleeding into signup, is equally misleading); (2) the toggle button
      stayed clickable while `busy` was `true`, unlike the submit button —
      a user could submit signup, then click the toggle and start typing
      different login credentials before the original request resolved;
      when it did resolve, it would silently call `onAuthenticated` under
      the signup account they'd already abandoned, discarding whatever
      they were mid-way through typing with no indication anything
      happened. Fixed by clearing the error and disabling the toggle
      (`disabled={busy}`) in the same `onClick`, mirroring the pattern the
      submit button already uses. No unit-testable surface (a React
      component; this project has no jsdom/testing-library, so component
      fixes are verified live, per established practice). Verified against
      a real `npm run dev` server: `page.route()` mocked a 409
      `EMAIL_TAKEN` signup response to trigger a real error, then a
      login response delayed 2.5s to create a genuine in-flight request.
      Confirmed via `git stash` on just the source file that the pre-fix
      code left the stale signup error visible after switching to login
      and kept the toggle clickable (and thus the mode switchable) while a
      request was pending, while the post-fix code clears the error
      immediately and disables the toggle until the request settles (then
      correctly re-enables it). Full suite unchanged (304 tests — a
      live-only fix, no new unit test) + `tsc -b` clean + both builds
      clean + a from-scratch clean-room worktree clone/install/test/
      build/start cycle with a live `/api/health` check.

- [x] **Two real validation-handling bugs in `apps/api/src/routes/projects.ts`,
      found by its first dedicated self-review as a full route file.**
      (1) Four routes — `POST /ideas/enhance`, `/projects`,
      `/projects/:id/answers`, `/projects/:id/refine` — threw
      `new HttpError(400, parsed.error.message, ...)` directly.
      `ZodError.message` is `JSON.stringify(issues, null, 2)`, not readable
      text: `apps/api/src/routes/auth.ts` had already hit this exact
      problem and fixed it locally with a `formatValidationError()` helper
      (join each issue's own `.message`), but that fix was never reused in
      `projects.ts`, so every failed validation on these 4 core endpoints
      sent the client a multi-line JSON blob as its user-facing error
      string — e.g. `POST /projects` with `{}` returned an error field
      starting with `"[\n  {\n    \"code\": \"invalid_type\"...`. (2) The
      WhatsApp send route used `WhatsAppSendSchema.parse()` (throwing)
      instead of the `safeParse()` + `HttpError(400, VALIDATION_ERROR)`
      pattern every other validated route in the file already uses — a
      malformed body (missing/empty `to` or `message`) threw an uncaught
      `ZodError` straight into `app.ts`'s catch-all, which returned a
      generic 500 Internal Server Error instead of a 400: the only route
      in this file where routine bad input looked like a server crash and
      polluted error logs with a real stack trace for what is just a
      client mistake. Fixed both: moved `formatValidationError()` out of
      `auth.ts` and into `httpError.ts` (next to `HttpError` itself, which
      both routers already import) as a single shared helper, switched all
      4 sites in `projects.ts` to use it, and switched the WhatsApp send
      route to the same `safeParse()` + `HttpError` pattern as its
      siblings. New end-to-end tests in `apps/api/src/app.test.ts`, run
      against a real Express server via the existing `withServer()` test
      harness (no mocking): one confirms a failed `POST /projects`
      validation now returns short readable text (`"Required"` for a
      missing field — Zod's own base type-check message, since a field
      that's `undefined` fails type-checking before the schema's custom
      `.min(1, "...")` message ever runs) instead of a JSON dump; the
      other confirms WhatsApp send now returns 400/`VALIDATION_ERROR` for
      a malformed body instead of 500. Caught my own mistake while writing
      the first test: initially hand-guessed the expected message as the
      schema's custom text (`"description is required"`) instead of
      running it — recomputed directly with `node -e` and found the real
      message for a *missing* field is Zod's own `"Required"` (the custom
      message only fires when the field is present but fails `.min()`,
      confirmed empirically for both the missing-field and
      empty-string cases before finalizing the assertions). Both new tests
      proven against the pre-fix code via `git stash` (2 failures: the raw
      JSON-dump assertion, and 500 instead of 400 on the WhatsApp test).
      Also verified with real `curl` requests against a real built server
      booted in the clean-room worktree, independent of the automated test
      suite. Full suite green (306 tests, up from 304 — `@forge/api` 95 →
      97) + `tsc -b` clean + both builds clean + a from-scratch clean-room
      worktree clone/install/test/build/start cycle with a live
      `/api/health` check plus the two curl checks above.

- [x] **All three Anthropic-backed callers in `packages/spec-engine` had no
      network timeout — a stalled connection would hang them forever.**
      Self-review (`code-review` skill, high effort) of
      `packages/spec-engine/src/promptEnhancer.ts` found
      `AnthropicPromptEnhancer.enhance()` calling `fetchImpl(...)` directly
      with no timeout. Checking the same code shape elsewhere found it
      copied verbatim into `AnthropicSpecProvider.generate()`
      (`anthropic.ts`) and `requestSpecFix` (`debug.ts`) — all three real
      places this package talks to `api.anthropic.com` shared the identical
      gap. If Anthropic's API accepts the TCP connection but never responds
      (a network stall or an upstream hang, not an HTTP error — those were
      already handled), the raw `fetchImpl(...)` call never resolves or
      rejects. For `AnthropicSpecProvider` and `AnthropicPromptEnhancer`
      this silently defeats the fallback-to-heuristic design
      `enhancePrompt`'s own comment documents ("if the real model call
      fails at runtime, fall back to the deterministic heuristic enhancer
      instead of surfacing a raw 500") — a hung call never triggers the
      `catch` block that fallback depends on, so the whole request just
      hangs instead of degrading gracefully. For `requestSpecFix` (the
      Debug Agent pipeline step, which has no offline fallback at all,
      unlike the other two) a hang would freeze the entire multi-agent
      build pipeline indefinitely with no way out — worse than either of
      the other two cases. Fixed by adding a shared `fetchAnthropic()`
      helper (new file `anthropicFetch.ts`) that wraps any `fetchImpl`
      call with a real `AbortController`-based timeout (default 60s,
      injectable per-call via a new `timeoutMs` option added to all three
      callers' existing options interfaces), and wiring all three call
      sites to use it instead of calling `fetchImpl` directly. Also fixed
      a small, unrelated dead-code issue the same review flagged in
      `promptEnhancer.ts`: a field-separator ternary
      (`isHebrew ? ", " : ", "`) whose two branches were byte-for-byte
      identical, which reads as if a language-specific choice had
      deliberately been made when none had — simplified to a plain
      `", "`. New tests: `anthropicFetch.test.ts` covers the shared helper
      directly (resolves normally when `fetchImpl` responds before the
      timeout; rejects with a real, verified abort once the timeout
      elapses, checked by asserting the injected `fetchImpl` actually saw
      its `AbortSignal` fire, not just that the promise rejected; passes a
      genuine `fetchImpl` rejection like a DNS failure through unchanged
      rather than misreporting it as a timeout). One wiring test added to
      each of `anthropic.test.ts`, `debug.test.ts`, and
      `promptEnhancer.test.ts` confirms the timeout is actually reached
      through each real caller, using a `fetchImpl` that only resolves
      once its `AbortSignal` fires (not a `fetchImpl` that never resolves
      at all regardless of the signal, which would just hang the test
      itself instead of proving anything) — plus an end-to-end test that
      `enhancePrompt()` still falls back to the heuristic enhancer when
      the Anthropic call times out, not just on an explicit HTTP error
      response, closing the actual gap in the documented fallback design.
      All 4 new timeout tests proven against the pre-fix code via
      `git stash`: run against a live 20-second wall-clock timeout, they
      hung indefinitely and were cancelled by the test runner as "still
      pending" rather than failing cleanly with an assertion error — which
      is exactly the bug this fixes, not a normal test failure. Also
      manually verified end-to-end with a real `curl` request to
      `POST /api/ideas/enhance` against a real built server booted in the
      clean-room worktree (the heuristic path, since no
      `ANTHROPIC_API_KEY` is configured in this environment), confirming
      the refactored request/response plumbing still works correctly.
      Full suite green (313 tests, up from 306 — `@forge/spec-engine`
      71 → 78) + `tsc -b` clean + both builds clean + a from-scratch
      clean-room worktree clone/install/test/build/start cycle with a
      live `/api/health` check.

- [x] **A real, measurable timing side-channel in login let an attacker
      enumerate registered emails.** Self-review (`code-review` skill, high
      effort) of `apps/api/src/routes/auth.ts` (its first dedicated pass).
      `POST /auth/login` checked `!record || !verifyPassword(...)` —
      JavaScript short-circuit evaluation means `verifyPassword` (whose
      `scryptSync` call is deliberately expensive, by design, to resist
      brute-forcing) was never even called when no user matched the given
      email. So a login attempt for an email that genuinely doesn't exist
      returned almost instantly, while a login for a real email with the
      wrong password paid the full scrypt cost — a reliable, easily
      measured difference an attacker can use to learn which emails are
      registered, without the response body or status code ever differing.
      Confirmed the gap empirically before touching any code: a direct
      microbenchmark showed ~37.5ms average per real `verifyPassword` call
      against ~0ms for skipping it entirely — several orders of magnitude,
      not test noise. Fixed by adding a fixed `DUMMY_PASSWORD_HASH`
      (computed once at module load from random bytes) and always calling
      `verifyPassword` — against the real user's hash when one exists,
      against the dummy hash otherwise — so the expensive scrypt hash runs
      exactly once per login attempt either way, regardless of whether the
      email is registered. New end-to-end test in `app.test.ts`: takes
      several real wall-clock timing samples of both a wrong-password
      login on a real account and a login for a nonexistent email, and
      asserts (a) the nonexistent-email path still takes over 5ms (proving
      the hash actually ran, not just "some work happened") and (b) the
      two paths' median times land within 3x of each other — deliberately
      generous tolerances chosen to stay robust against ordinary
      test-environment jitter, since the real pre-fix gap is closer to
      1000x than a few percent. Proven against the pre-fix code via
      `git stash`: the nonexistent-email path measured 2.03ms, failing the
      5ms floor exactly as predicted. Independently re-verified outside the
      automated suite too, with real `curl` requests (5 samples per path,
      using `curl`'s own `%{time_total}` since `/usr/bin/time` wasn't
      available in this environment) against a real built server booted in
      a clean-room worktree — both paths landed consistently around ~40ms,
      confirming the fix holds against the actual compiled server binary,
      not just the source under `tsx`. Full suite green (314 tests, up
      from 313 — `@forge/api` 97 → 98) + `tsc -b` clean + both builds
      clean + a from-scratch clean-room worktree clone/install/test/
      build/start cycle with a live `/api/health` check plus the curl
      timing checks above. Two related findings from the same review were
      explicitly **not** acted on this round, and are recorded here rather
      than silently dropped: `scryptSync` blocking Node's single event
      loop for the duration of every signup/login (a real concern under
      concurrent load, but a bigger architectural change — switching to
      the async `scrypt` API or a worker thread — that deserves its own
      round rather than being rushed alongside a security fix); and a
      genuinely unreachable 404 branch in `GET /auth/me` (dead code that
      masks the real 401 behavior a reader would expect, not a live bug,
      since `requireAuth`'s own join already guarantees the user exists by
      the time that handler runs).

- [x] **Password hashing blocked Node's single event loop for the
      duration of every signup/login request.** This round tackles the
      first of the two findings round 56 explicitly deferred (see above)
      rather than rushing it in alongside a security fix.
      `hashPassword`/`verifyPassword` called `scryptSync` directly —
      Node has exactly one JS event loop, so every signup/login call
      blocked that one thread for the full tens-of-milliseconds cost of
      the hash before *any* other request, even a totally unrelated
      `/api/projects` route, could be serviced. A burst of concurrent auth
      attempts (legitimate traffic or a trivial DoS) would serialize
      completely behind each other instead of the server handling them in
      parallel. Fixed by switching to the async `crypto.scrypt` (via
      `util.promisify`), which runs the actual hashing work on libuv's
      threadpool instead of the main thread, keeping the event loop free
      to service other requests while a hash computes. Propagated the
      resulting `Promise` through both functions' signatures and their
      three call sites in `routes/auth.ts`: signup, login, and the
      module-level dummy-hash constant round 56 added to close the timing
      side-channel (now a `Promise<string>` computed once at module load
      and lazily awaited on first use, so every login after the first
      reuses the already-resolved value with no extra cost). New test file
      `apps/api/src/auth/password.test.ts`: correctness round-trips
      (hash/verify matches, a wrong password fails, a malformed stored
      hash returns `false` instead of throwing, two hashes of the same
      password get different salts and both still verify), plus two
      directly empirical regression tests for the actual bug — one starts
      a `setInterval(2ms)` alongside a hash computation and asserts it
      keeps ticking throughout (proving the event loop genuinely stayed
      free, not just "the function returned a Promise"), the other runs
      three hashes concurrently via `Promise.all` and asserts the total
      wall time stays close to a single hash's time rather than roughly
      3x as long (proving real parallelism via the threadpool, not
      requests queued one after another behind one blocked thread).
      Verified the measurement technique itself first with a standalone
      `node -e` script before trusting it in the test suite: a comparable
      `scryptSync` call scored exactly 0 event-loop ticks during its
      run, against ~47 ticks for the async version — a stark, reliable
      signal, not test noise. Proven against the pre-fix (`scryptSync`-
      based) code via `git stash`: 3 of the 7 new tests failed exactly as
      predicted (0 ticks measured during the blocking hash, and 3
      concurrent hashes measured at 3.0x a single hash's time instead of
      running in parallel). Also updated two stale comments this fix
      obsoleted — `app.test.ts`'s round-56 timing-test doc comment and
      the dummy-hash doc comment in `routes/auth.ts` — which still named
      the now-removed `scryptSync`/`DUMMY_PASSWORD_HASH` identifiers.
      Independently re-verified end-to-end with real `curl` requests
      (signup, a correct-password login, and a wrong-password login) 
      against a real built server booted in a clean-room worktree,
      confirming the async refactor changed no observable behavior on
      the compiled server binary. Full suite green (321 tests, up from
      314 — `@forge/api` 98 → 105) + `tsc -b` clean + both builds clean +
      a from-scratch clean-room worktree clone/install/test/build/start
      cycle with a live `/api/health` check plus the curl checks above.

- [x] **Closed out the second finding round 56 deferred: the genuinely
      unreachable 404 branch in `GET /auth/me`.** Re-verified the claim
      from scratch rather than trusting the earlier round's note —
      re-read `requireAuth` (`apps/api/src/auth/middleware.ts`) and its
      DB call `getSessionUser`, whose SQL does
      `JOIN users ON users.id = sessions.userId`, and confirmed by
      grepping the whole codebase that no `deleteUser` function (or raw
      `DELETE FROM users`) exists anywhere — a user row, once created,
      is never removed. So `requireAuth` running successfully on a
      request is an unconditional proof the row still exists, and the
      handler's own follow-up `findUserById` lookup could only ever find
      the same row requireAuth had just fetched; the `if (!user) { 404 }`
      branch could never fire. Fixed by having `requireAuth` attach the
      already-fetched `User` object to the request (`req.user`, a new
      optional field alongside the existing `req.userId`) so the handler
      reuses it directly instead of re-querying — removing both the dead
      branch and a redundant DB round-trip on every `/auth/me` call, not
      just a cosmetic deletion. Along the way, noticed `GET /api/auth/me`
      had *zero* test coverage at all (not even a happy-path check), so
      added real E2E tests in `app.test.ts` covering: a valid session
      returns exactly the same user object signup returned; a missing
      Authorization header 401s with `AUTH_REQUIRED`; a garbage token
      401s with `SESSION_EXPIRED`; and a token invalidated by `/logout`
      401s too. This cleanup has no live bug to reproduce pre-fix (same
      category as round 52's `AGENT_ORDER` fix — a type-safety/dead-code
      guard against a scenario that structurally cannot occur given the
      current codebase, not a regression to prove via `git stash`), so
      verification instead focused on (a) proving the "never deleted"
      premise is actually true right now via the codebase-wide grep
      above, not just assumed, and (b) real black-box confirmation the
      observable behavior is unchanged: built the server in a clean-room
      worktree and hit it with real `curl` requests (signup → valid
      token → 200 with the right profile; no header → 401; garbage token
      → 401; token after logout → 401), matching the new tests exactly.
      Full monorepo suite green (322 tests, up from 321 — `@forge/api`
      105 → 106) + both builds clean + a from-scratch clean-room
      worktree clone/install/test/build/start cycle with a live
      `/api/health` check plus the curl checks above.

- [x] **Two entities whose names collide when compared case-insensitively
      (e.g. "Order" and "order") could silently share one SQLite table,
      corrupting data instead of erroring.** Found doing a full,
      whole-file `code-review` pass on `packages/db/src/migrate.ts` —
      this window's own designed fallback task when no other obvious
      candidate exists. Confirmed the actual mechanism directly against
      this project's real SQLite binding rather than assuming from SQLite
      docs alone: `CREATE TABLE IF NOT EXISTS "Order" (...)` followed by
      `CREATE TABLE IF NOT EXISTS "order" (...)` creates exactly *one*
      table and silently no-ops the second statement, because SQLite
      compares identifiers case-insensitively for ASCII even when
      double-quoted, so `IF NOT EXISTS` sees the two names as identical.
      `migrate.ts`'s `tableNameFor` prefixes per-project but never
      normalizes case, and `apps/api/src/codegen.ts` (the exported
      standalone app) uses the entity name directly as the table name
      with the same gap — so two case-colliding entities would silently
      collapse into one physical table, with every read/write meant for
      the "losing" entity actually hitting the "winning" entity's columns
      instead. Nothing in the codebase checked for this anywhere; the
      only defense was luck (the heuristic provider's own fixed 32-entity
      library happens not to contain a collision, verified with a script
      rather than assumed, but an LLM-generated or refined spec has no
      such guarantee). Fixed at the single point every `ProductSpec` is
      already validated — `packages/shared/src/index.ts`'s
      `ProductSpecSchema` — adding a `.refine()` that rejects a spec with
      case-colliding entity names, the exact same pattern and rationale
      as the existing `RESERVED_FIELD_NAMES` check for field names
      colliding with `id`/`createdAt`. A spec that fails this now falls
      back to the heuristic provider instead of ever reaching either
      database layer, matching the established fallback behavior. Traced
      every current caller of `ProductSpecSchema` (heuristic.ts's direct
      `.parse()`, anthropic.ts's and debug.ts's `.safeParse()`, and
      stored-project/checkpoint reads) to confirm all of them already
      re-validate through this one path, so the fix is complete at a
      single site. New tests: two in `spec-engine/src/index.test.ts`
      mirroring the existing reserved-field-name tests exactly (a direct
      rejection with the right message, and an end-to-end fallback to
      heuristic with no colliding names in the result) — proven to fail
      against the pre-fix schema via `git stash` on
      `packages/shared/src/index.ts` alone (both failed as predicted, the
      same-message assertion and the end-to-end fallback check); one in
      `packages/db/src/migrate.test.ts` documenting the actual SQLite
      no-op-second-CREATE-TABLE mechanism this closes off, so a future
      reader of `migrate.ts` sees *why* uniqueness has to be enforced
      upstream rather than assuming migrate.ts is itself safe. Also
      updated the schema's own doc comment, which previously described it
      as strictly "append-only" — noted that closing a real
      data-corruption hole (as this refine and `RESERVED_FIELD_NAMES` both
      do) is the one sanctioned exception, and that `getProject` (unlike
      `listProjectsForOwner`) has no safety net for an old stored spec
      that stops parsing — an accepted, narrow, already-precedented cost.
      Full suite green (325 tests, up from 322 — `@forge/spec-engine` 78 →
      80, `@forge/db` 54 → 55) + both builds clean (including `tsc -b` for
      the web package, confirming the schema change type-checks cleanly
      for every consumer) + a from-scratch clean-room worktree
      clone/install/test/build/start cycle, including a real curl-driven
      signup + `POST /api/projects` request against the built server
      confirming an ordinary, non-colliding description still generates a
      real heuristic spec exactly as before.

- [x] **Full code-review pass on `packages/db/src/checkpoints.ts`** (the
      next never-fully-reviewed core file, after `migrate.ts` in round
      59). The file itself held up well — small, already reasonably
      tested, no real bug found in it directly. But following the review
      one level up into its only caller, the checkpoint-restore route in
      `apps/api/src/routes/projects.ts`, turned up a genuine test-coverage
      gap: the line that actually protects a user from restoring another
      user's checkpoint into their own project —
      `checkpoint.projectId !== project.id` — had zero test coverage
      anywhere (confirmed by grepping the whole suite for
      `CHECKPOINT_NOT_FOUND`: the only occurrence was the route itself).
      This check matters precisely because `requireOwnedProject` alone
      can't catch this case — the attacking user genuinely owns the
      *target* project they're restoring into, just not the checkpoint
      they're supplying — and `getCheckpoint()` deliberately takes no
      `projectId` filter, leaving that cross-check entirely to the
      caller. Added an E2E test: two separate users each build a real
      project, the second user's own restore request against their own
      project is given the first user's real checkpoint id, and must
      404 with `CHECKPOINT_NOT_FOUND` while leaving their project's spec
      completely untouched. Proved the test would actually catch a
      regression, not just document today's behavior: temporarily
      weakened the route's check locally (dropped the `checkpoint.
      projectId !== project.id` half of the condition), reran the suite
      and watched the new test fail exactly as expected, then reverted
      and confirmed via `git diff` that no residual change remained
      before committing — the same discipline as a `git stash` proof,
      just applied to an uncommitted local edit instead of stashed
      source. Also resolved, while reviewing this file, an old
      never-confirmed finding: round 44's suspicion that
      `generateBackupZipEntries` (`apps/api/src/backup.ts`) could produce
      colliding ZIP entry paths for two entities differing only by case
      (it keys each entry as `` `${entity.name}.csv` ``, the same pattern
      as the SQL table names round 59 fixed). Traced every path a
      `ProductSpec` can take before reaching a backup export and
      confirmed it always passes through `ProductSpecSchema` first —
      round 59's entity-name-collision `.refine()` already makes this
      finding structurally impossible now, with no further code change
      needed; noted here rather than filed as still-open. Full suite
      green (326 tests, up from 325 — `@forge/api` 106 → 107) + both
      builds clean + a from-scratch clean-room worktree
      clone/install/test/build cycle.

- [x] **Full code-review pass on `packages/spec-engine/src/heuristic.ts`
      (the last file in this window's "migrate.ts, checkpoints.ts,
      heuristic.ts" list) found a real product-accuracy bug: the
      heuristic provider recommended "No payments" for a donation-only or
      membership/subscription-only description.** `buildOpenQuestions()`
      decides whether to ask about (and recommend) a payment provider two
      ways: a `PAYMENT_KEYWORDS` substring match against the raw
      description, or a hardcoded check for an entity literally named
      `"Invoice"` or `"Order"`. That entity check was never updated when
      the `Donation` (round 64) and `Subscription` (round 61) domain
      entities were added later, and neither entity's own trigger
      keywords in `domainEntities.ts` ("donation", "donor", "nonprofit",
      "fundraising campaign", "member management", "membership plan", …)
      happen to overlap `PAYMENT_KEYWORDS` ("payment", "invoice",
      "billing", "subscription", "checkout", "stripe", …). Confirmed
      empirically with `node -e` before writing anything, not assumed
      from reading the code alone: `"A donation tracking app for a small
      nonprofit, with donor records and fundraising campaigns."` matches
      only the `Donation` entity and got recommended `"No payments"` —
      plainly wrong, since accepting donations is definitionally
      accepting payments. The same gap reproduces for a membership-fee
      description phrased as `"member management"` (no literal
      "subscription"/"billing" substring to catch it either). Fixed by
      replacing the two-name hardcoded check with an explicit
      `BILLING_ENTITY_NAMES` set (`Invoice`, `Order`, `Donation`,
      `Subscription`) checked against the matched entity itself, rather
      than trying to keep `PAYMENT_KEYWORDS` in permanent lockstep with
      every future payment-flavored phrasing `domainEntities.ts` might
      ever gain — the exact drift that caused this bug in the first
      place. Also reviewed, without acting on it: `matchEntities()`
      pushes the *same* `DOMAIN_ENTITY_RULES` entity object reference
      (not a clone) into its result array for non-Hebrew input — a latent
      fragility if a future caller ever mutated a returned entity in
      place, corrupting the shared module-level singleton for every
      future request. Traced both current callers
      (`HeuristicSpecProvider.generate()`, which immediately reconstructs
      everything via `ProductSpecSchema.parse()`, and
      `HeuristicPromptEnhancer.enhance()`, which only reads `label`/
      `name`/`fields`) and confirmed neither mutates — not a live bug
      today, so left as-is rather than adding defensive cloning nothing
      currently needs (same category as round 52's `AGENT_ORDER`
      finding). New regression tests in `heuristic.test.ts` for both
      payment-question gaps, proven to fail against the pre-fix code via
      `git stash` on `heuristic.ts` alone (both failed exactly as
      predicted). Full suite green (328 tests, up from 326 —
      `@forge/spec-engine` 80 → 82) + both builds clean + a from-scratch
      clean-room worktree clone/install/test/build/start cycle, including
      a real curl-driven signup + `POST /api/projects` request against
      the built server confirming the donation description now
      recommends Stripe.

- [x] **Full code-review pass on `packages/db/src/repository.ts`** (the
      generic CRUD core — the data-layer sibling of `migrate.ts`, picked
      since the original three-file list was exhausted last round;
      `codegen.ts` at ~1900 lines was judged too large for one round's
      budget and saved for a narrower future pass). `coerceValue()`
      validates every structured field type — number, relation, boolean,
      enum — except `"date"`, which fell through to the function's
      `default` branch and stored `String(raw)` with zero validation.
      Confirmed empirically with `node -e` before writing anything: a
      required `"date"` field happily accepted the literal string
      `"not-a-real-date-at-all!!"` and stored it verbatim, no error.
      Checked whether the app's own real date-producing paths could ever
      legitimately need a looser format before tightening this — `seed.
      ts`'s own date generator (`toISOString().slice(0, 10)`) and
      `EntityPanel.tsx`'s `<input type="date">` both only ever produce or
      accept the canonical `YYYY-MM-DD` shape, so validating against
      exactly that shape can't break any real caller. Also checked the
      CSV-import client-side validator
      (`apps/web/src/entityFormatting.ts`'s `buildImportRecords`) and
      found the identical gap there too — a date column passes straight
      through unchecked, same as this file did — noted as a related
      follow-up for a future round rather than folded into this one,
      since it's a separate file/layer with its own review budget. Fixed
      by adding a `"date"` case to `coerceValue`'s switch: requires the
      canonical `YYYY-MM-DD` shape and rejects a value that matches that
      shape but isn't a real calendar date (e.g. `"2024-13-45"`,
      `"2024-02-30"`) by round-tripping the parsed year/month/day back
      through `Date.UTC` and checking they match what was typed — JS's
      `Date` constructor silently rolls an out-of-range month/day over
      into a *different*, wrong date instead of rejecting it, so a naive
      "does `new Date(...)` produce `Invalid Date`" check alone would
      have missed exactly that case. New tests in `repository.test.ts`: a
      real date round-trips correctly, a representative set of
      malformed/impossible dates are all rejected with a clear
      `ValidationError`, and an optional unset date field still correctly
      stays `null`. Proven to catch a real regression via `git stash` on
      `repository.ts` alone (the malformed-date test failed against the
      pre-fix code exactly as predicted). Full suite green (331 tests, up
      from 328 — `@forge/db` 55 → 58) + both builds clean + a
      from-scratch clean-room worktree clone/install/test/build/start
      cycle, including real curl requests against the built server on a
      real built beauty-clinic project: a valid `Appointment` date still
      creates a record (`201`), a garbage date is now cleanly rejected
      (`400`, `VALIDATION_ERROR`) instead of silently corrupting the row.

- [x] **Closed the sibling gap round 62 flagged: `apps/web/src/
      entityFormatting.ts`'s CSV-import validator had the identical
      unvalidated-date hole as `repository.ts` did before that round's
      fix.** Every other field type `buildImportRecords()` handles —
      boolean, number, enum — already validates and reports a clear
      per-row error; a date column passed straight through unchecked, the
      one gap left after round 62. With round 62's server-side fix
      already live, an imported bad date no longer corrupts stored data
      (the server now rejects it), but the failure only surfaced later as
      a generic per-row server error after every row had already been
      POSTed, instead of being caught immediately with a message
      consistent with the other field types in this exact function — a
      real UX regression from the pattern this function otherwise
      follows throughout. Confirmed empirically with `node -e` before
      fixing: importing a CSV with `"not-a-real-date-at-all"` in a date
      column produced zero client-side errors. Fixed by adding the
      identical `date` validation `repository.ts` already carries
      (YYYY-MM-DD shape plus a real-calendar-date check via `Date.UTC`
      round-tripping) as a new branch in `buildImportRecords`'s per-field
      loop. Confirmed the existing CSV round-trip test (export →
      `parseCsv` → `buildImportRecords`) already only ever produces
      `YYYY-MM-DD` dates, so this couldn't reject anything the app's own
      export would ever hand back to it. New tests: a date column with a
      mix of malformed/impossible/valid values reports one clear error
      per bad row and keeps only the valid row, and an optional empty
      date cell still correctly becomes `null` rather than being
      rejected. Proven to catch a real regression via `git stash` on
      `entityFormatting.ts` alone. Full suite green (333 tests, up from
      331 — `@forge/web` 84 → 86) + both builds clean + a from-scratch
      clean-room worktree clone/install/test/build cycle.

- [x] **The exported standalone app's own server had the identical
      missing-date-validation gap rounds 62-63 already fixed twice over
      in the live app** — closing out that pattern for a third and final
      layer. The previous round's own stored notes claimed
      `apps/api/src/codegen.ts` had no coercion logic at all for the
      exported app, reasoning that meant a bigger, separate finding was
      worth investigating; that claim turned out to be wrong on actual
      inspection, not just an update to it — `renderServerJs()` embeds
      its own `coerce()` function as a string template (a separate copy
      of the same logic, since the exported app promises zero runtime
      dependency on Forge AI), and it carries the exact same gap: validates
      required/number/relation/boolean/enum but falls through to a bare
      `return String(value)` for `"date"`, storing whatever string a
      client sends with no validation. Fixed by adding a `"date"` branch
      to the `coerce()` template, mirroring `repository.ts`'s
      YYYY-MM-DD-plus-real-calendar-date check exactly. Verified the
      double-backslash escaping needed inside the outer TypeScript
      template literal actually produces a correct
      `` /^(\d{4})-(\d{2})-(\d{2})$/ `` regex in the *generated* output
      before trusting it (printed the real generated `server.js` text and
      read it back), and syntax-checked the generated file with
      `node --check`. New test in `codegen.test.ts` follows this file's
      own established pattern for exercising generated code: generates a
      real project with a date field, spawns the actual generated
      `server.js` as a child process against a real SQLite file, and
      posts real HTTP requests — a valid date creates a record, four
      malformed/impossible dates are all rejected with `400`. Proven to
      catch a real regression via `git stash` on `codegen.ts` alone,
      re-run against the real spawned server each time, not just a check
      of the source text. Full suite green (334 tests, up from 333 —
      `@forge/api` 107 → 108) + both builds clean + a from-scratch
      clean-room worktree clone/install/test/build cycle, plus — since
      this fix lives inside generated *output*, not source the monorepo's
      own server runs — a genuine end-to-end pass through the real
      product feature on top of that: signed up, built a real
      beauty-clinic project, downloaded its actual export ZIP via the
      live API, unzipped it, ran the real downloaded `server.js`, and
      confirmed with `curl` that it accepts a valid date (`201`) and now
      cleanly rejects a garbage one (`400`) — not a simulation of the
      export, the literal file a real user would download and run.

- [x] **Full code-review pass on `apps/api/src/pipeline.ts`** (the
      build/refine agent pipeline) **found the file itself solid — but
      its caller, the `/build` route, had no precondition guard at all**,
      unlike `/refine` right below it. `pipeline.ts`'s own logic held up
      to close reading: the seed step already guards against
      double-seeding via an explicit "is this table actually still
      empty" check (not just "is it new per this diff"), and
      `diffAndMigrate`'s own `IF NOT EXISTS`-based idempotency (rounds
      59-60's territory) means calling the pipeline twice doesn't corrupt
      schema or data. But `POST /projects/:id/build` had no equivalent to
      `/refine`'s own `if (project.status !== "built") throw 409` guard.
      Confirmed the gap empirically end-to-end, not just by reading the
      code: built a real project through the real HTTP API, then called
      `/build` on it a second time — it "succeeded" (`200`) both times,
      and the project ended up with two Time Machine checkpoints both
      labeled "Initial build", with no way to tell them apart or know the
      second one was a redundant re-run rather than a genuine second
      initial build. Fixed by adding the same style of guard `/refine`
      already has: `/build` now rejects with `409 ALREADY_BUILT` once a
      project's status is `"built"`, pointing the caller at `/refine` for
      further changes — symmetric with `/refine`'s existing
      `409 BUILD_REQUIRED` for the opposite precondition. New E2E test in
      `app.test.ts`: builds a project, confirms a second `/build` call
      `409`s with `ALREADY_BUILT`, and confirms exactly one
      "Initial build" checkpoint exists afterward. Proven to catch a real
      regression via `git stash` on `routes/projects.ts` alone. Full
      suite green (335 tests, up from 334 — `@forge/api` 108 → 109) +
      both builds clean + a from-scratch clean-room worktree
      clone/install/test/build/start cycle, including real `curl`
      requests against the built server reproducing the exact scenario
      found empirically: first build `200`, second build `409
      ALREADY_BUILT`, and the checkpoints list containing exactly one
      `"Initial build"` entry.

- [x] **`POST /answers` on an already-built project silently desynced the
      stored spec from the real database, and the very next read against
      the "new" entity it claimed to add threw an uncaught SQL error as a
      raw `500` — a genuine crash, not the cosmetic duplicate-checkpoint
      issue round 65 found next door.** Direct follow-up on this round's
      own suggested lead: check other route pairs for a missing
      precondition guard symmetric to a sibling route's, the same pattern
      that caught `/build`. `/answers` has no such guard at all. Unlike
      `/build` and `/refine`, it never calls the build pipeline — it only
      calls `updateProjectSpec` directly, so it never migrates the SQL
      schema to match whatever new entities or fields the regenerated
      spec adds. That's harmless before the first build (no schema yet to
      fall out of sync with), but confirmed empirically, not just
      reasoned about, that it's a real crash afterward: a script built a
      real project through the real HTTP API, called `/answers` with a
      request that added an "Invoice" entity to the *stored spec*, then
      called `GET .../entities/Invoice` — which threw an uncaught
      `no such table` SQLite error from deep inside `listRecords`,
      surfacing to the client as a bare `500 INTERNAL_ERROR` instead of
      any clean `HttpError`. Fixed by adding the same `409 ALREADY_BUILT`
      guard `/build` now has, pointing the caller at `/refine` instead —
      but placed carefully *after* the route's own
      no-real-answers-submitted no-op early-return, not before it, so a
      harmless post-build call that would change nothing still succeeds
      rather than being needlessly rejected (an existing test already
      covered exactly that no-op case and would have broken with the
      guard placed too early — caught by actually running it, not
      assumed). Also corrected the route's own doc comment, which
      claimed to behave "exactly like Refine does for an already-built
      project" — it doesn't: Refine re-runs the whole pipeline, migration
      included; this route never did. New E2E test in `app.test.ts`:
      builds a project, confirms `/answers` now `409`s with
      `ALREADY_BUILT`, and confirms the stored spec is completely
      unchanged (no ghost `Invoice` entity). Proven to catch a real
      regression via `git stash` on `routes/projects.ts` alone. Full
      suite green (336 tests, up from 335 — `@forge/api` 109 → 110) +
      both builds clean + a from-scratch clean-room worktree
      clone/install/test/build/start cycle, including real `curl`
      requests against the built server reproducing the exact crash
      scenario found empirically — now a clean `409` instead of a `500`,
      with the spec confirmed still listing only the entities that were
      actually built.

- [x] **`PATCH`/`DELETE .../entities/:entityName/:recordId` leaked a raw
      `NaN` into a confusing 404 instead of cleanly rejecting a malformed
      record id.** Continued this round's own "missing symmetric
      precondition guard" investigation into `checkpoints/:id/restore`,
      the full WhatsApp connect/disconnect/send lifecycle (including
      disconnect-before-ever-connecting), and the entity CRUD routes —
      all confirmed correct and already consistently guarded (verified
      with a real running server via a script, not just by reading the
      code), so that specific pattern is now exhausted for this file.
      While checking the entity routes, found a smaller but still real
      gap: both routes do `Number(req.params.recordId)` with no
      validation. A live probe against a real built project confirmed
      `Number("not-a-number")` is `NaN`, and better-sqlite3 binds `NaN`
      as a parameter without throwing — so instead of failing fast, the
      request silently proceeded to a `404` whose message read
      `"Record NaN not found in Customer"`, leaking the raw failed
      coercion into a message meant for end users. Fixed by adding
      `parseRecordId()`, which rejects anything that isn't a plain
      non-negative integer with a clean `400 VALIDATION_ERROR` before it
      ever reaches the database layer. Extended the existing
      acceptance test in `app.test.ts` (rather than adding new `test()`
      blocks) with assertions that both routes now return
      `400`/`VALIDATION_ERROR` for a non-numeric id and that the error
      message never contains `"NaN"`. Proven to catch a real regression
      via `git stash` on `routes/projects.ts` alone (pre-fix: asserted
      `400`, actually got `404`). Full suite green (336 tests, unchanged
      test count since this extended an existing test rather than adding
      new ones) + both builds clean.

- [x] **The exported (downloaded) app's own CSV import silently accepted
      an invalid date, a fourth independent copy of a bug already fixed
      three times over.** Moved on to this round's own next suggested
      target, `apps/api/src/codegen.ts`, per its own note that the
      `routes/projects.ts` precondition-guard pattern is now exhausted.
      Round 62 found and fixed missing date validation in
      `packages/db/src/repository.ts`; round 63 found the identical gap
      independently in `apps/web/src/entityFormatting.ts`'s CSV import;
      round 64 found it a third time in this same `codegen.ts` file's
      own *server-side* `coerce()` (the function the exported app's
      `server.js` runs). This round found a fourth, separate copy: the
      exported app's *client-side* `buildImportRecords()` (generated
      into `EntityView.jsx`), whose own comment claims a CSV row is
      "already validated client-side" before being POSTed — true for
      required/number/enum fields, but a `date` field fell straight
      through to the raw-string default with zero validation. Confirmed
      empirically before writing any fix: generated a real project with
      a date field, extracted the actual generated `buildImportRecords`
      function out of the real `EntityView.jsx` output (not a
      reimplementation) via `new Function(...)`, and ran it against rows
      containing `"2024-13-45"` and `"not-a-date"` — both were accepted
      into `records` with zero entries in `errors`. The malformed value
      would still eventually get rejected by the server's own
      `coerce()` (fixed in round 64), but only after the row-numbered
      client-side error the code already promises was silently skipped.
      Fixed by porting the same `isValidDate`/`DATE_FORMAT` check into
      `buildImportRecords`'s `date` branch. New test in
      `codegen.test.ts` extracts and actually executes the real
      generated `isValidDate`/`matchesImportHeader`/`buildImportRecords`
      functions (the same “run the real generated code” standard the
      round 64 date test uses for the server side) and asserts a valid
      date passes through while `"2024-13-45"` and `"not-a-date"` are
      rejected with row-numbered errors. Proven to catch a real
      regression via `git stash` on `codegen.ts` alone (pre-fix: the
      test's own regex couldn't even find the not-yet-added
      `isValidDate` helper in the generated output). Full suite green
      (337 tests, up from 336 — `@forge/api` 110 → 111) + both builds
      clean.

- [x] **Calendar view silently shifted a record back one calendar day for
      any viewer in a timezone behind UTC (most of the Americas) — a real,
      live bug in both the live-preview app and the exported app, not just
      a divergence between them.** Continued reviewing `codegen.ts`'s
      Kanban/Calendar generated code, one of this round's own suggested
      targets, and found `buildCalendarMonth` (in both
      `apps/web/src/entityFormatting.ts` and its independent copy
      generated into the exported app's `EntityView.jsx`) parsed a stored
      `"YYYY-MM-DD"` date field with `new Date(rawString)`. Per the Date
      Time String Format spec, a date-only string like that parses as
      *UTC* midnight — but the calendar grid's own day cells are built
      with `new Date(year, month, day)`, i.e. *local* midnight, and the
      two are compared with local getters (`getFullYear`/`getMonth`/
      `getDate`). Confirmed empirically before touching any code: ran the
      real `buildCalendarMonth` under `TZ=America/New_York` and watched a
      record stored as `"2026-09-15"` land under September 14 on the
      grid instead of the 15th. The existing test covering this exact
      function ("places a record on the correct calendar day") only ever
      passed because the sandbox/CI environment defaults to UTC, where
      the bug is invisible — a real gap in test-environment coverage, not
      just in the code. Fixed by parsing the `YYYY-MM-DD` components
      directly into a local `Date` (the same construction the grid cells
      already use) instead of handing the raw string to the `Date`
      constructor, in both files independently. New regression tests in
      both `entityFormatting.test.ts` and `codegen.test.ts` (the latter
      extracting and executing the real generated functions, not a
      reimplementation) pin `process.env.TZ` to a behind-UTC zone for the
      assertion and restore it afterward, so they can't leak into other
      tests in the same process. Proven to catch a real regression via
      `git stash` on both source files at once (both new tests failed
      pre-fix). Also ran the *entire* suite once under
      `TZ=America/New_York` as extra scrutiny beyond the normal
      verification bar — everything passed except one unrelated,
      pre-existing test (`formatDateValue formats a valid ISO date per
      locale`) confirmed to fail identically on pre-fix code too;
      left for a future round rather than scope-creeping into this fix.
      Full suite green under the normal (UTC) test environment (339
      tests, up from 337 — `@forge/api` 111 → 112, `@forge/web` 86 → 87)
      + both builds clean.

- [x] **Every plain date field display — not just the Calendar view —
      showed one calendar day earlier than the stored value for a viewer
      behind UTC.** Direct follow-up on round 69's own top candidate: the
      pre-existing `formatDateValue` test failure under
      `TZ=America/New_York` that round left unfixed as out of scope.
      Investigated root cause before touching anything, per the routine's
      own instruction. It turned out to be the identical bug, not a test
      artifact: `formatDateValue` (`apps/web/src/entityFormatting.ts`,
      the function `EntityPanel.tsx` uses to render every date field in
      the main record table) and the exported app's `Cell` component
      (`apps/api/src/codegen.ts`, reused by *its* record table, the
      Kanban board, and global search results) both parsed a stored
      `"YYYY-MM-DD"` value with `new Date(value)` (UTC midnight) and then
      called `toLocaleDateString()`, which renders in the *viewer's
      local* time. Confirmed empirically under `TZ=America/New_York`
      before fixing: `formatDateValue("2026-03-15", "en")` returned
      `"3/14/2026"`. Since this is the exact same root cause as round
      69's Calendar fix, and far more broadly reachable (every date
      field shown anywhere, not just the calendar tab), this was clearly
      worth fixing now rather than deferring again. Fixed by reusing the
      `parseFieldDate` helper round 69 introduced in both files, instead
      of handing the raw string to the `Date` constructor. New tests:
      `entityFormatting.test.ts` pins `process.env.TZ` for the assertion
      (same technique as the Calendar test); `codegen.test.ts` goes a
      step further than a source-text match — it compiles the real
      generated `Cell` component's JSX with `esbuild`'s own `transform`
      (the identical tool this repo's own build already depends on) and
      actually renders it through a minimal JSX-runtime stub, so the test
      exercises the literal code a user's browser would run, not a
      reimplementation. Proven to catch a real regression via `git
      stash` on both source files (both new tests failed pre-fix with
      exactly the `"3/14/2026"` production symptom). Re-ran the entire
      suite under `TZ=America/New_York` one more time as a final check —
      it now passes cleanly end to end, including the test round 69 had
      to leave red. Full suite green under the normal (UTC) environment
      too (341 tests, up from 339 — `@forge/api` 112 → 113, `@forge/web`
      87 → 88) + both builds clean.

- [x] **The exported app's Delete/Duplicate/bulk-Delete/Kanban-move
      actions silently did nothing on a failed request — no error, no
      feedback, just a click that appeared to do nothing.** This round's
      own first candidate (a fresh sweep for any other `new Date(dateField)`
      occurrence of the timezone bug pattern) came back clean: every
      remaining `new Date(...)` call in `apps/web/src` and `apps/api/src`
      either builds a full ISO *instant* (a `createdAt` timestamp, correctly
      displayed in local time) or is calendar-navigation UI state, not a
      stored date field — so that specific bug class is now fully
      exhausted across the codebase. Moved to this round's second
      candidate instead: reviewing `codegen.ts`'s still-unaudited Kanban
      board code. `BoardCard`'s move dropdown turned out simple (no real
      drag-and-drop, just a `<select>`), but comparing its `handleMove`
      handler against the live-preview app's `EntityPanel.tsx` surfaced a
      real, clear divergence: the live app wraps `handleDelete`,
      `handleDuplicate`, `handleBulkDelete`, and `handleMove` in
      `try`/`catch` + `setError`, exactly like this same exported file's
      own `handleSubmit`/`handleImportFile` already do — but all four of
      those exported-app handlers had no error handling at all. A rejected
      `deleteRecord`/`createRecord`/`updateRecord` call (a dropped
      connection, an unexpected server error, a record someone else
      already deleted) became an unhandled promise rejection with zero
      user-visible feedback. Fixed by porting the identical
      `try`/`catch`/`setError(err.message)` pattern from the live app into
      all four handlers. New test extracts the real generated handler
      functions (plus their `pickDisplayField`/`recordDisplayLabel`
      dependencies) from real codegen output and executes them with a
      rejecting mock of the underlying API call, asserting `setError` is
      actually invoked with the rejection's message. Proven to catch a
      real regression via `git stash` on `codegen.ts` alone — pre-fix, the
      test itself threw the unhandled rejection, reproducing the exact
      production failure mode rather than merely failing an assertion.
      Full suite green (342 tests, up from 341 — `@forge/api` 113 → 114)
      + both builds clean.

- [x] **A genuine, direct report from שלומי: the home screen sometimes
      just sits on "חושבים על זה…" (thinking it over…) forever and never
      delivers the built app.** This is the first real user-reported bug
      in this whole project history (every entry above this one was
      self-directed). Asked a quick clarifying question first (where
      exactly it hangs) rather than guessing across the whole app —
      confirmed it's specifically the initial idea-to-project step on the
      home screen. Root cause: `fetchApi` (`apps/web/src/api.ts`) had no
      client-side timeout at all on regular (non-streaming) requests.
      `fetchWithWakeRetry` only retries when `fetchImpl` *throws* — a
      connection-level failure, e.g. Render's free tier refusing a
      connection while cold-starting — but a request whose connection
      succeeds and then simply never gets a response (a stalled upstream
      Anthropic call, or a cold start that happens not to surface as a
      hard connection failure) sails straight through untouched and hangs
      indefinitely, with the UI stuck on that same busy spinner forever.
      Fixed by wrapping `fetchApi`'s request in an `AbortController` with
      a 100-second ceiling — comfortably above the server's own 60s
      Anthropic timeout (`packages/spec-engine/src/anthropicFetch.ts`)
      plus real cold-start latency, but a hard bound, so a hung request
      now fails clearly with an actionable, translated message ("This is
      taking unusually long…") instead of spinning forever. Also fixed
      `fetchWithWakeRetry` itself: it was retrying even when the caller's
      *own* `AbortSignal` had already fired, which is pointless (the
      signal stays aborted, so every retry fails identically) and burned
      through the whole ~49s retry backoff while incorrectly showing the
      "waking up" banner for what wasn't a cold start at all. New
      regression tests: `wakeRetry.test.ts` proves the no-retry-on-abort
      fix directly; `api.test.ts` uses `node:test`'s mock timers plus a
      fake `fetch` that only rejects on abort (never resolving on its own,
      exactly like a stalled call) to prove `fetchApi` actually times out.
      Proven against the pre-fix code by literally hanging the test runner
      itself — the exact real production symptom, not just a failed
      assertion. Verified the fast/happy path is unaffected with a local
      end-to-end smoke test (real signup + create project against a real
      running server, heuristic provider, ~10ms — completely unaffected by
      the new client-side timeout). Full suite green (344 tests, up from
      342 — `@forge/web` 88 → 90) + both builds clean.

- [x] **Round 72 (autonomous): finished exhausting the "compare parallel
      handlers between live app and codegen.ts" investigation, then
      deduplicated a small, real code smell.** With שלומי's real bug fixed
      and no further reply from her yet, resumed the routine's own
      priority-1 candidate: checked the remaining async functions in
      `EntityPanel.tsx`/`EntityView` (`refresh`, `loadRelated`) and the
      `GlobalSearchPanel`/`GlobalSearch` pair (`runSearch`) — every one of
      them already matches between the live app and the exported app, so
      that investigation is now genuinely exhausted for this file pair,
      not just paused. Moved to a smaller, already-flagged candidate:
      `apps/web/src/api.ts`'s `exportProject` and `backupProject` repeated
      the exact same ~15-line request/blob-download sequence (auth header,
      translate an error response, turn the blob into an `<a download>`
      click), differing only in the URL path and the download filename.
      Extracted the shared mechanics into a private `downloadBlob()`
      helper; both public functions are now one-line wrappers around it.
      Pure refactor, no behavior change — no `git stash` proof needed
      (nothing here was broken before), but added real test coverage that
      didn't exist for these two functions at all until now: both entry
      points exercised through the shared helper (right URL requested,
      right filename suffix per function, a translated error surfaced
      without attempting a download on failure), using a minimal fake
      `document` (Node 22 already ships a real global
      `URL.createObjectURL`, just no `document`). Full suite green (347
      tests, up from 344 — `@forge/web` 90 → 93) + both builds clean.

- [x] **Round 73 (genuinely prompted this time — שלומי said "עוד שדרוגים",
      "more upgrades"): closed a long-open, self-identified gap instead of
      starting a fresh hunt from scratch.** Spent a while first on a
      broader search that came up empty: reviewed `twin.ts` (Business
      Twin), `backup.ts`, the auth stack (`users.ts`, `password.ts`,
      `auth/middleware.ts`, `routes/auth.ts`) and every async event
      handler across the whole live web app for missing error handling —
      all already solid, no new findings (the auth stack in particular
      already normalizes email case at the schema layer and defends
      against a login timing side-channel, both clearly deliberate).
      While reading `migrate.ts`, noticed a real but out-of-scope-for-one-
      round design gap: `diffAndMigrate` only ever adds new
      tables/columns — if a refine ever changed an *existing* field's
      type while keeping its name, the SQL column's type never updates to
      match, which SQLite has no native `ALTER COLUMN TYPE` for fixing
      cheaply. Documented rather than fixed (real schema-type migration
      needs a create-new-table-and-copy strategy, a genuine design
      decision, not a mechanical patch — added to the candidates list
      below). Instead closed the ZIP-writer parity gap round 68 had
      already found and explicitly left for "if it's ever worth doing":
      `codegen.ts`'s own embedded `buildZip()` (a necessary copy of
      `zip.ts`, since the exported app has zero runtime dependency on
      this repo) was missing the UTF-8 general-purpose-bit-flag and the
      >65535-entries guard `zip.ts` already has. Still not a live bug
      today (entity names are always ASCII, entity counts are always
      small), but worth keeping the two copies in sync so a future fix to
      `zip.ts` doesn't silently never reach the exported app. New test
      extracts and executes the real generated `buildZip`/`crc32`/
      `CRC_TABLE` and checks it with Python's spec-strict `zipfile`
      module — the same technique `zip.test.ts` already uses for the live
      writer, since the system `unzip` auto-detects UTF-8 regardless of
      the flag and wouldn't catch this. Proven to catch a real regression
      via `git stash` on `codegen.ts` alone: pre-fix, a Hebrew filename
      came back CP437-mangled mojibake through the spec-strict reader.
      Full suite green (348 tests, up from 347 — `@forge/api` 114 → 115)
      + both builds clean.

- [x] **Round 74 (שלומי said "עוד שידרנגים", read as a typo for "עוד
      שדרוגים", "more upgrades"): closed the exact design gap round 73
      had just documented and deliberately left open — made
      `diffAndMigrate`'s silent field-type-change gap visible instead of
      silently invisible.** Spent a first pass reviewing `twin.ts`,
      `backup.ts`, the full auth stack, `anthropic.ts`, `debug.ts`, and
      `promptEnhancer.ts`/`heuristic.ts` again — all confirmed solid, no
      new findings this time (also empirically re-verified, not just
      reasoned through, that `.trim()` already strips a BOM per spec —
      ruled out a hypothesized BOM-in-CSV-header bug). Also revisited the
      long-open accessibility `inert`/`aria-hidden` fix (flagged since
      round 46) and deliberately deferred it again: doing it properly
      needs real DOM-behavior test coverage this project doesn't have
      (confirmed again: no jsdom, no Playwright, `apps/web/src` has zero
      `*.test.tsx` files), and adding a whole new test-infrastructure
      layer is too large a scope change for one round without derailing
      it. Instead scoped down to the smaller, well-tested half of the
      `migrate.ts` gap: rather than attempting the full schema-type-
      migration redesign (still a genuine, separate product/design
      decision about how to handle existing rows that don't cleanly
      convert — SQLite has no cheap `ALTER COLUMN TYPE`), `diffAndMigrate`
      now detects when an existing field's declared type changed (same
      name, different `type`) and returns a `type_changed` entry
      (old/new type) instead of silently skipping it with no signal at
      all. Threaded through `pipeline.ts`'s Database-step success message
      and `BuildProgress.tsx`'s detail view (both languages) so a type
      change that can't be safely auto-converted is at least visible to
      whoever's watching the build, instead of the spec silently claiming
      a type the database doesn't actually have. Proven to catch a real
      regression via `git stash` on `migrate.ts` alone: pre-fix, the new
      test's expected `type_changed` entry came back as an empty array —
      the type change vanished with zero trace. Full suite green (349
      tests, up from 348 — `@forge/db` 58 → 59) + both builds clean.

- [x] **Round 75 (scheduled firing, no new message from שלומי): found a
      real, live bug via a first-ever close read of `EntityPanel.tsx`
      (840 lines, the largest web-package file never individually
      audited — earlier rounds only ever diffed it *against* its
      exported-app twin for parity, never scrutinized on its own).**
      `handleBulkDelete` awaited a bare `Promise.all(ids.map(deleteRecord))`
      inside a try/catch — but `Promise.all` rejects the instant *any one*
      delete rejects, which skipped both `refresh()` and the
      `setSelectedIds(new Set())` cleanup sitting right after it. A single
      failed delete in a multi-record selection (a dropped connection on
      mobile, a record someone else already removed) meant every record
      that DID delete successfully on the server stayed listed, and
      selected, in a now-stale table — invisible data loss the UI
      actively hid, and a retry would then re-attempt deleting records
      that no longer existed. The exact same bug existed in both copies:
      the live-preview `EntityPanel.tsx` and its necessary duplicate
      embedded in `codegen.ts`'s generated `EntityView.jsx` (round 71 had
      added try/catch to both, which papered over the *symptom* — an
      unhandled rejection — without touching the underlying
      `Promise.all` that caused the state loss). Switched both to
      `Promise.allSettled`: every delete's real outcome is checked
      individually, only the ids that genuinely failed stay selected,
      `refresh()` always runs so the table reflects reality regardless of
      outcome, and the error message now distinguishes "every delete in
      the batch failed" (unchanged wording, for parity) from a real
      partial failure (new translated `entity.bulk.partialFailure`
      message, Hebrew + English). Proven independently for both copies
      via `git stash`: pre-fix `EntityPanel.tsx` throws
      `capturedSelectedIds is not iterable` because the cleanup code is
      never reached past the one failure; pre-fix `codegen.ts`'s embedded
      copy fails the identical new test the identical way. New tests
      extract and execute the real handler source (esbuild-stripped
      TypeScript for the live app — the first time this session's
      esbuild-extraction technique has been applied to a live-app file
      rather than only `codegen.ts`'s generated-JS output — and raw
      extraction for the generated JS) with a mock `deleteRecord` that
      fails on exactly one of three selected ids. Full suite green (352
      tests, up from 349 — `@forge/api` 115 → 116, `@forge/web` 93 → 95)
      + both builds clean.

- [x] **Round 76 (scheduled firing, no new message from שלומי): continued
      round 75's newly-proven approach — read a large web file for its
      own logic instead of only comparing it against a twin — this time
      on `WhatsAppPanel.tsx` (363 lines), whose DB/API/UI layers had each
      been built and reviewed piecemeal across rounds 76-88 but never
      read start-to-finish as one piece of client-side logic on its
      own.** Found a real race: `handleDisconnect` deliberately stops
      both polling loops — the fast QR-waiting poll and the slow
      background poll that notices WhatsApp itself dropping the link
      later — *before* awaiting the disconnect request, specifically so a
      status fetch already in flight can't resolve afterward and
      overwrite fresher state (this exact race was already fixed once,
      for reconnects, via `cancelInFlightConnectedCheckRef` — the file's
      own comments document it clearly). That ordering is correct when
      the disconnect request succeeds. But when the request itself fails
      (a network error, an expired session), nothing actually changed
      server-side: the panel was connected before the click, and still
      is. The background connected-poll it had just stopped was never
      resumed on that failure path, silently leaving an otherwise-still-
      connected panel with zero monitoring until the user closes and
      reopens it — the identical "stuck showing Connected with no way to
      confirm it" failure mode the file's own
      `MAX_CONSECUTIVE_CONNECTED_POLL_FAILURES` comment already describes
      fixing for a *different* trigger (a persistently failing poll, not
      a failed manual disconnect). Fixed by capturing whether the panel
      was connected before stopping the polls, and resuming the
      connected-poll in the catch block when it was; a genuinely
      successful disconnect still correctly leaves it stopped, since
      "disconnected" is a terminal state until the user clicks Connect
      again. Regression-proven via `git stash`: pre-fix code fails the
      new "must resume the connected-poll it just stopped" assertion (0
      calls instead of 1). New tests extract and execute the real
      `handleDisconnect` (esbuild-stripped TypeScript, the same technique
      round 75 proved on `EntityPanel.tsx`) with a mock
      `disconnectWhatsApp` that rejects, plus a companion test confirming
      the successful path is unaffected. Full suite green (354 tests, up
      from 352 — `@forge/web` 95 → 97) + both builds clean.

- [x] **Round 77 (scheduled firing, no new message from שלומי): a third
      round in the same vein as 75-76 — full independent reads of files
      never scrutinized on their own, this time `api.ts` (456 lines,
      previously only reviewed in round 72's narrower "dedupe
      `exportProject`/`backupProject`" pass) and `GlobalSearchPanel.tsx`
      (160 lines).** `api.ts` itself checked out clean on this pass — one
      hypothesis (that `fetchApi`'s `REQUEST_TIMEOUT_MS` abort, added in
      round 71 for the home-screen hang, might also cut off the
      multi-minute build/refine SSE stream `streamPipeline` opens through
      the same `fetchApi`) turned out to be unfounded after tracing it
      through: the server (`apps/api/src/routes/projects.ts`) calls
      `res.writeHead()` before the pipeline even starts running, so the
      client's `fetch()` promise — and with it the `clearTimeout` that
      disarms the abort — resolves almost immediately, well before the
      100-second ceiling, leaving the actual multi-minute body read
      unbounded by it. Worth writing down since it looked like a real
      finding until verified against the server route, not just reasoned
      about. `GlobalSearchPanel.tsx` had the same bug class round 75 and
      76 already found twice: `runSearch` awaited a bare
      `Promise.all(entities.map(...))` across every entity in the
      project — one entity's records failing to load (a transient
      network blip, a cold-starting backend) rejected the WHOLE search,
      blanking out results from every OTHER entity that searched
      successfully. A user with, say, 9 working entity tables and 1
      flaky one saw a bare error message instead of the 9 entities' worth
      of results they could otherwise have had. The identical bug existed
      in the embedded duplicate inside `codegen.ts`'s exported
      `GlobalSearch.jsx`. Switched both to `Promise.allSettled`: results
      from every entity that succeeded are shown, and the error message
      distinguishes "every entity's search failed" (unchanged wording,
      for parity) from a genuine partial failure (new translated
      `search.partialFailure` message, Hebrew + English). Regression-
      proven independently for both copies via `git stash`: pre-fix code
      in each fails the new "must still show results from the entities
      that searched successfully" assertion (empty results instead of
      the two that should have shown). New tests extract and execute the
      real `runSearch`/`searchEntity` source (esbuild-stripped TypeScript
      for the live app, raw extraction for the generated JS — same
      techniques rounds 75-76 established). Full suite green (356 tests,
      up from 354 — `@forge/api` 116 → 117, `@forge/web` 97 → 99) + both
      builds clean.

- [x] **Round 78 (scheduled firing, no new message from שלומי): finished
      the `Promise.all` hunt round 77's own notes called for, then found a
      different bug class on the same "read a file's own logic in full"
      approach.** `grep -rn "Promise.all(" apps/web/src apps/api/src`
      turned up exactly two remaining call sites — `EntityPanel.tsx`'s and
      `codegen.ts`'s own `loadRelated` (the relation-field picker's data
      loader) — and both already catch each per-entity failure *inside*
      the `.map()` callback and resolve with a fallback `[name, []]`
      rather than letting the promise reject, so `Promise.all` here can
      never actually reject on a network failure; the hunt is genuinely
      exhausted. Read `routes/auth.ts` + `auth/middleware.ts` (confirmed
      solid again — session expiry is enforced SQL-side via `WHERE
      sessions.expiresAt > ?`, matching round 73's earlier read),
      `AuthScreen.tsx`, `HistoryPanel.tsx`, `BusinessTwinPanel.tsx`, and
      `twin.ts` in full — all came back clean. Then read `App.tsx`'s own
      logic (not just `summarizeRefineImpact`, already tested since an
      earlier round) and found a real, easily reachable bug: the four
      overlay panels (History, Business Twin, WhatsApp, global Search) —
      each a full-screen backdrop — were each opened by setting only
      their own "show" boolean to `true`, with zero regard for whether
      another panel's boolean was already `true`. Clicking "Business
      Twin" while History was already open (or pressing Ctrl+K for search
      while either was open) stacked two full-screen overlays on top of
      each other instead of replacing one with the other — a genuinely
      broken visual state, reachable from the toolbar with no special
      timing needed. Added an `openPanel(panel)` helper that always sets
      exactly one of the four booleans and clears the rest, and routed
      every "open" action (four toolbar buttons plus the Ctrl+K shortcut)
      through it; Escape's existing "close everything" handler needed no
      change. The exported standalone app's `App.jsx` only has the one
      search overlay and no History/Twin/WhatsApp panels at all, so there
      was nothing to stack there and no parity fix was needed.
      Regression-proven via `git stash`: pre-fix `App.tsx` has no
      `openPanel` function at all, so the new test's own extraction
      assertion fails outright before it can even check behavior. The
      test extracts the real function (esbuild-stripped TypeScript, the
      technique rounds 75-77 established) and confirms each of the four
      panel names produces exactly one `true` in the resulting state.
      Full suite green (357 tests, up from 356 — `@forge/web` 99 → 100) +
      both builds clean.

- [x] **Round 79 (scheduled firing, no new message from שלומי): closed
      several more file-level reads (`entityFormatting.ts` in full,
      `domainEntities.ts` structurally, `heuristic.ts`, `anthropic.ts`) —
      all clean, no new findings — then deliberately pivoted to the
      standing, repeatedly-deferred prerequisite: real DOM test
      infrastructure.** `entityFormatting.ts` (605 lines) had never been
      read start-to-finish despite years of piecemeal fixes across many
      rounds — a full read confirmed it's now genuinely solid, nothing
      new. Wrote a structural check script for `domainEntities.ts` (1041
      lines, likewise never read as a whole) verifying every declared
      `entity.name` is unique across all 32 built-in entities, every
      keyword is exclusive to one entity (no cross-entity ambiguity), and
      every enum field's declared values have a matching Hebrew label
      with no stray extras — all passed, zero issues. `heuristic.ts` and
      `anthropic.ts` read clean too. This project has had zero DOM-
      behavior test coverage since it started — every prior TSX-handler
      test (rounds 75-78) worked around that by extracting a plain
      function out of a `.tsx` file and running it via `new Function`
      with mocked dependencies, which proves a function's own logic but
      never actually renders anything, focuses anything, or dispatches a
      real event. `useDialogFocusTrap` — the shared hook behind every
      overlay panel (History, Business Twin, WhatsApp, GlobalSearch) that
      traps Tab, moves focus in on mount, and restores it on unmount — is
      exactly this kind of untestable code, and is also the direct
      prerequisite for the accessibility fix flagged since round 46 and
      deferred every time it came up (round 74 included) specifically for
      lacking this. Added `jsdom` + `@testing-library/react` as
      devDependencies and a real test for `useDialogFocusTrap`, proven
      against actual rendering, actual `document.activeElement`, and
      actual dispatched `KeyboardEvent`s. The test's own `withJsdom()`
      helper swaps jsdom's `window`/`document`/`navigator`/etc. onto the
      Node global scope for one test (the same approach
      jest-environment-jsdom and vitest's jsdom environment use) via
      `Object.defineProperty` rather than plain assignment — Node 22
      defines its own read-only `navigator` global through a getter that
      a bare `globalThis.navigator = ...` throws against — and waits one
      macrotask tick before tearing the globals back down: React
      re-throws any error caught while dispatching a DOM event
      asynchronously via `setTimeout`, so without that wait such a
      re-throw fires after the jsdom globals are already gone, surfacing
      as a bare, misleading "window is not defined" instead of the real
      error (confirmed by triggering exactly that before adding the
      wait). Proved the test catches a real regression, not just "renders
      without crashing": temporarily short-circuited the hook's
      Tab-handling to a no-op, confirmed the test failed with Tab no
      longer wrapping focus around, then restored the original file
      (`git diff` came back empty). This round deliberately stops at the
      infrastructure + one real test — the accessibility fix itself is
      real, separable follow-up work now unblocked for a future round,
      not something to rush into the same one. Full suite green (358
      tests, up from 357 — `@forge/web` 100 → 101) with no stray async
      errors in the full multi-file run, and both builds clean (needed
      `@types/jsdom` to satisfy `tsc -b`, added alongside).

- [x] **Round 80 (scheduled firing, no new message from שלומי): closed the
      accessibility gap flagged since round 46 and repeatedly deferred
      (round 74, round 79) for lacking real DOM test infrastructure —
      round 79 built that infrastructure specifically to unblock this.**
      Every overlay panel (History, Business Twin, WhatsApp,
      GlobalSearch) already traps Tab within itself via
      `useDialogFocusTrap`, but Tab-trapping only blocks *sequential
      keyboard navigation* — it does nothing about a screen reader's own
      virtual cursor (swipe/arrow-key browsing), which ignores tabindex
      and DOM event listeners entirely and could still read and interact
      with content that was only *visually* hidden behind an open
      overlay. Added `domInert.ts`'s
      `hideBackgroundFromAssistiveTech(dialogElement)`: walks from the
      dialog up to (not including) `document.body`, and at every level
      marks each sibling of the current node — everything NOT on the path
      to the dialog — with the real `inert` DOM attribute plus
      `aria-hidden`. React 18.3.1 (this project's version) has no JSX
      `inert` prop (that landed in React 19), so this sets the attribute
      directly via the DOM, the same way any plain-JS dialog library
      would. Returns a cleanup function that restores exactly what it
      changed: an element that already had `inert` set for an unrelated
      reason keeps it, and one with a prior `aria-hidden` value gets that
      value back rather than having the attribute stripped outright.
      Wired into `useDialogFocusTrap` itself so all four panels get this
      for free without each needing its own integration. Confirmed
      empirically before relying on it: jsdom does NOT implement `inert`'s
      actual browser behavior (focus/pointer blocking) — setting
      `el.inert` via the IDL property is a silent no-op in jsdom — so the
      fix and its tests use `setAttribute("inert", "")`/
      `hasAttribute("inert")` throughout, the same content-attribute path
      real browsers use to trigger that behavior via reflection; the
      tests verify the correct attributes land on the correct elements
      and get correctly lifted (the actual bug — content wasn't marked at
      all), honestly not claiming to verify `inert`'s real focus-blocking,
      which no test environment available to this project can currently
      check. Regression-proven via `git stash -u` (`domInert.ts` is a new
      file, so `-u` to include it as untracked): pre-fix code fails both
      the new `domInert.test.ts` assertions and
      `useDialogFocusTrap`'s new integration test ("content behind the
      dialog must be aria-hidden while it's open" — `null !== 'true'`).
      The exported standalone app (`codegen.ts`) has no dialog/focus-trap
      infrastructure at all for its one overlay (global search) — a
      separate, pre-existing gap this round's change doesn't touch or
      worsen. Full suite green (361 tests, up from 358 — `@forge/web`
      101 → 104) with no stray async errors in the full multi-file run,
      and both builds clean.

- [x] **Genuine, direct report from שלומי (with a screenshot): the exact
      "this is taking unusually long" translated error — the message added
      to fix the original home-screen-hang report — was itself now firing
      as a false positive on the enhance-and-build flow.** Root cause: a
      timing-budget mismatch in `fetchApi`'s own `REQUEST_TIMEOUT_MS`
      (100,000ms). That AbortController signal covers the *whole*
      `fetchWithWakeRetry` call, including its own cold-start retry
      backoff sleeps, not just the time spent on the final successful
      attempt — `wakeRetry.ts`'s own comment already documents Render's
      free-tier cold start as "50+ seconds," and its `DEFAULT_DELAYS_MS`
      backoff alone sums to ~49s of that. Once a connection finally
      succeeds, the request still has to complete, and
      `anthropicFetch.ts`'s `ANTHROPIC_REQUEST_TIMEOUT_MS` allows the
      server's own Anthropic call up to 60 more seconds on top. 49s of
      retry backoff + 60s of legitimate Anthropic processing = 109s of
      genuinely possible worst-case latency — already past the 100s
      ceiling that was supposed to be "comfortably above" it. The
      original round's own math (round 71) stated the right intent but
      the number didn't actually account for the retry backoff sharing
      the same clock as the final request's own response time. Raised
      `REQUEST_TIMEOUT_MS` to 180,000ms: the documented 109s worst case
      plus a full extra minute of margin for request/response transfer,
      JSON parsing, and DB writes, rather than shaving it close to the
      theoretical minimum again. Regression-proven via `git stash`: a new
      test (a response landing at 120s — past the OLD ceiling,
      comfortably inside the new one) fails against the pre-fix
      100,000ms value with the *exact same* "taking unusually long"
      error message visible in her screenshot, confirming this reproduces
      her real report rather than a guessed-at cause. The existing
      hang-detection test's mock-timer tick was updated from 100,000 to
      180,000 to match the new ceiling it asserts against. Full suite
      green (362 tests, up from 361 — `@forge/web` 104 → 105) + both
      builds clean. Not yet confirmed by שלומי herself that this
      resolves what she saw — per this Routine's standing rule, if she
      reports it again (or anything else), that becomes the top priority
      for whatever session sees it next, above all autonomous work.

- [x] **Continued round 79's DOM test infrastructure into `AuthScreen.tsx`,
      which had zero test coverage of any kind.** Its own comment explains
      the mode-toggle button stays disabled while a signup/login request
      is in flight, specifically so switching forms mid-request can't let
      that request resolve and silently sign the user in under whichever
      account they were trying to abandon. A plain function-extraction
      test (this project's usual technique for TSX handlers before round
      79) can check that the `disabled` attribute gets set, but can't
      verify the actual contract that matters: a genuinely disabled HTML
      button suppresses its click event entirely per spec, which only a
      real DOM can prove. Renders the real `AuthScreen` wrapped in its
      real `ThemeProvider`/`LanguageProvider`, submits the form with a
      controllable mocked fetch, confirms both the submit and toggle
      buttons are disabled, then confirms clicking the disabled toggle
      button does nothing at all — the heading (driven by mode) stays
      exactly as it was. Chased down a real footgun in this project's own
      `withJsdom()` pattern along the way, worth remembering for future
      test files that reuse it: using `new Promise(() => {})`
      (permanently pending) to simulate an in-flight request leaves TWO
      different things dangling past the end of the test —
      `fetchApi`'s own real `setTimeout(REQUEST_TIMEOUT_MS)`, an active
      OS-level timer never cleared since the fetch it's guarding never
      settles, which alone kept the whole `node:test` process alive for
      the full 3 minutes (confirmed directly: a foreground run with an
      explicit shell-level timeout guard showed the individual tests
      passing in ~150ms while the *process* still hadn't exited 20
      seconds later); and the abandoned `await signup(...)` promise chain
      itself, which `node:test`'s own runner flags on exit ("Promise
      resolution is still pending but the event loop has already
      resolved"). Reaching for `node:test`'s mock timers only traded one
      failure mode for another (the mocked timer needs an explicit tick
      that `withJsdom`'s own real-timer-based macrotask wait can't
      provide without more plumbing). The fix that actually worked: a
      *controllable* mock, resolved explicitly inside `act()` right after
      the assertions that need it still pending, so every async chain the
      test starts actually finishes before the test itself does. This is
      a new test for already-correct existing code, not a bug fix in
      `AuthScreen.tsx` itself — proven meaningful via the same technique
      round 79 established for exactly this case: temporarily removed the
      toggle button's `disabled={busy}`, confirmed the new test failed
      with a precise assertion message, then restored the original file
      (`git diff` came back empty). Full suite green (364 tests, up from
      362 — `@forge/web` 105 → 107) with no stray async errors and a
      clean process exit in the full multi-file run, and both builds
      clean.

- [x] **Fixed a real bug in `BuildProgress.tsx`: the "Build failed" banner
      scanned raw event history instead of each agent's latest status,
      violating `pipeline.ts`'s own documented contract.** `pipeline.ts`'s
      own comment states explicitly that "the UI ... keeps only the
      latest event per agent" — true for the per-row status icons and
      captions (both driven by `latestByAgent`), but not for the banner,
      which used `events.find((e) => e.status === "failed")` against the
      raw, ever-growing array. A Database migration failure that the
      Debug Agent successfully auto-recovers from (`pipeline.ts`'s
      try/catch always falls through to a fresh Database success event
      afterward, whether or not it entered the catch) leaves that earlier
      failed event sitting in `events` forever, so the banner — and its
      Back button, which the JSX renders alongside the rest of the step
      list — stayed up for the entire remainder of a build that was
      actually still running and about to complete successfully. Fixed by
      deriving `failedStep` from `latestByAgent`'s values instead, making
      it consistent with everything else the component renders. Added
      `BuildProgress.test.ts`, this project's first real-DOM test of the
      AI Team build screen: renders the real component through a
      realistic 15-event pipeline sequence (a recovered Database failure
      followed by every remaining agent succeeding through to Forge) and
      a genuine, unrecovered-failure companion case. Regression-proven via
      `git stash`: the new "banner must not show" assertion fails against
      the pre-fix code and passes against the fix; the companion
      unrecovered-failure test passes against both, confirming the fix
      didn't remove real failure detection along with the false positive.
      Two real test-infrastructure footguns surfaced and got fixed (and
      documented as comments in the test file, for future test files that
      touch this component) along the way: a *third*, outer `act()`
      wrapped around `render()` — on top of `@testing-library/react`'s own
      and the test's `runWithEvents` helper's inner one — deadlocks
      React's internal act-scope bookkeeping and hangs the whole
      `node:test` process indefinitely rather than ever completing or
      timing out on its own (caught only because this round's regression
      proof runs under an explicit `timeout 20` shell guard, per round
      81's own lesson); and passing a raw jsdom DOM node directly as
      `assert.equal`'s "actual" value hangs while formatting the failure
      message, since `node:assert`'s `util.inspect()` chokes on a jsdom
      element's huge, circular property graph — fixed by comparing
      booleans (`document.querySelector(...) === null`) instead of the
      raw node. Full suite green (367 tests, up from 364 —
      `@forge/web` 107 → 109) and both builds clean.

- [x] **Added real-DOM board-view coverage for `EntityPanel.tsx`** — the
      other half of the "table/board/calendar views" candidate the
      previous round's `BuildProgress.tsx` fix left open. `EntityPanel.tsx`
      had zero real-DOM render coverage before this: only its
      `handleBulkDelete` handler, via function extraction. `groupByField`
      (`entityFormatting.ts`) carries its own doc comment promising that an
      enum value with zero matching records "still shows as a column
      rather than silently disappearing" — unit-tested in isolation
      already, but never actually exercised through the live component
      tree with a real fetch round trip and a real re-render. Added two
      tests against a real "Deal" entity (a text field + a 3-value
      "status" enum) rendered through the actual `EntityPanel`, backed by
      a mock `fetch` over a real mutable in-memory record store: one
      confirms the board view renders all 3 declared statuses as columns
      even though 2 start with zero records; the other confirms changing a
      card's status `<select>` actually moves that card to its new column
      once the PATCH + `refresh()` round trip settles — a two-phase state
      transition a function-extraction test could check the arguments of
      but never observe reflected back in the live DOM the way a real user
      would see it. This is new coverage for already-correct existing
      code, not a bug fix — proven meaningful the same way this project
      always proves that when there's no old broken behavior to `git
      stash` back to: temporarily made `groupByField` filter out empty
      columns, confirmed both new tests failed with precise assertion
      messages, then restored the original file and confirmed `git diff`
      came back empty. Careful re-reading of `EntityPanel.tsx` and
      `entityFormatting.ts` (both already heavily hardened across many
      earlier rounds — Promise.allSettled, CSV-injection guarding, the
      UTC/local calendar timezone fix) turned up no fresh bug this time;
      documented honestly as coverage-only rather than stretching for a
      finding that wasn't there. No hang under an explicit `timeout 20`
      shell guard; neither of the two act()/assert footguns documented in
      `BuildProgress.test.ts` applied here, since these tests use plain
      `render()` + `fireEvent` + polled ticks with no `act()` of their
      own. Full suite green (369 tests, up from 367 — `@forge/web`
      109 → 111) and both builds clean.

- [x] **Added real-DOM calendar-view coverage for `EntityPanel.tsx`** —
      the last untested piece of "table/board/calendar views", following
      directly on the board-view tests above. `CalendarView`'s own doc
      comment promises two things that were never actually exercised
      through a real render before this: "a '+N more' overflow instead of
      an ever-growing cell", and that clicking a day's record chip opens
      it for editing (`onEdit` wired to `EntityPanel`'s own `startEdit`).
      Added two tests against a real "Appointment" entity (a text field +
      a date field) — one renders 4 records landing on the same real
      calendar day and confirms exactly 3 chips plus a "+1 more" indicator
      render, rather than either silently dropping the 4th record or
      letting the cell grow unbounded; the other clicks a chip and
      confirms the record form is genuinely pre-filled with that record's
      own field values afterward — the same real-click contract this
      session's `AuthScreen`/`BuildProgress`/board-view tests already
      established, applied to the calendar view's one interactive element.
      Regression-proven the same way as the board-view tests: temporarily
      widened the chip slice from 3 to 10 (confirmed the overflow test
      fails — 4 chips instead of 3), separately replaced the `onEdit`
      wiring with a no-op (confirmed the edit test fails via its own
      *bounded* `waitForCondition` timeout, not a hang), then restored the
      original file both times and confirmed `git diff` came back empty.
      With this, all three EntityPanel view modes now have real-DOM
      coverage. Full suite green (371 tests, up from 369 — `@forge/web`
      111 → 113) and both builds clean.

- [x] **Added real-DOM select-all `indeterminate` coverage for
      `EntityPanel.tsx`'s table view.** The table's "select all" header
      checkbox is the one interactive element across all three views
      (table/board/calendar, now all covered) a function-extraction test
      structurally cannot verify: `indeterminate` is a live DOM property
      set imperatively via a ref — there is no `indeterminate` HTML
      attribute, so it never shows up in rendered markup or a component's
      return value. Drove the full selection lifecycle through real
      checkbox clicks: none selected (unchecked, not indeterminate) → 1 of
      3 selected (indeterminate) → all 3 selected (checked, not
      indeterminate) → clicking the header checkbox while fully selected
      deselects everything rather than re-selecting or no-op'ing.
      Regression-proven the same way as this round's other new-coverage
      tests: temporarily hardcoded `el.indeterminate = false`, confirmed
      the test failed at the partial-selection step with a precise
      assertion message, then restored the original file and confirmed
      `git diff` came back empty. Also caught and fixed a footgun in this
      same test's own first draft before it was ever committed or run: an
      early version passed a raw jsdom DOM node directly as `assert.equal`'s
      "actual" value — exactly the pattern documented as a `node:assert`
      hang risk in `BuildProgress.test.ts`'s own comments a few rounds
      back — fixed to compare a boolean instead before ever executing it.
      Full suite green (372 tests, up from 371 — `@forge/web` 113 → 114)
      and both builds clean.

- [x] **Found and fixed a real, previously-latent bug in this project's own
      jsdom test infrastructure — not in any app code — while writing
      `EntityPanel.tsx`'s search-box coverage: every real-DOM test file
      silently couldn't type into a text `<input>`/`<textarea>` at all.**
      `react-dom` computes two module-top-level `var`s exactly once, the
      instant it's first imported: `canUseDOM`
      (`typeof window !== 'undefined' && ...`) and, derived from it,
      `isInputEventSupported`. Neither is ever recomputed. Every jsdom test
      file in this project installs its per-test `window` via
      `Object.defineProperty` from *inside* an async test callback
      (`withJsdom()`), which necessarily runs after the file's own static
      imports — and therefore after `react-dom`'s module evaluation — already
      happened against plain Node.js, where `window` doesn't exist yet. That
      permanently cached `isInputEventSupported = false` for the rest of the
      process, making `react-dom` fall back, for every controlled text
      field in every jsdom test afterward, to its ancient IE-era "input
      event polyfill" path — which calls `activeElement.attachEvent`, an
      IE-only API jsdom has never implemented. Confirmed both failure modes
      empirically while diagnosing this: a hard crash
      ("activeElement.attachEvent is not a function") once the element was
      focused, and a silent no-op (`onChange` simply never firing)
      otherwise — both bounded by this project's own `waitForCondition`
      timeouts, never an outright hang. This went unnoticed until now
      because no earlier jsdom test in this project actually depended on a
      *typed* value reaching React state — `AuthScreen.test.ts`'s own
      email/password `fireEvent.change` calls, for instance, only ever get
      read back via the input's own DOM `.value` (which `fireEvent` sets
      directly regardless of whether React's `onChange` ever ran), and its
      assertions all key off `busy` state set by form *submission*, a
      wholly separate, unaffected event path. Added `jsdomWarmup.ts`: a
      one-time, side-effect-only JSDOM install that must be the first
      import in any real-DOM test file, before anything that transitively
      imports `react-dom`, so its one-time checks see a genuine
      `window`/`document` and cache `true`. Applied it to every existing
      file that renders through `react-dom` (`AuthScreen.test.ts`,
      `BuildProgress.test.ts`, `EntityPanel.test.ts`,
      `useDialogFocusTrap.test.ts`); `domInert.test.ts` renders no React and
      is unaffected, left as-is. Added the two search-box tests this fix
      unblocked: typing a query narrows the board view down to the matching
      cards without losing the view mode or the typed text itself, and a
      query matching nothing shows the "no results" empty state rather than
      an all-empty board (the `visibleRecords.length === 0` branch sits
      above the board/calendar/table branching in `EntityPanel`'s JSX, real
      ordering to get right). Both regression-proven: removing the
      `jsdomWarmup.ts` import made the search test fail cleanly (a bounded
      `waitForCondition` timeout, not a hang); separately, hardcoding the
      empty-state branch's condition to `false` made the companion test
      fail with a precise assertion mismatch. Both reverted afterward,
      `git diff` confirmed empty each time. Full suite green (374 tests, up
      from 372 — `@forge/web` 114 → 116) and both builds clean.

- [x] **Closed the exact gap round 86's `jsdomWarmup.ts` fix identified in
      `AuthScreen.test.ts` itself.** That file's own two pre-existing tests
      type into the email/password fields via `fireEvent.change`, but
      neither ever asserted on anything downstream of it — one only checks
      button-disabled state (driven by `busy`, set on form *submission*, a
      wholly separate event path the onChange bug never touched) and reads
      the input's own DOM `.value` right back (which `fireEvent` sets
      directly regardless of whether React's `onChange` ever actually ran);
      the other never submits at all. Neither test could have caught the
      bug `jsdomWarmup.ts` fixed — exactly why it went unnoticed in this
      file until `EntityPanel.test.ts`'s search-box tests exposed it
      elsewhere. Added a test that captures the mock `fetch`'s request body
      on submit and confirms it contains the *exact* typed email and
      password, verifying the typed values genuinely flow through
      `handleSubmit` into the real `signup()` request rather than sitting
      inert in the input's own DOM node. Regression-proven directly against
      the fix it depends on: temporarily removed
      `import "./jsdomWarmup.js";` and reran just this test — it failed
      with `email: ''` instead of `'dana@example.com'` in the captured
      body, the *exact* failure mode `jsdomWarmup.ts`'s own comment
      describes. Restored afterward, `git diff` confirmed empty. Full suite
      green (375 tests, up from 374 — `@forge/web` 116 → 117) and both
      builds clean.

- [x] **Added real-DOM CSV import coverage for `EntityPanel.tsx`.**
      `entityFormatting.test.ts` already covers `parseCsv`/`buildImportRecords`
      in isolation, but nothing before this exercised `handleImportFile`'s
      actual wiring through a real file upload: a genuine `File` reaching
      `file.text()`, the parsed row genuinely POSTed via `createRecord`,
      and the table genuinely reflecting it afterward — now that
      `jsdomWarmup.ts` (round 86) makes typed/uploaded DOM input reliable,
      CSV import was the natural next real-DOM gap to close. Builds a real
      `File`/CSV via the standard jsdom-file-input technique (`.files` is
      read-only on a real `<input type="file">`, so it's set via
      `Object.defineProperty`, the same way a browser's own file picker
      would populate it) and fires a real "change" event, then confirms
      the imported record both reached the mock server (checked against
      the mutable record store the mock POST writes into) and shows up as
      a real row in the table after the post-import `refresh()`. New
      coverage for already-correct code, not a bug fix —
      `handleImportFile` already used `Promise.allSettled` correctly and
      no fresh defect turned up on inspection. Regression-proven the way
      this session does for coverage-only additions: temporarily removed
      `handleImportFile`'s `await refresh();` call, confirmed the new test
      failed via its own bounded `waitForCondition` timeout (no hang),
      then restored the original file and confirmed `git diff` came back
      empty. Full suite green (376 tests, up from 375 — `@forge/web`
      117 → 118) and both builds clean.

- [x] **Added real-DOM keyboard-navigation coverage for
      `GlobalSearchPanel.tsx`.** `handleInputKeyDown`'s
      ArrowDown/ArrowUp/Enter navigation across result groups had never
      been tested at all — not even via this project's usual
      function-extraction technique, let alone through a real render. A
      good fit for real-DOM coverage specifically: what matters is whether
      the highlighted group's CSS class actually moves on screen and
      whether Enter jumps to whichever group is currently highlighted, not
      just that the underlying index arithmetic is correct in isolation.
      Types a real query, submits the form, waits for two real result
      groups (a "Customer" and an "Order" entity both matching "widget",
      via a mocked `fetch` backing `listRecords`), then fires real
      `keydown` events on the actual input: confirms no group is
      highlighted before any arrow key, `ArrowDown` highlights the first
      group, a second `ArrowDown` moves the highlight to the second,
      `ArrowUp` moves it back, and `Enter` jumps to the currently
      highlighted entity. New coverage for already-correct code, not a bug
      fix — no defect turned up on inspection. Regression-proven the way
      this session does for coverage-only additions: temporarily typo'd
      the `ArrowDown` key check (`"ArrowDownXX"`), confirmed the new test
      failed with a precise assertion message on the first `ArrowDown`
      press, then restored the original file and confirmed `git diff`
      came back empty. Full suite green (377 tests, up from 376 —
      `@forge/web` 118 → 119) and both builds clean. (This round's push to
      `origin` needed 4 retries past a sustained run of GitHub 504s before
      a `git ls-remote` confirmed connectivity had recovered and the push
      finally landed — a transient upstream outage, not anything in this
      repository or this session's own network setup.)

- [x] **Added real-DOM send-test coverage for `WhatsAppPanel.tsx`.**
      `handleSendTest`'s two typed text fields (recipient number, message
      body) had never been exercised through a real render — only
      `handleDisconnect`'s polling-resume logic had function-extraction
      coverage. This is exactly the class of bug round 86's
      `jsdomWarmup.ts` fix addresses. Types a real recipient/message into
      the "connected" state's test-send form, submits it, and confirms the
      *exact* typed values reach the real POST body `sendWhatsAppMessage`
      sends (captured via a mocked `fetch`), not just the inputs' own DOM
      `.value` — then confirms a successful send refreshes the message log
      with the real server response. Regression-proven directly against
      the fix it depends on: temporarily removed
      `import "./jsdomWarmup.js";` and reran just this test — it failed
      with `to: ''` instead of `'972521112233'` in the captured body, the
      same failure mode documented in `jsdomWarmup.ts`'s own comment and
      previously confirmed for `AuthScreen.test.ts`. Restored afterward,
      `git diff` came back empty. Full suite green (378 tests, up from
      377 — `@forge/web` 119 → 120) and both builds clean.

- [x] **Fixed a real bug: sending a WhatsApp test message to a known
      customer's number never matched it, unlike an incoming message.**
      With real-DOM test infrastructure now saturated across every
      React-rendering file, this round pivoted back to reading
      previously-unaudited server code end to end
      (`apps/api/src/pipeline.ts`, `packages/db/src/migrate.ts` +
      `identifiers.ts`, `apps/api/src/codegen.ts`'s CSV/ZIP/calendar
      logic, `packages/spec-engine/src/{heuristic,debug,anthropic,
      promptEnhancer,anthropicFetch,index}.ts`, `apps/api/src/twin.ts`,
      `packages/db/src/repository.ts`, `apps/api/src/whatsapp.ts` +
      `whatsappWeb.ts`) looking for a genuine defect rather than
      generating new coverage. Most of it held up — several files turned
      out to already carry detailed comments documenting edge cases
      (timezone-safe date parsing, CSV formula-injection guarding, the
      additive-only migration's NOT NULL/FK omission, the 60s/180s
      Anthropic-vs-frontend timeout relationship) that had clearly
      already been reasoned through in earlier rounds. The one real gap:
      `POST /projects/:id/integrations/whatsapp/send` (in
      `apps/api/src/routes/projects.ts`) never called
      `findMatchingRecord` (the same phone-number-to-record matcher
      `WhatsAppWebManager.handleIncomingMessages` already uses for
      *incoming* messages) before logging the outgoing message —
      `matchedEntityName`/`matchedRecordId`/`matchedLabel` were always
      `null` for anything sent from the panel's own test-send form. That
      silently broke a promise the UI itself makes:
      `WhatsAppPanel.tsx`'s log rendering
      (`m.matchedLabel ?? (direction === "in" ? fromNumber : toNumber)`)
      is written to expect matching for *both* directions, falling back
      to the raw phone number only when nothing matched — so sending a
      test message to an existing customer's own number always showed
      their bare phone number in the log instead of their name, even
      though the exact same number arriving as an *incoming* message
      would correctly show it. Fixed by calling `findMatchingRecord`
      before `insertWhatsAppMessage` in the `/send` handler, guarded on
      `project.status === "built"` (mirroring
      `handleIncomingMessages`'s own guard) since matching before a
      first build would hit `listRecords`'s "no such table" error —
      there's no real SQL table behind any entity yet at that point.
      Regression-proven with `git stash` on just the route file: a new
      `app.test.ts` case (build a CRM project, insert a Customer record
      with phone `050-123-4567`, connect WhatsApp, send a test message to
      `972501234567`) failed with `matchedEntityName === null` against
      the old handler, then passed once the fix was restored. Full suite
      green (379 tests, up from 378 — `@forge/api` 117 → 118) and both
      builds clean.

- [x] **Fixed a real bug: `HistoryPanel.tsx` let two Time Machine
      restores race each other.** Continuing the same read-the-code
      discipline from the previous round (checkpoint restore/export/
      backup routes in `routes/projects.ts`, `backup.ts`, `zip.ts`,
      `packages/db/src/{checkpoints,projects,users}.ts`,
      `packages/shared/src/index.ts`'s `ProductSpecSchema`), most of it
      held up — the additive-only-migration safety net, the case-
      insensitive entity-name collision guard, and the append-only-schema
      discipline on stored specs are all already exactly as careful as
      earlier rounds' comments describe. `HistoryPanel.tsx` and
      `BusinessTwinPanel.tsx` had never received any test coverage at all
      (not even function-extraction), so this round read both closely —
      `BusinessTwinPanel.tsx` is pure read-only rendering with nothing to
      find, but `HistoryPanel.tsx`'s restore button only disabled the one
      row matching the in-flight `busyId`
      (`disabled={busyId === checkpoint.id}`), leaving every *other*
      checkpoint's restore button clickable while a restore request was
      still pending. Clicking a second checkpoint's button in that window
      fired a second, concurrent `restoreCheckpoint` request — whichever
      response landed last would silently overwrite the other's result via
      `onRestored`, with no error and no visible sign anything had raced.
      Fixed by disabling every restore button while *any* restore is in
      flight (`disabled={busyId !== null}`) — confirmed empirically first,
      with a standalone script, that a disabled button's `fireEvent.click`
      never reaches React's `onClick` in this project's jsdom setup, so
      the fix genuinely prevents the second request rather than just
      hiding a button that still worked underneath. Regression-proven with
      `git stash` on `HistoryPanel.tsx` alone: a new `HistoryPanel.test.ts`
      (the project's first real-DOM coverage for this file) holds the
      first checkpoint's restore request open, clicks the second
      checkpoint's restore button, and asserts the second request never
      fires — failed against the old code (the second request *did* fire)
      and passed once the fix was restored. Also had to guard the test's
      own held-open fetch mock in a `finally` (resolve it if the
      assertions above threw first) to avoid leaking the real, un-mocked
      180s `REQUEST_TIMEOUT_MS` timer `api.ts`'s `request()` starts —
      confirmed by first hitting that exact hang against the old code
      before adding the guard, the same "permanently-pending fetch mock"
      footgun documented from earlier rounds, now also proven from the
      failure side, not just avoided. Full suite green (380 tests, up
      from 379 — `@forge/web` 120 → 121) and both builds clean.

- [x] **Fixed a real bug: `App.tsx` could leave the preview pane blank
      after a refine dropped the active entity.** Third consecutive round
      (91, 92, 93) finding a genuine bug via full-file reading rather than
      generating new coverage for already-correct code. This round read
      `apps/api/src/auth/{middleware,password}.ts` and
      `apps/api/src/routes/auth.ts` (all clean — the timing-attack guard
      on login, the case-insensitive email normalization, and the
      scrypt/timingSafeEqual password verification are all exactly as
      careful as their own comments describe) and `apps/web/src/api.ts`
      (470 lines, also clean) before landing on `App.tsx`, the 637-line
      file that wires every screen together and had never been read as a
      whole. `handleBuildComplete` — the shared completion handler for
      both the very first build and every subsequent refine — set the
      active entity tab with `setActiveEntity((prev) => prev ?? ...)`:
      that only falls back to the rebuilt spec's first entity when `prev`
      was `null` (the first build), so once a tab was ever selected it
      stayed selected across every future refine, unconditionally — even
      when the refine's regenerated spec no longer contains that entity
      at all. A refine instruction like "remove deals tracking, focus on
      invoices" is a perfectly ordinary thing to ask for and a real spec
      provider (see `routes/projects.ts`'s own `/refine` comment) is free
      to actually drop the entity in response — when that happens, the
      preview pane's own `.filter((e) => e.name === activeEntity)` finds
      nothing, so the pane goes blank with no tab visibly selected until
      the user manually clicks another one. This is the *exact* "stale
      activeEntity" failure mode `handleLogout`'s own cleanup in this same
      file already explicitly guards against (its comment describes this
      precise scenario) — just not applied to the refine-completion path
      where it can also happen. Fixed by keeping `prev` only when it's
      still present in the rebuilt spec's entities, falling back to the
      first entity otherwise (matching the very first build's own
      behavior). Regression-proven with `git stash` on `App.tsx` alone:
      extracted the real `handleBuildComplete` via the same
      `esbuild.transformSync` + `new Function` technique this file's own
      `openPanel` test already established, ran it with a previously-
      active entity absent from the rebuilt spec — failed against the old
      code (`'Deal' !== 'Customer'`, stayed on the dropped tab) and passed
      once the fix was restored, while a second case confirmed a
      still-present active entity is correctly kept rather than needlessly
      reset. Full suite green (381 tests, up from 380 — `@forge/web`
      121 → 122) and both builds clean.

- [x] **Fixed a real bug: a denied insurance claim showed the same
      neutral gray status badge as a genuinely undecided one.** Fourth
      consecutive round (91-94) finding a real bug via full-file reading.
      Read `apps/web/src/EntityPanel.tsx` (851 lines, the largest file in
      the web app — clean; the select-all indeterminate checkbox, the
      per-entity remount-via-`key` reset, and the bulk-delete/import
      `Promise.allSettled` handling are all correctly done) end to end,
      then its sibling `apps/web/src/entityFormatting.ts` (605 lines, the
      shared formatting/parsing logic `EntityPanel.tsx` imports from) —
      where `badgeTone` classifies a status enum's value into a badge
      color by matching it against `POSITIVE_WORDS`/`NEGATIVE_WORDS`
      keyword lists. Cross-checked every enum value the built-in domain
      library (`spec-engine/domainEntities.ts`) actually uses against both
      lists rather than only the values the function's own tests already
      covered, and found one real miss: `InsuranceClaim`'s own status enum
      is exactly `["Submitted", "UnderReview", "Approved", "Denied",
      "Paid"]` — `"Approved"` already matched `POSITIVE_WORDS`, but
      `"Denied"` (an equally conclusive outcome sitting right next to it)
      fell through to the same neutral gray as the genuinely undecided
      `"Submitted"`/`"UnderReview"` states, even though its synonym
      `"rejected"` (used by other entities, e.g. `JobApplicant`'s own
      stage enum) was already in `NEGATIVE_WORDS`. `apps/api/src/codegen.ts`
      carries a deliberate duplicate copy of the same `badgeTone` for the
      exported standalone app (this codebase's established "duplicate
      small formatting helpers per surface" pattern) with the identical
      gap. Fixed by adding `"denied"` to `NEGATIVE_WORDS` in both copies.
      Regression-proven with `git stash` on both source files together: a
      new `entityFormatting.test.ts` case failed against the old code
      (`'neutral' !== 'negative'`) and passed once restored, and a
      matching `codegen.test.ts` case extracted and ran the real generated
      `badgeTone` (not a reference reimplementation) to prove the exported
      app gets the identical fix. Full suite green (383 tests, up from
      381 — `@forge/api` 118 → 119, `@forge/web` 122 → 123) and both
      builds clean.

- [x] **Made the exported standalone app installable as a real PWA.**
      Direct request from שלומי — "build a feature Claude doesn't have" —
      clarified (she picked from a short set of concrete options) to: the
      app she builds should install on her phone's home screen like a
      real app, not stay a browser tab. Added the three pieces a browser
      actually checks before offering "Add to Home Screen"/"Install", to
      `apps/api/src/codegen.ts`'s export output:
      `web/public/manifest.json` (name/truncated `short_name`,
      `display: "standalone"` — what actually hides the browser chrome
      once installed — theme/background colors matching the exported
      app's own palette, an SVG icon); `web/public/icon.svg` (a
      single-letter icon from the project name's own first character,
      taken via a code-point-aware iterator so a Hebrew letter or an
      emoji-led name can't split into a broken half-glyph — no
      image-generation dependency needed, keeping this export's "zero
      extra runtime dependency" promise); `web/public/sw.js` (a real
      stale-while-revalidate service worker for static assets, with a
      cached-`index.html` fallback for offline navigation, so a weak
      connection — the other half of what she asked for — still shows
      the last-known UI instantly instead of a blank failed load).
      `/api/*` requests are deliberately never intercepted by the service
      worker: a stale cached response for this app's own live business
      data — today's appointments, a customer list — would be actively
      wrong, not just out of date. `web/index.html` links the manifest
      and icon and sets `theme-color`; `main.jsx` registers the service
      worker only after the app's own first render (never blocks first
      paint) and swallows a failed registration, so a webview with no SW
      support falls back to ordinary always-online behavior instead of
      erroring. These live under `web/public/`, not `web/src/` — Vite's
      default `publicDir` (relative to the `"web"` root `vite.config.js`
      already declares) copies them verbatim into `dist/` at build time,
      landing at exactly the root paths (`/manifest.json`, `/icon.svg`,
      `/sw.js`) `index.html`/`main.jsx` reference. Verified genuinely
      end-to-end, not just via generated-source string matching: one new
      test runs the real generated service worker's `fetch` handler
      against a mocked `self`/`caches`/`fetch` to prove an `/api/`
      request is never intercepted (no `respondWith` call at all) while
      an ordinary static asset request is; another writes the *entire*
      export (not just `server.js`, unlike this file's other spawn-based
      tests) to a real temp directory, runs an actual `vite build` (the
      exact command this export's own `package.json` promises), spawns
      the real `server.js`, and fetches `/manifest.json`, `/icon.svg`,
      and `/sw.js` from it — confirming Vite's `publicDir` convention
      genuinely wires the files through, not just that the generated
      source looks right in isolation. Scoped to the exported/self-hosted
      app specifically, not Forge AI's own shared live-preview `apps/web`
      — that single SPA has no per-project route at all (no
      `react-router`, just client-side view state reset to the home
      screen on load), so a manifest on it could only ever install one
      generic "Forge AI" icon that always opens to the wrong screen,
      never a specific business's own app the way the exported deploy
      genuinely can. Full suite green (390 tests, up from 383 —
      `@forge/api` 119 → 126) and both builds clean.

- [x] **Fixed a real bug: `GlobalSearchPanel.tsx`'s search could show
      stale results from an older, slower query.** Back to the
      full-file-reading discipline (rounds 91-94) after the PWA feature
      request — this round's own note to itself paid off directly: read
      `GlobalSearchPanel.tsx` (172 lines) specifically looking for the
      *same* race-condition class already found and fixed twice this
      session (`HistoryPanel.tsx`'s concurrent restore, `App.tsx`'s stale
      `activeEntity`), and found a third instance. `runSearch` had no
      guard against two overlapping calls: submitting a search, then
      editing the query and submitting again before the first search's
      own network round trip finished — a slow first search, or just an
      impatient double-Enter (Enter falls through to a real form submit
      whenever nothing is highlighted yet, which is the *normal* state
      right after any search completes, since arrow keys are needed to
      highlight a group first) — started a second, independent
      `runSearch` call while the first was still in flight. Nothing
      stopped the first (now-stale) call's own `setResults` from running
      *after* the second (newer) call's `setResults` had already updated
      the screen, silently replacing the correct, current results with
      stale ones for a query the user had already moved past — no error,
      no visible sign anything had raced, just the wrong data on screen.
      Fixed with a request-generation counter (`searchRequestId`, a
      `useRef` bumped once per `runSearch` call): after its own network
      round trip, a call checks whether a newer call has already started
      before applying its results, discarding itself silently if so — the
      exact same shape of fix already used for `HistoryPanel.tsx`'s
      version of this bug. Regression-proven with `git stash` on
      `GlobalSearchPanel.tsx` alone: a new, *deterministic* (not
      timing-based) test using this file's own established
      `esbuild.transformSync` + `new Function` extraction technique holds
      the first search's `listRecords` call open past the second search's
      own completion, then only resolves it afterward — failed against
      the old code (the stale call's `setResults` fired a second time,
      `2 !== 1`) and passed once the fix was restored, alongside a further
      case confirming the fresh results were applied correctly in the
      first place. Full suite green (391 tests, up from 390 —
      `@forge/web` 123 → 124) and both builds clean.

- [x] **Fixed a real bug: `WhatsAppPanel.tsx`'s fast QR-waiting poll had
      no protection against a stale in-flight status check — the same
      race pattern that its own sibling poll, one function away in the
      same file, already guards against.** Sixth consecutive round
      (91-96) finding a genuine bug, and the fourth instance of the exact
      same race-condition class this session keeps finding
      (`HistoryPanel.tsx`'s concurrent restore, `App.tsx`'s stale
      `activeEntity`, `GlobalSearchPanel.tsx`'s stale search) — this time
      inside a file that had *already* fixed this exact problem for one
      of its two polling loops but not the other. `startConnectedPolling`
      (the slow background "is WhatsApp still linked" poll) guards its
      own `getWhatsAppStatus` call with `cancelInFlightConnectedCheckRef`,
      whose own comment spells out precisely why: `clearInterval` only
      stops *future* ticks, so a status fetch already in flight when the
      user disconnects (or reconnects) keeps running and would otherwise
      resolve afterward and overwrite the fresh state with its own stale
      payload. `startPolling` (the fast QR-waiting poll) calls the exact
      same `getWhatsAppStatus`, is stopped by the exact same
      `handleConnect`/`handleDisconnect` call sites — but never got the
      same guard. Without it, a `getWhatsAppStatus` call already in
      flight when `stopPolling()` runs still resolves afterward and calls
      `setStatus` with its now-stale `"connecting"`/`"qr"` payload,
      silently clobbering whatever correct status (e.g. a genuinely
      successful disconnect) was set in the meantime — no error, no
      visible sign anything raced, just the wrong status shown. Fixed
      with the identical `cancelInFlightPollRef` pattern
      `cancelInFlightConnectedCheckRef` already established two functions
      away in this same file. Regression-proven with `git stash` on
      `WhatsAppPanel.tsx` alone: extracted the real `stopPolling` +
      `startPolling` via this file's own established
      `esbuild.transformSync` + `new Function` technique, injected a fake
      `setInterval` to capture the tick callback for manual, synchronous
      control instead of waiting on real 1.5s timers, and a controllable
      `getWhatsAppStatus` mock held open past an external `stopPolling()`
      call — failed against the old code (`setStatus` was called with the
      stale `{status: "qr"}` payload) and passed once the fix was
      restored. Full suite green (392 tests, up from 391 — `@forge/web`
      124 → 125) and both builds clean.

- [x] **Fixed a real bug: the exported app's own `GlobalSearch.jsx`
      (generated by `codegen.ts`) had the exact same stale-search race
      that `GlobalSearchPanel.tsx` — the live-preview component it's a
      deliberate duplicate of — was already fixed for, in round 95.**
      Seventh consecutive round (91-97) finding a genuine bug, and the
      fifth instance of the exact same race-condition class this session
      keeps finding, and the second time (after `WhatsAppPanel.tsx` in
      round 96) it turned up as a fix that had already landed in one copy
      of some logic but not its sibling copy — this time the "sibling"
      is the codegen'd JS string that ships inside every exported app,
      rather than another function in the same file. Went looking
      specifically because `codegen.ts`'s `renderServerJs`/`renderApiJs`/
      `renderAppJsx`/`GlobalSearch` portions run real browser-executing
      JS in the exported app and had never been read line-by-line with
      this exact bug class in mind. `runSearch` in the generated
      `GlobalSearch.jsx` awaited `Promise.allSettled` over every entity's
      `listRecords` call with no guard at all — a second, faster search
      that resolved before a slower first one let the first search's
      late-arriving `setResults` silently clobber the newer, correct
      results on screen, identical to the bug `GlobalSearchPanel.tsx` had
      before round 95's fix. Fixed with the identical `searchRequestId`
      `useRef` pattern: bumped at the start of each `runSearch` call,
      checked immediately after the `Promise.allSettled` await resolves,
      before `setResults` runs. Regression-proven with `git stash` on
      `codegen.ts` alone: a new test extracts the real generated
      `matchesSearch`/`searchEntity`/`runSearch` via `new Function` (the
      file's own established technique) and holds the first search's
      `listRecords` call open past the second search's own completion —
      failed against the old code (`setResults` was called twice, 2 !==
      1, with the stale `fresh-target`-then-`stale-target` order visible
      in the capture) and passed once the fix was restored. Also had to
      fix the query/record text in the new test itself once: the real
      `matchesSearch` does substring matching, so the first attempt's
      query strings ("first query"/"second query") never actually
      matched the mock records — an easy trap when reusing a live-preview
      test's shape against a codegen test that runs the real matching
      logic instead of a mock. Full suite green (393 tests, up from 392
      — `@forge/api` 126 → 127) and both builds clean.

- [x] **Fixed a real bug: `EntityPanel.tsx`'s `refresh()` had no
      protection against two overlapping calls, and it's the single most
      widely-called async function in the component.** Eighth
      consecutive round (91-98) finding a genuine bug, and the sixth
      instance of the exact same race-condition class this session keeps
      finding. `refresh()` is called independently from
      `handleSubmit`, `handleDelete`, `handleDuplicate`,
      `handleBulkDelete`, `handleImportFile`, `handleMove`, and the
      mount/entity-change effect — seven different call sites, any two of
      which can overlap. The easiest real trigger: `handleDuplicate` has
      no confirmation dialog (unlike delete, which the code deliberately
      exempts from confirmation for exactly this reason per its own
      comment), so a user double-clicking "duplicate" on two different
      rows in quick succession starts two overlapping `refresh()` calls.
      Since `refresh()` awaited `listRecords` and called `setRecords`
      unconditionally, if the first (now stale) call's own network round
      trip happened to resolve after the second (newer) call's, its
      `setRecords` silently clobbered the newer, correct table with
      stale data — no error, no visible sign anything raced, just rows
      that were supposed to be there missing (or already-deleted rows
      reappearing) until the next action re-triggered a refresh. Fixed
      with the same `refreshRequestId` `useRef` pattern used everywhere
      else this bug class has turned up: bumped at the start of each
      `refresh()` call, checked immediately after the `listRecords` await
      resolves, before `setRecords`/`setError`/`setLoading` run.
      Regression-proven with `git stash` on `EntityPanel.tsx` alone: a
      new test extracts the real `refresh` function via this file's own
      established `esbuild.transformSync` + `new Function` technique and
      holds the first call's `listRecords` open past the second call's
      own completion — failed against the old code (`setRecords` called
      twice, 2 !== 1) and passed once the fix was restored. Full suite
      green (394 tests, up from 393 — `@forge/web` 125 → 126) and both
      builds clean.

- [x] **Fixed a real bug: the exported app's own `EntityView.jsx`
      (generated by `codegen.ts`) had the exact same `refresh()` race
      that `EntityPanel.tsx` — the live-preview component it's a
      deliberate duplicate of — was just fixed for in round 98.** Ninth
      consecutive round (91-99) finding a genuine bug, and the seventh
      instance of the exact same race-condition class this session keeps
      finding, and the third time it turned up as a fix that had already
      landed in the live-preview copy of some logic but not the codegen'd
      duplicate that ships inside every exported app (after `badgeTone`
      and `GlobalSearch.jsx`'s `runSearch`, round 97). Went looking
      specifically because round 98's own candidate list flagged
      `renderEntityJsx`/`renderAppJsx` as worth checking for exactly this
      duplicate. `EntityView.jsx`'s `refresh()` had the identical shape
      and identical seven call sites as `EntityPanel.tsx`
      (`handleSubmit`/`handleDelete`/`handleDuplicate`/
      `handleBulkDelete`/`handleImportFile`/`handleMove`/the
      mount/entity-change effect) with no guard against two calls
      overlapping — the same real trigger applies: `handleDuplicate` has
      no confirmation dialog, so double-clicking "duplicate" on two rows
      in the exported app starts two overlapping `refresh()` calls, and
      a stale first call resolving after a newer second one silently
      clobbered the correct table with stale data. Fixed with the
      identical `refreshRequestId` `useRef` pattern used in
      `EntityPanel.tsx`. Regression-proven with `git stash` on
      `codegen.ts` alone: a new test extracts the real generated
      `refresh` function via `new Function` and holds the first call's
      `listRecords` open past the second call's own completion — failed
      against the old code (`setRecords` called twice, 2 !== 1) and
      passed once the fix was restored. Full suite green (395 tests, up
      from 394 — `@forge/api` 127 → 128) and both builds clean.

- [x] **Tenth consecutive round (91-100) with a genuine finding — this
      time an honest negative result on the race-condition hunt, plus a
      real, separate test-coverage gap closed.** Systematically checked
      whether the other `useRef` race guards fixed this session
      (`GlobalSearchPanel`'s `searchRequestId`, `WhatsAppPanel`'s
      `cancelInFlight*`, `EntityPanel`'s `refreshRequestId`) had an
      unfixed duplicate in `codegen.ts`: WhatsApp integration and Time
      Machine checkpoints aren't part of the exported app at all (no
      duplicate exists to check), and `App.tsx`'s handlers are already
      guarded by disabled buttons rather than needing a ref (verified
      empirically that every busy-triggering button actually has
      `disabled={busy}`/etc., so the UI itself prevents the overlapping
      calls that made the other cases exploitable). Cross-checked every
      other duplicated helper between the live-preview
      `entityFormatting.ts` and `codegen.ts`'s generated strings —
      `parseCsv`, `buildImportRecords`, `isValidDate`/`isValidDateString`
      (both of codegen.ts's two copies), `compareValues`, `csvEscape`,
      `buildCalendarMonth`/`parseFieldDate` (including its own
      `TZ=America/New_York` regression coverage) — byte-for-byte against
      each other; all matched. Read `migrate.ts` end to end: its one
      known gap (retroactive column type conversion) is already
      correctly surfaced as a reported `type_changed` entry rather than
      silently swallowed, and fixing it for real requires a genuine
      product decision (what happens to existing rows that don't
      cleanly convert) this process isn't positioned to make
      unilaterally — left as-is, consistent with the routine's own
      standing guidance to ask שלומי rather than decide. Reviewed
      `whatsapp.ts`'s `findMatchingRecord` phone-matching logic and
      found a genuine, separate gap: its `shorter`/`longer` ternary swap
      (so matching works regardless of which of the stored vs. incoming
      number happens to normalize longer) had every existing test
      exercise only ONE of its two branches — the reverse direction
      (a stored phone in full international format matched against a
      shorter incoming number) was completely untested, meaning a future
      "simplification" that assumed the incoming number is always the
      longer one (true in every previously-tested case) would have
      silently broken matching with nothing to catch it. Added that
      missing regression test and proved it actually exercises the swap:
      temporarily hardcoded `shorter`/`longer` without the ternary,
      confirmed the new test failed against that broken version, then
      restored the real (already-correct) code and confirmed an empty
      `git diff`. Full suite green (396 tests, up from 395 — `@forge/api`
      128 → 129) and both builds clean.

- [x] **Fixed a real bug: `DATE_FIELD_NAME_HINTS` listed a misspelled,
      permanently-dead hint that never matched any real field in the
      domain library.** Eleventh consecutive round (91-101) with a
      genuine finding, following round 100's own guidance to pivot away
      from the exhausted race-condition vein toward fresh territory —
      found by reviewing `packages/spec-engine/src` fresh (unexamined in
      rounds 91-100) and cross-checking `findDateField`'s hint list
      against every real date-field name actually used across all 32
      entities in `domainEntities.ts`, the same "grep the real domain
      library and check by hand" technique that caught `badgeTone`'s
      missing "denied" value in round 94. Every date field in the domain
      library follows an "XxxDate" naming convention — `startDate`,
      `endDate`, `dueDate`, `shipDate`, and (the one this hint was
      presumably meant to catch) `WorkOrder`'s own `scheduledDate` — but
      the hint list had `"scheduledat"`, which `"scheduledDate"`'s
      lowercased form (`"scheduleddate"`) never matches. This hint was
      silently dead — currently invisible only because `WorkOrder`
      happens to declare exactly one date field, so `findDateField`'s
      fallback-to-first-date-field picks the right one anyway regardless
      of whether the hint matched. Any entity with `scheduledDate`
      alongside a second, less relevant date field (plausible for an
      AI-generated spec, which has no ordering guarantee the built-in
      domain library happens to honor) would silently get the wrong
      field preferred for its calendar view, with no error. Fixed the
      typo (`"scheduledat"` → `"scheduleddate"`) in both the live-preview
      `entityFormatting.ts` and its `codegen.ts` duplicate. Also checked
      the other three hints for the same dormancy: `"appointmentdate"`
      and `"eventdate"` are likewise never matched by any real field
      (`Appointment`/`Event` both just use `"date"`, already the first,
      always-matching hint), so left as harmless, honestly-dead
      placeholders rather than pretending to fix a problem they don't
      actually cause; `"duedate"` does match a real field and was already
      correct. Regression-proven in both files with the deliberate-break
      technique (temporarily reverted each file's own change, confirmed
      the new test failed, restored the fix): a constructed entity with
      `createdNote` (date) declared before `scheduledDate` (date) — the
      old, buggy hint picked `createdNote` (the naive first-field
      fallback); the fixed hint correctly picks `scheduledDate`. Full
      suite green (398 tests, up from 396 — `@forge/web` 126 → 127,
      `@forge/api` 129 → 130) and both builds clean.

- [x] **Added dedicated test coverage for `identifiers.ts`'s SQL-injection
      defense — a genuine, security-relevant gap, not a cosmetic one.**
      Twelfth consecutive round (91-102) with a genuine finding. Cross-
      checked round 101's other two candidates first: `BOARD_FIELD_NAME_HINTS`
      (`["status", "stage"]`) and `DISPLAY_FIELD_NAME_HINTS`
      (`["name", "title"]`) both checked out clean against every real field
      name across all 32 domain-library entities (every multi-enum entity's
      real "status"/"stage" field is correctly preferred over its other
      enum field by the board hint; every entity that has a "name"/"title"
      field already declares it first, so the display hint's fallback
      would pick the same field regardless) — a genuine negative result,
      unlike `DATE_FIELD_NAME_HINTS` in round 101. Pivoted to
      `packages/db/src/identifiers.ts`, whose `assertSafeIdentifier` is
      explicitly documented as this codebase's SQL-injection defense
      ("every identifier that ends up in a raw SQL string must pass
      through this allowlist first") — a genuinely more consequential
      class of file than a cosmetic hint typo. Discovered it had never had
      a dedicated test file: every existing test that touches it (through
      `migrate.test.ts`, `repository.test.ts`, `twin.test.ts`) only ever
      passes well-formed identifiers, so its actual job — rejecting a
      malicious or malformed one — had zero direct proof it works, despite
      the regex itself being correct on inspection. Added
      `packages/db/src/identifiers.test.ts`: acceptance of ordinary
      identifiers, rejection of a SQL-injection payload disguised as a
      field name, rejection of a leading-digit/whitespace/dot/quote-
      character identifier, rejection of an empty string, the error
      message naming both the identifier kind and the actual bad value,
      and `tableNameFor`'s own sanitizing of a malicious `projectId` (the
      one place a value reaches a raw SQL string without being validated
      against a spec first) into safe characters. Regression-proven with
      the deliberate-break technique for already-correct code: temporarily
      made `assertSafeIdentifier` a no-op, confirmed 5 of the 9 new tests
      failed, restored the real code, confirmed an empty `git diff`. Full
      suite green (407 tests, up from 398 — `@forge/db` 59 → 68) and both
      builds clean.

- [x] **Closed a second security-relevant test-coverage gap using the
      same technique as round 102: `getSessionUser` had no test proving
      it actually rejects a genuinely expired session.** Thirteenth
      consecutive round (91-103) with a genuine finding. Grepped the
      whole codebase for "injection"/"XSS"/"sanitiz"/"defense
      against"/"guard against"/"CWE-" comments to find more
      security-documented-but-unproven code the way round 102 found
      `identifiers.ts`; every hit besides `identifiers.ts` itself turned
      out to already be genuinely covered (`backup.ts`'s own `csvEscape`
      copy — the third duplicate of the CSV/formula-injection guard,
      alongside `entityFormatting.ts`'s and `codegen.ts`'s — already had
      a real end-to-end test through `generateBackupZipEntries`;
      `migrate.ts` already has dedicated identifier-sanitizing tests).
      Pivoted to auth/session code instead and found the real gap:
      `getSessionUser`'s SQL filters on `sessions.expiresAt > ?` — the
      actual boundary `requireAuth` (`apps/api/src/auth/middleware.ts`)
      depends on to reject a stale session — but every existing test that
      calls it (`users.test.ts`, `app.test.ts`'s HTTP-level auth tests)
      only ever passes a token that's still valid, was never created (a
      "garbage" string), or was already deleted by logout. None of those
      exercise a session row that genuinely *exists* in the table with a
      real, already-past `expiresAt`, the one case that specifically
      proves the expiry comparison itself works rather than some other
      rejection path (missing row, deleted row). A prior round
      (documented earlier in this file) added the first direct tests for
      this module at all, but even that round's coverage stopped short of
      this specific case. Added the missing test to
      `packages/db/src/users.test.ts`, inserting the session row directly
      (bypassing `createSession`'s own opportunistic pruning, so the row
      is still present when `getSessionUser` runs) and asserting the row
      exists before asserting it's rejected, so the test can't pass for
      the wrong reason. Regression-proven with the deliberate-break
      technique: temporarily dropped the `AND sessions.expiresAt > ?`
      clause from the query, confirmed the new test failed (an expired
      session authenticated successfully — a real, if temporary, auth
      bypass), restored the real query, confirmed an empty `git diff`.
      Full suite green (408 tests, up from 407 — `@forge/db` 68 → 69) and
      both builds clean.

- [x] **Fourteenth consecutive round (91-104) — the most extensive honest
      negative-result sweep yet, closing with one small but genuine
      coverage gap in `formatValidationError`.** Followed round 103's own
      candidate list into the authorization/ownership area and found the
      codebase already extremely well covered there: `requireOwnedProject`
      is the single choke point every one of `routes/projects.ts`'s 22
      routes goes through (confirmed by counting route registrations
      against call sites), a dedicated test already proves a second user
      gets a 404 (not a leaky 403) on another user's project, and a
      second, more sophisticated test already proves a user can't restore
      another user's checkpoint by reusing its id even into a project
      they genuinely own — exactly the class of bug this technique has
      caught elsewhere this session. Entity records turned out structurally
      immune to that same class (each project+entity pair gets its own
      SQL table via `tableNameFor`, not a shared table filtered by a
      foreign key, so there's no id to cross-reuse). Checked
      `extractBearerToken`'s case-insensitivity (already tested),
      login's timing-attack mitigation against email enumeration (already
      has a real multi-sample timing test), and WhatsApp message-log
      cross-project isolation (already tested) — all genuinely solid.
      Swept the whole `spec-engine` AI-provider layer (`anthropic.ts`,
      `debug.ts`, `promptEnhancer.ts`, `anthropicFetch.ts`, `index.ts`)
      end to end: every error path (timeout, refusal, truncation vs.
      malformed JSON, schema mismatch, fenced/unfenced/prose-wrapped
      responses, SQLite-reserved-keyword and case-collision entity/field
      names) already has dedicated tests, including the specific
      fallback-still-fails-when-heuristic-also-fails edge case. Also
      re-verified `zip.ts`: real `unzip -t` integrity checks, a
      spec-strict Python `zipfile` cross-check for the UTF-8 filename
      flag, and the already-fixed >65535-entries Zip64 guard. Closed with
      one genuine, if modest, gap that technique did surface:
      `formatValidationError` (shared by every route's 400 response) had
      no direct unit test anywhere — every existing test exercises it
      only through an HTTP round-trip and checks that a single expected
      issue's message appears somewhere in the response, never that
      *every* simultaneous issue survives the join, in order, separated
      by `"; "`. Added `apps/api/src/httpError.test.ts`. Regression-proven
      with the deliberate-break technique: temporarily changed the
      function to return only `issues[0]?.message`, confirmed exactly the
      multi-issue test failed (single-issue and JSON-dump-prevention
      tests still passed, correctly narrowing the failure to the join
      behavior specifically), restored the real code, confirmed an empty
      `git diff`. Full suite green (412 tests, up from 408 — `@forge/api`
      130 → 134) and both builds clean.

- [x] **Fifteenth consecutive round (91-105) — `packages/db/src/seed.ts`
      turned out already excellently covered; found the real gap one
      layer up, in the route that calls it.** Read `seed.ts` seriously for
      the first time this session (flagged as never examined across 14
      rounds), expecting to find something — instead found 20 existing
      tests in `seed.test.ts` covering every domain entity's believable
      values, the `rating` 1-5 domain clamp, and (already fixed in a much
      earlier round, with its own regression test) the exact
      `startDate`/`endDate` same-day collision bug this technique is
      built to catch. Cross-checked the `/end/i` field-name regex against
      every real date-field name across all entities in
      `domainEntities.ts` for a false-positive match (the same
      hint-list-vs-real-data technique that caught `DATE_FIELD_NAME_HINTS`
      in an earlier round) — none exists today. An honest negative result.
      Moved one layer up to `apps/api/src/routes/projects.ts`'s
      `deriveName` (picks a new project's display name from its
      description when the client doesn't supply an explicit `name`) and
      found it was *never* exercised by any test at all — every existing
      project-creation test either passes an explicit `name` or a normal
      multi-word description and never once reads back `project.name`.
      Two real, distinct branches were completely uncovered: the 6-word
      truncation, and the `"Untitled Project"` fallback for a description
      that's non-empty by character count (passing the API's own
      `z.string().min(1)` check, which counts *before* trimming) but
      whitespace-only, so it trims to zero words. Exported `deriveName`
      and added `apps/api/src/routes/projects.test.ts` with 5 direct unit
      tests. Regression-proven with the deliberate-break technique:
      temporarily removed the `words.length > 0 ?` fallback ternary so
      the function always returned (possibly empty) `words`, confirmed
      exactly the two whitespace/empty-input tests failed while the
      truncation and normal-input tests still passed, restored the real
      code, confirmed the only surviving diff was the intentional `export`
      keyword and its one-line doc comment. Full suite green (417 tests,
      up from 412 — `@forge/api` 134 → 139) and both builds clean.

- [x] **Sixteenth consecutive round (91-106) — found and fixed a genuine
      server-side race condition: concurrent /build or /refine calls on
      the same project silently overwrite each other's spec changes.**
      Followed round 105's own candidate list into `apps/api/src/routes/
      projects.ts`'s `/build` and `/refine` handlers, this time hunting
      for real shared-state races (not React `setState`, the family this
      session exhausted in rounds 91-100 — see roadmap). Both routes read
      `project.spec` once at request start, then spend real async time
      (a spec-generation call, then a migration) before writing it back
      via `updateProjectSpec`. Two such requests for the *same* project
      running concurrently — a double-click, or two open tabs — each
      still work from the spec that was current when *they* started, so
      whichever finishes last silently overwrites `project.spec` with its
      own result: the other request's migration already ran against the
      DB (additive-only, so the table/columns genuinely exist), but
      nothing in the now-overwritten spec points at it any more, so the
      API can no longer see or write to it through the normal entity
      routes. No existing test exercised two genuinely concurrent
      requests to the same project at all. Fixed with an in-memory
      `Set<projectId>` tracking active pipelines, rejecting a second
      concurrent build/refine with `409 PIPELINE_IN_PROGRESS` — mirroring
      the existing `ALREADY_BUILT`/`BUILD_REQUIRED` guards already on
      these same routes. Proven with a real two-HTTP-request test in
      `app.test.ts`: a gated `SpecProvider` test double blocks its first
      post-arm `generate()` call on a manually-released gate (any later
      call passes straight through, so a missing guard can't leave both
      requests deadlocked on the same gate) — this deterministically
      holds refine A open while refine B fires, without any timing-based
      `setTimeout` race. Regression-proven with the deliberate-break
      technique: removed just the `/refine` guard check, confirmed the
      test now fails (B gets a real 200 SSE stream instead of 409, so
      `.json()` on it throws a clean `SyntaxError` — the intended
      failure signature), restored the guard, confirmed the test passes
      again. While building this test, `withServer`'s own teardown
      turned out to have an unrelated but real bug of its own: two
      concurrent fetches to the same test server can leave an idle
      keep-alive socket open, and `server.close()`'s callback doesn't
      fire until every open connection closes on its own — so a failed
      assertion could leave the whole test run hanging on a multi-minute
      keep-alive timeout instead of failing fast. Fixed by calling
      `server.closeAllConnections()` before `server.close()` in
      `withServer`'s `finally`, benefiting every current and future test
      that touches this helper, not just this one. Full suite green (418
      tests, up from 417 — `@forge/api` 139 → 140) and both builds clean.

- [x] **Seventeenth consecutive round (91-107) — extended round 106's
      concurrent-pipeline guard to `/answers`, the one route that had the
      exact same race and wasn't covered.** Directly followed round 106's
      own candidate list back into `apps/api/src/routes/projects.ts`,
      this time auditing every other route for the same "read
      `project.spec`, await something, write `project.spec`" shape that
      made `/build` and `/refine` racy. `/checkpoints/:id/restore` turned
      out to be immune structurally, not by luck: `getCheckpoint`,
      `diffAndMigrate`, and `updateProjectSpec` are all synchronous SQLite
      calls with no `await` in between, so a single request runs to
      completion in one JS turn — there's no window for another request
      to interleave. `/answers`, though, has *exactly* round 106's shape:
      reads `project.spec` (via `project.description` and the
      not-yet-built check), awaits `generateSpec`, then calls
      `updateProjectSpec` — and critically, it was never added to round
      106's `activePipelines` guard, so two concurrent `/answers` calls
      (or an `/answers` racing a `/refine`/`/build`) on the same
      not-yet-built project could still silently race: whichever finishes
      last overwrites `project.spec`, and since `/answers` never migrates
      the DB at all, the loser's answers don't even leave a trace of a
      migrated-but-orphaned table behind — they just vanish outright.
      Extended the existing `activePipelines` guard to cover `/answers`
      too, so all three routes now share one lock per project id. Proven
      with the identical gated-`SpecProvider` two-HTTP-request technique
      from round 106, adapted for `/answers`' schema (`additionalRequest`
      text instead of an `instruction`). Regression-proven with the
      deliberate-break technique: removed just the new `/answers` guard
      check, confirmed the test failed cleanly and fast (200 instead of
      409, no hang — `withServer`'s round-106 `closeAllConnections()` fix
      keeps this kind of test's failure path fast for any future test of
      this shape too), restored the guard, confirmed the test passes
      again and the rest of the file (including round 106's own
      `/refine` concurrency test) still passes unchanged. Full suite
      green (419 tests, up from 418 — `@forge/api` 140 → 141) and both
      builds clean.

- [x] **Eighteenth consecutive round (91-108) — `whatsappWeb.ts`'s
      connect/disconnect races turned out already exhaustively covered;
      confirmed and directly tested a genuinely different one in
      `auth.ts`'s signup.** Read `apps/api/src/whatsappWeb.ts` (round
      107's top candidate) looking for an uncovered connect()/disconnect()
      race, and found the opposite of a gap: `WhatsAppWebManager` already
      documents and handles this exact class of bug in its own code
      comments (a `pendingCleanup` map so a fresh `connect()` waits out a
      disconnect's still-running auth-dir deletion instead of racing it;
      an identity check after `createSocket()` resolves that detects a
      concurrent disconnect replaced the session mid-flight and logs out
      the now-orphaned socket instead of leaking it) — and both scenarios
      already have dedicated tests that hold a fake `createSocket`/
      `removeAuthDir` open with a manually-released promise to force the
      exact interleaving, not just sequential calls. An honest negative
      result: this file has had more race-condition attention than
      almost anything else in the codebase. Pivoted to round 108's
      candidate #2: `auth.ts`'s signup, whose only `await` (`hashPassword`)
      happens *before* `createUser`'s SELECT-then-INSERT duplicate-email
      check — is there a window for two concurrent signups with the same
      email to both get through? Traced it down to `packages/db/src/
      connection.ts`: this project uses `node:sqlite`'s synchronous
      `DatabaseSync`, so `createUser`'s check-then-write is one atomic JS
      turn nothing else can interleave into — genuinely safe by
      construction, the same structural-immunity shape as round 107's
      `/checkpoints/:id/restore` finding. Unlike that finding, though,
      this one had never been directly exercised at all: the existing
      "rejects a duplicate email" test only ever sends the second signup
      strictly after the first fully completes. Added a real two-HTTP-
      request test firing both signups via `Promise.all` — no artificial
      gate needed, since `hashPassword`'s `scrypt` call is genuinely
      offloaded to libuv's threadpool (see `auth/password.ts`'s own
      comment), so real overlap happens naturally; ran it 5x to confirm
      it isn't flaky. Regression-proven with the deliberate-break
      technique on the pre-existing, already-correct `createUser`:
      temporarily removed its duplicate-email SELECT check, confirmed the
      new test caught the resulting raw `UNIQUE constraint failed` 500
      (instead of the clean 409 `EMAIL_TAKEN` production code always
      returns), restored the original function, confirmed an empty
      `git diff` on `users.ts`. Full suite green (420 tests, up from 419
      — `@forge/api` 141 → 142) and both builds clean.

- [x] **Real production incident, reported live by שלומי: "לא מצליח ליישם
      בקשה, רושם שגיאה שרת עמוס" ("can't get a request through, shows a
      'server busy' error") — a direct consequence of this session's own
      round 106-107 work, found and fixed the same session.** The new
      `PIPELINE_IN_PROGRESS` code (added in round 106 to guard concurrent
      `/build`/`/refine`/`/answers` calls) and the pre-existing
      `ALREADY_BUILT` code both had **no entry at all** in
      `apps/web/src/i18n/language.ts`'s translation dictionary —
      `resolveErrorMessage` silently falls back to the raw English
      `error` string for any unrecognized code, so on her Hebrew-first
      UI she saw untranslated English text instead of a real message,
      which she reasonably paraphrased as "the server is busy." Traced
      by grepping every actual `new HttpError(status, message, "CODE")`
      call site across `apps/api/src` and diffing against the
      dictionary: `ALREADY_BUILT`, `PIPELINE_IN_PROGRESS`, and (less
      urgently, since it already has a translation) `WHATSAPP_NOT_CONNECTED`
      were all missing from the *test's* hand-maintained `knownCodes`
      list too — meaning `language.test.ts`'s own "every HttpError code
      has a translation" test had already silently drifted out of sync
      with reality, which is exactly how this shipped undetected.
      Added Hebrew and English translations for both codes. Root-caused
      the test itself, not just patched the symptom: replaced the
      hardcoded `knownCodes` array with `findThrownHttpErrorCodes()`, a
      real scan of every `.ts` file under `apps/api/src` for
      `new HttpError(...)` call sites via regex, so any *future*
      untranslated code fails this test loudly instead of reaching a
      real user silently. Regression-proven twice: (1) the scan's own
      regex first failed on `ALREADY_BUILT` specifically, because its
      message text ("...already built; use refine...") contains a
      semicolon that an earlier, over-narrow `[^;]*?` pattern couldn't
      cross — fixed to `[\s\S]*?`, verified against a dedicated sanity
      test that asserts the scan actually finds all 5 real known codes;
      (2) with the scan working, temporarily removed the two new
      translation entries, confirmed the coverage test failed exactly as
      it should have when this bug first shipped, restored them. Pushed
      immediately as a live-incident fix (not queued for the next
      scheduled round) since שלומי was actively blocked. Full suite
      green (421 tests, up from 420 — `@forge/web` 127 → 128, net +1
      after replacing one test with two) and both builds clean.

- [x] **Also that round: שלומי sent a second real message showing the
      cold-start "waking up" screen with visible frustration ("זה מה
      שאתה יוצר!!!!"). Traced to `render.yaml`'s `plan: free` — Render's
      free tier sleeps after ~15 minutes idle and takes up to a minute to
      wake, and the "waking up" UI is deliberate (task #46) so the app
      doesn't look stuck, not a bug. Explained this honestly and offered
      three real options (paid Render plan for always-on; a self-ping
      keep-alive with an explicit tradeoff disclosed — it consumes
      Render's shared free-tier compute-hour quota and isn't a 100%
      guarantee against sleeping; or leave it as-is) and asked which she
      wants, rather than unilaterally spending her money or her account's
      free-tier hours on her behalf. No answer yet as of this entry — the
      standing instruction is that her next message on this is the
      absolute top priority the moment it arrives.**

- [x] **Nineteenth consecutive round (91-109) — entities CRUD's
      updateRecord race turned out already safe by construction, same as
      round 107/108's findings, and is now directly proven by a real
      test.** Followed round 108's own candidate list into
      `packages/db/src/repository.ts`. `insertRecord` and `deleteRecord`
      are plain single-statement operations with nothing to race.
      `updateRecord` does have the read-then-write shape round 106 had
      to guard for `project.spec` (`getRecord`, merge the caller's
      partial `data` into it, write the merged row back) — but confirmed,
      the same way round 107 confirmed `/checkpoints/:id/restore` and
      round 108 confirmed `auth.ts`'s signup, that every step here (both
      inside `updateRecord` and in the PATCH route handler wrapping it)
      is synchronous `node:sqlite` with zero `await` in between, so two
      concurrent PATCH requests can't actually interleave: whichever
      handler's JS turn runs second reads the first's already-committed
      write and merges correctly on top of it. Never directly exercised
      though — every existing CRUD test only PATCHes sequentially. Added
      a real two-concurrent-HTTP-request test (`Promise.all`, no
      artificial gate needed) proving two concurrent PATCHes to the same
      record, touching different fields, both survive without either
      clobbering the other back to a stale value. Regression-proven with
      the deliberate-break technique on the pre-existing, already-correct
      `updateRecord`: temporarily replaced its `{ ...existing, ...data }`
      merge with `{ ...data }` alone, confirmed the test caught the
      resulting 400 (the required `name` field vanished on the request
      that only touched `status`), restored the original code, confirmed
      an empty `git diff` on `repository.ts`. Full suite green (422
      tests, up from 421 — `@forge/api` 142 → 143) and both builds
      clean.

- [x] **Twentieth consecutive round (91-110) — `packages/shared` had no
      test infrastructure at all, and its own core validation had never
      been directly exercised anywhere.** Followed round 109's own
      candidate list into `packages/shared/src/index.ts`, never examined
      this session. Found two compounding gaps: (1) the package's own
      `package.json` had no `"test"` script and didn't even declare
      `zod` as a dependency despite it being the package's entire
      implementation — it only resolved via npm workspace hoisting —
      which meant this package was silently skipped by every
      `npm run test --workspaces --if-present` run across the whole
      session, invisible unless someone opened the directory directly;
      (2) `FieldSchema`'s two `.refine()` checks (an `enum` field must
      declare `enumValues`, a `relation` field must declare
      `relationTo`) had never been exercised by any test in the
      codebase, not even indirectly — every existing fixture using an
      enum/relation field, across `packages/db`, `apps/api`, and
      `apps/web`, already supplies valid `enumValues`/`relationTo`,
      since those fixtures exist to test unrelated behavior. Fixed the
      package infrastructure (added the `"test"` script and the missing
      `zod`/`tsx`/`typescript`/`@types/node` entries, matching every
      sibling package's `package.json` shape) and added
      `packages/shared/src/index.test.ts`, this package's first-ever
      test file: both refine rejections, `RESERVED_FIELD_NAMES` for
      both "id" and "createdAt" across several case variants (previously
      only "createdAt" was exercised anywhere, and only indirectly
      through an `AnthropicSpecProvider` test), the entity-name
      case-collision refine, and a couple of the plain schema shape
      checks. Regression-proven with the deliberate-break technique on
      the pre-existing, already-correct enum refine: temporarily
      replaced its predicate with `() => true`, confirmed exactly the
      two enum-rejection tests failed while the other nine passed,
      restored the original code, confirmed an empty `git diff` on
      `index.ts`. Full suite green (433 tests, up from 422 —
      `@forge/shared` now runs as its own workspace for the first time,
      contributing 11) and both builds clean.

- [x] **Twenty-first consecutive round (91-111) — round 110's own fix
      turned out incomplete: the root `npm test` command still silently
      skipped `@forge/shared`.** Followed round 110's own candidate list
      to check for other workspaces with the same missing-test-infra
      shape it had just found and fixed. Found something more specific
      and more directly a loose end from round 110 itself: the root
      `package.json`'s `"test"` script — the actual command
      `npm test` runs, the one a contributor or a future CI setup would
      actually invoke — hardcodes each workspace by name
      (`--workspace=@forge/spec-engine`, `...db`, `...api`, `...web`)
      rather than iterating all workspaces, and still didn't list
      `@forge/shared` even after last round added real tests there. The
      11 new tests existed and passed, but only reachable via
      `npm run test --workspaces --if-present` (this session's own
      verification command) — the project's own documented `npm test`
      would keep silently never running them. Verified empirically
      rather than just reasoning about it: `git stash`ed the fix, ran
      `npm test`, confirmed `@forge/shared`'s own test output never
      appears (only incidental mentions of "@forge/shared" inside other
      packages' test *names*, not its own suite running); restored the
      fix, ran `npm test` again, confirmed `@forge/shared@0.1.0 test`
      now runs first in the chain and reports 11/11. One-line fix to
      the root `"test"` script. Full suite still green (433 tests) and
      both builds clean.

- [x] **Twenty-second consecutive round (91-112) — `apps/api/src/twin.ts`
      (Business Twin), never systematically examined this session,
      turned out to already have 6 sophisticated tests including a
      deliberately-forced dangling-relation-id edge case; found one
      genuinely untested tie-break rule.** `computeBusinessTwin`'s
      `mostActive` reduce uses a strict `e.count > best.count`
      comparison, so a genuine tie between two entities' record counts
      keeps whichever one is declared earlier in `project.spec.entities`
      — a real, deliberate choice, not an arbitrary reduce artifact —
      but nothing verified it. A future edit that changed `>` to `>=`
      (an easy, plausible-looking "simplification") would silently flip
      which entity a real user sees reported as "most active" whenever
      their data happens to tie, with no test failing to catch it. Added
      a direct test locking in the current, earlier-wins behavior.
      Regression-proven with the deliberate-break technique on the
      pre-existing, already-correct code: temporarily changed the
      comparison to `>=`, confirmed the new test caught the resulting
      flip (the test's fixture reports "Appointment" as most active
      instead of the correct "Customer"), restored the original `>`,
      confirmed an empty `git diff` on `twin.ts`. Full suite green (434
      tests, up from 433 — `@forge/api` 143 → 144) and both builds
      clean.

- [x] **Twenty-third consecutive round (91-113) — the more complex
      tie-break round 112 flagged as unexplored: `computeRelationHubObservation`'s
      `candidates.sort()` has no explicit rule for two equally-linked
      records.** `candidates.sort((a, b) => b.total - a.total)` leaves a
      genuine tie's winner to whichever candidate happens to land first
      in the array before the (stable) sort — itself just a side effect
      of `listRecords`' `ORDER BY id DESC` (`repository.ts`) and `Map`
      insertion order, not a deliberate rule. Reasoning about nested
      `Map` insertion order by hand across two loops is exactly the kind
      of thing that's easy to get wrong, so determined the actual
      current winner empirically first, with a throwaway probe script
      (deleted before committing, never part of the real change): with
      two customers genuinely tied at 2 links each, the one whose
      *most-recently-inserted* record comes first wins — not the
      customer created first, which a reader skimming the code might
      otherwise assume "wins" on a tie. Locked in with a direct test.
      Regression-proven with the deliberate-break technique on the
      pre-existing, already-correct sort: temporarily added an
      ascending-id secondary key (`|| a.id - b.id`) to the comparator,
      confirmed exactly the new tie-break test failed while the other 7
      tests in `twin.test.ts` (including round 112's own tie-break test
      in the same file) still passed, restored the original one-key
      sort, confirmed an empty `git diff` on `twin.ts`. Full suite green
      (435 tests, up from 434 — `@forge/api` 144 → 145) and both builds
      clean.

- [ ] **Round 114 — responded to real user reports (a live "server busy"
      error and frustration at the Render free-tier cold-start screen) by
      building an automated keep-alive ping; discovered mid-implementation
      that it can't fire yet, for a reason bigger than a wrong branch
      name.** Added `.github/workflows/keep-alive.yml`: a GitHub Actions
      `schedule` (every 10 minutes) that curls `/api/health` on the live
      app, keeping it under Render free tier's ~15-minute spin-down
      window. Pushed to this repo's working branch
      (`claude/forge-ai-platform-u9an5m`, commit `19c18f4`) — then found
      that GitHub only ever evaluates `schedule`-triggered workflows on a
      repository's **default branch**, and this repo's default branch
      (`claude/from-zero-game-design-2b0jli`) is not a stale copy of this
      project — it's a **different application entirely** ("FROM ZERO", a
      business-tycoon game, with its own `render.yaml` deploying its own
      Render service by that exact branch name). Confirmed via the GitHub
      API (`list_branches`, `get_file_contents`, `list_commits`): the two
      branches share a repo but not a codebase. Because Render pins an
      explicit `branch:` in each project's own `render.yaml`, changing
      *GitHub's* default-branch setting to `claude/forge-ai-platform-u9an5m`
      would not touch either app's deployment — but it's a repository
      setting change with no API tool available here, and pushing the
      workflow file directly onto the other project's branch would also
      cross a standing "never push to a different branch without explicit
      permission" rule either way. Reported this honestly to שלומי and
      asked for a one-click fix on her end rather than guessing; this item
      stays open until she responds and the workflow is confirmed to
      actually run on schedule (`actions_list` → `list_workflow_runs`).

- [x] **Round 115 — while the round 114 default-branch question stayed
      open with שלומי, widened the i18n scan beyond `error.*` (a direction
      flagged since round 109): nothing checked whether a UI-facing
      translation key a component actually calls exists at all.**
      `apps/web/src/i18n/language.test.ts` already checked `he`/`en`
      dictionary symmetry against each other and every `HttpError` code
      the API can throw, but never checked the other direction: whether a
      key a component calls via `t("...")` is itself a real dictionary
      entry. Because `translate()` deliberately never throws (falls back
      to the raw key string instead), a typo'd or renamed key just
      renders literal text like `entity.dupplicate` on screen for a real
      user, with nothing failing loudly — the same failure shape as
      `PIPELINE_IN_PROGRESS`/`ALREADY_BUILT` shipping untranslated
      (round 109), just for UI keys instead of server error codes. Added
      `findUsedTranslationKeys()`, which scans every `.ts`/`.tsx` file
      under `apps/web/src` (mirroring `findThrownHttpErrorCodes`'s
      approach) for literal `t("...")` call sites — found 163 real call
      sites across 9 components today, all already covered, now locked in
      as an invariant. Regression-proven: temporarily removed
      `"entity.duplicate"` from `translations.he`, ran the suite, confirmed
      both the new test and the existing he/en-symmetry test failed with
      the expected messages, restored the entry, confirmed an empty
      `git diff` on `language.ts`. Full suite green (437 tests, up from
      435 — `@forge/web` 128 → 130) and both builds clean. Known
      limitation, same as the HttpError scan: a dynamically-built key
      (`t(someVariable)`) can't be statically checked; none exist in this
      codebase today.

- [x] **Round 116 — `apps/api/src/displayField.ts`, never examined this
      session, had a real untested tie-break: `DISPLAY_FIELD_NAME_HINTS`
      lists `"name"` before `"title"`, which reads like a priority order,
      but the actual code doesn't honor that order at all.**
      `pickDisplayField` iterates `entity.fields` (not the hints list) and
      returns the first field whose own name matches any hint — so an
      entity that happens to declare a `title` field before its `name`
      field gets `title` as its display label, not `name`, contradicting
      what the hints array's own ordering suggests. Confirmed empirically
      with a quick throwaway probe before writing the real test. Added a
      test locking in the current, field-declaration-order behavior with
      both orderings (title-before-name and name-before-title). Regression
      -proven with the deliberate-break technique: temporarily rewrote the
      lookup to walk `DISPLAY_FIELD_NAME_HINTS` in its own order instead
      (a plausible-looking "fix" toward what the array's order implies),
      confirmed exactly the new test failed while every other
      `displayField.test.ts` test still passed, restored the original
      one-line `find()`, confirmed an empty `git diff` on
      `displayField.ts`. Full suite green (438 tests, up from 437 —
      `@forge/api` 146 → 147) and both builds clean.

- [x] **Round 117 — a fresh pass on `apps/api/src/backup.ts` (the "backup
      all data" ZIP/CSV export), unexamined this session: every field
      type except `boolean` already had its own test.** `backup.ts`'s
      `fieldDisplayValue` is a standalone copy of
      `entityFormatting.ts`'s CSV formatting (duplicated on purpose per
      the file's own top comment), and its `field.type === "boolean"`
      branch — Excel's `TRUE`/`FALSE` convention — had zero coverage.
      Writing the test surfaced a genuinely non-obvious invariant along
      the way, caught only by running the test rather than reasoning
      about it: an **omitted** boolean field renders `"FALSE"`, not
      blank, unlike every other field type. The cause is one layer down,
      in `packages/db/src/repository.ts`'s `rowToRecord`, which coerces a
      boolean column's stored `NULL` through `Boolean(value)` — so an
      unset boolean is indistinguishable from an explicit `false` by the
      time a record ever reaches `backup.ts`. A first draft of this test
      assumed the unset case would render blank (matching text/number/
      enum/relation's behavior) and failed against the real code; fixed
      by reading `repository.ts` directly instead of continuing to guess,
      then locked in the real, verified behavior. Regression-proven:
      temporarily lowercased the rendered `"TRUE"`/`"FALSE"` to
      `"true"`/`"false"`, confirmed exactly the new test failed, restored
      the original code, confirmed an empty `git diff` on `backup.ts`.
      Full suite green (439 tests, up from 438 — `@forge/api` 146 → 147)
      and both builds clean.

- [x] **Round 118 — followed round 117's finding into `apps/api/src/codegen.ts`
      (the standalone-app exporter): its own independent copy of
      `rowToRecord`/`backupFieldDisplayValue`, embedded in the generated
      `server.js` template, had the exact same untested boolean gap.**
      Because the exported app has zero runtime dependency on this repo,
      `codegen.ts` duplicates the live API's backup-CSV logic verbatim
      into a template string — and none of `codegen.test.ts`'s existing
      1432 lines (nor its shared `project` fixture) ever exercised a
      boolean field. Same invariant applies here too: an omitted boolean
      renders `"FALSE"`, not blank. Extracted and executed the real
      generated `rowToRecord`/`backupFieldDisplayValue` via regex +
      `new Function` — the same technique the file's existing `buildZip`
      test already uses — rather than spawning a full server process (no
      HTTP or real SQLite round-trip needed here) or editing the shared
      `project` fixture other tests in the file depend on for exact
      output. Regression-proven: temporarily lowercased the generated
      `"TRUE"`/`"FALSE"` to `"true"`/`"false"` in `codegen.ts`'s template,
      confirmed exactly the new test failed, restored the original code,
      confirmed an empty `git diff` on `codegen.ts`. Full suite green
      (440 tests, up from 439 — `@forge/api` 147 → 148) and both builds
      clean.

- [x] **Round 119 — found a *third* independent copy of the same
      boolean/enum CSV-formatting logic inside `codegen.ts`, and this one
      had zero output coverage at all, not even the partial coverage
      round 117/118's copies started from.** `codegen.ts` embeds the
      per-entity "Export CSV" button's client-side `fieldDisplayValue`/
      `recordsToCsv` inside the generated `EntityView.jsx` template — a
      separate function from round 118's server-side
      `backupFieldDisplayValue`. The existing tests around it
      (`codegen.test.ts` lines 792-802, 827-843) only ever regex-matched
      the functions' *presence and signatures*; nothing ever executed
      them and checked the actual CSV string a real export would produce,
      for any field type. Extracted and executed the real generated
      `csvEscape`/`fieldDisplayValue`/`recordsToCsv` via regex +
      `new Function` (the technique round 118 introduced for this file)
      and asserted on the real output: a boolean renders `TRUE`/`FALSE`
      and an enum value resolves to its translated label. Regression
      -proven: temporarily lowercased the generated `"TRUE"`/`"FALSE"` to
      `"true"`/`"false"` in this template, confirmed exactly the new test
      failed, restored the original code, confirmed an empty `git diff`
      on `codegen.ts`. Full suite green (441 tests, up from 440 —
      `@forge/api` 148 → 149) and both builds clean.

- [x] **Round 120 — real user feedback ("אתה רק מוצא בעיות, תפתח את הקוד
      שיהיה מושלם" — "you only find problems, develop the code to be
      great") redirected this session from bug-hunting back to shipping a
      real, visible feature: project collaborators.** Closed the honest
      gap `docs/security.md` has documented since the first auth work —
      "No RBAC / organizations... single-owner-per-project... no team
      sharing" — to its first real version: an owner can invite any other
      existing Forge AI user by email as a collaborator, who then gets
      identical full read/write access to the project (build, refine,
      every entity's records, exports, WhatsApp, Time Machine) through the
      exact same `requireProjectAccess` check every route already used
      (renamed from `requireOwnedProject`, now owner-OR-collaborator);
      managing who has access stays owner-only via a separate, stricter
      `requireProjectOwner`. New `packages/db/src/collaborators.ts`
      (`project_collaborators` table), `projects.ts`'s new
      `listProjectsForUser` (owned ∪ collaborated-on, one `LEFT JOIN`, no
      duplicate rows even when a user is both), three new routes
      (`GET`/`POST`/`DELETE .../collaborators`, guarding against an
      unknown email or the owner's own email), a new `CollaboratorsPanel`
      (invite/remove for the owner, read-only for a collaborator), and
      full Hebrew/English translations.

      Verifying this in a real browser surfaced a second, genuinely
      unplanned gap: `listProjects()` had zero UI consumers before this —
      every login always landed on "create something new" with no way
      back into a project you'd already made, **owner included** (`project`
      is plain in-memory React state with nothing behind it once the tab
      reloads). Without fixing that too, an invited collaborator would
      have had real API access but no way to actually discover or open
      the project. Added a "Your projects" list to the home screen
      (`openExistingProject` routes a built project to preview, a draft
      back to spec review), which incidentally also fixes this for every
      existing user, not just collaborators.

      Verified two ways: the full regression-proof discipline (temporarily
      reverted `requireProjectAccess` to owner-only, confirmed exactly the
      new "collaborator gains access" test failed; temporarily hardcoded
      `openExistingProject`'s view to `"preview"`, confirmed exactly its
      new test failed; both restored, empty `git diff` each time), **and**
      a full real-browser Playwright pass against the actual running dev
      server in both languages — signup, invite, the collaborator's home
      screen showing the shared project with a "Shared" badge, opening it
      with full access, and the same panel correctly read-only (no invite
      form, no remove buttons) from the collaborator's own side; RTL/Hebrew
      layout confirmed too. Full suite green (454 tests, up from 441 —
      `@forge/api` 149 → 154, `@forge/web` 130 → 131, `@forge/db` 69 → 76)
      and both builds clean.

- [x] **Round 121 — a natural follow-on to round 120: "Duplicate" a
      project as a template for a new one.** `POST /projects/:id/clone`
      copies a project's spec + description into a brand-new project
      owned by whoever asked — the owner, or a collaborator making their
      own personal starting point from one shared with them — but
      deliberately never the source's actual data. The clone always
      starts as a fresh `"draft"`, exactly like describing a new idea
      from scratch, so nobody's real business records land in a new
      project without them explicitly building it themselves. Reuses
      `requireProjectAccess` (not `requireProjectOwner`), since cloning
      your own copy of a blueprint you already have access to doesn't
      touch the original at all. A "Duplicate" button on each home-screen
      project card lands straight on the clone's spec review screen.
      (Restructured `.my-project-card` from a single clickable button
      into a card containing a borderless "open" button plus a separate
      "Duplicate" button, since a `<button>` can't nest inside another
      `<button>`.)

      Verified two ways: 3 new API tests (built a project, inserted a
      real record, confirmed the clone's own table doesn't exist yet
      since it's unbuilt — proving no data carries over, not just that
      none is *visible*; a collaborator's clone is owned by the
      collaborator, not the original owner, verified against their real
      `/auth/me` identity rather than trusting a client-supplied value;
      an outsider with no access still gets a 404 cloning it, same as
      every other project route), regression-proven with the
      deliberate-break technique (temporarily made the clone keep the
      source's `ownerId` instead of the requester's — a plausible-looking
      mistake — confirmed exactly the collaborator-ownership test failed,
      restored, confirmed an empty `git diff`) — **and** a full
      real-browser Playwright pass against the actual running dev server:
      build a project, click Duplicate from the home screen, land on the
      clone's spec review with the same entities, return home and see
      both the original and the "(copy)" clone listed. Full suite green
      (457 tests, up from 454 — `@forge/api` 154 → 157) and both builds
      clean.

- [x] **Round 122 — a third follow-on in the same visible-features vein:
      inline project rename.** The project name was previously fixed
      forever at creation — auto-derived from the first few words of the
      description by `deriveName`, including a clone's generic "(copy)"
      suffix from round 121 — with no way to fix a bad or generic name
      afterward. `PATCH /projects/:id/name` (Zod-validated, rejects an
      empty/whitespace-only name with 400) uses `requireProjectAccess`, not
      `requireProjectOwner`, so a collaborator can rename too, consistent
      with the existing full-access sharing model; a new `ProjectNameEditor`
      component (extracted out of `App.tsx` for independent testability,
      matching this codebase's existing panel-component pattern) replaces
      the static preview-screen `<h1>`: click to edit, Enter or blur saves,
      Escape cancels without saving.

      Building the Escape-cancel path surfaced a genuine testing-
      infrastructure limitation worth recording: a jsdom-based regression
      test for "Escape cancels without saving" did **not** catch a
      deliberately reintroduced bug (removing the guard against a spurious
      save-on-unmount race, where Escape's `setEditing(false)` unmounts the
      focused input). Two throwaway probe scripts (not committed) pinned
      down why — jsdom does not fire a `blur` event when the focused
      element is removed from the DOM, but real Chromium reliably does.
      The guard is real and necessary for production correctness even
      though no jsdom unit test in this codebase's current tooling can
      directly prove it fixes that exact race; `ProjectNameEditor.test.ts`'s
      own comment documents this honestly instead of overclaiming what the
      jsdom test proves.

      Verified three ways: the regular jsdom test suite (2 new component
      tests, 3 new API route tests, 1 new db-layer test), the
      deliberate-break-and-restore discipline for the db layer, and — since
      jsdom couldn't settle the Escape question on its own — a full
      Playwright pass against real Chromium on the actual running dev
      server: opened a seeded project, renamed it via a real blur, reloaded
      the page and reopened the project from the home screen to confirm the
      new name persisted server-side (not just in local React state, and
      not just visible without a reload), then re-entered edit mode, typed
      over it, and pressed Escape — confirming the previously-saved name
      was kept, not the newly-typed text and not a revert to the original
      auto-derived name. Full suite green (467 tests, up from 457 —
      `@forge/db` 76 → 77, `@forge/api` 157 → 160, `@forge/web` 131 → 133)
      and both builds clean.

- [x] **Round 123 — a fourth follow-on in the same visible-features vein:
      "Delete" a project from the home screen.** Once a project existed
      there was previously no way to get rid of it, not even a mistaken,
      empty, or unwanted one. `DELETE /projects/:id` deletes it for real
      and cascades everything that belongs only to it: the project row,
      its real generated data tables (one per entity), Time Machine
      checkpoints, collaborator grants, and WhatsApp connection/message
      history -- not just the project row with everything else silently
      orphaned. Each of those cleanups was added as its own small,
      exported bulk-delete function on the module that already owns that
      table (`deleteCheckpointsForProject`, `removeAllCollaborators`,
      `deleteWhatsAppData`), with a new `deleteProject` in `projects.ts`
      orchestrating them plus dropping the real per-entity data tables via
      the same `tableNameFor` naming `migrate.ts` uses to create them.
      Unlike rename and clone (round 122/121, both `requireProjectAccess`
      since a collaborator has identical full access), this route uses
      the stricter `requireProjectOwner`: deleting removes *every*
      collaborator's access too, so it's deliberately not something a
      collaborator can trigger on a project they don't own. Also tears
      down any *live* WhatsApp Web socket via `WhatsAppWebManager.disconnect`
      before the DB cleanup, since that in-memory connection state lives
      in apps/api, outside packages/db's reach. On the home screen, a
      danger-styled "Delete" button appears on each project card only for
      its owner, gated behind `window.confirm` naming the project --
      matching this codebase's one existing delete confirmation
      (`EntityPanel`'s own record-delete).

      Verified with the deliberate-break-and-restore discipline at all
      three layers -- db: temporarily skipped the entity-table-drop loop,
      confirmed the new test's specific "table should be dropped"
      assertion failed and nothing else; api: temporarily swapped
      `requireProjectOwner` for `requireProjectAccess`, confirmed exactly
      the "a collaborator cannot delete" test failed (204 instead of the
      expected 404); web: temporarily removed the `window.confirm` guard,
      confirmed exactly the "declining must not delete" assertion failed
      -- each restored afterward with an empty `git diff` on that specific
      change. **And** a full Playwright pass against the real running dev
      server with two real logged-in users (an owner and a collaborator,
      each their own browser context): confirmed the collaborator never
      sees a delete button on the project shared with them, dismissing the
      confirm dialog leaves everything untouched, accepting it removes
      exactly that project while a second, untouched project survives,
      the deletion persists across a page reload (not just local React
      state), and the collaborator loses access too once reloaded. Full
      suite green (469 tests, up from 467 -- `@forge/db` 77 → 78,
      `@forge/api` 160 → 164, `@forge/web` 133 → 134) and both builds
      clean.

- [x] **Round 124 — a fifth follow-on in the same visible-features vein,
      moving from project-level actions to an account-level one: "Change
      password" from the topbar.** There was previously no way to change
      your account password once signed up at all, a real gap for anyone
      actually using this app day to day, not a theoretical one. New
      `PATCH /auth/password` (`packages/db`'s new narrow
      `getPasswordHash`/`updatePasswordHash` helpers, scoped to this one
      need rather than widening the public `User` type with a field
      nothing else should ever read) requires the *current* password, not
      just a valid session token -- so someone briefly at an
      already-logged-in device can't silently lock the real owner out.
      Unlike login, this route doesn't need the timing-side-channel
      defense (`dummyPasswordHashPromise`) login uses, since `requireAuth`
      has already proven the caller's identity before this route's own
      code ever runs -- there's no account to enumerate. Deliberately does
      *not* invalidate any other active session on a successful change:
      this app's session model has no bulk-revoke-by-user mechanism at
      all, and building one is a bigger change than this route's own
      scope, so it's documented as a known, honest limitation rather than
      silently assumed away. On the client, a new `ChangePasswordPanel`
      (matching this codebase's existing overlay-panel pattern) opens from
      a new button next to "Log out" in the topbar -- available from every
      screen (home, spec review, building, preview), not just the project
      preview, since it's an account-level action, not a project one. A
      client-side confirm-new-password field catches a typo before it's
      ever sent to the server.

      Verified with the deliberate-break-and-restore discipline at all
      three layers -- db: temporarily turned `updatePasswordHash` into a
      no-op, confirmed the new test's specific "hash actually changed"
      assertion failed and nothing else; api: temporarily removed the
      `verifyPassword` check entirely, confirmed exactly the
      wrong-current-password test failed (204 instead of the expected 401
      `INVALID_CURRENT_PASSWORD`); web: temporarily removed the
      new-password/confirm-password mismatch guard, confirmed exactly the
      "declines on mismatch, never calls the API" assertion failed -- each
      restored afterward with an empty `git diff` on that specific change.
      **And** a full Playwright pass against the real running dev server:
      signed up, tried the wrong current password (rejected with a clear
      "incorrect" error, nothing changed), tried a mismatched confirmation
      (rejected client-side, no request ever sent), changed the password
      for real (a visible success message), logged out, confirmed the OLD
      password is now rejected on login and the NEW one logs in
      successfully -- the strongest possible proof the change genuinely
      persisted server-side, not just in local component state. Full
      suite green (479 tests, up from 469 -- `@forge/db` 78 → 80,
      `@forge/api` 164 → 168, `@forge/web` 134 → 138) and both builds
      clean.

- [x] **Round 125 — a sixth follow-on, back to the Business Twin: a
      "possible duplicate" observation.** Flags two records within the
      same entity that share the exact same display name (e.g. two
      "Customer" records both named "Dana Levi") -- a real, actionable
      signal for a real small business (an accidental double-import, a
      contact entered twice) without ever claiming to know *why* they
      match, the same honesty principle every other Business Twin
      observation already follows (round 63's relation-coverage gaps,
      round 65's most-linked record). Reuses `displayField.ts`'s own
      `pickDisplayField`/`recordDisplayLabel` -- the exact same field
      every other part of this app already uses to represent a record --
      rather than inventing a second notion of "the record's name".

      Deliberately restricted to an entity whose picked display field is
      actually `text`: `pickDisplayField` falls back to an entity's first
      field of *any* type when there's no name/title/text field at all,
      and two records genuinely coincide on a field like that constantly
      (two unrelated shipments that both happen to weigh 5kg) without
      being duplicates in any meaningful sense. This wasn't a hypothetical
      worry -- a first draft of this test suite (a "Shipment" entity with
      only a `weight: number` field) caught the exact false positive:
      "In 'Shipments', 2 records share the name '5' — possibly a
      duplicate." Fixed by skipping duplicate-detection entirely for an
      entity with no text display field, not by trying to special-case
      the message.

      No web-side code needed at all: `BusinessTwinPanel.tsx` already
      renders the `observations` array generically, so this new
      observation string appears automatically wherever it's pushed into
      that array server-side -- this round's entire diff lives in
      `apps/api/src/twin.ts` and its test file.

      Verified with the deliberate-break-and-restore discipline
      (temporarily removed the "picked display field must be text" guard,
      confirmed exactly the false-positive-on-a-number-field test failed
      with that same bogus "share the name '5'" observation, restored,
      confirmed an empty `git diff`), **and** a full Playwright pass
      against the real running dev server: signed up, built a real CRM
      project through the actual AI pipeline (not a seeded shortcut),
      added a second "Dana Levi" customer alongside the one the Seed Data
      agent already created on its own, opened the Business Twin panel,
      and confirmed the new observation appears correctly alongside the
      existing "most active" and relation-coverage insights. Full suite
      green (483 tests, up from 479 -- `@forge/api` 168 → 172;
      `@forge/web` unchanged at 138, since no client-side code was needed)
      and both builds clean.

- [x] **Round 126 — a seventh follow-on: inline entity display-label
      rename.** An entity's display label (e.g. "Customer" shown as
      "לקוחות") was otherwise only ever set once, by spec generation,
      with no way to fix an awkward auto-generated one short of a full
      natural-language Refine round-trip -- a real AI/heuristic call plus
      a migration, even though nothing about the actual schema needs to
      change for a pure display-text edit. New
      `PATCH /projects/:id/entities/:entityName/label`: since `label` is
      pure display metadata (`EntitySchema`'s own comment) and
      `entity.name` -- the real table name -- is never touched, this is
      a direct `updateProjectSpec` write with no migration involved at
      all. Uses `requireProjectAccess`, consistent with every other
      spec-editing action a collaborator can already do (rename, clone),
      not the stricter owner-only gate delete uses. Registered before the
      existing `.../:entityName/:recordId` PATCH route so a request to
      `.../label` is never mistaken for an update to a record literally
      named "label".

      On the client, a new `EntityLabelEditor` component mirrors
      `ProjectNameEditor` (round 122) almost exactly -- click to edit,
      Enter or blur saves, Escape cancels, the same spurious-save-on-
      unmount guard for the same underlying reason -- and replaces the
      entity panel's static heading. The entity-tabs nav (which already
      maps over `project.spec.entities` on every render) picks up the new
      label automatically once `onRenamed` bubbles the updated project up
      to `App.tsx`'s `setProject`, with no separate wiring needed for the
      tab itself -- one save updates both the panel heading and the tab
      in the same render.

      Verified with the deliberate-break-and-restore discipline at both
      layers -- api: temporarily wrote the new value into `entity.name`
      instead of `entity.label`, confirmed the test's own subsequent
      entity lookup broke with a real `TypeError` (proving the break
      really would have corrupted the entity's real name/table mapping in
      production, not just its display text); web: temporarily removed
      the actual `renameEntityLabel` API call from `save()`, confirmed
      exactly the "saves a real change" test failed -- each restored
      afterward with the full suite green again. **And** a full
      Playwright pass against the real running dev server: built a real
      CRM project through the actual AI pipeline, renamed the Customer
      entity's label to Hebrew text, confirmed both the panel heading AND
      the entity-tabs nav updated immediately (RTL layout correct too),
      reloaded and reopened the project from the home screen to confirm
      the rename persisted server-side (not just local React state), then
      confirmed Escape correctly cancels a second edit without saving.
      Full suite green (489 tests, up from 483 -- `@forge/api` 172 → 176,
      `@forge/web` 138 → 140) and both builds clean.

- [x] **Round 127 — an eighth follow-on, extending round 126's entity-
      label rename one level down: inline field display-label rename.**
      A single field's label (e.g. a "phone" field shown as "טלפון נייד")
      had the exact same gap entities had before round 126 -- set once by
      spec generation, no way to fix an awkward one short of a full
      natural-language Refine round-trip. New
      `PATCH /projects/:id/entities/:entityName/fields/:fieldName/label`,
      another direct `updateProjectSpec` write with no migration (a new
      `findField` helper, 404 `FIELD_NOT_FOUND`, mirrors `findEntity`'s
      own existence check), and a new `FieldLabelEditor` on the client.

      This one genuinely differs from `ProjectNameEditor`/
      `EntityLabelEditor`, not just in what it edits: a field's label
      lives inside a `<label>` that already wraps the real form input
      (needed for correct label/input association), and a native
      `<label>` forwards a click on its own non-interactive content to
      that wrapped input. Making the label text itself the click-to-edit
      target the way the two earlier editors do would also refocus the
      actual field input on every click. Used a dedicated small
      pencil-icon `<button>` instead, with `preventDefault`/
      `stopPropagation` on its click, so starting an edit never touches
      the sibling input's focus -- and wrote a jsdom test specifically
      for that click-forwarding contract (render `FieldLabelEditor` inside
      a real `<label>` with its own click handler, click the rename
      button, assert the wrapping label's handler never fired), not just
      for the rename itself.

      Verified with the deliberate-break-and-restore discipline at three
      separate points -- api: temporarily wrote the new value into
      `field.name` instead of `field.label`, confirmed the test's own
      subsequent field lookup broke with a real `TypeError` (the same
      "would have corrupted the real column mapping" proof round 126's
      entity version gave); web save path: temporarily removed the actual
      `renameFieldLabel` call, confirmed exactly the "saves a real change"
      test failed; web focus-safety: temporarily removed
      `stopPropagation` from the edit button's click handler, confirmed
      exactly the new label-click-forwarding test failed -- each restored
      afterward with the full suite green again. **And** a full Playwright
      pass against the real running dev server: built a real CRM project,
      clicked a field's rename button, and confirmed via
      `document.activeElement` in real Chromium (not just assumed from
      the jsdom test, which can't fully settle a real click-forwarding
      question the way round 122's blur-on-unmount discovery already
      taught this session to distrust) that the rename input -- not the
      sibling `FieldInput` -- genuinely receives focus; renamed it to
      Hebrew text, confirmed it persisted across a reload, then confirmed
      Escape correctly cancels a second edit without saving. Full suite
      green (496 tests, up from 489 -- `@forge/api` 176 → 180, `@forge/web`
      140 → 143) and both builds clean.

- [x] **Round 128 — a ninth follow-on, moving away from the rename series
      to a different gap: "Duplicate selected" for bulk-select.**
      Bulk-select + bulk-delete already existed (round 53), and a single
      record already had its own "Duplicate" quick action (round 89), but
      there was no way to duplicate several selected records at once -- a
      real time-saver for cloning a handful of near-identical entries
      (e.g. several similar service listings) without repeating the
      single-record duplicate one row at a time.

      `handleBulkDuplicate` deliberately reuses two things already proven
      correct rather than inventing new logic: `handleDuplicate`'s own
      per-record field-copy (`id`/`createdAt` excluded, server-assigned),
      and `handleBulkDelete`'s own `Promise.allSettled` resilience pattern
      -- a single rejected create must not hide the ones that DID
      succeed, and must not stop the batch from attempting the rest. No
      confirmation dialog, for the same reason `handleDuplicate` has none:
      duplicating creates rather than destroys. Selection clears on full
      success; a partial failure keeps only the actually-failed ids
      selected, ready for a retry -- the exact same contract
      `handleBulkDelete` already established, just for creates instead of
      deletes.

      Verified with the deliberate-break-and-restore discipline:
      temporarily swapped `Promise.allSettled` for a plain `Promise.all`
      wrapped in try/catch (a plausible-looking "simplification"),
      confirmed exactly the "keeps only the failed ids selected, and
      still refreshes on partial failure" test failed with a real
      `TypeError` (`setSelectedIds` is never called down the
      all-or-nothing path when one create rejects) -- restored, confirmed
      an empty `git diff`. **And** a full Playwright pass against the
      real running dev server: built a real CRM project, selected 2 of
      the seeded records, clicked "Duplicate selected", confirmed the
      table grew from 2 to 4 rows, confirmed the selection (and the
      bulk-actions bar) cleared after the full success, and confirmed the
      2 new records persisted across a reload. Full suite green (498
      tests, up from 496 -- `@forge/web` 143 → 145; `@forge/api`/
      `@forge/db` unchanged, since this reuses the existing single-record
      `POST /entities/:entityName` route per duplicate, no new server-side
      code needed) and both builds clean.

- [x] **Round 129 — Business Twin: download the snapshot as a shareable
      report.** The Business Twin panel (round 24, extended in rounds 63,
      65, 125) could only be viewed on-screen -- there was no way to save
      or share the actual snapshot. "PDF export" was the obvious first
      instinct (it had been sitting in the trigger prompt's own suggestion
      list since round 124), but was deliberately ruled out this round:
      the 14 standard PDF fonts are Latin-only, so a dependency-free PDF
      writer (this codebase's established pattern, per `zip.ts`) would
      need an embedded/subsetted Hebrew font to avoid literally garbled
      or missing glyphs for this app's Hebrew-first audience -- a
      materially bigger, riskier undertaking than this feature's value
      justifies in one round. Plain UTF-8 text has no such limitation,
      is just as shareable (WhatsApp, email, paste anywhere), and was the
      actual chosen approach.

      New `twinReport.ts` exports a pure `formatTwinReport(twin,
      projectName, lang, t)` -- title, generated-at timestamp, summary,
      roles, one line per entity's record count, the total, and the
      existing observations list, each section correctly omitted (not
      printed as an empty heading) when there's nothing to show -- plus
      `downloadTwinReport`, which saves that text as a real `.txt` file
      via a Blob + a synthetic `<a download>` click, the same download
      mechanics `api.ts`'s `downloadBlob` already uses for export/backup,
      but skipping the network round-trip entirely since the twin data is
      already sitting in `BusinessTwinPanel`'s own React state -- no new
      server route needed. Wired a "Download report" button into the
      panel's header, next to Close.

      Verified with the deliberate-break-and-restore discipline: removed
      the `if (twin.roles.length > 0)` guard around the roles line,
      confirmed the "omits the roles line and observations section when
      there are none" test failed with a real stray "Roles: " line in
      the output -- restored, confirmed an empty `git diff` (new file, so
      confirmed via a clean re-run instead). **And** a full Playwright
      pass against the real running dev server: built a real project from
      a Hebrew idea ("חנות פרחים עם לקוחות והזמנות"), opened Business
      Twin, clicked "Download report", intercepted the real browser
      download event, and read back the actual saved file's bytes --
      confirmed the Hebrew title, summary, roles, per-entity counts, and
      observations all round-tripped correctly through the Blob/UTF-8
      path with zero page errors. (Also discovered and ruled out, via an
      isolated bare-HTML repro, a genuine Chromium/Playwright quirk
      unrelated to this feature's code: a blob-URL download whose
      `download` attribute is pure Hebrew reports `suggestedFilename()`
      as the generic string "download" in this test environment --
      reproducible with zero relation to React or this app's code, and
      an existing, identical limitation `backupProject`/`exportProject`
      already share for any Hebrew project name; the file's actual saved
      content was unaffected.) Full suite green (502 tests, up from 498
      -- `@forge/web` 145 → 149; `@forge/db`/`@forge/api` unchanged, no
      server-side code needed) and both builds clean.

- [x] **Round 130 — a status filter dropdown for the entity table view.**
      Free-text search already existed (round 67), but there was no way
      to narrow a long table down to just one status/stage (e.g. only
      "Won" deals, only "Approved" insurance claims, only "Pending"
      orders) without switching to board view and scanning one column by
      eye -- a real, common business need once an entity has more than a
      handful of records.

      Added a "Filter by <field>" `<select>` next to the search box,
      scoped to the same enum field `findBoardField` already picks out
      for the board view (usually "status"/"stage") -- reusing an
      existing, proven field-selection heuristic rather than inventing a
      new one, and consistent with the board view's own concept of "the
      one field this entity is organized by". The filter is applied
      inside `visibleRecords`, the single memo table view, board view,
      calendar view, bulk-select, and CSV export all already read from --
      so filtering to one status narrows all of them at once, including
      CSV export (exporting only the currently-filtered rows), with no
      separate wiring needed per view.

      Verified with the deliberate-break-and-restore discipline: replaced
      the filter's `matched.filter(...)` with a no-op passthrough,
      confirmed the new test (select "won" in the dropdown, expect the
      table to narrow from 3 rows to 1) failed with `waitForCondition:
      condition never became true` since the table never actually
      narrowed -- restored, confirmed an empty `git diff`. **And** a full
      Playwright pass against the real running dev server: built a real
      CRM project with sales-stage records, selected "New" in the filter,
      confirmed the table narrowed from 2 rows to 1 and the one visible
      row's own badge read "New" (not just a shorter list -- the *right*
      row), cleared the filter back to "All" and confirmed all rows
      returned, then reloaded and reopened the project to confirm the
      underlying records themselves were untouched by the filter (a pure
      view-state feature, not a destructive one). Full suite green (503
      tests, up from 502 -- `@forge/web` 149 → 150; `@forge/db`/
      `@forge/api` unchanged, purely a client-side view filter) and both
      builds clean.

- [x] **Round 131 — a per-record Print action.** Business apps built on
      Forge regularly hold things a real business needs to hand someone on
      paper -- an order, a work order, an insurance claim -- and the only
      way to print one before this round was the browser's own page print,
      which captured the whole cluttered app chrome (topbar, sidebar, the
      record-entry form) around one row's data.

      Added a "🖨️ Print" row action next to Edit/Duplicate/Delete. It
      fills an always-mounted `RecordPrintSheet` with that one record's
      fields (reusing the same `Cell` renderer the table already uses, so
      badges/dates/numbers/relations format identically) and calls
      `window.print()`. The visibility switch is pure CSS, the standard
      "print only this element" technique: `.print-record-sheet` is
      `display: none` on screen, and a `@media print` rule sets
      `visibility: hidden` on everything in `body`, then re-declares
      `visibility: visible` (and `display: block`) on just the sheet and
      its children. Deliberately NOT a dependency-free PDF writer (the
      pattern round 129 already ruled out for the same reason): the real
      browser print pipeline renders Hebrew text correctly out of the
      box, so there's no font-embedding risk to solve at all here.

      Verified with the deliberate-break-and-restore discipline: changed
      the Print button's handler to always queue `visibleRecords[0]`
      instead of the actual clicked row's record, confirmed the new test
      (click row 2's Print button, expect the sheet to show row 2's own
      data) failed with the sheet instead showing row 1's "Acme Corp" --
      restored, confirmed the diff matched only the intended change.
      **And** a full Playwright pass against the real running dev server
      that couldn't be faked by a DOM-only check: confirmed the sheet's
      real `display` is `none` on ordinary screen media (not just
      logically empty), stubbed `window.print` and confirmed it fires
      exactly once on click, then used Playwright's own print-media
      emulation (not a mock) to confirm the sheet's computed `display`
      flips to visible, the topbar's computed `visibility` becomes
      `hidden`, and the sheet's actual rendered text contains that
      record's real field values. Full suite green (504 tests, up from
      503 -- `@forge/web` 150 → 151; `@forge/db`/`@forge/api` unchanged,
      purely client-side) and both builds clean.

- [x] **Round 132 — pin/favorite a project on the home screen.** "Your
      projects" (round 3-ish, extended many times since) has always sorted
      newest-first, server-side, with no way to change that -- once
      someone has a handful of projects, the one they actually touch every
      day can end up buried below others they haven't opened in weeks.

      Added a star toggle on each project card. Pinning moves that project
      to the front of the list; everything else -- pinned or not -- keeps
      its own existing relative order otherwise, so pinning never
      reshuffles anything beyond moving the pinned ones forward. New
      `pinnedProjects.ts` holds this as three small pure functions
      (`getPinnedIds`, `togglePinned`, `sortByPinned`) backed by
      `localStorage`, matching the app's existing convention for
      per-viewer-only preferences (theme, language) that don't need a
      server round trip or to be shared across a project's other
      collaborators -- a deliberate choice, since the star toggle needed
      nothing further from the server at all (the full project list is
      already fetched; this only ever reorders it client-side).

      Verified with the deliberate-break-and-restore discipline: swapped
      `[...pinned, ...unpinned]` for `[...unpinned, ...pinned]` in
      `sortByPinned`, confirmed the reordering test failed with pinned
      projects pushed to the BACK instead of the front -- restored,
      confirmed a clean re-run (new file). **And** a full Playwright pass
      against the real running dev server: built two real projects
      ("Alpha" then "Beta", newest-first so Beta listed first by default),
      pinned Alpha via its star, confirmed it jumped to the front and its
      star filled in, reloaded the page and confirmed the pin survived
      (real localStorage persistence, not the view-state-doesn't-persist
      quirk that resets everything server-driven on reload), then unpinned
      it and confirmed the natural newest-first order returned. Full suite
      green (510 tests, up from 504 -- `@forge/web` 151 → 157; `@forge/db`/
      `@forge/api` unchanged, purely client-side) and both builds clean.

- [x] **Round 133 — search box for "Your projects" once there are enough
      to matter.** A natural follow-on to round 132's pin: pinning helps
      keep one favorite handy, but scrolling/scanning a growing grid to
      find a specific OTHER project by eye doesn't scale. Added a search
      box, shown once there are more than 5 projects (so it doesn't
      clutter a short list), that narrows by a case-insensitive substring
      match on the project's name.

      Extracted the combined filter-then-sort into an exported
      `filterAndSortProjects(projects, search, pinnedIds)` -- mirroring
      this same file's existing `summarizeRefineImpact` pattern (an
      exported pure function backing a piece of JSX, directly importable
      by a test rather than needing a full component render) -- and
      deliberately composed in that order (narrow first, THEN apply the
      pinned-first sort to what's left), so a search and a pin always
      agree with each other instead of one silently undoing the other.

      Verified with the deliberate-break-and-restore discipline: dropped
      `.trim()` from the query normalization, confirmed the "a blank/
      whitespace-only query must show everything" test failed by matching
      NOTHING instead (a lone space is truthy, so it flowed straight into
      the substring filter) -- restored, confirmed a clean diff. **And** a
      full Playwright pass against the real running dev server: seeded 6
      real projects directly via the API (fast and deterministic, since
      this feature only cares about names in the list, not built status),
      confirmed the search box only appears once there are 6, searched
      "bakery" and got exactly the 2 real matches (not a coincidental
      count), searched "CLINIC" in uppercase and confirmed it still
      matched the lowercase-stored name, confirmed the "no results"
      message appears for a query matching nothing, and confirmed clearing
      the box restores all 6. Full suite green (512 tests, up from 510 --
      `@forge/web` 157 → 159; `@forge/db`/`@forge/api` unchanged, purely
      client-side) and both builds clean.

- [x] **Round 134 — recent-activity and stale-entity observations for
      Business Twin.** A deliberate return to the Business Twin (last
      touched at round 129) rather than a fourth straight round on "Your
      projects" (rounds 130-133 all lived there) -- three-plus rounds on
      the same screen risked becoming the same kind of narrow, repetitive
      work שלומי originally pushed back on, so this round moved to a
      different part of the app entirely.

      Reads a fact every record already carries for free -- its own
      `createdAt` column, stamped by `insertRecord` on every insert, never
      previously surfaced in the Twin -- to add two new observations: how
      many records were added in the last week (across the whole
      project), and which entities that genuinely DO have real records
      haven't had a single new one added in the last 30 days. The second
      is a materially different signal from the existing "no records yet
      in: X" observation just above it, which only ever catches an entity
      that never had ANY data -- this one catches an entity that USED to
      get data and has since gone quiet (a process that stopped, a form
      nobody fills out anymore), which is a genuinely different and more
      actionable thing for a real small business to notice.

      Verified with the deliberate-break-and-restore discipline: flipped
      the "track each entity's most-recent record's age" logic to track
      the OLDEST record's age instead (init `-Infinity` + `>` instead of
      `Infinity` + `<`), confirmed the test asserting "an entity with one
      recent record among older ones must NOT be flagged stale" failed --
      Appointment (one 45-day-old record, one fresh one) got wrongly
      flagged alongside the genuinely all-old Customer entity -- restored,
      confirmed an empty `git diff`. **And** a full Playwright pass against
      the real running dev server, going a step further than a mocked
      date: built a real CRM project, confirmed the "records added in the
      last week" observation read "4" right after the build (the real
      seed data), then ran a raw `node --experimental-sqlite` script
      against the *same live sqlite file this exact dev server process was
      reading from* (not a separate test DB) to backdate only the Customer
      entity's 2 rows to 45 days ago, reloaded the Business Twin panel, and
      confirmed the count dropped to "2" (just Order's still-fresh rows)
      and a new "No new records added in the last 30 days in: Customer"
      observation appeared, naming exactly the entity that was actually
      backdated. Full suite green (515 tests, up from 512 -- `@forge/api`
      180 → 183; `@forge/db`/`@forge/web` unchanged, all new logic lives in
      `twin.ts`) and both builds clean.

- [x] **Round 135 — a "What would change?" diff preview on Time Machine
      checkpoints.** Yet another different part of the app (round 134 was
      Business Twin, rounds 130-133 were the home screen) -- the History
      panel hadn't been touched since its original build. Restoring a
      checkpoint never destroys any data (migrations are additive-only, per
      the restore route's own comment), but it DOES move which
      entities/fields the live screens currently show -- so a real question
      before clicking Restore is "what will disappear from what I see right
      now?", and the panel had no way to answer it beyond guessing from a
      timestamp and an entity count.

      Added a "What would change?" toggle per checkpoint, computed entirely
      client-side via a new `computeCheckpointDiff(currentSpec,
      checkpointSpec)` -- both specs are already fully in hand (the
      checkpoint's own and the currently-open project's), so no new server
      route was needed. It's deliberately the reverse direction of
      pipeline.ts's existing `computeImpact` (which reports what a build
      newly ADDS going forward, for the AI Team screen): this one reports
      which entities present now are missing from the checkpoint (would be
      removed) and which fields on entities that survive would be removed
      too.

      Along the way, adding a second button per checkpoint row broke an
      existing test's `.checkpoint-list button` selector (it silently
      started clicking the new toggle instead of Restore) -- fixed by
      giving the restore button its own `.checkpoint-restore-btn` class,
      a real, if narrowly-scoped, regression this round's own change caused
      and fixed before moving on, not just a pre-existing gap.

      Verified with the deliberate-break-and-restore discipline: inverted
      the field-removal filter's condition (`checkpointFieldNames.has`
      instead of `!checkpointFieldNames.has`), confirmed every one of the 5
      new `computeCheckpointDiff` tests failed with exactly the wrong
      fields reported as removed -- restored, confirmed a clean re-run.
      **And** a full Playwright pass against the real running dev server:
      built a real CRM, refined it with "Add invoice tracking" (a real
      structural change -- a recognized domain-entity keyword this
      heuristic engine actually acts on, unlike a plain-English field
      request it doesn't parse, discovered by first trying and disproving a
      weaker instruction), opened Time Machine, expanded "What would
      change?" on the pre-refine checkpoint and confirmed it correctly named
      the real new "Invoice" entity as something that would be removed, and
      confirmed the post-refine checkpoint (matching the current spec
      exactly) correctly reported "No changes" instead. Full suite green
      (521 tests, up from 515 -- `@forge/web` 159 → 165; `@forge/db`/
      `@forge/api` unchanged, purely client-side) and both builds clean.

- [x] **Round 136 — confirmation before removing a project collaborator.**
      A fourth different screen in a row (home screen rounds 130-133,
      Business Twin 134, Time Machine 135, now Collaborators) -- and a real,
      genuine safety gap found by reading the panel's own code: every other
      truly destructive action in this app (deleting a project, round 123;
      deleting a record, round 73) is gated behind a confirm dialog, but
      removing a collaborator was the one place left where a single click
      instantly revoked someone's access, with no "are you sure?" at all.

      Fixed by mirroring `handleDeleteProject`'s own exact
      `window.confirm(...)` pattern, naming the actual person being removed
      in the message (not a generic "remove this collaborator?").

      Verified with the deliberate-break-and-restore discipline: removed
      the confirm gate entirely, confirmed the new test (declining a
      confirm must leave the collaborator and the server untouched) failed
      because there was no confirm message to assert on at all -- restored,
      confirmed the diff matched only the intended change. **And** a full
      Playwright pass against the real running dev server using
      Playwright's own native `page.on("dialog")` handling -- not a
      `window.confirm` mock, the actual browser-native confirm() dialog:
      signed up two real accounts, had the owner invite the second as a
      collaborator, clicked Remove and dismissed the real dialog (confirmed
      the collaborator stayed listed, and confirmed the dialog's own message
      named their real email), clicked Remove again and accepted it this
      time (confirmed they were actually removed), then reloaded and
      reopened the project to confirm the removal genuinely persisted
      server-side. Full suite green (523 tests, up from 521 -- `@forge/web`
      165 → 167; `@forge/db`/`@forge/api` unchanged, purely client-side) and
      both builds clean.

- [x] **Round 137 — show each WhatsApp message's real timestamp in the log.**
      A fifth different screen in a row (home screen, Business Twin, Time
      Machine, Collaborators, now WhatsApp) -- and, like round 136, a real
      gap found by reading the panel's own code rather than guessing:
      `WhatsAppMessageLogEntry` has always carried a genuine `createdAt`
      (stamped by `insertWhatsAppMessage` on every insert), but the log
      row's own markup never rendered it at all -- a message history with
      no visible time information is strictly less useful than any real
      chat log.

      Added it as a locale-formatted, non-wrapping timestamp at the end of
      each row, matching the exact same `LOCALE` map + `toLocaleString`
      pattern this file's own HistoryPanel/CollaboratorsPanel already use.

      Verified with the deliberate-break-and-restore discipline: removed
      the new timestamp span, confirmed the new test failed with "expected
      a timestamp element in the message log row" -- restored, confirmed
      the diff matched only the intended change. **And** a real-browser
      Playwright pass with an honest, disclosed limitation: a genuine
      WhatsApp connection needs a real phone to scan a QR code (not
      possible in this environment), and the panel's own pre-existing
      architecture only ever fetches the message log once actually
      connected -- neither of which this round's change touches. Rather
      than skip real-browser verification, intercepted just the two
      WhatsApp API calls at the network level (`page.route`) so the real
      component tree still mounted, fetched, and rendered in a genuine
      Chromium layout engine: confirmed the exact real timestamp string
      appeared exactly matching `toLocaleString`'s own output, and used
      `getBoundingClientRect`/`getComputedStyle` to confirm the real
      browser's flex layout keeps it on one line (`white-space: nowrap`,
      not wrapped across rows) -- the kind of layout fact only a real
      layout engine, not jsdom, can confirm. Full suite green (524 tests,
      up from 523 -- `@forge/web` 167 → 168; `@forge/db`/`@forge/api`
      unchanged, purely client-side) and both builds clean.

- [x] **Round 138 — a Columns menu to hide/show table columns per entity.**
      A sixth different screen in a row (home screen, Business Twin, Time
      Machine, Collaborators, WhatsApp, now the Entity/Records table) --
      found by reading EntityPanel.tsx itself rather than guessing: a wide
      entity (a CRM's "Customer" with name/email/phone/status/source/notes,
      or any of this project's other multi-field domain entities) always
      renders every single field as a table column with no way to trim it
      down, unlike the flexibility the view already has elsewhere (search,
      status filter, sort, board/calendar view).

      Added a "Columns" toggle button in the toolbar that opens a small
      checkbox panel, one row per field. Unchecking a field drops its
      column from the table immediately -- both the header and every row's
      cell for it. Deliberately scoped to the table view only: CSV export
      and the single-record print sheet (round 131) still always include
      every field, since those are whole-record actions, not "what's
      currently on screen" -- documented as such directly in the code so a
      future reader doesn't assume it's an oversight. The choice persists
      per project+entity via a new `columnVisibility.ts` module, a direct
      structural match to the existing `pinnedProjects.ts` (round 132)
      convention: try/catch-wrapped localStorage reads/writes, a pure
      toggle function returning the new set so the caller never has to
      re-read storage. Guarded so the table can never end up with zero
      columns: hiding the last remaining visible field is a no-op.

      Verified with the deliberate-break-and-restore discipline: commented
      out the `writeStore(store)` call inside `toggleFieldVisibility` (so
      the toggle would still work in memory but never actually persist),
      re-ran both the new `columnVisibility.test.ts` suite and the new
      EntityPanel persistence test -- exactly the two tests asserting a
      real storage round-trip failed, with the precise logical mismatch
      (a fresh mount still showing 4 header columns instead of the
      expected 3, i.e. the hidden column silently came back), while every
      other test (including the new no-op-guard test, which doesn't touch
      persistence) kept passing. Restored the file, confirmed via `diff`
      against a pre-break copy that it matched byte-for-byte, and confirmed
      `git diff --stat` showed only the intended six files. **And** a full
      Playwright pass against the real running dev server in a real
      Chromium browser: signed up a real account, built a real CRM app
      (a genuine 6-field "Customer" entity), opened the Columns menu,
      hid the second field, and confirmed the real table's actual header
      count dropped from 8 to 7 and the hidden field's own label was
      truly gone from the header's real text content (not just visually
      hidden) -- then did a full page reload (`page.reload()`, a real
      navigation, not a client-side route change) and reopened the same
      project the way a returning user would, confirming the header count
      was still 7: the hidden-column choice survived a genuine browser
      reload via real localStorage, not just in-memory component state.
      Full suite green (530 tests, up from 524 -- `@forge/web` 168 → 174;
      `@forge/shared`/`@forge/spec-engine`/`@forge/db`/`@forge/api`
      unchanged, purely client-side) and both builds clean.

- [x] **Round 139 — show each project's creation date on its home screen
      card.** Back to a different screen again (Entity table was round
      138) -- "Your projects" had already grown pin/favorite (132) and
      search (133), but every card still showed only the project's own
      name. With several projects on screen there was no way to tell at a
      glance which one was recent (today's work) and which was from
      months ago, without opening each one -- `Project.createdAt` has
      always existed on every project since the very first round, just
      never surfaced on the card itself.

      Added a small "Created on <date>" line under the name, reusing the
      exact same `LOCALE` map + `toLocaleDateString` convention already
      used by HistoryPanel/CollaboratorsPanel/WhatsAppPanel (round 137).
      The formatting call itself was pulled out into a small exported
      `formatProjectCreatedDate(createdAt, lang)` function rather than
      left inline in the JSX, matching this same file's own
      `summarizeRefineImpact`/`filterAndSortProjects` (round 133)
      convention of keeping anything worth testing directly importable.

      Verified with the deliberate-break-and-restore discipline: made the
      function silently ignore its own `lang` argument and always format
      in `en-US`, re-ran the new test -- it failed with the exact expected
      mismatch (asserting the real `he-IL` string, e.g. "15.3.2026", got
      back the English "3/15/2026" instead), restored the file, and
      confirmed via `git diff` that only the intended change remained.
      **And** a full Playwright pass against the real running dev server:
      signed up a real account, built a real app, confirmed the home
      screen's project card showed today's actual date (matching a live
      `toLocaleDateString("en-US")` computed independently in the test
      script, not a hardcoded string) -- then switched the real UI to
      Hebrew via the language switcher and confirmed the SAME card
      re-rendered with a genuinely different, real Hebrew-locale date
      format ("נוצר ב-24.9.2026"), not a stale or identical string, proving
      the `lang` argument actually drives the real rendered output, not
      just the isolated unit test. Full suite green (531 tests, up from
      530 -- `@forge/web` 174 → 175; `@forge/shared`/`@forge/spec-engine`/
      `@forge/db`/`@forge/api` unchanged, purely client-side) and both
      builds clean.

- [x] **Round 140 — a live elapsed timer on the AI Team build screen.**
      A genuinely different screen from the last five (Time Machine,
      Collaborators, WhatsApp, Entity table, Your projects) -- read
      `BuildProgress.tsx` fresh since it hadn't been touched in a long
      time, and found a real gap: a multi-agent build can take a real,
      noticeable stretch of wall-clock time, but the screen never showed
      how long it had actually been running. Someone watching a build that
      takes 20+ seconds has no way to tell "still genuinely working" from
      "silently stuck" -- the per-step captions update, but there was no
      running clock anywhere.

      Added a `formatElapsedTime(ms)` helper (m:ss, zero-padded seconds,
      clamped to zero for any negative/clock-skew input) and a ticking
      "⏱️ 0:07" display next to the existing "Step X of N" subtitle,
      updating once a second via `setInterval` while the build runs. The
      trickier part: freezing it at the EXACT final duration the instant
      the build finishes, rather than drifting up to a second past the
      real finish time waiting for the next tick, or (the regression this
      guards against) never stopping at all and continuing to climb for
      the rest of the page's lifetime after the build is long done.

      Verified with the deliberate-break-and-restore discipline: removed
      the `finished` early-return + freeze so the interval never stopped,
      re-ran the new test -- it failed exactly as expected (asserting the
      timer stayed at "0:10" after the build finished, it kept climbing to
      "0:15"), restored the file, confirmed via `diff` against a pre-break
      copy that it matched byte-for-byte. The regression test itself uses
      `node:test`'s own fake timers (`t.mock.timers.enable({ apis:
      ["setInterval", "Date"] })`) to deterministically tick through 3s,
      then 10s of simulated time while "running", confirm the freeze
      happens the instant a controlled `run()` promise resolves, then tick
      5 MORE simulated seconds and confirm the displayed time genuinely
      never moved -- proving the interval itself stopped, not just that
      the display happened to look right at one moment. **And** a real
      Playwright pass against the real running dev server: signed up,
      started a real build, and read the real DOM element (not a mock)
      immediately after clicking "Build the app" -- confirmed a real
      `⏱️ m:ss`-shaped reading and a real `aria-label="Time elapsed"` were
      present on the actual rendered timer, and that the whole real build
      completed end to end with the new `setInterval`-driven effect
      running alongside it and zero page errors. (This dev pipeline's
      deterministic, non-AI build steps finish and unmount the build
      screen in well under a second, too fast for a real click-through run
      to reliably catch a live *second* tick the way the fake-timer unit
      test deterministically does -- documented honestly in the script
      itself, with the actual tick-by-tick and freeze behavior covered
      rigorously by that unit test instead.) Full suite green (533 tests,
      up from 531 -- `@forge/web` 175 → 177; `@forge/shared`/
      `@forge/spec-engine`/`@forge/db`/`@forge/api` unchanged, purely
      client-side) and both builds clean.

- [x] **Round 141 — Business Twin's stat tiles jump straight to that
      entity.** Back to Business Twin (last touched round 134) with a
      fresh gap found by reading its own code: each stat tile ("Customers
      · 12") was inert display text, not a control. Seeing a count and
      wanting to actually look at those records meant closing the whole
      Business Twin panel and hunting for the right tab yourself --
      despite `GlobalSearchPanel` already having exactly this
      "click something, jump straight to that entity's tab, close the
      overlay" pattern (`onJumpToEntity`) for its own search results.

      Made each tile a real `<button>` with its own `aria-label` naming
      which entity it jumps to, wired through a new `onJumpToEntity` prop
      that mirrors `GlobalSearchPanel`'s own call site in `App.tsx`
      exactly: `setActiveEntity(entityName)` then close the panel. CSS
      needed a few explicit overrides (`color: inherit`, `font-weight:
      normal`, a custom `:hover` rule) since turning a plain `<div>` into
      a `<button>` picks up this file's own global button reset
      (accent-colored background, bold text) that would otherwise clash
      with the tile's existing custom look.

      Verified with the deliberate-break-and-restore discipline: changed
      the click handler to pass the tile's display LABEL ("Orders")
      instead of its real entity NAME ("Order") -- a genuinely plausible
      mistake, since both are visible on the same tile -- re-ran the new
      test, which failed with exactly that mismatch, restored the file,
      confirmed via `diff` against a pre-break copy that it matched
      byte-for-byte. **And** a full Playwright pass against the real
      running dev server: built a real 2-entity CRM (Customer + Deal),
      opened the real Business Twin panel, read the SECOND tile's own
      label off the real DOM (not hardcoded), clicked it, and confirmed
      three independent real facts -- the twin overlay actually unmounted
      (`.twin-panel` gone, not just visually hidden), the "Deal" entity
      tab (matching the clicked tile, not a coincidence) became the real
      active tab, and its own record form rendered underneath. Full suite
      green (535 tests, up from 533 -- `@forge/web` 177 → 179;
      `@forge/shared`/`@forge/spec-engine`/`@forge/db`/`@forge/api`
      unchanged, purely client-side) and both builds clean.

- [x] **Round 142 — confirm before restoring a Time Machine checkpoint.**
      Back to Time Machine (last touched round 135), flagged explicitly as
      a candidate gap in round 141's own trigger notes and confirmed real
      by reading `HistoryPanel.tsx` fresh: clicking "Restore" fired the
      real API call immediately, with zero confirmation -- the only
      real destructive-feeling action left in this app without one
      (deleting a project, round 123; removing a collaborator, round 136,
      both already have this exact gate). The "What would change?" diff
      toggle (round 135) already lets you preview the effect first, but
      nothing stopped clicking Restore without ever opening it.

      Added the identical `window.confirm(...)` gate this codebase already
      uses elsewhere, naming the checkpoint's own label. Changed
      `handleRestore`'s signature from taking a bare `checkpointId` to
      the full `Checkpoint` object, since the confirm message needs its
      `label` too and the call site already has the whole object in hand
      from the render loop.

      Verified with the deliberate-break-and-restore discipline: called
      `window.confirm(...)` but stopped checking its return value (a
      genuinely plausible mistake -- the dialog would still visibly pop up,
      just do nothing with the answer), re-ran the new test -- it failed
      exactly as expected (the restore API was called even after declining),
      restored the file, confirmed via `diff` against a pre-break copy that
      it matched byte-for-byte. Also had to fix one pre-existing test (the
      round-135 concurrency regression test) that clicked Restore without
      ever expecting a confirm dialog -- added the same `window.confirm =
      () => true` mock this file's own new test and CollaboratorsPanel's
      (round 136) already use, since that test's actual concern is the
      concurrency guard, not the new dialog. **And** a full Playwright pass
      against the real running dev server using Playwright's own native
      `page.on("dialog")` handling, not a mock: built a real app, ran a
      real refine ("add invoice tracking") to get a second real checkpoint,
      opened Time Machine, clicked Restore and DISMISSED the real
      browser-native dialog -- confirmed its exact real message text named
      the checkpoint, and confirmed the checkpoint list was genuinely
      unchanged afterward -- then clicked Restore again and ACCEPTED it,
      confirming the panel actually closed and the real preview screen
      came back. Full suite green (536 tests, up from 535 -- `@forge/web`
      179 → 180; `@forge/shared`/`@forge/spec-engine`/`@forge/db`/
      `@forge/api` unchanged, purely client-side) and both builds clean.

- [x] **Round 143 — show when each refine happened in the refine history
      log.** A genuinely different screen from the last five (Entity
      table, Your projects, AI Team build, Business Twin, Time Machine) --
      the refine/chat pane, barely touched since its original rounds 34-35.
      Found by reading `App.tsx`'s own `RefineHistoryEntry` interface: it
      had `id`/`instruction`/`summary` but no timestamp at all, so a
      session with several refines ("Add invoice tracking", then later
      "Add a status field") gave no way to tell which happened five
      minutes ago and which was the very first one from an hour earlier --
      the exact same class of gap round 137 (WhatsApp messages) and round
      139 (project cards) already fixed elsewhere in this app.

      Added a `completedAt` field, stamped with `new Date().toISOString()`
      at the exact moment `handleBuildComplete` builds the entry (right
      alongside the existing `summarizeRefineImpact` call), and a small
      exported `formatRefineTimestamp(completedAt, lang)` helper --
      `toLocaleString` (date AND time, since multiple refines can land on
      the same day, unlike `formatProjectCreatedDate`'s date-only need) --
      matching this file's own established convention of keeping anything
      JSX-displayed directly testable.

      Verified with the deliberate-break-and-restore discipline: made the
      new helper ignore its own `lang` argument and always format in
      `en-US`, re-ran the new test -- it failed with the exact expected
      mismatch (asserting the real `he-IL` string, got the English one
      back instead), restored the file, confirmed via `diff` against a
      pre-break copy that it matched byte-for-byte. **And** a full
      Playwright pass against the real running dev server: signed up,
      built a real app, ran a real refine ("add invoice tracking"),
      confirmed exactly one real history entry appeared with a real
      timestamp -- parsed the rendered string back into a real `Date` and
      confirmed it landed within the actual wall-clock window the refine
      ran in (not a stale or hardcoded value) -- then switched the real UI
      to Hebrew and confirmed the SAME entry re-rendered with a genuinely
      different Hebrew-locale format ("24.9.2026, 7:19:59"), proving the
      `lang` argument really drives the rendered output end to end, not
      just the isolated unit test. Full suite green (537 tests, up from
      536 -- `@forge/web` 180 → 181; `@forge/shared`/`@forge/spec-engine`/
      `@forge/db`/`@forge/api` unchanged, purely client-side) and both
      builds clean.

- [x] **Round 144 — a Back button on the spec-review screen.** A genuinely
      different screen from the last five (Your projects, AI Team build,
      Business Twin, Time Machine, refine/chat) -- the "Here's what we
      understood" spec-review step, barely touched since its original
      rounds 27/29. Found by reading `App.tsx`'s own view-transition wiring:
      the ONLY way out of this screen was forward, via "Build the app" --
      changing your mind about the idea (a typo, the wrong idea entirely,
      wanting to reconsider the generated entities first) meant logging out
      entirely, or hoping the browser's own back button didn't leave the
      SPA in some broken half-state. Every other screen in this app already
      has a real way back (`BuildProgress`'s own `onBack`, `HistoryPanel`/
      `BusinessTwinPanel`/etc.'s close buttons) -- this was the one
      genuinely stranded screen.

      Added a real "Back" button next to "Build the app", wired to a new
      `handleBackToHome` that does a careful, non-destructive reset:
      switches the view home, clears the now-abandoned draft project from
      state along with its own `selectedAnswers`/`additionalRequest` (tied
      specifically to that draft's own open questions, not whatever gets
      created next) -- but deliberately leaves `description` untouched, so
      the idea text already typed is still sitting in the textarea, ready
      to tweak and resubmit rather than retyped from scratch. The draft
      project itself is never deleted server-side -- `createProject` had
      already made it real, and (confirmed by reading `listProjectsForUser`)
      it stays fully reachable and re-openable from "Your projects", the
      exact same as any other never-built draft; the existing Delete button
      there is already the honest way to clean it up if unwanted, matching
      this app's "never silently delete data" convention seen throughout.

      Verified with the deliberate-break-and-restore discipline: dropped
      the `setSelectedAnswers({})` call (a genuinely plausible one-line
      omission among four reset calls), re-ran the new test -- it failed
      with the exact expected leftover state (`{"Which plan?": "Pro"}`
      surviving instead of being cleared), restored the file, confirmed via
      `diff` against a pre-break copy that it matched byte-for-byte. **And**
      a full Playwright pass against the real running dev server: signed
      up, described a real idea, landed on the real spec-review screen with
      a real draft project already created server-side, clicked the real
      Back button, confirmed landing back on the real home screen with the
      exact same description text still pre-filled in the textarea -- then
      confirmed the abandoned draft genuinely still appeared in "Your
      projects" (not silently deleted), and that reopening it correctly
      routed back to spec review with its own spec intact, exactly as a
      draft-status project always has. Full suite green (538 tests, up
      from 537 -- `@forge/web` 181 → 182; `@forge/shared`/
      `@forge/spec-engine`/`@forge/db`/`@forge/api` unchanged, purely
      client-side) and both builds clean.

- [x] **Round 145 — a matched WhatsApp sender's name jumps to their
      record.** Back to WhatsApp (last touched round 137), a fresh gap
      found by reading the panel's own types: `matchedEntityName`/
      `matchedRecordId` have always been stamped on every message (see
      `packages/db/src/whatsapp.ts`) whenever the incoming number matches
      a real record, and `matchedLabel` already rendered as the row's
      "who" text -- but that text was always inert. Seeing "Dana Levi"
      sent a message and wanting to actually look at her record meant
      closing the whole panel and hunting for the right entity tab
      yourself, despite `BusinessTwinPanel` already having exactly this
      "click something, jump to that entity's tab, close the overlay"
      pattern (`onJumpToEntity`, round 141) for its own stat tiles.

      Made a matched sender's name a real `<button>` (an unmatched
      sender -- no known record -- stays plain, inert text, since there's
      nothing to jump to), wired through a new `onJumpToEntity` prop that
      mirrors `App.tsx`'s existing Business Twin call site exactly. CSS
      needed the same explicit overrides round 141 already established
      (`background: none`, `font: inherit`, etc.) to undo this file's
      global button reset without losing the underlined-link look.

      Verified with the deliberate-break-and-restore discipline: changed
      the click handler to pass the matched sender's display LABEL
      ("Dana Levi") instead of the real matched ENTITY NAME ("Customer")
      -- the same class of plausible mistake round 141's own regression
      test caught, since both are visible on the same message -- re-ran
      the new test, which failed with exactly that mismatch, restored the
      file, confirmed via `diff` against a pre-break copy that it matched
      byte-for-byte. **And** a full Playwright pass against the real
      running dev server: built a real 2-entity CRM (Customer + Deal),
      and -- since a real WhatsApp connection needs an actual phone to
      scan a QR code, not possible here -- intercepted just the two
      WhatsApp API calls with `page.route()` (the same honest substitute
      round 137 already established) so the real component still mounted
      and rendered in a genuine Chromium layout engine: read the real
      matched sender's name off the real DOM, clicked it, and confirmed
      two independent real facts -- the WhatsApp overlay actually
      unmounted (`.whatsapp-panel` gone, not just visually hidden), and
      the "Customer" entity tab (matching the clicked message, not a
      coincidence) became the real active tab. Full suite green (539
      tests, up from 538 -- `@forge/web` 182 → 183; `@forge/shared`/
      `@forge/spec-engine`/`@forge/db`/`@forge/api` unchanged, purely
      client-side) and both builds clean.

- [x] **Round 146 — a "Today" button on the entity calendar view.** Back
      to the Entity table screen (last touched 8 rounds ago at round 138,
      with the Columns menu), a fresh gap found by reading `CalendarView`
      inside `EntityPanel.tsx`: it already had prev/next month navigation
      (round 49), but no way to jump straight back to the current month
      once you'd paged away -- you had to click prev/next repeatedly, one
      month at a time, with nothing marking how far you'd wandered.

      Added a "Today" button to the calendar nav, disabled exactly when
      it would be a no-op (already showing the current month), driven by
      a new pure `isSameMonth(a, b)` helper in `entityFormatting.ts`
      alongside the file's existing private `isSameDay`. Clicking it
      resets `calendarMonth` state straight to `new Date()`, the same
      state `onPrevMonth`/`onNextMonth` already drive.

      Verified with the deliberate-break-and-restore discipline, twice:
      first narrowed `isSameMonth` to compare only `getMonth()` (dropping
      the year check) -- a genuinely plausible mistake, since two dates a
      year apart in the same calendar month look identical at a glance --
      re-ran the unit tests, which failed on exactly the same-month/
      different-year case; restored and confirmed via `diff` against a
      pre-break copy that the file matched byte-for-byte. Then separately
      dropped `disabled={isCurrentMonth}` from the button's own JSX --
      re-ran the new real-DOM test, which failed on the "must start
      disabled" assertion; restored and confirmed the same byte-for-byte
      match. **And** a full Playwright pass against the real running dev
      server: signed up, built a real app from "Manage appointments with
      clients, including the appointment date, client name, and notes"
      (the heuristic spec-engine produced a real 2-entity app -- Customer
      and Appointment), switched to the Appointment entity's tab (the
      one with a real `date` field), opened its calendar view, paged
      forward two real months, clicked the real Today button, and
      confirmed the actual DOM month label returned to "September 2026"
      and the button disabled itself again -- not a mock, an actual
      round trip through the real heuristic spec generator, the real
      build pipeline, and a real Chromium render. Full suite green (542
      tests, up from 539 -- `@forge/web` 183 → 186; `@forge/shared`/
      `@forge/spec-engine`/`@forge/db`/`@forge/api` unchanged, purely
      client-side) and both builds clean.

- [x] **Round 147 — port the calendar "Today" button to the exported
      codegen app.** Round 146 added a Today button to the live-preview
      `EntityPanel`'s calendar view, but the exported (downloadable)
      standalone app has its own entirely separate `CalendarView`
      implementation inside `codegen.ts` -- a genuinely different area
      of the codebase from anything touched in rounds 142-146, and one
      this project has an established, repeated pattern of following up
      on (calendar view itself: round 49 → 50; board view: 47 → 48; CSV
      export/import, bulk actions, "Duplicate record", etc., all got the
      same live-preview-then-codegen two-step). Without this round, a
      person who exported their app after round 146 would get a
      calendar view stuck one round behind the one they'd actually used
      and liked.

      Added `isSameCalendarMonth(a, b)` right next to the file's
      existing `isSameCalendarDay`, and wired an identical Today button
      into the generated `CalendarView`'s nav -- same disabled-when-
      already-current-month behavior, same `onToday` prop threaded
      through from the `calendarMonth` state setter at the render call
      site. The exported app's own CSS turned out simpler than the
      live-preview app's: `.calendar-nav button` there was never
      wrapped in the aggressive global `button` reset that round 141/
      145/146 all had to fight with explicit overrides, so this needed
      only a small `.calendar-today-btn:disabled { opacity: 0.55; }`
      rule, matching the export's own existing `.csv-export-btn:disabled`
      convention.

      Verified with the deliberate-break-and-restore discipline, twice:
      first narrowed `isSameCalendarMonth` to compare only `getMonth()`
      (dropping the year check, the exact same class of mistake round
      146 tested) -- re-ran the new test, which failed on the same-
      month/different-year case; restored and confirmed via `diff`
      against a pre-break copy that the file matched byte-for-byte. Then
      separately dropped `disabled={isCurrentMonth}` from the generated
      button's own JSX -- re-ran the JSX-wiring test, which failed on
      the same assertion; restored and confirmed the same byte-for-byte
      match. **And** the strongest verification this codegen feature
      can get: generated a real export for a project with an
      "Appointment" entity, ran a real `vite build` of it (the literal
      command the export's own package.json promises, not a mock),
      spawned the real generated `server.js`, and drove the actual
      running app with real Playwright/Chromium -- filled in and
      submitted the real record form, opened the real calendar view,
      paged forward two real months, clicked the real Today button, and
      confirmed the actual DOM month label returned to "September 2026"
      and the button disabled itself again, against the literal
      standalone app a person receives from the Export button, not the
      live-preview app. Full suite green (544 tests, up from 542 --
      `@forge/api` 183 → 185; `@forge/shared`/`@forge/spec-engine`/
      `@forge/db`/`@forge/web` unchanged) and both builds clean.

- [x] **Round 148 — port the "Columns" menu to the exported codegen
      app.** A second live-preview-then-codegen follow-up in a row,
      found by systematically checking round 138's "Columns" menu
      (hide/show individual table columns, persisted in localStorage)
      against `codegen.ts`'s own separate `EntityView.jsx` table
      implementation -- `grep`-ing for "Columns"/"columnVisibility"
      there came back empty, confirming this feature had been
      live-preview-only for 10 rounds. Same underlying gap as round 147,
      different feature and a genuinely different part of the table UI
      (column management, not the calendar view).

      Added `getHiddenColumns`/`toggleColumnVisibility` (localStorage-
      backed, right next to `emptyForm` at module scope) and a
      `visibleFields` memo, wired a Columns button/menu into the
      toolbar next to Export CSV, and swapped `entity.fields.map` for
      `visibleFields.map` in the table header and body. Scoped
      persistence by entity name alone rather than project+entity like
      the live-preview app's own `columnVisibility.ts` -- this
      single-tenant exported app has no project id to scope by in the
      first place. CSV export deliberately kept reading `entity.fields`
      instead of `visibleFields`, matching the live-preview app's own
      "CSV export is a whole-record action; hiding a column is just a
      table-view preference" rule (confirmed by a regression test
      reading `handleExportCsv`'s own extracted source).

      Verified with the deliberate-break-and-restore discipline, twice:
      first made `toggleColumnVisibility` write to a shared `store.all`
      key instead of `store[entityName]` -- a genuinely plausible
      copy-paste slip that would leak one entity's hidden columns into
      every other entity's table -- re-ran the new persistence test,
      which failed on exactly that; restored and confirmed via `diff`
      against a pre-break copy that the file matched byte-for-byte.
      Then separately made `handleExportCsv` read `visibleFields`
      instead of `entity.fields` -- re-ran the static-check test, which
      failed on the same assertion; restored and confirmed the same
      byte-for-byte match. **And** the strongest available proof: a
      real export, a real `vite build`, a real spawned `server.js`,
      and real Playwright/Chromium against it -- added a real customer
      record, opened the real Columns menu, unchecked "Email", watched
      the real DOM table actually drop that column, reloaded the real
      page and confirmed the hidden state survived (a genuine
      localStorage round trip, not a mock), then clicked the real
      Export CSV button and read the downloaded file to confirm the
      hidden Email column was still there, exactly as the whole-record-
      action rule promises. Full suite green (546 tests, up from 544 --
      `@forge/api` 185 → 187; `@forge/shared`/`@forge/spec-engine`/
      `@forge/db`/`@forge/web` unchanged) and both builds clean.

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
