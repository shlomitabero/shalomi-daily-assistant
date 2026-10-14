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
export function isValidDateString(value: string): boolean {
  const match = DATE_FORMAT.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  // Date.UTC(year, ...) silently adds 1900 to a year in 0-99 (legacy
  // ECMA-262 behavior), which would wrongly reject "0099-01-01" -- so the
  // date is built via setUTCFullYear, whose year argument has no such
  // special-casing, instead of passed through Date.UTC.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function coerceValue(field: Field, raw: unknown): string | number | null {
  // A whitespace-only string (" ", "\t\n", …) is not caught by `raw === ""`,
  // so it used to fall straight through to the type-specific coercion below
  // -- for a required `number`/`relation` field, `Number(" ")` is `0` (a
  // genuine JS quirk, not a NaN), so the required-field check never fired
  // and a real zero/foreign-key-0 got silently stored for input that was,
  // in substance, empty. Matches entityFormatting.ts's own CSV import,
  // which already trims each cell before checking for emptiness.
  const isEmpty = raw === undefined || raw === null || raw === "" || (typeof raw === "string" && raw.trim() === "");
  if (isEmpty) {
    if (field.required) {
      throw new ValidationError(`Field "${field.name}" is required`);
    }
    return null;
  }
  switch (field.type) {
    case "number":
    case "relation": {
      // JS's own array-to-number coercion is as much a quirk as the
      // whitespace-string and "Infinity"-string ones above: Number([]) is
      // 0 and Number([42]) is 42, not NaN, so an array raw value passed
      // Number.isFinite below and silently became a real stored id/amount
      // instead of the ValidationError every other not-really-a-number
      // input already gets -- for a *required* field this also meant the
      // required-check above never fired, since isEmpty doesn't recognize
      // an array as "no real value" either.
      if (Array.isArray(raw)) {
        throw new ValidationError(`Field "${field.name}" must be a number`);
      }
      const num = Number(raw);
      // Number.isFinite, not just !Number.isNaN: Number("Infinity") is
      // Infinity, not NaN. A client would never actually get this far
      // with a literal Infinity (JSON.stringify turns it into null first),
      // but a raw "Infinity"/"-Infinity" string reaching this function
      // directly should still be rejected, not silently stored.
      if (!Number.isFinite(num)) {
        throw new ValidationError(`Field "${field.name}" must be a number`);
      }
      return num;
    }
    case "boolean": {
      // Unlike number/relation/enum/date below, this used to have no
      // rejection path at all: a JSON request body's boolean field set to
      // anything outside the exact true/false allowlist (a typo, "yes",
      // 2, a stray string) silently became `false` and was written to the
      // DB with the request still reporting success -- round 514 fixed
      // the exact same gap one layer up, in the CSV-import parser, but
      // never touched this function, the one every actual record write
      // (including a direct API call, not just CSV import) funnels
      // through.
      if (raw === true || raw === "true" || raw === 1 || raw === "1") return 1;
      if (raw === false || raw === "false" || raw === 0 || raw === "0") return 0;
      throw new ValidationError(`Field "${field.name}" must be a boolean`);
    }
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

/**
 * A field renamed only by letter case across a refine (e.g. "email" ->
 * "Email") is a genuine no-op in diffAndMigrate (migrate.ts, rounds
 * 617/618) -- the physical column stays under its ORIGINAL casing, since
 * SQLite resolves column names case-insensitively for DDL/DML and no
 * ALTER is needed. But `row` here comes straight from `SELECT * FROM
 * ...`, keyed by node:sqlite with the column's real physical name, not by
 * the entity's current spec casing -- a plain `row[fieldName]` misses
 * entirely, silently returning undefined for a field whose data is still
 * sitting right there on disk. Falls back to a case-insensitive scan of
 * the row's own keys before giving up.
 */
function getRowValue(row: Record<string, unknown>, fieldName: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, fieldName)) return row[fieldName];
  const lowerFieldName = fieldName.toLowerCase();
  const matchingKey = Object.keys(row).find((key) => key.toLowerCase() === lowerFieldName);
  return matchingKey === undefined ? undefined : row[matchingKey];
}

function rowToRecord(entity: Entity, row: Record<string, unknown>): EntityRecord {
  const record: EntityRecord = { id: row.id as number, createdAt: row.createdAt as string };
  for (const field of entity.fields) {
    const value = getRowValue(row, field.name);
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
  const table = tableNameFor(projectId, entity.name);
  const existingRow = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!existingRow) {
    throw new NotFoundError(`Record ${id} not found in ${entity.name}`);
  }
  const columns = fieldColumns(entity);
  // Only a field the caller actually supplied is re-coerced/validated
  // against the entity's *current* definition -- an untouched field keeps
  // its already-stored raw value exactly as-is. The previous behavior
  // (`{ ...existing, ...data }` then coerceValue on every field) re-derived
  // and re-validated every field on every update, including ones the
  // caller never mentioned. That meant a refine that later tightens an
  // unrelated field on the same entity -- narrows its enumValues, or flips
  // required false->true -- would permanently fail every future update to
  // any pre-existing row whose stored value for that field no longer
  // satisfies the new definition, even an update (inline cell edit, bulk
  // field update, a Kanban drag) that never touches that field at all.
  const values = entity.fields.map((field) =>
    Object.prototype.hasOwnProperty.call(data, field.name) ? coerceValue(field, data[field.name]) : getRowValue(existingRow, field.name),
  );

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
