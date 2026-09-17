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
