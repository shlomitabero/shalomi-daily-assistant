import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { listRecords, listWhatsAppMessages, type ForgeDatabase, type WhatsAppMessage } from "@forge/db";
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
 * zip.ts's buildZip writes an entry's `path` into the archive verbatim,
 * with no validation at all (unlike packages/db/src/identifiers.ts's
 * tableNameFor, which sanitizes an entity name before it becomes a SQL
 * table, or codegen.ts's assertSafe, which outright rejects an unsafe
 * entity/field name before the exported app is even generated -- see
 * round 283/284's roadmap entries). tableNameFor SANITIZES rather than
 * rejects, so a project with an entity name containing "/" or similar
 * builds and runs live in this app perfectly normally; by the time a real
 * user clicks "Backup all data" on it, entity.name reaches this ZIP-path
 * construction completely unguarded. A "/" would create an unintended
 * nested folder inside the downloaded archive, breaking this feature's
 * own "one flat CSV per entity" promise -- and replacing every path
 * separator also rules out path traversal (a naive unzip tool interprets
 * "../" as a directory-escaping component only when "/" is actually
 * present to split the path into segments; a flat filename with no
 * separators at all, even one containing literal dots, can never do
 * that). Deliberately narrower than tableNameFor's full ASCII-only
 * sanitization: only the characters that are actually unsafe in a zip/
 * filesystem path are replaced, so a real Hebrew entity name stays
 * human-readable in the archive's own file listing -- the entire point
 * of this feature.
 */
function sanitizeZipEntryName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
}

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
 * listWhatsAppMessages (packages/db/src/whatsapp.ts) is paginated -- built
 * for the log panel's own "load more" UI, never meant to return a whole
 * project's history in one call. A backup has no such limit: it walks
 * every page (using the same `limit+1`-derived `hasMore` flag the panel's
 * own "load more" button already relies on) until none remain, so a
 * project with thousands of messages backs up in full, not just its most
 * recent 50.
 */
function collectAllWhatsAppMessages(db: ForgeDatabase, projectId: string): WhatsAppMessage[] {
  const all: WhatsAppMessage[] = [];
  const pageSize = 200;
  let offset = 0;
  for (;;) {
    const { messages, hasMore } = listWhatsAppMessages(db, projectId, pageSize, offset);
    all.push(...messages);
    if (!hasMore) break;
    offset += pageSize;
  }
  return all;
}

function whatsappMessagesToCsv(messages: WhatsAppMessage[]): string {
  const header = ["Direction", "From", "To", "Message", "Matched Record", "Status", "Date"].map(csvEscape).join(",");
  const rows = messages.map((m) =>
    [
      m.direction === "in" ? "Incoming" : "Outgoing",
      m.fromNumber,
      m.toNumber,
      m.body,
      m.matchedLabel ?? "",
      m.status,
      m.createdAt,
    ]
      .map((v) => csvEscape(v))
      .join(","),
  );
  return [header, ...rows].join("\r\n");
}

/**
 * Builds one ZIP entry per entity ("<EntityName>.csv"), each a real,
 * Excel-friendly CSV (BOM + CRLF) of every record currently stored for
 * it. Every entity's records are fetched once up front so relation
 * fields resolve to the related record's display label regardless of
 * which entity is processed first.
 *
 * A project's real WhatsApp conversation history is genuine business
 * data too -- a shop owner backing up "all data" and later needing to
 * show what a customer actually said has no other way to get it out,
 * since the log panel's own "Download log" only ever serializes whatever
 * page happens to be loaded in the browser at that moment, not the whole
 * history. Added as one more CSV entry, "WhatsApp Messages.csv", using
 * the exact same BOM/CRLF/csvEscape conventions as every entity CSV
 * above -- omitted entirely (not an empty file) for a project that never
 * connected WhatsApp at all, the same "nothing to report" convention
 * empty-but-real entities don't get (they still exist in the spec, so
 * they always get a CSV; WhatsApp is a project-optional integration, not
 * part of the spec, so its absence is the normal case, not a gap).
 */
export function generateBackupZipEntries(db: ForgeDatabase, project: Project): { path: string; content: string }[] {
  const allEntities = project.spec.entities;
  const recordsByEntity: Record<string, EntityRecord[]> = {};
  for (const entity of allEntities) {
    recordsByEntity[entity.name] = listRecords(db, project.id, entity);
  }

  const entries = allEntities.map((entity) => ({
    path: `${sanitizeZipEntryName(entity.name)}.csv`,
    content: "﻿" + entityToCsv(entity, recordsByEntity[entity.name], allEntities, recordsByEntity),
  }));

  const whatsappMessages = collectAllWhatsAppMessages(db, project.id);
  if (whatsappMessages.length > 0) {
    entries.push({
      path: "WhatsApp Messages.csv",
      content: "﻿" + whatsappMessagesToCsv(whatsappMessages),
    });
  }

  return entries;
}
