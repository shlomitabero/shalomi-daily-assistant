import type { Project, ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";

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
  };
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
  const rows = db
    .prepare("SELECT * FROM projects WHERE ownerId = ? ORDER BY createdAt DESC")
    .all(ownerId) as Record<string, unknown>[];
  return rows.map(rowToProject);
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
