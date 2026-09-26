# ADR 0004: Migration idempotency hardening + a Debug Agent pipeline step

## Status

Accepted.

## Context

Direct product feedback (Hebrew): "when the system hits a problem it stops
— check this bug and fix it; build a system like Claude Code, and better."
No specific reproduction was given. Two real, separable problems follow
from that report, and both are addressed here rather than papering over
either with a generic try/catch:

1. Before this change, `diffAndMigrate` (`packages/db/src/migrate.ts`) had
   a real crash class: calling it twice with a spec that adds the same
   column (a retried build, or a refine that re-derives a spec already
   applied) issued a duplicate `ALTER TABLE ... ADD COLUMN`, which SQLite
   rejects, throwing and halting the pipeline with no recovery. This is a
   concrete bug regardless of whether it was the user's exact trigger.
2. Even with (1) fixed, the pipeline as built had no answer at all for an
   *unexpected* Database-step failure — any migration error simply ended
   the generator with a raw error message. "The system hits a problem and
   stops" was literally true by design, not a bug in one function.

## Decision

### Migration idempotency

`existingColumns(db, table)` reads `PRAGMA table_info(table)` before the
field-addition loop in `diffAndMigrate`; a column already present is
skipped instead of re-added. This closes the crash class outright — the
same additive change can be applied any number of times safely — which
also makes retries (including the Debug Agent's own retry, below) safe by
construction rather than by convention. Verified by a new test: calling
`diffAndMigrate` twice in a row with the same additive spec change no
longer throws.

### Debug Agent

A new `Debug` pipeline step (`packages/spec-engine/src/debug.ts`,
`apps/api/src/pipeline.ts`) activates only when the Database step's
migration still throws after the idempotency fix above (any other
unexpected `diffAndMigrate` failure):

1. `requestSpecFix(spec, errorMessage, { apiKey })` sends the failing
   `ProductSpec` and the literal error message to Claude with a system
   prompt asking for a corrected, schema-valid spec — the same
   direct-`fetch` pattern as the existing Anthropic spec provider
   (`anthropic.ts`), not a new SDK dependency.
2. The pipeline retries `diffAndMigrate` once with the corrected spec. If
   that succeeds, the build continues normally using the corrected spec
   for every later step (Seed Data, QA, Security, the saved checkpoint) —
   the user gets a working build, and the `Debug` step's detail payload
   shows exactly what was changed.
3. Two failure paths are reported honestly, never silently swallowed or
   retried indefinitely:
   - No `ANTHROPIC_API_KEY` configured: the `Debug` step reports it can't
     attempt a fix and surfaces the real underlying error, in Hebrew.
   - The model's own proposed fix is itself invalid (fails schema
     validation, or still fails to migrate): the pipeline reports that the
     automatic fix attempt failed and stops — there is exactly one retry,
     never a loop.

This is explicitly framed as a narrow, honest first version of "a system
like Claude Code" for this platform's own build pipeline: self-diagnosis
and self-repair for one well-defined, previously-unrecoverable failure
class (schema migration errors), not a general autonomous coding agent
that rewrites arbitrary application logic. Overclaiming that scope would
repeat the exact overpromising this project has consistently avoided.

## Verification performed

- `packages/db/src/migrate.test.ts`: new test proves `diffAndMigrate` is
  safe to call twice with the same additive change.
- `packages/spec-engine/src/debug.test.ts`: `requestSpecFix` against a
  mocked `fetch` — successful fix, schema-validation failure, non-2xx API
  error.
- `apps/api/src/pipeline.test.ts`: full pipeline runs against a real
  broken spec (an unsafe field identifier that reliably makes the
  migration throw) with a mocked model response —
  recovers and reaches a successful `Forge` finalize step with the
  corrected spec persisted; reports honestly with no API key configured
  (no `Forge` event emitted, i.e. the build correctly does not silently
  continue); reports honestly when the model's own fix is also invalid
  (still no `Forge` event, proving there is no infinite retry loop).
- Full monorepo test suite and production build (`npm test`, `npm run
  build`) run clean after these changes.

## Consequences

- A whole class of previously-fatal, non-obvious SQLite errors (duplicate
  column additions) can no longer happen at all.
- Genuinely unexpected Database-step failures now get one real, logged
  attempt at automatic recovery when a Claude API key is configured,
  instead of unconditionally stopping the build.
- When recovery isn't possible (no key, or the model's fix doesn't work
  either), the user sees the real error, in Hebrew, rather than a build
  that silently stops with no explanation — matching this project's
  "no fake implementations, no silent failure" principle.
- This does not make the pipeline immune to all failure — it narrows one
  specific, previously-unrecoverable gap. Broader self-healing (production
  observability, automatic regression diagnosis) remains a Phase 3 item in
  `roadmap.md`.
