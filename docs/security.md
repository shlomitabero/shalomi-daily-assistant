# Security

## Threat model

The biggest security surface in the full Forge AI vision — executing
AI-generated code, sandboxing untrusted repositories, prompt injection from
project content — mostly doesn't exist yet, because this codebase doesn't
execute generated code or ingest external repositories. It runs one
generic, hand-written CRUD engine over a schema the model (or the heuristic
fallback) only gets to *describe*, never to execute. That constrains the
real threats to a smaller, concrete list:

### Addressed

- **Authentication.** Email/password accounts, `scrypt`-hashed (Node's
  `node:crypto`, no extra dependency) and compared with `timingSafeEqual`.
  Sessions are random 32-byte bearer tokens stored server-side with a
  30-day expiry, checked on every request by `requireAuth` middleware.
  There is no email verification and no password reset flow yet — see
  "Before any real deployment" below.
- **Authorization / multi-tenancy.** Every project has an `ownerId`.
  `requireOwnedProject` returns 404 — not 403 — for a project that doesn't
  exist *or* belongs to someone else, so the API never confirms a project
  ID's existence to a non-owner. Covered by an explicit cross-user test in
  `apps/api/src/app.test.ts`.
- **SQL injection.** No table or column name is ever built from
  string-concatenated, unsanitized input. `packages/db/src/identifiers.ts`
  sanitizes project IDs and entity names, and rejects (rather than
  sanitizes) field/column names that aren't already safe SQL identifiers —
  see the tests in `packages/db/src/migrate.test.ts`. All row *values* go
  through parameterized `?` placeholders, including everything a user (or a
  model) supplies as record data.
- **Input validation.** Every request body is validated: `zod` at the route
  boundary and field-level validation in the repository layer (required
  fields, enum membership, numeric coercion) before anything reaches
  SQLite.
- **Secrets.** The only server secret is `ANTHROPIC_API_KEY`, read from the
  environment and never sent to the browser or logged. Session tokens are
  stored in `localStorage` on the client, which is the standard tradeoff
  for a bearer-token SPA (readable by any script running on the page — i.e.
  an XSS bug would be able to steal it; there is no XSS-prone `innerHTML`/
  `dangerouslySetInnerHTML` usage in this codebase today, but that's a
  property to keep, not a guarantee of the framework).
- **A real, automated Security Agent step.** Every build/refine runs a
  static scan (`apps/api/src/pipeline.ts`) for reserved-SQL-word collisions
  and plaintext fields that look like secrets (`password`, `token`, `ssn`,
  etc. stored as `text`/`longtext`), producing a real score and warning
  list — advisory today, not a blocking gate (see roadmap for making high
  severity findings block publishing, per vision section 38).
- **CORS** is enabled broadly for local development; tighten before any
  real deployment (below).

### Explicitly not addressed yet (do not assume these exist)

- **No rate limiting.** `POST /api/projects` and `POST /api/projects/:id/refine`
  call a real LLM API when configured; nothing currently stops abuse of
  either endpoint, or of `/api/auth/signup` (account-creation spam).
- **No RBAC / organizations.** Auth is single-owner-per-project; there is no
  `Workspace`/`WorkspaceMember` concept, so no team sharing and no roles
  beyond "the owner can do everything."
- **No CSRF protection**, since auth is bearer-token-in-header (not a
  cookie), which is inherently not CSRF-vulnerable — this is a property of
  the current design, not a gap, but would need revisiting if cookie-based
  auth is ever added.
- **No sandboxing of generated code**, because nothing generates or
  executes arbitrary code in this codebase — the generic CRUD engine is
  fixed, reviewed code; only the *schema* is model-influenced, and it only
  ever becomes `CREATE TABLE`/`ALTER TABLE` statements built through the
  safe-identifier path above, never arbitrary SQL.
- **Prompt injection.** The Anthropic provider sends the user's raw
  description (plus, for a refine, the prior description and the new
  instruction) as the only user-turn content and expects a specific JSON
  shape back; a response that doesn't validate against `ProductSpecSchema`
  is rejected outright rather than partially trusted. There's no scenario
  yet where the model's output can reach a shell, the filesystem, or
  another user's data, which is what makes prompt injection dangerous
  elsewhere in the full vision (section 100) — that changes materially once
  agents get filesystem/shell/git tools in a later phase, and this document
  should be revisited then.
- **No audit log.** Section 40 of the vision (who changed what, when,
  human or AI) isn't implemented; checkpoints record *what* changed but not
  *who* triggered it beyond the implicit single owner.

## Before any real deployment

1. Restrict CORS to the actual frontend origin.
2. Add rate limiting on `POST /api/projects`, `POST /api/projects/:id/refine`,
   and `POST /api/auth/signup` (the endpoints that spend real money or
   enable abuse).
3. Add email verification and a password-reset flow before treating
   accounts as real user identities rather than a demo login.
4. Move `DB_PATH` to a persistent, backed-up volume.
5. Add a session-revocation UI ("log out everywhere") — `deleteSession`
   exists in `packages/db` but is only wired to the current session's own
   logout today.
