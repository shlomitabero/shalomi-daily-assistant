import { randomUUID } from "node:crypto";
import type { AgentStepEvent, Entity, ProductSpec, Project } from "@forge/shared";
import {
  countRecords,
  diffAndMigrate,
  generateSeedRecords,
  getProject,
  insertCheckpoint,
  insertRecord,
  listRecords,
  markProjectBuilt,
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
  "token",
  "ssn",
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
function computeImpact(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): ImpactSummary {
  const previousEntities = new Map((previousSpec?.entities ?? []).map((e) => [e.name, e]));
  const nextEntityNames = new Set(nextSpec.entities.map((e) => e.name));
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
      newEntities.push({ name: entity.name, label: entity.label ?? entity.name });
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
      changedEntities.push({
        name: entity.name,
        label: entity.label ?? entity.name,
        newFieldNames: newFields.map((f) => f.label ?? f.name),
        removedFieldNames: removedFields.map((f) => f.label ?? f.name),
        tightenedFieldNames: tightenedFields.map((f) => f.label ?? f.name),
      });
    }
  }

  const removedEntities = (previousSpec?.entities ?? [])
    .filter((e) => !nextEntityNames.has(e.name))
    .map((e) => ({ name: e.name, label: e.label ?? e.name }));

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
  const message = previousSpec
    ? `Impact: +${impact.newEntityNames.length} new entities (${impact.newEntityNames.join(", ") || "none"}), ` +
      `${impact.changedEntities.length} existing entities gaining fields.` +
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
      for (const requiredField of requiredFields) {
        const recordMissingThisField = { ...validRecord };
        delete recordMissingThisField[requiredField.name];
        try {
          insertRecord(db, projectId, entity, recordMissingThisField);
          allPassed = false;
          checks.push(`FAILED: inserting without required "${requiredField.name}" was not rejected`);
        } catch (err) {
          if (err instanceof ValidationError) {
            checks.push(`required-field validation enforced for "${requiredField.name}"`);
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
  const typeChanges = changes.filter((c) => c.type === "type_changed");
  const relationTargetChanges = changes.filter((c) => c.type === "relation_target_changed");
  yield {
    agent: "Database",
    status: "success",
    message:
      `${changes.length} schema change(s) applied (${changes.filter((c) => c.type === "new_table").length} new tables, ${changes.filter((c) => c.type === "new_column").length} new columns). Nothing was dropped.` +
      (typeChanges.length > 0
        ? ` Note: ${typeChanges.map((c) => `${c.table}.${c.column} (${c.fromType} → ${c.toType})`).join(", ")} kept the original database column type — existing data was not converted.`
        : "") +
      (relationTargetChanges.length > 0
        ? ` Note: ${relationTargetChanges.map((c) => `${c.table}.${c.column} (${c.fromRelationTo} → ${c.toRelationTo})`).join(", ")} kept pointing at the original related table — existing data was not re-linked.`
        : ""),
    detail: changes,
  };

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
  const entitiesToSeed = nextSpec.entities.filter(
    (e) => newEntityNames.has(tableNameFor(project.id, e.name)) && countRecords(db, project.id, e) === 0,
  );
  let seededCount = 0;
  const seedErrors: string[] = [];
  for (const entity of entitiesToSeed) {
    for (const record of generateSeedRecords(entity)) {
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
  insertCheckpoint(db, { id: randomUUID(), projectId: project.id, label: changeLabel, spec: nextSpec });
  const finalProject = getProject(db, project.id)!;

  yield {
    agent: "Forge",
    status: "success",
    message: "Build complete. Checkpoint saved to the Time Machine.",
    detail: { project: finalProject },
  };
}
