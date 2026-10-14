import type { Entity, Field, ProductSpec } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { disableAutomationRulesForEntity, disableAutomationRulesForField, ensureAutomationRulesTable } from "./automations.js";
import { listHistoricalEntityNames, recordEntityNameInHistory } from "./checkpoints.js";
import { assertSafeIdentifier, quoteIdentifier, tableNameFor } from "./identifiers.js";
import { ValidationError } from "./repository.js";

/**
 * Names this project's entities have ever been known by, for the
 * cross-refine sanitized-table-name collision check below. previousSpec's
 * own entity names always count (no table needed), plus -- when the Time
 * Machine checkpoint infrastructure has been set up (ensureCheckpointsTable;
 * always true for the real app via store.ts, not necessarily true for a
 * caller exercising diffAndMigrate in isolation) -- checkpoint_entity_history
 * itself, a durable, append-only ledger of every entity name ever written
 * to a checkpoint, written at insertCheckpoint and never pruned, which
 * already exists specifically to answer "did this project ever have an
 * entity named X" (currently used by deleteProject for exactly that
 * question). Without it, the collision check below only ever sees one
 * refine hop back: a sanitized-name collision with an entity removed TWO OR
 * MORE refines ago -- already absent from previousSpec too by then -- would
 * silently pass.
 */
function allKnownEntityNames(db: ForgeDatabase, projectId: string, previousSpec: ProductSpec): Set<string> {
  const names = new Set(previousSpec.entities.map((e) => e.name));
  if (hasCheckpointHistoryTable(db)) {
    for (const name of listHistoricalEntityNames(db, projectId)) names.add(name);
  }
  return names;
}

/**
 * Same tolerance allKnownEntityNames above already needs: the checkpoint
 * infrastructure is always set up for the real app (store.ts), but
 * diffAndMigrate is also exercised directly (migrate.test.ts) against a bare
 * openDatabase(":memory:") that never called ensureCheckpointsTable --
 * recordEntityNameInHistory's own INSERT would throw "no such table" there,
 * so every call site below checks this first rather than assuming the table
 * exists.
 */
function hasCheckpointHistoryTable(db: ForgeDatabase): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoint_entity_history'").get();
}

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

/**
 * A field removed from an entity and later re-added under the same name --
 * e.g. a relation field dropped, then a differently-typed field also named
 * "assignee" added back on a later refine -- has no prevField in
 * prevFieldsByName below: that map only ever comes from the IMMEDIATELY
 * preceding spec, and the field wasn't there. So it falls past both the
 * type_changed and relation_target_changed checks above it (both require
 * prevField to be truthy) straight into the "new_column" branch -- but the
 * physical column was never dropped (this migration engine is additive-only
 * by design), so `currentColumns.has(columnName)` is true and the ALTER is
 * skipped, silently reusing a stale column whose real SQL type/REFERENCES
 * clause can mismatch what nextSpec now claims. Reading that straight from
 * SQLite's own catalog -- the one source of truth that survived the field's
 * absence from the spec -- lets the field loop below report the same kind
 * of change (type_changed/relation_target_changed) it already would have if
 * the field had never left the spec at all.
 */
function physicalColumnShape(db: ForgeDatabase, table: string): Map<string, { sqlType: string; fkTable?: string }> {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string; type: string }[];
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as { from: string; table: string }[];
  const shapeByColumn = new Map<string, { sqlType: string; fkTable?: string }>();
  for (const column of columns) {
    const fk = foreignKeys.find((f) => f.from === column.name);
    shapeByColumn.set(column.name, { sqlType: column.type, fkTable: fk?.table });
  }
  return shapeByColumn;
}

/**
 * Best-effort reverse lookup from a physical table name back to the entity
 * name a user-facing message should show, for a stale relation column whose
 * actual REFERENCES target has to be read from physicalColumnShape above
 * (there's no Field left anywhere to read a relationTo string from). Checks
 * both specs' own entity names since the referenced entity could have been
 * renamed or removed from either one; falls back to the raw table name
 * (still accurate, just less readable) rather than "undefined" when neither
 * spec's entities account for it.
 */
function entityNameForTable(projectId: string, candidateEntityNames: Iterable<string>, table: string): string {
  for (const name of candidateEntityNames) {
    if (tableNameFor(projectId, name) === table) return name;
  }
  return table;
}

/** Reverses sqlTypeFor's own mapping for a column with no surviving Field to read field.type from -- only ever used for a user-facing message string, not for any decision logic. */
function fieldTypeLabelForSqlType(sqlType: string, hasForeignKey: boolean): string {
  switch (sqlType) {
    case "REAL":
      return "number";
    case "INTEGER":
      return hasForeignKey ? "relation" : "boolean";
    default:
      return "text";
  }
}

export interface MigrationChange {
  type: "new_table" | "new_column" | "type_changed" | "relation_target_changed" | "relation_missing_fk";
  table: string;
  column?: string;
  /** Only set for "type_changed": the field's old and new declared type, for a message that says what actually changed. */
  fromType?: string;
  toType?: string;
  /** Only set for "relation_target_changed": the field's old and new relationTo entity name. Only set for "relation_missing_fk": the relationTo the field claims, with no "from" since the reused column never had any FK to begin with. */
  fromRelationTo?: string;
  toRelationTo?: string;
}

/**
 * Builds the "kept the original column type/relation target" notice for any
 * type_changed/relation_target_changed/relation_missing_fk entries in a
 * diffAndMigrate() result -- the one signal that catches a reused column
 * whose physical SQL type or FK target no longer matches what the spec now
 * claims. Returns "" when there's nothing to warn about. Shared by
 * pipeline.ts (surfaced live during /build and /refine) and the
 * checkpoint-restore route (surfaced in its response), so this diagnostic
 * is computed once and never silently dropped at either call site.
 */
export function describeMigrationHazards(changes: MigrationChange[]): string {
  const typeChanges = changes.filter((c) => c.type === "type_changed");
  const relationTargetChanges = changes.filter((c) => c.type === "relation_target_changed");
  const relationMissingFkChanges = changes.filter((c) => c.type === "relation_missing_fk");
  return (
    (typeChanges.length > 0
      ? ` Note: ${typeChanges.map((c) => `${c.table}.${c.column} (${c.fromType} → ${c.toType})`).join(", ")} kept the original database column type — existing data was not converted.`
      : "") +
    (relationTargetChanges.length > 0
      ? ` Note: ${relationTargetChanges.map((c) => `${c.table}.${c.column} (${c.fromRelationTo} → ${c.toRelationTo})`).join(", ")} kept pointing at the original related table — existing data was not re-linked.`
      : "") +
    (relationMissingFkChanges.length > 0
      ? ` Note: ${relationMissingFkChanges.map((c) => `${c.table}.${c.column} (→ ${c.toRelationTo})`).join(", ")} is a relation field reusing a column that was never linked to anything — existing and new values in it are not protected against pointing at a record that doesn't exist.`
      : "")
  );
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
  const entityNames = new Set(nextSpec.entities.map((e) => e.name));
  const changes: MigrationChange[] = [];
  // A field kept by name can still invalidate an automation rule that
  // references it without being removed outright: retyped away from
  // text/longtext breaks any rule using it as a toMode:"field" WhatsApp
  // destination (routes/projects.ts's validateAutomationToField only runs
  // at rule create/update time, never again), and an enum field losing one
  // of its enumValues breaks any field_equals rule whose stored fieldValue
  // was exactly that now-removed option (validateAutomationFieldValue has
  // the same create/update-time-only limitation). Both are tracked here so
  // the automation-rule safety sweep below can disable them the same way
  // it already does for a field removed outright.
  const fieldsNeedingAutomationDisable = new Map<string, Set<string>>();

  nextSpec.entities.forEach((entity, index) => {
    const table = tableNameFor(projectId, entity.name);
    const prevEntity = previousEntities.get(entity.name);
    const currentColumns = existingColumns(db, table);

    // tableNameFor sanitizes an entity name by replacing every non-ASCII-
    // alphanumeric character with "_", so two differently-named entities
    // can collapse to the identical physical table name (most plausibly
    // two non-ASCII names of the same length, e.g. Hebrew). ProductSpecSchema
    // already rejects that WITHIN one spec (findSanitizedIdentifierCollisions),
    // but it only ever sees one spec at a time -- it has no way to know
    // that today's entity name collides with a DIFFERENT entity that
    // existed at some point in this project's past and has since been
    // removed. Checking previousSpec.entities alone (this round's original
    // fix) only catches a collision with an entity removed on the IMMEDIATELY
    // preceding refine; one removed two or more refines ago is already gone
    // from previousSpec too, so allKnownEntityNames also consults the
    // durable checkpoint_entity_history ledger, which remembers every entity
    // name this project's spec has EVER contained. Without this check, the
    // "entity absent from previousSpec" branch below would treat that stale,
    // unrelated table as a benign same-entity reuse: the removed entity's
    // real rows would keep sitting in the table and silently surface as
    // records of today's new, differently-named entity, with any
    // coincidentally-matching field reused rather than reported.
    // previousEntities is guaranteed collision-free internally by that same
    // upstream schema check, so at most one other known name can match.
    // The comparison itself must be case-insensitive: SQLite compares ASCII
    // identifiers case-insensitively even when double-quoted (the same fact
    // ProductSpecSchema's own findCaseInsensitiveDuplicateEntityNames refine
    // exists to guard against within one spec -- confirmed directly against
    // this project's SQLite binding), so an entity named "order" colliding
    // with a since-removed "Order" from this project's own history is just
    // as real a collision as a sanitized-character collision, and a plain
    // `===` here would silently miss it.
    const tableLower = table.toLowerCase();
    if (!prevEntity) {
      const collidingName = Array.from(allKnownEntityNames(db, projectId, previousSpec)).find(
        (name) => name !== entity.name && tableNameFor(projectId, name).toLowerCase() === tableLower,
      );
      if (collidingName) {
        throw new ValidationError(
          `Entity "${entity.name}" sanitizes to the same database table as entity "${collidingName}", which existed earlier in this project's history -- refusing to silently merge their data. Choose a name that differs in its ASCII letters/digits, not just punctuation or non-ASCII characters.`,
        );
      }
    }

    if (!prevEntity && currentColumns.size === 0) {
      db.exec(statements[index]);
      changes.push({ type: "new_table", table });
      if (hasCheckpointHistoryTable(db)) recordEntityNameInHistory(db, projectId, entity.name);
      return;
    }

    // An entity absent from previousSpec (no prevEntity) but whose table
    // already physically exists is a name reused after the entity was
    // removed on an earlier refine and re-added here under the same name --
    // previousSpec is only ever the IMMEDIATELY preceding spec, so an
    // entity's own in-between removal is invisible from this call, but the
    // physical table survives it (additive-only migrations never drop a
    // table, same as physicalColumnShape's own gap for a single reused
    // column below). Without this check, CREATE TABLE IF NOT EXISTS above
    // would be a silent no-op and `return` would skip the field loop
    // entirely, forever leaving out any field the re-added entity now
    // claims that the stale table doesn't already have -- surfacing as a
    // raw "no such column" SQLite error on the first insert/update, not a
    // reported migration change. Falling through to the same per-field diff
    // as an ordinary existing entity, with an empty prevFieldsByName when
    // there's no prevEntity to source it from, makes every field take the
    // "reused, compare against physical reality" path physicalShapeByColumn
    // already provides for a single reused column -- so a benign reuse
    // (identical shape to before removal) stays silent, and a real
    // mismatch is reported and its column actually added, just like it
    // would be if the field itself (not the whole entity) had been the
    // thing reused.
    const prevFieldsByName = new Map((prevEntity?.fields ?? []).map((f) => [f.name, f]));
    // A refine that merely changes a surviving field's letter-case (e.g.
    // "email" -> "Email") is invisible to the exact-string lookup above --
    // EntitySchema's own findCaseInsensitiveDuplicateFieldNames (shared/src/
    // index.ts) only rejects a case-collision WITHIN one spec, so nextSpec's
    // single "Email" field passes validation cleanly, and prevFieldsByName
    // (keyed by previousSpec's exact "email") simply has no entry for
    // "Email". Without this, the field below falls through to the "reused
    // column" branch, whose own exact-string currentColumns.has() check also
    // misses the already-existing physical column -- the generated ALTER
    // TABLE ... ADD COLUMN then throws SQLite's own "duplicate column name"
    // error (SQLite compares identifiers case-insensitively, the same fact
    // the entity-level collision guard above already relies on), an
    // unhandled raw Error at both call sites that reach here (pipeline.ts's
    // try/catch burns a Debug Agent retry that can never actually fix it;
    // the checkpoint-restore route has no try/catch at all, surfacing a raw
    // 500). Resolving via a second, lowercased map finds the same prevField
    // a case-only rename really is, so it takes the normal type_changed/
    // enum/relation comparison path below (comparing TYPES, which is
    // unaffected by the name's case) and never reaches the ALTER at all --
    // correct, since SQLite already resolves either case to the one
    // physical column.
    const prevFieldByLowerName = new Map((prevEntity?.fields ?? []).map((f) => [f.name.toLowerCase(), f]));
    const physicalShapeByColumn = physicalColumnShape(db, table);
    for (const field of entity.fields) {
      const prevField = prevFieldsByName.get(field.name) ?? prevFieldByLowerName.get(field.name.toLowerCase());
      if (prevField) {
        if (prevField.type !== field.type) {
          changes.push({
            type: "type_changed",
            table,
            column: assertSafeIdentifier(field.name, "column"),
            fromType: prevField.type,
            toType: field.type,
          });
          if (field.type !== "text" && field.type !== "longtext") {
            if (!fieldsNeedingAutomationDisable.has(entity.name)) {
              fieldsNeedingAutomationDisable.set(entity.name, new Set());
            }
            fieldsNeedingAutomationDisable.get(entity.name)!.add(field.name);
          }
        } else if (field.type === "enum" && prevField.type === "enum") {
          // Same mechanism as the type_changed branch above, but the type
          // itself didn't change -- only the set of allowed values did.
          // Mirrors computeImpact's own "tightened" check (pipeline.ts) for
          // the identical narrowing condition, used there to warn the user
          // about existing records rather than to disable automations.
          const nextValues = new Set(field.enumValues ?? []);
          const lostValue = (prevField.enumValues ?? []).some((v) => !nextValues.has(v));
          if (lostValue) {
            if (!fieldsNeedingAutomationDisable.has(entity.name)) {
              fieldsNeedingAutomationDisable.set(entity.name, new Set());
            }
            fieldsNeedingAutomationDisable.get(entity.name)!.add(field.name);
          }
        } else if (field.type === "relation" && prevField.type === "relation") {
          // Same gap as "type_changed" above, but for a relation field's
          // *target* rather than its own type: the column's REFERENCES
          // clause (generateCreateTableStatements, the "new_column" branch
          // below) is bound to whatever relationTo was when the column was
          // created, and SQLite can't retroactively repoint a FK any more
          // than it can retype a column. Without this, a refine that keeps
          // a relation field's name and type but repoints relationTo to a
          // different, still-existing entity (e.g. "treat couriers as
          // drivers now") leaves the live spec claiming a target the
          // database's FK still doesn't actually watch -- real records of
          // the new target get wrongly rejected as INVALID_RELATION_TARGET,
          // or (if an id happens to coincide with the stale target table)
          // silently accepted with no FK protection at all, breaking the
          // dangling-id invariant twin.ts's own insight logic relies on.
          //
          // Deliberately compares the column's REAL physical FK target
          // (physicalShapeByColumn, the same source the "reused column"
          // branch below already uses) rather than prevField.relationTo --
          // a relationTo that oscillates across >=2 refines (A -> B -> A)
          // used to compare only against the IMMEDIATELY preceding spec, so
          // the third refine (back to A) saw prevField.relationTo ("B") !==
          // field.relationTo ("A") and reported a spurious
          // relation_target_changed "B -> A", even though the FK had
          // physically pointed at A continuously the entire time (the
          // middle refine's own ALTER never ran, by the same additive-only
          // design this comment already describes) -- a false "still
          // watching the wrong table" warning for a column that was never
          // actually wrong. Comparing physical reality instead reports a
          // change exactly when one still genuinely exists, regardless of
          // how many hops the relationTo string took to get there. Unlike
          // "type_changed" above, this has no ambiguous-bucket problem to
          // worry about (every relationTo maps to one distinct physical
          // table, never collapsed the way text/longtext/enum/date share a
          // single SQL column type), so it's safe to always prefer physical
          // reality here.
          const columnName = assertSafeIdentifier(field.name, "column");
          const shape = physicalShapeByColumn.get(columnName);
          const expectedFkTable =
            field.relationTo && entityNames.has(field.relationTo) ? tableNameFor(projectId, field.relationTo) : undefined;
          if (shape?.fkTable && expectedFkTable && shape.fkTable !== expectedFkTable) {
            changes.push({
              type: "relation_target_changed",
              table,
              column: columnName,
              fromRelationTo: entityNameForTable(projectId, [...previousEntities.keys(), ...entityNames], shape.fkTable),
              toRelationTo: field.relationTo,
            });
          } else if (shape && !shape.fkTable && expectedFkTable) {
            // Mirrors the identical relation_missing_fk case in the "reused
            // column" branch below -- a relation field whose relationTo
            // stayed textually the same across this hop can still have lost
            // its FK somewhere in an earlier oscillation (e.g. relation ->
            // boolean -> relation, sharing the INTEGER bucket so
            // type_changed never fires, with no FK ever re-added since
            // ALTER can't add one to an existing column).
            changes.push({
              type: "relation_missing_fk",
              table,
              column: columnName,
              toRelationTo: field.relationTo,
            });
          }
        }
        continue;
      }
      const columnName = assertSafeIdentifier(field.name, "column");
      // A column that already exists here despite having no prevField is a
      // name reused after an earlier removal (see physicalColumnShape's own
      // doc-comment) -- compare what's physically there against what field
      // now claims, the same way the prevField branch above compares two
      // Field definitions, and report the same two change shapes when they
      // genuinely disagree. A benign reuse (same name, same type) stays
      // silent, exactly like it would if the field had simply never left.
      //
      // The reused column can physically exist under different letter-case
      // than field.name declares -- e.g. "email" removed on one refine, then
      // re-added two+ refines later as "Email". currentColumns/
      // physicalShapeByColumn are keyed by the column's REAL stored name
      // (PRAGMA table_info), so an exact-case lookup misses it even though
      // SQLite resolves both names to the identical column (the same fact
      // prevFieldByLowerName above already relies on, for the sibling case
      // where the field survived the IMMEDIATELY preceding spec rather than
      // being removed and re-added). Without resolving through a lowercased
      // fallback first, this falls through to the "new_column" ALTER TABLE
      // ADD COLUMN below, which throws SQLite's own "duplicate column name"
      // error.
      const physicalColumnName =
        currentColumns.has(columnName)
          ? columnName
          : Array.from(currentColumns).find((c) => c.toLowerCase() === columnName.toLowerCase());
      if (physicalColumnName) {
        const shape = physicalShapeByColumn.get(physicalColumnName);
        const expectedSqlType = sqlTypeFor(field);
        if (shape && shape.sqlType !== expectedSqlType) {
          changes.push({
            type: "type_changed",
            table,
            column: columnName,
            fromType: fieldTypeLabelForSqlType(shape.sqlType, shape.fkTable !== undefined),
            toType: field.type,
          });
        } else if (field.type === "relation" && shape) {
          const expectedFkTable = field.relationTo && entityNames.has(field.relationTo) ? tableNameFor(projectId, field.relationTo) : undefined;
          if (shape.fkTable && expectedFkTable && shape.fkTable !== expectedFkTable) {
            changes.push({
              type: "relation_target_changed",
              table,
              column: columnName,
              fromRelationTo: entityNameForTable(projectId, [...previousEntities.keys(), ...entityNames], shape.fkTable),
              toRelationTo: field.relationTo,
            });
          } else if (!shape.fkTable && expectedFkTable) {
            // The reused column shares relation's own INTEGER bucket (so the
            // type_changed check above stays silent) but never had a FK at
            // all -- e.g. it was a plain boolean before being removed, or a
            // relation to a target that no longer resolves. SQLite can't add
            // a FOREIGN KEY to an existing column any more than it can
            // retype one, so unlike a brand-new relation column (which gets
            // a real REFERENCES clause below), this one is left with *zero*
            // referential-integrity protection forever -- strictly worse
            // than relation_target_changed's "still watching the wrong
            // table", since nothing is watched at all. Without this, the
            // dangling-id invariant twin.ts's own insight logic relies on
            // ("a bug elsewhere" producing one) would be silently false for
            // this exact column, with no reported change to explain why.
            changes.push({
              type: "relation_missing_fk",
              table,
              column: columnName,
              toRelationTo: field.relationTo,
            });
          }
        }
      }
      // Whether to physically run the ALTER (has SQLite already got this
      // column?) and whether to report it as a change (is it new relative
      // to previousSpec?) are separate questions -- a column can be
      // physically present already while still being new *this call*, e.g.
      // when pipeline.ts retries diffAndMigrate with the same previousSpec
      // after the Debug Agent fixes a later entity that made an earlier
      // partial attempt throw. Reporting it either way keeps the returned
      // change list an accurate diff against previousSpec regardless of
      // what a prior, partially-failed call already applied.
      if (!physicalColumnName) {
        const sqlType = sqlTypeFor(field);
        // NOT NULL deliberately omitted: SQLite can't retroactively satisfy
        // it against a table's existing rows (they'd all violate it with
        // their current NULL). The column is added nullable;
        // required-ness is still enforced by the API for every write going
        // forward. A REFERENCES clause has no such problem -- existing rows
        // just get NULL in the new column, which trivially satisfies a
        // foreign key -- so it's added here exactly like
        // generateCreateTableStatements already does for a brand-new table.
        // Without this, a relation field added to an *existing* entity via
        // refine got no FK protection at all: deleting a record another
        // record's new relation field pointed at would silently succeed
        // instead of being blocked with the 409 routes/projects.ts already
        // returns for this exact case on a relation field that existed from
        // the start.
        let fk = "";
        if (field.type === "relation" && field.relationTo && entityNames.has(field.relationTo)) {
          const relatedTable = tableNameFor(projectId, field.relationTo);
          fk = ` REFERENCES ${quoteIdentifier(relatedTable)}(id)`;
        }
        db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(columnName)} ${sqlType}${fk}`);
      }
      changes.push({ type: "new_column", table, column: columnName });
    }
    if (hasCheckpointHistoryTable(db)) recordEntityNameInHistory(db, projectId, entity.name);
  });

  // An entity or field this spec change (refine, the Debug Agent's retry,
  // checkpoint restore) drops from the spec can leave a stale automation
  // rule referencing a name that no longer exists -- harmless by itself,
  // since the record routes that would fire it already 404 via
  // findEntity/findField first. But deriveEntityName/deriveFieldName
  // (routes/projects.ts) only dedupe against names that currently exist,
  // so a LATER spec change that reintroduces the same name (plausible: an
  // AI-regenerated spec for the same business tends to reconverge on the
  // same obvious names, e.g. "Order"/"status") silently resurrects the
  // stale rule against an entity/field it was never actually written
  // for. Cleaned up here, not in the API routes, so every diffAndMigrate
  // caller is covered uniformly, the same way this function's own
  // migrations already are additive/removal-symmetric per call site.
  // ensureAutomationRulesTable is idempotent (CREATE TABLE IF NOT
  // EXISTS) -- called here rather than assumed, since diffAndMigrate is
  // also exercised directly (migrate.test.ts) against a bare
  // openDatabase(":memory:") that never goes through store.ts's own
  // centralized table setup.
  ensureAutomationRulesTable(db);
  for (const prevEntity of previousSpec.entities) {
    if (!entityNames.has(prevEntity.name)) {
      disableAutomationRulesForEntity(db, projectId, prevEntity.name);
      continue;
    }
    const nextEntity = nextSpec.entities.find((e) => e.name === prevEntity.name)!;
    const nextFieldNames = new Set(nextEntity.fields.map((f) => f.name));
    // A field renamed only by letter case (e.g. "status" -> "Status") is a
    // genuine no-op for the main per-field diff loop above (rounds 617/618's
    // prevFieldByLowerName fallback) -- the field survives with the same
    // data and the same physical column. But this separate sweep's own
    // nextFieldNames.has() is still exact-string, so it sees the
    // old-cased prevField.name as "removed" and disables any automation
    // rule still referencing it (as a field_equals trigger or a toField
    // destination), even though the field never actually left. A
    // lowercased fallback set, mirroring the same pattern already used one
    // function up, resolves this the same way.
    const nextFieldNamesLower = new Set(nextEntity.fields.map((f) => f.name.toLowerCase()));
    for (const prevField of prevEntity.fields) {
      if (!nextFieldNames.has(prevField.name) && !nextFieldNamesLower.has(prevField.name.toLowerCase())) {
        disableAutomationRulesForField(db, projectId, prevEntity.name, prevField.name);
      }
    }
    for (const fieldName of fieldsNeedingAutomationDisable.get(prevEntity.name) ?? []) {
      disableAutomationRulesForField(db, projectId, prevEntity.name, fieldName);
    }
  }

  return changes;
}
