import type { Entity, EntityRecord, Field } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { assertSafeIdentifier, tableNameFor } from "./identifiers.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

function coerceValue(field: Field, raw: unknown): string | number | null {
  if (raw === undefined || raw === null || raw === "") {
    if (field.required) {
      throw new ValidationError(`Field "${field.name}" is required`);
    }
    return null;
  }
  switch (field.type) {
    case "number":
    case "relation": {
      const num = Number(raw);
      if (Number.isNaN(num)) {
        throw new ValidationError(`Field "${field.name}" must be a number`);
      }
      return num;
    }
    case "boolean":
      return raw === true || raw === "true" || raw === 1 || raw === "1" ? 1 : 0;
    case "enum":
      if (field.enumValues && !field.enumValues.includes(String(raw))) {
        throw new ValidationError(
          `Field "${field.name}" must be one of: ${field.enumValues.join(", ")}`,
        );
      }
      return String(raw);
    default:
      return String(raw);
  }
}

function rowToRecord(entity: Entity, row: Record<string, unknown>): EntityRecord {
  const record: EntityRecord = { id: row.id as number, createdAt: row.createdAt as string };
  for (const field of entity.fields) {
    const value = row[field.name];
    record[field.name] = field.type === "boolean" ? Boolean(value) : (value as string | number | null);
  }
  return record;
}

function fieldColumns(entity: Entity): string[] {
  return entity.fields.map((f) => assertSafeIdentifier(f.name, "column"));
}

export function insertRecord(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  data: Record<string, unknown>,
): EntityRecord {
  const table = tableNameFor(projectId, entity.name);
  const columns = fieldColumns(entity);
  const values = entity.fields.map((field) => coerceValue(field, data[field.name]));
  const createdAt = new Date().toISOString();

  const placeholders = ["?", ...columns.map(() => "?")].join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${table} (createdAt, ${columns.join(", ")}) VALUES (${placeholders})`,
  );
  const result = stmt.run(createdAt, ...values);
  return getRecord(db, projectId, entity, Number(result.lastInsertRowid))!;
}

export function listRecords(db: ForgeDatabase, projectId: string, entity: Entity): EntityRecord[] {
  const table = tableNameFor(projectId, entity.name);
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all() as Record<string, unknown>[];
  return rows.map((row) => rowToRecord(entity, row));
}

export function countRecords(db: ForgeDatabase, projectId: string, entity: Entity): number {
  const table = tableNameFor(projectId, entity.name);
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function getRecord(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  id: number,
): EntityRecord | undefined {
  const table = tableNameFor(projectId, entity.name);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(entity, row) : undefined;
}

export function updateRecord(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  id: number,
  data: Record<string, unknown>,
): EntityRecord {
  const existing = getRecord(db, projectId, entity, id);
  if (!existing) {
    throw new NotFoundError(`Record ${id} not found in ${entity.name}`);
  }
  const table = tableNameFor(projectId, entity.name);
  const columns = fieldColumns(entity);
  const merged = { ...existing, ...data };
  const values = entity.fields.map((field) => coerceValue(field, merged[field.name]));

  const setClause = columns.map((c) => `${c} = ?`).join(", ");
  db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values, id);
  return getRecord(db, projectId, entity, id)!;
}

export function deleteRecord(db: ForgeDatabase, projectId: string, entity: Entity, id: number): void {
  const table = tableNameFor(projectId, entity.name);
  const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  if (result.changes === 0) {
    throw new NotFoundError(`Record ${id} not found in ${entity.name}`);
  }
}
