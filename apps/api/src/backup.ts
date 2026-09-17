import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { listRecords, type ForgeDatabase } from "@forge/db";

/**
 * "Backup all data": one ZIP containing one CSV per entity, so a real
 * business owner can get their whole project's data out at once instead
 * of visiting every tab's own CSV export button. Deliberately server-side
 * (not a client-side loop of the existing per-entity export) so it's one
 * request, one file, and reuses the already-proven dependency-free
 * zip.ts writer the code-export endpoint uses -- no new zip logic.
 *
 * The CSV formatting logic here intentionally mirrors (rather than
 * imports) apps/web/src/entityFormatting.ts's `recordsToCsv` and
 * apps/api/src/codegen.ts's own copy of the same logic -- the established
 * pattern in this codebase of duplicating small, self-contained
 * formatting helpers per surface (live preview, exported app, and now
 * the server) instead of a cross-package shared dependency for a few
 * dozen lines of pure formatting.
 */

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];

function pickDisplayField(entity: Entity): Field | null {
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText ?? entity.fields[0] ?? null;
}

function recordDisplayLabel(entity: Entity, record: EntityRecord): string {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return `#${record.id}`;
  return String(value);
}

function fieldDisplayValue(
  field: Field,
  value: unknown,
  allEntities: Entity[],
  recordsByEntity: Record<string, EntityRecord[]>,
): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") {
    const targetEntity = field.relationTo ? allEntities.find((e) => e.name === field.relationTo) : undefined;
    const records = field.relationTo ? recordsByEntity[field.relationTo] : undefined;
    if (!targetEntity || !records) return `#${value}`;
    const match = records.find((r) => Number(r.id) === Number(value));
    return match ? recordDisplayLabel(targetEntity, match) : `#${value}`;
  }
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  if (field.type === "date") {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  }
  if (field.type === "number") return Number(value).toLocaleString();
  return String(value);
}

function entityToCsv(entity: Entity, records: EntityRecord[], allEntities: Entity[], recordsByEntity: Record<string, EntityRecord[]>): string {
  const header = entity.fields.map((f) => csvEscape(f.label ?? f.name)).join(",");
  const rows = records.map((record) =>
    entity.fields.map((f) => csvEscape(fieldDisplayValue(f, record[f.name], allEntities, recordsByEntity))).join(","),
  );
  return [header, ...rows].join("\r\n");
}

/**
 * Builds one ZIP entry per entity ("<EntityName>.csv"), each a real,
 * Excel-friendly CSV (BOM + CRLF) of every record currently stored for
 * it. Every entity's records are fetched once up front so relation
 * fields resolve to the related record's display label regardless of
 * which entity is processed first.
 */
export function generateBackupZipEntries(db: ForgeDatabase, project: Project): { path: string; content: string }[] {
  const allEntities = project.spec.entities;
  const recordsByEntity: Record<string, EntityRecord[]> = {};
  for (const entity of allEntities) {
    recordsByEntity[entity.name] = listRecords(db, project.id, entity);
  }

  return allEntities.map((entity) => ({
    path: `${entity.name}.csv`,
    content: "﻿" + entityToCsv(entity, recordsByEntity[entity.name], allEntities, recordsByEntity),
  }));
}
