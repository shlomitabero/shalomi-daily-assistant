import { z } from "zod";

export const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "boolean",
  "date",
  "enum",
  "relation",
] as const;

/**
 * Every generated table hardcodes these two columns as built-ins
 * (packages/db/src/migrate.ts for the live preview, apps/api/src/codegen.ts
 * for the exported standalone app) -- a field sharing either name, in any
 * casing, produces a duplicate-column `CREATE TABLE`, which throws
 * uncaught and crashes the whole exported app before it can even start
 * listening. Rejected here, at the one point every spec (heuristic, the
 * real Anthropic provider, and its own repair path in debug.ts) is
 * validated, so a bad name just falls back to the heuristic provider
 * (see generateSpec in spec-engine/src/index.ts) instead of reaching
 * either database layer at all.
 */
const RESERVED_FIELD_NAMES = new Set(["id", "createdat"]);

export const FieldSchema = z
  .object({
    name: z.string().min(1),
    /** Human-facing name shown in the UI (e.g. Hebrew). Falls back to `name` when absent. */
    label: z.string().optional(),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    enumValues: z.array(z.string()).optional(),
    /** Display text per raw enumValue (e.g. {"New": "חדש"}). The stored/API value is always the raw enumValue. */
    enumLabels: z.record(z.string(), z.string()).optional(),
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
    message: `Field name "${f.name}" collides with a built-in column every table already has (id/createdAt) -- choose a different name`,
  }));

export type Field = z.infer<typeof FieldSchema>;

export const EntitySchema = z.object({
  name: z.string().min(1),
  /** Human-facing name shown in the UI (e.g. Hebrew). Falls back to `name` when absent. */
  label: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(FieldSchema).min(1),
});

export type Entity = z.infer<typeof EntitySchema>;

export const ScreenSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["list", "form", "dashboard"]),
  entity: z.string().optional(),
});

export type Screen = z.infer<typeof ScreenSchema>;

export const OpenQuestionSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
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
 * break this schema on purpose.
 */
export const ProductSpecSchema = z.object({
  summary: z.string().min(1),
  personas: z.array(z.string()).default([]),
  roles: z.array(z.string()).min(1),
  entities: z.array(EntitySchema).min(1),
  screens: z.array(ScreenSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(OpenQuestionSchema).default([]),
});

export type ProductSpec = z.infer<typeof ProductSpecSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string(),
  spec: ProductSpecSchema,
  status: z.enum(["draft", "built"]),
  createdAt: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  createdAt: z.string(),
});

export type User = z.infer<typeof UserSchema>;

export const CheckpointSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  label: z.string(),
  spec: ProductSpecSchema,
  createdAt: z.string(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

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
