import type { Entity, EntityRecord, Field } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { assertSafeIdentifier, quoteIdentifier, tableNameFor } from "./identifiers.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Every date field's canonical stored representation is exactly the
 * YYYY-MM-DD shape an <input type="date"> produces (see seed.ts's own
 * `toISOString().slice(0, 10)` and EntityPanel.tsx's date input) --
 * accepts that shape and rejects anything else, including a
 * syntactically-shaped but calendrically impossible date like
 * "2024-13-45" (the Date constructor silently rolls an out-of-range
 * month/day over into a *different*, wrong date instead of rejecting it,
 * so the parsed year/month/day are checked back against what was typed).
 */
function isValidDateString(value: string): boolean {
  const match = DATE_FORMAT.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

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
    case "date": {
      const str = String(raw);
      if (!isValidDateString(str)) {
        throw new ValidationError(`Field "${field.name}" must be a valid date in YYYY-MM-DD format`);
      }
      return str;
    }
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
    `INSERT INTO ${quoteIdentifier(table)} (createdAt, ${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
  );
  const result = stmt.run(createdAt, ...values);
  return getRecord(db, projectId, entity, Number(result.lastInsertRowid))!;
}

export function listRecords(db: ForgeDatabase, projectId: string, entity: Entity): EntityRecord[] {
  const table = tableNameFor(projectId, entity.name);
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY id DESC`).all() as Record<string, unknown>[];
  return rows.map((row) => rowToRecord(entity, row));
}

export function countRecords(db: ForgeDatabase, projectId: string, entity: Entity): number {
  const table = tableNameFor(projectId, entity.name);
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${quoteIdentifier(table)}`).get() as { count: number };
  return row.count;
}

export function getRecord(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  id: number,
): EntityRecord | undefined {
  const table = tableNameFor(projectId, entity.name);
  const row = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE id = ?`).get(id) as
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

  const setClause = columns.map((c) => `${quoteIdentifier(c)} = ?`).join(", ");
  db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE id = ?`).run(...values, id);
  return getRecord(db, projectId, entity, id)!;
}

export function deleteRecord(db: ForgeDatabase, projectId: string, entity: Entity, id: number): void {
  const table = tableNameFor(projectId, entity.name);
  const result = db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE id = ?`).run(id);
  if (result.changes === 0) {
    throw new NotFoundError(`Record ${id} not found in ${entity.name}`);
  }
}
