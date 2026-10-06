# ADR 0005: Upgrade code export to a real multi-file React codebase

## Status

Accepted. Supersedes the shape (not the intent) of ADR 0003.

## Context

Direct product feedback, twice: "take everything Base44 and Lovable can
do," and later, explicitly asked which specific gap to close next: "קוד
מלא לכל פרויקט" (full code for every project). ADR 0003 deliberately
shipped a minimal export — one `server.js`, one `public/index.html`, no
build step — as an honest first answer to "can I leave?", explicitly
flagging in its own "Consequences" section that a real generated
per-project codebase was the larger, still-open version of the same
promise, and listing it as a "not yet implemented" roadmap item.

A single HTML file with inline vanilla JS and string-concatenated markup
is not what Base44 or Lovable actually hand you — they hand you a real,
component-based frontend codebase you can open in an editor, understand
file-by-file, and extend. That gap is closed here.

## Decision

`generateExportFiles` (`apps/api/src/codegen.ts`) now generates a real
Vite + React project instead of one HTML file:

- `web/src/entities/<Entity>.jsx` — **one real file per entity**, each
  with that entity's exact field list as literal, readable, editable
  code (name, label, type, required, enum values) — not fetched from a
  schema at runtime. Opening `Customer.jsx` shows you exactly what
  `Customer` has; nothing is inferred by reading a shared blob.
- `web/src/components/EntityView.jsx` — the list + form UI shared by
  every entity file, the same way a hand-written multi-entity CRUD app
  would factor this out, not a generic single component driving
  everything off a runtime schema fetch.
- `web/src/App.jsx` — the top-level app: imports each entity's component
  by name and renders entity tabs.
- `web/src/api.js` — a small shared REST client.
- `vite.config.js`, `web/index.html`, `web/src/main.jsx` — a normal Vite
  project layout.
- `server.js` — **unchanged in substance** from ADR 0003: the same real
  Express + `node:sqlite` backend, same validation rules, same zero
  dependency on Forge AI. Only the static-serve directory changed
  (`dist/` — Vite's build output — instead of `public/`).

The one-command promise from ADR 0003 (`npm install && npm start`) still
holds: `start` is `vite build && node server.js`, so the real build step
runs automatically rather than becoming a second command a non-technical
user has to know about.

### Why Vite + React, not literally Next.js

The roadmap phrased the deferred item as "Next.js/React." Next.js brings
routing, server components, and a deploy target (typically Vercel) that
this project's generated apps don't need — every generated app here is a
single page with entity tabs, and its own server is already the deploy
target. A hand-generated Next.js app would add framework machinery this
export doesn't use, for no real benefit over a plain Vite + React SPA
served by the existing Express server. This ADR is explicit about that
tradeoff rather than calling the output "Next.js" and overclaiming.

### Why this doesn't also keep the old single-file export as a second option

A second "lite export" choice would ask a non-technical user to pick
between two exports they have no way to evaluate. The new export is
still small and still readable (its file count matches the entity count
plus a handful of shared files, not a large scaffold), so nothing about
"read it, it's not a black box" from ADR 0003 is lost — it's just spread
across real, well-named files instead of one.

## Verification performed

Per this project's "no fake implementations" principle, this was
actually run end-to-end, not just implemented:

1. `codegen.test.ts`: asserts the exact generated file set for a
   two-entity project; validates `package.json` (express + react +
   react-dom + vite + @vitejs/plugin-react, and that `start` builds
   before serving); checks `server.js` with `node --check` as before;
   checks **every** generated `.jsx`/`.js` file with a real parser
   (`esbuild.transformSync`, the same transform Vite itself uses) rather
   than only eyeballing the template strings; confirms each entity's
   file contains only that entity's own fields (no cross-entity leakage);
   confirms a project name containing JSX-significant characters
   (`"`, `{`, `}`, `<`, `>`, a backtick) doesn't break the generated
   `App.jsx`, because the title is passed through `JSON.stringify` into a
   JS constant and rendered via a JSX expression, never spliced into JSX
   text directly.
2. Generated a real two-entity project's export files to a directory
   with no relationship to this repository.
3. Ran a genuine `npm install` there against the public npm registry
   (not a cache warmed by this repo) — installed Express, React,
   React DOM, Vite, and `@vitejs/plugin-react` fresh.
4. Ran `npm start`, which really invoked `vite build` (producing a real
   `dist/` bundle) and then started the real Express server.
5. Exercised the real REST API with `curl`: created a record, listed it,
   and confirmed a missing-required-field request is rejected with 400.
6. Drove the **built, served React app** with a real browser (Playwright):
   confirmed the page title, confirmed `dir="rtl"` from Hebrew entity
   labels, confirmed the record created via `curl` appears in the table,
   switched to the second entity's tab, and created a second record
   through the real rendered form — all with zero page errors.
7. Stopped the verification server and deleted the temp directory —
   nothing about this depended on the Forge AI process being alive.

## Consequences

- The exported codebase is now a real, editable, per-entity React
  project — a materially closer match to what Base44/Lovable-style
  exports look like — while keeping the backend exactly as tested and
  verified in ADR 0003.
- There is now a real build step (`vite build`). This is hidden behind
  one command (`npm start`) so it doesn't change the user-facing
  promise, but it does mean the export needs a working npm registry
  connection on first install, same as any modern frontend project.
- The generated project is larger (13 files for a 2-entity project vs. 5
  before) but each file is small and single-purpose; nothing here is a
  large opaque scaffold.
- `docs/roadmap.md`'s "Actual generated, exportable Next.js/React
  codebases per project" item is satisfied by this (with the Vite/React,
  not literal Next.js, scope noted above) and is marked done.
