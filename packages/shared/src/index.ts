import { z } from "zod";

export const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "boolean",
  "date",
  "enum",
  "relation",
  "file",
] as const;

/**
 * Every generated table hardcodes these three columns as built-ins
 * (packages/db/src/migrate.ts for the live preview, apps/api/src/codegen.ts
 * for the exported standalone app) -- a field sharing any of these names,
 * in any casing, produces a duplicate-column `CREATE TABLE`, which throws
 * uncaught and crashes the whole exported app before it can even start
 * listening. Rejected here, at the one point every spec (heuristic, the
 * real Anthropic provider, and its own repair path in debug.ts) is
 * validated, so a bad name just falls back to the heuristic provider
 * (see generateSpec in spec-engine/src/index.ts) instead of reaching
 * either database layer at all.
 *
 * Round 1614: "createdbyuserid" closes the exact same gap round 1613's own
 * new createdByUserId system column (the record-creation audit trail)
 * opened the moment it shipped -- this set was never updated for it, so a
 * field literally named "Created By User Id" sailed through this refine
 * untouched and only hit the real "duplicate column name" SQLite error at
 * build time.
 */
const RESERVED_FIELD_NAMES = new Set(["id", "createdat", "createdbyuserid"]);

/**
 * Mirrors packages/db/src/identifiers.ts's own SAFE_IDENTIFIER exactly
 * (duplicated, not imported, for the same reason findSanitizedIdentifierCollisions
 * below is: @forge/shared has no dependency on @forge/db) -- every field
 * name reaches assertSafeIdentifier raw, with NO sanitization step first,
 * in both migrate.ts (the live preview) and repository.ts's fieldColumns.
 * That's unlike an entity name, which tableNameFor always sanitizes
 * (replacing every non-ASCII-alphanumeric character with "_") before the
 * identical assert, so an entity name never actually throws there.
 * routes/projects.ts's own deriveFieldName (the manual "add field" UI
 * path) already produces a name guaranteed to match this shape -- its own
 * comment documents finding this exact gap at round 549 and closing it
 * for that one call path specifically -- but an AI-generated spec's field
 * name (anthropic.ts/debug.ts) is never run through deriveFieldName at
 * all; only RESERVED_FIELD_NAMES and ProductSpecSchema.safeParse stand
 * between the model's raw JSON and this crash point. A field name with a
 * space, a hyphen, a leading digit, or any non-ASCII character (plausible
 * for this app's Hebrew-primary user base, where `label` -- not `name` --
 * is meant to carry the Hebrew display text) reached `diffAndMigrate`
 * unguarded and threw a raw, uncaught-by-design Error there instead of
 * being caught here, at the one point every spec is validated, where a
 * rejected safeParse falls back to the heuristic provider invisibly (see
 * RESERVED_FIELD_NAMES's own comment above for why that fallback is the
 * intended outcome for exactly this class of risk).
 */
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * SQLite compares identifiers (table names included) case-insensitively for
 * ASCII, even when double-quoted -- confirmed directly against this
 * project's actual SQLite binding: `CREATE TABLE IF NOT EXISTS "Order" (...)`
 * followed by `CREATE TABLE IF NOT EXISTS "order" (...)` creates exactly one
 * table, "Order", and silently no-ops the second statement rather than
 * erroring (the `IF NOT EXISTS` guard sees the two names as the same table).
 * Both packages/db/src/migrate.ts (the live preview, table names prefixed
 * per-project) and apps/api/src/codegen.ts (the exported standalone app,
 * entity name used directly as the table name) create one table per entity
 * keyed by this name -- so two entities differing only by case would
 * silently collapse into one shared table, and every read/write for the
 * "losing" entity would run against the "winning" entity's columns instead.
 * Rejected here, at the one point every spec is validated, for the same
 * reason RESERVED_FIELD_NAMES is: better a spec falls back to the heuristic
 * provider than reach either database layer with an unreconcilable name.
 */
function findCaseInsensitiveDuplicateEntityNames(entities: { name: string }[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const entity of entities) {
    const key = entity.name.toLowerCase();
    if (seen.has(key)) {
      dupes.push(entity.name);
    } else {
      seen.add(key);
    }
  }
  return dupes;
}

/**
 * The live preview's table names (packages/db/src/identifiers.ts's
 * tableNameFor) are built by sanitizing an entity name -- replacing every
 * non-ASCII-alphanumeric character with "_" -- and, unlike the
 * case-insensitive check above, that sanitization never throws on an
 * unreconcilable name; it just silently produces a string. Two entities
 * with completely different names can sanitize down to the exact same
 * table name, most plausibly when both names are non-ASCII (e.g. Hebrew):
 * confirmed directly, `tableNameFor("p", "לקוח")` and
 * `tableNameFor("p", "מוצר")` are both `"entity_p_____"`. Whichever entity
 * is migrated second then has its `CREATE TABLE IF NOT EXISTS` silently
 * no-op against the first entity's already-created table, and every
 * read/write for the "losing" entity runs against the "winning" entity's
 * columns instead -- the exact same real-data-corruption failure mode
 * findCaseInsensitiveDuplicateEntityNames already guards against, just
 * reached through a different transformation. This sanitization rule is
 * intentionally duplicated here (not imported) rather than shared, since
 * @forge/shared has no dependency on @forge/db (the dependency runs the
 * other way) -- keep this in sync with tableNameFor if either changes.
 */
function findSanitizedIdentifierCollisions(entities: { name: string }[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const entity of entities) {
    const key = entity.name.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
    if (seen.has(key)) {
      dupes.push(entity.name);
    } else {
      seen.add(key);
    }
  }
  return dupes;
}

export const FieldSchema = z
  .object({
    name: z.string().min(1),
    /**
     * Human-facing name shown in the UI (e.g. Hebrew). Falls back to `name`
     * when ABSENT -- every display site uses `field.label ?? field.name`,
     * and `??` only falls back on `null`/`undefined`, never on `""`. Round
     * 856 (see this file's own name-sanitization comment just above)
     * already closed the equivalent gap for `name`; `label` was never
     * given the same treatment, so an AI-generated spec emitting
     * `"label": ""` (a model's plausible way of saying "no custom label")
     * passed validation cleanly and then rendered as a literally blank
     * string everywhere a label is shown, with no error surfaced anywhere.
     * `.min(1)` rejects that empty string the same way it already rejects
     * a malformed `name`, sending it back through generateSpec's existing
     * fallback instead of silently corrupting display text project-wide.
     */
    label: z.string().min(1).optional(),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    /**
     * Round 1215: the `.refine()` below only checked the ARRAY's own
     * length, never that each element is non-empty -- an AI-generated
     * spec emitting `enumValues: ["", "Active"]` passed validation
     * cleanly. Unlike `label` (purely display), an empty element here
     * becomes real STORED DATA: packages/db/src/seed.ts's
     * `field.enumValues?.[index % length] ?? null` cycles through every
     * declared value when seeding, and `"" ?? null` is `""` (not `null`),
     * so some seeded records get their enum column literally set to the
     * empty string. It also breaks the record-editing UI: EntityPanel.tsx
     * renders a blank enum badge/option, and `uniqueEnumValues` (which
     * only de-dupes, never filters blanks) produces an `<option value="">`
     * that collides with the enum `<select>`'s own "clear value"
     * placeholder -- the native `required` validation then can't
     * distinguish the two, silently blocking re-save of that record with
     * no error shown. `.min(1)` closes this the same way round 1213/1214
     * closed it for `label`/`roles`/`personas`/`assumptions`.
     */
    enumValues: z.array(z.string().min(1)).optional(),
    /**
     * Display text per raw enumValue (e.g. {"New": "חדש"}). The stored/API
     * value is always the raw enumValue.
     *
     * Round 1246: same bug class as round 1213/1215's `label`/`enumValues`
     * fixes -- every render site across this app falls back with
     * `field.enumLabels?.[value] ?? value`, which only falls back on
     * `null`/`undefined`, never on `""`. An AI-generated spec emitting
     * `enumLabels: {"Active": ""}` passed validation cleanly and then
     * rendered a literally blank label everywhere that enum value appears
     * (table cells, Kanban columns, calendar feed, backup CSV, automation
     * reports). `.min(1)` on the value closes it the same way round
     * 1213/1215 closed it for `label`/`enumValues`'s own elements.
     */
    enumLabels: z.record(z.string(), z.string().min(1)).optional(),
    relationTo: z.string().optional(),
  })
  .refine(
    (f) => (f.type !== "enum" || (f.enumValues && f.enumValues.length > 0)),
    { message: "enum fields must declare enumValues" },
  )
  .refine((f) => (f.type !== "relation" || !!f.relationTo), {
    message: "relation fields must declare relationTo",
  })
  .refine((f) => !RESERVED_FIELD_NAMES.has(f.name.toLowerCase()), (f) => ({
    message: `Field name "${f.name}" collides with a built-in column every table already has (id/createdAt/createdByUserId) -- choose a different name`,
  }))
  .refine((f) => SAFE_FIELD_NAME.test(f.name), (f) => ({
    message: `Field name "${f.name}" must be a plain ASCII identifier (letters, digits, underscore, starting with a letter) -- use "label" for a human-facing display name instead`,
  }));

export type Field = z.infer<typeof FieldSchema>;

/**
 * SQLite compares column names case-insensitively too, the same underlying
 * reason findCaseInsensitiveDuplicateEntityNames above exists -- confirmed
 * directly against this project's actual SQLite binding: `CREATE TABLE t
 * ("Email" TEXT, "email" TEXT)` throws "duplicate column name: email", and
 * (for an already-existing column) `ALTER TABLE t ADD COLUMN "Email" TEXT`
 * throws "duplicate column name: Email" the same way. routes/projects.ts's
 * `deriveFieldName` (the manual "add field" UI path) already de-duplicates
 * case-insensitively against an entity's existing fields, so this gap is
 * specific to an AI- or heuristic-generated spec, which has no equivalent
 * guard -- a /refine that regenerates an entity from prose alone (see
 * pipeline.ts's own `computeImpact` comment on that same blind spot) can
 * emit two same-entity fields differing only by case. Unlike the
 * entity-name case, two fields can only collide within the *same* entity
 * (fields are scoped per-table, not per-spec), so this is checked on
 * EntitySchema itself rather than ProductSpecSchema. Caught here, at the
 * one point every spec is validated, for the same reason: better a spec
 * falls back to the heuristic provider than reach either database layer
 * with an unreconcilable pair of column names.
 */
function findCaseInsensitiveDuplicateFieldNames(fields: { name: string }[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const field of fields) {
    const key = field.name.toLowerCase();
    if (seen.has(key)) {
      dupes.push(field.name);
    } else {
      seen.add(key);
    }
  }
  return dupes;
}

export const EntitySchema = z
  .object({
    name: z.string().min(1),
    /** Human-facing name shown in the UI (e.g. Hebrew). Falls back to `name` when absent -- see FieldSchema's own `label` comment above for why this is `.min(1)`, not just `.optional()`. */
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    fields: z.array(FieldSchema).min(1),
  })
  .refine((entity) => findCaseInsensitiveDuplicateFieldNames(entity.fields).length === 0, (entity) => ({
    message: `Entity "${entity.name}" has field name(s) that collide when compared case-insensitively, which SQLite column names cannot distinguish: ${findCaseInsensitiveDuplicateFieldNames(entity.fields).join(", ")} -- choose distinct names`,
  }));

export type Entity = z.infer<typeof EntitySchema>;

export const ScreenSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["list", "form", "dashboard"]),
  entity: z.string().optional(),
});

export type Screen = z.infer<typeof ScreenSchema>;

export const OpenQuestionSchema = z.object({
  question: z.string().min(1),
  /** Round 1214: see ProductSpecSchema's own `roles`/`personas`/`assumptions` comment just below -- same gap, same fix. */
  options: z.array(z.string().min(1)).default([]),
  recommendation: z.string().optional(),
});

export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/**
 * Every stored project (packages/db/src/projects.ts) and checkpoint keeps
 * its spec as JSON and re-validates it against *this* schema on every read
 * -- there's no migration step for old spec_json rows the way
 * diffAndMigrate handles the SQL schema. That makes this schema
 * append-only in practice: a new field must be `.optional()` or carry a
 * `.default()`, and an existing field must never go from optional to
 * required or gain a stricter validator (a new `.min()`, a narrower
 * `z.enum`, etc.) -- any of those would make every previously-stored spec
 * fail to parse. projects.ts's `listProjectsForOwner` treats a row that
 * fails to parse as excluded rather than crashing the whole list, but
 * that's a safety net for something else going wrong, not license to
 * break this schema on purpose. The one sanctioned exception is closing a
 * real data-corruption hole (as the entity-name-collision `.refine()`
 * below does): `getProject` has no such safety net and fails loudly for
 * that one project, which is the accepted, narrow cost of never having
 * let an unreconcilable name reach the database layer in the first place.
 */
export const ProductSpecSchema = z
  .object({
    summary: z.string().min(1),
    /**
     * Round 1214: `roles`/`personas`/`assumptions` are plain free-text
     * string arrays with no guard on each element's own content -- unlike
     * the narrow, purpose-built `AddRoleSchema`/`AddPersonaSchema`/
     * `AddAssumptionSchema` in routes/projects.ts (all `z.string().trim().min(1)`,
     * since "any non-empty string is a valid role/persona/assumption" per
     * that file's own comment), which a human can never bypass through the
     * UI. An AI-generated spec hitting this broader schema instead can
     * emit a stray `""` element in one of these arrays with nothing to
     * stop it. `RoleChip`/`PersonaItem`/`AssumptionItem`
     * (SpecListItemRemover.tsx) render the string DIRECTLY with no
     * fallback at all (unlike `label ?? name` -- round 1213's fix was for
     * a field with a fallback; these have none), so an empty element
     * renders as a ghost chip: invisible text, only a dangling remove
     * button, with no error ever surfaced. `.min(1)` on each element
     * closes this the same way round 1213 closed it for `label` and round
     * 856 closed it for `name` -- sending a spec with an empty element
     * back through generateSpec's existing heuristic-provider fallback
     * instead of silently storing/rendering a blank chip.
     */
    personas: z.array(z.string().min(1)).default([]),
    roles: z.array(z.string().min(1)).min(1),
    entities: z.array(EntitySchema).min(1),
    screens: z.array(ScreenSchema).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
    openQuestions: z.array(OpenQuestionSchema).default([]),
  })
  .refine((spec) => findCaseInsensitiveDuplicateEntityNames(spec.entities).length === 0, (spec) => ({
    message: `Entity name(s) collide when compared case-insensitively, which SQLite table names cannot distinguish: ${findCaseInsensitiveDuplicateEntityNames(spec.entities).join(", ")} -- choose distinct names`,
  }))
  .refine((spec) => findSanitizedIdentifierCollisions(spec.entities).length === 0, (spec) => ({
    message: `Entity name(s) collapse to the same underlying SQL table name once sanitized to a safe identifier: ${findSanitizedIdentifierCollisions(spec.entities).join(", ")} -- choose names that differ in their ASCII letters/digits, not just punctuation or non-ASCII characters`,
  }));

export type ProductSpec = z.infer<typeof ProductSpecSchema>;

/**
 * Round 1426: ProductSpecSchema's own doc comment above explains why this
 * schema can never gain a new/stricter validator on an EXISTING field --
 * every stored project and checkpoint re-validates its spec_json against
 * this exact schema on every read, so a new `.max()` here would make any
 * previously-stored spec whose content happens to exceed it fail to parse
 * going forward. That's exactly why rounds 1403/1404/1408-1411/1414/1423/
 * 1424's own "unbounded free-text field" caps all lived on the narrower
 * HTTP-input schemas in apps/api/src/routes/projects.ts (write-time only,
 * never re-validated against stored data) rather than here -- this schema
 * was the one place in the whole codebase that pattern could never safely
 * reach, round 1411's own comment says so outright, and no round since
 * closed it.
 *
 * The safe fix is a SEPARATE check, not a schema change: this function is
 * called only at the two points a freshly-generated spec is first
 * produced (AnthropicSpecProvider.generate, requestSpecFix), right next
 * to their own ProductSpecSchema.safeParse call, before anything is ever
 * stored. A model stuck in a token-repetition loop (a real, documented
 * LLM failure mode) can legitimately emit a syntactically valid spec
 * where one string field balloons to several KB -- ProductSpecSchema's
 * own `.min(1)` checks accept that without complaint, and that oversized
 * value then gets stored as the project's live spec AND baked into every
 * future Time Machine checkpoint, re-sent on every GET /projects/:id
 * (every page load, by every collaborator) and rendered verbatim in every
 * table header, Kanban column, calendar feed, Business Twin report, and
 * CSV/print export forever -- the same "bloats every future read"
 * amplification shape the HTTP-input caps above were built to prevent,
 * just one layer deeper. Returning a description here (rather than just
 * true/false) lets each caller fold it into the same descriptive
 * "Anthropic API response did not match..." Error message their own
 * schema-mismatch branch just above already throws, so this reuses that
 * exact same fallback-to-heuristic path with no new plumbing.
 *
 * Deliberately NOT applied to HeuristicSpecProvider's own output: its
 * `summary` legitimately embeds the raw project description verbatim
 * (see heuristic.ts's own `summarize`), which can itself be up to 5000
 * characters (CreateProjectSchema's own round-1408 cap) -- a completely
 * ordinary, expected result for that deterministic generator, not a
 * failure mode to guard against.
 */
export const GENERATED_SPEC_LABEL_MAX_LENGTH = 200;
export const GENERATED_SPEC_PHRASE_MAX_LENGTH = 500;
export const GENERATED_SPEC_SUMMARY_MAX_LENGTH = 2000;

export function findOversizedGeneratedSpecField(spec: ProductSpec): string | null {
  if (spec.summary.length > GENERATED_SPEC_SUMMARY_MAX_LENGTH) {
    return `summary (${spec.summary.length} characters, max ${GENERATED_SPEC_SUMMARY_MAX_LENGTH})`;
  }
  for (const [kind, phrases] of [
    ["role", spec.roles],
    ["persona", spec.personas],
    ["assumption", spec.assumptions],
  ] as const) {
    for (const phrase of phrases) {
      if (phrase.length > GENERATED_SPEC_PHRASE_MAX_LENGTH) {
        return `a ${kind} (${phrase.length} characters, max ${GENERATED_SPEC_PHRASE_MAX_LENGTH})`;
      }
    }
  }
  for (const q of spec.openQuestions) {
    if (q.question.length > GENERATED_SPEC_PHRASE_MAX_LENGTH) {
      return `an openQuestions question (${q.question.length} characters, max ${GENERATED_SPEC_PHRASE_MAX_LENGTH})`;
    }
    for (const option of q.options) {
      if (option.length > GENERATED_SPEC_PHRASE_MAX_LENGTH) {
        return `an openQuestions option (${option.length} characters, max ${GENERATED_SPEC_PHRASE_MAX_LENGTH})`;
      }
    }
    if (q.recommendation && q.recommendation.length > GENERATED_SPEC_PHRASE_MAX_LENGTH) {
      return `an openQuestions recommendation (${q.recommendation.length} characters, max ${GENERATED_SPEC_PHRASE_MAX_LENGTH})`;
    }
  }
  for (const entity of spec.entities) {
    if (entity.name.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
      return `entity name "${entity.name.slice(0, 40)}..." (${entity.name.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
    }
    if (entity.label && entity.label.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
      return `entity "${entity.name}"'s label (${entity.label.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
    }
    if (entity.description && entity.description.length > GENERATED_SPEC_PHRASE_MAX_LENGTH) {
      return `entity "${entity.name}"'s description (${entity.description.length} characters, max ${GENERATED_SPEC_PHRASE_MAX_LENGTH})`;
    }
    for (const field of entity.fields) {
      if (field.name.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
        return `a field name in entity "${entity.name}" (${field.name.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
      }
      if (field.label && field.label.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
        return `field "${field.name}"'s label in entity "${entity.name}" (${field.label.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
      }
      // Round 1448: relationTo (FieldSchema's own declaration above) is
      // plain z.string().optional() -- no .max() of its own, unlike every
      // other free-text field this function already guards -- so it's
      // just as exposed to the token-repetition failure mode this whole
      // function exists to catch. Capped at the identifier-like
      // GENERATED_SPEC_LABEL_MAX_LENGTH (it names another entity, the same
      // shape as field.name/entity.name above), not the longer phrase cap.
      if (field.relationTo && field.relationTo.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
        return `field "${field.name}"'s relationTo in entity "${entity.name}" (${field.relationTo.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
      }
      for (const value of field.enumValues ?? []) {
        if (value.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
          return `an enumValue on field "${field.name}" in entity "${entity.name}" (${value.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
        }
      }
      for (const value of Object.values(field.enumLabels ?? {})) {
        if (value.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
          return `an enumLabel on field "${field.name}" in entity "${entity.name}" (${value.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
        }
      }
      // Round 1602: enumLabels's KEY (FieldSchema's own declaration above,
      // z.record(z.string(), z.string().min(1))) has no .max() of its own --
      // only the value does -- so a key is just as exposed to the
      // token-repetition failure mode this whole function exists to catch,
      // and need not even match anything in this field's own (already
      // capped) enumValues array. Capped at the identifier-like
      // GENERATED_SPEC_LABEL_MAX_LENGTH, same as enumValues's own elements,
      // since a key IS a raw enum-value identifier, not a display phrase.
      for (const key of Object.keys(field.enumLabels ?? {})) {
        if (key.length > GENERATED_SPEC_LABEL_MAX_LENGTH) {
          return `an enumLabel key on field "${field.name}" in entity "${entity.name}" (${key.length} characters, max ${GENERATED_SPEC_LABEL_MAX_LENGTH})`;
        }
      }
    }
  }
  return null;
}

export const ProjectSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string(),
  spec: ProductSpecSchema,
  status: z.enum(["draft", "built"]),
  createdAt: z.string(),
  // Only present for a project the requesting user is a collaborator on
  // (not the owner): the project_collaborators row's own addedAt for that
  // specific grant (see listProjectsForUser). Lets the client distinguish
  // one share from the next -- a collaborator removed and later re-added
  // gets a fresh addedAt, so the home screen's "New share" chip
  // (sharedProjectSeen.ts) can tell that apart from a share already seen.
  sharedAt: z.string().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  createdAt: z.string(),
  // Round 1566: null until a real POST /auth/verify-email call consumes a
  // genuine token (or, on a deployment with no email provider configured,
  // immediately at signup -- there's no way to verify there at all). A
  // pre-existing account (created before this field existed) is backfilled
  // to its own createdAt at migration time, so it's never null either --
  // see users.ts's own ensureUsersTable doc comment.
  emailVerifiedAt: z.string().nullable(),
});

export type User = z.infer<typeof UserSchema>;

export const CheckpointSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  label: z.string(),
  /**
   * Set once, at creation, from the pipeline's own unambiguous knowledge of
   * whether this snapshot came from /build or /refine -- never re-derived
   * from `label` the way it used to be, since CheckpointLabelEditor lets a
   * user freely rename a checkpoint to arbitrary text (including text that
   * no longer starts with "Refine:"/"שיפור:", or that happens to start with
   * one by coincidence), which would otherwise silently reclassify it.
   */
  kind: z.enum(["build", "refine"]),
  spec: ProductSpecSchema,
  createdAt: z.string(),
  /**
   * Round 1567: closes docs/security.md's own named gap ("checkpoints
   * record *what* changed but not *who* triggered it"). Null for every
   * checkpoint written before this field existed -- there is no signal to
   * retroactively reconstruct it from, an honest limit, same as `kind`'s
   * own pre-migration backfill admits for its own (recoverable, unlike
   * this one) history. Resolving this id to a display email is the
   * caller's job (see routes/projects.ts's GET .../checkpoints, which
   * returns a sibling `collaboratorEmails` map rather than baking a
   * resolved email into this schema itself).
   */
  createdByUserId: z.string().nullable(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * "editor" has identical read/write access to the owner (the original,
 * still-default grant). "viewer" is read-only, enforced server-side by
 * requireProjectWriteAccess (apps/api/src/routes/projects.ts) -- not just a
 * hidden button. The owner is never one of these values: ownership is
 * project.ownerId, a separate concept entirely.
 */
export const CollaboratorRoleSchema = z.enum(["editor", "viewer"]);
export type CollaboratorRole = z.infer<typeof CollaboratorRoleSchema>;

/** A user (other than the owner) who's been granted access to a project — see packages/db/src/collaborators.ts. */
export const ProjectCollaboratorSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  addedAt: z.string(),
  role: CollaboratorRoleSchema,
});

export type ProjectCollaborator = z.infer<typeof ProjectCollaboratorSchema>;

/** A single generated record's data, keyed by field name. Values are JSON-safe. */
export type EntityRecord = Record<string, string | number | boolean | null>;

/**
 * One step emitted by the build/refine agent pipeline (see apps/api/src/pipeline.ts).
 * Each step reports genuinely verifiable work — a real migration, a real
 * smoke test, a real static check — not a scripted delay.
 */
export interface AgentStepEvent {
  agent: "Architect" | "Database" | "Debug" | "Seed Data" | "QA" | "Security" | "Forge";
  status: "running" | "success" | "failed";
  message: string;
  detail?: unknown;
}
