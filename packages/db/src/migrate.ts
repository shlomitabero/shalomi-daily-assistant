import type { Entity, Field, ProductSpec } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { assertSafeIdentifier, tableNameFor } from "./identifiers.js";

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
        fk = ` REFERENCES ${relatedTable}(id)`;
      }
      columns.push(`${columnName} ${sqlType}${notNull}${fk}`);
    }
    return `CREATE TABLE IF NOT EXISTS ${table} (${columns.join(", ")})`;
  });
}

export function applyMigrations(db: ForgeDatabase, projectId: string, spec: ProductSpec): void {
  const statements = generateCreateTableStatements(projectId, spec);
  for (const statement of statements) {
    db.exec(statement);
  }
}
