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

2. **No bilingual (Hebrew + English) support at all — now fixed, every
   screen converted.** There was no i18n architecture in this codebase at
   all (`grep` for `i18n`/`locale`/`translation` across `apps/web/src`
   returned nothing): every user-facing string was hardcoded Hebrew JSX
   text, with no language switcher and no LTR path. The founding prompt
   marked this "CRITICAL," correctly. Fixed as a sequence of real,
   individually-verified steps rather than rushed in one pass — see
   ADR 0006 for the architecture. Every screen is now converted and was
   verified live in a real browser: pre-auth, topbar, home, spec review,
   AI Team build, preview + entity panel, History panel, and Business
   Twin panel. A real bug was found and fixed along the way: checkpoint
   timestamps in the History panel were hardcoded to `he-IL` formatting
   regardless of the selected UI language. Browser-language
   auto-detection (Hebrew locale → Hebrew, else → English, stored
   preference always wins) is now enabled too, verified across 4 real
   browser locale contexts — see `docs/roadmap.md`. Server-side error
   messages are now localized too (a real user-reported incident showed a
   raw English "Internal server error" on an all-Hebrew page): every API
   error now carries a stable code the client translates, verified live
   in both a Hebrew and an English browser context — see
   `docs/roadmap.md`'s "Production hardening" section. No known i18n gaps
   remain.

3. **Desktop empty void below the fold — fixed.** The content container
   was correctly centered, but nothing anchored the page visually once
   the viewport was taller than the content, worst on the auth screen at
   1440px. Fixed with real design work, not a CSS patch: a subtle, fixed
   radial-gradient background (using the existing `--accent-soft`/
   `--steel-soft` tokens, so it adapts automatically in dark mode too)
   anchors every screen; the auth screen specifically gained a real
   two-column layout at ≥900px with a "What you get" panel — four
   genuine, honestly-scoped product claims (schema/API/screens
   generation, Time Machine, bilingual UI including error messages, code
   export), not filler copy. Verified live in a real browser at 1440px
   (desktop, both languages), 768px (tablet, confirmed it stacks single-
   column below the breakpoint) and 390px (mobile, confirmed no clipping)
   — RTL correctly mirrors the two-column order via the same direction-
   relative flexbox pattern this codebase already uses (see ADR 0006).
   Also confirmed the new background doesn't clash with content-heavy
   screens (spec review). Zero console errors in any of these checks.

### P2 — minor polish

- **Mobile Refine box placeholder clipping — fixed.** The input and its
  submit button shared one row with a 160px input minimum, visibly
  clipping the placeholder text on narrow viewports. Below 480px they now
  stack vertically (input gets the full row width), and the English/
  Hebrew placeholder copy was also shortened to a realistic short example
  ("add invoice tracking" / "להוסיף מעקב חשבוניות") so it fully fits
  without relying on the wider box alone. Verified live at 390px in both
  languages: the full placeholder text is now visible with room to
  spare, and confirmed no regression on desktop, where the chat pane's
  own narrow column width already wraps the same way. This closes the
  last open finding from the original audit.
- **Dark mode toggle — fixed.** `styles.css` already defined dark-mode-
  ready CSS custom properties (applied automatically via
  `prefers-color-scheme`), but there was no way for the user to switch
  manually. Added a real toggle (`ThemeSwitcher`, mirroring the existing
  `LanguageSwitcher`/`LanguageProvider` architecture in `theme/theme.ts` +
  `theme/ThemeContext.tsx`): an explicit choice always wins, otherwise it
  falls back to the system preference, persisted to `localStorage`. Shown
  in the topbar and on the auth screen. Verified: 3 new unit tests +
  live in a real browser — toggled to dark, confirmed `data-theme="dark"`
  on `<html>`, took real screenshots of both the auth and home screens
  showing correct dark styling, confirmed the choice survives a page
  reload, and checked mobile (390px) + Hebrew RTL together with the new
  switch button present — no clipping, correct layout, zero console
  errors.

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
