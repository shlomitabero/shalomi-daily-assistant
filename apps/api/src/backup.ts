import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { listRecords, type ForgeDatabase } from "@forge/db";
import { recordDisplayLabel } from "./displayField.js";

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

/**
 * A value starting with =, +, -, @, or a tab/CR is prefixed with a leading
 * single quote before the usual comma/quote/newline wrapping -- see the
 * matching comment on entityFormatting.ts's own csvEscape (CSV/formula
 * injection, CWE-1236): spreadsheet apps treat an unguarded cell like that
 * as a formula, and a stored field can hold arbitrary text, not just
 * values this app itself ever wrote.
 */
function csvEscape(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/**
 * Numbers and dates are deliberately left unformatted (no thousands
 * separator, no locale date reordering) -- unlike this same value's
 * on-screen table rendering elsewhere, this CSV is meant to be re-openable
 * as plain data (and could plausibly be re-imported via the per-entity
 * "Import CSV" feature, which shares this exact column format). A
 * locale-formatted "1,500" or "1/2/2024" wouldn't round-trip cleanly.
 */
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
