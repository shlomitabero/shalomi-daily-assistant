# ADR 0003: Standalone code export

## Status

Accepted.

## Context

Direct product feedback: "take everything Base44 and Lovable can do."
Both platforms' single most repeated marketing claim is code ownership —
you can leave with your app. Phase 1/2 of Forge AI never had this: a built
app only ever existed as rows in Forge's own SQLite database, runnable
only through Forge's own generic CRUD engine. That is the single biggest,
most concrete gap called out in `docs/architecture.md`'s "own your code"
discussion, and it's fixable without waiting for a full generated-codebase
rewrite (the Phase 2 item in `roadmap.md`).

## Decision

`GET /api/projects/:id/export` (only once a project is built) generates a
small set of literal source files — `package.json`, `server.js`,
`public/index.html`, `README.md`, `.gitignore` — from the project's
`ProductSpec`, zips them, and streams the zip as a download. The generated
app:

1. **Has zero runtime dependency on Forge AI.** It doesn't import any
   `@forge/*` package, doesn't call back to this platform, and has exactly
   one dependency (`express`). `codegen.test.ts` proves the generated
   `server.js` is syntactically valid on its own (`node --check`), and this
   ADR's verification step (below) proves it actually runs.
2. **Is a single readable server file and a single readable HTML file**,
   not a generated Next.js/Vite project with a build step. A non-technical
   user's "own your code" moment should be "open server.js, it's 150 lines
   and I can read it," not "here's a 40-file scaffold and a build
   pipeline." This is a deliberate simplification versus Lovable's
   full-framework export — the honest tradeoff being that it isn't meant
   to be a starting point for a large team project, just a true, working,
   ownable copy of exactly what was built.
3. **Reuses the same schema-from-spec and validation logic conceptually**
   (required fields, enum membership, type coercion) as
   `packages/db`, but as freshly generated literal code, not an import —
   because an export that still depends on Forge's own packages wouldn't
   actually be independent.
4. **Ships with no authentication.** Forge AI's own auth is per-workspace,
   single-owner; baking that into an export would either be dead code (no
   second user will ever exist) or a false promise of security nobody
   configured. The README says so explicitly and points at Forge's own
   `apps/api/src/auth/` as a reference if the user wants to add it.

## A dependency-free ZIP writer

Rather than adding a zip library (`archiver`, `jszip`, ...), `zip.ts`
implements the PKZIP "store" (uncompressed) format directly — a few dozen
lines once CRC32 is included, and it keeps this codebase's pattern of
avoiding dependencies where a small amount of well-tested code covers the
need (see ADR 0001's `node:sqlite` decision for the same reasoning).
`zip.test.ts` doesn't just assert on the bytes — it writes the archive to
disk and calls the system `unzip -t`/`unzip -o` on it, so correctness is
checked against a real, independent implementation of the format.

## Verification performed

Before calling this feature done, the following was actually run, not just
implemented (per the project's own "no fake implementations" principle):

1. Created and built a real project through the running API (Hebrew
   description, four entities).
2. Downloaded the export via the real HTTP endpoint and confirmed the
   response is `file`-identified as a genuine ZIP archive.
3. **Stopped the Forge AI server entirely.**
4. Extracted the zip into an unrelated directory, ran `npm install` and
   `npm start` there with no other files present.
5. Exercised the standalone app's real REST API with `curl` (create,
   list, and a required-field-rejection case) and confirmed a real browser
   (Playwright) loads its UI, shows the correct Hebrew tabs/labels, and can
   submit a form that persists a new row.

All of that worked with the original Forge AI process already dead —
proving the export is genuinely standalone, not aspirationally so.

## Consequences

- Users get a real, immediate answer to "can I leave?" — yes, today, for
  any built project.
- The exported app is intentionally not what a professional dev team would
  hand-build (no auth, no tests, single SQLite file, no build tooling) —
  it's a true, working starting point, not a production-grade codebase.
  That distinction is stated in the generated README, not hidden.
- If Phase 2's full generated-codebase-per-project work happens later, this
  export can either be superseded by it or kept as a lightweight "quick
  export" option alongside the heavier one — nothing here blocks that.
