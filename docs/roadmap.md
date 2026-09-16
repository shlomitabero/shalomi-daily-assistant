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
      dark mode too, zero console errors. **Still not done, tracked as a
      follow-up:** porting bulk-select/delete into the exported
      standalone codegen output (`apps/api/src/codegen.ts`), matching
      the pattern used for the four earlier features.

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
