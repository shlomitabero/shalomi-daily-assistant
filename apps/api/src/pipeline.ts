import { randomUUID } from "node:crypto";
import type { AgentStepEvent, Entity, Field, ProductSpec, Project } from "@forge/shared";
import {
  countRecords,
  describeMigrationHazards,
  diffAndMigrate,
  generateSeedRecords,
  getProject,
  insertCheckpoint,
  insertRecord,
  listRecords,
  markProjectBuilt,
  orderForSeeding,
  tableNameFor,
  updateProjectSpec,
  ValidationError,
  type ForgeDatabase,
  type MigrationChange,
} from "@forge/db";
import { requestSpecFix } from "@forge/spec-engine";

const RESERVED_SQL_WORDS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "TABLE", "FROM", "WHERE", "ORDER",
  "GROUP", "BY", "JOIN", "INDEX", "KEY", "PRIMARY", "FOREIGN", "REFERENCES",
  "DEFAULT", "NULL", "NOT", "AND", "OR", "VALUES", "INTO", "CREATE", "DROP",
  "ALTER", "UNIQUE", "CHECK", "CONSTRAINT", "TRANSACTION", "COMMIT", "ROLLBACK",
]);

const SENSITIVE_FIELD_HINTS: (string | RegExp)[] = [
  "password",
  // Plain "secret" would also match "secretary"/"secretive" as a plain
  // substring (same collision class fixed in domainEntities.ts's keyword
  // matching). That fix used a \b-bounded regex against lowercased prose,
  // but field names are camelCase/snake_case identifiers, not prose --
  // lowercasing first erases the very capitalization that marks a fresh
  // word start (`\bsecret\b` would reject "secretKey" too). This regex
  // instead runs against the field's ORIGINAL, un-lowercased name: an
  // uppercase "Secret" is always a valid word start wherever it appears
  // ("mySecretKey", "apiSecret"), while a lowercase "secret" only counts at
  // the very start of the name or right after a non-letter separator
  // ("secret", "secret_key", "api_secret") -- and either form is rejected
  // when immediately followed by a lowercase letter, which is exactly what
  // rules out "secretary"/"secretive".
  /(?:(?<![a-zA-Z])secret|Secret)(?![a-z])/,
  "apikey",
  "api_key",
  // Plain "token" would also match "tokenizer"/"detokenize"/"retokenize" as
  // a plain substring (lowercased: "**token**izer", "de**token**ize") --
  // same collision class as "secret"/"secretary" just above, and "token" is
  // an ordinary English word rather than an acronym like "ssn" below, so
  // this mirrors the "secret" regex's shape exactly: original-case
  // lowercase "token" only counts at a word start or right after a
  // non-letter separator ("token", "token_value", "api_token"), an
  // uppercase "Token" is always a valid word start wherever it appears
  // ("authToken", "apiToken"), and either form is rejected when
  // immediately followed by a lowercase letter, which rules out
  // "tokenizer"/"detokenize"/"retokenize".
  /(?:(?<![a-zA-Z])token|Token)(?![a-z])/,
  // Plain "ssn" would also match "businessName"/"className" as a plain
  // substring (lowercased: "busine**ssn**ame", "cla**ssn**ame") -- same
  // collision class as "secret"/"secretary" just above. "ssn" is normally
  // kept all-uppercase as a standalone acronym within camelCase (ssn,
  // SSN, userSSN, ssn_number, ssnNumber), unlike "secret"/"Secret" which
  // is an ordinary word, so the boundary regex checks for lowercase "ssn"
  // at a word start or the acronym "SSN" anywhere, each not immediately
  // followed by a lowercase letter -- which is exactly what rules out the
  // mixed-case "ssN" inside "businessName"/"className".
  /(?:(?<![a-zA-Z])ssn|SSN)(?![a-z])/,
  "creditcard",
];

interface ImpactSummary {
  newEntityNames: string[];
  newEntities: { name: string; label: string }[];
  changedEntities: { name: string; label: string; newFieldNames: string[]; removedFieldNames: string[]; tightenedFieldNames: string[] }[];
  removedEntityNames: string[];
  removedEntities: { name: string; label: string }[];
}

/**
 * A refine instruction like "rename Customer to Client" or "remove deals
 * tracking, focus on invoices" regenerates the whole spec from plain prose
 * (AnthropicSpecProvider.generate only ever receives description text, never
 * the previous spec's structure) -- a very plausible way for the AI to
 * simply omit an entity/field from the next spec rather than literally
 * renaming it in place. Migrations are additive-only (see migrate.ts), so
 * nothing is actually destroyed -- but the moment this build finishes, that
 * entity/field becomes unreachable through the UI/API, and without this,
 * nothing in the live build stream ever said so: the Architect's own
 * message only ever reported what was newly ADDED. The only way to
 * discover a removal was to later open Time Machine and manually diff two
 * checkpoints with checkpointDiff.ts's own (separate, client-side)
 * removedEntities logic -- after the fact, not in the moment it happened.
 */
/**
 * A field's display label is never enforced unique (only its name is --
 * see entityFormatting.ts's/codegen.ts's/backup.ts's own identical
 * comment on this), so two fields on the same entity can legally share a
 * label via the Field Label editor (e.g. a "subtotal" and a "shipping"
 * field both labeled "Amount"). Below, computeImpact reports a REMOVED
 * field by its label alone -- without this, removing only one of two
 * same-labeled fields would claim that shared label is "no longer
 * reachable through the app" even though a different, still-live field
 * with the identical label is sitting right there in the UI: actively
 * wrong, not just ambiguous, in the one message meant to build trust that
 * nothing was silently lost. Mirrors (rather than imports, matching this
 * codebase's established per-surface convention) entityFormatting.ts's
 * identical fieldLabelOccurrences/fieldDisplayLabel pair.
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
 * The entity-level twin of fieldLabelOccurrences/fieldDisplayLabel above --
 * an entity's own display label is just as unenforced-unique as a field's
 * (entities.ts's PATCH /entities/:entityName/label route accepts any
 * non-empty string, with no collision check against sibling entities'
 * labels), so two different entities can legally share a label via the
 * Entity Label editor. Without this, computeImpact's own
 * "<label> lost field(s)"/"<label> now enforces stricter rules on"
 * warnings below -- and App.tsx's chat-history rendering of this same
 * `detail`, which reads this exact `label` field -- would be unable to
 * tell a reader which of two same-labeled entities actually changed,
 * one level up from the field-label gap round 641 already fixed in this
 * identical function.
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

function computeImpact(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): ImpactSummary {
  const previousEntities = new Map((previousSpec?.entities ?? []).map((e) => [e.name, e]));
  const nextEntityNames = new Set(nextSpec.entities.map((e) => e.name));
  // Counted over every entity that exists on EITHER side of this refine
  // (deduped by name, mirroring the identical field-level domain choice
  // above), so a removed entity's label is checked against a surviving
  // same-labeled entity too, not just whichever of new/changed/removed
  // list it lands in.
  const allEntitiesByName = new Map<string, Entity>();
  for (const e of previousSpec?.entities ?? []) allEntitiesByName.set(e.name, e);
  for (const e of nextSpec.entities) allEntitiesByName.set(e.name, e);
  const entityLabels = entityLabelOccurrences(Array.from(allEntitiesByName.values()));
  const newEntities: { name: string; label: string }[] = [];
  const changedEntities: {
    name: string;
    label: string;
    newFieldNames: string[];
    removedFieldNames: string[];
    tightenedFieldNames: string[];
  }[] = [];

  for (const entity of nextSpec.entities) {
    const prev = previousEntities.get(entity.name);
    if (!prev) {
      newEntities.push({ name: entity.name, label: entityDisplayLabel(entity, entityLabels) });
      continue;
    }
    const prevFieldsByName = new Map(prev.fields.map((f) => [f.name, f]));
    const nextFieldNames = new Set(entity.fields.map((f) => f.name));
    const newFields = entity.fields.filter((f) => !prevFieldsByName.has(f.name));
    const removedFields = prev.fields.filter((f) => !nextFieldNames.has(f.name));
    // A same-named field that keeps existing on both sides is invisible to
    // the new/removed check above, but can still tighten in a way that
    // matters: becoming required where it wasn't, or (for an enum) losing
    // a value existing records might already be storing. repository.ts's
    // own updateRecord comment explains why this doesn't retroactively
    // break anything by itself (only a field the caller actually supplies
    // gets re-validated against the entity's current definition) -- but
    // nothing told the user this constraint changed at all, unlike a field
    // being added/removed outright.
    const tightenedFields = entity.fields.filter((f) => {
      const prevField = prevFieldsByName.get(f.name);
      if (!prevField) return false;
      if (f.required && !prevField.required) return true;
      if (f.type === "enum" && prevField.type === "enum") {
        const nextValues = new Set(f.enumValues ?? []);
        return (prevField.enumValues ?? []).some((v) => !nextValues.has(v));
      }
      return false;
    });
    if (newFields.length > 0 || removedFields.length > 0 || tightenedFields.length > 0) {
      // Occurrences are counted over every field that exists on EITHER side
      // of this refine (deduped by name, next's definition winning for a
      // field present on both), not just whichever of new/removed/tightened
      // list a given field lands in -- otherwise a removed field's label
      // could still collide with a field that didn't change at all this
      // refine (the exact "Amount" subtotal/shipping scenario above) without
      // ever being counted as ambiguous.
      const allFieldsByName = new Map<string, Field>();
      for (const f of prev.fields) allFieldsByName.set(f.name, f);
      for (const f of entity.fields) allFieldsByName.set(f.name, f);
      const labelOccurrences = fieldLabelOccurrences(Array.from(allFieldsByName.values()));
      changedEntities.push({
        name: entity.name,
        label: entityDisplayLabel(entity, entityLabels),
        newFieldNames: newFields.map((f) => fieldDisplayLabel(f, labelOccurrences)),
        removedFieldNames: removedFields.map((f) => fieldDisplayLabel(f, labelOccurrences)),
        tightenedFieldNames: tightenedFields.map((f) => fieldDisplayLabel(f, labelOccurrences)),
      });
    }
  }

  const removedEntities = (previousSpec?.entities ?? [])
    .filter((e) => !nextEntityNames.has(e.name))
    .map((e) => ({ name: e.name, label: entityDisplayLabel(e, entityLabels) }));

  return {
    newEntityNames: newEntities.map((e) => e.name),
    newEntities,
    changedEntities,
    removedEntityNames: removedEntities.map((e) => e.name),
    removedEntities,
  };
}

function architectEvent(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): AgentStepEvent {
  const impact = computeImpact(previousSpec, nextSpec);
  // Mirrors the removedEntityNames warning below, one level down: an entity
  // that still exists can nonetheless lose one of its OWN fields on a
  // refine (same root cause -- the AI regenerates the whole spec from prose
  // with no access to the previous structure). computeImpact already
  // computes this per entity (changedEntities[].removedFieldNames), but
  // without this clause the message says "N existing entities gaining
  // fields" even when an entity only ever LOST a field and gained nothing,
  // which is actively misleading, not just incomplete.
  const entitiesWithRemovedFields = impact.changedEntities.filter((e) => e.removedFieldNames.length > 0);
  // Same sibling-attribute gap class as removedFieldNames above, but for a
  // field that keeps existing on both sides while becoming more restrictive
  // (now required, or an enum losing a value) -- a real, user-caused change
  // computeImpact now tracks but that otherwise had no warning at all.
  const entitiesWithTightenedFields = impact.changedEntities.filter((e) => e.tightenedFieldNames.length > 0);
  // changedEntities includes an entity for ANY of new/removed/tightened
  // fields (see computeImpact above), but the headline below only ever
  // talks about entities "gaining fields" -- using changedEntities.length
  // directly claimed an entity gained fields even when its only change was
  // a removal or a tightening, contradicting the warning clause(s) that
  // follow in the very same message for that exact entity.
  const entitiesWithNewFields = impact.changedEntities.filter((e) => e.newFieldNames.length > 0);
  const message = previousSpec
    ? `Impact: +${impact.newEntityNames.length} new entities (${impact.newEntityNames.join(", ") || "none"}), ` +
      `${entitiesWithNewFields.length} existing entities gaining fields.` +
      (impact.removedEntityNames.length > 0
        ? ` Warning: ${impact.removedEntityNames.length} entities are no longer in the spec (${impact.removedEntityNames.join(", ")}) -- their data is kept but is no longer reachable through the app.`
        : "") +
      (entitiesWithRemovedFields.length > 0
        ? ` Warning: ${entitiesWithRemovedFields.map((e) => `${e.label} lost field(s): ${e.removedFieldNames.join(", ")}`).join("; ")} -- their data is kept but is no longer reachable through the app.`
        : "") +
      (entitiesWithTightenedFields.length > 0
        ? ` Warning: ${entitiesWithTightenedFields.map((e) => `${e.label} now enforces stricter rules on: ${e.tightenedFieldNames.join(", ")}`).join("; ")} -- existing records are unaffected unless edited again.`
        : "")
    : `Designed ${nextSpec.entities.length} tables for ${nextSpec.roles.length} roles.`;
  return { agent: "Architect", status: "success", message, detail: impact };
}

export function runQaChecks(
  db: ForgeDatabase,
  projectId: string,
  spec: ProductSpec,
): { allPassed: boolean; results: { entity: string; checks: string[] }[] } {
  const results: { entity: string; checks: string[] }[] = [];
  let allPassed = true;

  for (const entity of spec.entities) {
    const checks: string[] = [];
    try {
      listRecords(db, projectId, entity);
      checks.push("list endpoint returns data without error");
    } catch (err) {
      allPassed = false;
      checks.push(`FAILED: list endpoint threw: ${(err as Error).message}`);
    }

    const requiredFields = entity.fields.filter((f) => f.required);
    if (requiredFields.length > 0) {
      // A record valid for every OTHER field, so omitting exactly the field
      // under test is the only thing that should make insertRecord reject
      // it -- reusing generateSeedRecords (the same generator that seeds a
      // freshly built app's own demo data) rather than {} means testing the
      // 2nd, 3rd, etc. required field no longer needs the 1st one to be
      // missing too, which is what let every required field past the first
      // go completely unchecked before this fix.
      const validRecord = generateSeedRecords(entity, 1)[0];
      // generateSeedRecords (seed.ts) always leaves a "file" field null --
      // correct for real seeding, but it breaks this exact function's own
      // "valid for every OTHER field" invariant whenever the entity has a
      // REQUIRED file field: insertRecord would reject validRecord itself,
      // before recordMissingThisField below ever deletes the field this
      // loop is actually testing, for the unrelated file field instead. A
      // placeholder value (coerceValue's own "file" case stores it as a
      // plain string with no shape validation at all, same as every other
      // unrecognized type) is never submitted for real -- it only fills in
      // a SIBLING required field here, so testing that same file field
      // itself still correctly deletes it below and still gets rejected.
      for (const f of entity.fields) {
        if (f.type === "file" && f.required) validRecord[f.name] = JSON.stringify({ url: "", name: "placeholder", size: 0, mimeType: "" });
      }
      for (const requiredField of requiredFields) {
        const recordMissingThisField = { ...validRecord };
        delete recordMissingThisField[requiredField.name];
        try {
          insertRecord(db, projectId, entity, recordMissingThisField);
          allPassed = false;
          checks.push(`FAILED: inserting without required "${requiredField.name}" was not rejected`);
        } catch (err) {
          // Confirms the rejection actually names requiredField itself --
          // not just that *some* ValidationError was thrown. Without this,
          // a sibling required field insertRecord rejects FIRST (coerceValue
          // processes fields in array order) would be silently credited as
          // "enforced for" requiredField even though requiredField's own
          // required-check was never actually exercised -- the exact
          // invariant the placeholder-fill above exists to prevent, kept
          // here as a second, self-verifying layer rather than relying
          // solely on validRecord always being correctly constructed.
          if (err instanceof ValidationError && (err as Error).message.includes(`"${requiredField.name}"`)) {
            checks.push(`required-field validation enforced for "${requiredField.name}"`);
          } else if (err instanceof ValidationError) {
            allPassed = false;
            checks.push(
              `FAILED: inserting without required "${requiredField.name}" was rejected, but for a different field (${(err as Error).message}) -- "${requiredField.name}"'s own required-check was never actually exercised`,
            );
          } else {
            allPassed = false;
            checks.push(`FAILED: unexpected error validating "${requiredField.name}": ${(err as Error).message}`);
          }
        }
      }
    } else {
      checks.push("no required fields to validate");
    }
    results.push({ entity: entity.name, checks });
  }
  return { allPassed, results };
}

export function runSecurityScan(projectId: string, spec: ProductSpec): { score: number; warnings: string[] } {
  const warnings: string[] = [];
  for (const entity of spec.entities) {
    if (RESERVED_SQL_WORDS.has(entity.name.toUpperCase())) {
      warnings.push(`Entity name "${entity.name}" is a reserved SQL word — works today because it's namespaced as ${tableNameFor(projectId, entity.name)}, but consider renaming it to avoid confusion.`);
    }
    for (const field of entity.fields) {
      if (RESERVED_SQL_WORDS.has(field.name.toUpperCase())) {
        warnings.push(`Field "${entity.name}.${field.name}" is a reserved SQL word.`);
      }
      const lowerName = field.name.toLowerCase();
      if (
        (field.type === "text" || field.type === "longtext") &&
        SENSITIVE_FIELD_HINTS.some((hint) =>
          typeof hint === "string" ? lowerName.includes(hint) : hint.test(field.name),
        )
      ) {
        warnings.push(`Field "${entity.name}.${field.name}" looks sensitive but is stored as plain text — do not put real secrets in it.`);
      }
    }
  }
  const score = Math.max(0, 100 - warnings.length * 10);
  return { score, warnings };
}

export interface PipelineOptions {
  previousSpec?: ProductSpec;
  nextSpec: ProductSpec;
  changeLabel: string;
  // Only /refine passes this (the generateSpec() call it made just before
  // starting this pipeline); /build has no such call (it builds whatever
  // spec the project already has), so this stays undefined there. Carried
  // on the very first event's own `detail` below rather than as a new event
  // shape, so every existing SSE consumer (which assumes every frame is an
  // AgentStepEvent) keeps working unchanged.
  providerName?: string;
}

/**
 * The build/refine agent pipeline. Every step does genuinely verifiable
 * work — a real migration, real seed inserts, a real smoke test, a real
 * static scan — and can genuinely fail with a real error. Nothing here is a
 * scripted delay standing in for work that didn't happen.
 */
export async function* runBuildPipeline(
  db: ForgeDatabase,
  project: Project,
  options: PipelineOptions,
): AsyncGenerator<AgentStepEvent> {
  const { previousSpec, changeLabel, providerName } = options;
  let nextSpec = options.nextSpec;

  yield {
    agent: "Architect",
    status: "running",
    message: "Designing schema from the product spec…",
    // Spread rather than `detail: providerName ? {...} : undefined` --
    // the latter would set an own `detail` key (value undefined) on every
    // /build event too, changing this object's own enumerable key set
    // even when there's no providerName to carry, which a strict
    // assert.deepEqual elsewhere could end up distinguishing from today's
    // shape.
    ...(providerName ? { detail: { providerName } } : {}),
  };
  yield architectEvent(previousSpec, nextSpec);

  yield { agent: "Database", status: "running", message: "Applying migration…" };
  let changes: MigrationChange[];
  try {
    changes = diffAndMigrate(db, project.id, previousSpec, nextSpec);
  } catch (err) {
    const dbError = (err as Error).message;
    yield { agent: "Database", status: "failed", message: dbError };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      yield {
        agent: "Debug",
        status: "failed",
        message: "No Claude API key is configured, so an automatic fix isn't available right now. The exact error was: " + dbError,
      };
      return;
    }

    yield { agent: "Debug", status: "running", message: "Analyzing what went wrong and looking for a fix…" };
    let fixedSpec: ProductSpec;
    try {
      fixedSpec = await requestSpecFix(nextSpec, dbError, { apiKey, model: process.env.ANTHROPIC_MODEL });
      changes = diffAndMigrate(db, project.id, previousSpec, fixedSpec);
    } catch (fixErr) {
      yield {
        agent: "Debug",
        status: "failed",
        message: "The automatic fix attempt failed: " + (fixErr as Error).message,
      };
      return;
    }
    nextSpec = fixedSpec;
    // The Architect event already streamed to the client reflected the
    // pre-fix spec -- requestSpecFix is free to rename/add/remove
    // entities and fields while resolving the error, so that detail can
    // now disagree with what's actually about to be built. Re-emitting it
    // for the corrected spec lets the UI (which keeps only the latest
    // event per agent) replace the stale one instead of leaving it
    // uncorrected.
    yield architectEvent(previousSpec, nextSpec);
    yield {
      agent: "Debug",
      status: "success",
      message: "Found an automatic fix for the issue, and continuing the build with it.",
      detail: { correctedSpec: fixedSpec },
    };
  }
  yield {
    agent: "Database",
    status: "success",
    message:
      `${changes.length} schema change(s) applied (${changes.filter((c) => c.type === "new_table").length} new tables, ${changes.filter((c) => c.type === "new_column").length} new columns). Nothing was dropped.` +
      describeMigrationHazards(changes),
    detail: changes,
  };
  // Round 610 recorded the whole nextSpec into the durable history ledger
  // right here, so a later step (QA) stopping the build/refine before any
  // checkpoint got inserted couldn't orphan a new entity's real table.
  // Round 611: that was still too late for an entity whose OWN migration
  // succeeded but a LATER entity in the same diffAndMigrate call then threw
  // (e.g. a sanitized-name collision) -- this call never even runs in that
  // case. diffAndMigrate itself now records each entity's name the moment
  // its own migration step commits, which covers this call's job too, so it
  // was removed rather than kept as a now-redundant duplicate.

  yield { agent: "Seed Data", status: "running", message: "Generating sample records for new tables…" };
  const newEntityNames = new Set(changes.filter((c) => c.type === "new_table").map((c) => c.table));
  // Also requires the table to actually be empty right now, not just
  // "new" per this diff: /projects/:id/build always calls this pipeline
  // with previousSpec undefined (there's no previous spec for an initial
  // build), so diffAndMigrate reports every entity as new_table on every
  // call -- including a retry of a build that already got partway through
  // seeding before a later step (QA) failed. Without this check, a retry
  // re-inserts a full duplicate round of sample rows into tables that
  // already have them.
  //
  // A new entity's required relation field can point at an EXISTING entity
  // that currently has zero rows (e.g. the user deleted all of its records
  // through the normal UI before this refine) -- seedValueFor's
  // required-relation guess (row id 1) then violates the FK constraint on
  // every single insert, since row 1 genuinely doesn't exist, permanently
  // failing to seed the new entity with no error ever shown to the user
  // (round 467). Walking the required-relation graph out from every new
  // entity -- following chains, tolerating cycles via the visited set --
  // finds every such currently-empty target so it gets reseeded too, even
  // though it isn't itself "new". Same countRecords===0 safety check as
  // above, so an existing entity that genuinely still has rows is never
  // touched.
  const entityByName = new Map(nextSpec.entities.map((e) => [e.name, e]));
  const mustAlsoSeed = new Set<string>();
  const newEntitiesList = nextSpec.entities.filter((e) => newEntityNames.has(tableNameFor(project.id, e.name)));
  const visited = new Set(newEntitiesList.map((e) => e.name));
  const frontier = [...newEntitiesList];
  while (frontier.length > 0) {
    const entity = frontier.shift()!;
    for (const field of entity.fields) {
      if (field.type !== "relation" || !field.required || !field.relationTo || visited.has(field.relationTo)) continue;
      const target = entityByName.get(field.relationTo);
      if (!target || countRecords(db, project.id, target) > 0) continue;
      visited.add(target.name);
      mustAlsoSeed.add(target.name);
      frontier.push(target);
    }
  }
  const entitiesToSeed = orderForSeeding(
    nextSpec.entities.filter(
      (e) =>
        (newEntityNames.has(tableNameFor(project.id, e.name)) || mustAlsoSeed.has(e.name)) &&
        countRecords(db, project.id, e) === 0,
    ),
  );
  let seededCount = 0;
  const seedErrors: string[] = [];
  for (const entity of entitiesToSeed) {
    // seedValueFor (seed.ts) deliberately leaves every "file" field null --
    // there's no real uploaded file to point a seeded record at. For an
    // OPTIONAL file field that's fine (the field is just left empty). For a
    // REQUIRED one, insertRecord's own coerceValue rejects every single
    // generated record for this entity with the exact same
    // `Field "X" is required` error, every time, for a structural reason
    // that retrying or seeding more records can never fix -- unlike
    // buildImportRecords (CSV import) and handleDuplicate/
    // handleBulkDuplicate, which already refuse upfront with one clear
    // reason for this exact "file field makes the operation structurally
    // impossible" case, this loop used to just attempt the doomed inserts
    // anyway, piling up one identical error per generated record instead of
    // explaining the real, unfixable-by-seeding cause once.
    const unseedableFileField = entity.fields.find((f) => f.type === "file" && f.required);
    if (unseedableFileField) {
      seedErrors.push(
        `${entity.name}: skipped seeding -- required file field "${unseedableFileField.label ?? unseedableFileField.name}" has no real uploaded file to point a sample record at; add its first record(s) by hand once the app is live.`,
      );
      continue;
    }
    for (const record of generateSeedRecords(entity)) {
      // generateSeedRecords's required-relation guess is a static "row 1",
      // which orderForSeeding above only gets right by assuming the target
      // table's very first row genuinely has id 1 -- true for a target
      // seeded fresh in this same batch, but false the moment that target
      // is an AUTOINCREMENT table that ever had (and lost) rows before: an
      // existing-but-emptied entity reseeded above lands on ids 3, 4, ...
      // (SQLite's AUTOINCREMENT keyword never reuses a deleted rowid), so
      // the guessed 1 is a dangling FK on every insert. Overwriting with
      // whichever real row the target actually has right now -- which by
      // this point in the loop always exists, since orderForSeeding placed
      // the target before its dependent -- fixes that without touching the
      // self-relation/cycle case, where no real row exists yet and the
      // guess is left exactly as fragile as before.
      for (const field of entity.fields) {
        if (field.type !== "relation" || !field.required || !field.relationTo) continue;
        const target = entityByName.get(field.relationTo);
        const existing = target ? listRecords(db, project.id, target) : [];
        if (existing.length > 0) record[field.name] = existing[0].id;
      }
      try {
        insertRecord(db, project.id, entity, record);
        seededCount += 1;
      } catch (err) {
        seedErrors.push(`${entity.name}: ${(err as Error).message}`);
      }
    }
  }
  if (seedErrors.length > 0) {
    yield {
      agent: "Seed Data",
      status: "failed",
      message: `Seeded ${seededCount} record(s), but ${seedErrors.length} failed.`,
      detail: seedErrors,
    };
  } else {
    yield {
      agent: "Seed Data",
      status: "success",
      message: entitiesToSeed.length > 0 ? `Seeded ${seededCount} sample record(s) across ${entitiesToSeed.length} new table(s).` : "No new tables to seed.",
      detail: { seededCount, entities: entitiesToSeed.map((e) => e.label ?? e.name) },
    };
  }

  yield { agent: "QA", status: "running", message: "Running smoke tests against the live schema…" };
  const qa = runQaChecks(db, project.id, nextSpec);
  if (!qa.allPassed) {
    yield {
      agent: "QA",
      status: "failed",
      message: "One or more smoke tests failed — stopping before publishing this build.",
      detail: qa.results,
    };
    return;
  }
  yield {
    agent: "QA",
    status: "success",
    message: `${qa.results.length}/${qa.results.length} entity checks passed.`,
    detail: qa.results,
  };

  yield { agent: "Security", status: "running", message: "Scanning the spec for common risks…" };
  const security = runSecurityScan(project.id, nextSpec);
  yield {
    agent: "Security",
    status: "success",
    message: `Security score ${security.score}/100${security.warnings.length > 0 ? ` — ${security.warnings.length} advisory warning(s).` : "."}`,
    detail: security.warnings,
  };

  updateProjectSpec(db, project.id, nextSpec);
  markProjectBuilt(db, project.id);
  // previousSpec is only ever set by the /refine route (undefined for
  // /build -- see routes/projects.ts's two streamPipeline call sites), so
  // it's already the one unambiguous, rename-proof signal for which kind
  // of checkpoint this is; see CheckpointSchema's own doc-comment for why
  // this can no longer be re-derived from `label` later.
  insertCheckpoint(db, {
    id: randomUUID(),
    projectId: project.id,
    label: changeLabel,
    kind: previousSpec ? "refine" : "build",
    spec: nextSpec,
  });
  const finalProject = getProject(db, project.id)!;

  yield {
    agent: "Forge",
    status: "success",
    message: "Build complete. Checkpoint saved to the Time Machine.",
    detail: { project: finalProject },
  };
}
