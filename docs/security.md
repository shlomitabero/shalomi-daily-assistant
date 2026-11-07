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
  30-day expiry, checked on every request by `requireAuth` middleware. A
  real password-reset flow exists (`POST /api/auth/forgot-password` /
  `POST /api/auth/reset-password`, `apps/api/src/routes/auth.ts`) — a
  hashed, time-limited token, enumeration-safe (the same response whether
  or not the email exists), rate-limited (see "Rate limiting" below).
  Email verification is also implemented (round 1566) —
  `POST /auth/verify-email` / `POST /auth/resend-verification`, a
  `users.emailVerifiedAt` column (backfilled to `createdAt` for
  pre-existing rows so nobody already signed up is locked out), both
  rate-limited the same way. A signed-in user can also revoke every
  *other* session ("log out everywhere", round 1564) via
  `POST /auth/sessions/revoke-others`, which calls the
  `deleteOtherSessionsForUser` function in `packages/db` that already
  existed but was until then only wired to the current session's own
  logout.
- **Authorization / multi-tenancy.** Every project has an `ownerId`.
  `requireProjectAccess` returns 404 — not 403 — for a project that doesn't
  exist, belongs to someone else, *and* isn't shared with the requesting
  user, so the API never confirms a project ID's existence to anyone
  without access to it. Covered by an explicit cross-user test in
  `apps/api/src/app.test.ts`.
- **Rate limiting.** The auth endpoints (signup, login, forgot-password)
  are rate-limited (`apps/api/src/auth/rateLimit.ts`). The LLM-calling
  project endpoints -- `POST /ideas/enhance`, `POST /projects`,
  `POST /projects/:id/answers`, `POST /projects/:id/refine` -- are rate-
  limited by `aiGenerationRateLimiter` (round 858; 30 requests/15min per
  user), and `POST /projects/from-template`/`POST /projects/:id/clone` by a
  separate `projectCreationRateLimiter` (round 1163) against unbounded free
  project-row creation (both in `apps/api/src/routes/projects.ts`). Rate
  limiting has since been extended to most other mutating routes in that
  file too (collaborator invites, record CRUD, automation-rule CRUD,
  WhatsApp connect/send, exports/backups, the public calendar feed, etc.)
  -- see `docs/roadmap.md` for the full history; this bullet only tracks
  the two routes this document used to claim were still unprotected.
- **Project sharing (collaborators) with real RBAC.** An owner can invite
  another existing user as a collaborator with one of two roles —
  `"editor"` (identical access to the owner, except managing who else has
  access) or `"viewer"` (read-only: `requireProjectWriteAccess`,
  `apps/api/src/routes/projects.ts`, returns 403 `VIEWER_READ_ONLY` for
  every mutating route — ~40 call sites covering every POST/PATCH/DELETE in
  that file). `CollaboratorRole` (`packages/db/src/collaborators.ts`) is a
  real `"editor" | "viewer"` type, surfaced and changeable in
  `CollaboratorsPanel.tsx`'s role picker, and the frontend disables every
  write affordance (`readOnly` props throughout `EntityPanel.tsx`,
  `AutomationsPanel.tsx`, `WhatsAppPanel.tsx`, etc.) for a viewer, not just
  the server. Managing who has access at all — inviting, removing, or
  changing a role — is enforced owner-only by a separate, stricter
  `requireProjectOwner` check, covered by its own cross-user tests.
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
- **Inbound webhooks** (`POST /public/webhook-in/:projectId/:entityName`,
  `apps/api/src/routes/webhookIn.ts`, round 1405) are the one route family
  deliberately outside `requireAuth` -- an external sender (Stripe,
  Typeform, a website's own form handler) has no session and can't be made
  to attach an Authorization header, so a per-project, regeneratable token
  in the URL's query string is the entire authentication, compared with
  `timingSafeEqual` rather than `===`. Rate-limited to 60 requests/15min,
  keyed by `projectId:token` together (not just the project id), so a
  wrong guess against one project's token can't exhaust a real
  integration's own budget for that same project (round 1109's own
  reasoning, extended here round 1405). 404s uniformly for "project
  doesn't exist", "entity doesn't exist", "no token generated yet", and
  "token mismatch", mirroring the public calendar feed route's own
  anti-enumeration convention below. Idempotency is opt-in via an
  `X-Idempotency-Key` header (round 1418), and delivery/failure history is
  tracked and surfaced to collaborators in `CollaboratorsPanel.tsx` (rounds
  1456/1457/1471).

### Explicitly not addressed yet (do not assume these exist)

- **No organizations / workspaces.** A project can be shared with other
  individual users with a real editor/viewer role each (see "Project
  sharing" above), but there is still no `Workspace`/`WorkspaceMember`
  concept — sharing is per-project, not grouped under a team/org an owner
  manages collectively, and there's no entity-scoped (as opposed to
  whole-project) permission level.
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
- **Audit log for automation-rule create/update/delete is now complete.**
  Section 40 of the vision (who changed what, when, human or AI) is now
  covered for every write surface this doc used to call out as missing: a
  checkpoint records *who* created it (`checkpoints.createdByUserId`, round
  1567), a restore records who performed it
  (`projects.lastRestoredByUserId`/`lastRestoredCheckpointId`/
  `lastRestoredAt`, round 1568), a record create records its creator
  (`records.createdByUserId`, round 1613) and a record update its last
  editor (`records.updatedByUserId`, round 1617), a record delete is logged
  with its deleter (`record_deletions`, round 1632), a collaborator invite,
  role change, removal, or ownership-transfer is logged with both actor and
  target (`collaborator_access_changes`, rounds 1636/1654/1665), an entity/field label
  rename outside a build is logged with its actor (`schema_label_edits`,
  round 1639), an automation rule create/update is logged on the rule row
  itself (`automation_rules.createdByUserId`/`updatedByUserId`, round
  1664), and an automation rule delete is logged with its deleter
  (`automation_rule_deletions`, round 1666) — all six of the latter
  surfaced in `CollaboratorsPanel.tsx`'s Copy/Download report.

## Before any real deployment

1. Restrict CORS to the actual frontend origin.
2. Move `DB_PATH` to a persistent, backed-up volume.
