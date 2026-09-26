# ADR 0006: Bilingual (Hebrew + English) i18n architecture — Step 1

## Status

Accepted. First of several steps; the founding request and
`docs/product-quality-audit.md` both flag full bilingual support as the
platform's single largest remaining real gap.

## Context

`docs/product-quality-audit.md` confirmed the platform had zero i18n
architecture: every user-facing string was hardcoded Hebrew JSX, no
language switcher existed, and there was no LTR code path at all. This is
explicitly the "CRITICAL" item in the founding product prompt, and it is
real — Forge AI cannot honestly claim to be a serious bilingual product
while this is true.

Converting every screen in one pass was explicitly ruled out — the
recurring-improvement process this repository follows ships one real,
fully-verified step at a time, and a large cross-cutting UI change is
exactly the kind of thing that goes wrong when rushed. This ADR covers
Step 1: the architecture itself, plus the topbar chrome and the
authentication screen as the proof it actually works end to end.

## Decision

### No i18n library

`react-i18next` or similar was deliberately not added. At this app's
current size (a few dozen user-facing strings, two languages, no
pluralization/interpolation complexity yet) a library adds a dependency
and an API surface for a problem a ~60-line module solves directly —
consistent with this codebase's existing pattern of avoiding a dependency
where a small amount of well-tested code covers the need (see ADR 0001's
`node:sqlite` decision, ADR 0003's dependency-free ZIP writer). If string
count or pluralization complexity grows enough to justify a library
later, this can be revisited.

### Architecture

- `apps/web/src/i18n/language.ts` — pure, dependency-free, framework-free:
  `Lang` type, a flat `translations: Record<Lang, Record<string, string>>`
  dictionary, `translate(lang, key)` (falls back Hebrew → raw key, never
  throws on a missing key), `dirFor(lang)`, and `detectInitialLang`.
  Being pure functions with no React or DOM dependency, this is unit
  tested directly with `node:test` (no jsdom, no React Testing Library) —
  the same lightweight test approach already used everywhere else in this
  repo.
- `apps/web/src/i18n/LanguageContext.tsx` — a `LanguageProvider` holding
  the current `Lang` in React state, persisting it to `localStorage`
  (`forge.lang`) and setting `document.documentElement.lang`/`dir` in an
  effect whenever it changes, plus the `useTranslation()` hook exposing
  `{ lang, dir, t, setLang }` to any component in the tree.
- `apps/web/src/i18n/LanguageSwitcher.tsx` — the "עברית | EN" toggle,
  reused identically on the pre-auth screen and the authenticated topbar.

### Default language is always Hebrew, not browser-detected — for now

The founding prompt asks for browser-language auto-detection with a
user-preference override. That is deliberately **not** implemented yet:
since only the topbar chrome and the auth screen are converted so far, an
English-browser visitor auto-defaulting to English would see an
English-chrome, Hebrew-content mixed page on their very first visit —
strictly worse than staying consistently Hebrew. Until
enough screens are converted that the whole product is coherently
bilingual, `detectInitialLang` always returns `"he"` for a first-time
visitor; English is only ever reached by an explicit click on the
switcher. This is called out directly in the code comment, not hidden.

### RTL/LTR layout

`apps/web/src/styles.css` was already built entirely on CSS logical
properties (`text-align: start`, `padding-inline-start`, `flex-direction:
row`, which is direction-relative in flexbox) rather than physical
left/right values — confirmed during the audit before writing any new
code. This meant zero CSS changes were needed to make the existing
converted screens flip correctly for LTR; `dir` on `<html>` is the only
thing driving direction.

## What is and isn't converted yet

Converted, verified live: the pre-auth screen (title, subtitle, both
signup and login modes, field labels, buttons, mode toggle) and the
authenticated app's topbar chrome (tagline, logout button). **Not yet
converted**: the home/describe screen, the spec review screen, the AI
Team build screen, the preview/entity screens, History, and the Business
Twin panel — these still show hardcoded Hebrew regardless of the
selected language. This is tracked explicitly as the next items in
`docs/roadmap.md`, one screen (or a small group) per future cycle, using
the same architecture — no further infrastructure work should be needed,
just adding `t()` calls and dictionary keys per screen.

Also not yet handled: server-side error messages (e.g. failed
login/signup) are returned by the API in whatever language it happens to
use today and are not translated client-side.

## Verification performed

- `apps/web/src/i18n/language.test.ts`: 6 unit tests — `detectInitialLang`
  trusts a valid stored value and defaults to Hebrew for anything else;
  `dirFor` maps correctly; `translate` returns the right string per
  language and falls back correctly; a completeness check that every key
  in one language's dictionary also exists in the other (catches an
  untranslated string automatically instead of relying on manual review).
- `npm run build` (`tsc -b && vite build`) succeeds with the new context
  and hook wired into `App.tsx`.
- Live in a real browser (Playwright, real server): confirmed the default
  is Hebrew/RTL on first load; clicking "EN" switches `<html dir>` to
  `ltr` and `<html lang>` to `en`, translates the auth screen's title,
  subtitle, field labels and submit button live; a page reload keeps the
  English choice (localStorage persistence); switching back to Hebrew,
  signing up, and toggling the topbar switcher correctly translates the
  tagline and logout button and updates `dir`/`lang` again. Zero page
  errors in any of these steps.

## Consequences

- The product now has a real, working, if partial, bilingual foundation —
  not a mockup of one.
- Until more screens are converted, switching to English produces a
  visibly mixed-language experience past the topbar/auth — this is an
  accepted, documented, temporary state, not a hidden bug.
- Adding a new user-facing string anywhere in the app now has a clear,
  established pattern to follow (`t("area.key")` + both dictionary
  entries), rather than being a one-off decision each time.

## Update: browser-language auto-detection enabled

All screens (home, spec review, AI Team build, preview/entity, History,
Business Twin) were converted in the follow-up work this ADR anticipated
(`docs/roadmap.md`), removing the reason the "default Hebrew, not
browser-detected" decision above gave for deferring auto-detection —
there is no longer an unconverted screen that a browser-detected English
visitor could land on and see a mixed-language page.

`detectInitialLang` now takes an optional `browserLanguage` argument
(`LanguageProvider` passes `navigator.language`): an explicit stored
choice still always wins; otherwise a Hebrew browser locale (`he`,
`he-IL`, ...) picks Hebrew, any other locale picks English, and no
browser info at all (e.g. a non-browser test environment) still falls
back to Hebrew, preserving the product's Hebrew-first default when there
is genuinely nothing to detect.

Verified with 4 new unit tests (Hebrew locale variants, non-Hebrew
locales, a stored preference overriding the locale, and the no-browser-
info fallback) and live in a real browser across four real Playwright
browser contexts with different locales (`en-US`, `he-IL`, `fr-FR`, and
`en-US` with a stored Hebrew preference) — each produced the correct
`dir`/`lang` and, for the two full-page cases, the correctly translated
title, with zero stored preference in three of the four cases (a fresh
browser context has no `localStorage`) to confirm this was genuinely the
locale-detection path, not leftover state from a previous test.

## Update: server-side error messages are now localized too

This closes the last gap this ADR called out ("not yet handled: server-
side error messages"). The API never had its own i18n — its errors are
plain English strings written for developers, and the client used to show
them verbatim. Localizing them server-side would mean the API needs to
know the caller's language on every request; instead, every `HttpError`
now also carries a small stable `code` (`apps/api/src/httpError.ts`), and
translation happens client-side via a new `error.<CODE>` slice of the
same dictionary this ADR already established, through a new pure
`resolveErrorMessage(lang, body)` in `i18n/language.ts` — no second i18n
system, just more keys in the existing one. A code the dictionary doesn't
recognize yet falls back to the original raw English text rather than
showing nothing. See `docs/roadmap.md` ("Localize server-side error
messages") for the verification detail.
