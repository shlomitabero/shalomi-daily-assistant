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
      spec_json TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
}

function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    label: row.label as string,
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
  checkpoint: { id: string; projectId: string; label: string; spec: ProductSpec },
): Checkpoint {
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO checkpoints (id, projectId, label, spec_json, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(checkpoint.id, checkpoint.projectId, checkpoint.label, JSON.stringify(checkpoint.spec), createdAt);
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
 * project's own history.
 */
export function renameCheckpoint(db: ForgeDatabase, projectId: string, checkpointId: string, label: string): Checkpoint {
  const result = db.prepare("UPDATE checkpoints SET label = ? WHERE id = ? AND projectId = ?").run(label, checkpointId, projectId);
  if (result.changes === 0) {
    throw new NotFoundError(`Checkpoint ${checkpointId} not found in project ${projectId}`);
  }
  return getCheckpoint(db, checkpointId)!;
}

/** Part of deleteProject's cleanup (projects.ts) -- a deleted project's history has nothing left to restore. */
export function deleteCheckpointsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM checkpoints WHERE projectId = ?").run(projectId);
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
