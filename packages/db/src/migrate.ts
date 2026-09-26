import type { Entity, Field, ProductSpec } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { assertSafeIdentifier, quoteIdentifier, tableNameFor } from "./identifiers.js";

function sqlTypeFor(field: Field): string {
  switch (field.type) {
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    case "relation":
      return "INTEGER";
    case "text":
    case "longtext":
    case "enum":
    case "date":
    default:
      return "TEXT";
  }
}

/**
 * Builds one CREATE TABLE statement per entity. Every generated app gets a
 * real SQL schema — this is the "Database Engineer Agent" of the Forge AI
 * vision reduced to its honest Phase 1 form: deterministic schema-from-spec,
 * not yet a full migration-diffing/rollback system (see roadmap.md).
 */
export function generateCreateTableStatements(projectId: string, spec: ProductSpec): string[] {
  const entityNames = new Set(spec.entities.map((e) => e.name));
  return spec.entities.map((entity: Entity) => {
    const table = tableNameFor(projectId, entity.name);
    const columns = [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "createdAt TEXT NOT NULL",
    ];
    for (const field of entity.fields) {
      const columnName = assertSafeIdentifier(field.name, "column");
      const sqlType = sqlTypeFor(field);
      const notNull = field.required ? " NOT NULL" : "";
      let fk = "";
      if (field.type === "relation" && field.relationTo && entityNames.has(field.relationTo)) {
        const relatedTable = tableNameFor(projectId, field.relationTo);
        fk = ` REFERENCES ${quoteIdentifier(relatedTable)}(id)`;
      }
      columns.push(`${quoteIdentifier(columnName)} ${sqlType}${notNull}${fk}`);
    }
    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (${columns.join(", ")})`;
  });
}

export function applyMigrations(db: ForgeDatabase, projectId: string, spec: ProductSpec): void {
  const statements = generateCreateTableStatements(projectId, spec);
  for (const statement of statements) {
    db.exec(statement);
  }
}

/** The set of column names SQLite already has for a table (empty if the table doesn't exist yet). */
function existingColumns(db: ForgeDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export interface MigrationChange {
  type: "new_table" | "new_column" | "type_changed";
  table: string;
  column?: string;
  /** Only set for "type_changed": the field's old and new declared type, for a message that says what actually changed. */
  fromType?: string;
  toType?: string;
}

/**
 * Additive-only migration: creates tables for entities that didn't exist in
 * `previousSpec`, and ALTER TABLE ADD COLUMN for fields that didn't exist on
 * an entity that did. Never drops or renames anything, even if a field or
 * entity was removed from the new spec — consistent with the vision's
 * "never destroy work" principle (section 70) and with Time Machine
 * checkpoints always being safe to restore. `previousSpec` undefined means
 * this is the first build (equivalent to applyMigrations).
 *
 * One thing this deliberately does NOT do: if a field that already existed
 * changes *type* (same name, e.g. "notes" going from text to number) rather
 * than being newly added, the SQL column's own type is left exactly as it
 * was — SQLite has no cheap, retroactive "ALTER COLUMN TYPE" (the only real
 * fix is create-a-new-table-and-copy-with-conversion, a genuine design
 * decision about how to handle existing rows that don't cleanly convert,
 * not a mechanical patch). Silently doing nothing here would leave the
 * spec claiming a type the database doesn't actually have, so this at
 * least surfaces it as a reported "type_changed" entry (see pipeline.ts's
 * own message for it) instead of a gap nobody can see.
 */
export function diffAndMigrate(
  db: ForgeDatabase,
  projectId: string,
  previousSpec: ProductSpec | undefined,
  nextSpec: ProductSpec,
): MigrationChange[] {
  if (!previousSpec) {
    applyMigrations(db, projectId, nextSpec);
    return nextSpec.entities.map((e) => ({ type: "new_table" as const, table: tableNameFor(projectId, e.name) }));
  }

  const statements = generateCreateTableStatements(projectId, nextSpec);
  const previousEntities = new Map(previousSpec.entities.map((e) => [e.name, e]));
  const changes: MigrationChange[] = [];

  nextSpec.entities.forEach((entity, index) => {
    const table = tableNameFor(projectId, entity.name);
    const prevEntity = previousEntities.get(entity.name);

    if (!prevEntity) {
      db.exec(statements[index]);
      changes.push({ type: "new_table", table });
      return;
    }

    const prevFieldsByName = new Map(prevEntity.fields.map((f) => [f.name, f]));
    const currentColumns = existingColumns(db, table);
    for (const field of entity.fields) {
      const prevField = prevFieldsByName.get(field.name);
      if (prevField) {
        if (prevField.type !== field.type) {
          changes.push({
            type: "type_changed",
            table,
            column: assertSafeIdentifier(field.name, "column"),
            fromType: prevField.type,
            toType: field.type,
          });
        }
        continue;
      }
      const columnName = assertSafeIdentifier(field.name, "column");
      // Whether to physically run the ALTER (has SQLite already got this
      // column?) and whether to report it as a change (is it new relative
      // to previousSpec?) are separate questions -- a column can be
      // physically present already while still being new *this call*, e.g.
      // when pipeline.ts retries diffAndMigrate with the same previousSpec
      // after the Debug Agent fixes a later entity that made an earlier
      // partial attempt throw. Reporting it either way keeps the returned
      // change list an accurate diff against previousSpec regardless of
      // what a prior, partially-failed call already applied.
      if (!currentColumns.has(columnName)) {
        const sqlType = sqlTypeFor(field);
        // NOT NULL / FK deliberately omitted: SQLite can't retroactively
        // satisfy either constraint against a table's existing rows. The
        // column is added nullable; required-ness is still enforced by the
        // API for every write going forward.
        db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(columnName)} ${sqlType}`);
      }
      changes.push({ type: "new_column", table, column: columnName });
    }
  });

  return changes;
}
