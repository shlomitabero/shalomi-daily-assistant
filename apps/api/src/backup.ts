import { readFileSync } from "node:fs";
import type { Entity, EntityRecord, Field, Project } from "@forge/shared";
import { listRecords, listWhatsAppMessages, type ForgeDatabase, type WhatsAppMessage } from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { recordDisplayLabel } from "./displayField.js";
import { resolveUploadedFilePath } from "./uploadPaths.js";

type Lang = "he" | "en";

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
 *
 * A value that already starts with a literal "'" is also prefixed with one
 * more "'" -- this backup CSV is re-importable via the per-entity "Import
 * CSV" feature (see this file's own comment below on numbers/dates being
 * left unformatted for exactly that reason), which shares entityFormatting.
 * ts's unescapeCsvGuard: without this, a value like "'-interesting" (a real
 * leading apostrophe immediately followed by a guarded character) exports
 * to the exact same bytes as the guard applied to "-interesting", so that
 * shared unescape logic can't tell them apart on import and silently drops
 * the real apostrophe. Mirrors entityFormatting.ts's own csvEscape, which
 * already carries this fix.
 */
function csvEscape(value: string): string {
  const guarded = /^[=+\-@\t\r']/.test(value) ? `'${value}` : value;
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
 *
 * Resolving a relation field used to `records.find(...)` a full linear
 * scan of the related entity's whole record array, repeated once per row
 * -- for an entity with N records and a relation field pointing to one
 * with M records, that's O(N*M) of synchronous, blocking work inside a
 * single request handler, before even counting a second relation field
 * or a third entity. A per-entity id->record Map (built once, up front,
 * in generateBackupZipEntries) turns this lookup into O(1): with tens of
 * thousands of linked records -- a plausible dataset for a long-lived
 * CRM-style project -- the old version could stall the whole Node
 * process for seconds to minutes, blocking every other project's
 * requests too, not just this one backup request.
 */
/**
 * Mirrors entityFormatting.ts's own parseFileFieldValue -- a `file` field's
 * stored value is a JSON-encoded `{url, name, size, mimeType}` descriptor,
 * not a plain string like every other field type, so fieldDisplayValue
 * below needs just the filename out of it for the CSV cell (the actual
 * uploaded bytes, when a real uploadsDir is available, are instead added
 * to the ZIP as their own entries -- see addUploadedFileEntries below).
 */
function fileFieldDisplayName(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    const parsed = JSON.parse(value) as { name?: unknown };
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // not a file descriptor -- treated as no file, same as an empty value
  }
  return "";
}

function fieldDisplayValue(
  field: Field,
  value: unknown,
  allEntities: Entity[],
  recordIndexByEntity: Record<string, Map<number, EntityRecord>>,
  lang: Lang = "en",
): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") {
    // Round 1160: case-insensitive, mirroring migrate.ts's own round-1159
    // fix -- without it, a relationTo differing from its target entity's
    // name only by letter case fell back to "#<id>" in the backup instead
    // of the related record's real display label. recordIndexByEntity is
    // keyed by each entity's own real, canonical name (see its own build
    // site below), so the index lookup must use targetEntity.name, not the
    // possibly-differently-cased relationTo string itself.
    const relationTo = field.relationTo;
    const targetEntity = relationTo ? allEntities.find((e) => e.name.toLowerCase() === relationTo.toLowerCase()) : undefined;
    const index = targetEntity ? recordIndexByEntity[targetEntity.name] : undefined;
    if (!targetEntity || !index) return `#${value}`;
    const match = index.get(Number(value));
    return match ? recordDisplayLabel(targetEntity, match, lang) : `#${value}`;
  }
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
  if (field.type === "file") return fileFieldDisplayName(value);
  return String(value);
}

/**
 * A field's display label is never enforced unique (only its name is --
 * see entityFormatting.ts's/codegen.ts's own comment on this), so two
 * fields on the same entity can legally share a label via the Field Label
 * editor (e.g. a "subtotal" and a "shipping" field both labeled "Amount").
 * Without this, entityToCsv's header below would write that shared label
 * twice with nothing to tell the columns apart -- silently corrupting a
 * backup a real user could re-import via this same app's own per-entity
 * "Import CSV" feature, which matches columns by header text alone.
 * Mirrors (rather than imports, per this file's own top comment)
 * entityFormatting.ts's/codegen.ts's identical fieldLabelOccurrences/
 * fieldDisplayLabel pair, already used there for the same reason.
 */
function fieldLabelOccurrences(fields: Field[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const f of fields) {
    const label = f.label ?? f.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

function fieldDisplayLabel(field: Field, occurrences: Map<string, number>): string {
  const label = field.label ?? field.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${field.name})` : label;
}

/**
 * Round 1161: the entity-level sibling of fieldLabelOccurrences/
 * fieldDisplayLabel just above -- the Entity Label editor doesn't enforce
 * uniqueness either, so a project with both a "Customer" entity and a
 * "Lead" entity can legally give both the exact same display label, and a
 * matched WhatsApp message's own name alone can't tell which one it
 * actually belongs to. Round 1137 already fixed this identical gap for
 * apps/web/src/whatsappLog.ts's own "Download/Copy log" export
 * (entityLabelOccurrences/entityDisplayLabel there) -- whatsappMessagesToCsv
 * below never got the matching fix, so the one WhatsApp message record a
 * person actually keeps forever (the full backup, not just whatever page
 * happens to be loaded in the panel) silently dropped the one piece of
 * information that disambiguates it. Mirrors (rather than imports, per
 * this file's own top comment) whatsappLog.ts's identical pair.
 */
function entityLabelOccurrences(entities: Entity[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const e of entities) {
    const label = e.label ?? e.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
  const label = entity.label ?? entity.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
}

/** Falls back to the raw stored entityName when the entity has since been renamed or deleted -- same convention as whatsappLog.ts's/WhatsAppPanel.tsx's own matchedEntityLabel helpers for a reference that no longer resolves. */
function matchedEntityLabel(entityName: string, entities: Entity[]): string {
  const entity = entities.find((e) => e.name === entityName);
  return entity ? entityDisplayLabel(entity, entityLabelOccurrences(entities)) : entityName;
}

/**
 * Reorders entity.fields to match the user's own drag-reordered column
 * order for this entity's table -- the on-screen table, per-entity "Export
 * CSV", Copy, both Print sheets, the Columns menu, board cards, the add/
 * edit form, the bulk-edit/filter/group-by pickers, and the calendar .ics
 * export (rounds 615/621/670/678/684/686) all already follow it; this
 * server-side ZIP was the one export surface left behind, since the
 * server has no way to learn a client-only localStorage preference on its
 * own -- the client now sends it as a query param (see
 * parseColumnOrdersQueryParam below). Mirrors (rather than imports, per
 * this file's own top comment) apps/web/src/columnOrder.ts's own
 * applyColumnOrder verbatim: a field the order mentions keeps its
 * persisted relative position; any field the order doesn't mention (a
 * newly added field, or an order saved before this entity was ever
 * reordered) is appended at the end in the entity's own original order,
 * so every field still appears exactly once.
 *
 * Round 1287: an order entry is matched case-insensitively when no exact
 * name matches, mirroring apps/web/src/columnOrder.ts's own round-985 fix
 * for the identical hazard -- a live AI refine that merely recases an
 * existing field ("status" -> "Status") is a no-op at the SQLite layer,
 * but an exact-match lookup against the persisted order array couldn't
 * tell that apart from the field being removed outright, silently
 * reverting this entity's backup column order to its default declared
 * order the instant such a refine completed.
 */
function orderedFieldsFor(entity: Entity, columnOrders: Record<string, string[]>): Field[] {
  const order = columnOrders[entity.name];
  if (!order || order.length === 0) return entity.fields;
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  const byLowerName = new Map(entity.fields.map((f) => [f.name.toLowerCase(), f]));
  const ordered: Field[] = [];
  const used = new Set<Field>();
  for (const name of order) {
    const field = byName.get(name) ?? byLowerName.get(name.toLowerCase());
    if (field && !used.has(field)) {
      ordered.push(field);
      used.add(field);
    }
  }
  for (const field of entity.fields) {
    if (!used.has(field)) ordered.push(field);
  }
  return ordered;
}

/**
 * Defensive parsing of the client's own per-entity column order, sent as a
 * single JSON-encoded query param (?columnOrders=...) since this is a
 * plain GET download with no request body. Any malformed shape -- not
 * valid JSON, not a plain object, a value that isn't an array of strings
 * -- is dropped down to an empty map rather than thrown: the backup must
 * never fail just because a stale or malformed localStorage value made it
 * onto the wire, and orderedFieldsFor's own fallback to the entity's
 * declared order already handles an entity missing from the map, or an
 * empty order array, the same way it handles a never-reordered entity.
 */
export function parseColumnOrdersQueryParam(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const names = value.filter((v): v is string => typeof v === "string");
      if (names.length > 0) result[key] = names;
    }
    return result;
  } catch {
    return {};
  }
}

function entityToCsv(
  entity: Entity,
  records: EntityRecord[],
  allEntities: Entity[],
  recordIndexByEntity: Record<string, Map<number, EntityRecord>>,
  orderedFields: Field[],
  lang: Lang = "en",
): string {
  const labelOccurrences = fieldLabelOccurrences(orderedFields);
  const header = orderedFields.map((f) => csvEscape(fieldDisplayLabel(f, labelOccurrences))).join(",");
  const rows = records.map((record) =>
    orderedFields.map((f) => csvEscape(fieldDisplayValue(f, record[f.name], allEntities, recordIndexByEntity, lang))).join(","),
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
  let cursor: string | null = null;
  for (;;) {
    const { messages, hasMore, nextCursor } = listWhatsAppMessages(db, projectId, pageSize, cursor);
    all.push(...messages);
    if (!hasMore) break;
    cursor = nextCursor;
  }
  return all;
}

/**
 * Every entity's own CSV in this same ZIP already shows real Hebrew
 * column headers whenever the project's own fields are Hebrew (entityToCsv
 * above uses field.label, the project's own language). This hardcoded
 * entry sat in English regardless, the one file in the whole backup a
 * Hebrew-speaking shop owner couldn't read -- same isHebrewText(project.
 * description) signal this file's own caller (routes/projects.ts) already
 * uses for "בנייה ראשונית"/"(עותק)" elsewhere in this exact codebase.
 */
function whatsappMessagesToCsv(messages: WhatsAppMessage[], allEntities: Entity[], isHebrew: boolean): string {
  const header = (
    isHebrew
      ? ["כיוון", "מאת", "אל", "הודעה", "רשומה מותאמת", "סטטוס", "תאריך"]
      : ["Direction", "From", "To", "Message", "Matched Record", "Status", "Date"]
  )
    .map(csvEscape)
    .join(",");
  const incomingLabel = isHebrew ? "נכנסת" : "Incoming";
  const outgoingLabel = isHebrew ? "יוצאת" : "Outgoing";
  const rows = messages.map((m) => {
    // Round 1161: see entityLabelOccurrences/matchedEntityLabel's own doc
    // comment above -- disambiguates a matched name that's shared across
    // two entities, the same way the on-screen log and its own Download/
    // Copy export already do.
    const matched = m.matchedLabel ? (m.matchedEntityName ? `${m.matchedLabel} — ${matchedEntityLabel(m.matchedEntityName, allEntities)}` : m.matchedLabel) : "";
    return [m.direction === "in" ? incomingLabel : outgoingLabel, m.fromNumber, m.toNumber, m.body, matched, m.status, m.createdAt].map((v) => csvEscape(v)).join(",");
  });
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
/**
 * Nothing stops a real entity from being named exactly "WhatsApp Messages"
 * -- ProductSpecSchema has no reservation for it (unlike id/createdAt via
 * RESERVED_FIELD_NAMES), and an AI-generated spec for an app that itself
 * prominently features a WhatsApp integration can plausibly produce that
 * exact wording. Without this check, that entity's own CSV entry above and
 * this hardcoded log entry would collide at the identical path
 * "WhatsApp Messages.csv" -- buildZip (zip.ts) does no dedup of its own, so
 * both would land in the archive under one name, and every common unzip
 * tool resolves that by silently overwriting one with the other on
 * extraction, with no error or warning. Same deterministic
 * case-insensitive numeric-suffix resolution deriveEntityName/
 * deriveFieldName (routes/projects.ts) already use for every other naming
 * conflict in this codebase -- the entity keeps its real, user-facing
 * name untouched; this hardcoded entry is the one that yields.
 */
function uniqueWhatsAppLogPath(existingPaths: string[]): string {
  const existingLower = new Set(existingPaths.map((p) => p.toLowerCase()));
  const base = "WhatsApp Messages";
  if (!existingLower.has(`${base}.csv`.toLowerCase())) return `${base}.csv`;
  let suffix = 2;
  while (existingLower.has(`${base} ${suffix}.csv`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}.csv`;
}

/**
 * Round 964 investigated, and rejected, giving the entity-CSV entries
 * below the same existingPaths-based numeric-suffix dedup
 * uniqueWhatsAppLogPath already applies for the one hardcoded WhatsApp
 * entry -- reasoning that two entity names differing only by characters
 * sanitizeZipEntryName treats as equivalent (e.g. "A/B" and "A:B", both
 * -> "A_B.csv") could reach this function and silently collide. They
 * cannot: ProductSpecSchema's own findSanitizedIdentifierCollisions
 * refine (packages/shared/src/index.ts) already rejects any two entity
 * names that collapse to the same key under `name.replace(/[^A-Za-z0-9]/g,
 * "_").toLowerCase()` -- a STRICTLY BROADER transformation than
 * sanitizeZipEntryName's own narrower `[\\/:*?"<>|\u0000-\u001f]` set (every
 * character sanitizeZipEntryName touches is also non-alphanumeric, so
 * findSanitizedIdentifierCollisions's net is a strict superset: any pair
 * that collides under sanitizeZipEntryName necessarily also collides
 * under this broader, case-insensitive key, and is therefore already
 * rejected before such a spec can ever be stored). rowToProject
 * (packages/db/src/projects.ts) re-validates every project's spec
 * through this same ProductSpecSchema.parse on every single read, with
 * no path that hands this function a project whose spec skipped it --
 * so entity.name here can never actually produce two colliding paths.
 */
/**
 * Round 1203: the CSV cell for a `file` field only ever carried the
 * uploaded file's own NAME (fileFieldDisplayName above) -- never its
 * actual bytes, despite the feature being literally labeled "Backup all
 * data". A project with any `file` field (a resume, a receipt scan) that
 * a user backs up and then deletes -- the record, the whole project, or
 * their account, all of which really delete the underlying upload, per
 * the orphaned-upload-cleanup rounds -- permanently loses that file's
 * real content, despite having a "backup" in hand. Reads each `file`
 * field's currently-stored upload via resolveUploadedFilePath (the exact
 * same validated resolution deleteUploadedFile uses to find what to
 * delete, now shared rather than duplicated), and adds it as its own ZIP
 * entry alongside the CSVs -- best-effort: a value that doesn't resolve
 * to a real upload (already-deleted, malformed, or simply empty) is
 * silently skipped, exactly like deleteUploadedFile's own best-effort
 * contract, rather than failing the whole backup over one missing file.
 * `uploadsDir` is optional so every existing caller/test that doesn't
 * pass one keeps the old CSV-only behavior unchanged.
 */
function addUploadedFileEntries(
  entries: { path: string; content: string | Buffer }[],
  uploadsDir: string,
  projectId: string,
  entity: Entity,
  records: EntityRecord[],
): void {
  const fileFields = entity.fields.filter((f) => f.type === "file");
  if (fileFields.length === 0) return;
  const entityDir = sanitizeZipEntryName(entity.name);
  for (const record of records) {
    for (const field of fileFields) {
      const target = resolveUploadedFilePath(uploadsDir, projectId, entity.name, record[field.name]);
      if (!target) continue;
      let content: Buffer;
      try {
        content = readFileSync(target);
      } catch {
        continue;
      }
      const originalName = sanitizeZipEntryName(fileFieldDisplayName(String(record[field.name])) || target.slice(target.lastIndexOf("/") + 1));
      entries.push({ path: `${entityDir}/files/${record.id}-${sanitizeZipEntryName(field.name)}-${originalName}`, content });
    }
  }
}

export function generateBackupZipEntries(
  db: ForgeDatabase,
  project: Project,
  columnOrders: Record<string, string[]> = {},
  uploadsDir?: string,
): { path: string; content: string | Buffer }[] {
  const allEntities = project.spec.entities;
  const recordsByEntity: Record<string, EntityRecord[]> = {};
  const recordIndexByEntity: Record<string, Map<number, EntityRecord>> = {};
  for (const entity of allEntities) {
    const records = listRecords(db, project.id, entity);
    recordsByEntity[entity.name] = records;
    recordIndexByEntity[entity.name] = new Map(records.map((r) => [Number(r.id), r]));
  }

  const entries: { path: string; content: string | Buffer }[] = allEntities.map((entity) => ({
    path: `${sanitizeZipEntryName(entity.name)}.csv`,
    content:
      "﻿" +
      entityToCsv(
        entity,
        recordsByEntity[entity.name],
        allEntities,
        recordIndexByEntity,
        orderedFieldsFor(entity, columnOrders),
        isHebrewText(project.description) ? "he" : "en",
      ),
  }));

  const whatsappMessages = collectAllWhatsAppMessages(db, project.id);
  if (whatsappMessages.length > 0) {
    entries.push({
      path: uniqueWhatsAppLogPath(entries.map((e) => e.path)),
      content: "﻿" + whatsappMessagesToCsv(whatsappMessages, allEntities, isHebrewText(project.description)),
    });
  }

  if (uploadsDir) {
    for (const entity of allEntities) {
      addUploadedFileEntries(entries, uploadsDir, project.id, entity, recordsByEntity[entity.name]);
    }
  }

  return entries;
}
