import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import type { Entity, EntityRecord, Field, Project, Screen } from "@forge/shared";
import { CollaboratorRoleSchema, FIELD_TYPES } from "@forge/shared";
import {
  getCheckpoint,
  getProject,
  insertProject,
  listCheckpoints,
  renameCheckpoint,
  deleteCheckpoint,
  listProjectsForUser,
  listOwnedProjectIds,
  listCollaboratedProjectIds,
  diffAndMigrate,
  describeMigrationHazards,
  updateProjectSpec,
  updateProjectName,
  updateProjectDescription,
  deleteProject,
  insertRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
  insertWhatsAppMessage,
  listWhatsAppMessages,
  clearWhatsAppMessages,
  deleteWhatsAppMessage,
  addCollaborator,
  removeCollaborator,
  isCollaborator,
  listCollaborators,
  getCollaboratorRole,
  updateCollaboratorRole,
  findUserByEmail,
  findUserById,
  countRecords,
  listAutomationRules,
  listAutomationRuns,
  getAutomationRun,
  getAutomationRule,
  insertAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  getOrCreateCalendarFeedToken,
  regenerateCalendarFeedToken,
  isValidDateString,
  NotFoundError,
  type ForgeDatabase,
  type AutomationTrigger,
  type AutomationToMode,
  type AutomationActionType,
} from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { enhancePrompt, generateSpec, isHebrewText, TEMPLATES } from "@forge/spec-engine";
import { formatValidationError, HttpError } from "../httpError.js";
import { requireAuth } from "../auth/middleware.js";
import { createRateLimiter } from "../auth/rateLimit.js";
import { carryForwardLabels, cleanupFileFieldsRetypedAway, describeImpactHazards, runBuildPipeline } from "../pipeline.js";
import { withIdempotency } from "../idempotency.js";
import { generateExportFiles } from "../codegen.js";
import { generateBackupZipEntries, parseColumnOrdersQueryParam } from "../backup.js";
import { buildZip } from "../zip.js";
import { computeBusinessTwin } from "../twin.js";
import { deleteUploadedFile, isPathInsideDir, UPLOADED_FILENAME } from "../uploadPaths.js";
import type { WhatsAppAttachment, WhatsAppWebManager } from "../whatsappWeb.js";
import { findMatchingRecord } from "../whatsapp.js";
import { fireRule, fireScheduledRule, hasTooManyConsecutiveFailuresToday, isAllowedWebhookUrl, runAutomationsForRecordChange } from "../automations.js";
import type { EmailSender } from "../email.js";

const CreateProjectSchema = z.object({
  // Round 919: every other free-text schema in this file that accepts a
  // user-typed string already trims first (RenameProjectSchema,
  // UpdateProjectDescriptionSchema, RenameEntityLabelSchema, etc. just
  // below) -- this one and EnhanceIdeaSchema's own `idea` were the two
  // left out, letting a whitespace-only value (length 1+, so it passes
  // `min(1)` unchanged) reach generateSpec/HeuristicSpecProvider.generate,
  // whose own "description must not be empty" guard throws a bare Error
  // neither this route nor errorMiddleware ever catches as anything but
  // a raw 500 -- confirmed live against the real running server.
  description: z.string().trim().min(1, "description is required"),
  name: z.string().optional(),
});

const FromTemplateSchema = z.object({
  templateId: z.string().min(1, "templateId is required"),
  lang: z.enum(["he", "en"]).optional(),
});

const EnhanceIdeaSchema = z.object({
  // Round 919: the identical gap CreateProjectSchema's own `description`
  // just above had -- a whitespace-only `idea` reaches
  // HeuristicPromptEnhancer.enhance's own "must not be empty" guard,
  // surfacing as a raw 500 instead of this schema's own clean 400.
  idea: z.string().trim().min(1, "idea is required"),
});

const RefineSchema = z.object({
  // Round 938: matches every sibling free-text schema in this file
  // (description/idea/name/label/role/assumption/persona above, round
  // 919's own idea fix) -- this one alone was missing .trim(), so a
  // stray leading/trailing space the client sent reached this route's
  // own permanent checkpoint changeLabel (`Refine: ${instruction}`)
  // verbatim, stored forever in the Time Machine history.
  instruction: z.string().trim().min(1, "instruction is required"),
});

/**
 * Round 776: `answers` used to be a flat `Record<string,string>` keyed by
 * the question's own text -- which works fine as long as every open
 * question's wording is unique, but ProductSpecSchema's own
 * OpenQuestionSchema carries no uniqueness constraint on `question` (unlike
 * entity names, which get a real `.refine()` a few lines below in
 * ProductSpecSchema), and the AI provider's system prompt gives the model
 * no reason to avoid asking two unrelated, identically-worded questions
 * (e.g. two different features each prompting "Should notifications be
 * sent via email or SMS?"). A JS object literally cannot hold two entries
 * under the same key, so two distinct answers for the same question text
 * were unrepresentable at the wire-format level even before this route's
 * own code ran -- the second answer always silently overwrote the first
 * in the request body itself. Array-of-pairs keeps every answer distinct
 * regardless of whether its question's wording collides with another's;
 * the client now pairs each answer with its own question's array index
 * (see App.tsx's own selectedAnswers comment) rather than by text.
 */
const AnswerQuestionsSchema = z.object({
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional().default([]),
  additionalRequest: z.string().optional(),
});

/**
 * Round 973: `attachment` references a file already uploaded via POST
 * .../integrations/whatsapp/attachments/upload (never a raw file in this
 * JSON body) -- the same descriptor shape {url, name, mimeType} every
 * other uploaded-file reference in this app already uses (a `file`-type
 * field's own stored value, minus `size`, which nothing here needs). The
 * send route itself re-validates `url` actually points at a real file
 * this project's own attachment upload created before ever resolving it
 * to a filesystem path -- see its own comment there.
 */
const WhatsAppSendSchema = z.object({
  to: z.string().min(1, "to is required"),
  message: z.string().min(1, "message is required"),
  attachment: z
    .object({
      url: z.string().min(1),
      name: z.string().min(1),
      mimeType: z.string().min(1),
    })
    .optional(),
});

/**
 * Only "send_whatsapp" exists today, modeled as a single-value enum
 * (rather than a bare string literal baked into the handler) so adding a
 * second action type later is an additive schema change, not a rewrite.
 */
const SCHEDULE_TIME_UTC_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHEDULE_DAYS_OF_WEEK_PATTERN = /^[0-6](,[0-6]){0,6}$/;

/**
 * Round 967: validates a schedule rule's own `scheduleTimezone` is a real
 * IANA zone name Node's own Intl implementation recognizes (e.g.
 * "Asia/Jerusalem"), rather than trusting an arbitrary client-supplied
 * string straight into isScheduledRuleDue's own Intl.DateTimeFormat call
 * (apps/api/src/automations.ts) -- an unrecognized zone throws there, not
 * silently misbehaves, so this is a real system-boundary validation, not
 * a defensive nicety for an unreachable case.
 */
function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
const ScheduleTimezoneSchema = z
  .string()
  .min(1)
  .refine(isValidIanaTimeZone, "scheduleTimezone must be a real IANA time zone name (e.g. \"Asia/Jerusalem\")");

const CreateAutomationRuleSchema = z
  .object({
    trigger: z.enum(["record_created", "field_equals", "schedule", "record_deleted"]),
    fieldName: z.string().min(1).optional(),
    fieldValue: z.string().min(1).optional(),
    scheduleTimeUtc: z.string().regex(SCHEDULE_TIME_UTC_PATTERN, "scheduleTimeUtc must be \"HH:MM\" in 24-hour UTC").optional(),
    scheduleDaysOfWeek: z
      .string()
      .regex(SCHEDULE_DAYS_OF_WEEK_PATTERN, "scheduleDaysOfWeek must be comma-separated day numbers 0-6")
      .optional(),
    scheduleTimezone: ScheduleTimezoneSchema.optional(),
    actionType: z.enum(["send_whatsapp", "webhook", "send_email"]),
    toMode: z.enum(["static", "field"]),
    toNumber: z.string().min(1).optional(),
    toField: z.string().min(1).optional(),
    webhookUrl: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
    toEmail: z.string().email("toEmail must be a valid email address").optional(),
    emailSubject: z.string().min(1).optional(),
    messageTemplate: z.string().min(1, "messageTemplate is required"),
  })
  .refine((data) => data.trigger !== "field_equals" || (!!data.fieldName && !!data.fieldValue), {
    message: "fieldName and fieldValue are required when trigger is field_equals",
    path: ["fieldName"],
  })
  .refine((data) => data.trigger !== "schedule" || !!data.scheduleTimeUtc, {
    message: "scheduleTimeUtc is required when trigger is schedule",
    path: ["scheduleTimeUtc"],
  })
  .refine((data) => data.trigger !== "schedule" || data.actionType === "webhook" || data.toMode === "static", {
    message: "a schedule rule has no triggering record to read a destination field from, so toMode must be static",
    path: ["toMode"],
  })
  .refine((data) => data.actionType !== "send_whatsapp" || data.toMode !== "static" || !!data.toNumber, {
    message: "toNumber is required when toMode is static",
    path: ["toNumber"],
  })
  .refine((data) => data.actionType !== "send_whatsapp" || data.toMode !== "field" || !!data.toField, {
    message: "toField is required when toMode is field",
    path: ["toField"],
  })
  .refine((data) => data.actionType !== "webhook" || !!data.webhookUrl, {
    message: "webhookUrl is required when actionType is webhook",
    path: ["webhookUrl"],
  })
  .refine((data) => data.actionType !== "webhook" || !data.webhookUrl || isAllowedWebhookUrl(data.webhookUrl), {
    message: "webhookUrl must be a real http(s) URL, and can't point at a local/private address",
    path: ["webhookUrl"],
  })
  .refine((data) => data.actionType !== "send_email" || data.toMode !== "static" || !!data.toEmail, {
    message: "toEmail is required when toMode is static",
    path: ["toEmail"],
  })
  .refine((data) => data.actionType !== "send_email" || data.toMode !== "field" || !!data.toField, {
    message: "toField is required when toMode is field",
    path: ["toField"],
  })
  .refine((data) => data.actionType !== "send_email" || !!data.emailSubject, {
    message: "emailSubject is required when actionType is send_email",
    path: ["emailSubject"],
  });

const UpdateAutomationRuleSchema = z.object({
  trigger: z.enum(["record_created", "field_equals", "schedule", "record_deleted"]).optional(),
  fieldName: z.string().min(1).nullable().optional(),
  fieldValue: z.string().min(1).nullable().optional(),
  scheduleTimeUtc: z.string().regex(SCHEDULE_TIME_UTC_PATTERN, "scheduleTimeUtc must be \"HH:MM\" in 24-hour UTC").nullable().optional(),
  scheduleDaysOfWeek: z
    .string()
    .regex(SCHEDULE_DAYS_OF_WEEK_PATTERN, "scheduleDaysOfWeek must be comma-separated day numbers 0-6")
    .nullable()
    .optional(),
  scheduleTimezone: ScheduleTimezoneSchema.nullable().optional(),
  actionType: z.enum(["send_whatsapp", "webhook", "send_email"]).optional(),
  toMode: z.enum(["static", "field"]).optional(),
  toNumber: z.string().min(1).nullable().optional(),
  toField: z.string().min(1).nullable().optional(),
  webhookUrl: z.string().min(1).nullable().optional(),
  webhookSecret: z.string().min(1).nullable().optional(),
  toEmail: z.string().email("toEmail must be a valid email address").nullable().optional(),
  emailSubject: z.string().min(1).nullable().optional(),
  messageTemplate: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

/**
 * The same three cross-field invariants CreateAutomationRuleSchema's own
 * .refine() chain enforces, as a plain function instead of a zod schema --
 * a PATCH only sends the fields it's actually changing (UpdateAutomation-
 * RuleSchema's own fields are all .optional()), so there's no single
 * static shape to run zod's .refine() against; the PATCH route instead
 * merges the patch onto the existing stored rule (the same `{ ...existing,
 * ...patch }` updateAutomationRule itself does) and validates THAT merged
 * result here. Without this, a PATCH could silently save an internally
 * inconsistent rule -- e.g. `{"toMode":"field"}` on a rule created with
 * toMode:"static" produces toMode:"field" with a still-null toField,
 * which can never resolve a destination and will keep recording a
 * "no destination configured" failure on every future fire.
 */
export function findAutomationRuleInvariantViolation(rule: {
  trigger: AutomationTrigger;
  fieldName: string | null;
  fieldValue: string | null;
  scheduleTimeUtc: string | null;
  actionType: AutomationActionType;
  toMode: AutomationToMode;
  toNumber: string | null;
  toField: string | null;
  webhookUrl: string | null;
  toEmail: string | null;
  emailSubject: string | null;
}): string | null {
  if (rule.trigger === "field_equals" && !(rule.fieldName && rule.fieldValue)) {
    return "fieldName and fieldValue are required when trigger is field_equals";
  }
  if (rule.trigger === "schedule" && !rule.scheduleTimeUtc) {
    return "scheduleTimeUtc is required when trigger is schedule";
  }
  if (rule.trigger === "schedule" && rule.actionType !== "webhook" && rule.toMode !== "static") {
    return "a schedule rule has no triggering record to read a destination field from, so toMode must be static";
  }
  if (rule.actionType === "webhook" && !rule.webhookUrl) {
    return "webhookUrl is required when actionType is webhook";
  }
  if (rule.actionType === "webhook" && rule.webhookUrl && !isAllowedWebhookUrl(rule.webhookUrl)) {
    return "webhookUrl must be a real http(s) URL, and can't point at a local/private address";
  }
  if (rule.actionType === "send_whatsapp" && rule.toMode === "static" && !rule.toNumber) {
    return "toNumber is required when toMode is static";
  }
  if (rule.actionType === "send_whatsapp" && rule.toMode === "field" && !rule.toField) {
    return "toField is required when toMode is field";
  }
  if (rule.actionType === "send_email" && rule.toMode === "static" && !rule.toEmail) {
    return "toEmail is required when toMode is static";
  }
  if (rule.actionType === "send_email" && rule.toMode === "field" && !rule.toField) {
    return "toField is required when toMode is field";
  }
  if (rule.actionType === "send_email" && !rule.emailSubject) {
    return "emailSubject is required when actionType is send_email";
  }
  return null;
}

const AddCollaboratorSchema = z.object({
  // Every stored account email is lowercased at signup (see auth.ts's
  // CredentialsSchema) so this lookup has to normalize the same way, or a
  // real, existing account becomes invisible to it the moment the typed
  // email's capitalization differs at all (mobile auto-capitalize, pasting
  // from a signature, "John.Doe@Company.com") -- findUserByEmail's `WHERE
  // email = ?` is a plain case-sensitive SQLite comparison.
  email: z.string().email("a valid email is required").transform((email) => email.toLowerCase()),
  // Optional and defaulted to "editor" so every existing caller (the web
  // UI before this round, any script/integration already using this
  // route) keeps behaving exactly as before -- full access, same as today.
  role: CollaboratorRoleSchema.default("editor"),
});

const UpdateCollaboratorRoleSchema = z.object({
  role: CollaboratorRoleSchema,
});

const RenameProjectSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
});

const UpdateProjectDescriptionSchema = z.object({
  description: z.string().trim().min(1, "description is required"),
});

const RenameEntityLabelSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const RenameCheckpointSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const RenameFieldLabelSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const SetFieldRequiredSchema = z.object({
  required: z.boolean(),
});

const AddRoleSchema = z.object({
  role: z.string().trim().min(1, "role is required"),
});

const AddAssumptionSchema = z.object({
  assumption: z.string().trim().min(1, "assumption is required"),
});

const AddPersonaSchema = z.object({
  persona: z.string().trim().min(1, "persona is required"),
});

const AddEntitySchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

/**
 * Only `label` was ever accepted here -- every field added from the spec
 * review screen was born as a plain optional text field, the single
 * weakest link in an otherwise fully correctable pre-build screen (every
 * other mistake -- a wrong entity/role/assumption/label -- has a real fix
 * path; a wrong field *type* or a missing `required` flag didn't, short of
 * delete-and-recreate-as-the-same-plain-text-field, i.e. no real fix at
 * all). `type`/`required`/`enumValues` are optional and default to
 * exactly today's behavior, so every existing caller that only ever sent
 * `label` keeps working unchanged. `relationTo` is checked against this
 * project's own real entity names in the route handler below (not here --
 * this schema alone has no access to the project), never accepted as
 * arbitrary free text the way the already-rejected ProductSpecSchema-level
 * relationTo refine (round 415) would have required guessing at: the
 * client UI only ever offers a dropdown of entities that already exist in
 * this project, so there's no "deliberate forward-reference placeholder
 * vs. typo" ambiguity to resolve here at all.
 */
const AddFieldSchema = z
  .object({
    label: z.string().trim().min(1, "label is required"),
    type: z.enum(FIELD_TYPES).default("text"),
    required: z.boolean().default(false),
    // Comma-separated in the request body (what the UI's own single text
    // input sends) rather than a JSON array, trimmed and with blanks
    // dropped -- mirrors how a user would naturally type "New, In
    // Progress, Done" without needing to know this becomes an array.
    enumValues: z
      .string()
      .optional()
      .transform((raw) => (raw ? raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0) : undefined)),
    relationTo: z.string().trim().optional(),
  })
  .refine((f) => f.type !== "enum" || (f.enumValues && f.enumValues.length > 0), {
    message: "an enum field needs at least one value",
  })
  .refine((f) => f.type !== "relation" || !!f.relationTo, {
    message: "a relation field needs a target entity",
  });

/**
 * The matching fix for an EXISTING field, the one correction AddFieldSchema
 * above didn't cover: switching a field's type after it was already
 * proposed (an AI/heuristic-mis-typed field could add a replacement of the
 * right type, but the wrong one stuck around, un-removable until it was
 * the entity's only field). Same shape and same two refines as
 * AddFieldSchema (no `label`/`required` here -- those already have their
 * own dedicated routes), and the same relationTo-against-real-entities
 * check happens in the route handler below, not here.
 */
const SetFieldTypeSchema = z
  .object({
    type: z.enum(FIELD_TYPES),
    enumValues: z
      .string()
      .optional()
      .transform((raw) => (raw ? raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0) : undefined)),
    relationTo: z.string().trim().optional(),
  })
  .refine((f) => f.type !== "enum" || (f.enumValues && f.enumValues.length > 0), {
    message: "an enum field needs at least one value",
  })
  .refine((f) => f.type !== "relation" || !!f.relationTo, {
    message: "a relation field needs a target entity",
  });

/** Exported for direct unit testing of the word-truncation and empty-input fallback below. */
export function deriveName(description: string): string {
  const words = description.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 0 ? words : "Untitled Project";
}

/**
 * A newly-added entity's `label` is free text a user typed (possibly
 * Hebrew, possibly punctuation-laden), but its `name` becomes a SQL table
 * name in both the live preview (packages/db/src/migrate.ts, per-project
 * prefixed) and the exported codegen app (apps/api/src/codegen.ts, used
 * directly), so it has to be a non-empty run of ASCII identifier
 * characters, matching every existing domain entity's own PascalCase
 * convention (see domainEntities.ts -- "Customer", "WorkOrder", etc.).
 * Splits on any non-alphanumeric run (so both "Loyalty Program" and
 * "loyalty-program" become "LoyaltyProgram"), title-cases each surviving
 * word, and joins them with nothing in between. A label with no ASCII
 * letters/digits at all (pure Hebrew, say) leaves nothing to join, so it
 * falls back to "Entity" rather than producing the empty string
 * EntitySchema's `name: z.string().min(1)` would reject.
 *
 * A numeral-led label ("2024 Sales", or bare "2024") joins to a name like
 * "2024Sales" that passes EntitySchema (no identifier-shape guard) and
 * builds fine in the live preview -- packages/db/src/identifiers.ts's
 * `tableNameFor` always prepends a permanent "entity_" prefix, so the real
 * SQL table name there never starts with a digit regardless of this
 * function's own output. But codegen.ts's exported-app generator uses
 * `entity.name` directly, with no such prefix, so `assertSafe`'s
 * leading-letter requirement throws the moment the user exports an
 * otherwise-healthy, already-built project (round 555; the round-549 fix
 * below for deriveFieldName covers column names the same way, but never
 * reaches this function). Prefixed with "Entity" the same way the "no
 * ASCII letters at all" case already falls back to "Entity".
 *
 * De-duplicates case-insensitively against the project's existing entity
 * names (SQLite's own case-insensitive identifier comparison -- see
 * ProductSpecSchema's own case-collision `.refine()` in @forge/shared) by
 * appending the first free numeric suffix, so two entities that would
 * otherwise both derive to "Payments" never collide into one shared table
 * instead of silently corrupting either entity's data.
 */
export function deriveEntityName(label: string, existingNames: string[]): string {
  const words = label
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const joined = words.join("") || "Entity";
  const base = /^[0-9]/.test(joined) ? `Entity${joined}` : joined;
  const existingLower = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!existingLower.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (existingLower.has(`${base}${suffix}`.toLowerCase())) suffix += 1;
  return `${base}${suffix}`;
}

/**
 * A newly-added field's `label` is free text (possibly Hebrew), but its
 * `name` becomes a real SQL column name in both the live preview
 * (packages/db/src/migrate.ts) and the exported codegen app
 * (apps/api/src/codegen.ts) -- the same ASCII-identifier requirement
 * deriveEntityName's own comment above explains, just camelCase (matching
 * every existing domain-library field's own convention -- see
 * domainEntities.ts's "customerName"/"courierId") instead of PascalCase.
 * Falls back to "field" for a label with no ASCII letters/digits at all,
 * the same as deriveEntityName falls back to "Entity". De-duplicates
 * case-insensitively against both the entity's existing field names and
 * the two column names every table already carries as a built-in (id,
 * createdAt -- see FieldSchema's own RESERVED_FIELD_NAMES check in
 * @forge/shared), appending the first free numeric suffix, so this can
 * never hand FieldSchema's own refine() a name it would reject.
 */
export function deriveFieldName(label: string, existingNames: string[]): string {
  const words = label
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()));
  const joined = words.join("") || "field";
  // packages/db/src/identifiers.ts's SAFE_IDENTIFIER requires a leading
  // letter -- a numeral-led label ("2024 Sales", or bare "2024") joins to a
  // name like "2024Sales" that passes FieldSchema (no identifier-shape
  // guard) but throws a raw "Unsafe column identifier" error from
  // assertSafeIdentifier the moment the project is actually built (round
  // 549). In the live preview, entity names get this same protection for
  // free from tableNameFor's permanent "entity_" prefix; fields have no
  // such prefix, so it's enforced here instead, the same way the "no ASCII
  // letters at all" case already falls back to "field". (deriveEntityName
  // above needs its own, separate version of this same guard for the
  // exported codegen app, which uses entity.name with no such prefix --
  // round 555.)
  const base = /^[0-9]/.test(joined) ? `field${joined[0].toUpperCase()}${joined.slice(1)}` : joined;
  const taken = new Set(["id", "createdat", ...existingNames.map((n) => n.toLowerCase())]);
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base}${suffix}`.toLowerCase())) suffix += 1;
  return `${base}${suffix}`;
}

/**
 * generateSpec's own screen-generation (heuristic.ts's buildScreens --
 * Dashboard + List + Form per entity, or templates.ts's screensFor --
 * Dashboard + List only) only ever runs once, at spec creation; the
 * pre-build add/remove-entity routes below mutated `entities` directly
 * while leaving `screens` completely untouched, so a manually-added entity
 * got zero screens (undercounting "N screens" in HistoryPanel.tsx/
 * checkpointDiff.ts, the spec's only two consumers of this field) and a
 * manually-removed entity left its own dangling screen entries behind,
 * naming an entity that no longer exists -- both baked permanently into
 * the initial-build checkpoint, since /build passes project.spec straight
 * through with no regeneration (round 553). Every screen a real generator
 * produces for a given entity already carries that entity's own name in
 * `screen.entity` (see both functions above), so instead of guessing which
 * of the two conventions (or an AI-generated project's own arbitrary
 * shape) this particular project uses, this mirrors whichever existing
 * entity's own screens come last in `entities` -- the most likely to
 * reflect the project's current real convention, including after a
 * refine. Falls back to a Dashboard-plus-List+Form-pair entity's own
 * List+Form pair (round 1031: every real generator -- heuristic.ts,
 * templates.ts, and now anthropic.ts -- normalizes to this exact shape,
 * so a List-only fallback here was the one place left still assuming
 * templates.ts's own now-fixed, pre-round-1028 minimal shape) when no
 * entity has any tagged screens at all.
 */
export function deriveScreensForNewEntity(newEntityName: string, existingEntities: Entity[], screens: Screen[]): Screen[] {
  for (let i = existingEntities.length - 1; i >= 0; i -= 1) {
    const templateName = existingEntities[i].name;
    const templateScreens = screens.filter((s) => s.entity === templateName);
    if (templateScreens.length === 0) continue;
    return templateScreens.map((s) => ({
      ...s,
      name: s.name.split(templateName).join(newEntityName),
      entity: newEntityName,
    }));
  }
  return [
    { name: `${newEntityName} List`, type: "list", entity: newEntityName },
    { name: `${newEntityName} Form`, type: "form", entity: newEntityName },
  ];
}

/**
 * The field_equals automation trigger must only fire when the matching
 * field actually transitioned value as part of THIS update -- see
 * matchesTrigger's own doc comment in automations.ts. The PATCH record
 * route used to pass `new Set(Object.keys(req.body))` as "changed
 * fields", trusting that the request body only contained touched fields.
 * EntityPanel's main edit form (and any future caller) submits every
 * field on every save, not a diff, so that made a field_equals rule
 * re-fire on every unrelated edit to a record that already matched --
 * e.g. a customer getting a duplicate "order delivered" WhatsApp message
 * every time an unrelated note on an already-delivered order was edited.
 * Comparing the pre- and post-update records gives the real transition
 * regardless of what the request body happened to include.
 */
export function computeChangedFields(
  entity: Entity,
  before: EntityRecord | undefined,
  after: EntityRecord,
): Set<string> {
  return new Set(entity.fields.map((f) => f.name).filter((name) => !before || before[name] !== after[name]));
}

function findEntity(project: Project, entityName: string): Entity {
  const entity = project.spec.entities.find((e) => e.name === entityName);
  if (!entity) {
    throw new HttpError(404, `Entity "${entityName}" is not part of this project's spec`, "ENTITY_NOT_FOUND");
  }
  return entity;
}

function findField(entity: Entity, fieldName: string) {
  const field = entity.fields.find((f) => f.name === fieldName);
  if (!field) {
    throw new HttpError(404, `Field "${fieldName}" is not part of entity "${entity.name}"`, "FIELD_NOT_FOUND");
  }
  return field;
}

// An automation rule's field_equals trigger stores fieldValue as a plain
// string and matchesTrigger (automations.ts) compares it with a byte-exact
// `String(actual) === rule.fieldValue` -- no normalization at all. For a
// boolean field, rowToRecord always yields a real JS boolean, so
// String(actual) is always exactly "true" or "false"; anything else typed
// into the free-text "Value" input (round 595's own finding: "yes", "1",
// "כן" are all natural things to type) can never match, leaving the rule
// permanently, silently dead -- no error, no indication anywhere. Same for
// an enum field whose typed value doesn't exactly match one of its
// enumValues. Round 607: same gap for a date field -- its only stored shape
// is a real "YYYY-MM-DD" (repository.ts's own coerceValue/isValidDateString
// already enforce this at insert time), but the live table only ever shows
// a date field in locale-formatted form (EntityPanel.tsx's toLocaleDateString),
// so that's the only value a real user has ever seen for it and the only
// one they'd type into this free-text box -- never the raw ISO shape.
// Rejecting here, at creation/update time, mirrors repository.ts's own
// coerceValue boolean/enum/date checks exactly (same error style) instead
// of letting a rule save successfully and never fire.
// Round 613: the identical gap for a number field -- matchesTrigger's
// String(actual) is whatever JS's own Number.prototype.toString() produces
// ("1000"), but the only form of that value a real user has ever seen is
// EntityPanel.tsx's locale-formatted one (entityFormatting.ts's
// formatNumberValue: (1000).toLocaleString() === "1,000"), the natural
// thing to type into this free-text box. Number(fieldValue)'s own string
// form is the one canonical shape that can ever match; anything else
// (grouping separators, trailing zeros, scientific notation) never will.
function validateAutomationFieldValue(field: Field, fieldValue: string): void {
  if (field.type === "boolean" && fieldValue !== "true" && fieldValue !== "false") {
    throw new HttpError(400, `Field "${field.name}" must be "true" or "false"`, "VALIDATION_ERROR");
  }
  if (field.type === "enum" && field.enumValues && !field.enumValues.includes(fieldValue)) {
    throw new HttpError(400, `Field "${field.name}" must be one of: ${field.enumValues.join(", ")}`, "VALIDATION_ERROR");
  }
  if (field.type === "date" && !isValidDateString(fieldValue)) {
    throw new HttpError(400, `Field "${field.name}" must be a date in YYYY-MM-DD format`, "VALIDATION_ERROR");
  }
  if (field.type === "number" && (!Number.isFinite(Number(fieldValue)) || String(Number(fieldValue)) !== fieldValue)) {
    throw new HttpError(400, `Field "${field.name}" must be a plain number matching how it's stored (e.g. "1000", not "1,000")`, "VALIDATION_ERROR");
  }
  // A relation field's rowToRecord value (repository.ts) is the raw related
  // record's id, same as a number field -- but no UI surface ever shows that
  // id (EntityPanel.tsx/codegen.ts always render relationDisplayLabel, the
  // related record's own label, in its place), so there is no "what the user
  // has seen" value to accidentally mistype here the way round 613's number
  // fix addresses -- any free-text fieldValue a real person types (most
  // plausibly the related record's own display label) can only ever match if
  // it happens to already be the bare id string. Same rejection shape as the
  // number branch above, since that is the one string form the stored id can
  // ever take.
  if (field.type === "relation" && (!Number.isInteger(Number(fieldValue)) || String(Number(fieldValue)) !== fieldValue || Number(fieldValue) < 0)) {
    throw new HttpError(400, `Field "${field.name}" must be the related record's id (a plain non-negative integer), not its display label`, "VALIDATION_ERROR");
  }
  // A file field's stored value (repository.ts's coerceValue default case)
  // is the raw JSON-encoded {url, name, size, mimeType} upload descriptor
  // -- never something a real person could type into the Value box (its
  // url/size are generated at upload time and unknowable in advance), so
  // matchesTrigger's own byte-exact `String(actual) === rule.fieldValue`
  // comparison can never succeed. Without this, the rule builder UI
  // (AutomationsPanel.tsx) still lets a file field be picked here with no
  // filter, and its Value box falls through to the same plain text input
  // every unrecognized field type gets -- saving successfully as a
  // permanently, silently dead rule, the exact failure shape rounds
  // 595/607/613 already closed for every other field type that can never
  // match.
  if (field.type === "file") {
    throw new HttpError(400, `Field "${field.name}" can't be used in a trigger condition -- a file field's stored value can never be typed in by hand`, "VALIDATION_ERROR");
  }
}

// A toMode:"field" rule's destination is `record[toField]`, sent as-is to
// WhatsAppWebManager.sendMessage (automations.ts's fireRule). The create/
// update routes only ever called findField(entity, toField) -- confirming
// the field exists, never that it could plausibly hold a phone number.
// fireRule's own `typeof to !== "string"` guard already catches number/
// boolean fields (both become a non-string JS value via rowToRecord), but
// date and enum fields are stored as plain strings (repository.ts's
// coerceValue) and sail straight through: a date value like "2024-01-15"
// strips to "20240115" (round 506/507's missing_country_code heuristic
// only catches exactly one leading zero, and this has none), reaching
// WhatsAppWebManager.sendMessage's real sock.sendMessage call with a
// nonsensical JID instead of being rejected at rule save time -- the
// same "reject at creation, don't rely on a runtime guard to notice"
// discipline round 595 already established for the trigger's own
// fieldValue.
function validateAutomationToField(field: Field): void {
  if (field.type !== "text" && field.type !== "longtext") {
    throw new HttpError(
      400,
      `Field "${field.name}" can't be used as a destination -- only a text field can hold a phone number or email address`,
      "VALIDATION_ERROR",
    );
  }
}

/**
 * `Number("abc")` is NaN, which SQLite's driver happily binds as a
 * parameter without throwing (verified empirically) -- so without this
 * check, a malformed :recordId in the URL silently falls through to
 * "Record NaN not found in X", a confusing 404 that leaks the raw
 * coercion result instead of clearly rejecting the bad input.
 */
function parseRecordId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `Invalid record id "${raw}"`, "VALIDATION_ERROR");
  }
  return Number(raw);
}

/** Same NaN-leak concern as parseRecordId above, for the roles/assumptions removal routes' :index param. */
function parseListIndex(raw: string, list: string[], notFoundCode: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) >= list.length) {
    throw new HttpError(404, `No item at index ${raw}`, notFoundCode);
  }
  return Number(raw);
}

/**
 * Unlike entities/fields (addressed by their own stable `name`, see the
 * routes below), roles and assumptions are plain strings with no identity
 * beyond their array position -- a role/assumption chip's :index is
 * whatever the client last rendered. Two of these requests can overlap (a
 * user clicking two different chips' remove/rename in quick succession,
 * each firing before the first one's response re-renders the list with
 * shifted indices), and since each handler below re-reads the current spec
 * fresh and applies its own :index synchronously with no await in between,
 * the second request's index can silently land on a different entry than
 * the one actually clicked once the first request's mutation has already
 * shifted the array -- removing/renaming the wrong role or assumption with
 * no error shown anywhere. `expect` carries the exact string value the
 * client had in hand when it captured that index, so a request whose
 * target already moved can be rejected instead of silently corrupting a
 * different entry. Optional only so that direct API callers (including
 * this repo's own existing tests) that don't send it keep working
 * unchanged -- this app's own web client (SpecListItemRemover.tsx) always
 * sends it.
 */
function assertIndexStillMatches(list: string[], index: number, expect: unknown, notFoundCode: string): void {
  if (typeof expect === "string" && list[index] !== expect) {
    throw new HttpError(409, "This item was already changed by another update -- refresh and try again", notFoundCode);
  }
}

/**
 * 404s (rather than 403s) on a project this user has no access to -- either
 * it doesn't exist, or it belongs to someone else and this user isn't a
 * collaborator on it -- to avoid leaking existence either way. A
 * collaborator gets identical access to the owner through every route that
 * calls this (see collaborators.ts's own module comment); only managing the
 * collaborator list itself is owner-only, via requireProjectOwner below.
 */
function requireProjectAccess(db: ForgeDatabase, id: string, userId: string): Project {
  const project = getProject(db, id);
  if (!project || (project.ownerId !== userId && !isCollaborator(db, id, userId))) {
    throw new HttpError(404, `Project "${id}" not found`, "PROJECT_NOT_FOUND");
  }
  return project;
}

/** Stricter than requireProjectAccess: for actions only the owner may take (inviting/removing a collaborator, changing a collaborator's role). */
function requireProjectOwner(db: ForgeDatabase, id: string, userId: string): Project {
  const project = getProject(db, id);
  if (!project || project.ownerId !== userId) {
    throw new HttpError(404, `Project "${id}" not found`, "PROJECT_NOT_FOUND");
  }
  return project;
}

/**
 * Stricter than requireProjectAccess but looser than requireProjectOwner:
 * for every route that actually mutates the project (as opposed to just
 * reading it). The owner always passes -- ownership isn't a role row, it's
 * project.ownerId. An "editor" collaborator passes too, exactly like every
 * route used to treat every collaborator before roles existed. Only a
 * "viewer" collaborator is turned back, and with a real 403 (not the 404
 * requireProjectAccess uses for "no access at all") -- they already know
 * the project exists, since they can read it; what's missing is write
 * access, not the project itself.
 */
function requireProjectWriteAccess(db: ForgeDatabase, id: string, userId: string): Project {
  const project = requireProjectAccess(db, id, userId);
  if (project.ownerId === userId) {
    return project;
  }
  if (getCollaboratorRole(db, id, userId) === "viewer") {
    throw new HttpError(403, "Viewers can view this project but can't make changes to it", "VIEWER_READ_ONLY");
  }
  return project;
}

/**
 * listCollaborators (collaborators.ts) only ever returns rows from the
 * project_collaborators join table -- the owner isn't in that table at
 * all (their access comes from project.ownerId directly), so a
 * collaborator opening the sharing panel could see every OTHER
 * collaborator but never the person who actually owns the project. This
 * is the missing other half: fetches the owner's own email so the two
 * collaborators routes below can return it alongside the collaborator
 * list. Falls back to null instead of throwing on the (should-never-
 * happen) case of an owner account that's since been deleted, so a
 * dangling reference doesn't 500 the whole panel.
 */
function getOwnerInfo(db: ForgeDatabase, project: Project): { userId: string; email: string } | null {
  const owner = findUserById(db, project.ownerId);
  return owner ? { userId: owner.id, email: owner.email } : null;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

async function streamPipeline(
  res: Response,
  db: ForgeDatabase,
  project: Project,
  opts: Parameters<typeof runBuildPipeline>[2],
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for await (const event of runBuildPipeline(db, project, opts)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

/** Keeps every uploaded file's extension bounded and free of path-traversal
 * characters a crafted original filename could otherwise smuggle through
 * (multer's own filename callback receives it completely unsanitized) --
 * the stored name is always `${randomUUID()}${this}`, never the original
 * filename itself, so this only has to be a safe suffix, not a safe name. */
function safeFileExtension(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/**
 * multer (via busboy) decodes a multipart part's `Content-Disposition:
 * filename="..."` header using a strict Latin-1 byte-for-byte mapping
 * unless a `defParamCharset` is explicitly configured (which this app's
 * own createUploadMiddleware never does) -- but every real browser
 * (Chrome/Firefox/Safari) sends a non-ASCII filename as its raw UTF-8
 * bytes, not RFC 5987 percent-encoding and not real Latin-1. The result:
 * `file.originalname` for a Hebrew filename like "קורות חיים.pdf" (an
 * entirely ordinary upload for this app's primary Hebrew-speaking user
 * base) arrives as mojibake -- each UTF-8 byte individually mis-mapped to
 * its own Latin-1 code point -- and that corrupted string then becomes
 * the file field's permanent, displayed `name` (table cell, CSV/backup
 * export, WhatsApp/webhook automation templates, Global Search), with no
 * way for the user to fix it short of re-uploading under an ASCII name.
 * Re-interpreting those same code points as UTF-8 bytes (the exact
 * inverse of the mis-decoding) recovers the original text. Gated to only
 * apply when every character is in the Latin-1 range (U+0000-U+00FF) --
 * a string busboy's own extended `filename*=UTF-8''...` RFC 5987 syntax
 * already decoded correctly (an actual real Unicode string) always has
 * at least one character outside that range, and must never be
 * reinterpreted a second time -- and when the result doesn't introduce
 * the U+FFFD replacement character, which would mean the bytes never
 * were valid UTF-8 in the first place (e.g. a genuine single-byte Latin-1
 * accented filename sent by some other, older client), in which case the
 * original is already correct and is returned unchanged.
 */
export function decodeMojibakeFilename(name: string): string {
  if (!/^[\u0000-ÿ]*$/.test(name)) return name;
  const reDecoded = Buffer.from(name, "latin1").toString("utf8");
  return reDecoded.includes("�") ? name : reDecoded;
}

/**
 * Every uploaded file for a project lives under uploadsDir/{projectId}/...
 * (see createUploadMiddleware's own destination callback below) -- a
 * project-scoped directory, so removing it wholesale on project deletion
 * is both correct and simple: no need to parse any individual record's
 * file-field value or know which fields were ever "file" type. Best-
 * effort: a project that never had a file field (the common case) has no
 * such directory at all, and recursive+force makes that -- along with any
 * other already-gone-for-whatever-reason case -- a silent no-op rather
 * than an error that would block the rest of deletion.
 */
export async function deleteProjectUploads(uploadsDir: string, projectId: string): Promise<void> {
  await rm(path.join(uploadsDir, projectId), { recursive: true, force: true }).catch(() => {});
}

// deleteUploadedFile (the per-record file-field cleanup -- replacing a
// file field's value, clearing it, or deleting the record it belongs to)
// moved to uploadPaths.ts in round 977, so pipeline.ts's own migration-
// cleanup step there can reuse it too, without that module and this one
// importing from each other in both directions. See uploadPaths.ts's own
// doc comment for its full history (rounds 674/848/849).

/**
 * Cleans up whichever `file`-type fields are about to stop being reachable
 * from this record -- every one of them when the record itself is gone
 * (`newRecord` null, from the DELETE route), or only the ones a PATCH
 * actually changed (comparing against `newRecord`, so an update that never
 * touches a given file field leaves its upload alone). Always deletes the
 * OLD value's file, never whatever the new one might be.
 */
async function deleteReplacedFileFields(
  uploadsDir: string,
  projectId: string,
  entity: Entity,
  oldRecord: EntityRecord,
  newRecord: EntityRecord | null,
): Promise<void> {
  await Promise.all(
    entity.fields
      .filter((f) => f.type === "file" && (!newRecord || oldRecord[f.name] !== newRecord[f.name]))
      .map((f) => deleteUploadedFile(uploadsDir, projectId, entity.name, oldRecord[f.name])),
  );
}

// EntitySchema's own `name` has no character-set restriction (round
// 844/845/846/847's own repeated finding) -- an AI-generated entity name
// isn't guaranteed to be a safe filesystem path segment the way a
// manually-added one is (deriveEntityName sanitizes that path only).
// migrate.ts's own tableNameFor SANITIZES an unsafe name for the SQL
// table it creates (replacing every non-alphanumeric character with "_"),
// rather than rejecting the build outright -- so a project with an entity
// literally named e.g. "../../../tmp/evil" still reaches status "built"
// successfully, with that exact unsafe string preserved verbatim in
// project.spec. The upload route's own destination directory (below) is
// built directly from entity.name: path.join(uploadsDir, projectId,
// entityName) resolves "../../../tmp/evil" clean outside uploadsDir
// entirely, and multer would then write the attacker's uploaded file (up
// to 10 MB) wherever that resolves to -- a server-side arbitrary-file-write
// primitive, limited only by OS file permissions. Confirmed reachable:
// encodeURIComponent (the client's own, round 552/847-established
// convention for sending such a name at all) keeps a "/" within one URL
// path segment, and Express decodes it back to a literal "/" in
// req.params.entityName before this route's own handlers ever run.
// isPathInsideDir (and, since round 918, UPLOADED_FILENAME) live in
// uploadPaths.ts (round 850), shared with automations.ts's own
// findTemplateFileAttachment -- the identical unguarded path.join shape
// reached a third way, via a WhatsApp automation's file attachment (a
// read+exfiltration primitive, not just a write/delete one).

/**
 * Round 973: the fixed subdirectory name manual WhatsApp send attachments
 * are stored under -- `createUploadMiddleware` below stores a record
 * file-field upload at `uploadsDir/<projectId>/<entityName>/<filename>`,
 * but a manual send has no entity/field to key off at all. A leading
 * underscore keeps this visually distinct from a real entity name in a
 * directory listing, though nothing actually depends on that: `entity.name`
 * has no character-set restriction (see uploadPaths.ts's own doc comment),
 * so a project could in principle have a real entity literally named this
 * -- at worst, that entity's own file-field uploads would land in the same
 * parent folder as this feature's attachments, which changes nothing about
 * access control (every stored file is still named with its own random
 * UUID and path-safety-checked by filename, not by which folder it's in).
 */
const WHATSAPP_ATTACHMENTS_DIRNAME = "_whatsapp-attachments";

function createUploadMiddleware(uploadsDir: string) {
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(uploadsDir, req.params.id, req.params.entityName);
      if (!isPathInsideDir(dir, uploadsDir)) {
        cb(new HttpError(400, `Entity "${req.params.entityName}" has a name that cannot be used as a storage path`, "UNSAFE_ENTITY_NAME"), dir);
        return;
      }
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        cb(err as Error, dir);
        return;
      }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}${safeFileExtension(file.originalname)}`);
    },
  });
  // 10 MB covers the real-world cases this is for (a resume, an ID photo, an
  // invoice scan) without letting one upload exhaust the ephemeral disk a
  // free-tier host like the current Render deployment gives this process
  // (see server.ts's own comment on dbPath/whatsappSessionsDir).
  return multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
}

/**
 * Round 973: the manual-send counterpart of createUploadMiddleware above,
 * for a WhatsApp attachment that isn't tied to any entity/field at all --
 * stores under the fixed WHATSAPP_ATTACHMENTS_DIRNAME subdirectory instead
 * of an entity name read from the URL, so there's no untrusted path
 * segment here needing createUploadMiddleware's own isPathInsideDir check.
 * Same 10 MB/one-file limit and random-UUID filename convention as every
 * other upload in this app.
 */
function createWhatsAppAttachmentUploadMiddleware(uploadsDir: string) {
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(uploadsDir, req.params.id, WHATSAPP_ATTACHMENTS_DIRNAME);
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        cb(err as Error, dir);
        return;
      }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}${safeFileExtension(file.originalname)}`);
    },
  });
  return multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
}

export function createProjectsRouter(
  db: ForgeDatabase,
  provider: SpecProvider | undefined,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  activePipelines: Set<string>,
  uploadsDir: string,
): Router {
  const router = Router();
  router.use(requireAuth(db));
  const upload = createUploadMiddleware(uploadsDir);
  const whatsappAttachmentUpload = createWhatsAppAttachmentUploadMiddleware(uploadsDir);

  /**
   * Round 858: unlike routes/auth.ts (signup/login/forgot-password/
   * login/verify-code, rounds 847-857), this router had NO volumetric
   * throttle at all on the routes that actually spend real, metered
   * Anthropic API cost -- /ideas/enhance, POST /projects, and
   * .../answers/.../refine each unconditionally call generateSpec/
   * enhancePrompt (packages/spec-engine) whenever ANTHROPIC_API_KEY is
   * configured, which it is for this app's own real deployment (the free
   * heuristic fallback only applies when no key is set at all). Every
   * route here already sits behind requireAuth (line above), but an
   * authenticated account looping any of these four calls has no limit
   * at all -- activePipelines (below) only blocks two overlapping
   * requests on the SAME project, never a tight sequential loop across
   * many. Round 807's own docs/security.md fix already named this exact
   * gap explicitly ("routes/projects.ts/app.ts never import
   * createRateLimiter at all, so POST /api/projects/.../refine genuinely
   * remain unprotected") but only corrected the documentation's claim
   * about it -- the code gap itself was never closed until now.
   *
   * One shared limiter (not one per route, unlike auth.ts): these four
   * routes are really one budget -- "how many real AI-generation calls
   * can this account trigger" -- not four independent concerns, so a
   * user alternating between them to dodge a per-route cap would still
   * be correctly caught by a single shared counter. Keyed by user id, not
   * IP, since every caller here is already authenticated and a shared
   * IP (an office, a NAT) must not collaterally throttle unrelated
   * accounts.
   *
   * Deliberately excludes /build: it reuses the spec POST /projects or
   * /answers already generated (`nextSpec: project.spec`) and only ever
   * makes its own extra AI call on the rare Debug Agent repair path
   * (streamPipeline's own single-shot requestSpecFix, triggered only by
   * a genuine migration failure) -- counting an ordinary build (zero
   * extra AI cost in the common case) against the same budget as an
   * actual spec generation would eat into a legitimate user's allowance
   * for no real cost reason.
   */
  const aiGenerationRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many AI generation requests. Please try again later.",
  });

  /**
   * Round 862: the WhatsApp integration's connect/disconnect/send routes
   * had no volumetric throttle at all, unlike the AI-generation routes
   * right above (round 858) and every unauthenticated auth route (rounds
   * 847-857). `send`'s own `to` is a free-form string (WhatsAppSendSchema
   * only checks it's non-empty, never that it matches an existing
   * record's phone number) sent through this project's own real, linked
   * WhatsApp account -- any owner or editor collaborator (requireProjectWriteAccess
   * grants both identical access) can script repeated calls to spam an
   * arbitrary third-party number, or just this project's own real
   * business number, with no server-side cap. whatsappWeb.ts's own
   * sendSpacingMs paces consecutive sends (avoiding a bursty shape
   * WhatsApp's own abuse detection flags) but never caps total volume --
   * at the default 1.2s spacing that's still ~3,000 sends/hour sustained,
   * exactly the kind of automated-behavior pattern this module's own
   * doc comments already disclose as a real ban risk for the connected
   * number, now with a lever any collaborator can pull deliberately or
   * by accident. connect/disconnect get the same shared limiter: each
   * opens or tears down a real Baileys socket, and a tight reconnect
   * loop is its own real resource/detection-risk pattern -- reusing one
   * limiter rather than three, since "how much can this account churn
   * this project's WhatsApp integration" is one budget, the same
   * shared-budget reasoning aiGenerationRateLimiter above already uses.
   * Never reached by an automation rule's own WhatsApp send
   * (automations.ts calls whatsapp.sendMessage directly, never through
   * this HTTP route at all), so a legitimate rule firing often is
   * unaffected.
   */
  const whatsappRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many WhatsApp requests. Please try again later.",
  });

  /**
   * Round 1052: POST .../collaborators had no volumetric throttle at all,
   * unlike every other route in this codebase that can reveal whether an
   * email belongs to a real account. routes/auth.ts's own forgot-password/
   * login/verify-code/reset-password rate limiters (rounds 847-894) exist
   * specifically to stop cheap, fast probing of exactly that question --
   * this route answers it even more directly: a distinct 404
   * ("COLLABORATOR_USER_NOT_FOUND") naming the probed email back verbatim
   * when no account exists, versus 201 success when one does. Any
   * signed-up user who owns one free project (signup and project creation
   * are both free; this route only requires requireProjectOwner, not any
   * paid/built state) could otherwise script thousands of email probes per
   * minute from a single account with zero server-side cap -- the
   * cheapest account-enumeration oracle in the app. Keyed by the inviting
   * user's own id, the same rationale changePasswordRateLimiter above
   * uses: the caller is already authenticated here (requireProjectOwner
   * ran first), so the realistic abuser is one account iterating emails,
   * not a shared IP that must not collaterally throttle unrelated users.
   */
  const inviteCollaboratorRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many collaborator invite attempts. Please try again later.",
  });

  /**
   * /build, /refine, and /answers each read `project.spec` once at the
   * start of the request, then spend real time (an AI/heuristic
   * spec-generation call, and for /build and /refine also a migration)
   * before writing it back via updateProjectSpec. Two such requests for
   * the *same* project running concurrently (e.g. a double-click, or two
   * open tabs) would each still be working from the spec that was current
   * when they started -- the one that finishes last overwrites
   * project.spec with its own result, silently discarding whatever
   * entities/fields the other one added (for /build and /refine, that
   * other request's migration already ran and the DB table exists,
   * additive-only, but nothing in the overwritten spec points at it any
   * more, so the API can no longer see or write to it; for /answers,
   * which never migrates, it's a plain lost update -- the answers just
   * vanish). Tracked in-memory rather than in the DB: this process is the
   * only writer of project.spec (a single Node process backs this whole
   * app -- see app.ts's own comment on `staticDir`), so there's nothing
   * this needs to survive a restart for.
   *
   * Round 535: constructed once in app.ts and passed in here (rather than
   * declared locally, as before) so routes/auth.ts's DELETE /auth/account
   * handler can guard its own per-project cleanup loop against the exact
   * same hazard -- a Set private to this router's own closure couldn't be
   * reached from another router module at all.
   */

  /**
   * The Prompt Architect Agent: takes a short, rough idea and rewrites it
   * into a fuller, more detailed prompt (same AI-or-heuristic provider seam
   * as generateSpec), without creating a project yet -- the client decides
   * whether to use the enhanced text.
   */
  router.post(
    "/ideas/enhance",
    aiGenerationRateLimiter,
    asyncRoute(async (req, res) => {
      const parsed = EnhanceIdeaSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { enhanced, providerName } = await enhancePrompt(parsed.data.idea);
      res.json({ enhanced, providerName });
    }),
  );

  /**
   * `X-Idempotency-Key` (apps/web/src/api.ts's createProject) is this
   * route's first consumer of the mechanism docs/wakeRetry-idempotency-
   * design.md (round 470) designed: a client-generated key reused across
   * fetchWithWakeRetry's own retries of the same createProject() call, so
   * a retry that lands after the first attempt already fully created a
   * project (a real AI call plus a new row) replays that same response
   * instead of creating a second, duplicate draft. A request with no key
   * (an older client, or the key being optional by design) behaves exactly
   * as before -- see withIdempotency's own doc comment.
   */
  router.post(
    "/projects",
    aiGenerationRateLimiter,
    asyncRoute(async (req, res) => {
      const parsed = CreateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { description, name } = parsed.data;
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects", async () => {
        const { spec, providerName } = await generateSpec(description, provider);
        const project = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name: name ?? deriveName(description),
          description,
          spec,
        });
        return { status: 201, body: { project, providerName } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * The Templates Gallery (Forge AI vision doc's "reusable templates" /
   * docs/roadmap.md's "Template/agent marketplace" backlog item): a fixed,
   * hand-authored catalog a client can browse before ever typing an idea.
   * Deliberately returns only display metadata, never each template's full
   * `spec` -- the client doesn't need it (picking a template goes straight
   * to POST /projects/from-template below, which resolves it server-side),
   * and there's no reason to hand a bigger payload than the gallery cards
   * actually render. `entityNames`/`entityNamesEn` are the one exception:
   * just each entity's own display label (no fields/types/required/relations),
   * cheap to derive since `spec`/`specEn` are already in memory, so a user
   * can see what a template actually builds before committing to it instead
   * of guessing from the one-line description alone.
   */
  router.get(
    "/templates",
    asyncRoute(async (_req, res) => {
      res.json({
        templates: TEMPLATES.map(({ id, icon, name, nameHe, description, descriptionHe, spec, specEn }) => ({
          id,
          icon,
          name,
          nameHe,
          description,
          descriptionHe,
          entityNames: spec.entities.map((e) => e.label),
          entityNamesEn: specEn.entities.map((e) => e.label),
        })),
      });
    }),
  );

  /**
   * One-click project creation from a Templates Gallery card -- the same
   * "insert a project from an already-fully-formed spec, no AI call"
   * precedent /projects/:id/clone already established, just sourcing the
   * spec from the static TEMPLATES catalog instead of an existing project.
   * `lang` picks which of the template's two display-text pairs becomes the
   * new project's name/description, AND which of its two specs (`spec` vs
   * `specEn`) becomes the project's entities -- both are real, human-authored
   * text/labels in their respective language, not a machine translation of
   * one, so an English-UI user gets a fully English generated app instead
   * of English chrome around Hebrew entity/field labels. This app is
   * Hebrew-first, so anything other than an explicit "en" falls back to the
   * Hebrew copy, matching /projects/:id/clone's own Hebrew-first suffix
   * choice just above.
   */
  router.post(
    "/projects/from-template",
    asyncRoute(async (req, res) => {
      const parsed = FromTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const template = TEMPLATES.find((t) => t.id === parsed.data.templateId);
      if (!template) {
        throw new HttpError(404, `No template "${parsed.data.templateId}"`, "TEMPLATE_NOT_FOUND");
      }
      const useEnglish = parsed.data.lang === "en";
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/from-template", async () => {
        const project = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name: useEnglish ? template.name : template.nameHe,
          description: useEnglish ? template.description : template.descriptionHe,
          spec: useEnglish ? template.specEn : template.spec,
        });
        return { status: 201, body: { project } };
      });
      res.status(status).json(body);
    }),
  );

  router.get(
    "/projects",
    asyncRoute(async (req, res) => {
      res.json({ projects: listProjectsForUser(db, req.userId!) });
    }),
  );

  /**
   * The robust complement to GET /projects above: that listing goes through
   * listProjectsForUser, which silently drops any project whose stored spec
   * no longer parses against today's ProductSpecSchema (a real, expected
   * case for an older project -- see tryRowToProject's own comment). A
   * caller that needs the actual, complete set of project ids this user can
   * reach -- not a user-facing listing of project details -- needs this
   * instead, the same reason DELETE /auth/account uses listOwnedProjectIds
   * rather than listProjectsForUser for its own deletion sweep. Registered
   * before /projects/:id so this literal path is never captured as an :id.
   */
  router.get(
    "/projects/mine-ids",
    asyncRoute(async (req, res) => {
      res.json({
        ownedProjectIds: listOwnedProjectIds(db, req.userId!),
        sharedProjectIds: listCollaboratedProjectIds(db, req.userId!),
      });
    }),
  );

  router.get(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      res.json({ project: requireProjectAccess(db, req.params.id, req.userId!) });
    }),
  );

  /**
   * Round 1006: hands the client the token it needs to build a live
   * calendar subscription ("Subscribe") URL -- see getOrCreateCalendarFeedToken's
   * own doc comment, and the public, unauthenticated feed route itself
   * (routes/calendar.ts). requireProjectAccess, not requireProjectWriteAccess:
   * a read-only viewer can already see every record this feed would ever
   * expose through the live app itself, so handing them the subscribe URL
   * too is no new exposure.
   */
  router.get(
    "/projects/:id/calendar-feed-token",
    asyncRoute(async (req, res) => {
      requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ token: getOrCreateCalendarFeedToken(db, req.params.id) });
    }),
  );

  /**
   * Round 1012: once any collaborator has fetched the token above and
   * subscribed in their own calendar app, there was no way to invalidate
   * it -- not even the owner could, since nothing anywhere ever
   * overwrote an already-set calendarFeedToken. A removed or demoted
   * collaborator (or anyone they'd forwarded the URL to) kept live,
   * unauthenticated read access to this feed forever, with no fix short
   * of deleting the whole project. requireProjectOwner, not
   * requireProjectAccess (unlike the GET route above): rotating the
   * token also breaks every OTHER collaborator's already-configured
   * subscription with no warning to them, so only the owner -- who
   * already decides who has access to the project at all -- can trigger
   * that tradeoff.
   */
  router.post(
    "/projects/:id/calendar-feed-token/regenerate",
    asyncRoute(async (req, res) => {
      requireProjectOwner(db, req.params.id, req.userId!);
      res.json({ token: regenerateCalendarFeedToken(db, req.params.id) });
    }),
  );

  /**
   * A project's name is otherwise only ever set once at creation
   * (deriveName's auto-derived first few words of the description), with
   * no way to fix it -- including the generic "(copy)" suffix a clone
   * starts with. requireProjectAccess (not requireProjectOwner): a
   * collaborator has the exact same full read/write access as the owner
   * everywhere else, and a project's display name is no different.
   */
  router.patch(
    "/projects/:id/name",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = RenameProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const updated = updateProjectName(db, project.id, parsed.data.name);
      res.json({ project: updated });
    }),
  );

  /**
   * A project's description -- the free text typed on the home screen --
   * was otherwise set exactly once, at creation, with no way to ever fix
   * it, unlike the name route right above. That's a real gap: the
   * description isn't just cosmetic display text, it's silently re-sent as
   * context on every future /refine and /answers call (see this file's own
   * `combinedDescription` construction in both of those routes), so a typo
   * or wrong requirement in the original description keeps compounding
   * into every future AI call, with no way to correct it short of starting
   * over. requireProjectAccess (not requireProjectOwner), matching every
   * other spec-review-screen edit a collaborator can already make. No
   * activePipelines guard needed: unlike the 12 routes round 380 added one
   * to, this never reads-then-writes project.spec -- the description
   * column is never touched anywhere else in the app after insertProject,
   * so there is no read-modify-write race for it to lose.
   */
  router.patch(
    "/projects/:id/description",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = UpdateProjectDescriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const updated = updateProjectDescription(db, project.id, parsed.data.description);
      res.json({ project: updated });
    }),
  );

  /**
   * Clones a project's spec (and description) into a brand-new project
   * owned by whoever asked -- the owner, or a collaborator making their
   * own personal starting point from a shared one. Deliberately does NOT
   * copy the source project's actual data (real customer records, etc.):
   * the clone always starts as a fresh "draft", exactly like a newly
   * described idea, so the requester chooses when (and whether) to build
   * it and get its own freshly generated seed data -- never someone
   * else's real business data landing in a new project without them
   * asking for that specifically. requireProjectAccess (not
   * requireProjectOwner) since reading a project you have access to and
   * making your own personal copy of its blueprint doesn't touch the
   * original at all.
   */
  router.post(
    "/projects/:id/clone",
    asyncRoute(async (req, res) => {
      const source = requireProjectAccess(db, req.params.id, req.userId!);
      const suffix = isHebrewText(source.description) ? " (עותק)" : " (copy)";
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${source.id}/clone`, async () => {
        const cloned = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name: `${source.name}${suffix}`,
          description: source.description,
          spec: source.spec,
        });
        return { status: 201, body: { project: cloned } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * Permanently deletes a project -- requireProjectOwner, not
   * requireProjectAccess: unlike renaming or cloning, this affects every
   * collaborator's access too (nobody can even see this project's data
   * again), so it's deliberately not something a collaborator can do to
   * someone else's project on their own initiative. Tears down any *live*
   * WhatsApp Web socket first (that in-memory state lives in this process,
   * outside packages/db's reach -- see WhatsAppWebManager's own comment),
   * then deleteProject (packages/db) does the rest: drops the project's
   * real generated data tables, checkpoints, collaborator grants, and
   * WhatsApp connection/message history. Irreversible -- the client is
   * expected to confirm with the user before calling this.
   *
   * The activePipelines check below is the same guard /build, /refine,
   * /answers, and restore already have, for a reason specific to THIS
   * route: a running pipeline (runBuildPipeline, pipeline.ts) keeps
   * creating entity tables (diffAndMigrate) and inserting seed rows
   * entirely independently of this request, by project id, with no way
   * to cancel it mid-flight. Deleting the project out from under it
   * doesn't stop it -- deleteProject drops the project row and every
   * table it currently knows about, but the in-flight pipeline's own
   * later diffAndMigrate/insertRecord/updateProjectSpec calls just keep
   * running against that same (now-gone) project id: at best they throw
   * once updateProjectSpec can't find the row anymore (after the response
   * headers for that pipeline's own SSE stream were already sent, so the
   * client just sees the stream die with no error), and at worst any
   * entity table diffAndMigrate re-creates *after* this delete runs is a
   * permanently orphaned SQLite table with no project row ever pointing
   * at it again -- a real disk-space leak nothing else in this app ever
   * cleans up.
   *
   * This route itself now also *adds* to activePipelines (not just checks
   * it) for the duration of its own async work, below -- the reverse
   * direction of the same hazard: whatsapp.disconnect() is a genuine await
   * (a real network round-trip when a WhatsApp Web socket is connected),
   * and every ordinary quick mutation route in this file only checks
   * activePipelines, never sets it. Without this, such a route could read
   * the still-present project row during that window, run its whole
   * update to completion, and return 200 for a change that deleteProject()
   * erases moments later with no error ever reaching that caller.
   */
  /**
   * Round 945: same withIdempotency() extension, and the same reason, as
   * deleteRecord's/deleteCheckpoint's own fix (rounds 792/944) -- this is
   * the single most destructive route in the app (an irreversible,
   * cascading whole-project delete), yet it was the one real-effect
   * mutation route with zero idempotency coverage. fetchWithWakeRetry
   * retries any thrown fetch() error, so a response lost in transit after
   * the project was already deleted meant the retry's own
   * requireProjectOwner found no such row and threw a plain 404 for a
   * delete that, from the user's own point of view, already fully
   * succeeded -- App.tsx's handleDeleteProject treats that 404 as a
   * genuine failure (its success-path cleanup, including removing the
   * project from the visible list, never runs), leaving the UI showing an
   * already-gone project as if the delete had failed.
   *
   * Unlike entities/fields/checkpoints (identified by a name/id that
   * stays meaningful even after the retry-sensitive "not found" check),
   * the resource this route's own 404 depends on (the project itself) is
   * also the one requireProjectOwner needs to look up to authorize the
   * request at all -- so requireProjectOwner itself has to move INSIDE
   * the withIdempotency callback (a genuine retry never reaches it; the
   * wrap short-circuits first), and the idempotency route key is built
   * from req.params.id directly rather than project.id, since no `project`
   * exists yet at that point.
   */
  router.delete(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(db, idempotencyKey, req.userId!, `DELETE /projects/${req.params.id}`, async () => {
        const project = requireProjectOwner(db, req.params.id, req.userId!);
        if (activePipelines.has(project.id)) {
          throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
        }
        // This route has its own genuine await (whatsapp.disconnect() -> a
        // real network round-trip to the WhatsApp Web socket, when one is
        // connected) before deleteProject() actually runs -- the same kind
        // of gap /build/refine/answers/restore already guard against via
        // activePipelines, just on this route's own side instead of a
        // pipeline's. Without marking this project id busy for that window,
        // any ordinary quick mutation route (add a role, rename, add an
        // entity, ...) that only *checks* activePipelines -- never sets it
        // itself -- can read the still-present project row, run its entire
        // update to completion, and return 200 with what looks like a
        // persisted change, moments before deleteProject() below erases the
        // row (and that "persisted" change) out from under it with no error
        // ever surfacing to that caller.
        activePipelines.add(project.id);
        try {
          await whatsapp.disconnect(project.id).catch(() => {});
          deleteProject(db, project.id);
          await deleteProjectUploads(uploadsDir, project.id);
        } finally {
          activePipelines.delete(project.id);
        }
        return { status: 204, body: null };
      });
      res.status(status).end();
    }),
  );

  /**
   * Project sharing (see collaborators.ts's own module comment): the owner
   * or any current collaborator can see who has access; only the owner can
   * change who does. Listed by requireProjectAccess first so a collaborator
   * gets the same 404-not-403 existence-hiding treatment as every other
   * route if they've lost access since their last page load.
   */
  router.get(
    "/projects/:id/collaborators",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) });
    }),
  );

  router.post(
    "/projects/:id/collaborators",
    inviteCollaboratorRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectOwner(db, req.params.id, req.userId!);
      const parsed = AddCollaboratorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const invited = findUserByEmail(db, parsed.data.email);
      if (!invited) {
        throw new HttpError(404, `No account found for "${parsed.data.email}"`, "COLLABORATOR_USER_NOT_FOUND");
      }
      if (invited.id === project.ownerId) {
        throw new HttpError(400, "The project owner already has full access", "CANNOT_ADD_OWNER_AS_COLLABORATOR");
      }
      addCollaborator(db, project.id, invited.id, parsed.data.role);
      res.status(201).json({ collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) });
    }),
  );

  /**
   * Owner-only, like inviting itself: changes an existing collaborator's
   * role between "editor" (full read/write) and "viewer" (read-only,
   * enforced by requireProjectWriteAccess on every mutating route). Does
   * NOT let the owner target their own id -- ownership isn't a role row at
   * all, so there is no "role" of the owner's to change.
   */
  router.patch(
    "/projects/:id/collaborators/:userId/role",
    asyncRoute(async (req, res) => {
      const project = requireProjectOwner(db, req.params.id, req.userId!);
      if (req.params.userId === project.ownerId) {
        throw new HttpError(400, "The project owner doesn't have a collaborator role to change", "CANNOT_CHANGE_OWNER_ROLE");
      }
      if (getCollaboratorRole(db, project.id, req.params.userId) === null) {
        throw new HttpError(404, "Collaborator not found", "COLLABORATOR_NOT_FOUND");
      }
      const parsed = UpdateCollaboratorRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      updateCollaboratorRole(db, project.id, req.params.userId, parsed.data.role);
      res.json({ collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) });
    }),
  );

  /**
   * Removing a collaborator was previously owner-only, full stop -- which
   * meant a collaborator invited to someone else's project had no way to
   * actually leave it; only asking the owner to remove them worked. This
   * now also allows the one case that's always safe regardless of who owns
   * the project: removing YOURSELF (real, permanent "leave project" self-
   * service, the collaborator-scoped sibling of round 210's own "delete my
   * account"). requireProjectAccess (not requireProjectOwner) so a
   * collaborator's own request to leave doesn't 404 before it even gets a
   * chance to check who's being removed; the owner-or-self check below is
   * what actually gates it. A collaborator can never remove a *different*
   * collaborator -- that stays owner-only.
   */
  router.delete(
    "/projects/:id/collaborators/:userId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const isSelf = req.params.userId === req.userId;
      if (project.ownerId !== req.userId! && !isSelf) {
        throw new HttpError(403, "Only the project owner can remove a different collaborator", "COLLABORATOR_CANNOT_REMOVE_OTHERS");
      }
      removeCollaborator(db, project.id, req.params.userId);
      res.status(204).end();
    }),
  );

  router.post(
    "/projects/:id/answers",
    aiGenerationRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = AnswerQuestionsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const entries = parsed.data.answers
        .map(({ question, answer }) => [question.trim(), answer.trim()] as const)
        .filter(([question, answer]) => question.length > 0 && answer.length > 0);
      const additionalRequest = parsed.data.additionalRequest?.trim() ?? "";

      // Free-text answers (not just the suggested quick-pick options) and a
      // free-standing request (not tied to any specific question at all)
      // both feed straight back into spec generation -- so this actually
      // changes the spec that will get built, instead of only highlighting
      // a chip in the UI.
      const sections: string[] = [];
      if (entries.length > 0) {
        const answersText = entries.map(([question, answer]) => `- ${question}: ${answer}`).join("\n");
        sections.push(`Answers to clarifying questions:\n${answersText}`);
      }
      if (additionalRequest.length > 0) {
        sections.push(`Additional request: ${additionalRequest}`);
      }
      if (sections.length === 0) {
        res.json({ project });
        return;
      }
      // Unlike /refine, this route only calls updateProjectSpec directly --
      // it never runs the build pipeline, so it never migrates the SQL
      // schema to match whatever new entities/fields the regenerated spec
      // adds. That's fine before the first build (there's no schema yet to
      // fall out of sync with), but doing this on an already-built project
      // would silently desync project.spec from the real database: the spec
      // would claim an entity exists that has no table, and the very next
      // read/write against it throws an uncaught "no such table" SQL error
      // -- confirmed empirically, not just reasoned about. Checked only
      // here, after the no-op early-return above, so a harmless call with
      // no actual answers/request still succeeds post-build; /refine is the
      // route that correctly re-runs the pipeline for a built project.
      if (project.status === "built") {
        throw new HttpError(409, "This project is already built; use refine to make further changes", "ALREADY_BUILT");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      // Round 474: unlike /build and /refine (which stream SSE and are out
      // of scope for this mechanism), this route returns a plain JSON
      // response, so it fits withIdempotency()'s {status, body} contract
      // exactly like the five routes converted in rounds 471-473. A retry
      // landing after the activePipelines guard above already cleared
      // (the pipeline fully finished) would otherwise call generateSpec()
      // again -- a second real AI call -- and overwrite project.spec a
      // second time.
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${project.id}/answers`, async () => {
        activePipelines.add(project.id);
        try {
          const combinedDescription = `${project.description}\n\n${sections.join("\n\n")}`;
          // Same fix as /refine just above -- a clarifying-question answer
          // or additional request containing one Hebrew/English word must
          // not flip the WHOLE draft spec's language away from what the
          // original description already established.
          const { spec, providerName } = await generateSpec(combinedDescription, provider, isHebrewText(project.description));
          const updated = updateProjectSpec(db, project.id, spec);
          return { status: 200, body: { project: updated, providerName } };
        } finally {
          activePipelines.delete(project.id);
        }
      });
      res.status(status).json(body);
    }),
  );

  router.post(
    "/projects/:id/build",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Mirrors /refine's own status guard below: without this, calling
      // /build a second time on an already-built project silently
      // "succeeds" (diffAndMigrate with no previousSpec treats every
      // entity as new, but the seed step's own empty-table check keeps it
      // from re-seeding real data) but still inserts a fresh checkpoint
      // mislabeled "Initial build" every time -- the Time Machine history
      // ends up with multiple identically-labeled checkpoints with no way
      // to tell them apart. /refine is the correct route once a project
      // is already built.
      if (project.status === "built") {
        throw new HttpError(409, "This project is already built; use refine to make further changes", "ALREADY_BUILT");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      activePipelines.add(project.id);
      try {
        await streamPipeline(res, db, project, {
          nextSpec: project.spec,
          changeLabel: isHebrewText(project.description) ? "בנייה ראשונית" : "Initial build",
          uploadsDir,
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.post(
    "/projects/:id/refine",
    aiGenerationRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before refining it", "BUILD_REQUIRED");
      }
      const parsed = RefineSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      activePipelines.add(project.id);
      try {
        const { instruction } = parsed.data;
        const combinedDescription = `${project.description}\n\nAdditional requirement: ${instruction}`;
        // Decided from the project's own established description ALONE, not
        // the combined text the instruction was just appended to -- without
        // this, a single Hebrew/English word anywhere in a brand-new
        // instruction (a pasted name, a stray word) flipped an already-built
        // project's ENTIRE set of labels to that script, not just whatever
        // the instruction was actually about (see SpecProvider.generate's
        // own doc comment).
        const { spec: nextSpec, providerName } = await generateSpec(combinedDescription, provider, isHebrewText(project.description));
        await streamPipeline(res, db, project, {
          previousSpec: project.spec,
          nextSpec,
          // Decided from the project's own established description, matching
          // /build's identical convention just above and round 708's own
          // principle -- not from the instruction's own text, which can be
          // typed in either script regardless of the project's real,
          // established language (e.g. a Hebrew project refined with a
          // plain-English instruction), leaving an otherwise fully-Hebrew
          // Time Machine checkpoint list with one inconsistently-English
          // entry.
          changeLabel: isHebrewText(project.description) ? `שיפור: ${instruction}` : `Refine: ${instruction}`,
          providerName,
          uploadsDir,
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.get(
    "/projects/:id/checkpoints",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ checkpoints: listCheckpoints(db, project.id) });
    }),
  );

  /**
   * Round 956: same withIdempotency() extension, and the same reason, as
   * deleteCheckpoint's own fix just above (round 944) -- but the actual
   * hazard here is subtler than a 404. Restore reads project.spec, computes
   * a migrationWarning from it, then overwrites it with checkpoint.spec --
   * so a response lost in transit after the server already committed this
   * means the retry re-reads project.spec as the value THIS SAME restore
   * already wrote (now equal to checkpoint.spec), diffs it against itself,
   * and comes back with migrationWarning: null even though the restore
   * that actually happened may have crossed a real data hazard the user
   * never gets to see. docs/roadmap.md's round-944 entry explicitly flagged
   * this as a separate, still-open idempotency story -- this closes it.
   * Everything from the checkpoint lookup down moves inside the
   * withIdempotency callback (not just the final mutation), since the
   * hazard is in the READ (project.spec) as much as the write.
   */
  router.post(
    "/projects/:id/checkpoints/:checkpointId/restore",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/checkpoints/${req.params.checkpointId}/restore`,
        async () => {
          const checkpoint = getCheckpoint(db, req.params.checkpointId);
          if (!checkpoint || checkpoint.projectId !== project.id) {
            throw new HttpError(404, `Checkpoint "${req.params.checkpointId}" not found`, "CHECKPOINT_NOT_FOUND");
          }
          // Restore itself is the lost-update hazard activePipelines (see its
          // own comment above) exists to prevent -- it reads project.spec, does
          // work, then writes project.spec back, just like /build, /refine, and
          // /answers do. Round 991: this route's own body below DOES now await
          // real work before writing back (cleanupFileFieldsRetypedAway, added
          // round 977, does genuine disk I/O) -- a comment that used to be here
          // claimed restore "never awaits anything", which was already wrong
          // the moment that round shipped. Marking this project id busy for the
          // whole callback (mirroring /build/refine/answers/DELETE's own
          // identical activePipelines.add/delete pattern), not just checking
          // it, is what actually closes the gap: without it, an ordinary quick
          // mutation route (entity/field label rename, roles, ...) that only
          // *checks* activePipelines could read the still-current spec, write
          // its own change, and return 200 during that await -- only for
          // updateProjectSpec below to silently overwrite the whole spec with
          // the checkpoint's frozen snapshot the instant it resumes, discarding
          // that change with no error to either caller.
          if (activePipelines.has(project.id)) {
            throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
          }
          activePipelines.add(project.id);
          try {
            // project.spec must be re-read here, fresh inside the callback,
            // rather than reusing the `project` fetched above by
            // requireProjectWriteAccess -- that outer read happens before
            // this call is known to be a genuine first attempt rather than a
            // retry, so on a retry it would still be the PRE-restore spec
            // from the request object, not the actually-current (already
            // restored) one getProject() returns here. A plain getProject()
            // is enough (not another requireProjectWriteAccess call) since
            // access was already established above and can't have changed
            // in between.
            const currentSpec = getProject(db, project.id)!.spec;
            // Restoring never drops columns/tables (migrations are additive-only),
            // so it's always safe from *losing* data: this just ensures the
            // restored spec's schema exists (a no-op unless restoring "forward"
            // to a spec never built) and moves the spec pointer. "Safe from
            // losing" isn't "safe from misreading" though -- diffAndMigrate can
            // still report a reused column whose physical SQL type or FK target
            // no longer matches what the restored spec claims (e.g. a field that
            // was boolean when this checkpoint was taken, but has since been
            // retyped to text and wasn't just created fresh here), and /build and
            // /refine always surface that exact same diagnostic to the user
            // (pipeline.ts's "Database" agent message) -- silently discarding it
            // here, right where it's needed just as much, left a restored project
            // render stale/mismatched values (e.g. a boolean cell reading
            // Boolean("some real note text") as true) with no warning at all.
            // Round 929: the checkpoint's own spec is a frozen snapshot from
            // whenever it was taken -- restoring it straight, unmodified, silently
            // reverted any entity/field label (and enum-value label) the user
            // customized AFTER that checkpoint via EntityLabelEditor/
            // FieldLabelEditor, with zero warning (describeImpactHazards only
            // ever looks at structural field changes, never labels). This is the
            // exact same "a previous customization should survive, by name, onto
            // whatever spec replaces it" problem carryForwardLabels already
            // solves for /refine (round 915/917) -- previousSpec is the CURRENT,
            // still-customized spec being replaced; nextSpec is the checkpoint's
            // own spec about to become the live one, mutated in place so its
            // labels win for any entity/field that survives under the same name.
            carryForwardLabels(currentSpec, checkpoint.spec);
            const changes = diffAndMigrate(db, project.id, currentSpec, checkpoint.spec);
            // Round 977: a restore can retype a field away from "file" the
            // exact same way a /refine can -- see cleanupFileFieldsRetypedAway's
            // own doc comment (pipeline.ts).
            await cleanupFileFieldsRetypedAway(db, uploadsDir, project.id, changes);
            const updated = updateProjectSpec(db, project.id, checkpoint.spec);
            // An older checkpoint being restored to isn't guaranteed to be a
            // safe, monotonically-looser move the way the data migration above
            // already is (additive-only) -- it can easily be STRICTER on a field
            // the user has since relaxed, or simply missing an entity/field the
            // user has been actively using with real data in it. /build and
            // /refine already warn about this exact class of change
            // (pipeline.ts's own "Architect" message); describeImpactHazards
            // reuses that identical hazard detection here, over the current spec
            // being replaced (previousSpec) and the checkpoint's own spec taking
            // its place (nextSpec) -- the same previousSpec/nextSpec shape
            // computeImpact already expects, restore just supplies an older
            // spec as "next" instead of a freshly regenerated one.
            const migrationWarning = (describeMigrationHazards(changes).trim() + describeImpactHazards(currentSpec, checkpoint.spec)).trim();
            return { status: 200, body: { project: updated, migrationWarning: migrationWarning.length > 0 ? migrationWarning : null } };
          } finally {
            activePipelines.delete(project.id);
          }
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * A checkpoint's label was previously only ever the automatic one build/
   * refine gave it ("Initial build", "Refine: <instruction>") -- no way to
   * give an important one a name that's actually memorable months later
   * (e.g. "before the pricing overhaul"). Checks project ownership through
   * requireProjectAccess just like the restore route above, and
   * renameCheckpoint itself re-scopes by projectId in its own WHERE clause
   * (see checkpoints.ts), so a checkpoint id belonging to a different
   * project can never be renamed even if guessed.
   */
  /**
   * Round 962: same withIdempotency() extension, and the same reason, as
   * the entity-label/field-label PATCH routes' own round-960 fix -- this
   * route's two immediate siblings on the exact same resource (restore,
   * round 956; delete, round 944) already got this protection, but the
   * rename sitting between them was missed. renameCheckpoint
   * (packages/db/src/checkpoints.ts) is a plain, unconditional UPDATE, not
   * scoped to the label's own previous value -- a response lost in
   * transit after a rename already committed means a retry blindly
   * reapplies its own now-stale label a second time, silently reverting a
   * genuinely newer rename (a different collaborator, or a second tab)
   * that landed in between, with no error to either side.
   */
  router.patch(
    "/projects/:id/checkpoints/:checkpointId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = RenameCheckpointSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/checkpoints/${req.params.checkpointId}`,
        async () => {
          const checkpoint = renameCheckpoint(db, project.id, req.params.checkpointId, parsed.data.label);
          return { status: 200, body: { checkpoint } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Time Machine's history otherwise only ever grows -- every build and
   * every refine adds a checkpoint, with no way to prune a single unwanted
   * one (an experimental refine that went nowhere, say), the same real gap
   * round 208 closed for the WhatsApp message log. deleteCheckpoint itself
   * re-scopes by projectId in its own WHERE clause (see checkpoints.ts), so
   * a checkpoint id belonging to a different project can never be deleted
   * even if guessed. Never touches the project's own current spec (that
   * lives on the project row, independent of this table), so deleting even
   * the checkpoint that happens to match the current state is harmless.
   *
   * Round 944: same withIdempotency() extension, and the same reason, as
   * deleteRecord's own fix (round 792) -- deleteCheckpoint throws
   * NotFoundError once the row is actually gone, with no special case for
   * a retry. fetchWithWakeRetry (apps/web/src/wakeRetry.ts) retries on ANY
   * thrown fetch() error, so a response lost in transit after the server
   * already deleted the checkpoint meant the retry got back a confusing
   * 404 for a delete that, from the user's own point of view, already
   * fully succeeded -- and since HistoryPanel.tsx's handleDelete is
   * deliberately non-optimistic (only removes the row from state on an
   * actual 200/204 response), the checkpoint stayed visibly listed right
   * next to that error, with no way to resolve the contradiction short of
   * a page reload.
   */
  router.delete(
    "/projects/:id/checkpoints/:checkpointId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/checkpoints/${req.params.checkpointId}`,
        async () => {
          deleteCheckpoint(db, project.id, req.params.checkpointId);
          return { status: 204, body: null };
        },
      );
      res.status(status).end();
    }),
  );

  router.get(
    "/projects/:id/export",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before exporting its code", "BUILD_REQUIRED");
      }
      /**
       * codegen.ts's assertSafe rejects any entity/field name that isn't a
       * plain ASCII identifier -- unlike the live preview's own table-name
       * sanitization (packages/db/src/identifiers.ts's tableNameFor), which
       * never throws. A spec with a single, non-colliding non-ASCII name
       * (e.g. Hebrew) is therefore a real, reachable case that builds and
       * runs fine in the live preview but has always thrown here as a bare
       * Error -- which app.ts's generic error handler turned into an
       * unexplained 500, with zero indication of what went wrong or how to
       * fix it. Caught here and translated into an actionable 422 instead;
       * the underlying schema-level fix (round 283) intentionally didn't
       * reject this case outright, since a lone non-colliding non-ASCII
       * name doesn't corrupt any data -- it just can't be exported.
       */
      let files: ReturnType<typeof generateExportFiles>;
      try {
        files = generateExportFiles(project);
      } catch (err) {
        const match = err instanceof Error && /^Refusing to export: unsafe (entity|field) identifier "(.+)"$/.exec(err.message);
        if (match) {
          throw new HttpError(
            422,
            `Refusing to export: unsafe ${match[1]} identifier "${match[2]}" -- rename it to use only English letters, digits, and underscores, then try exporting again`,
            "EXPORT_UNSAFE_IDENTIFIER",
          );
        }
        throw err;
      }
      const zip = buildZip(files);
      const safeName = project.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app";
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${safeName}.zip"`);
      res.send(zip);
    }),
  );

  router.get(
    "/projects/:id/backup",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before backing up its data", "BUILD_REQUIRED");
      }
      const columnOrders = parseColumnOrdersQueryParam(req.query.columnOrders);
      const entries = generateBackupZipEntries(db, project, columnOrders);
      const zip = buildZip(entries);
      const safeName = project.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app";
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${safeName}-backup.zip"`);
      res.send(zip);
    }),
  );

  /**
   * Round 976: requireProjectAccess here lets a "viewer" collaborator
   * through identically to an editor/owner -- correct for status/
   * phoneNumber/error, but `qrDataUrl` (whenever status is "qr") is a live
   * WhatsApp-Web linking QR code, not ordinary project data: scanning it
   * with any phone links that phone as a new device on the REAL external
   * WhatsApp account this project is connecting, with full read/send
   * access to it, entirely outside this app's own permission model. A
   * viewer can never cause a connect themselves (POST .../connect already
   * requires requireProjectWriteAccess below) but could otherwise just
   * read this GET route (or simply have the panel open) while an owner/
   * editor is mid-connect and hijack the account. Same redaction pattern
   * as round 975's webhookSecret fix -- only the credential is redacted,
   * every other field stays visible to a viewer as before.
   */
  router.get(
    "/projects/:id/integrations/whatsapp/status",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const isViewer = project.ownerId !== req.userId! && getCollaboratorRole(db, project.id, req.userId!) === "viewer";
      const status = whatsapp.getStatus(project.id);
      res.json(isViewer ? { ...status, qrDataUrl: null } : status);
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/connect",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      res.json(await whatsapp.connect(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/disconnect",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      await whatsapp.disconnect(project.id);
      res.json(whatsapp.getStatus(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/send",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = WhatsAppSendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { to, message, attachment } = parsed.data;
      const connStatus = whatsapp.getStatus(project.id);
      if (connStatus.status !== "connected") {
        throw new HttpError(409, "Connect WhatsApp before sending a message", "WHATSAPP_NOT_CONNECTED");
      }
      // Round 973: `attachment.url` is client-supplied -- re-derive the
      // expected prefix and re-validate the filename against UPLOADED_FILENAME
      // ourselves rather than trusting it, exactly like the existing
      // record-file reference resolution a few hundred lines above this
      // route does for a record's own file-type field value. A URL that
      // doesn't match the one and only shape this project's own attachment
      // upload route ever produces (including one for a DIFFERENT project)
      // is rejected before it ever reaches path.join, so no attacker-chosen
      // path segment is used, and only once it matches UPLOADED_FILENAME
      // exactly is the already-isPathInsideDir-checked uploadsDir/.../filename
      // combination ever opened.
      let resolvedAttachment: WhatsAppAttachment | undefined;
      if (attachment) {
        const filePath = resolveWhatsAppAttachmentPath(project.id, attachment.url);
        if (!filePath) {
          throw new HttpError(400, "Invalid attachment reference", "INVALID_ATTACHMENT");
        }
        if (!existsSync(filePath)) {
          throw new HttpError(400, "Attachment file is no longer available", "ATTACHMENT_FILE_GONE");
        }
        resolvedAttachment = { filePath, fileName: attachment.name, mimeType: attachment.mimeType };
      }
      // Unlike every sibling mutating route in this file (/roles,
      // /assumptions, /entities, /entities/:entityName/automations, the
      // record-creation route, …), this one was never wrapped in
      // withIdempotency -- and api.ts's sendWhatsAppMessage() never sent an
      // X-Idempotency-Key header either, unlike all of those siblings'
      // client-side counterparts. A response lost after whatsapp.sendMessage()
      // already succeeded (the exact fetchWithWakeRetry retry window the
      // design doc exists for) would resend the identical POST and send the
      // same real WhatsApp message to the customer a second time.
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/integrations/whatsapp/send`,
        async () => {
          const result = await whatsapp.sendMessage(project.id, to, message, resolvedAttachment);
          // Round 979: resolvedAttachment is single-use -- whatsapp.sendMessage
          // above (performSend, whatsappWeb.ts) already fully read it into
          // memory before this await resolved, win or lose, and nothing else
          // in this app ever references this exact uploaded file again (there
          // is no record/automation tying it to anything, unlike an entity's
          // own file-field upload). Deleting it now, regardless of whether
          // the send itself succeeded, is what the record-file-field cleanup
          // (deleteReplacedFileFields) already does for an entity's own
          // uploads on every PATCH/DELETE -- without this, every test-send
          // with an attachment (the feature's own common, intended usage)
          // permanently grew this project's disk usage, with the only
          // existing cleanup (deleteProjectUploads) being whole-project
          // deletion.
          if (resolvedAttachment) {
            await rm(resolvedAttachment.filePath, { force: true }).catch(() => {});
          }
          // whatsapp.sendMessage() above is a genuine await (a real network
          // round-trip to the WhatsApp Web socket) -- the same reverse-direction
          // hazard DELETE /projects/:id's own comment documents for every other
          // quick mutation route in this file. A concurrent DELETE /projects/:id
          // can run to completion (including deleteWhatsAppData, which purges
          // this project's existing whatsapp_messages rows) while this send is
          // still suspended above. Without this re-check, the insertWhatsAppMessage
          // call below would then create a BRAND NEW row for a project id that no
          // longer exists -- whatsapp_messages.projectId carries no foreign key,
          // so the insert would succeed silently, and since every reader route
          // (GET .../messages, the backup ZIP, etc.) 404s via requireProjectAccess
          // the instant the project is gone, that row would be permanently
          // orphaned and unreachable through any route, forever, while this
          // request still reports 200 { ok: true } as if nothing went wrong.
          if (!getProject(db, project.id)) {
            throw new HttpError(404, `Project "${project.id}" not found`, "PROJECT_NOT_FOUND");
          }
          // Mirrors the matching an incoming message gets (see
          // WhatsAppWebManager.handleIncomingMessages): without this, the panel's
          // own log rendering (which falls back to the matched label only when
          // one is present, for either direction) always shows the raw phone
          // number for a sent test message, even when `to` is a known customer's
          // number. Only attempted once the project is actually built -- before
          // that there is no real table behind any entity yet, and
          // findMatchingRecord's listRecords call would throw "no such table".
          const match = project.status === "built" ? findMatchingRecord(db, project, to) : null;
          insertWhatsAppMessage(db, {
            projectId: project.id,
            direction: "out",
            fromNumber: connStatus.phoneNumber ?? "",
            toNumber: to,
            body: message,
            matchedEntityName: match?.entityName ?? null,
            matchedRecordId: match?.recordId ?? null,
            matchedLabel: match?.label ?? null,
            status: result.ok ? "sent" : "failed",
          });
          if (!result.ok) {
            return { status: 502, body: { ok: false, error: result.error } };
          }
          return { status: 200, body: { ok: true } };
        },
      );
      res.status(status).json(body);
    }),
  );

  router.get(
    "/projects/:id/integrations/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // A conversation only ever grows, and listWhatsAppMessages always
      // capped at 50 with no way to ask for anything older -- cursor lets
      // the panel's own "load older messages" button actually reach them.
      // Anything that isn't a genuine string (missing, an array from a
      // repeated query param) falls back to null, which listWhatsAppMessages
      // itself already treats as "start from the newest message" --
      // listWhatsAppMessages validates the cursor's own shape itself, same
      // as it always tolerated a malformed offset.
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
      res.json(listWhatsAppMessages(db, project.id, 50, cursor));
    }),
  );

  router.delete(
    "/projects/:id/integrations/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      clearWhatsAppMessages(db, project.id);
      res.status(204).end();
    }),
  );

  /**
   * Round 958: same withIdempotency() extension, and the same reason, as
   * deleteCheckpoint's own fix (round 944) -- deleteWhatsAppMessage
   * (packages/db/src/whatsapp.ts) throws NotFoundError once the row is
   * already gone, with no special case for a retry. fetchWithWakeRetry
   * retries on ANY thrown fetch() error, so a response lost in transit
   * after the server already deleted the message meant the retry got back
   * a confusing 404 for a delete that, from the user's own point of view,
   * already fully succeeded -- and since WhatsAppPanel.tsx's
   * handleDeleteMessage only removes the row from local state inside its
   * try block, that 404 left the message still visibly listed right next
   * to a scary error banner, with no way to resolve the contradiction
   * short of a page reload. The sibling bulk-clear route just above needs
   * no such wrapper -- clearing an already-empty table is naturally a
   * no-op -- but deleting one specific row by id is not.
   */
  router.delete(
    "/projects/:id/integrations/whatsapp/messages/:messageId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/integrations/whatsapp/messages/${req.params.messageId}`,
        async () => {
          deleteWhatsAppMessage(db, project.id, req.params.messageId);
          return { status: 204, body: null };
        },
      );
      res.status(status).end();
    }),
  );

  router.get(
    "/projects/:id/twin",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before viewing its Business Twin", "BUILD_REQUIRED");
      }
      res.json({ twin: computeBusinessTwin(db, project) });
    }),
  );

  /**
   * One cheap COUNT(*) per entity, so the entity-tabs strip can show how
   * much data lives in each tab without the user clicking into every one --
   * the only other place this information already existed (Business Twin)
   * sits an extra click away behind its own panel, not at a glance where
   * attention already is.
   */
  router.get(
    "/projects/:id/entity-counts",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before viewing entity counts", "BUILD_REQUIRED");
      }
      const counts: Record<string, number> = {};
      for (const entity of project.spec.entities) {
        counts[entity.name] = countRecords(db, project.id, entity);
      }
      res.json({ counts });
    }),
  );

  router.get(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      res.json({ records: listRecords(db, project.id, entity) });
    }),
  );

  router.post(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      /**
       * Round 594: the one business-record-mutation route this design's
       * own "Full inventory of mutating routes" (docs/wakeRetry-idempotency-
       * design.md) never actually listed -- every other real-effect POST
       * (roles/assumptions/entities/fields/answers/project-create/clone)
       * got withIdempotency protection in rounds 471-528, but record
       * creation itself (the single most frequent write in the app --
       * every "Add" form, duplicate, bulk-duplicate, and CSV-import row)
       * was missed, plausibly because its URL (/entities/:entityName) so
       * closely resembles the already-fixed spec-level /entities (add-
       * entity-to-spec) route above. fetchWithWakeRetry (apps/web/src/
       * wakeRetry.ts) retries on any thrown fetch() error, not just an
       * HTTP error -- exactly the "sent, processed, lost on the way back"
       * case this mechanism exists for -- so a response lost in transit
       * after insertRecord already committed produced a second, fully
       * duplicate row on retry.
       */
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/entities/${entity.name}`,
        async () => {
          /**
           * Same `PRAGMA foreign_keys = ON` constraint the DELETE route
           * below already translates (round 292), but on the write side:
           * a relation field's picker in EntityPanel.tsx is built from
           * `relatedRecords` fetched earlier, so submitting a create/edit
           * referencing a record another collaborator (or this same
           * browser's own deferred-delete undo window) deleted in the
           * meantime hits this exact constraint. Without this, app.ts's
           * generic error handler turned it into an unexplained 500
           * instead of a message naming the actual problem.
           */
          let record: ReturnType<typeof insertRecord>;
          try {
            record = insertRecord(db, project.id, entity, req.body ?? {});
          } catch (err) {
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              throw new HttpError(
                400,
                "This record references another record that no longer exists",
                "INVALID_RELATION_TARGET",
              );
            }
            throw err;
          }
          // Deliberately not awaited -- see runAutomationsForRecordChange's
          // own comment. A WhatsApp send is a real network round-trip, and
          // this response is about to go out; nothing downstream of it
          // should add latency to, or ever fail because of, an automation
          // side effect. Firing it inside this callback (rather than after
          // withIdempotency resolves) keeps it from firing a second time on
          // a replayed/cached retry, same as insertRecord itself above.
          //
          // X-Suppress-Automations, set only by EntityPanel.tsx's CSV-import
          // path, skips this call entirely for an imported row. Without it,
          // importing a spreadsheet of pre-existing customers to migrate off
          // another system fires every "record_created" rule for each row
          // -- concurrently, since the import POSTs every row at once via
          // Promise.allSettled -- sending a real WhatsApp "welcome" message
          // to hundreds of people who were never actually just created, in
          // a concurrent burst that's exactly the automated-sending pattern
          // whatsappWeb.ts's own module comment already warns can get a
          // number flagged or blocked. A single "Add" form submission, a
          // duplicate, and a bulk-duplicate are all still genuinely new
          // records from the app's own point of view, so none of those
          // paths set this header -- only CSV import, which is a backfill
          // of data that already existed before the app did.
          if (req.header("X-Suppress-Automations") !== "true") {
            void runAutomationsForRecordChange(
              db,
              whatsapp,
              emailSender,
              project,
              entity,
              "created",
              record,
              new Set(Object.keys(req.body ?? {})),
              uploadsDir,
              `${req.protocol}://${req.get("host")}`,
            );
          }
          return { status: 201, body: { record } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Stores a single uploaded file on disk and hands back a small JSON
   * descriptor ({ url, name, size, mimeType }) -- the caller then PATCHes
   * (or includes in the POST create) that descriptor, JSON-stringified,
   * as the field's own value, exactly like every other record write. This
   * route itself never touches the record/database at all; it only turns
   * a multipart upload into a value the normal record-write path already
   * knows how to store (coerceValue's default string branch).
   *
   * Access/field-type validation runs in its own middleware, BEFORE
   * multer's disk-storage middleware -- otherwise an authenticated user
   * with no access to this specific project (or a project/field that
   * doesn't exist, or a field that isn't type "file") would still have
   * their file written to disk before the handler ever got a chance to
   * reject the request.
   */
  router.post(
    "/projects/:id/entities/:entityName/fields/:fieldName/upload",
    (req, res, next) => {
      try {
        const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
        if (project.status !== "built") {
          throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
        }
        const entity = findEntity(project, req.params.entityName);
        const field = findField(entity, req.params.fieldName);
        if (field.type !== "file") {
          throw new HttpError(400, `Field "${field.name}" is not a file field`, "NOT_A_FILE_FIELD");
        }
        // Reject here too, before multer's own disk-storage middleware
        // (which also checks this, defense-in-depth) ever starts parsing
        // the multipart body -- matching this route's own stated goal
        // just above of rejecting before anything gets written to disk.
        if (!isPathInsideDir(path.join(uploadsDir, req.params.id, entity.name), uploadsDir)) {
          throw new HttpError(400, `Entity "${entity.name}" has a name that cannot be used as a storage path`, "UNSAFE_ENTITY_NAME");
        }
        next();
      } catch (err) {
        next(err);
      }
    },
    // Round 907: multer's own disk-storage middleware (invoked below,
    // inside withIdempotency's run callback rather than as a separate
    // Express middleware stage) names every file with a fresh randomUUID
    // -- a retried upload (fetchApi's own fetchWithWakeRetry auto-retries
    // on a dropped connection, even one where the server already fully
    // finished and the response just never arrived) is physically
    // indistinguishable from a brand-new one, so each retry wrote a
    // completely separate orphaned file to disk forever, with no cleanup
    // mechanism anywhere for a file that no record ever ends up
    // referencing. Every structurally identical write path in this file
    // already opts into withIdempotency (createRecord's own POST chief
    // among them) -- this route was the one holdout. Wrapping multer's own
    // invocation inside the run callback (not just the response-building
    // after it) is what actually matters here: withIdempotency's own
    // existing/"done" replay check runs BEFORE run() -- and therefore
    // before multer ever touches disk -- so a genuine replay never writes
    // a second file at all, not merely "writes one but the client doesn't
    // see its URL."
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const entity = findEntity(project, req.params.entityName);
      const field = findField(entity, req.params.fieldName);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/entities/${entity.name}/fields/${field.name}/upload`,
        async () => {
          await new Promise<void>((resolve, reject) => {
            upload.single("file")(req, res, (err: unknown) => {
              if (err instanceof MulterError) {
                if (err.code === "LIMIT_FILE_SIZE") {
                  reject(new HttpError(400, "File is too large (max 10 MB)", "FILE_TOO_LARGE"));
                  return;
                }
                reject(new HttpError(400, "File upload failed", "UPLOAD_ERROR"));
                return;
              }
              if (err) {
                reject(err as Error);
                return;
              }
              resolve();
            });
          });
          const file = req.file;
          if (!file) {
            throw new HttpError(400, "No file was uploaded", "NO_FILE_UPLOADED");
          }
          // Round 1025: the access/existence check above runs before
          // multer's own disk write -- a genuine, potentially long I/O
          // operation (a slow connection, a large file) -- with nothing in
          // between. A concurrent DELETE /projects/:id on this same
          // project (another tab/device, or another collaborator) can run
          // to completion -- including its own deleteProjectUploads sweep
          // -- entirely within that window: multer's destination callback
          // (createUploadMiddleware above) unconditionally recreates this
          // project's upload directory via mkdirSync with no existence
          // check of its own, so the write still lands on disk, resurrecting
          // a just-deleted project's upload directory, permanently orphaned
          // (nothing will ever call deleteProjectUploads for this project
          // again). Re-checks existence now, after that genuine await, the
          // same "check after the real I/O, not just before it" pattern
          // rounds 539/1024 already established for auth.ts's own password
          // routes -- cleaning up the just-written file rather than leaving
          // it orphaned if the project is gone.
          if (!getProject(db, req.params.id)) {
            await rm(file.path, { force: true }).catch(() => {});
            throw new HttpError(404, `Project "${req.params.id}" not found`, "PROJECT_NOT_FOUND");
          }
          return {
            status: 200,
            body: {
              file: {
                url: `/api/uploads/${req.params.id}/${req.params.entityName}/${file.filename}`,
                name: decodeMojibakeFilename(file.originalname),
                size: file.size,
                mimeType: file.mimetype,
              },
            },
          };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Round 1002: the create-form counterpart of deleteReplacedFileFields
   * (round 685, called from the PATCH/DELETE record routes below). That
   * sweep only ever diffs a record write against its own already-persisted
   * DB row, so it can never reach a file uploaded via the POST route above
   * while a record is still being composed client-side and hasn't been
   * created yet -- replacing the chosen file, or removing it, before ever
   * submitting the create form left that upload sitting on disk forever,
   * with nothing short of deleting the whole project (deleteProjectUploads)
   * ever touching it. Mirrors the WhatsApp attachment delete route below:
   * best-effort and a silent no-op for anything that doesn't resolve to a
   * real upload this project's own upload route could have produced.
   */
  router.delete(
    "/projects/:id/entities/:entityName/fields/:fieldName/upload",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const entity = findEntity(project, req.params.entityName);
      const field = findField(entity, req.params.fieldName);
      if (field.type !== "file") {
        throw new HttpError(400, `Field "${field.name}" is not a file field`, "NOT_A_FILE_FIELD");
      }
      const parsed = z.object({ url: z.string().min(1) }).safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      await deleteUploadedFile(uploadsDir, project.id, entity.name, JSON.stringify({ url: parsed.data.url }));
      res.status(204).end();
    }),
  );

  /**
   * Round 979: resolves and validates a client-supplied WhatsApp attachment
   * descriptor's `url` back to a real, safe filesystem path under THIS
   * project's own WHATSAPP_ATTACHMENTS_DIRNAME -- shared by the send route
   * (round 973) and the explicit delete route below, so both validate the
   * identical way instead of two independently-maintained copies drifting
   * apart. Returns null for anything that doesn't match the one shape this
   * project's own upload route could ever have produced (including a URL
   * for a DIFFERENT project); never throws.
   */
  function resolveWhatsAppAttachmentPath(projectId: string, url: string): string | null {
    const expectedPrefix = `/api/uploads/${projectId}/${WHATSAPP_ATTACHMENTS_DIRNAME}/`;
    const filename = url.startsWith(expectedPrefix) ? url.slice(expectedPrefix.length) : null;
    if (!filename || !UPLOADED_FILENAME.test(filename)) return null;
    const target = path.join(uploadsDir, projectId, WHATSAPP_ATTACHMENTS_DIRNAME, filename);
    return isPathInsideDir(target, uploadsDir) ? target : null;
  }

  /**
   * Round 973: the manual-send counterpart of the entity file-field upload
   * route above. Mirrors its idempotency/multer/error-handling shape
   * exactly, minus the entity/field access checks (there is no entity or
   * field here) and minus the UNSAFE_ENTITY_NAME check (WHATSAPP_ATTACHMENTS_DIRNAME
   * is a fixed literal, not an untrusted path segment).
   */
  router.post(
    "/projects/:id/integrations/whatsapp/attachments/upload",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/integrations/whatsapp/attachments/upload`,
        async () => {
          await new Promise<void>((resolve, reject) => {
            whatsappAttachmentUpload.single("file")(req, res, (err: unknown) => {
              if (err instanceof MulterError) {
                if (err.code === "LIMIT_FILE_SIZE") {
                  reject(new HttpError(400, "File is too large (max 10 MB)", "FILE_TOO_LARGE"));
                  return;
                }
                reject(new HttpError(400, "File upload failed", "UPLOAD_ERROR"));
                return;
              }
              if (err) {
                reject(err as Error);
                return;
              }
              resolve();
            });
          });
          const file = req.file;
          if (!file) {
            throw new HttpError(400, "No file was uploaded", "NO_FILE_UPLOADED");
          }
          // Round 1025: mirrors the entity file-field upload route's own
          // identical fix just above -- see its own comment for the full
          // "resurrected upload directory" race this re-check closes.
          if (!getProject(db, req.params.id)) {
            await rm(file.path, { force: true }).catch(() => {});
            throw new HttpError(404, `Project "${req.params.id}" not found`, "PROJECT_NOT_FOUND");
          }
          return {
            status: 200,
            body: {
              file: {
                url: `/api/uploads/${req.params.id}/${WHATSAPP_ATTACHMENTS_DIRNAME}/${file.filename}`,
                name: decodeMojibakeFilename(file.originalname),
                size: file.size,
                mimeType: file.mimetype,
              },
            },
          };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Round 979: the manual-remove/replace counterpart of the send route's
   * own after-send cleanup -- a user who removes a chosen attachment (or
   * picks a different file) before ever sending, or simply closes the
   * panel, left that upload sitting on disk forever, with nothing short of
   * deleting the whole project ever touching it (deleteProjectUploads).
   * Best-effort and silently a no-op for anything that doesn't resolve to a
   * real path under THIS project's own attachments directory -- a user who
   * already sent (and so already had it cleaned up above), or whose
   * reference is stale/invalid for any other reason, has nothing left here
   * worth erroring over.
   */
  router.delete(
    "/projects/:id/integrations/whatsapp/attachments",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = z.object({ url: z.string().min(1) }).safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const filePath = resolveWhatsAppAttachmentPath(project.id, parsed.data.url);
      if (filePath) {
        await rm(filePath, { force: true }).catch(() => {});
      }
      res.status(204).end();
    }),
  );

  /**
   * An entity's display label (e.g. "Customer" shown as "לקוחות") was
   * otherwise only ever set once, by spec generation -- fixing an awkward
   * auto-generated label meant a full natural-language Refine round-trip
   * (a real AI/heuristic call plus a migration, even though nothing about
   * the actual schema needs to change). `label` is pure display metadata
   * (see EntitySchema's own comment) -- entity.name, the real table name,
   * is never touched -- so this is a direct updateProjectSpec write, no
   * migration involved. requireProjectAccess (not requireProjectOwner),
   * consistent with every other spec-editing action a collaborator can
   * already do. Registered before the .../:recordId PATCH route below so
   * a request to .../entities/Customer/label is never mistaken for an
   * update to a record literally named "label".
   */
  /**
   * Round 960: same withIdempotency() extension, and the same reason, as
   * the roles/assumptions/personas PATCH/DELETE routes (round 943) --
   * this route reads project.spec, computes a targeted patch, and writes
   * it back, with no idempotency protection at all. A response lost in
   * transit after the server already committed the rename means
   * fetchWithWakeRetry's automatic retry re-applies the SAME, now-stale
   * label a second time -- harmless if nothing else changed, but if a
   * genuinely different, newer edit to this exact entity's label landed
   * in between (another collaborator, or this same user from a second
   * tab), the retry silently reverts it back to the old value, with no
   * error to either side. findEntity moves inside the callback (not just
   * the mutation) since it reads live state that could have changed by
   * the time a request actually runs; RenameEntityLabelSchema's own
   * request-body-shape validation stays outside, matching every sibling
   * PATCH route's established convention.
   */
  router.patch(
    "/projects/:id/entities/:entityName/label",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same read-project.spec-then-write-it-back shape /build, /refine,
      // /answers, and checkpoint-restore are already guarded against (see
      // their own comments) -- a slow /refine already in flight computes
      // its nextSpec from the pre-rename spec and silently reverts this
      // rename the moment it finishes writing, with no error to either side.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = RenameEntityLabelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/entities/${req.params.entityName}/label`,
        async () => {
          const entity = findEntity(project, req.params.entityName);
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) => (e.name === entity.name ? { ...e, label: parsed.data.label } : e)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * A field's display label (e.g. a "phone" field shown as "טלפון נייד")
   * has the exact same story as an entity's own label above: set once by
   * spec generation, pure display metadata that never touches the real
   * column name, so this is another direct updateProjectSpec write with
   * no migration. Path shape (.../fields/:fieldName/label) can never
   * collide with .../:entityName/:recordId below since it's a distinct,
   * longer route -- unlike the entity-label route, there's no registration-
   * order concern here.
   */
  /** Round 960: same withIdempotency() extension as the entity-label PATCH route just above -- see its own doc comment. */
  router.patch(
    "/projects/:id/entities/:entityName/fields/:fieldName/label",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as the entity-label route above, for the
      // same reason -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = RenameFieldLabelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/entities/${req.params.entityName}/fields/${req.params.fieldName}/label`,
        async () => {
          const entity = findEntity(project, req.params.entityName);
          const field = findField(entity, req.params.fieldName);
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name
                ? { ...e, fields: e.fields.map((f) => (f.name === field.name ? { ...f, label: parsed.data.label } : f)) }
                : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * The other real correction gap this round closes: a field's own
   * `required` flag -- unlike its label, which FieldChip could already
   * rename -- was static from spec generation onward, rendered as plain
   * " *" text with no control to toggle it. A newly-added field via the
   * POST route above can already set `required` at creation time; this is
   * the matching fix for every field the AI/heuristic engine already
   * proposed. Same direct updateProjectSpec write, no migration (this
   * never touches a real column -- pre-build only, same gate as every
   * other field-shape route here).
   */
  /** Round 960: same withIdempotency() extension as the entity-label PATCH route above -- see its own doc comment. */
  router.patch(
    "/projects/:id/entities/:entityName/fields/:fieldName/required",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot change a field's required flag after the project has already been built", "FIELD_EDIT_AFTER_BUILD");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = SetFieldRequiredSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/entities/${req.params.entityName}/fields/${req.params.fieldName}/required`,
        async () => {
          const entity = findEntity(project, req.params.entityName);
          const field = findField(entity, req.params.fieldName);
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name
                ? { ...e, fields: e.fields.map((f) => (f.name === field.name ? { ...f, required: parsed.data.required } : f)) }
                : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * The last correction gap in this family: an existing field's `type`
   * itself. Round 675 let the add-field form create a field with any real
   * type, but a field the AI/heuristic engine had already proposed with
   * the WRONG type still had no fix short of delete-and-recreate (losing
   * its place in the list and its label history). Same relationTo check
   * as the add-field route above (against this project's own real entity
   * names, never free text -- not a reopening of the already-rejected
   * ProductSpecSchema-level cross-field refine, since this only ever
   * validates one route's own request against live data it already has).
   * Deliberately clears whichever of enumValues/relationTo no longer
   * applies (e.g. switching "enum" -> "text" drops enumValues) rather than
   * leaving it stranded on a field whose type no longer calls for it.
   * enumLabels needs the same treatment one level deeper: the "edit
   * values" flow (SpecListItemRemover.tsx's openDraftFor) re-submits this
   * same route with type staying "enum" but a changed enumValues list --
   * renaming or removing a value used to leave its old enumLabels entry
   * permanently orphaned (and a newly-added value with no entry at all),
   * surviving in the stored spec forever since there's no other UI to
   * touch enumLabels directly. Carried forward to just the values that
   * still exist in the new list, the same "stale derived data must not
   * outlive the data it was derived from" rule already applied to
   * enumValues/relationTo just above.
   *
   * Round 949: a THIRD, independently-unswept instance of the case-only-
   * rename bug class rounds 946/947 already closed elsewhere -- an exact-
   * string lookup here (the original `.includes(value)` filter) mishandled
   * a value renamed only by letter case (e.g. editing "lost" to "Lost" in
   * the "edit values" form, a purely cosmetic fix) the exact same way: the
   * old label survived under the key "lost", which no longer exists in the
   * new list, so it was silently dropped -- and no entry was created for
   * the new "Lost" key either, since nothing in the fresh submission ever
   * supplies one. Mirrors pipeline.ts's carryForwardLabels (round 947):
   * each NEW value's label is looked up by exact match first, falling back
   * to a case-insensitive match against the OLD enumLabels keys, so a
   * case-only rename carries its label forward onto the new key instead of
   * losing it. Only a genuinely removed value (no match either way) drops
   * its label; a genuinely new value stays unlabeled, same as before.
   */
  /** Round 960: same withIdempotency() extension as the entity-label PATCH route above -- see its own doc comment. */
  router.patch(
    "/projects/:id/entities/:entityName/fields/:fieldName/type",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot change a field's type after the project has already been built", "FIELD_EDIT_AFTER_BUILD");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = SetFieldTypeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      if (parsed.data.type === "relation" && !project.spec.entities.some((e) => e.name === parsed.data.relationTo)) {
        throw new HttpError(400, `"${parsed.data.relationTo}" is not an entity in this project`, "RELATION_TARGET_NOT_FOUND");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/entities/${req.params.entityName}/fields/${req.params.fieldName}/type`,
        async () => {
          const entity = findEntity(project, req.params.entityName);
          const field = findField(entity, req.params.fieldName);
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name
                ? {
                    ...e,
                    fields: e.fields.map((f) =>
                      f.name === field.name
                        ? {
                            ...f,
                            type: parsed.data.type,
                            enumValues: parsed.data.type === "enum" ? parsed.data.enumValues : undefined,
                            enumLabels:
                              parsed.data.type === "enum" && f.enumLabels
                                ? (() => {
                                    const prevLabelsByLowerValue = new Map(
                                      Object.entries(f.enumLabels!).map(([value, label]) => [value.toLowerCase(), label]),
                                    );
                                    const next: Record<string, string> = {};
                                    for (const value of parsed.data.enumValues!) {
                                      const label = f.enumLabels![value] ?? prevLabelsByLowerValue.get(value.toLowerCase());
                                      if (label !== undefined) next[value] = label;
                                    }
                                    return next;
                                  })()
                                : undefined,
                            relationTo: parsed.data.type === "relation" ? parsed.data.relationTo : undefined,
                          }
                        : f,
                    ),
                  }
                : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * The spec review screen's "roles" chips and "assumptions" list (both
   * plain string[] on the spec, set once by spec generation) were
   * otherwise entirely static -- no way to correct a role or assumption
   * the AI/heuristic engine got wrong before committing to a build. Same
   * direct updateProjectSpec write as the label routes above, just
   * filtering an index out of a string[] instead of editing an object
   * field. Deliberately DELETE-by-index rather than a full-array PUT: the
   * UI only ever removes one chip/item at a time, and index-based removal
   * means a stale client array can't accidentally resurrect an item
   * someone else just removed. No project.status check (unlike the record
   * routes below) since this edits the spec itself, the same as the label
   * routes -- available before a project is even built, when it's most
   * useful for catching a wrong assumption early. Unlike assumptions,
   * `roles` carries `.min(1)` on ProductSpecSchema (see that schema's own
   * comment -- every stored spec is re-validated against it on every read),
   * so removing the very last role would otherwise pass this route's own
   * checks and then blow up inside updateProjectSpec's schema validation as
   * an uncaught 500 -- guarded explicitly below instead, with a clear 400.
   *
   * Removal alone was one-directional: once the heuristic engine missed a
   * role entirely (e.g. a two-sided marketplace where it only spotted
   * "Buyer"), or missed an assumption worth recording, there was no way to
   * add one back short of restarting the whole spec. These two POST
   * routes are the other half of the same correction workflow -- append
   * one trimmed string to the array and persist through the same
   * updateProjectSpec path, no schema/status checks needed since any
   * non-empty string is a valid role or assumption.
   */
  /**
   * Round 473 extends the same withIdempotency() mechanism (round 471's
   * POST /projects, round 472's from-template/clone) to this append route
   * -- the design doc's own "append-only gap": a retry landing after the
   * first append already finished would otherwise append the identical
   * role a second time.
   */
  router.post(
    "/projects/:id/roles",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as the entity/field-label routes above --
      // this is another direct read-project.spec-then-write-it-back edit,
      // the exact shape /build/refine/answers/restore are already guarded
      // against.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${project.id}/roles`, async () => {
        const nextSpec = { ...project.spec, roles: [...project.spec.roles, parsed.data.role] };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** See POST /projects/:id/roles's own doc comment just above -- same extension, same reasoning. */
  router.post(
    "/projects/:id/assumptions",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddAssumptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${project.id}/assumptions`, async () => {
        const nextSpec = { ...project.spec, assumptions: [...project.spec.assumptions, parsed.data.assumption] };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * Round 775: `personas` is the one spec-level string[] (ProductSpecSchema,
   * alongside roles/assumptions) that was generated by both spec providers
   * and persisted, but had no correction path at all -- no render on the
   * Spec Review screen, and (until this route) no API endpoint to write one
   * either. See its own doc comment where it's rendered in App.tsx for the
   * full gap. Same extension, same reasoning as /roles and /assumptions
   * above; personas carries no `.min(1)` floor on ProductSpecSchema (an
   * empty personas array is always valid, unlike roles), so there's no
   * last-item guard to mirror from the roles DELETE route below.
   */
  router.post(
    "/projects/:id/personas",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddPersonaSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${project.id}/personas`, async () => {
        const nextSpec = { ...project.spec, personas: [...project.spec.personas, parsed.data.persona] };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * Round 943: same withIdempotency() extension, and the same reason, as
   * the entity/field DELETE routes above (round 941) -- fetchWithWakeRetry
   * (apps/web/src/wakeRetry.ts) retries on ANY thrown fetch() error, so a
   * response lost in transit after this role was already removed meant the
   * retry's own assertIndexStillMatches ran against the already-shortened
   * list and threw a confusing ROLE_STALE_INDEX for a removal that, from
   * the user's point of view, already fully succeeded. parseListIndex/
   * assertIndexStillMatches and the last-item check all move inside the
   * withIdempotency callback -- not stay where they were, above -- so a
   * genuine retry replays the first call's cached success instead of
   * re-running them against spec state the first call already changed.
   */
  router.delete(
    "/projects/:id/roles/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `DELETE /projects/${project.id}/roles/${req.params.index}`, async () => {
        const index = parseListIndex(req.params.index, project.spec.roles, "ROLE_NOT_FOUND");
        assertIndexStillMatches(project.spec.roles, index, (req.body as { expect?: unknown })?.expect, "ROLE_STALE_INDEX");
        if (project.spec.roles.length <= 1) {
          throw new HttpError(400, "Cannot remove the last remaining role -- at least one role is required", "VALIDATION_ERROR");
        }
        const nextSpec = { ...project.spec, roles: project.spec.roles.filter((_, i) => i !== index) };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** Round 943: same withIdempotency() extension as the roles DELETE route just above -- see its own doc comment. */
  router.delete(
    "/projects/:id/assumptions/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/assumptions/${req.params.index}`,
        async () => {
          const index = parseListIndex(req.params.index, project.spec.assumptions, "ASSUMPTION_NOT_FOUND");
          assertIndexStillMatches(
            project.spec.assumptions,
            index,
            (req.body as { expect?: unknown })?.expect,
            "ASSUMPTION_STALE_INDEX",
          );
          const nextSpec = { ...project.spec, assumptions: project.spec.assumptions.filter((_, i) => i !== index) };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * See POST /projects/:id/personas's own doc comment above -- same
   * extension, same reasoning. No last-item guard: personas carries no
   * `.min(1)` floor. Round 943: same withIdempotency() extension as the
   * roles/assumptions DELETE routes above -- see their own doc comment.
   */
  router.delete(
    "/projects/:id/personas/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/personas/${req.params.index}`,
        async () => {
          const index = parseListIndex(req.params.index, project.spec.personas, "PERSONA_NOT_FOUND");
          assertIndexStillMatches(project.spec.personas, index, (req.body as { expect?: unknown })?.expect, "PERSONA_STALE_INDEX");
          const nextSpec = { ...project.spec, personas: project.spec.personas.filter((_, i) => i !== index) };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Remove-then-re-add was the only way to fix a typo or wording in an
   * existing role/assumption -- correct in the end, but it also silently
   * moved the item to the end of its own list (a new POST always appends)
   * and briefly violated roles' own .min(1) floor if it was the last one.
   * Reuses AddRoleSchema/AddAssumptionSchema verbatim (same {role: string}/
   * {assumption: string} shape a rename body needs) rather than declaring
   * a near-duplicate schema. In-place index replacement via .map, mirroring
   * renameFieldLabel's own PATCH-by-identity approach above.
   */
  /**
   * Round 943: same withIdempotency() extension, and the same reason, as
   * the DELETE roles route above -- a lost response after a successful
   * rename meant a retry's assertIndexStillMatches compared its `expect`
   * (the OLD value) against the list which, post-rename, now holds the NEW
   * value at that index -- the same confusing ROLE_STALE_INDEX for a rename
   * that already fully succeeded. parseListIndex/assertIndexStillMatches
   * move inside the callback for the same reason as the DELETE route;
   * AddRoleSchema's own body-shape validation stays outside, matching the
   * add-field route's own convention (deterministic, side-effect-free, so
   * safe to re-run even on a retry that the idempotency wrap short-circuits
   * before ever reaching here).
   */
  router.patch(
    "/projects/:id/roles/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `PATCH /projects/${project.id}/roles/${req.params.index}`, async () => {
        const index = parseListIndex(req.params.index, project.spec.roles, "ROLE_NOT_FOUND");
        assertIndexStillMatches(project.spec.roles, index, (req.body as { expect?: unknown })?.expect, "ROLE_STALE_INDEX");
        const nextSpec = { ...project.spec, roles: project.spec.roles.map((r, i) => (i === index ? parsed.data.role : r)) };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** Round 943: same withIdempotency() extension as the roles PATCH route just above -- see its own doc comment. */
  router.patch(
    "/projects/:id/assumptions/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddAssumptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/assumptions/${req.params.index}`,
        async () => {
          const index = parseListIndex(req.params.index, project.spec.assumptions, "ASSUMPTION_NOT_FOUND");
          assertIndexStillMatches(
            project.spec.assumptions,
            index,
            (req.body as { expect?: unknown })?.expect,
            "ASSUMPTION_STALE_INDEX",
          );
          const nextSpec = {
            ...project.spec,
            assumptions: project.spec.assumptions.map((a, i) => (i === index ? parsed.data.assumption : a)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * See the roles/assumptions PATCH routes' own doc comment above -- same
   * extension, same reasoning. Reuses AddPersonaSchema verbatim for the
   * rename body, same as roles/assumptions reuse their own add schemas.
   * Round 943: same withIdempotency() extension as the roles/assumptions
   * PATCH routes above -- see their own doc comment.
   */
  router.patch(
    "/projects/:id/personas/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddPersonaSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/personas/${req.params.index}`,
        async () => {
          const index = parseListIndex(req.params.index, project.spec.personas, "PERSONA_NOT_FOUND");
          assertIndexStillMatches(project.spec.personas, index, (req.body as { expect?: unknown })?.expect, "PERSONA_STALE_INDEX");
          const nextSpec = {
            ...project.spec,
            personas: project.spec.personas.map((p, i) => (i === index ? parsed.data.persona : p)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * The spec review screen's "entities" section (the list of screens the
   * AI Team is about to build) was the one part of the spec review page
   * with no correction path at all -- roles and assumptions each got a
   * real remove button, but an entity the heuristic/AI invented that
   * doesn't belong (an unwanted "Courier" screen on a business with no
   * delivery, say) could only be talked out of existence via the free-text
   * "additional request" box and hoping the next build actually drops it --
   * never a guaranteed, immediate removal. Removes by entityName (not
   * index, unlike roles/assumptions above) since EntitySchema names are
   * already the real unique identifier every other route in this file
   * addresses an entity by. Same `entities: z.array(EntitySchema).min(1)`
   * floor on ProductSpecSchema as roles' own `.min(1)` -- guarded the same
   * way, with a clear 400 instead of an uncaught schema-validation 500.
   * Gated to a project that hasn't been built yet: once built, this
   * spec-review screen is never shown again and the real database table,
   * generated code, and routes for that entity already exist -- removing
   * it from the spec alone would silently desync the spec from the actual
   * running app instead of actually undoing anything.
   */
  /**
   * Round 941: the sibling POST (add) route just below already got
   * withIdempotency protection; this one never did. Unlike add, a
   * retried delete doesn't just risk a no-op -- the exact round-792
   * hazard round already fixed for record deletion, just missed here:
   * fetchWithWakeRetry (apps/web/src/wakeRetry.ts) retries on ANY
   * thrown fetch() error, not only a Render cold start, so a response
   * lost in transit AFTER this entity was already removed means the
   * retry's own "not found" check below throws ENTITY_NOT_FOUND for a
   * removal that, from the user's point of view, already fully
   * succeeded. The "not found" check itself has to move inside the
   * withIdempotency callback (not stay where it was, above) so a
   * genuine retry replays the first call's cached success instead of
   * re-running against spec state the first call already changed.
   */
  router.delete(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot remove a screen after the project has already been built", "ENTITY_REMOVAL_AFTER_BUILD");
      }
      // Same activePipelines guard /build itself already has (see its own
      // comment) -- an in-flight /build on this still-unbuilt project reads
      // project.spec at its own start and only writes its result back once
      // the whole pipeline finishes, so this removal would otherwise be
      // silently reverted (or, worse, removing an entity the pipeline is
      // mid-migration on) the moment that build completes.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/entities/${req.params.entityName}`,
        async () => {
          if (!project.spec.entities.some((e) => e.name === req.params.entityName)) {
            throw new HttpError(404, "No such screen in this project's spec", "ENTITY_NOT_FOUND");
          }
          if (project.spec.entities.length <= 1) {
            throw new HttpError(400, "Cannot remove the last remaining screen -- at least one is required", "VALIDATION_ERROR");
          }
          const dependent = project.spec.entities.find(
            (e) => e.name !== req.params.entityName && e.fields.some((f) => f.type === "relation" && f.relationTo === req.params.entityName),
          );
          if (dependent) {
            throw new HttpError(
              400,
              `Cannot remove this screen -- "${dependent.label ?? dependent.name}" still links to it`,
              "ENTITY_HAS_DEPENDENT_RELATIONS",
            );
          }
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.filter((e) => e.name !== req.params.entityName),
            screens: project.spec.screens.filter((s) => s.entity !== req.params.entityName),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * The other direction of the same gap the comment above describes --
   * removal alone was one-directional. If the heuristic/AI engine missed a
   * whole screen entirely (a two-sided marketplace where it only spotted
   * "Order", say, and never "Payment"), there was no way to add it back
   * short of a full Refine round-trip after committing to a build, or
   * talking it into existence via the free-text "additional request" box
   * and hoping the regenerated spec actually includes it. Mirrors
   * AddRoleForm/AddAssumptionForm's own shape (a single free-text field,
   * appended), but an entity needs more than a bare string to satisfy
   * EntitySchema -- `deriveEntityName` turns the typed label into a valid
   * ASCII table-name `name`, and the new entity gets the same single
   * required "name" text field every domain-library entity starts with
   * (see domainEntities.ts), rather than being born with zero fields and
   * failing `fields.min(1)`. Same pre-build-only gate as the DELETE route
   * above, for the same reason: once built, the real database table and
   * generated code already exist and don't track further spec edits.
   */
  /** Same withIdempotency() extension as POST /projects/:id/roles above -- see its own doc comment. */
  router.post(
    "/projects/:id/entities",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot add a screen after the project has already been built", "ENTITY_ADD_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-removal route above -- see
      // its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddEntitySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${project.id}/entities`, async () => {
        const name = deriveEntityName(parsed.data.label, project.spec.entities.map((e) => e.name));
        const newEntity: Entity = {
          name,
          label: parsed.data.label,
          fields: [{ name: "name", type: "text", required: true }],
        };
        const newScreens = deriveScreensForNewEntity(name, project.spec.entities, project.spec.screens);
        const nextSpec = {
          ...project.spec,
          entities: [...project.spec.entities, newEntity],
          screens: [...project.spec.screens, ...newScreens],
        };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * The other half of the same one-directional gap entities themselves had
   * before the add route above -- roles, assumptions, and whole entities
   * all got a real add/remove/rename correction path on the spec review
   * screen, but a single *field* within an entity had none at all: the
   * only field-level mutation anywhere in the app was renameFieldLabel
   * (cosmetic label-only). An AI/heuristic-mis-scoped entity missing an
   * obvious field (no "email" on a Customer, say), or one that needed a
   * real type/required flag the engine didn't propose, could only be
   * fixed via a full natural-language Refine round-trip after committing
   * to a build. type/required/enumValues default to the original plain
   * optional text field when omitted (AddFieldSchema's own comment), so
   * nothing about an existing caller's behavior changes; a relationTo is
   * validated against this project's own real entity names right here --
   * the one place with access to them -- and rejected with a clear 400
   * (not an uncaught schema throw) if it names an entity that doesn't
   * exist in this project. Uses deriveFieldName the same way the
   * entity-add route above uses deriveEntityName. Same pre-build-only
   * gate as entity/field-label routes: once built, the real database
   * column and generated code already exist and don't track further
   * spec edits.
   */
  /** Same withIdempotency() extension as POST /projects/:id/roles above -- see its own doc comment. */
  router.post(
    "/projects/:id/entities/:entityName/fields",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot add a field after the project has already been built", "FIELD_ADD_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-removal route above -- see
      // its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const entity = findEntity(project, req.params.entityName);
      const parsed = AddFieldSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      if (parsed.data.type === "relation" && !project.spec.entities.some((e) => e.name === parsed.data.relationTo)) {
        throw new HttpError(400, `"${parsed.data.relationTo}" is not an entity in this project`, "RELATION_TARGET_NOT_FOUND");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/entities/${entity.name}/fields`,
        async () => {
          const name = deriveFieldName(parsed.data.label, entity.fields.map((f) => f.name));
          const newField: Field = {
            name,
            label: parsed.data.label,
            type: parsed.data.type,
            required: parsed.data.required,
            ...(parsed.data.type === "enum" ? { enumValues: parsed.data.enumValues } : {}),
            ...(parsed.data.type === "relation" ? { relationTo: parsed.data.relationTo } : {}),
          };
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) => (e.name === entity.name ? { ...e, fields: [...e.fields, newField] } : e)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Removal side of the same gap. `entity.fields` carries EntitySchema's
   * own `fields.min(1)` floor (an entity with zero fields can't render a
   * record form at all), the same reasoning as roles'/entities' own
   * `.min(1)` guards above -- checked explicitly here for a clear 400
   * rather than an uncaught schema-validation error inside
   * updateProjectSpec. Same pre-build-only gate as every other
   * spec-shape-changing route in this file.
   *
   * Round 941: same withIdempotency() extension, and the same reason, as
   * the entity-removal DELETE route above -- see its own doc comment.
   * findField's own 404 is the retry-sensitive check here, so it (and
   * the mutation) moves inside the callback; findEntity stays outside,
   * same as the sibling add-field route just above, since it's needed
   * for the idempotency route key regardless.
   */
  router.delete(
    "/projects/:id/entities/:entityName/fields/:fieldName",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot remove a field after the project has already been built", "FIELD_REMOVE_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-removal route above -- see
      // its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const entity = findEntity(project, req.params.entityName);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/entities/${entity.name}/fields/${req.params.fieldName}`,
        async () => {
          findField(entity, req.params.fieldName);
          if (entity.fields.length <= 1) {
            throw new HttpError(400, "Cannot remove the last remaining field -- at least one is required", "VALIDATION_ERROR");
          }
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name ? { ...e, fields: e.fields.filter((f) => f.name !== req.params.fieldName) } : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  router.patch(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = parseRecordId(req.params.recordId);
      /**
       * Round 792: same withIdempotency extension as the DELETE route just
       * below's own doc comment -- a response lost in transit after
       * updateRecord already committed used to leave a retry free to run
       * updateRecord a second time. Re-sending the exact same body is
       * harmless on its own (the second run just rewrites the same value
       * back), but a genuinely different edit from someone else landing in
       * between the lost response and the retry is not: without this
       * guard, the retry would blindly re-apply its own stale body and
       * clobber that intervening edit back to the old value. With it, a
       * retry that matches an already-completed key never touches the
       * database again -- it just replays the cached response -- so a
       * collaborator's newer edit in between survives untouched.
       */
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/entities/${entity.name}/${recordId}`,
        async () => {
          const before = getRecord(db, project.id, entity, recordId);
          // Same FOREIGN KEY constraint translation as the POST route above --
          // see its own comment for why this is reachable through the real UI.
          let record: ReturnType<typeof updateRecord>;
          try {
            record = updateRecord(db, project.id, entity, recordId, req.body ?? {});
          } catch (err) {
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              throw new HttpError(
                400,
                "This record references another record that no longer exists",
                "INVALID_RELATION_TARGET",
              );
            }
            throw err;
          }
          // Fire-and-forget, same reasoning as runAutomationsForRecordChange
          // just below -- a filesystem delete must never add latency to, or
          // ever fail, the response this update already succeeded at. Fired
          // inside this callback (never reached on a replayed/cached retry),
          // the same convention the create-record route's own automations
          // call already established.
          void deleteReplacedFileFields(uploadsDir, project.id, entity, before, record);
          // Same X-Suppress-Automations escape hatch as the POST route above --
          // see its own comment. CSV import now PATCHes a row whose id matched
          // an existing record (see EntityPanel.tsx's handleImportFile) instead
          // of always POSTing a duplicate, and that bulk re-import is exactly
          // as automation-unsafe on the update side as it is on the create
          // side: a spreadsheet of hundreds of pre-existing customers,
          // re-imported after a bulk edit, must not fire a "record_updated"
          // WhatsApp rule for every single one of them at once.
          if (req.header("X-Suppress-Automations") !== "true") {
            void runAutomationsForRecordChange(
              db,
              whatsapp,
              emailSender,
              project,
              entity,
              "updated",
              record,
              computeChangedFields(entity, before, record),
              uploadsDir,
              `${req.protocol}://${req.get("host")}`,
            );
          }
          return { status: 200, body: { record } };
        },
      );
      res.status(status).json(body);
    }),
  );

  router.delete(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = parseRecordId(req.params.recordId);
      /**
       * Round 792: every other real-effect mutation on a record (create,
       * update) already got withIdempotency protection (rounds 471-594) --
       * this delete route was missed, and unlike create/update, a retried
       * delete doesn't just risk a no-op or a harmless re-apply: deleteRecord
       * (repository.ts) throws NotFoundError once the row is actually gone,
       * which this route has no special case for, so it propagates as a
       * real 404. fetchWithWakeRetry (apps/web/src/wakeRetry.ts) retries on
       * ANY thrown fetch() error, not just a cold start -- a response lost
       * in transit after the server already deleted the row (a dropped
       * connection is a realistic Wi-Fi/mobile blip, not only Render's
       * cold-start case this mechanism was built for) means the retry lands
       * on an already-deleted row and gets back a confusing "not found"
       * error for a delete that, from the user's own point of view, already
       * fully succeeded -- EntityPanel.tsx's commitPendingDelete then
       * restores the (already gone) row into the UI and shows that error.
       */
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/entities/${entity.name}/${recordId}`,
        async () => {
          // Fetched before the delete below purely so a `file`-type field's
          // own upload can be cleaned up afterward (see
          // deleteReplacedFileFields) -- `undefined` here just means the
          // delete itself is about to 404, same as always.
          const before = getRecord(db, project.id, entity, recordId);
          /**
           * `PRAGMA foreign_keys = ON` (connection.ts) makes deleting a record
           * another record still points to via a `relation` field throw a real
           * "FOREIGN KEY constraint failed" error from node:sqlite -- app.ts's
           * generic error handler turned that into an unexplained 500 before
           * this, with EntityPanel.tsx's own deferred-delete undo window
           * (round 108-ish) silently swallowing the failure entirely (its
           * `.catch(() => {})`, fixed the same round as this), so the user saw
           * the row vanish and then quietly reappear on next refresh with no
           * error ever shown. Translated into an actionable 409 here instead,
           * the same route-level pattern as EXPORT_UNSAFE_IDENTIFIER (round 284).
           */
          try {
            deleteRecord(db, project.id, entity, recordId);
          } catch (err) {
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              throw new HttpError(
                409,
                "Cannot delete this record -- another record still references it through a relation field",
                "RECORD_HAS_DEPENDENT_RECORDS",
              );
            }
            throw err;
          }
          // Round 969: "record_deleted" rules fire here, off the same
          // `before` snapshot just used for file cleanup below -- it's the
          // only state a deleted row has left to interpolate a message or
          // resolve a toMode:"field" destination from (fireRule never
          // re-reads the record from the database). Deliberately no
          // X-Suppress-Automations check here, unlike the create/update
          // routes' own CSV-import-specific escape hatch -- there's no bulk-
          // delete-via-backfill-import path at all (EntityPanel.tsx's own
          // bulk-delete calls this exact single-record route once per row,
          // the same way its bulk-duplicate already fires one
          // "record_created" automation per duplicated row with no
          // suppression), so a deliberate multi-select delete firing one
          // "record_deleted" automation per record is the same intentional
          // behavior as every other bulk *user* action already is, not the
          // backfill-of-pre-existing-data case suppression exists for.
          //
          // Round 1015: this used to fire alongside deleteReplacedFileFields
          // below as two independent, unsequenced fire-and-forget calls off
          // the identical `before` snapshot -- but a "record_deleted" rule
          // referencing a file field can genuinely read that file back off
          // disk (fireEmailAction's own `await readFile`, and the WhatsApp
          // branch's identical `await readFile` inside whatsappWeb.ts's
          // sendMessage), and deleteReplacedFileFields's own
          // deleteUploadedFile does a genuine `await rm` against that exact
          // same path (newRecord is null here, so EVERY file field on
          // `before` gets unlinked, not just a changed one the way the
          // PATCH route's own call further below only ever deletes a file
          // that differs from -- and so never collides with -- whatever the
          // post-update record's automations might read). Firing both
          // unsequenced raced the unlink against the read at the libuv
          // threadpool level: whichever completed first decided, with no
          // relation to the data, whether a "record_deleted" email/WhatsApp
          // automation shipped with its file attached or silently degraded
          // to plain text (the same already-accepted degradation
          // findTemplateFileAttachment's own doc comment describes for a
          // genuinely stale reference, just reached nondeterministically
          // here instead). Chaining the cleanup after the automations run
          // via `.finally` -- so a rejected/failed automations run still
          // lets cleanup proceed -- guarantees every automation's own file
          // read happens before the unlink, without this route ever
          // awaiting either call itself: the response below still returns
          // before any of this settles.
          const automationsRun = before
            ? runAutomationsForRecordChange(db, whatsapp, emailSender, project, entity, "deleted", before, new Set(), uploadsDir, `${req.protocol}://${req.get("host")}`)
            : Promise.resolve();
          // Fire-and-forget, same reasoning as the PATCH route's own call --
          // a filesystem delete must never add latency to this response.
          // Fired inside this callback (never reached on a replayed/cached
          // retry), the same convention the create-record route's own
          // automations call already established.
          if (before) void automationsRun.finally(() => deleteReplacedFileFields(uploadsDir, project.id, entity, before, null));
          return { status: 204, body: null };
        },
      );
      res.status(status).end();
    }),
  );

  /**
   * Automation rules: "when a record in this entity is created, or a
   * field on it is set to a given value, send a WhatsApp message" -- the
   * if-this-then-that layer on top of this app's existing WhatsApp
   * integration. Storage lives in packages/db/src/automations.ts;
   * evaluation and firing happens in automations.ts (this package),
   * invoked fire-and-forget from the record create/update routes above.
   * Access level matches the WhatsApp send route (requireProjectAccess,
   * not requireProjectOwner) -- any collaborator who can edit records can
   * already cause the same WhatsApp sends these rules automate.
   *
   * Round 975: that reasoning only ever covered an editor collaborator --
   * a "viewer" categorically can't edit records (requireProjectWriteAccess
   * blocks every write route, this list's own POST/PATCH/DELETE siblings
   * included), so they can never cause the same side effect, yet
   * requireProjectAccess above lets them through to this GET anyway.
   * `webhookSecret` is a real external credential (sent as `Authorization:
   * Bearer <webhookSecret>` to a third-party webhook destination -- see
   * AutomationRule's own doc comment in packages/db/src/automations.ts),
   * not project data in the ordinary sense -- unlike every other field on
   * a rule, reading it lets its holder act against that external system
   * entirely outside this app, well past what "view only, can't make
   * changes" is supposed to mean. Redacted to null for a viewer; an owner
   * or editor collaborator (who could just edit the rule to reveal it, or
   * already cause the identical webhook POST by editing a record) sees it
   * unchanged, exactly as before this round.
   */
  router.get(
    "/projects/:id/automations",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const isViewer = project.ownerId !== req.userId && getCollaboratorRole(db, project.id, req.userId!) === "viewer";
      // Round 959: hasTooManyConsecutiveFailuresToday's own cap (rounds
      // 924/934/951) was always computed and acted on server-side, but
      // never surfaced -- only a "schedule"-trigger rule is ever checked
      // against it (runScheduledAutomationsCheck only consults
      // listEnabledScheduledRules), so computing it for a record_created/
      // field_equals rule would show a meaningless, never-consulted value.
      const now = new Date();
      const rules = listAutomationRules(db, project.id).map((rule) => ({
        ...rule,
        webhookSecret: isViewer ? null : rule.webhookSecret,
        pausedForToday: rule.trigger === "schedule" && rule.enabled ? hasTooManyConsecutiveFailuresToday(db, rule, now) : false,
      }));
      res.json({ rules });
    }),
  );

  /**
   * A rule's own lastTriggeredAt/lastStatus/lastError (already in the
   * list above) only ever shows the single most recent firing -- a rule
   * that failed repeatedly and then happened to succeed on its latest
   * attempt looks perfectly healthy. This surfaces the real history
   * (packages/db/src/automations.ts's own automation_runs table,
   * populated by recordAutomationRun alongside its existing rule-row
   * update) so a user can actually tell a flaky rule apart from a
   * reliable one. Same access level as the rule list itself.
   */
  router.get(
    "/projects/:id/automations/:ruleId/runs",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const rule = getAutomationRule(db, project.id, req.params.ruleId);
      if (!rule) {
        throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
      }
      res.json({ runs: listAutomationRuns(db, project.id, rule.id) });
    }),
  );

  /**
   * Round 971: a record-triggered rule (record_created/field_equals/
   * record_deleted) gets exactly ONE delivery attempt -- unlike a
   * "schedule" rule, which isScheduledRuleDue's own doc comment
   * documents as deliberately retrying on every subsequent tick until a
   * run actually succeeds. A webhook destination that was briefly down,
   * or a transient WhatsApp socket hiccup, permanently loses that one
   * business event's notification with no recourse before this route --
   * the owner's only way to even notice was reading the failed run's own
   * `lastError` in the History list after the fact.
   *
   * Re-fires the SAME rule against the record's CURRENT state, via the
   * exact same fireRule this run originally went through -- automation_runs
   * stores no snapshot of the record's values at the time it originally
   * fired (only a reference to which record it was, see AutomationRun's
   * own doc comment), so a retry necessarily uses whatever that record
   * looks like now, not what it looked like at the original failure.
   *
   * Round 972: round 971's own original comment here claimed a
   * "schedule" rule's run (recordId always null -- there's no triggering
   * record at all) "already retries automatically" and so needed no
   * manual path -- true of the periodic scheduler's own per-tick
   * isScheduledRuleDue check, but NOT once hasTooManyConsecutiveFailuresToday
   * has tripped: runScheduledAutomationsCheck's own loop then skips
   * calling fireScheduledRule for that rule entirely for the rest of the
   * day (see that function's own doc comment), so no new run is ever
   * recorded to clear the pause, and nothing else anywhere calls
   * fireScheduledRule -- confirmed via grep, it has exactly one call
   * site. A user who fixes the actual problem (reconnects WhatsApp, fixes
   * a webhook URL) had no way to make a once-daily report go out before
   * tomorrow's UTC rollover. A schedule rule's own failed run is now
   * retried too, via fireScheduledRule directly (bypassing that same-day
   * cap for this one explicit, manual attempt only -- the cap only ever
   * governs the automatic per-tick loop) -- a successful retry's own new
   * "sent" run is also the newest run hasTooManyConsecutiveFailuresToday
   * looks at, so it naturally un-pauses the rest of today's automatic
   * ticks too, with no separate "clear the pause" step needed.
   *
   * The one case left with nothing to retry at all, rejected with 400: a
   * run with a null recordId whose rule is NOT "schedule" -- only
   * possible for a run recorded before this column existed at all, for
   * which no record reference was ever captured to resend against. Same
   * write-access level and rate limiter as the manual WhatsApp send
   * route, since this can cause the identical real send/webhook-POST
   * side effect.
   */
  router.post(
    "/projects/:id/automations/:ruleId/runs/:runId/retry",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const rule = getAutomationRule(db, project.id, req.params.ruleId);
      if (!rule) {
        throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
      }
      const run = getAutomationRun(db, project.id, rule.id, req.params.runId);
      if (!run) {
        throw new HttpError(404, `Automation run "${req.params.runId}" not found`, "AUTOMATION_RUN_NOT_FOUND");
      }
      if (run.status !== "failed") {
        throw new HttpError(400, "Only a failed run can be retried", "AUTOMATION_RUN_NOT_FAILED");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      if (run.recordId === null) {
        if (rule.trigger !== "schedule") {
          throw new HttpError(
            400,
            "This run has no record to retry against -- it was recorded before this app could track which record triggered a run, so there's no current data left to resend",
            "AUTOMATION_RUN_NOT_RETRYABLE",
          );
        }
        const { status, body } = await withIdempotency(
          db,
          idempotencyKey,
          req.userId!,
          `POST /projects/${project.id}/automations/${rule.id}/runs/${run.id}/retry`,
          async () => {
            await fireScheduledRule(db, whatsapp, emailSender, project, rule);
            const [latestRun] = listAutomationRuns(db, project.id, rule.id, 1);
            return { status: 200, body: { run: latestRun ?? null } };
          },
        );
        res.status(status).json(body);
        return;
      }
      const entity = findEntity(project, rule.entityName);
      // Round 991: unlike record_created/field_equals, a "record_deleted"
      // rule's own triggering event IS that record's deletion -- getRecord
      // below is GUARANTEED to find nothing for one of these, every single
      // time, not just occasionally, so retrying one could never have
      // worked at all before recordSnapshot existed to replay against
      // instead. See AutomationRun.recordSnapshot's own doc comment
      // (packages/db/src/automations.ts) for why this is captured only for
      // this one trigger -- record_created/field_equals still intentionally
      // re-fetch the record's CURRENT state below, unchanged.
      let record: EntityRecord;
      if (rule.trigger === "record_deleted") {
        if (!run.recordSnapshot) {
          throw new HttpError(
            404,
            "This run fired before its triggering record's data was saved for retry, so there's nothing left to resend",
            "AUTOMATION_RUN_RECORD_GONE",
          );
        }
        record = JSON.parse(run.recordSnapshot) as EntityRecord;
      } else {
        const current = getRecord(db, project.id, entity, run.recordId);
        if (!current) {
          throw new HttpError(404, "The record this automation would send no longer exists", "AUTOMATION_RUN_RECORD_GONE");
        }
        record = current;
      }
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/automations/${rule.id}/runs/${run.id}/retry`,
        async () => {
          await fireRule(db, whatsapp, emailSender, project, entity, rule, record, uploadsDir, `${req.protocol}://${req.get("host")}`);
          const [latestRun] = listAutomationRuns(db, project.id, rule.id, 1);
          return { status: 200, body: { run: latestRun ?? null } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Round 997: before this route, the ONLY way to ever find out whether a
   * newly-created rule's destination/credentials/template actually work
   * was to wait for a real trigger event (create/update/delete a record,
   * or wait for a schedule rule's own next due time) and then check the
   * run history after the fact -- a brand-new "send_email" or "webhook"
   * rule (rounds 974/996) in particular has no WhatsApp-connection
   * precondition forcing an early sanity check the way send_whatsapp
   * does, so a typo'd webhook URL or email address could sit silently
   * broken for however long until its trigger condition first fires for
   * real. This fires the SAME single-attempt logic the retry route above
   * and the real triggers both go through (fireRule/fireScheduledRule),
   * on demand, against real data -- not a separate "dry run" path that
   * could drift from what actually fires in production.
   *
   * A "schedule" rule has no triggering record at all (same as its own
   * real firing), so it's tested exactly like the retry route's own
   * null-recordId branch above: fireScheduledRule directly, bypassing
   * isScheduledRuleDue/hasTooManyConsecutiveFailuresToday entirely, same
   * precedent round 972's retry route already established for this exact
   * bypass. Every other trigger needs a real record to interpolate
   * {{field}} placeholders and resolve a toMode:"field" destination from
   * -- uses the entity's own most-recently-created record (listRecords is
   * already ORDER BY id DESC, so `[0]` is cheap, no extra query), and
   * rejects with a clear, specific error when the entity has no records
   * at all yet rather than a confusing one further down the call chain.
   */
  router.post(
    "/projects/:id/automations/:ruleId/test",
    whatsappRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const rule = getAutomationRule(db, project.id, req.params.ruleId);
      if (!rule) {
        throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      if (rule.trigger === "schedule") {
        const { status, body } = await withIdempotency(
          db,
          idempotencyKey,
          req.userId!,
          `POST /projects/${project.id}/automations/${rule.id}/test`,
          async () => {
            await fireScheduledRule(db, whatsapp, emailSender, project, rule);
            const [latestRun] = listAutomationRuns(db, project.id, rule.id, 1);
            return { status: 200, body: { run: latestRun ?? null } };
          },
        );
        res.status(status).json(body);
        return;
      }
      const entity = findEntity(project, rule.entityName);
      // Round 998: a record-triggered rule can be created before the
      // project is ever built (rule creation itself has no project.status
      // guard, same as every other automation route -- an intentional,
      // already-tested pattern: pre-configuring automations ahead of the
      // first build), in which case this entity's own real per-project SQL
      // table (only ever created by diffAndMigrate, from the build/refine
      // pipeline) genuinely doesn't exist yet. Checked here, not with a
      // blanket route-level guard, and folded into the exact same "no
      // records yet" outcome right below -- from this route's own point of
      // view the two situations are functionally identical (there is
      // nothing to test against), and every other automation route stays
      // fully usable on a not-yet-built project exactly as before.
      // Before this check, calling this route for any trigger other than
      // "schedule" against such a project threw a raw, uncaught
      // `SqliteError: no such table`, surfaced as a generic 500 instead of
      // this same clean, already-documented 400.
      const record = project.status === "built" ? listRecords(db, project.id, entity)[0] : undefined;
      if (!record) {
        throw new HttpError(
          400,
          `There are no ${entity.label} records yet to test this rule against -- create one first, then try again`,
          "AUTOMATION_TEST_NO_RECORDS",
        );
      }
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/automations/${rule.id}/test`,
        async () => {
          await fireRule(db, whatsapp, emailSender, project, entity, rule, record, uploadsDir, `${req.protocol}://${req.get("host")}`);
          const [latestRun] = listAutomationRuns(db, project.id, rule.id, 1);
          return { status: 200, body: { run: latestRun ?? null } };
        },
      );
      res.status(status).json(body);
    }),
  );

  router.post(
    "/projects/:id/entities/:entityName/automations",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const entity = findEntity(project, req.params.entityName);
      const parsed = CreateAutomationRuleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const data = parsed.data;
      if (data.trigger === "field_equals" && data.fieldName) {
        const field = findField(entity, data.fieldName);
        if (data.fieldValue) validateAutomationFieldValue(field, data.fieldValue);
      }
      if (data.toMode === "field" && data.toField) {
        validateAutomationToField(findField(entity, data.toField));
      }
      /**
       * Round 600: the one insert route in this feature docs/wakeRetry-
       * idempotency-design.md never listed, since Automation Rules was
       * added out-of-band well after that inventory was written -- every
       * other real-effect POST in this file got withIdempotency protection
       * in rounds 471-528/594, but creating an automation rule was missed.
       * Without this, a response lost in transit after insertAutomationRule
       * already committed (the same fetchWithWakeRetry retry-on-any-thrown-
       * fetch-error case round 594 fixed for record creation) produced a
       * second, fully duplicate rule -- which then double-sends the same
       * WhatsApp message on every subsequent real trigger, since
       * runAutomationsForRecordChange fires each enabled rule independently
       * with no dedup across rules of identical content.
       */
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/entities/${entity.name}/automations`,
        async () => {
          const rule = insertAutomationRule(db, {
            projectId: project.id,
            entityName: entity.name,
            trigger: data.trigger,
            fieldName: data.fieldName ?? null,
            fieldValue: data.fieldValue ?? null,
            scheduleTimeUtc: data.scheduleTimeUtc ?? null,
            scheduleDaysOfWeek: data.scheduleDaysOfWeek ?? null,
            scheduleTimezone: data.scheduleTimezone ?? null,
            actionType: data.actionType,
            toMode: data.toMode,
            toNumber: data.toNumber ?? null,
            toField: data.toField ?? null,
            webhookUrl: data.webhookUrl ?? null,
            webhookSecret: data.webhookSecret ?? null,
            toEmail: data.toEmail ?? null,
            emailSubject: data.emailSubject ?? null,
            messageTemplate: data.messageTemplate,
          });
          return { status: 201, body: { rule } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Round 953: same withIdempotency() extension, and the same reason, as
   * the roles/assumptions/personas PATCH routes above (round 943) -- this
   * feature's own sibling POST (create) route already got it in round
   * 600, but PATCH/DELETE were missed. fetchWithWakeRetry retries on ANY
   * thrown fetch() error, so a response lost in transit after this update
   * already succeeded meant a retry re-read the now-already-patched rule
   * as `existing`, re-applied the same patch on top of itself (harmless
   * for most fields, but re-running validateAutomationFieldValue/
   * validateAutomationToField against already-current data is redundant
   * work this guards against needing to reason about) and risked clobbering
   * a genuinely different concurrent edit that landed in between. All of
   * `existing`/`next`-dependent validation and the mutation itself move
   * inside the withIdempotency callback -- not stay where they were, above
   * -- so a genuine retry replays the first call's cached success instead
   * of re-running them against state the first call already changed.
   * UpdateAutomationRuleSchema's own body-shape validation stays outside,
   * matching the roles/assumptions PATCH routes' own convention -- it's
   * deterministic and side-effect-free, so safe to re-run even though a
   * genuine retry never reaches it.
   */
  router.patch(
    "/projects/:id/automations/:ruleId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const parsed = UpdateAutomationRuleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `PATCH /projects/${project.id}/automations/${req.params.ruleId}`,
        async () => {
          const existing = getAutomationRule(db, project.id, req.params.ruleId);
          if (!existing) {
            throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
          }
          // Validate the merged result (the same `{ ...existing, ...patch }`
          // updateAutomationRule itself does), not just the patch in
          // isolation -- see findAutomationRuleInvariantViolation's own
          // comment for why a patch-only check would miss an inconsistency
          // this merge creates against a field the patch doesn't even touch.
          const next = { ...existing, ...parsed.data };
          const invariantError = findAutomationRuleInvariantViolation(next);
          if (invariantError) {
            throw new HttpError(400, invariantError, "VALIDATION_ERROR");
          }
          const entity = findEntity(project, existing.entityName);
          if (next.trigger === "field_equals" && next.fieldName) {
            const field = findField(entity, next.fieldName);
            if (next.fieldValue) validateAutomationFieldValue(field, next.fieldValue);
          }
          if (next.toMode === "field" && next.toField) {
            validateAutomationToField(findField(entity, next.toField));
          }
          try {
            const rule = updateAutomationRule(db, project.id, req.params.ruleId, parsed.data);
            return { status: 200, body: { rule } };
          } catch (err) {
            if (err instanceof NotFoundError) {
              throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
            }
            throw err;
          }
        },
      );
      res.status(status).json(body);
    }),
  );

  /** Round 953: same withIdempotency() extension as the PATCH route just above -- see its own doc comment. */
  router.delete(
    "/projects/:id/automations/:ruleId",
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/automations/${req.params.ruleId}`,
        async () => {
          try {
            deleteAutomationRule(db, project.id, req.params.ruleId);
          } catch (err) {
            if (err instanceof NotFoundError) {
              throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
            }
            throw err;
          }
          return { status: 204, body: null };
        },
      );
      res.status(status).end();
    }),
  );

  return router;
}
