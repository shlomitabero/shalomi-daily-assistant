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
  });

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
  agent: "Architect" | "Database" | "Seed Data" | "QA" | "Security" | "Forge";
  status: "running" | "success" | "failed";
  message: string;
  detail?: unknown;
}
