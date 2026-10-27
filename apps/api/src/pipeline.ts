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
  quoteIdentifier,
  tableNameFor,
  updateProjectSpec,
  ValidationError,
  type ForgeDatabase,
  type MigrationChange,
} from "@forge/db";
import { requestSpecFix } from "@forge/spec-engine";
import { deleteUploadedFile } from "./uploadPaths.js";

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

/**
 * Round 915: `EntityLabelEditor`/`FieldLabelEditor` (EntityPanel.tsx) let a
 * user rename an entity's or field's display label post-build -- but
 * SpecProvider.generate (both HeuristicSpecProvider and
 * AnthropicSpecProvider) has no `previousSpec` parameter at all, so it has
 * no way to know a label was ever customized. Every `/refine` call
 * regenerates the WHOLE spec from `combinedDescription` alone, and
 * `runBuildPipeline` persists that freshly generated spec wholesale via
 * `updateProjectSpec` with no reconciliation step anywhere -- so the very
 * next refine after a label rename (an entirely unrelated one, e.g. "add a
 * notes field") silently discarded the rename, with no hazard warning
 * (`describeImpactHazards` below only ever covers removed fields/tightened
 * rules, never a reverted label). Mirrors `diffAndMigrate`'s own
 * name-matching convention (packages/db/src/migrate.ts) -- an entity/field
 * that survives a refine under the same name keeps its own prior label
 * (and an enum field's own prior enumLabels), the same "additive, never
 * silently lose something the user already has" principle migrations
 * themselves already follow for the underlying schema. Mutates `nextSpec`
 * in place (the same convention `diffAndMigrate` itself follows for
 * `nextSpec.entities[].fields[].relationTo` normalization), since the
 * caller never reads the pre-mutation object again.
 *
 * Round 917's own survey caught a self-regression in the enumLabels half
 * of this, two rounds later: the original version copied the ENTIRE prior
 * enumLabels map verbatim, with no check that `field.type` was still
 * "enum" and no check that a given key still exists in the freshly
 * regenerated `field.enumValues`. Round 887 already named "a refine that
 * narrows/widens/renames an enum field's own options, without changing
 * the field's own name or type" as a recurring, everyday hazard class in
 * this codebase -- an entirely ordinary refine ("add a cancelled
 * status") hits it on every single call, with no manual label edit
 * needed first. The naive copy both (a) left a newly-added value (e.g.
 * "cancelled") with no label at all, discarding the label the fresh
 * generation had JUST correctly supplied for it, and (b) left a stale
 * label behind for a value the refine had just removed or renamed away.
 * Fixed by merging instead of overwriting: a value present in BOTH the
 * prior and the fresh enumValues keeps its own PRIOR label (consistent
 * with this function's own label-carrying half); a value that's new to
 * this refine keeps whatever label the fresh generation already gave it,
 * since there's no prior label to carry forward for it at all.
 */
export function carryForwardLabels(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): void {
  if (!previousSpec) return;
  const previousEntities = new Map(previousSpec.entities.map((e) => [e.name, e]));
  // Round 947: mirrors migrate.ts's own lowercased-fallback convention
  // (rounds 617-620) -- ProductSpecSchema's case-insensitive-duplicate
  // check only rejects a collision WITHIN one spec, so an ordinary refine
  // can genuinely regenerate an entity/field with only its letter case
  // changed (e.g. "email" -> "Email"), which migrate.ts's own hardening
  // already treats as the same physical column, not a drop+add. Without
  // this fallback, the exact-string lookup below missed that case-only
  // rename entirely, silently discarding any label/enumLabels customization
  // the user had set on that exact entity/field.
  const previousEntitiesByLowerName = new Map(previousSpec.entities.map((e) => [e.name.toLowerCase(), e]));
  for (const entity of nextSpec.entities) {
    const prevEntity = previousEntities.get(entity.name) ?? previousEntitiesByLowerName.get(entity.name.toLowerCase());
    if (!prevEntity) continue;
    if (prevEntity.label !== undefined) entity.label = prevEntity.label;
    const prevFields = new Map(prevEntity.fields.map((f) => [f.name, f]));
    const prevFieldsByLowerName = new Map(prevEntity.fields.map((f) => [f.name.toLowerCase(), f]));
    for (const field of entity.fields) {
      const prevField = prevFields.get(field.name) ?? prevFieldsByLowerName.get(field.name.toLowerCase());
      if (!prevField) continue;
      if (prevField.label !== undefined) field.label = prevField.label;
      if (field.type === "enum" && field.enumValues && prevField.enumLabels) {
        const merged: Record<string, string> = { ...field.enumLabels };
        for (const value of field.enumValues) {
          if (prevField.enumLabels[value] !== undefined) merged[value] = prevField.enumLabels[value];
        }
        field.enumLabels = merged;
      }
    }
  }
}

export function computeImpact(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): ImpactSummary {
  const previousEntities = new Map((previousSpec?.entities ?? []).map((e) => [e.name, e]));
  // Round 947: same lowercased-fallback convention as carryForwardLabels
  // just above (mirroring migrate.ts's own rounds 617-620 hardening) --
  // without it, a case-only entity/field rename (a genuine refine
  // artifact, not a real structural change) was reported as the SAME
  // entity/field being both newly added AND removed at once, which
  // describeImpactHazards below turns into a false, alarming "lost
  // field(s) -- data no longer reachable" warning streamed straight to
  // the user for a change that doesn't actually lose or gain anything.
  const previousEntitiesByLowerName = new Map((previousSpec?.entities ?? []).map((e) => [e.name.toLowerCase(), e]));
  const nextEntityNames = new Set(nextSpec.entities.map((e) => e.name));
  const nextEntityNamesLower = new Set(nextSpec.entities.map((e) => e.name.toLowerCase()));
  // Counted over every entity that exists on EITHER side of this refine
  // (deduped by name, mirroring the identical field-level domain choice
  // above), so a removed entity's label is checked against a surviving
  // same-labeled entity too, not just whichever of new/changed/removed
  // list it lands in.
  // Round 1065: keyed by LOWERCASE name (not exact name), mirroring
  // checkpointDiff.ts's own round-954 fix for this exact mechanism one
  // screen over. A case-only entity rename (e.g. "customer" ->
  // "Customer") is, per migrate.ts's own hardening, a true no-op -- and
  // carryForwardLabels (just above in this same pipeline, called before
  // this function) copies the old entity's label onto the renamed one
  // verbatim, so previousSpec's "customer" and nextSpec's "Customer" end
  // up sharing the identical label string. Keyed by exact name, both
  // survived as two separate map entries, so entityLabelOccurrences
  // wrongly counted the shared label twice and appended a false
  // "(Customer)" disambiguation suffix -- streamed straight into the
  // live build/refine progress UI -- to an entity that was never
  // actually ambiguous with anything.
  const allEntitiesByName = new Map<string, Entity>();
  for (const e of previousSpec?.entities ?? []) allEntitiesByName.set(e.name.toLowerCase(), e);
  for (const e of nextSpec.entities) allEntitiesByName.set(e.name.toLowerCase(), e);
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
    const prev = previousEntities.get(entity.name) ?? previousEntitiesByLowerName.get(entity.name.toLowerCase());
    if (!prev) {
      newEntities.push({ name: entity.name, label: entityDisplayLabel(entity, entityLabels) });
      continue;
    }
    const prevFieldsByName = new Map(prev.fields.map((f) => [f.name, f]));
    const prevFieldsByLowerName = new Map(prev.fields.map((f) => [f.name.toLowerCase(), f]));
    const nextFieldNames = new Set(entity.fields.map((f) => f.name));
    const nextFieldNamesLower = new Set(entity.fields.map((f) => f.name.toLowerCase()));
    const newFields = entity.fields.filter((f) => !prevFieldsByName.has(f.name) && !prevFieldsByLowerName.has(f.name.toLowerCase()));
    const removedFields = prev.fields.filter((f) => !nextFieldNames.has(f.name) && !nextFieldNamesLower.has(f.name.toLowerCase()));
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
      const prevField = prevFieldsByName.get(f.name) ?? prevFieldsByLowerName.get(f.name.toLowerCase());
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
    .filter((e) => !nextEntityNames.has(e.name) && !nextEntityNamesLower.has(e.name.toLowerCase()))
    .map((e) => ({ name: e.name, label: entityDisplayLabel(e, entityLabels) }));

  return {
    newEntityNames: newEntities.map((e) => e.name),
    newEntities,
    changedEntities,
    removedEntityNames: removedEntities.map((e) => e.name),
    removedEntities,
  };
}

/**
 * Just the "Warning: ..." clauses of architectEvent's own message below --
 * extracted so the checkpoint restore route (routes/projects.ts) can give
 * the identical "something is now unreachable/stricter" hazard detection
 * /build and /refine already give, even though a restore has no "Impact:
 * +N new entities..." headline of its own to attach them to (it isn't a
 * fresh design pass). Pure, over two ProductSpec objects exactly like
 * computeImpact itself -- the same previousSpec/nextSpec shape works
 * whether `nextSpec` came from a real regeneration or, as in a restore, is
 * simply an OLDER checkpoint's spec: restoring isn't guaranteed to be a
 * safe, monotonically-looser move the way the data-migration side of a
 * restore already is (migrations are additive-only, see migrate.ts) -- an
 * earlier checkpoint can easily be STRICTER on a field a user has since
 * relaxed, or simply missing an entity/field the user has been actively
 * using, with real data already in it.
 */
export function describeImpactHazards(previousSpec: ProductSpec, nextSpec: ProductSpec): string {
  const impact = computeImpact(previousSpec, nextSpec);
  // An entity that still exists can nonetheless lose one of its OWN fields
  // (same root cause as an entity disappearing outright, one level down).
  // computeImpact already computes this per entity
  // (changedEntities[].removedFieldNames) -- this just picks out which
  // entities need their own clause below.
  const entitiesWithRemovedFields = impact.changedEntities.filter((e) => e.removedFieldNames.length > 0);
  // Same sibling-attribute gap class as removedFieldNames above, but for a
  // field that keeps existing on both sides while becoming more restrictive
  // (now required, or an enum losing a value) -- a real change computeImpact
  // tracks but that otherwise had no warning at all.
  const entitiesWithTightenedFields = impact.changedEntities.filter((e) => e.tightenedFieldNames.length > 0);
  return (
    (impact.removedEntityNames.length > 0
      ? ` Warning: ${impact.removedEntityNames.length} entities are no longer in the spec (${impact.removedEntityNames.join(", ")}) -- their data is kept but is no longer reachable through the app.`
      : "") +
    (entitiesWithRemovedFields.length > 0
      ? ` Warning: ${entitiesWithRemovedFields.map((e) => `${e.label} lost field(s): ${e.removedFieldNames.join(", ")}`).join("; ")} -- their data is kept but is no longer reachable through the app.`
      : "") +
    (entitiesWithTightenedFields.length > 0
      ? ` Warning: ${entitiesWithTightenedFields.map((e) => `${e.label} now enforces stricter rules on: ${e.tightenedFieldNames.join(", ")}`).join("; ")} -- existing records are unaffected unless edited again.`
      : "")
  );
}

function architectEvent(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): AgentStepEvent {
  const impact = computeImpact(previousSpec, nextSpec);
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
      describeImpactHazards(previousSpec, nextSpec)
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
      // placeholder value is never submitted for real -- it only fills in
      // a SIBLING required field here, so testing that same file field
      // itself still correctly deletes it below and still gets rejected.
      // Round 908: coerceValue's "file" case now rejects any url that
      // isn't this server's own /api/uploads/<project>/<entity>/<filename>
      // shape, so the placeholder's url must match that shape too (an
      // empty string, as used before round 908, is now itself rejected).
      for (const f of entity.fields) {
        if (f.type === "file" && f.required)
          validRecord[f.name] = JSON.stringify({ url: "/api/uploads/qa-placeholder/qa-placeholder/placeholder.txt", name: "placeholder", size: 0, mimeType: "" });
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
  // Round 977: lets this pipeline's own migration step clean up a file
  // field's now-orphaned disk uploads when a refine retypes it away from
  // "file" -- see cleanupFileFieldsRetypedAway's own doc comment below.
  // /build never passes previousSpec at all, so diffAndMigrate's
  // type_changed detection (which this depends on) never fires there
  // regardless; harmless to pass this unconditionally anyway.
  uploadsDir: string;
  // Only /refine passes this (the generateSpec() call it made just before
  // starting this pipeline); /build has no such call (it builds whatever
  // spec the project already has), so this stays undefined there. Carried
  // on the very first event's own `detail` below rather than as a new event
  // shape, so every existing SSE consumer (which assumes every frame is an
  // AgentStepEvent) keeps working unchanged.
  providerName?: string;
}

/**
 * Round 977: diffAndMigrate's own type_changed detection (migrate.ts) is
 * deliberately additive-only -- it never touches a retyped field's
 * existing column DATA (see its own doc comment) -- but a field moving
 * AWAY from "file" leaves every record's old upload permanently
 * unreachable garbage, not just un-migrated: deleteReplacedFileFields
 * (routes/projects.ts), the only cleanup mechanism that exists for a
 * file-field upload, filters on the field's CURRENT type, so no future
 * PATCH/DELETE on that entity's records will ever clean these up either
 * once the field stops being "file".
 *
 * Reads each affected column's raw stored value directly via SQL, bypassing
 * the normal listRecords/coerceValue path -- that would try to interpret
 * the value as whatever NEW type the field became, not the original file
 * descriptor JSON that's still physically sitting in the column (migrate.ts
 * never ALTERs it; `sqlTypeFor` maps both "file" and "text" to the same
 * SQL TEXT, and nothing re-writes existing rows on a type change regardless
 * of the new type). `deleteUploadedFile`'s own JSON-shape check already
 * no-ops harmlessly on anything that isn't a real file descriptor (a value
 * written AFTER the retype, under the field's new type; NULL; etc.), so
 * this never needs to reason about which rows are "really" still a file
 * value versus already-reused for something else.
 */
export async function cleanupFileFieldsRetypedAway(db: ForgeDatabase, uploadsDir: string, projectId: string, changes: MigrationChange[]): Promise<void> {
  const columnsByEntity = new Map<string, string[]>();
  for (const change of changes) {
    if (change.type === "type_changed" && change.fromType === "file" && change.toType !== "file" && change.entityName && change.column) {
      if (!columnsByEntity.has(change.entityName)) columnsByEntity.set(change.entityName, []);
      columnsByEntity.get(change.entityName)!.push(change.column);
    }
  }
  for (const [entityName, columns] of columnsByEntity) {
    const table = tableNameFor(projectId, entityName);
    for (const column of columns) {
      const rows = db.prepare(`SELECT ${quoteIdentifier(column)} AS val FROM ${quoteIdentifier(table)}`).all() as { val: unknown }[];
      await Promise.all(rows.map((row) => deleteUploadedFile(uploadsDir, projectId, entityName, row.val)));
    }
  }
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
  // Preserves any entity/field label (and enum label) a user customized
  // post-build, which the freshly generated nextSpec otherwise silently
  // overwrites on every refine -- see carryForwardLabels's own doc
  // comment above. A no-op for a plain /build (previousSpec is undefined).
  carryForwardLabels(previousSpec, nextSpec);

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
      // requestSpecFix is itself a fresh AI call with no more knowledge of
      // a user's customized labels than generateSpec had -- carries them
      // forward again here, same as the initial nextSpec just above.
      carryForwardLabels(previousSpec, fixedSpec);
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
  // Round 977: once this migration has actually committed (the yield just
  // above), clean up any file-field upload the type_changed entries in
  // `changes` just made permanently unreachable -- see
  // cleanupFileFieldsRetypedAway's own doc comment.
  await cleanupFileFieldsRetypedAway(db, options.uploadsDir, project.id, changes);
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
    // Round 978: same structural-impossibility shape as unseedableFileField
    // just above, for a required relation field instead -- seedValueFor's
    // own required-relation guess (seed.ts) is a static "row 1", which this
    // loop's own per-record overwrite just below only corrects once the
    // target genuinely HAS a row to point at. orderForSeeding (seed.ts)
    // deliberately excludes a self-relation from its topological sort (its
    // own doc comment: "a same-entity (self) relation... is left exactly as
    // unaddressed"), and falls back to an unresolved append order for a
    // genuine cycle between two required relations -- in either case, this
    // entity can be reached here with its own required relation TARGET
    // still genuinely empty (checked live, right now, not just "was empty
    // when this whole seeding step started" -- an entity seeded earlier in
    // this very loop already has real rows by the time a later, correctly-
    // ordered dependent reaches this check). For a genuine cross-entity
    // cycle, that guess genuinely dangles -- every generated record fails
    // insertRecord's own FK constraint with zero explanation, piling up one
    // cryptic "FOREIGN KEY constraint failed" per record. For a
    // self-relation specifically, the guess can accidentally self-satisfy
    // on a completely fresh table (the new row's own just-assigned id
    // happens to be the same "1" being guessed) -- so it doesn't always
    // crash, but it does produce exactly the kind of unrealistic-looking
    // seed data ("this employee manages itself") this generator exists to
    // avoid everywhere else. Either way, skipping upfront with one clear,
    // actionable message is the same choice already made for the
    // identical "can't seed this yet" situation the file-field case above
    // handles.
    const unseedableRelationField = entity.fields.find((f) => {
      if (f.type !== "relation" || !f.required || !f.relationTo) return false;
      const target = entityByName.get(f.relationTo);
      return !!target && countRecords(db, project.id, target) === 0;
    });
    if (unseedableRelationField) {
      seedErrors.push(
        `${entity.name}: skipped seeding -- required relation field "${unseedableRelationField.label ?? unseedableRelationField.name}" has no real row to point at yet (likely a self-referencing or circular required relation); add its first record(s) by hand once the app is live.`,
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

  // Every other step above is deliberately wrapped so nothing can throw
  // past this point once headers are already sent (writeHead happened
  // long before this generator started -- see streamPipeline's own call
  // site): the Database step's try/catch+auto-fix-retry, Seed Data's
  // per-record try/catch, runQaChecks' own internal try/catches. This
  // finalize block does real DB writes too (a disk-full ephemeral-disk
  // write failure is exactly the kind of thing the Database step above
  // already treats as a real, expected failure mode, not hypothetical),
  // so it needs the identical guard -- without it, a thrown error here
  // propagates out of this generator with nowhere good to go: streamPipeline's
  // `for await` has no try/catch of its own, so it reaches Express's error
  // middleware (app.ts) *after* this response's headers were already
  // written, at which point calling res.status(500).json(...) there throws
  // its own synchronous ERR_HTTP_HEADERS_SENT instead of ever reaching the
  // client -- the browser just sees the SSE connection die with no real
  // error message, after having already watched every earlier step render
  // as a green "success", even though the build was never actually marked
  // built and no checkpoint was ever saved.
  try {
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
  } catch (err) {
    yield {
      agent: "Forge",
      status: "failed",
      message: "The build finished, but saving it failed: " + (err as Error).message,
    };
  }
}
