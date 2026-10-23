# Data Model

## What's implemented today

Five tiers of storage, all in one SQLite database (default path
`apps/api/data/forge.sqlite`, override with `DB_PATH`):

### 1. Accounts — `users` and `sessions` tables

| table    | columns                                              |
|----------|-------------------------------------------------------|
| users    | `id` (TEXT, PK), `email` (TEXT, UNIQUE), `passwordHash` (TEXT, `scrypt` salt:hash), `createdAt` |
| sessions | `token` (TEXT, PK), `userId` (TEXT), `expiresAt` (TEXT, ISO 8601, 30 days from issue) |

### 2. Platform metadata — `projects` table

| column      | type | notes                                   |
|-------------|------|------------------------------------------|
| id          | TEXT | UUID, primary key                        |
| ownerId     | TEXT | the `users.id` that created this project |
| name        | TEXT | derived from the description if not given |
| description | TEXT | the original natural-language input      |
| spec_json   | TEXT | the current `ProductSpec`, as JSON — moves when a checkpoint is restored |
| status      | TEXT | `draft` \| `built`                        |
| createdAt   | TEXT | ISO 8601 timestamp                        |

### 3. Collaboration — `project_collaborators` table

| column    | type | notes                                                        |
|-----------|------|---------------------------------------------------------------|
| projectId | TEXT | the shared project, part of the composite primary key         |
| userId    | TEXT | the invited `users.id`, part of the composite primary key     |
| role      | TEXT | `"editor"` \| `"viewer"` (additive migration, defaults existing rows to `"editor"`) |
| addedAt   | TEXT | ISO 8601 timestamp                                             |

An owner can invite another existing user as either an `"editor"`
(identical access to the owner, except managing who else has access) or a
read-only `"viewer"` — enforced server-side by `requireProjectWriteAccess`
(`apps/api/src/routes/projects.ts`, ~40 call sites covering every mutating
route) and reflected client-side by disabling write affordances throughout
the UI for a viewer. See "Project sharing" in `security.md` for the full
picture.

### 4. Time Machine — `checkpoints` table

| column     | type | notes                                              |
|------------|------|------------------------------------------------------|
| id         | TEXT | UUID, primary key                                    |
| projectId  | TEXT | the project this snapshot belongs to                 |
| label      | TEXT | `"Initial build"` or `"Refine: <instruction>"`       |
| spec_json  | TEXT | the full `ProductSpec` at this point, as JSON        |
| createdAt  | TEXT | ISO 8601 timestamp                                   |

One row is written by the `Forge` agent step at the end of every successful
build or refine (see `architecture.md`). Restoring sets `projects.spec_json`
back to a checkpoint's `spec_json` — see "additive-only migrations" below
for why that's always safe.

### 5. Generated application data — one table per entity per project

For a project with id `proj1` and an entity named `Customer`, Forge AI
creates a real table `entity_proj1_Customer` with:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `createdAt TEXT NOT NULL`
- one column per field in the spec, typed by `Field.type`:

| Field.type | SQL type | notes                                        |
|------------|----------|-----------------------------------------------|
| text       | TEXT     |                                                |
| longtext   | TEXT     |                                                |
| number     | REAL     |                                                |
| boolean    | INTEGER  | stored as 0/1, coerced to `true`/`false` in the API |
| date       | TEXT     | ISO date string, no timezone handling yet     |
| enum       | TEXT     | validated against `enumValues` at write time  |
| relation   | INTEGER  | `REFERENCES <relatedTable>(id)` when the target entity exists in the same spec |

`required: true` fields get a `NOT NULL` column constraint on the entity's
*first* build, and are validated at the API layer before every write
regardless. A field added later by a refine is always added nullable —
SQLite can't retroactively satisfy `NOT NULL` against a table's existing
rows — see ADR 0002.

### Additive-only migrations

Once a table or column exists, nothing in this codebase drops or renames
it — a refine that removes a field from the spec just stops showing it in
the UI; the column and its data stay in SQLite. This is a deliberate,
documented simplification (ADR 0002) that makes Time Machine restores
unconditionally safe: `diffAndMigrate` run against an older spec only ever
finds things already present, so it's a no-op, never a destructive
rollback.

## The full domain model this is scoped from

The long-term vision (section 93 of the founding spec) describes a much
larger entity set — `Workspace`, `WorkspaceMember`, `Conversation`,
`Message`, `Requirement`, `ProjectDecision`, `Agent`, `AgentTask`,
`TaskDependency`, `Artifact`, `FileVersion`, `Environment`, `Deployment`,
`Integration`, `SecretReference`, `TestRun`, `SecurityScan`, `Issue`,
`Incident`, `UsageRecord`, `Subscription`, `AuditEvent`, and more.

`User` and `Checkpoint` now exist for real (above); so does project-level
sharing with a real editor/viewer role each (the `project_collaborators`
table, tier 3 above) — but the rest of this larger vision doesn't yet.
There is still no `Workspace` or `WorkspaceMember` concept: sharing is
per-project, not grouped under a team/org an owner manages collectively,
and there's no entity-scoped (as opposed to whole-project) permission
level. See `roadmap.md` Phase 3/4 and `security.md` for what that
narrower gap means in practice.
