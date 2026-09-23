import type { Checkpoint, ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

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

export function getCheckpoint(db: ForgeDatabase, id: string): Checkpoint | undefined {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCheckpoint(row) : undefined;
}

/** Part of deleteProject's cleanup (projects.ts) -- a deleted project's history has nothing left to restore. */
export function deleteCheckpointsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM checkpoints WHERE projectId = ?").run(projectId);
}
