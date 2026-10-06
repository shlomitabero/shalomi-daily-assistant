import type { Checkpoint, ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";

/**
 * Time Machine storage: every successful build or refine snapshots the
 * resulting spec here. Restoring a checkpoint moves the project's spec
 * pointer back to that snapshot; it never drops tables/columns added since
 * (see migrate.ts — migrations in this engine are additive-only), so a
 * restore is always safe to apply, it just stops surfacing fields/entities
 * added after that point until refined forward again.
 */
export function ensureCheckpointsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'build',
      spec_json TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  // A table created by an older version of this app has no `kind` column at
  // all -- additive-only, same discipline migrate.ts uses for every
  // per-project entity table, so a pre-existing checkpoints table is never
  // dropped or recreated here. ADD COLUMN gives every existing row the
  // column's own 'build' default, then this one-time UPDATE backfills
  // "refine" using the exact same label-prefix heuristic getCheckpointType
  // itself used to live-classify a checkpoint before this column existed --
  // the best information available for data written before today. A
  // checkpoint already renamed away from its original "Refine: .../שיפור:
  // ..." prefix before this migration ever runs can't be recovered
  // correctly by this one-time backfill -- an honest, unavoidable limit of
  // reconstructing history from the only signal that ever existed for it.
  // Every checkpoint created after this point gets its `kind` set directly
  // at insertCheckpoint instead, never derived from (or vulnerable to a
  // later rename of) its label again.
  const hasKindColumn = (db.prepare("PRAGMA table_info(checkpoints)").all() as { name: string }[]).some((c) => c.name === "kind");
  if (!hasKindColumn) {
    db.exec("ALTER TABLE checkpoints ADD COLUMN kind TEXT NOT NULL DEFAULT 'build'");
    db.exec(`UPDATE checkpoints SET kind = 'refine' WHERE label LIKE 'Refine:%' OR label LIKE 'שיפור:%'`);
  }

  // A durable, append-only record of every entity name a project's spec has
  // ever contained -- written once at insertCheckpoint and never pruned by
  // deleteCheckpoint, unlike listAllCheckpointedEntityNames below, which
  // re-derives the same thing live from whichever checkpoints still happen
  // to exist. deleteProject (projects.ts) needs the entity name for every
  // real table it must drop; deleting a *single* checkpoint (round 216,
  // an ordinary, advertised cleanup action -- "an experimental refine that
  // went nowhere") can remove the only checkpoint whose spec_json still
  // mentioned an entity later refined out of the spec, with no other
  // checkpoint or the current spec mentioning it either -- at that point
  // listAllCheckpointedEntityNames alone can no longer see it, and that
  // entity's real table becomes permanently orphaned the moment the whole
  // project is later deleted (confirmed via a direct repro: build with
  // Customer+Order, refine away Order, delete the build checkpoint, delete
  // the project -- the Order table survives with nothing left anywhere
  // referencing it). This table is the fix: once an entity name is ever
  // written here, it survives for as long as the project itself does.
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_entity_history (
      projectId TEXT NOT NULL,
      entityName TEXT NOT NULL,
      PRIMARY KEY (projectId, entityName)
    )
  `);
  // Backfill for data written before this table existed -- every checkpoint
  // still on file plus every project's own current spec, which the ledger
  // would otherwise never have learned about if its own build/refine
  // happened before this round. Re-run (idempotent via INSERT OR IGNORE)
  // on every startup rather than gated behind "table just created": cheap
  // at this app's scale, and self-healing if the ledger and the checkpoints
  // table ever drifted apart for any other reason.
  // The `projects` table may not exist yet when this runs in isolation (a
  // unit test that calls ensureCheckpointsTable without ensureProjectsTable
  // first); real app startup (store.ts) always creates it first, but the
  // backfill degrades to checkpoints-only rather than throwing either way.
  const hasProjectsTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
    .get();
  const allSpecRows = db
    .prepare(
      hasProjectsTable
        ? `SELECT projectId, spec_json FROM checkpoints
           UNION ALL
           SELECT id AS projectId, spec_json FROM projects`
        : `SELECT projectId, spec_json FROM checkpoints`,
    )
    .all() as { projectId: string; spec_json: string }[];
  const insertHistoryEntry = db.prepare("INSERT OR IGNORE INTO checkpoint_entity_history (projectId, entityName) VALUES (?, ?)");
  for (const row of allSpecRows) {
    for (const entityName of extractEntityNamesFromSpecJson(row.spec_json)) {
      insertHistoryEntry.run(row.projectId, entityName);
    }
  }
}

function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    label: row.label as string,
    kind: row.kind as "build" | "refine",
    spec: ProductSpecSchema.parse(JSON.parse(row.spec_json as string)),
    createdAt: row.createdAt as string,
  };
}

/**
 * ProductSpecSchema can only get stricter over time (see the identical
 * rationale on projects.ts's tryRowToProject), so a checkpoint written by
 * an older version of this app -- and no longer parseable against today's
 * schema -- is a real, expected future case. Unlike a single-checkpoint
 * fetch, a list has other valid checkpoints to still show, so one bad row
 * is excluded rather than taking down the whole Time Machine history for
 * the project.
 */
function tryRowToCheckpoint(row: Record<string, unknown>): Checkpoint | undefined {
  try {
    return rowToCheckpoint(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Checkpoint ${row.id as string} has a stored spec that no longer matches the current schema; excluded from listings until fixed.`, err);
    return undefined;
  }
}

export function insertCheckpoint(
  db: ForgeDatabase,
  checkpoint: { id: string; projectId: string; label: string; kind: "build" | "refine"; spec: ProductSpec },
): Checkpoint {
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO checkpoints (id, projectId, label, kind, spec_json, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(checkpoint.id, checkpoint.projectId, checkpoint.label, checkpoint.kind, JSON.stringify(checkpoint.spec), createdAt);
  // Durable ledger entry (see ensureCheckpointsTable's own doc-comment) --
  // written here, at the one point this entity name is known to be real,
  // so it survives this checkpoint being individually deleted later.
  const insertHistoryEntry = db.prepare("INSERT OR IGNORE INTO checkpoint_entity_history (projectId, entityName) VALUES (?, ?)");
  for (const entity of checkpoint.spec.entities) {
    insertHistoryEntry.run(checkpoint.projectId, entity.name);
  }
  return { ...checkpoint, createdAt };
}

export function listCheckpoints(db: ForgeDatabase, projectId: string): Checkpoint[] {
  // createdAt has only millisecond resolution, so two checkpoints inserted
  // in quick succession (e.g. a build's checkpoint immediately followed by
  // a refine's) can share the same value; ORDER BY createdAt DESC alone
  // leaves that tie's order undefined. rowid strictly increases with
  // insertion order in this SQLite table (not declared WITHOUT ROWID), so
  // it breaks the tie deterministically in favor of "most recently
  // inserted first" -- exactly what "newest first" means for a tie.
  const rows = db
    .prepare("SELECT * FROM checkpoints WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(tryRowToCheckpoint).filter((c): c is Checkpoint => c !== undefined);
}

/**
 * deleteProject (projects.ts) needs every entity name this project's
 * checkpoint history could ever have produced a real data table for, so
 * it can drop tables for entities later removed from the spec (migrate.ts
 * is additive-only -- see deleteProject's own doc-comment). Going through
 * listCheckpoints for that would be wrong: tryRowToCheckpoint deliberately
 * excludes a checkpoint whose *other* fields (roles, summary, ...) no
 * longer satisfy a ProductSpecSchema that has only gotten stricter since
 * the checkpoint was written (see that schema's own doc-comment) -- the
 * right behavior for a user-facing history list, but it would silently
 * drop that checkpoint's entities from deleteProject's accounting too,
 * leaving their real tables permanently orphaned. Extracting entity names
 * only needs `entities` to be an array of objects with a string `name` --
 * far weaker than the full schema -- so this reads spec_json directly
 * instead of going through rowToCheckpoint/ProductSpecSchema.parse.
 */
/**
 * Shared by listAllCheckpointedEntityNames below and projects.ts's own
 * deleteProject, which needs the exact same tolerant extraction for a
 * project's own spec_json (not just its checkpoints) for the identical
 * reason: a project row can fail full ProductSpecSchema.parse too (see
 * projects.ts's tryRowToProject), and deleteProject can't afford to miss
 * entities just because the rest of the stored spec no longer validates.
 */
export function extractEntityNamesFromSpecJson(specJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specJson);
  } catch {
    return [];
  }
  const entities = (parsed as { entities?: unknown })?.entities;
  if (!Array.isArray(entities)) return [];
  const names: string[] = [];
  for (const entity of entities) {
    const name = (entity as { name?: unknown })?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

export function listAllCheckpointedEntityNames(db: ForgeDatabase, projectId: string): string[] {
  const rows = db
    .prepare("SELECT spec_json FROM checkpoints WHERE projectId = ?")
    .all(projectId) as { spec_json: string }[];
  const names = new Set<string>();
  for (const row of rows) {
    for (const name of extractEntityNamesFromSpecJson(row.spec_json)) names.add(name);
  }
  return [...names];
}

/**
 * The durable twin of listAllCheckpointedEntityNames above (see
 * ensureCheckpointsTable's own doc-comment for why the two differ):
 * listAllCheckpointedEntityNames only ever sees entity names from
 * checkpoints that still exist right now, so a deleted single checkpoint
 * (round 216) can make it forget an entity name forever, even though
 * that entity genuinely had a real data table at some point. This reads
 * the append-only ledger instead -- every entity name this project's spec
 * has EVER contained, independent of which checkpoints happen to still be
 * around. deleteProject (projects.ts) unions both, plus the current spec,
 * so losing any one source is never by itself enough to orphan a table.
 */
export function listHistoricalEntityNames(db: ForgeDatabase, projectId: string): string[] {
  const rows = db.prepare("SELECT entityName FROM checkpoint_entity_history WHERE projectId = ?").all(projectId) as { entityName: string }[];
  return rows.map((r) => r.entityName);
}

export function getCheckpoint(db: ForgeDatabase, id: string): Checkpoint | undefined {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCheckpoint(row) : undefined;
}

/**
 * Renames a checkpoint's own label -- Time Machine only ever gave a
 * checkpoint an automatic label ("Initial build", "Refine: <instruction>"),
 * with no way to give an important one a name that's actually memorable
 * months later (e.g. "before the pricing overhaul"). Scoped to projectId in
 * the same WHERE clause as the checkpoint id itself (mirroring
 * deleteWhatsAppMessage's own convention in whatsapp.ts), so a checkpoint
 * id belonging to a different project can never be renamed through this
 * call. Throws NotFoundError for an id that doesn't exist in this
 * project's own history. Deliberately touches only `label` -- `kind` is
 * set once at insertCheckpoint and never revisited here, so renaming a
 * checkpoint (even to text that happens to look like the other kind's own
 * default label) can never change how HistoryPanel's build/refine filter
 * classifies it.
 */
export function renameCheckpoint(db: ForgeDatabase, projectId: string, checkpointId: string, label: string): Checkpoint {
  const result = db.prepare("UPDATE checkpoints SET label = ? WHERE id = ? AND projectId = ?").run(label, checkpointId, projectId);
  if (result.changes === 0) {
    throw new NotFoundError(`Checkpoint ${checkpointId} not found in project ${projectId}`);
  }
  return getCheckpoint(db, checkpointId)!;
}

/**
 * Part of deleteProject's cleanup (projects.ts) -- a deleted project's
 * history has nothing left to restore. Also clears this project's own rows
 * from checkpoint_entity_history: deleteProject has already read it (and
 * every other source) into its own entityNames set by the time this runs,
 * so nothing is lost by clearing it here, and leaving it behind would let
 * the ledger grow forever with rows for projects that no longer exist.
 */
export function deleteCheckpointsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM checkpoints WHERE projectId = ?").run(projectId);
  db.prepare("DELETE FROM checkpoint_entity_history WHERE projectId = ?").run(projectId);
}

/**
 * Removes a single checkpoint -- Time Machine's history otherwise only ever
 * grows (every build and every refine adds one, with no way to prune a
 * single unwanted entry, e.g. an experimental refine that went nowhere),
 * the same real gap round 208 closed for the WhatsApp message log.
 * Scoped to projectId in the same WHERE clause as the checkpoint id itself,
 * the same convention renameCheckpoint above and deleteWhatsAppMessage
 * (whatsapp.ts) already use, so a checkpoint id belonging to a different
 * project can never be deleted through this call. Deleting a checkpoint
 * never touches the project's own current spec -- that lives on the
 * project row itself, independent of this table -- so even deleting the
 * checkpoint that happens to match the current state (the "Current" chip
 * in HistoryPanel.tsx) is harmless; it just removes that historical entry.
 * Throws NotFoundError for an id that doesn't exist in this project's own
 * history.
 */
export function deleteCheckpoint(db: ForgeDatabase, projectId: string, checkpointId: string): void {
  const result = db.prepare("DELETE FROM checkpoints WHERE id = ? AND projectId = ?").run(checkpointId, projectId);
  if (result.changes === 0) {
    throw new NotFoundError(`Checkpoint ${checkpointId} not found in project ${projectId}`);
  }
}
