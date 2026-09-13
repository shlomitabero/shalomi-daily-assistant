# ADR 0002: Auth model, agent pipeline shape, and additive-only migrations

## Status

Accepted.

## Context

Phase 1 proved one honest vertical slice (idea → spec → schema → CRUD UI)
with no auth and no iteration story. Moving toward "the best prototype
there is" meant picking the next few features that most differentiate
Forge AI from a generic CRUD generator — the AI Team, Time Machine, and the
ability to keep improving a shipped app in plain language — while keeping
every claim true (per the vision's own "no fake implementations" and "no
silent failures" principles).

## Decisions

1. **Bearer-token sessions, not JWTs or OAuth.** A random 32-byte token is
   stored server-side in a `sessions` table with an expiry; the client sends
   it as `Authorization: Bearer <token>`. This is simpler to reason about
   and revoke (delete the row) than a signed JWT, and there's no need yet
   for a third-party identity provider. Passwords are hashed with `scrypt`
   (Node's `node:crypto`, no extra dependency) and compared with
   `timingSafeEqual`. See `security.md` for what this does and doesn't
   cover (no email verification, no password reset, no rate limiting yet).

2. **A 404, not a 403, on someone else's project.** `requireOwnedProject`
   returns "not found" whether the project doesn't exist or belongs to
   another user, so the API never confirms a given project ID exists to
   someone who doesn't own it.

3. **The agent pipeline is a sequence, not parallel branches — and it's an
   async generator, not a job queue.** The vision's "AI Team" describes
   agents working in parallel with a dependency graph. Building real
   parallel orchestration (with the scheduling and partial-failure handling
   it implies) before the sequential version even existed would have meant
   shipping neither. `apps/api/src/pipeline.ts` is a single `async
   function*` yielding one `AgentStepEvent` per step (Architect → Database →
   Seed Data → QA → Security → Forge), streamed to the browser as
   Server-Sent Events over a plain `fetch` (not `EventSource`, since
   `EventSource` can't send a custom `Authorization` header — the client
   reads `response.body` with a `ReadableStreamDefaultReader` instead, see
   `apps/web/src/api.ts`). Parallel execution with real dependencies is
   Phase 3 work, not simulated here.

4. **Every pipeline step does real, checkable work — including the one that
   looks the most like theater.** The QA step actually calls `listRecords`
   and attempts an insert missing a required field, asserting it's rejected
   — a real regression in the repository layer would make this step fail
   the build, not silently pass. The Security step is a real static scan
   (reserved-SQL-word collisions, a plaintext-secret-looking-field
   heuristic) with a real score, not a fixed "100/100". Seed Data inserts
   go through the same `insertRecord` validation path as a real user
   request, not a raw SQL bypass.

5. **Migrations are additive-only: never drop, never rename.** Once a
   column or table exists, nothing in this codebase removes it — a refine
   that drops a field from the spec just stops surfacing it in the UI; the
   column and its data stay in SQLite. This single rule is what makes Time
   Machine checkpoint restores trivially safe (`diffAndMigrate` run against
   an older spec is a no-op, never a destructive rollback) and is a direct,
   concrete implementation of the vision's "never destroy work" principle
   (section 70) and "AI Data Migration Guard" (section 24), reduced to its
   simplest honest form: no diffing UI, no simulated migration preview yet
   — just a hard guarantee that this engine cannot drop your data. The
   tradeoff is accepted explicitly: a real product would eventually need a
   real column-removal story (with confirmation, backup, and rollback) —
   that's future work, not silently missing.

6. **Refine re-derives the whole spec from the combined description rather
   than patching the JSON directly.** This keeps one code path (`generateSpec`)
   responsible for producing a valid `ProductSpec`, and reuses the same
   diffing logic that would apply if a smarter provider (Anthropic, or a
   future one) returned a genuinely edited spec. The heuristic provider's
   determinism means a refine mostly *adds* entities recognized from new
   keywords rather than editing existing ones — a real, documented
   limitation of the offline fallback (see `architecture.md`), not hidden
   behavior.

## Consequences

- Auth and ownership are real and tested (`apps/api/src/app.test.ts` includes
  a dedicated cross-user isolation test), but this is still a single-tenant-
  per-user model with no organizations, no RBAC beyond a single owner, and
  no rate limiting — Phase 3/4 concerns, listed explicitly in `security.md`.
- The AI Team is genuinely watchable and genuinely fails loudly when a step
  fails (stopping the build, not silently publishing a broken one) — but it
  is not yet the fully parallel, dependency-graph-driven team the vision
  describes.
- Time Machine restores are safe by construction, at the cost of the schema
  only ever growing, never shrinking, until a later phase adds a real
  column-removal workflow.
