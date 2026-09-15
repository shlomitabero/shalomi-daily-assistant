# Product quality audit

Performed in response to a direct request to benchmark this platform
against Lovable/Base44/Replit/Bolt/v0 and close real gaps, starting from
an honest look at what exists today rather than a rewrite. Methodology:
ran the real app end to end (signup → describe → answer questions →
build → preview → entity CRUD) with a real browser (Playwright) at
mobile (390px), tablet (768px) and desktop (1440px) widths, screenshotted
every major screen, checked the browser console for real errors, and read
the relevant source. This is not a checklist filled in from memory — every
finding below was seen on screen or in code before being written down.

This audit does not attempt to score the platform against all ~123 items
of the founding prompt in one pass. It records what was actually found,
categorized honestly, and this repository's own recurring improvement
process (see `docs/roadmap.md`) works down the list one real, verified
item at a time — the same discipline used for every feature already
shipped here.

## What already works (not re-litigated below)

Real auth, a real multi-agent build pipeline with genuinely verifiable
per-step work (not timed placeholders), additive-only migrations with a
real Time Machine, a natural-language Refine loop, an open-ended
answers/request box on the spec review screen, a Debug Agent that
attempts real self-repair on migration failures, a real multi-file React
codebase export, and a Business Twin based on real record counts. Mobile
layout, RTL correctness, and table overflow were already fixed in earlier
passes and were re-checked here — still correct.

## Findings

### P0 — none found

No broken core flow, dead button, or fake-success state was found in this
pass. Signup, describe, answer, build, CRUD, refine, export, and Time
Machine all worked as claimed, on every viewport tested, with zero
browser console errors traceable to the app itself (the only console
error seen — a `ERR_CERT_AUTHORITY_INVALID` on the Google Fonts
stylesheet — is this sandboxed environment's proxy intercepting an
external font request, not an application bug).

### P1 — real, fixable quality gaps

1. **Generic placeholder seed data (fixed in this pass).** Every freshly
   built app's first screen showed rows like "לקוחות - שם 1" / "Customer
   phone 2" — literally the "Test Test" / "Lorem Ipsum" pattern item #79
   of the founding prompt calls out by name. This is the single most
   visible "feels unfinished" signal in the entire product, because it's
   what a user sees the moment their app finishes building. Fixed by
   giving `packages/db/src/seed.ts` real, believable value pools (person
   names, emails, phone numbers, marketing sources, job roles, item/plan
   names) keyed off each field's actual name, with context (e.g. the same
   `name` field means a person for `Customer`/`Employee` but a catalog
   item for `Service`/`Product`). Verified with new unit tests and live in
   a real browser across three entity types (Customer, Appointment,
   Employee) — see the "Add believable seed data" commit.

2. **No bilingual (Hebrew + English) support at all — Steps 1–3 fixed,
   more screens still open.** There was no i18n architecture in this
   codebase at all (`grep` for `i18n`/`locale`/`translation` across
   `apps/web/src` returned nothing): every user-facing string was
   hardcoded Hebrew JSX text, with no language switcher and no LTR path.
   The founding prompt marks this "CRITICAL," correctly. Given the size of
   this change, it's being done as a sequence of real steps rather than
   rushed in one pass — see ADR 0006. Done so far: the i18n architecture
   itself (dictionary, context, hook, language switcher, a real
   `dir`/`lang` flip, `{placeholder}` interpolation for strings like "Step
   2 of 6"), the pre-auth screen, the topbar chrome, the home screen, the
   full spec review screen, and the AI Team build screen (all 7 agents'
   captions and their expandable detail panels) — all verified live in a
   real browser with zero page errors, including actually catching and
   reading the live in-progress build screen mid-build, not just its
   start and end states. **Still open:** the preview/entity panel,
   History, and Business Twin panel all still show hardcoded Hebrew
   regardless of the selected language — each is a queued next step in
   `docs/roadmap.md`.

3. **Desktop screens with little content leave a large, unstyled empty
   void below the fold** (seen clearly on the auth screen and the "מה
   תרצו לבנות?" home screen at 1440px). The content container is
   correctly centered, but nothing anchors the page visually once the
   viewport is taller than the content — no hero treatment, no background
   texture, nothing. This reads as "generic/unfinished" per the founding
   prompt's own language, though it doesn't block any functionality. Not
   fixed in this pass — real visual design work (not a quick CSS
   tweak) belongs in its own pass so it gets done properly rather than
   patched.

### P2 — minor polish, not fixed in this pass

- On mobile (390px), the Refine box's input placeholder text gets visibly
  clipped because the input and its submit button share one row with a
  160px input minimum — the box still functions correctly once you start
  typing, this is cosmetic only.
- No dark mode toggle is exposed in the UI yet, even though
  `styles.css` already defines dark-mode-ready CSS custom properties in
  several places — the token system exists but isn't switchable by the
  user today.

## What this audit deliberately did not do

It did not implement items 1–123 of the founding prompt as a checklist.
Most of those items (a visual drag-and-drop editor, a workflow builder, a
command palette, an integrations marketplace, an autonomous daily
"Software Manager," multi-persona simulated QA, and others) describe a
materially larger product than what a single further session can honestly
build and verify end-to-end. Claiming otherwise — or writing the code
without running and checking it in a real browser — would repeat exactly
the "amateur feeling" failure mode this audit exists to catch. Each real,
verifiable item from that list is a candidate for a future entry in
`docs/roadmap.md`, picked and shipped one at a time with the same
verification discipline as everything else in this repository.
