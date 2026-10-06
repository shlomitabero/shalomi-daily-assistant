import type { Project, ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { tableNameFor, quoteIdentifier } from "./identifiers.js";
import { deleteCheckpointsForProject, extractEntityNamesFromSpecJson, listAllCheckpointedEntityNames, listHistoricalEntityNames } from "./checkpoints.js";
import { removeAllCollaborators } from "./collaborators.js";
import { deleteWhatsAppData } from "./whatsapp.js";

export function ensureProjectsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    ownerId: row.ownerId as string,
    name: row.name as string,
    description: row.description as string,
    spec: ProductSpecSchema.parse(JSON.parse(row.spec_json as string)),
    status: row.status as Project["status"],
    createdAt: row.createdAt as string,
    // Only listProjectsForUser's query selects this column; every other
    // caller's row simply lacks the key (undefined). Even there, an owned
    // project's LEFT JOIN side never matches, so the driver hands back SQL
    // NULL rather than leaving the key absent -- normalize that to
    // undefined too, matching the schema's `.optional()` (not `.nullable()`)
    // and letting JSON.stringify omit the key entirely for owned projects.
    sharedAt: (row.sharedAt as string | null | undefined) ?? undefined,
  };
}

/**
 * ProductSpecSchema can only get stricter over time (a field going from
 * optional to required, a new .min(1), etc.), so a project whose spec_json
 * was written by an older version of this app -- and no longer parses
 * against today's schema -- is a real, expected future case. There's no
 * valid Project to substitute for it (every caller needs real entities to
 * work with), so this fails loudly and per-row rather than silently
 * dropping or fixing up the data -- the stored row itself is never
 * touched, so nothing here is destructive; it only decides what a *read*
 * does when parsing fails.
 */
function tryRowToProject(row: Record<string, unknown>): Project | undefined {
  try {
    return rowToProject(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Project ${row.id as string} has a stored spec that no longer matches the current schema; excluded from listings until fixed.`, err);
    return undefined;
  }
}

export function insertProject(
  db: ForgeDatabase,
  project: { id: string; ownerId: string; name: string; description: string; spec: ProductSpec },
): Project {
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id, ownerId, name, description, spec_json, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    project.id,
    project.ownerId,
    project.name,
    project.description,
    JSON.stringify(project.spec),
    "draft",
    createdAt,
  );
  return getProject(db, project.id)!;
}

export function getProject(db: ForgeDatabase, id: string): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToProject(row) : undefined;
}

export function listProjectsForOwner(db: ForgeDatabase, ownerId: string): Project[] {
  // createdAt has only millisecond resolution, so two projects created in
  // quick succession can share the same value; ORDER BY createdAt DESC
  // alone leaves that tie's order undefined (see the identical fix and its
  // rationale in checkpoints.ts's listCheckpoints). rowid strictly
  // increases with insertion order in this SQLite table (not declared
  // WITHOUT ROWID), so it breaks the tie deterministically in favor of
  // "most recently inserted first".
  const rows = db
    .prepare("SELECT * FROM projects WHERE ownerId = ? ORDER BY createdAt DESC, rowid DESC")
    .all(ownerId) as Record<string, unknown>[];
  return rows.map(tryRowToProject).filter((p): p is Project => p !== undefined);
}

/**
 * Everything listProjectsForOwner returns, plus any project someone else
 * owns but has added this user to as a collaborator (see collaborators.ts).
 * A LEFT JOIN rather than a UNION so ORDER BY can still reference
 * projects.rowid for the same tie-break listProjectsForOwner uses --
 * project_collaborators' own PRIMARY KEY (projectId, userId) guarantees at
 * most one matching join row per project for this specific userId, so this
 * never needs a DISTINCT to avoid duplicate rows.
 */
export function listProjectsForUser(db: ForgeDatabase, userId: string): Project[] {
  const rows = db
    .prepare(
      `SELECT projects.*, project_collaborators.addedAt AS sharedAt FROM projects
       LEFT JOIN project_collaborators ON project_collaborators.projectId = projects.id AND project_collaborators.userId = ?
       WHERE projects.ownerId = ? OR project_collaborators.userId = ?
       ORDER BY projects.createdAt DESC, projects.rowid DESC`,
    )
    .all(userId, userId, userId) as Record<string, unknown>[];
  return rows.map(tryRowToProject).filter((p): p is Project => p !== undefined);
}

export function markProjectBuilt(db: ForgeDatabase, id: string): Project {
  db.prepare("UPDATE projects SET status = ? WHERE id = ?").run("built", id);
  const project = getProject(db, id);
  if (!project) throw new Error(`Project ${id} not found`);
  return project;
}

export function updateProjectSpec(db: ForgeDatabase, id: string, spec: ProductSpec): Project {
  db.prepare("UPDATE projects SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), id);
  const project = getProject(db, id);
  if (!project) throw new Error(`Project ${id} not found`);
  return project;
}

/**
 * A project's name is otherwise only ever set once, at creation
 * (deriveName's auto-derived first few words of the description) -- with
 * no way to fix an awkward auto-generated name, or the generic "(copy)"
 * suffix a clone starts with (see the clone route), short of deleting and
 * recreating the whole project. The caller is responsible for validating
 * `name` (non-empty after trimming) before calling this.
 */
export function updateProjectName(db: ForgeDatabase, id: string, name: string): Project {
  db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
  const project = getProject(db, id);
  if (!project) throw new Error(`Project ${id} not found`);
  return project;
}

/**
 * A project's description (the free text typed on the home screen) was
 * otherwise set exactly once, at creation, with no way to ever fix it --
 * unlike the name, which got its own updateProjectName above. That's a
 * real gap: the stored description isn't just cosmetic, it's silently
 * re-sent as context on every future /refine and /answers call (see
 * pipeline.ts's and projects.ts's own `combinedDescription` construction),
 * so a typo or wrong requirement in it keeps compounding into every AI
 * call forever, with no way to correct it short of abandoning the project.
 * The caller is responsible for validating `description` (non-empty after
 * trimming) before calling this, the same contract updateProjectName has.
 */
export function updateProjectDescription(db: ForgeDatabase, id: string, description: string): Project {
  db.prepare("UPDATE projects SET description = ? WHERE id = ?").run(description, id);
  const project = getProject(db, id);
  if (!project) throw new Error(`Project ${id} not found`);
  return project;
}

/**
 * Permanently deletes a project and everything that belongs only to it:
 * its real generated data tables (one per entity, via tableNameFor -- the
 * same naming migrate.ts uses to create them), Time Machine checkpoints,
 * collaborator grants, and WhatsApp connection/message history. Unlike
 * migrations (additive-only by design, see ADR 0002), this is genuinely
 * destructive and irreversible -- callers must have already confirmed
 * that with the user, and (for WhatsApp) torn down any *live* socket via
 * WhatsAppWebManager.disconnect first, since that in-memory state lives in
 * apps/api, outside this package's reach.
 *
 * Drops tables for every entity that ever appeared in this project's
 * history -- its current spec AND every checkpoint's own spec -- not just
 * project.spec.entities. migrate.ts's diffAndMigrate is deliberately
 * additive-only (see its own comment: "Never drops or renames anything,
 * even if a field or entity was removed from the new spec"), so a real
 * sequence like build -> refine (adds Entity) -> refine (removes Entity
 * from the spec again) -> delete project leaves that entity's own data
 * table, with real rows, untouched by the current spec's own list and
 * orphaned forever with no project row left pointing at it. Every
 * successful build/refine inserts exactly one checkpoint with its
 * resulting spec (pipeline.ts's own insertCheckpoint call), so the union
 * of every checkpoint's entities plus the current spec's own is the
 * complete set of tables this project could ever have created -- read
 * before deleteCheckpointsForProject below removes that very history.
 * Uses listAllCheckpointedEntityNames rather than listCheckpoints: the
 * latter silently excludes a checkpoint whose *other* fields no longer
 * satisfy today's (stricter) ProductSpecSchema, which would leave that
 * checkpoint's own entities out of this accounting and their tables
 * orphaned forever -- the exact bug this doc-comment describes, just one
 * step removed (see listAllCheckpointedEntityNames's own doc-comment).
 *
 * Also unions listHistoricalEntityNames: deleting a single checkpoint
 * (round 216, an ordinary cleanup action) can remove the only checkpoint
 * whose own spec still mentioned an entity later refined out of the
 * current spec, with no other remaining checkpoint mentioning it either --
 * at that point listAllCheckpointedEntityNames alone has already forgotten
 * it, and this project's own deletion would otherwise leave that one
 * table permanently orphaned with nothing anywhere left pointing at it.
 * listHistoricalEntityNames reads a durable, append-only ledger written at
 * every insertCheckpoint call instead, so it survives any single
 * checkpoint being deleted in between.
 *
 * Takes a bare `projectId` rather than a parsed `Project`, and reads this
 * project's own spec_json the same tolerant way (extractEntityNamesFromSpecJson,
 * not ProductSpecSchema.parse): a project row can fail full re-parse too
 * (tryRowToProject's own comment -- the schema can only get stricter over
 * time), and DELETE /auth/account's own cleanup (apps/api/src/routes/
 * auth.ts) must reach every project this user owns, including one whose
 * spec no longer validates -- going through getProject/listProjectsForUser
 * for that would silently skip it, leaving its tables, checkpoints, and
 * WhatsApp data (and the project row itself) permanently orphaned under a
 * deleted user id right after that same request reports success.
 */
export function deleteProject(db: ForgeDatabase, projectId: string): void {
  const row = db.prepare("SELECT spec_json FROM projects WHERE id = ?").get(projectId) as
    | { spec_json: string }
    | undefined;
  const entityNames = new Set(row ? extractEntityNamesFromSpecJson(row.spec_json) : []);
  for (const entityName of listAllCheckpointedEntityNames(db, projectId)) entityNames.add(entityName);
  for (const entityName of listHistoricalEntityNames(db, projectId)) entityNames.add(entityName);
  for (const entityName of entityNames) {
    const table = tableNameFor(projectId, entityName);
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
  }
  deleteCheckpointsForProject(db, projectId);
  removeAllCollaborators(db, projectId);
  deleteWhatsAppData(db, projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
}

/**
 * Raw query -- selects only the `id` column, so (unlike listProjectsForUser)
 * it never needs to parse spec_json and can never silently miss a project
 * whose stored spec fails ProductSpecSchema.parse (see tryRowToProject's
 * own comment: a project written by an older app version is a real,
 * expected case, not a hypothetical). DELETE /auth/account needs exactly
 * this: every project id this user owns, with no possibility of one
 * silently falling through a tolerant listing meant for display.
 */
export function listOwnedProjectIds(db: ForgeDatabase, ownerId: string): string[] {
  const rows = db.prepare("SELECT id FROM projects WHERE ownerId = ?").all(ownerId) as { id: string }[];
  return rows.map((r) => r.id);
}
