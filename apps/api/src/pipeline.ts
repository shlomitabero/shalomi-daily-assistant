import { randomUUID } from "node:crypto";
import type { AgentStepEvent, Entity, ProductSpec, Project } from "@forge/shared";
import {
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

const SENSITIVE_FIELD_HINTS = ["password", "secret", "apikey", "api_key", "token", "ssn", "creditcard"];

interface ImpactSummary {
  newEntityNames: string[];
  newEntities: { name: string; label: string }[];
  changedEntities: { name: string; label: string; newFieldNames: string[] }[];
}

function computeImpact(previousSpec: ProductSpec | undefined, nextSpec: ProductSpec): ImpactSummary {
  const previousEntities = new Map((previousSpec?.entities ?? []).map((e) => [e.name, e]));
  const newEntities: { name: string; label: string }[] = [];
  const changedEntities: { name: string; label: string; newFieldNames: string[] }[] = [];

  for (const entity of nextSpec.entities) {
    const prev = previousEntities.get(entity.name);
    if (!prev) {
      newEntities.push({ name: entity.name, label: entity.label ?? entity.name });
      continue;
    }
    const prevFieldNames = new Set(prev.fields.map((f) => f.name));
    const newFields = entity.fields.filter((f) => !prevFieldNames.has(f.name));
    if (newFields.length > 0) {
      changedEntities.push({
        name: entity.name,
        label: entity.label ?? entity.name,
        newFieldNames: newFields.map((f) => f.label ?? f.name),
      });
    }
  }
  return { newEntityNames: newEntities.map((e) => e.name), newEntities, changedEntities };
}

function runQaChecks(
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

    const requiredField = entity.fields.find((f) => f.required);
    if (requiredField) {
      try {
        insertRecord(db, projectId, entity, {});
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
    } else {
      checks.push("no required fields to validate");
    }
    results.push({ entity: entity.name, checks });
  }
  return { allPassed, results };
}

function runSecurityScan(projectId: string, spec: ProductSpec): { score: number; warnings: string[] } {
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
        SENSITIVE_FIELD_HINTS.some((hint) => lowerName.includes(hint))
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
  const { previousSpec, changeLabel } = options;
  let nextSpec = options.nextSpec;

  yield { agent: "Architect", status: "running", message: "Designing schema from the product spec…" };
  const impact = computeImpact(previousSpec, nextSpec);
  const architectMessage = previousSpec
    ? `Impact: +${impact.newEntityNames.length} new entities (${impact.newEntityNames.join(", ") || "none"}), ` +
      `${impact.changedEntities.length} existing entities gaining fields.`
    : `Designed ${nextSpec.entities.length} tables for ${nextSpec.roles.length} roles.`;
  yield { agent: "Architect", status: "success", message: architectMessage, detail: impact };

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
        message: "אין מפתח Claude API מוגדר, אז אין אפשרות לתיקון אוטומטי כרגע. זו השגיאה המדויקת שקרתה: " + dbError,
      };
      return;
    }

    yield { agent: "Debug", status: "running", message: "מנתח מה השתבש ומנסה למצוא תיקון…" };
    let fixedSpec: ProductSpec;
    try {
      fixedSpec = await requestSpecFix(nextSpec, dbError, { apiKey, model: process.env.ANTHROPIC_MODEL });
      changes = diffAndMigrate(db, project.id, previousSpec, fixedSpec);
    } catch (fixErr) {
      yield {
        agent: "Debug",
        status: "failed",
        message: "הניסיון לתקן אוטומטית נכשל: " + (fixErr as Error).message,
      };
      return;
    }
    nextSpec = fixedSpec;
    yield {
      agent: "Debug",
      status: "success",
      message: "נמצא תיקון אוטומטי לבעיה, וממשיכים בבנייה איתו.",
      detail: { correctedSpec: fixedSpec },
    };
  }
  yield {
    agent: "Database",
    status: "success",
    message: `${changes.length} schema change(s) applied (${changes.filter((c) => c.type === "new_table").length} new tables, ${changes.filter((c) => c.type === "new_column").length} new columns). Nothing was dropped.`,
    detail: changes,
  };

  yield { agent: "Seed Data", status: "running", message: "Generating sample records for new tables…" };
  const newEntityNames = new Set(changes.filter((c) => c.type === "new_table").map((c) => c.table));
  const entitiesToSeed = nextSpec.entities.filter((e) => newEntityNames.has(tableNameFor(project.id, e.name)));
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
