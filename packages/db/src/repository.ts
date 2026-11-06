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

// Round 1210: mirrors apps/api/src/uploadPaths.ts's own UPLOADED_FILENAME
// regex exactly -- the one filename shape createUploadMiddleware's own
// filename callback (routes/projects.ts) ever actually generates.
// Duplicated here rather than imported: this package has no dependency
// on apps/api (and shouldn't gain one just for this one constant), the
// same cross-package duplication this codebase already documents
// elsewhere (codegen.ts's own duplicated copies of live-app logic).
const UPLOADED_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;

/**
 * Round 1479: unlike every spec-config free-text field this codebase has
 * already capped (project name/description, automation rule fields,
 * entity/field labels, AI-generation input -- rounds 1403/1404/1408/1409/
 * 1410/1411/1414/1423/1426), an actual record's own text/longtext field
 * VALUE -- the single highest-volume input in the whole app, and the one
 * reachable through three independent paths (a direct create/update call,
 * CSV import, and the public per-project inbound-webhook token, none of
 * which impose any cap of their own) -- had no ceiling anywhere. Express's
 * default ~100KB JSON body limit was the only bound. A stored oversized
 * value is later substituted verbatim into a real outbound WhatsApp
 * message or email body (automations.ts's interpolateTemplate), an entire
 * webhook-action JSON.stringify(record) payload, and the calendar ICS
 * feed/Business Twin report/CSV export -- turning one oversized field into
 * real outbound spam risk every time a record_created/record_updated rule
 * fires, the exact abuse vector round 862's own WhatsApp-ban doc comment
 * already names. `longtext` is explicitly meant for real multi-paragraph
 * notes, so it gets a much larger ceiling than the single-field `text`
 * type.
 */
const TEXT_FIELD_VALUE_MAX_LENGTH = 5000;
const LONGTEXT_FIELD_VALUE_MAX_LENGTH = 20000;

function coerceValue(field: Field, raw: unknown, projectId: string, entityName: string): string | number | null {
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
      // Same quirk, boolean-shaped: Number(true) is 1 and Number(false) is
      // 0, both finite, so a boolean raw value silently became a real
      // stored number/foreign-key id instead of being rejected -- and for
      // a required field, `raw === false` also bypassed the required-check
      // above, since isEmpty doesn't recognize `false` as "no real value".
      if (Array.isArray(raw) || typeof raw === "boolean") {
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
      // Round 1320: same coincidental-coercion gap number/relation (round
      // 604) already closed above, one input shape later. JS's
      // Array.prototype.toString collapses a *single-element* array to its
      // bare element with no comma -- String(["active"]) is "active", not
      // "[object Object]" or "active,other" -- so a single-element-array
      // raw value for an enum field silently stringified to a real, valid
      // member and passed this check, instead of getting the same
      // ValidationError every other wrong-shaped input for this field
      // already gets.
      if (Array.isArray(raw)) {
        throw new ValidationError(
          `Field "${field.name}" must be one of: ${field.enumValues?.join(", ") ?? ""}`,
        );
      }
      if (field.enumValues && !field.enumValues.includes(String(raw))) {
        throw new ValidationError(
          `Field "${field.name}" must be one of: ${field.enumValues.join(", ")}`,
        );
      }
      return String(raw);
    case "date": {
      // Round 1320: same single-element-array coincidental-match gap as
      // the enum case just above -- String(["2024-01-15"]) is
      // "2024-01-15", a real valid date string.
      if (Array.isArray(raw)) {
        throw new ValidationError(`Field "${field.name}" must be a valid date in YYYY-MM-DD format`);
      }
      const str = String(raw);
      if (!isValidDateString(str)) {
        throw new ValidationError(`Field "${field.name}" must be a valid date in YYYY-MM-DD format`);
      }
      return str;
    }
    case "file": {
      // Round 908: a file field's stored value is an otherwise-
      // unvalidated, client-settable JSON descriptor -- nothing ties it
      // to an actual upload, since a normal record create/update call can
      // set this field directly, bypassing the real
      // /fields/:fieldName/upload endpoint entirely. EntityPanel.tsx (and
      // codegen.ts's own duplicated twin) render this descriptor's `url`
      // as a real, clickable `<a href>`/`<img src>` with no scheme check
      // anywhere -- a crafted "javascript:..."/"data:..." url stored by
      // one collaborator would run in whichever OTHER collaborator's
      // browser later clicks the resulting file link, a stored-XSS/
      // session-theft primitive reachable by any editor collaborator
      // against any other collaborator or the owner. The only `url` shape
      // this server itself ever generates is createUploadMiddleware's own
      // /api/uploads/<projectId>/<entityName>/<filename>
      // (routes/projects.ts's upload route response) -- reject anything
      // else here, the one place every real record write (create or
      // update, not just the upload route) already funnels through.
      //
      // Round 1210: the shape-only regex this round 908 fix originally had
      // (three non-slash segments) blocked the XSS primitive above, but it
      // still accepted ANY other project's own real upload URL verbatim --
      // every DOWNSTREAM reader of this same descriptor (resolveUploadedFilePath/
      // deleteUploadedFile in uploadPaths.ts, findTemplateFileAttachment in
      // automations.ts) already discards the URL's own embedded path
      // segments and rebuilds the path from trusted context instead of
      // trusting them (their own doc comments: entity.name has no
      // character-set restriction, so the embedded segments were never
      // safe to trust) -- but /api/uploads is served by a plain,
      // unauthenticated express.static with no project-ownership check of
      // its own, and EntityPanel.tsx's rendered <a href>/<img src> uses
      // this descriptor's url completely verbatim, with no equivalent
      // rebuild-from-trusted-context step. A crafted descriptor pointing
      // at some OTHER project's real, already-uploaded file -- set via a
      // normal record write, exactly like the XSS case above -- would be
      // stored, then silently served to every collaborator of THIS
      // project (even one with zero access to the other project) who
      // opens the record and clicks the link. Requiring an exact match
      // against this record's own projectId/entityName, and the real
      // UUID filename shape (not just "no slashes"), closes that gap at
      // the same single write-time chokepoint the XSS fix already used.
      //
      // Round 1320: same single-element-array coincidental-match gap as
      // the enum/date cases above -- String(['{"url":"..."}']) is
      // '{"url":"..."}', a real, validly-shaped descriptor string.
      if (Array.isArray(raw)) {
        throw new ValidationError(`Field "${field.name}" must be a valid file descriptor`);
      }
      const str = String(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(str);
      } catch {
        throw new ValidationError(`Field "${field.name}" must be a valid file descriptor`);
      }
      const url = (parsed as { url?: unknown } | null)?.url;
      // Round 1530: entityName here is the entity's CURRENT, canonical
      // name -- a case-only entity rename (a real, supported refine
      // operation) leaves every already-uploaded file's own stored url
      // embedding the entity's casing AT UPLOAD TIME (createUploadMiddleware
      // never rewrites it). An unconditional exact-case match below would
      // reject re-submitting that record's own already-valid, unmodified
      // file descriptor the moment its entity is renamed only by letter
      // case -- the same case-only-rename hazard round 1270 already fixed
      // for this descriptor's own read-side siblings (resolveUploadedFilePath/
      // deleteUploadedFile in uploadPaths.ts), but never on this write-side
      // gate. Falling back to a case-insensitive match of just the
      // entity-name segment, after the exact projectId prefix still
      // matched exactly, is as safe as the exact match: round 1210's own
      // anti-cross-project-injection guarantee lives entirely in the
      // projectId segment (unchanged here), and ProductSpecSchema's
      // findCaseInsensitiveDuplicateEntityNames refine guarantees at most
      // one entity name can ever match a given string this way, so the
      // fallback is never ambiguous -- the same precedent findEntity's own
      // round-1162 fallback already relies on.
      const projectPrefix = `/api/uploads/${projectId}/`;
      const entitySegment = `${entityName}/`;
      const rest = typeof url === "string" && url.startsWith(projectPrefix) ? url.slice(projectPrefix.length) : null;
      const entityMatches = rest !== null && (rest.startsWith(entitySegment) || rest.slice(0, entitySegment.length).toLowerCase() === entitySegment.toLowerCase());
      if (rest === null || !entityMatches || !UPLOADED_FILENAME.test(rest.slice(entitySegment.length))) {
        throw new ValidationError(`Field "${field.name}" must be a valid file descriptor`);
      }
      return str;
    }
    default: {
      // text / longtext (file has its own case above, round 908): unlike
      // every branch above, this used to have no rejection path at all --
      // String(raw) on an object or array (e.g. a stray `{ foo: "bar" }`
      // or `[1, 2, 3]` body, not valid JSON for either of these fields)
      // silently stringifies it to "[object Object]" or "1,2,3" and
      // writes that garbage with the request still reporting success,
      // instead of throwing the same ValidationError every not-really-a-
      // string input already gets for number/boolean/enum/date.
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        throw new ValidationError(`Field "${field.name}" must be a string`);
      }
      const str = String(raw);
      const maxLength = field.type === "longtext" ? LONGTEXT_FIELD_VALUE_MAX_LENGTH : TEXT_FIELD_VALUE_MAX_LENGTH;
      if (str.length > maxLength) {
        throw new ValidationError(`Field "${field.name}" must be ${maxLength} characters or fewer`);
      }
      return str;
    }
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
  const record: EntityRecord = {
    id: row.id as number,
    createdAt: row.createdAt as string,
    createdByUserId: (row.createdByUserId as string | null) ?? null,
    updatedByUserId: (row.updatedByUserId as string | null) ?? null,
  };
  for (const field of entity.fields) {
    const value = getRowValue(row, field.name);
    // Round 1134: every other field type below passes a real stored NULL
    // straight through -- boolean was the one type that ran every value
    // through Boolean(value) unconditionally, so Boolean(null) silently
    // became `false`, indistinguishable from an explicitly unchecked box.
    // NULL is a routine, reachable state here, not a hypothetical: a
    // refine that adds a boolean field to an entity with existing rows
    // (migrate.ts's own "NOT NULL deliberately omitted" column-add) leaves
    // every pre-existing record with a real NULL until someone edits it.
    // Every downstream consumer that renders a boolean as text already
    // has its own `value === null` guard written and ready
    // (entityFormatting.ts/backup.ts's fieldDisplayValue, twin.ts's
    // computeEnumDistributionObservations, automations.ts's
    // interpolateTemplate) -- that guard was simply unreachable for
    // booleans specifically, since a real null never survived this far.
    // Treats getRowValue's own "column not found at all" `undefined`
    // (its doc comment above) the same as a stored NULL -- both mean "no
    // real value," and codegen.test.ts's round-117 test already exercised
    // this exact missing-column shape for a boolean.
    record[field.name] =
      field.type === "boolean" ? (value === null || value === undefined ? null : Boolean(value)) : (value as string | number | null);
  }
  return record;
}

function fieldColumns(entity: Entity): string[] {
  return entity.fields.map((f) => assertSafeIdentifier(f.name, "column"));
}

/**
 * Round 1613: generateCreateTableStatements (migrate.ts) now declares
 * createdByUserId on every FRESH entity table, but that CREATE TABLE
 * statement only ever runs as `IF NOT EXISTS` -- a no-op for a table a
 * project already built before this round shipped. Checked lazily here
 * (not once at startup, since there's no single fixed table to check the
 * way checkpoints.ts's ensureCheckpointsTable does -- a table exists per
 * project per entity) so every pre-existing entity table self-heals the
 * moment its own project next creates a record, with no migration step
 * for an already-"built" project to ever miss.
 */
function ensureCreatedByUserIdColumn(db: ForgeDatabase, table: string): void {
  const hasColumn = (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]).some(
    (c) => c.name === "createdByUserId",
  );
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN createdByUserId TEXT`);
  }
}

/**
 * Round 1617: the direct sibling of ensureCreatedByUserIdColumn above, for
 * updateRecord's own new updatedByUserId column -- identical self-healing
 * rationale (generateCreateTableStatements's CREATE TABLE IF NOT EXISTS is
 * a no-op for a table a project already built before this round shipped).
 */
function ensureUpdatedByUserIdColumn(db: ForgeDatabase, table: string): void {
  const hasColumn = (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]).some(
    (c) => c.name === "updatedByUserId",
  );
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN updatedByUserId TEXT`);
  }
}

export function insertRecord(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  data: Record<string, unknown>,
  createdByUserId?: string | null,
): EntityRecord {
  const table = tableNameFor(projectId, entity.name);
  ensureCreatedByUserIdColumn(db, table);
  const columns = fieldColumns(entity);
  const values = entity.fields.map((field) => coerceValue(field, data[field.name], projectId, entity.name));
  const createdAt = new Date().toISOString();

  const placeholders = ["?", "?", ...columns.map(() => "?")].join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (createdAt, createdByUserId, ${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
  );
  const result = stmt.run(createdAt, createdByUserId ?? null, ...values);
  const id = Number(result.lastInsertRowid);
  // Round 1231: mirrors updateRecord's own round-1037/1176 self-reference
  // guard, which this function never got. The new row's id is only known
  // after the insert above, so unlike updateRecord (where the id is the
  // caller's own URL param, known before any field is coerced), a
  // self-referencing relation field can only be caught here, after the
  // fact -- a freshly-built entity table's very first record gets a
  // predictable id (AUTOINCREMENT starts at 1), making e.g. {"managerId":
  // 1} on the first Employee record a real, reachable self-reference via
  // a direct POST, with no error anywhere (the SQL FOREIGN KEY constraint
  // itself allows a row to reference its own id). Deletes the row it just
  // inserted and throws the identical message updateRecord already uses,
  // rather than leaving a self-referencing row committed.
  const selfRefField = entity.fields.find(
    (field, i) => field.type === "relation" && field.relationTo?.toLowerCase() === entity.name.toLowerCase() && values[i] === id,
  );
  if (selfRefField) {
    db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE id = ?`).run(id);
    throw new ValidationError(`Field "${selfRefField.name}" can't reference the record's own id`);
  }
  return getRecord(db, projectId, entity, id)!;
}

export function listRecords(db: ForgeDatabase, projectId: string, entity: Entity, limit?: number): EntityRecord[] {
  const table = tableNameFor(projectId, entity.name);
  // limit is optional and only ever passed by the one caller (the live
  // GET .../entities/:entityName route) that needs to cap an interactive
  // response -- every other caller (backup, twin insights, seed, webhook
  // lookups, automations) keeps today's unbounded behavior untouched.
  const sql = `SELECT * FROM ${quoteIdentifier(table)} ORDER BY id DESC${limit !== undefined ? " LIMIT ?" : ""}`;
  const rows = (limit !== undefined ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as Record<string, unknown>[];
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
  updatedByUserId?: string | null,
): EntityRecord {
  const table = tableNameFor(projectId, entity.name);
  ensureUpdatedByUserIdColumn(db, table);
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
  const values = entity.fields.map((field) => {
    if (!Object.prototype.hasOwnProperty.call(data, field.name)) return getRowValue(existingRow, field.name);
    const coerced = coerceValue(field, data[field.name], projectId, entity.name);
    // Round 1037: a self-referencing relation field (field.relationTo ===
    // this entity's own name -- e.g. Employee.managerId -> Employee) has
    // no guard anywhere else in the write path: the SQL FOREIGN KEY
    // constraint itself allows a row to reference its own id (confirmed
    // directly -- a self-referencing row even DELETEs cleanly), and
    // coerceValue above only checks that the raw value is a finite
    // number. Only rejected when the CALLER is actually setting this
    // field to the record's own id right now -- an update to some other,
    // unrelated field must still succeed even if legacy data already has
    // a pre-existing self-reference, the same "don't retroactively break
    // an unrelated write" principle every other per-field validation in
    // this function already follows (see this function's own comment on
    // only re-coercing fields the caller actually supplied).
    //
    // Round 1176: case-insensitive, same as every sibling relationTo
    // comparison rounds 1159-1162 already fixed elsewhere (migrate.ts,
    // codegen.ts, automations.ts, backup.ts, calendarFeed.ts,
    // routes/calendar.ts, twin.ts, EntityPanel's relationTargets) -- those
    // rounds never reached this file. A relationTo string legitimately
    // differing in case from its target entity's declared name (a real,
    // demonstrated byproduct of AI-generated/refined specs) meant a
    // SELF-relation whose own relationTo happened to differ in case from
    // its own entity's name silently never hit this guard at all --
    // storing the exact "record references its own id" state this guard
    // exists specifically to reject, with no error anywhere.
    if (field.type === "relation" && field.relationTo?.toLowerCase() === entity.name.toLowerCase() && coerced === id) {
      throw new ValidationError(`Field "${field.name}" can't reference the record's own id`);
    }
    return coerced;
  });

  // Written unconditionally on every update, even one whose `data` touches
  // zero of entity.fields (e.g. a future metadata-only PATCH) -- the
  // person who performed the update changed the record regardless of
  // which fields they actually set, mirroring insertRecord's own
  // unconditional createdByUserId write.
  const setClause = [...columns.map((c) => `${quoteIdentifier(c)} = ?`), `${quoteIdentifier("updatedByUserId")} = ?`].join(", ");
  db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE id = ?`).run(...values, updatedByUserId ?? null, id);
  return getRecord(db, projectId, entity, id)!;
}

export function deleteRecord(db: ForgeDatabase, projectId: string, entity: Entity, id: number): void {
  const table = tableNameFor(projectId, entity.name);
  const result = db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE id = ?`).run(id);
  if (result.changes === 0) {
    throw new NotFoundError(`Record ${id} not found in ${entity.name}`);
  }
}
