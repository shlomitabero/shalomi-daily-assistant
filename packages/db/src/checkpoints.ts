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
  const rows = db
    .prepare("SELECT * FROM checkpoints WHERE projectId = ? ORDER BY createdAt DESC")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToCheckpoint);
}

export function getCheckpoint(db: ForgeDatabase, id: string): Checkpoint | undefined {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCheckpoint(row) : undefined;
}
