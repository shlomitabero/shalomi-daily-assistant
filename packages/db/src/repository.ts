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
      const str = String(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(str);
      } catch {
        throw new ValidationError(`Field "${field.name}" must be a valid file descriptor`);
      }
      const url = (parsed as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || !/^\/api\/uploads\/[^/]+\/[^/]+\/[^/]+$/.test(url)) {
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
      return String(raw);
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
  const record: EntityRecord = { id: row.id as number, createdAt: row.createdAt as string };
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
  const values = entity.fields.map((field) => {
    if (!Object.prototype.hasOwnProperty.call(data, field.name)) return getRowValue(existingRow, field.name);
    const coerced = coerceValue(field, data[field.name]);
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
