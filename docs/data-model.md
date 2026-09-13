# Data Model

## What's implemented today

Two tiers of storage, both in one SQLite database (default path
`apps/api/data/forge.sqlite`, override with `DB_PATH`):

### 1. Platform metadata — `projects` table

| column      | type | notes                                   |
|-------------|------|------------------------------------------|
| id          | TEXT | UUID, primary key                        |
| name        | TEXT | derived from the description if not given |
| description | TEXT | the original natural-language input      |
| spec_json   | TEXT | the full generated `ProductSpec`, as JSON |
| status      | TEXT | `draft` \| `built`                        |
| createdAt   | TEXT | ISO 8601 timestamp                        |

### 2. Generated application data — one table per entity per project

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

`required: true` fields get a `NOT NULL` column constraint *and* are
validated at the API layer before the SQL statement runs, so a violation
comes back as a clear 400 rather than a raw SQLite error.

## The full domain model this is scoped from

The long-term vision (section 93 of the founding spec) describes a much
larger entity set — `User`, `Workspace`, `WorkspaceMember`, `Conversation`,
`Message`, `Requirement`, `ProjectDecision`, `Agent`, `AgentTask`,
`TaskDependency`, `Artifact`, `FileVersion`, `Checkpoint`, `Environment`,
`Deployment`, `Integration`, `SecretReference`, `TestRun`, `SecurityScan`,
`Issue`, `Incident`, `UsageRecord`, `Subscription`, `AuditEvent`, and more.

None of that is implemented yet — there is currently one implicit demo
workspace, no authentication, and no multi-tenancy. Adding real users
changes nearly every table above (row ownership, RLS-style checks in the
repository layer), so it is called out explicitly here rather than bolted
on partially. See `roadmap.md` Phase 2 and `security.md` for the specific
gap this leaves.
