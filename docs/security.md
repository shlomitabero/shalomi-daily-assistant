# Security

## Threat model for this Phase 1 slice

The biggest security surface in the full Forge AI vision — executing
AI-generated code, sandboxing untrusted repositories, prompt injection from
project content — mostly doesn't exist yet in Phase 1, because Phase 1
doesn't execute generated code or ingest external repositories. It runs one
generic, hand-written CRUD engine over a schema the model (or the heuristic
fallback) only gets to *describe*, never to execute. That constrains the
real threats to a smaller, concrete list:

### Addressed

- **SQL injection.** No table or column name is ever built from
  string-concatenated, unsanitized input. `packages/db/src/identifiers.ts`
  sanitizes project IDs and entity names, and rejects (rather than
  sanitizes) field/column names that aren't already safe SQL identifiers —
  see the tests in `packages/db/src/migrate.test.ts` for both the "hostile
  entity name gets sanitized" and "hostile column name gets rejected"
  cases. All row *values* go through parameterized `?` placeholders,
  including everything a user (or a model) supplies as record data.
- **Input validation.** Every request body is validated: `zod` at the route
  boundary (`CreateProjectSchema`) and field-level validation in the
  repository layer (required fields, enum membership, numeric coercion)
  before anything reaches SQLite.
- **Secrets.** The only secret in this slice is `ANTHROPIC_API_KEY`, read
  from the environment server-side and never sent to the browser or logged.
  There is no UI flow that asks a user to paste a secret into chat.
- **CORS** is enabled broadly for local development; this is called out
  below as something to tighten before any real deployment.

### Explicitly not addressed yet (do not assume these exist)

- **No authentication or authorization.** Every API route is unauthenticated
  and operates on a single implicit workspace. Anyone who can reach the API
  can read/write any project's data. This is the single biggest gap before
  this could handle real user data, and is first on the Phase 2 list.
- **No rate limiting.** `POST /api/projects` calls a real LLM API when
  configured; nothing currently stops abuse of that endpoint.
- **No row-level security / multi-tenancy.** There is only one tenant.
- **No CSRF protection**, since there are no sessions/cookies yet to
  protect.
- **No sandboxing of generated code**, because nothing generates or
  executes arbitrary code in this slice — the generic CRUD engine is fixed,
  reviewed code; only the *schema* is model-influenced, and it only ever
  becomes `CREATE TABLE` statements built through the safe-identifier path
  above, never arbitrary SQL.
- **Prompt injection.** The Anthropic provider sends the user's raw
  description as the only user-turn content and expects a specific JSON
  shape back; a response that doesn't validate against `ProductSpecSchema`
  is rejected outright rather than partially trusted. There's no scenario
  yet where the model's output can reach a shell, the filesystem, or
  another user's data, which is what makes prompt injection dangerous
  elsewhere in the full vision (section 100) — that changes materially once
  agents get filesystem/shell/git tools in Phase 2+, and this document
  should be revisited then.

## Before any real deployment

1. Add authentication (even a single-workspace API key) before exposing
   this off localhost.
2. Restrict CORS to the actual frontend origin.
3. Add rate limiting on `POST /api/projects` (the one endpoint that spends
   real money via the Anthropic API).
4. Move `DB_PATH` to a persistent volume; the default path is not backed up.
