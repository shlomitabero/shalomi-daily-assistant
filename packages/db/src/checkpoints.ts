import type { Checkpoint, ProductSpec } from "@forge/shared";
import { ProductSpecSchema } from "@forge/shared";
import type { ForgeDatabase } from "./connection.js";
import { NotFoundError } from "./repository.js";

/**
 * Time Machine storage: every successful build or refine snapshots the
 * resulting spec here. Restoring a checkpoint moves the project's spec
 * pointer back to that snapshot; it never drops tables/columns added since
 * (see migrate.ts — migrations in this engine are additive-only), so a
 * restore is always safe to apply, it just stops surfacing fields/entities
 * added after that point until refined forward again.
 */
export function ensureCheckpointsTable(db: ForgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'build',
      spec_json TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  // A table created by an older version of this app has no `kind` column at
  // all -- additive-only, same discipline migrate.ts uses for every
  // per-project entity table, so a pre-existing checkpoints table is never
  // dropped or recreated here. ADD COLUMN gives every existing row the
  // column's own 'build' default, then this one-time UPDATE backfills
  // "refine" using the exact same label-prefix heuristic getCheckpointType
  // itself used to live-classify a checkpoint before this column existed --
  // the best information available for data written before today. A
  // checkpoint already renamed away from its original "Refine: .../שיפור:
  // ..." prefix before this migration ever runs can't be recovered
  // correctly by this one-time backfill -- an honest, unavoidable limit of
  // reconstructing history from the only signal that ever existed for it.
  // Every checkpoint created after this point gets its `kind` set directly
  // at insertCheckpoint instead, never derived from (or vulnerable to a
  // later rename of) its label again.
  const hasKindColumn = (db.prepare("PRAGMA table_info(checkpoints)").all() as { name: string }[]).some((c) => c.name === "kind");
  if (!hasKindColumn) {
    db.exec("ALTER TABLE checkpoints ADD COLUMN kind TEXT NOT NULL DEFAULT 'build'");
    db.exec(`UPDATE checkpoints SET kind = 'refine' WHERE label LIKE 'Refine:%' OR label LIKE 'שיפור:%'`);
  }

  // Round 1312: renameCheckpoint's own doc-comment below says this feature
  // exists so a user can give an important checkpoint a label that's still
  // memorable "months later" -- but round 1291's retention prune (just
  // below, in insertCheckpoint) deletes purely by recency, with no
  // exemption for a checkpoint the user explicitly renamed. Once 100 newer
  // build/refine checkpoints accumulate past a renamed one, it's pruned
  // exactly like an ordinary auto-labeled one, silently defeating the
  // rename feature's entire stated purpose. `renamed` is set directly by
  // renameCheckpoint from here on (never re-derived from `label`, same
  // discipline `kind` above already adopted and for the identical reason:
  // a user could otherwise rename a checkpoint to text that happens to
  // look auto-generated). For data written before this column existed,
  // this one-time backfill marks a checkpoint as already-renamed when its
  // label doesn't match either auto-generated shape -- the same kind of
  // best-effort, admittedly-imperfect reconstruction the `kind` backfill
  // above already does from the only signal that ever existed for it.
  const hasRenamedColumn = (db.prepare("PRAGMA table_info(checkpoints)").all() as { name: string }[]).some((c) => c.name === "renamed");
  if (!hasRenamedColumn) {
    db.exec("ALTER TABLE checkpoints ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0");
    db.exec(
      `UPDATE checkpoints SET renamed = 1 WHERE label NOT IN ('Initial build', 'בנייה ראשונית') AND label NOT LIKE 'Refine:%' AND label NOT LIKE 'שיפור:%'`,
    );
  }

  // Round 1567: closes docs/security.md's own named gap ("checkpoints
  // record *what* changed but not *who* triggered it") -- unlike `kind`/
  // `renamed` above, there is no signal anywhere to backfill this from for
  // a pre-existing row (no prior column, no label heuristic that could
  // ever have encoded a user id), so this stays honestly NULL forever for
  // every checkpoint written before this column existed. Every checkpoint
  // written after this point gets it set directly by insertCheckpoint,
  // from the real authenticated req.userId the build/refine route already
  // has on hand (routes/projects.ts).
  const hasCreatedByUserIdColumn = (db.prepare("PRAGMA table_info(checkpoints)").all() as { name: string }[]).some((c) => c.name === "createdByUserId");
  if (!hasCreatedByUserIdColumn) {
    db.exec("ALTER TABLE checkpoints ADD COLUMN createdByUserId TEXT");
  }

  // A durable, append-only record of every entity name a project's spec has
  // ever contained -- written once at insertCheckpoint and never pruned by
  // deleteCheckpoint, unlike listAllCheckpointedEntityNames below, which
  // re-derives the same thing live from whichever checkpoints still happen
  // to exist. deleteProject (projects.ts) needs the entity name for every
  // real table it must drop; deleting a *single* checkpoint (round 216,
  // an ordinary, advertised cleanup action -- "an experimental refine that
  // went nowhere") can remove the only checkpoint whose spec_json still
  // mentioned an entity later refined out of the spec, with no other
  // checkpoint or the current spec mentioning it either -- at that point
  // listAllCheckpointedEntityNames alone can no longer see it, and that
  // entity's real table becomes permanently orphaned the moment the whole
  // project is later deleted (confirmed via a direct repro: build with
  // Customer+Order, refine away Order, delete the build checkpoint, delete
  // the project -- the Order table survives with nothing left anywhere
  // referencing it). This table is the fix: once an entity name is ever
  // written here, it survives for as long as the project itself does.
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_entity_history (
      projectId TEXT NOT NULL,
      entityName TEXT NOT NULL,
      PRIMARY KEY (projectId, entityName)
    )
  `);
  // Backfill for data written before this table existed -- every checkpoint
  // still on file plus every project's own current spec, which the ledger
  // would otherwise never have learned about if its own build/refine
  // happened before this round. Re-run (idempotent via INSERT OR IGNORE)
  // on every startup rather than gated behind "table just created": cheap
  // at this app's scale, and self-healing if the ledger and the checkpoints
  // table ever drifted apart for any other reason.
  // The `projects` table may not exist yet when this runs in isolation (a
  // unit test that calls ensureCheckpointsTable without ensureProjectsTable
  // first); real app startup (store.ts) always creates it first, but the
  // backfill degrades to checkpoints-only rather than throwing either way.
  const hasProjectsTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
    .get();
  const allSpecRows = db
    .prepare(
      hasProjectsTable
        ? `SELECT projectId, spec_json FROM checkpoints
           UNION ALL
           SELECT id AS projectId, spec_json FROM projects`
        : `SELECT projectId, spec_json FROM checkpoints`,
    )
    .all() as { projectId: string; spec_json: string }[];
  const insertHistoryEntry = db.prepare("INSERT OR IGNORE INTO checkpoint_entity_history (projectId, entityName) VALUES (?, ?)");
  for (const row of allSpecRows) {
    for (const entityName of extractEntityNamesFromSpecJson(row.spec_json)) {
      insertHistoryEntry.run(row.projectId, entityName);
    }
  }

  // Round 1760: the durable twin of checkpoint_entity_history above, but
  // for a field's own declared TYPE rather than an entity's name --
  // findLastKnownFieldType (below) used to scan `checkpoints.spec_json`
  // directly for this, which was safe when that table was unbounded, but
  // insertCheckpoint's own CHECKPOINTS_RETENTION_LIMIT prune (round 1291)
  // deletes rows by pure recency with no awareness that this other
  // function depends on old rows surviving -- round 1291's own
  // verification only ever checked that pruning didn't break the
  // entity-name ledger above, never this. Once enough builds/refines
  // accumulate on a long-lived project (exactly the population the
  // retention cap itself targets) past a field's removal, every
  // checkpoint that ever declared its type ages out, findLastKnownFieldType
  // silently returns undefined, and migrate.ts's reused-column TEXT-bucket
  // branch stops detecting a genuine date<->enum (etc.) reuse it was built
  // specifically to catch -- reopening the exact stale-data corruption
  // round 1108 exists to prevent. This table fixes it the same way
  // checkpoint_entity_history fixes the analogous entity-name gap: upserted
  // (keyed by projectId+entityName+fieldName, so it always holds only the
  // MOST RECENT declared type) at the same insertCheckpoint call site,
  // independent of whether the checkpoint that recorded it is later pruned.
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_field_type_history (
      projectId TEXT NOT NULL,
      entityName TEXT NOT NULL,
      fieldName TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (projectId, entityName, fieldName)
    )
  `);
  // Backfill, same rationale and same re-run-every-startup idempotence as
  // checkpoint_entity_history's own backfill above. Order matters here
  // (unlike the entity-name backfill's INSERT OR IGNORE, this is an
  // upsert that must end up holding the MOST RECENT type): checkpoints
  // are processed oldest-first so a later checkpoint's declared type
  // always overwrites an earlier one's, and each project's own current
  // spec -- the single most up-to-date source of truth available -- is
  // applied last, after every checkpoint.
  const upsertFieldType = db.prepare(
    "INSERT INTO checkpoint_field_type_history (projectId, entityName, fieldName, type) VALUES (?, ?, ?, ?) ON CONFLICT (projectId, entityName, fieldName) DO UPDATE SET type = excluded.type",
  );
  const checkpointSpecRowsOldestFirst = db
    .prepare("SELECT projectId, spec_json FROM checkpoints ORDER BY createdAt ASC, rowid ASC")
    .all() as { projectId: string; spec_json: string }[];
  for (const row of checkpointSpecRowsOldestFirst) {
    for (const [entityName, fieldName, type] of extractFieldTypesFromSpecJson(row.spec_json)) {
      upsertFieldType.run(row.projectId, entityName, fieldName, type);
    }
  }
  if (hasProjectsTable) {
    const currentSpecRows = db.prepare("SELECT id AS projectId, spec_json FROM projects").all() as { projectId: string; spec_json: string }[];
    for (const row of currentSpecRows) {
      for (const [entityName, fieldName, type] of extractFieldTypesFromSpecJson(row.spec_json)) {
        upsertFieldType.run(row.projectId, entityName, fieldName, type);
      }
    }
  }
}

function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    label: row.label as string,
    kind: row.kind as "build" | "refine",
    spec: ProductSpecSchema.parse(JSON.parse(row.spec_json as string)),
    createdAt: row.createdAt as string,
    createdByUserId: (row.createdByUserId as string | null) ?? null,
  };
}

/**
 * ProductSpecSchema can only get stricter over time (see the identical
 * rationale on projects.ts's tryRowToProject), so a checkpoint written by
 * an older version of this app -- and no longer parseable against today's
 * schema -- is a real, expected future case. Unlike a single-checkpoint
 * fetch, a list has other valid checkpoints to still show, so one bad row
 * is excluded rather than taking down the whole Time Machine history for
 * the project.
 */
function tryRowToCheckpoint(row: Record<string, unknown>): Checkpoint | undefined {
  try {
    return rowToCheckpoint(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Checkpoint ${row.id as string} has a stored spec that no longer matches the current schema; excluded from listings until fixed.`, err);
    return undefined;
  }
}

/**
 * The single-entity primitive recordEntityHistory below loops over. Exported
 * separately (round 611) so diffAndMigrate (migrate.ts) can record an
 * entity's name into the durable history ledger (see ensureCheckpointsTable's
 * own doc-comment) the moment ITS OWN migration step actually commits --
 * diffAndMigrate can itself throw partway through nextSpec.entities (e.g. a
 * later entity's sanitized-name collision, round 496-498's own guard), after
 * earlier entities in that same call already got their real tables created.
 * Round 610 only ever recorded history once, after the pipeline's WHOLE
 * migration call succeeded -- too late for an entity whose own table is
 * already real but whose call never got to finish, orphaning it exactly the
 * same way a QA failure did before round 610.
 */
export function recordEntityNameInHistory(db: ForgeDatabase, projectId: string, entityName: string): void {
  db.prepare("INSERT OR IGNORE INTO checkpoint_entity_history (projectId, entityName) VALUES (?, ?)").run(projectId, entityName);
}

/**
 * Writes every entity name in `spec` into the durable history ledger,
 * independent of ever inserting a checkpoint. insertCheckpoint below calls
 * this once its own row is written, so a checkpoint's own entities are
 * tracked even though diffAndMigrate's own per-entity calls (above) already
 * cover every entity whose migration actually ran during this project's
 * history.
 */
export function recordEntityHistory(db: ForgeDatabase, projectId: string, spec: ProductSpec): void {
  for (const entity of spec.entities) {
    recordEntityNameInHistory(db, projectId, entity.name);
  }
}

/**
 * The field-type twin of recordEntityHistory above, feeding
 * checkpoint_field_type_history (see ensureCheckpointsTable's own doc
 * comment for why this ledger exists, round 1760). Upserts rather than
 * INSERT OR IGNORE: this ledger must hold a field's MOST RECENT declared
 * type, not just "has this field ever existed," so a later call for the
 * same (projectId, entityName, fieldName) deliberately overwrites an
 * earlier one's type.
 */
export function recordFieldTypeHistory(db: ForgeDatabase, projectId: string, spec: ProductSpec): void {
  const upsert = db.prepare(
    "INSERT INTO checkpoint_field_type_history (projectId, entityName, fieldName, type) VALUES (?, ?, ?, ?) ON CONFLICT (projectId, entityName, fieldName) DO UPDATE SET type = excluded.type",
  );
  for (const entity of spec.entities) {
    for (const field of entity.fields) {
      upsert.run(projectId, entity.name, field.name, field.type);
    }
  }
}

/**
 * Mirrors automations.ts's own AUTOMATION_RUNS_RETENTION_LIMIT convention
 * (round 951) for the identical unbounded-growth shape: every build/refine
 * adds one checkpoint, forever, with no cap at all before this round --
 * each row carries a full spec_json blob, a real unbounded storage cost
 * for a long-lived project. Higher than automation_runs's own limit (20)
 * since a checkpoint is added far less often (one per build/refine, not
 * one per automation firing) and is the more valuable of the two to keep
 * around longer. Exported so a future caller that needs to stay in sync
 * with this exact number (the same reasoning AUTOMATION_RUNS_RETENTION_LIMIT's
 * own doc comment gives) can read it rather than hard-coding its own copy.
 */
export const CHECKPOINTS_RETENTION_LIMIT = 100;

export function insertCheckpoint(
  db: ForgeDatabase,
  checkpoint: { id: string; projectId: string; label: string; kind: "build" | "refine"; spec: ProductSpec; createdByUserId?: string | null },
): Checkpoint {
  const createdAt = new Date().toISOString();
  const createdByUserId = checkpoint.createdByUserId ?? null;
  db.prepare(
    "INSERT INTO checkpoints (id, projectId, label, kind, spec_json, createdAt, createdByUserId) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(checkpoint.id, checkpoint.projectId, checkpoint.label, checkpoint.kind, JSON.stringify(checkpoint.spec), createdAt, createdByUserId);
  recordEntityHistory(db, checkpoint.projectId, checkpoint.spec);
  recordFieldTypeHistory(db, checkpoint.projectId, checkpoint.spec);
  // Prunes the oldest checkpoints beyond the retention limit, mirroring
  // recordAutomationRun's own exact DELETE...NOT IN (SELECT...ORDER BY...
  // LIMIT ?) pattern. Safe even if the pruned set includes the checkpoint
  // matching the project's current spec -- deleteCheckpoint's own doc
  // comment already establishes that deleting that one is harmless, since
  // the current spec lives on the project row itself, independent of this
  // table. checkpoint_entity_history (recordEntityHistory, just above) is
  // this table's own separate, deliberately-unpruned ledger, so pruning
  // here can never orphan a real data table the way deleting a checkpoint
  // alone once could before that ledger existed.
  //
  // Round 1312: `renamed = 0` treats an explicit rename (renameCheckpoint,
  // below) as the user pinning that checkpoint -- exempting it from this
  // prune entirely, regardless of age, instead of deleting it on exactly
  // the same schedule as a never-looked-at auto-labeled one. A user would
  // have to rename over 100 checkpoints in one project to make this table
  // grow unbounded again; that's a deliberate, bounded action per row, not
  // the unbounded-by-default growth round 1291 was guarding against.
  db.prepare(
    `DELETE FROM checkpoints WHERE projectId = ? AND renamed = 0 AND id NOT IN (
      SELECT id FROM checkpoints WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?
    )`,
  ).run(checkpoint.projectId, checkpoint.projectId, CHECKPOINTS_RETENTION_LIMIT);
  return { ...checkpoint, createdAt, createdByUserId };
}

export function listCheckpoints(db: ForgeDatabase, projectId: string): Checkpoint[] {
  // createdAt has only millisecond resolution, so two checkpoints inserted
  // in quick succession (e.g. a build's checkpoint immediately followed by
  // a refine's) can share the same value; ORDER BY createdAt DESC alone
  // leaves that tie's order undefined. rowid strictly increases with
  // insertion order in this SQLite table (not declared WITHOUT ROWID), so
  // it breaks the tie deterministically in favor of "most recently
  // inserted first" -- exactly what "newest first" means for a tie.
  const rows = db
    .prepare("SELECT * FROM checkpoints WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(tryRowToCheckpoint).filter((c): c is Checkpoint => c !== undefined);
}

/**
 * deleteProject (projects.ts) needs every entity name this project's
 * checkpoint history could ever have produced a real data table for, so
 * it can drop tables for entities later removed from the spec (migrate.ts
 * is additive-only -- see deleteProject's own doc-comment). Going through
 * listCheckpoints for that would be wrong: tryRowToCheckpoint deliberately
 * excludes a checkpoint whose *other* fields (roles, summary, ...) no
 * longer satisfy a ProductSpecSchema that has only gotten stricter since
 * the checkpoint was written (see that schema's own doc-comment) -- the
 * right behavior for a user-facing history list, but it would silently
 * drop that checkpoint's entities from deleteProject's accounting too,
 * leaving their real tables permanently orphaned. Extracting entity names
 * only needs `entities` to be an array of objects with a string `name` --
 * far weaker than the full schema -- so this reads spec_json directly
 * instead of going through rowToCheckpoint/ProductSpecSchema.parse.
 */
/**
 * Shared by listAllCheckpointedEntityNames below and projects.ts's own
 * deleteProject, which needs the exact same tolerant extraction for a
 * project's own spec_json (not just its checkpoints) for the identical
 * reason: a project row can fail full ProductSpecSchema.parse too (see
 * projects.ts's tryRowToProject), and deleteProject can't afford to miss
 * entities just because the rest of the stored spec no longer validates.
 */
export function extractEntityNamesFromSpecJson(specJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specJson);
  } catch {
    return [];
  }
  const entities = (parsed as { entities?: unknown })?.entities;
  if (!Array.isArray(entities)) return [];
  const names: string[] = [];
  for (const entity of entities) {
    const name = (entity as { name?: unknown })?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

export function listAllCheckpointedEntityNames(db: ForgeDatabase, projectId: string): string[] {
  const rows = db
    .prepare("SELECT spec_json FROM checkpoints WHERE projectId = ?")
    .all(projectId) as { spec_json: string }[];
  const names = new Set<string>();
  for (const row of rows) {
    for (const name of extractEntityNamesFromSpecJson(row.spec_json)) names.add(name);
  }
  return [...names];
}

/**
 * The field-type twin of extractEntityNamesFromSpecJson above, used only
 * by checkpoint_field_type_history's own backfill (round 1760).
 */
function extractFieldTypesFromSpecJson(specJson: string): [entityName: string, fieldName: string, type: string][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specJson);
  } catch {
    return [];
  }
  const entities = (parsed as { entities?: unknown })?.entities;
  if (!Array.isArray(entities)) return [];
  const result: [string, string, string][] = [];
  for (const entity of entities) {
    const entityName = (entity as { name?: unknown })?.name;
    const fields = (entity as { fields?: unknown })?.fields;
    if (typeof entityName !== "string" || !Array.isArray(fields)) continue;
    for (const field of fields) {
      const fieldName = (field as { name?: unknown })?.name;
      const type = (field as { type?: unknown })?.type;
      if (typeof fieldName === "string" && typeof type === "string") result.push([entityName, fieldName, type]);
    }
  }
  return result;
}

/**
 * Round 1108: migrate.ts's "reused column" branch (a field removed on one
 * refine and re-added two+ refines later under the same name) has no
 * `prevField` to compare against -- by definition, the field is absent
 * from `previousSpec`. For the physically-ambiguous TEXT bucket
 * (text/longtext/enum/date all collapse to the same SQLite column type,
 * see migrate.ts's own `sqlTypeFor`), that leaves no way at all to tell a
 * genuine date->enum reuse (stale ISO-date strings now rendered/edited as
 * an enum select with no matching option) from a benign text->text one --
 * a gap identified and deliberately deferred at round 511 as needing "a
 * field's full type lineage beyond one hop, which does not currently
 * exist." It does, in the sense that matters here: checkpoint_field_type_history
 * (round 1760) already records this entity+field's most recently declared
 * type, upserted every time a checkpoint is written (insertCheckpoint,
 * above).
 *
 * Originally (round 1108-1226) this scanned `checkpoints.spec_json`
 * directly, newest-first, for the same answer -- safe only as long as
 * that table was unbounded. Round 1291's CHECKPOINTS_RETENTION_LIMIT
 * prune made that unsafe: once every checkpoint that ever declared a
 * removed field's type ages out (realistic on exactly the long-lived,
 * heavily-refined projects the retention cap itself targets), the old
 * scan silently returned undefined, defeating this function's whole
 * purpose. checkpoint_field_type_history is deliberately never pruned,
 * the same way checkpoint_entity_history (this file's analogous ledger
 * for entity names) isn't.
 */
export function findLastKnownFieldType(db: ForgeDatabase, projectId: string, entityName: string, fieldName: string): string | undefined {
  // Exact-case first, falling back to case-insensitive -- the same
  // convention findField (routes/projects.ts) already uses, and the same
  // one this function itself adopted at round 1226 -- since the
  // entity/field this is called with (migrate.ts's reused-column branch)
  // is today's live declared name, which a cosmetic recase (round 988's
  // own "never treat like a real drop" convention) can legitimately leave
  // differing in case from how this ledger originally recorded it.
  const exact = db
    .prepare("SELECT type FROM checkpoint_field_type_history WHERE projectId = ? AND entityName = ? AND fieldName = ?")
    .get(projectId, entityName, fieldName) as { type: string } | undefined;
  if (exact) return exact.type;
  const rows = db
    .prepare("SELECT entityName, fieldName, type FROM checkpoint_field_type_history WHERE projectId = ?")
    .all(projectId) as { entityName: string; fieldName: string; type: string }[];
  const caseInsensitive = rows.find(
    (r) => r.entityName.toLowerCase() === entityName.toLowerCase() && r.fieldName.toLowerCase() === fieldName.toLowerCase(),
  );
  return caseInsensitive?.type;
}

/**
 * The durable twin of listAllCheckpointedEntityNames above (see
 * ensureCheckpointsTable's own doc-comment for why the two differ):
 * listAllCheckpointedEntityNames only ever sees entity names from
 * checkpoints that still exist right now, so a deleted single checkpoint
 * (round 216) can make it forget an entity name forever, even though
 * that entity genuinely had a real data table at some point. This reads
 * the append-only ledger instead -- every entity name this project's spec
 * has EVER contained, independent of which checkpoints happen to still be
 * around. deleteProject (projects.ts) unions both, plus the current spec,
 * so losing any one source is never by itself enough to orphan a table.
 */
export function listHistoricalEntityNames(db: ForgeDatabase, projectId: string): string[] {
  const rows = db.prepare("SELECT entityName FROM checkpoint_entity_history WHERE projectId = ?").all(projectId) as { entityName: string }[];
  return rows.map((r) => r.entityName);
}

export function getCheckpoint(db: ForgeDatabase, id: string): Checkpoint | undefined {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCheckpoint(row) : undefined;
}

/**
 * Round 1427: the lenient counterpart to getCheckpoint above, mirroring
 * tryRowToCheckpoint's own doc comment -- a checkpoint whose stored spec
 * no longer parses against today's ProductSpecSchema is a real, expected
 * case (listCheckpoints already excludes such rows from Time Machine's
 * own list via tryRowToCheckpoint), but getCheckpoint's single callsite,
 * the restore route, never caught its raw throw: a checkpoint id a caller
 * already has (a stale rendered "Restore" button, a retried request) hit
 * an uncaught ZodError -> a raw 500, instead of the exact same clean 404
 * CHECKPOINT_NOT_FOUND the route already throws one line later for "no
 * such id"/"wrong project". Routes that only need to know whether a
 * restorable checkpoint exists should use this instead of getCheckpoint.
 */
export function tryGetCheckpoint(db: ForgeDatabase, id: string): Checkpoint | undefined {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? tryRowToCheckpoint(row) : undefined;
}

/**
 * Renames a checkpoint's own label -- Time Machine only ever gave a
 * checkpoint an automatic label ("Initial build", "Refine: <instruction>"),
 * with no way to give an important one a name that's actually memorable
 * months later (e.g. "before the pricing overhaul"). Scoped to projectId in
 * the same WHERE clause as the checkpoint id itself (mirroring
 * deleteWhatsAppMessage's own convention in whatsapp.ts), so a checkpoint
 * id belonging to a different project can never be renamed through this
 * call. Throws NotFoundError for an id that doesn't exist in this
 * project's own history. Deliberately touches only `label` (and, as of
 * round 1312, `renamed`) -- `kind` is set once at insertCheckpoint and
 * never revisited here, so renaming a checkpoint (even to text that
 * happens to look like the other kind's own default label) can never
 * change how HistoryPanel's build/refine filter classifies it.
 *
 * Round 1312: also marks `renamed = 1`, exempting this checkpoint from
 * insertCheckpoint's own retention prune (see that function's doc-comment)
 * from now on -- without this, the exact scenario this doc-comment's
 * "months later" promise describes used to be defeated the moment 100
 * newer build/refine checkpoints piled up after it.
 */
export function renameCheckpoint(db: ForgeDatabase, projectId: string, checkpointId: string, label: string): Checkpoint {
  const result = db.prepare("UPDATE checkpoints SET label = ?, renamed = 1 WHERE id = ? AND projectId = ?").run(label, checkpointId, projectId);
  if (result.changes === 0) {
    throw new NotFoundError(`Checkpoint ${checkpointId} not found in project ${projectId}`);
  }
  // Round 1093: re-reading through getCheckpoint's strict rowToCheckpoint
  // (ProductSpecSchema.parse) would throw for a checkpoint whose stored
  // spec_json no longer satisfies today's schema (see rowToCheckpoint's own
  // doc-comment -- ProductSpecSchema can only get stricter over time), but
  // only AFTER the label UPDATE above already committed -- so the rename
  // would silently succeed while the caller sees a crash, and every retry
  // (withIdempotency, routes/projects.ts) would repeat the exact same
  // failure forever, since nothing about the stale spec_json ever changes.
  // Renaming never touches spec_json, so this function never needed that
  // validation in the first place; the rest of the returned Checkpoint is
  // just echoing back this row's own stored fields, read directly instead
  // of round-tripped through a schema check this call has no use for.
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as Record<string, unknown>;
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    label: row.label as string,
    kind: row.kind as "build" | "refine",
    spec: JSON.parse(row.spec_json as string) as ProductSpec,
    createdAt: row.createdAt as string,
    createdByUserId: (row.createdByUserId as string | null) ?? null,
  };
}

/**
 * Part of deleteProject's cleanup (projects.ts) -- a deleted project's
 * history has nothing left to restore. Also clears this project's own rows
 * from checkpoint_entity_history: deleteProject has already read it (and
 * every other source) into its own entityNames set by the time this runs,
 * so nothing is lost by clearing it here, and leaving it behind would let
 * the ledger grow forever with rows for projects that no longer exist.
 */
export function deleteCheckpointsForProject(db: ForgeDatabase, projectId: string): void {
  db.prepare("DELETE FROM checkpoints WHERE projectId = ?").run(projectId);
  db.prepare("DELETE FROM checkpoint_entity_history WHERE projectId = ?").run(projectId);
}

/**
 * Removes a single checkpoint -- Time Machine's history otherwise only ever
 * grows (every build and every refine adds one, with no way to prune a
 * single unwanted entry, e.g. an experimental refine that went nowhere),
 * the same real gap round 208 closed for the WhatsApp message log.
 * Scoped to projectId in the same WHERE clause as the checkpoint id itself,
 * the same convention renameCheckpoint above and deleteWhatsAppMessage
 * (whatsapp.ts) already use, so a checkpoint id belonging to a different
 * project can never be deleted through this call. Deleting a checkpoint
 * never touches the project's own current spec -- that lives on the
 * project row itself, independent of this table -- so even deleting the
 * checkpoint that happens to match the current state (the "Current" chip
 * in HistoryPanel.tsx) is harmless; it just removes that historical entry.
 * Throws NotFoundError for an id that doesn't exist in this project's own
 * history.
 */
export function deleteCheckpoint(db: ForgeDatabase, projectId: string, checkpointId: string): void {
  const result = db.prepare("DELETE FROM checkpoints WHERE id = ? AND projectId = ?").run(checkpointId, projectId);
  if (result.changes === 0) {
    throw new NotFoundError(`Checkpoint ${checkpointId} not found in project ${projectId}`);
  }
}
