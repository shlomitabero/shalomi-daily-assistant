import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import type { Entity, EntityRecord, Field, Project, Screen } from "@forge/shared";
import { CollaboratorRoleSchema, FIELD_TYPES, findOversizedGeneratedSpecField } from "@forge/shared";
import {
  tryGetCheckpoint,
  getProject,
  tryGetProject,
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
  recordCheckpointRestore,
  getLastCheckpointRestore,
  updateProjectName,
  updateProjectDescription,
  transferProjectOwnership,
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
  disableAutomationRulesForEntity,
  disableAutomationRulesForField,
  getOrCreateCalendarFeedToken,
  regenerateCalendarFeedToken,
  getOrCreateInboundWebhookToken,
  regenerateInboundWebhookToken,
  getLastInboundWebhookAt,
  getLastInboundWebhookFailure,
  isValidDateString,
  NotFoundError,
  insertRecordDeletion,
  listRecordDeletions,
  insertCollaboratorAccessChange,
  listCollaboratorAccessChanges,
  insertSchemaLabelEdit,
  listSchemaLabelEdits,
  insertAutomationRuleDeletion,
  listAutomationRuleDeletions,
  type ForgeDatabase,
  type AutomationTrigger,
  type AutomationToMode,
  type AutomationActionType,
  type AutomationFieldOperator,
} from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { enhancePrompt, generateSpec, isHebrewText, mergeRefinedSpec, TEMPLATES } from "@forge/spec-engine";
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
import { recordDisplayLabel } from "../displayField.js";
import { fireRule, fireScheduledRule, hasTooManyConsecutiveFailuresToday, isAllowedWebhookUrl, runAutomationsForRecordChange } from "../automations.js";
import type { EmailSender } from "../email.js";

/**
 * Round 1410: factored out of CreateProjectSchema/RenameProjectSchema's own
 * `.max(200)` calls (round 1408) into one shared constant, so this ceiling
 * can never drift between the two schemas -- and so /projects/:id/clone's
 * own derived name (below) can enforce the identical ceiling without
 * hardcoding a second, easy-to-forget-to-update copy of "200".
 */
const PROJECT_NAME_MAX_LENGTH = 200;

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
  // Round 1408: neither `description` nor `name` had a `.max()` ceiling,
  // only Express's own default 100KB json() body limit -- the same
  // "unbounded free-text field" pattern rounds 1403/1404 already closed
  // for automation-rule fields and WhatsApp send, but with a WORSE
  // amplification profile here: once set, `project.name` is embedded
  // verbatim into email subject/body sent to EVERY collaborator by
  // several already-built broadcast loops (project deletion, calendar-
  // feed-token regenerate, invite, role change, removal, self-leave,
  // ownership transfer) -- a single oversized value set once then
  // multiplies into N outbound emails on every later collaboration
  // action, not a one-shot cost like the schemas those rounds capped.
  description: z.string().trim().min(1, "description is required").max(5000, "description must be 5000 characters or fewer"),
  // Round 1292: round 919's own fix above only covered `description` --
  // `name` was left optional with no `.trim().min(1)` guard at all, unlike
  // this exact field's own sibling schema (RenameProjectSchema, below)
  // which already enforces it correctly. A caller-supplied "" or "   "
  // passed through unchanged (name ?? deriveName(description) only falls
  // back for null/undefined, never for an empty/whitespace string),
  // storing a blank project name verbatim -- not reachable through
  // today's web client (createProject never sends `name` at all), but a
  // real server-side validation hole for any other caller.
  name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH, "name must be 200 characters or fewer").optional(),
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
  // Round 1409: no `.max()` either -- unlike every other free-text schema
  // in this file capped by rounds 1403/1404/1408, `idea` reaches a real,
  // billed Anthropic API call (AnthropicPromptEnhancer.enhance, see
  // promptEnhancer.ts) directly and synchronously on THIS request, not a
  // later fan-out -- the most direct cost-amplification instance of this
  // bug class yet. Capped at the same 5000 as `description`, since this is
  // the same kind of free-form idea text (often the literal same input).
  idea: z.string().trim().min(1, "idea is required").max(5000, "idea must be 5000 characters or fewer"),
});

const RefineSchema = z.object({
  // Round 938: matches every sibling free-text schema in this file
  // (description/idea/name/label/role/assumption/persona above, round
  // 919's own idea fix) -- this one alone was missing .trim(), so a
  // stray leading/trailing space the client sent reached this route's
  // own permanent checkpoint changeLabel (`Refine: ${instruction}`)
  // verbatim, stored forever in the Time Machine history.
  // Round 1409: also had no `.max()` -- `instruction` is concatenated onto
  // project.description and sent straight to the real Anthropic
  // Messages API (generateSpec, see anthropic.ts) on this same request.
  // Capped lower than `description`'s 5000: a refine instruction is a
  // short, targeted change request ("remove deals tracking, focus on
  // invoices"), not a full project description.
  instruction: z.string().trim().min(1, "instruction is required").max(2000, "instruction must be 2000 characters or fewer"),
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
  // Round 1409: none of these four string fields had a `.max()` -- each is
  // concatenated into combinedDescription and sent straight to the real,
  // billed Anthropic Messages API (generateSpec) on this same request, the
  // same direct-cost-on-this-request gap EnhanceIdeaSchema/RefineSchema
  // just above were found to have. `question` is normally server-generated
  // (an open question's own text echoed back by the client) but capped
  // defensively like `answer`, since nothing here re-derives it from the
  // stored spec to confirm it matches.
  answers: z
    .array(z.object({ question: z.string().max(2000), answer: z.string().max(2000) }))
    .optional()
    .default([]),
  additionalRequest: z.string().max(2000).optional(),
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
/*
 * Round 1404: `to`/`message` had a `.min(1)` floor but no `.max()`
 * ceiling, the same gap round 1403 just closed for the sibling automation
 * rule schemas in this file. whatsappRateLimiter below bounds CALL COUNT
 * (30/15min, shared with connect/disconnect) but not payload SIZE -- an
 * owner or editor (requireProjectWriteAccess grants both identical access
 * to this route) could send a handful of near-100KB messages (Express's
 * own default json() body limit) through the project's real, linked
 * WhatsApp account, directly risking the automated-behavior ban/abuse-
 * detection outcome round 862's own doc comment on whatsappRateLimiter
 * already names as a real-world harm -- just reachable with far fewer,
 * larger calls instead of many small ones. `attachment.url`/`name`/
 * `mimeType` don't need the same treatment: the route re-validates them
 * against this project's own upload records before ever using them, so
 * an oversized value there already fails downstream regardless of this
 * schema's own `.min(1)`-only declaration.
 */
/**
 * Round 1594: neither field had `.trim()`, unlike every sibling free-text
 * field in this same file -- round 1424 already gave the automation
 * schemas' own `toNumber`/`messageTemplate` this exact treatment for this
 * exact reason ("a whitespace-only value passes `.min(1)` but is
 * functionally empty"), and rounds 1403/1404 touched this schema twice
 * since (adding `.max()`) without ever adding it here too. The real
 * consequence is worse than the automation case: a whitespace-only
 * `message` passes HTML5 `required` (WhatsAppPanel.tsx's test-send form,
 * round 1593's own noValidate fix never checked for this -- only
 * blank-vs-non-blank) and this schema's own `.min(1)`, then reaches
 * whatsappWeb.ts's `performSend` plain-text branch, whose own comment
 * explicitly assumes "the plain 'no attachment was ever requested' case
 * ... stays unconditional, since its body is always real message text" --
 * a premise this exact gap violates. The result: a literal blank-looking
 * WhatsApp message is sent to a real contact, reported `{ok: true}`, and
 * logged as a clean "sent" row with no sign anything was wrong.
 */
const WhatsAppSendSchema = z.object({
  to: z.string().trim().min(1, "to is required").max(50),
  message: z.string().trim().min(1, "message is required").max(4096),
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

/*
 * Round 1403: every one of this schema's (and UpdateAutomationRuleSchema's
 * below) free-text fields had a `.min(1)` floor but no `.max()` ceiling --
 * only Express's own default 100KB JSON body limit (app.ts's
 * `express.json()` sets no `limit`) bounded them. A rule is created once,
 * cheaply, and then fires on every matching record create/update/delete
 * (recordWriteRateLimiter alone permits 500/15min per account) -- so an
 * oversized `messageTemplate`/`webhookUrl` turns one ~100KB rule-creation
 * request into tens of megabytes of real outbound WhatsApp/email/webhook
 * traffic per 15-minute window, sustained indefinitely by scripting
 * ordinary record creation against a rule already saved. These caps are
 * generous for any real message/URL/secret but far below the body limit,
 * closing the amplification without touching legitimate use.
 */
const CreateAutomationRuleSchema = z
  .object({
    trigger: z.enum(["record_created", "field_equals", "schedule", "record_deleted", "record_updated", "inbound_webhook"]),
    // Round 1424: these free-text fields never got the `.trim()` treatment
    // rounds 408/919/939 already established everywhere else in this file
    // (see e.g. RenameProjectSchema/UpdateProjectDescriptionSchema a few
    // hundred lines below) for "a whitespace-only value passes `.min(1)`
    // but is functionally empty" -- a rule saved with toNumber:" " looked
    // configured but could never actually send, and fireRule's own error
    // for that case misdirects the user to check their RECORD's phone
    // field, when the real defect is the RULE's own static destination.
    // webhookUrl and toEmail don't need this: a whitespace-only value
    // already fails isAllowedWebhookUrl's URL parse / .email() respectively.
    fieldName: z.string().trim().min(1).max(200).optional(),
    fieldValue: z.string().trim().min(1).max(2000).optional(),
    // Round 1491: see AutomationFieldOperator's own doc comment
    // (packages/db/src/automations.ts). Omitted (same as every rule created
    // before this field existed) defaults to "equals" everywhere this is
    // read -- see matchesTrigger's own matchesFieldOperator helper.
    fieldOperator: z.enum(["equals", "not_equals", "greater_than", "less_than"]).optional(),
    scheduleTimeUtc: z.string().regex(SCHEDULE_TIME_UTC_PATTERN, "scheduleTimeUtc must be \"HH:MM\" in 24-hour UTC").optional(),
    scheduleDaysOfWeek: z
      .string()
      .regex(SCHEDULE_DAYS_OF_WEEK_PATTERN, "scheduleDaysOfWeek must be comma-separated day numbers 0-6")
      .optional(),
    scheduleTimezone: ScheduleTimezoneSchema.optional(),
    actionType: z.enum(["send_whatsapp", "webhook", "send_email"]),
    toMode: z.enum(["static", "field"]),
    toNumber: z.string().trim().min(1).max(50).optional(),
    toField: z.string().trim().min(1).max(200).optional(),
    webhookUrl: z.string().min(1).max(2000).optional(),
    webhookSecret: z.string().trim().min(1).max(500).optional(),
    toEmail: z.string().email("toEmail must be a valid email address").max(320).optional(),
    emailSubject: z.string().trim().min(1).max(500).optional(),
    messageTemplate: z.string().trim().min(1, "messageTemplate is required").max(4000),
  })
  .refine((data) => data.trigger !== "field_equals" || (!!data.fieldName && !!data.fieldValue), {
    message: "fieldName and fieldValue are required when trigger is field_equals",
    path: ["fieldName"],
  })
  .refine((data) => data.trigger === "field_equals" || (!data.fieldName && !data.fieldValue), {
    message: "fieldName and fieldValue must be empty when trigger is not field_equals",
    path: ["fieldName"],
  })
  .refine((data) => data.trigger === "field_equals" || !data.fieldOperator, {
    message: "fieldOperator must be empty when trigger is not field_equals",
    path: ["fieldOperator"],
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
  trigger: z.enum(["record_created", "field_equals", "schedule", "record_deleted", "record_updated", "inbound_webhook"]).optional(),
  // Round 1424: same .trim() gap as CreateAutomationRuleSchema's own
  // fields just above -- see that schema's doc comment.
  fieldName: z.string().trim().min(1).max(200).nullable().optional(),
  fieldValue: z.string().trim().min(1).max(2000).nullable().optional(),
  // Round 1491: see CreateAutomationRuleSchema's own identical field.
  fieldOperator: z.enum(["equals", "not_equals", "greater_than", "less_than"]).nullable().optional(),
  scheduleTimeUtc: z.string().regex(SCHEDULE_TIME_UTC_PATTERN, "scheduleTimeUtc must be \"HH:MM\" in 24-hour UTC").nullable().optional(),
  scheduleDaysOfWeek: z
    .string()
    .regex(SCHEDULE_DAYS_OF_WEEK_PATTERN, "scheduleDaysOfWeek must be comma-separated day numbers 0-6")
    .nullable()
    .optional(),
  scheduleTimezone: ScheduleTimezoneSchema.nullable().optional(),
  actionType: z.enum(["send_whatsapp", "webhook", "send_email"]).optional(),
  toMode: z.enum(["static", "field"]).optional(),
  toNumber: z.string().trim().min(1).max(50).nullable().optional(),
  toField: z.string().trim().min(1).max(200).nullable().optional(),
  webhookUrl: z.string().min(1).max(2000).nullable().optional(),
  webhookSecret: z.string().trim().min(1).max(500).nullable().optional(),
  toEmail: z.string().email("toEmail must be a valid email address").max(320).nullable().optional(),
  emailSubject: z.string().trim().min(1).max(500).nullable().optional(),
  messageTemplate: z.string().trim().min(1).max(4000).optional(),
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
  fieldOperator: AutomationFieldOperator | null;
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
  // Round 1098: the PATCH route's own `{ ...existing, ...parsed.data }`
  // merge (see its call site's comment) lets a trigger change leave a
  // stale fieldName/fieldValue from when this rule used to be
  // field_equals, since nothing here ever forbade them outside it --
  // matchesTrigger (automations.ts) now also guards against this at
  // evaluation time, but the invariant belongs here too, at the write
  // path, so a caller finds out immediately rather than only once the
  // rule starts silently double-firing.
  if (rule.trigger !== "field_equals" && (rule.fieldName || rule.fieldValue)) {
    return "fieldName and fieldValue must be empty when trigger is not field_equals";
  }
  // Round 1491: same reasoning as the fieldName/fieldValue check above --
  // mirrors CreateAutomationRuleSchema's own identical .refine().
  if (rule.trigger !== "field_equals" && rule.fieldOperator) {
    return "fieldOperator must be empty when trigger is not field_equals";
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
  // Round 1423: same length cap as auth.ts's CredentialsSchema's own email
  // field -- z.string().email() has no limit of its own, and this email is
  // re-sent on every GET .../collaborators call to every other collaborator.
  email: z.string().email("a valid email is required").max(320, "email must be 320 characters or fewer").transform((email) => email.toLowerCase()),
  // Optional and defaulted to "editor" so every existing caller (the web
  // UI before this round, any script/integration already using this
  // route) keeps behaving exactly as before -- full access, same as today.
  role: CollaboratorRoleSchema.default("editor"),
  // Round 1253: same optional client-language hint ChangeEmailSchema/
  // ChangePasswordSchema already carry, for the invite notification email
  // this route now sends to the invited user.
  lang: z.enum(["he", "en"]).optional(),
});

const UpdateCollaboratorRoleSchema = z.object({
  role: CollaboratorRoleSchema,
  // Round 1254: same optional client-language hint AddCollaboratorSchema
  // already carries, for the role-change notification email this route
  // now sends to the affected collaborator.
  lang: z.enum(["he", "en"]).optional(),
});

// Round 1719: same optional client-language hint every sibling collaborator-
// mutation schema in this file already carries, for the resend route's own
// notification email just below.
const ResendInviteSchema = z.object({
  lang: z.enum(["he", "en"]).optional(),
});

const TransferOwnershipSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  // Round 1255: same optional client-language hint UpdateCollaboratorRoleSchema
  // already carries, for the new-owner notification email this route now sends.
  lang: z.enum(["he", "en"]).optional(),
});

const RenameProjectSchema = z.object({
  // Round 1408: mirrors CreateProjectSchema's own newly-added cap -- this
  // route is the one place a project's name can be changed at any time
  // after creation (requireProjectWriteAccess, so any owner/editor), the
  // same place the amplification this round closes is actually reachable
  // from, since CreateProjectSchema's own `name` is rarely exercised by
  // today's web client.
  name: z.string().trim().min(1, "name is required").max(PROJECT_NAME_MAX_LENGTH, "name must be 200 characters or fewer"),
});

const UpdateProjectDescriptionSchema = z.object({
  // Round 1408: mirrors CreateProjectSchema's own newly-added cap, for the
  // identical reason -- this route is reachable at any time after
  // creation, not just once.
  description: z.string().trim().min(1, "description is required").max(5000, "description must be 5000 characters or fewer"),
});

/**
 * Round 1411: none of these 8 schemas' own free-text fields had a `.max()`
 * -- the same "unbounded free-text field" pattern rounds 1403/1404/1408/
 * 1409/1410 already closed elsewhere in this file, but on a sibling family
 * (entity/field/checkpoint labels, roles/personas/assumptions) those rounds
 * never touched. Unlike those closed instances, there's no cap at ANY layer
 * here -- not even the broader ProductSpecSchema in packages/shared, which
 * also only enforces `.min(1)` on `label`/`roles`/`personas`/`assumptions`.
 * The whole spec (every entity/field label, every role/persona/assumption)
 * is re-fetched and shipped on every `GET /projects/:id` -- every page
 * load, by every collaborator -- so one oversized value set once bloats
 * every future load of this project, forever, not a one-shot cost. It's
 * also embedded verbatim into the calendar ICS feed (a real third-party
 * calendar app has to parse it), the Business Twin report, and print/export
 * output. `label` fields are short display names (tab/column headers,
 * dropdown options) -- capped at PROJECT_NAME_MAX_LENGTH, the same
 * convention `name` already uses. `role`/`assumption`/`persona` are short
 * free-text phrases, not raw paragraphs, so capped a bit higher at 500.
 */
const SPEC_LABEL_MAX_LENGTH = PROJECT_NAME_MAX_LENGTH;
const SPEC_PHRASE_MAX_LENGTH = 500;

/**
 * GET .../entities/:entityName had no limit at all (flagged since round
 * 375, never implemented) -- an entity with tens of thousands of rows
 * meant sending the entire table over the wire on every load. Generous
 * enough that it's invisible to the overwhelming majority of real
 * projects, while still bounding the worst case; Export CSV/JSON already
 * exist for anyone who genuinely needs every row of a table this large.
 */
const RECORD_LIST_RESPONSE_CAP = 5000;

const RenameEntityLabelSchema = z.object({
  label: z.string().trim().min(1, "label is required").max(SPEC_LABEL_MAX_LENGTH, "label must be 200 characters or fewer"),
});

const RenameCheckpointSchema = z.object({
  label: z.string().trim().min(1, "label is required").max(SPEC_LABEL_MAX_LENGTH, "label must be 200 characters or fewer"),
});

const RenameFieldLabelSchema = z.object({
  label: z.string().trim().min(1, "label is required").max(SPEC_LABEL_MAX_LENGTH, "label must be 200 characters or fewer"),
});

const SetFieldRequiredSchema = z.object({
  required: z.boolean(),
});

const AddRoleSchema = z.object({
  role: z.string().trim().min(1, "role is required").max(SPEC_PHRASE_MAX_LENGTH, "role must be 500 characters or fewer"),
});

const AddAssumptionSchema = z.object({
  assumption: z.string().trim().min(1, "assumption is required").max(SPEC_PHRASE_MAX_LENGTH, "assumption must be 500 characters or fewer"),
});

const AddPersonaSchema = z.object({
  persona: z.string().trim().min(1, "persona is required").max(SPEC_PHRASE_MAX_LENGTH, "persona must be 500 characters or fewer"),
});

const AddEntitySchema = z.object({
  label: z.string().trim().min(1, "label is required").max(SPEC_LABEL_MAX_LENGTH, "label must be 200 characters or fewer"),
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
    label: z.string().trim().min(1, "label is required").max(SPEC_LABEL_MAX_LENGTH, "label must be 200 characters or fewer"),
    type: z.enum(FIELD_TYPES).default("text"),
    required: z.boolean().default(false),
    // Comma-separated in the request body (what the UI's own single text
    // input sends) rather than a JSON array, trimmed and with blanks
    // dropped -- mirrors how a user would naturally type "New, In
    // Progress, Done" without needing to know this becomes an array.
    // Round 1414: capped at SPEC_PHRASE_MAX_LENGTH BEFORE the split/trim --
    // the one free-text field this route family's own round-1403/1408-1411
    // sweep missed, the only field here (besides `label`, already capped
    // two lines up) an AI-generated or hand-typed spec can grow without
    // bound, re-embedded in the spec on every GET /projects/:id the same
    // way label/role/assumption/persona already are.
    enumValues: z
      .string()
      .max(SPEC_PHRASE_MAX_LENGTH, "enum values must be 500 characters or fewer")
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
    // Round 1414: same enumValues cap as AddFieldSchema above -- see its
    // own comment.
    enumValues: z
      .string()
      .max(SPEC_PHRASE_MAX_LENGTH, "enum values must be 500 characters or fewer")
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
 * the built-in column names every table already carries (id, createdAt,
 * createdByUserId, updatedByUserId, updatedAt -- see FieldSchema's own
 * RESERVED_FIELD_NAMES check in @forge/shared, round 1613/1614/1617/1672),
 * appending the first free numeric suffix, so this can never hand
 * FieldSchema's own refine() a name it would reject.
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
  const taken = new Set([
    "id",
    "createdat",
    "createdbyuserid",
    "updatedbyuserid",
    "updatedat",
    ...existingNames.map((n) => n.toLowerCase()),
  ]);
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

/**
 * Round 1162: a relation field's own relationTo can permanently differ in
 * letter case from its real target entity's name (see migrate.ts's own
 * round-1159 doc comment -- an AI-generated or Debug-Agent-repaired spec
 * can produce this, and migrate.ts's own case-rename handling never
 * rewrites a SIBLING field's relationTo string when an entity itself is
 * renamed). Every client call site that fetches a relation field's own
 * target records (EntityPanel.tsx's relationTargets, AutomationsPanel.tsx's
 * relationFieldTargets) passes that raw relationTo string straight through
 * as this route family's own :entityName param -- an exact-case find here
 * 404ed every one of those requests, so the live table/board/calendar
 * cells, CSV export, search, and automation message templates all
 * silently fell back to the raw "#<id>" the moment a relation's own
 * relationTo didn't exactly match its target's current spelling, even
 * though migrate.ts's own round-1159 fix already guarantees the real
 * foreign key underneath is intact. ProductSpecSchema's own
 * findCaseInsensitiveDuplicateEntityNames refine guarantees at most one
 * entity name can ever match a given string this way, so the fallback is
 * never ambiguous.
 */
function findEntity(project: Project, entityName: string): Entity {
  const entity = project.spec.entities.find((e) => e.name === entityName) ?? project.spec.entities.find((e) => e.name.toLowerCase() === entityName.toLowerCase());
  if (!entity) {
    throw new HttpError(404, `Entity "${entityName}" is not part of this project's spec`, "ENTITY_NOT_FOUND");
  }
  return entity;
}

/**
 * Round 1187: case-insensitive, mirroring findEntity's own round-1162
 * fallback -- migrate.ts's own prevFieldByLowerName leniency (and a
 * second lowercased sweep disabling stale automation rules) already
 * treats a field renamed only by letter case as the same field for
 * data-preservation/migration purposes, proving this exact scenario is
 * real and anticipated at the migration layer; it was simply never
 * carried into this route-layer helper, which every field-level route
 * in this file (PATCH label/required/type, uploads, automation
 * validation, field removal) resolves `fieldName` through.
 */
function findField(entity: Entity, fieldName: string) {
  const field = entity.fields.find((f) => f.name === fieldName) ?? entity.fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
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

/**
 * Round 1491: "greater_than"/"less_than" only have a sensible meaning for a
 * field with a real numeric ordering -- "number" and "date" (compared
 * chronologically, see matchesTrigger's own matchesFieldOperator helper).
 * An enum/boolean/text/longtext/relation/file field has no such ordering a
 * user configuring this rule could reasonably predict (a relation field's
 * own id, for instance, is an internal implementation detail with no
 * meaning as a magnitude), so saving one of these two operators against any
 * of them is rejected here, the same "reject at creation, don't rely on a
 * runtime guard to silently never match" discipline validateAutomationFieldValue
 * above already establishes for its own cases.
 */
function validateAutomationFieldOperator(field: Field, operator: AutomationFieldOperator): void {
  if ((operator === "greater_than" || operator === "less_than") && field.type !== "number" && field.type !== "date") {
    throw new HttpError(400, `Field "${field.name}" must be a number or date field to use a greater-than/less-than comparison`, "VALIDATION_ERROR");
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
export function parseRecordId(raw: string): number {
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
 *
 * Round 1447: uses tryGetProject, not the stricter getProject, for the same
 * reason round 1427's checkpoint-restore fix and round 1428's scheduled-
 * automation scheduler fix already use it over their own siblings --
 * getProject's rowToProject runs ProductSpecSchema.parse and THROWS a
 * ZodError for a project whose stored spec no longer matches the current
 * schema (a pre-schema-tightening project, same root condition those two
 * rounds already fixed), rather than returning undefined. Since this
 * function is the primary access gate for nearly every route in this file
 * (~50+: GET/PATCH project, build, refine, checkpoints, entities,
 * automations, collaborators, WhatsApp, uploads...), that throw escaped as
 * a raw 500 instead of this function's own intended clean 404 for EVERY
 * route on such a project -- not just one narrow call site. Confirmed live
 * against a real running app instance before this fix.
 */
function requireProjectAccess(db: ForgeDatabase, id: string, userId: string): Project {
  const project = tryGetProject(db, id);
  if (!project || (project.ownerId !== userId && !isCollaborator(db, id, userId))) {
    throw new HttpError(404, `Project "${id}" not found`, "PROJECT_NOT_FOUND");
  }
  return project;
}

/** Stricter than requireProjectAccess: for actions only the owner may take (inviting/removing a collaborator, changing a collaborator's role). Round 1447: tryGetProject, see requireProjectAccess's own doc comment just above. */
function requireProjectOwner(db: ForgeDatabase, id: string, userId: string): Project {
  const project = tryGetProject(db, id);
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
export async function deleteReplacedFileFields(
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
   * Round 1163: round 1153's own survey confirmed /projects/from-template
   * and /projects/:id/clone "correctly unthrottled on their own merits" --
   * but that conclusion was narrowly about the real synchronous pipeline
   * cost /build has and these two routes don't (no diffAndMigrate/seed/QA/
   * security-scan work at all). It never addressed a separate, real
   * concern: both routes are still an unconditional insertProject
   * (packages/db) with zero volumetric cap of their own, unlike
   * aiGenerationRateLimiter's own identical insertProject call on
   * POST /projects just above. insertProject has no per-user project-count
   * cap either, and there's no project-row retention/cleanup anywhere in
   * this codebase -- a tight loop against either route (no AI cost, so
   * aiGenerationRateLimiter's own 30/15min budget is never even touched)
   * creates unbounded project rows for free, growing this app's one shared
   * better-sqlite3 file forever and permanently slowing listProjectsForUser
   * for that same account (GET /projects, the home screen's own data
   * source) and this single Node process's shared synchronous DB access
   * for everyone else. One shared limiter across both routes, the same
   * "one real budget, not N independent concerns" reasoning
   * aiGenerationRateLimiter above already uses -- "how many brand-new,
   * empty project rows can this account create for free" is a single
   * question regardless of which of these two routes answers it. Sized
   * the same as aiGenerationRateLimiter's own budget: each call here is
   * cheaper (no AI/pipeline cost at all), but the actual resource being
   * capped -- a new project row -- is identical, so there's no principled
   * reason to allow more of them for free just because they're faster to
   * produce.
   */
  const projectCreationRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many projects created. Please try again later.",
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
   * Round 1053: /export, /backup, and /twin had no volumetric throttle at
   * all, despite being the heaviest, most CPU-bound GET routes in this
   * router -- zip.ts and backup.ts (and twin.ts's own report builder)
   * contain no async/await at all, so the entire ZIP build (CRC32 over
   * every entity's CSV bytes, itself built from a synchronous `listRecords`
   * SELECT per entity) runs fully synchronously on this app's one Node
   * event loop (see app.ts's own "single-service" deployment comment --
   * there's no horizontal scaling to absorb this). /export is the heaviest
   * of the three: it re-runs the entire codegen.ts template-generation
   * pipeline (the same code that builds the whole standalone exported
   * app's source) on every single call, regardless of data size. Any
   * authenticated collaborator -- owner, editor, or even a read-only
   * viewer, since all three routes use requireProjectAccess, not
   * requireProjectWriteAccess -- can script a tight loop of requests
   * against their own project; because this blocks the *shared*
   * single-threaded process, it stalls every other user's and project's
   * requests too, not just the caller's own. One shared limiter across all
   * three, the same "one real budget, not N independent concerns"
   * reasoning aiGenerationRateLimiter above already uses, since "how much
   * expensive synchronous work can this account trigger" is a single
   * question regardless of which of the three routes answers it. Keyed by
   * user id, same rationale as every other already-authenticated route's
   * limiter above.
   */
  const expensiveReadRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many export/backup/twin requests. Please try again later.",
  });

  /**
   * Round 1153: /build had NO volumetric throttle at all -- the one
   * comparably-expensive mutation route in this file this hardening
   * series never looked at. Unlike /refine right below it (gated by
   * aiGenerationRateLimiter), /build was deliberately excluded from that
   * specific limiter (see aiGenerationRateLimiter's own doc comment
   * above) because an ordinary build makes no *extra* AI call -- but that
   * reasoning never addressed /build's own separate, real cost: it runs
   * diffAndMigrate (real CREATE TABLE/index DDL per entity),
   * generateSeedRecords+insertRecord (real seed inserts per entity), and
   * runQaChecks (pipeline.ts -- for every required field of every entity,
   * a full insertRecord attempt it expects to throw, i.e. extra
   * synchronous DB round-trips per required field) plus runSecurityScan,
   * all synchronously on better-sqlite3's API on this app's one shared
   * Node event loop -- the exact "no horizontal scaling to absorb this"
   * hazard expensiveReadRateLimiter's own doc comment names, just for a
   * heavier pipeline than export/backup/twin. activePipelines (checked
   * just below) only blocks a second concurrent build/refine on the SAME
   * project; it does nothing to cap how many DIFFERENT projects one
   * account can build back-to-back -- and /projects/from-template and
   * /projects/:id/clone (both free, instant, already-unthrottled since
   * neither runs this pipeline itself) make an unbounded supply of
   * freshly-buildable projects trivially reachable. Reuses
   * expensiveReadRateLimiter's own budget shape rather than inventing a
   * new one: "how much expensive synchronous pipeline work can this
   * account trigger" is the same kind of single-process-blocking question
   * that budget was already sized for.
   */
  const buildPipelineRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many build requests. Please try again later.",
  });

  /**
   * Round 1082: POST .../fields/:fieldName/upload (an entity record's own
   * file-type field) had NO volumetric throttle at all, unlike every other
   * route in this file that writes to this app's own ephemeral disk --
   * its structurally identical sibling, POST .../whatsapp/attachments/upload
   * (round 973's own doc comment: "Mirrors its idempotency/multer/
   * error-handling shape exactly"), already sits behind whatsappRateLimiter.
   * createUploadMiddleware's own 10MB-per-file cap (doc comment just above
   * it) exists specifically "without letting one upload exhaust the
   * ephemeral disk a free-tier host like the current Render deployment
   * gives this process" -- but that cap only bounds a single request's own
   * size, never how many requests one account can fire. Any authenticated
   * collaborator with write access to even one project (free to create) can
   * script a tight loop of ~10MB uploads with no server-side cap at all;
   * nothing requires an uploaded file ever be attached to a real record
   * (round 1002's own comment: an abandoned upload just sits on disk until
   * the whole project is deleted), so this is a real, account-triggerable
   * way to fill the shared disk this single-process deployment gives every
   * project, degrading everyone else's uploads/builds too -- the exact
   * resource every other limiter in this file already exists to protect.
   * A dedicated limiter rather than reusing whatsappRateLimiter: that one's
   * own budget is explicitly "how much can this account churn this
   * project's WhatsApp integration" (connect/disconnect/send), not disk
   * usage -- a different real question, even though both happen to share
   * the same 30-per-15-min shape here.
   */
  const fileUploadRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many file upload requests. Please try again later.",
  });

  /**
   * Round 1086: GET .../entity-counts had NO volumetric throttle at all,
   * unlike its siblings /export, /backup, and /twin (round 1053), which sit
   * behind expensiveReadRateLimiter for exactly this reason: countRecords
   * (packages/db/src/repository.ts) is a fully synchronous better-sqlite3
   * `SELECT COUNT(*)` with no WHERE clause, run once per entity in a loop --
   * real, uncapped synchronous work on this app's single Node event loop
   * (see expensiveReadRateLimiter's own doc comment on the lack of
   * horizontal scaling). Any authenticated collaborator with mere read
   * access -- this route uses requireProjectAccess, not
   * requireProjectWriteAccess -- can script a tight loop of requests,
   * stalling every other user's and project's requests too. A dedicated
   * limiter rather than reusing expensiveReadRateLimiter: that one's own
   * message and doc comment explicitly scope its budget to "export/backup/
   * twin requests" specifically, and legitimate entity-counts traffic is
   * both much lighter per call (a handful of COUNT(*)s, not a full ZIP/
   * report build) and more frequent (App.tsx fires one on every project
   * open, not just on an explicit export/backup/twin click) -- a higher cap
   * fits its real legitimate usage better without starving it by sharing
   * a budget meant for much heavier, rarer calls.
   */
  const entityCountsRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many entity-count requests. Please try again later.",
  });

  /**
   * Round 1342: `GET .../entities/:entityName` -- the route that lists every
   * record of one entity -- had NO volumetric throttle at all, unlike its
   * own write-side sibling (`POST .../entities/:entityName`, gated by
   * recordWriteRateLimiter below) and its lighter read cousin
   * (`GET .../entity-counts`, gated by entityCountsRateLimiter just above).
   * `listRecords` (packages/db/src/repository.ts) is a fully synchronous
   * better-sqlite3 `SELECT *` with no LIMIT at all, followed by a per-row
   * `rowToRecord` JS-object construction for every column of every row --
   * strictly heavier per call than entity-counts' own `SELECT COUNT(*)`
   * this exact reasoning already justified a dedicated limiter for, and
   * this route uses `requireProjectAccess`, not `requireProjectWriteAccess`,
   * so a mere read-only viewer collaborator (free to be invited to, or to
   * create their own project) can script a tight loop against it, stalling
   * this app's one shared Node event loop (the same single-process hazard
   * expensiveReadRateLimiter's own doc comment names) for every other
   * user's and project's requests too.
   *
   * A dedicated limiter with a higher cap than entityCountsRateLimiter's 60,
   * since legitimate traffic against this specific route is itself heavier:
   * GlobalSearchPanel's own `runSearch` fires one call per entity on every
   * search submission (not just once per project open the way entity-counts
   * is), and EntityPanel's relation-field loader fires one more per distinct
   * related entity a record references -- both genuinely routine, not
   * abusive, usage this budget must comfortably absorb.
   */
  const recordListRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 120,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many record list requests. Please try again later.",
  });

  /**
   * Round 1109: the entire pre-build spec-editing route family -- add/
   * remove/rename an entity or field, change a field's type/required flag,
   * and append/edit/remove a role, assumption, or persona -- had NO
   * volumetric throttle at all, unlike every other repeatable, server-
   * cost-bearing route family in this file (aiGenerationRateLimiter,
   * whatsappRateLimiter, inviteCollaboratorRateLimiter,
   * expensiveReadRateLimiter, fileUploadRateLimiter, entityCountsRateLimiter
   * above). Each of these routes is a synchronous read-project.spec-then-
   * write-it-back round trip with no cap on how large the spec can grow:
   * neither `EntitySchema.fields` nor `ProductSpecSchema.entities`/`roles`/
   * `assumptions` (@forge/shared) carry a `.max()`, and updateProjectSpec
   * (packages/db/src/projects.ts) does a synchronous `JSON.stringify`
   * write immediately followed by a full `getProject` re-read that
   * re-validates the ENTIRE spec via `ProductSpecSchema.parse` --
   * including its own O(entities)/O(fields) duplicate-name refines -- with
   * no `await` anywhere in the real work. Any signed-up account (signup
   * and project creation are both free, and the project never needs to
   * actually be built) can script repeated calls against one project of
   * their own; each call's cost grows with the spec's own size, so N calls
   * that each add one entity/field cost roughly O(N^2) total synchronous
   * CPU time on this app's single Node event loop -- the exact "no
   * horizontal scaling to absorb this" hazard expensiveReadRateLimiter's
   * own doc comment above already names, just never extended to this
   * route family. One shared limiter across the whole family, the same
   * "one real budget, not N independent concerns" reasoning
   * aiGenerationRateLimiter below already uses, since "how much spec-
   * mutation work can this account trigger" is a single question
   * regardless of which of these routes answers it. A higher cap than
   * expensiveReadRateLimiter's 20: unlike that budget's heavy, rare
   * export/backup/twin calls, these are the routine, one-click-at-a-time
   * edits a user makes while actively building out a project's spec by
   * hand (adding several entities/fields in one sitting is ordinary, not
   * suspicious).
   */
  const specEditRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many spec edit requests. Please try again later.",
  });

  /**
   * Round 1110: record create/update/delete (`POST .../entities/:entityName`,
   * `PATCH`/`DELETE .../entities/:entityName/:recordId`) had NO volumetric
   * throttle at all -- the one real-effect mutation family round 594's own
   * doc comment already calls "the single most frequent write in the app",
   * yet it was skipped by every rate-limiter round that followed
   * (aiGenerationRateLimiter/whatsappRateLimiter/inviteCollaboratorRateLimiter/
   * expensiveReadRateLimiter/fileUploadRateLimiter/entityCountsRateLimiter/
   * specEditRateLimiter above -- none of their own doc comments ever mention
   * this family). `insertRecord`/`updateRecord`/`deleteRecord`
   * (packages/db/src/repository.ts) are synchronous better-sqlite3 calls on
   * this app's one shared Node event loop (the same "no horizontal scaling"
   * hazard expensiveReadRateLimiter's own doc comment names), and each one
   * also triggers a fire-and-forget `runAutomationsForRecordChange` whose
   * own rule lookup is further synchronous DB work before any WhatsApp/
   * email send is even queued. Any signed-up account with write access to
   * one built project (free to create) can script a tight loop with no
   * server-side cap on row count or request volume.
   *
   * Deliberately a much higher cap than every sibling limiter above: unlike
   * an occasional, one-click-at-a-time action, a record write is this app's
   * own designed unit of BULK work -- CSV import (EntityPanel.tsx's
   * handleImportFile) fires one create/update request per row, all
   * concurrently via Promise.allSettled, with no row-count cap at all; bulk-
   * edit, bulk-delete, and bulk-duplicate likewise map over `selectedIds`
   * with no cap on how many records a user can select. A cap sized like
   * specEditRateLimiter's 60 (fine for "how many fields will you add by
   * hand in one sitting") would make a legitimate CSV import of a real
   * customer list -- exactly the migration-off-another-system use case that
   * feature's own doc comment names -- hit 429 partway through, silently
   * truncating a correct import. 500 per window comfortably covers a large
   * real import or bulk action while still bounding a genuinely abusive,
   * sustained scripted loop far below what would meaningfully stall this
   * process for every other project.
   */
  const recordWriteRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 500,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many record write requests. Please try again later.",
  });

  /**
   * Round 1143: Time Machine's own checkpoint list/restore/rename/delete
   * routes had NO volumetric throttle at all -- the one route family this
   * exact hardening series (aiGenerationRateLimiter/whatsappRateLimiter/
   * inviteCollaboratorRateLimiter/expensiveReadRateLimiter/
   * fileUploadRateLimiter/entityCountsRateLimiter/specEditRateLimiter/
   * recordWriteRateLimiter above, plus routes/calendar.ts's own feed
   * limiter) never looked at. Restore is the real cost driver: it runs
   * carryForwardLabels, a full diffAndMigrate schema diff, and
   * describeMigrationHazards/describeImpactHazards' own hazard analysis
   * across every entity/field, plus an awaited cleanupFileFieldsRetypedAway
   * disk-I/O pass -- genuine synchronous work on this app's one shared
   * Node event loop (the same single-process hazard expensiveReadRateLimiter's
   * own doc comment names), gated only by activePipelines (an anti-race
   * check against a *concurrent* restore, not a volumetric cap on many
   * sequential ones). Any editor collaborator with write access to a
   * project they created themselves (free, no approval needed) could
   * script a tight loop against restore and stall every other user's and
   * project's requests too, not just their own. One shared limiter across
   * all four routes, the same "one real budget, not N independent
   * concerns" reasoning every sibling limiter above already uses --
   * list/rename/delete are each individually cheap, but restore alone
   * already justifies the same budget specEditRateLimiter uses for its own
   * occasional, one-click-at-a-time spec-mutation actions (not the much
   * higher, bulk-sized recordWriteRateLimiter budget, since restoring a
   * checkpoint is never a scripted bulk action the way CSV import/bulk-edit
   * legitimately are).
   */
  const checkpointRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many checkpoint requests. Please try again later.",
  });

  /**
   * Round 1146: automation-rule create/update/delete
   * (`POST .../entities/:entityName/automations`, `PATCH`/`DELETE
   * .../automations/:ruleId`) had NO volumetric throttle at all -- round
   * 1143's own closing note claimed this hardening series (aiGenerationRate-
   * Limiter/whatsappRateLimiter/inviteCollaboratorRateLimiter/
   * expensiveReadRateLimiter/fileUploadRateLimiter/entityCountsRateLimiter/
   * specEditRateLimiter/recordWriteRateLimiter/checkpointRateLimiter above)
   * had closed "the last known un-rate-limited real-effect route family,"
   * but never actually looked at this one. `insertAutomationRule` is an
   * unbounded INSERT with no row cap (packages/db/src/automations.ts), the
   * same "no server-side cap on row count" hazard recordWriteRateLimiter's
   * own doc comment names for record writes -- except each row created
   * here is a live rule that can later fire a real WhatsApp/webhook/email
   * send on every future matching trigger, so the cost compounds well past
   * the one synchronous INSERT this limiter is gating. Scoped like
   * specEditRateLimiter's budget, not recordWriteRateLimiter's: creating an
   * automation rule is an occasional, one-click-at-a-time action through
   * AutomationsPanel's own form (including its Duplicate button, which
   * just resubmits this same create route), never a scripted bulk action
   * the way CSV import/bulk-edit legitimately are.
   */
  const automationRuleRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many automation rule requests. Please try again later.",
  });

  /**
   * Round 1383: `GET .../automations` (the rule list) and `GET
   * .../automations/:ruleId/runs` (one rule's run history) had NO volumetric
   * throttle at all -- unlike every other mutating automation route just
   * above (automationRuleRateLimiter) and every other repeatable,
   * server-cost-bearing GET sibling in this file (entityCountsRateLimiter,
   * recordListRateLimiter, whatsappMessagesReadRateLimiter). Both are real
   * synchronous DB work, not O(1): the rule list's own handler calls
   * hasTooManyConsecutiveFailuresToday (apps/api/src/automations.ts) for
   * every enabled schedule-trigger rule, each of which runs its own
   * listAutomationRuns query fetching up to 60 rows -- genuine N+1 cost per
   * call. Gated only by requireProjectAccess, so any collaborator with mere
   * read access (a viewer, not just the owner) can hit either route.
   *
   * Same reasoning as round 1344's whatsappMessagesReadRateLimiter: this
   * isn't a theoretical abuse surface -- App.tsx's own checkFailingAutomations
   * already polls the rule list route every AUTOMATIONS_FAILING_POLL_INTERVAL_MS
   * (30 seconds) for as long as a built project sits open, before counting
   * any manual AutomationsPanel open or "History" expansion (which hits the
   * second route). A budget sized only for occasional, one-click actions
   * (automationRuleRateLimiter's own 60-per-15-min) would 429 that ordinary
   * background poll within roughly 15 minutes of a project just sitting
   * open -- a regression, not a fix -- so this gets its own, more generous
   * budget instead, shared by both GET routes since neither is meaningfully
   * more expensive than the other.
   */
  const automationsReadRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 120,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many automation read requests. Please try again later.",
  });

  /**
   * Round 1171: POST .../calendar-feed-token/regenerate had no volumetric
   * throttle at all, unlike every sibling owner-only mutation this file
   * already guards. Lower severity than an unbounded-disk-growth hazard
   * (round-972's own doc comment: "rotating the token also breaks every
   * OTHER collaborator's already-configured subscription with no warning
   * to them"), but that's exactly the abuse surface a cap matters for --
   * a single authenticated account looping this call griefs every real
   * collaborator's live calendar subscription repeatedly, with nothing
   * server-side slowing it down.
   */
  const calendarFeedTokenRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many calendar feed token requests. Please try again later.",
  });

  /**
   * Round 1405: mirrors calendarFeedTokenRateLimiter's own reasoning
   * exactly, for the new inbound-webhook-token regenerate route below --
   * a single authenticated account looping this call griefs its own (or,
   * for a shared project, every collaborator's) already-configured
   * external integration (Stripe, Typeform) repeatedly, with nothing
   * server-side slowing it down otherwise.
   */
  const inboundWebhookTokenRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many webhook token requests. Please try again later.",
  });

  /**
   * Round 1171: DELETE .../integrations/whatsapp/messages (bulk-clear, a
   * single unbounded DELETE over the whole message-history table for this
   * project) and its sibling .../messages/:messageId (one row at a time)
   * both had no volumetric throttle at all. Deliberately a dedicated
   * limiter, not whatsappRateLimiter above: that one's own doc comment
   * scopes it specifically to "how much can this account churn this
   * project's WhatsApp INTEGRATION" (connect/disconnect/send) -- clearing
   * already-received message history is a different real question (log
   * housekeeping, not integration churn), even though nothing stops an
   * account from looping either route to repeatedly wipe a project's own
   * WhatsApp log.
   */
  const whatsappHistoryRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many WhatsApp history requests. Please try again later.",
  });

  /**
   * Round 1344: `GET .../integrations/whatsapp/messages` -- the route that
   * lists a project's WhatsApp message log -- had NO volumetric throttle at
   * all, unlike its own DELETE siblings on the same path (both already
   * gated by whatsappHistoryRateLimiter just above). Lower severity than
   * other gaps this series closed (`listWhatsAppMessages` is already
   * keyset-paginated at `LIMIT 50` per call, bounding each call's own
   * cost), but nothing stopped unbounded *call frequency* from any
   * collaborator with mere read access (`requireProjectAccess`, not write).
   *
   * Deliberately NOT whatsappHistoryRateLimiter's own 30-per-15-min budget:
   * that limiter is sized for occasional housekeeping (clear/delete), but
   * WhatsAppPanel.tsx's own `startConnectedPolling` calls this exact route
   * every `CONNECTED_POLL_INTERVAL_MS` (10 seconds) for as long as the
   * panel sits open on a connected integration -- 6 calls/minute, 90 calls
   * in any 15-minute window, from a single ordinary open panel doing
   * nothing but sitting there. Applying the 30-per-window budget here would
   * 429 a real user's own panel after roughly 5 minutes of normal use, not
   * just an abusive scripted loop -- a regression, not a fix. This
   * dedicated limiter's budget instead comfortably covers that baseline
   * background-poll rate plus the initial load-on-mount fetch and manual
   * "load older messages" pagination clicks, while still bounding a
   * genuinely abusive loop (e.g. polling far faster than the UI ever does)
   * well below what would meaningfully stall this process for every other
   * project.
   */
  const whatsappMessagesReadRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 300,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many WhatsApp message requests. Please try again later.",
  });

  /**
   * Round 1172: PATCH .../name and PATCH .../description had no volumetric
   * throttle at all -- the last two plain mutations left in this file
   * without one after round 1171's own sweep closed every other gap. Not
   * specEditRateLimiter below: that one is scoped to the pre-build spec
   * (entities/fields/relations) and every route using it also carries the
   * activePipelines guard these two routes deliberately don't need (see
   * their own doc comments -- description is never read-modify-written
   * anywhere else, and a bare name/description edit doesn't touch
   * project.spec at all). A project's display name and description are the
   * same real question either way -- "how much can this account edit this
   * project's own basic metadata" -- so one dedicated limiter, shared
   * between both routes, rather than a spec-editing budget that doesn't fit
   * what either route actually does, or two separate budgets for what is
   * really one question asked two ways.
   */
  const projectMetadataRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many project metadata update requests. Please try again later.",
  });

  /**
   * Round 1179: `DELETE /projects/:id` -- this file's own doc comment on
   * that route already calls it "the single most destructive route in the
   * app" -- was the one mutating route in this entire file with NO
   * volumetric throttle at all, the exact "unguarded mutating route"
   * pattern rounds 1163/1169/1171/1172/1153 already closed everywhere
   * else they found it, just missed on arguably the highest-cost route of
   * all. Unlike projectCreationRateLimiter above (which bounds how many
   * NEW project rows an account can create), this route's own real cost
   * is different and arguably higher per call: a genuine network
   * round-trip tearing down a live WhatsApp Web socket
   * (`whatsapp.disconnect`), a full cascading DB delete of every table
   * the project owns, and a filesystem walk deleting its uploads
   * directory -- so this gets its own dedicated budget ("how many whole
   * projects can this account irreversibly delete per window"), not a
   * shared one with creation, matching this file's own established
   * sharing-vs-dedicated discipline (round 1082's doc comment): share
   * only when two routes answer the identical real budget question,
   * dedicate when the per-call cost and the question genuinely differ.
   * Capped lower than creation's 30/15min given the heavier per-call
   * cost, while still well above what a person clicking delete on
   * several real projects in a row would ever hit.
   */
  const projectDeletionRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.userId ?? "unknown",
    message: "Too many project deletion requests. Please try again later.",
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
    projectCreationRateLimiter,
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
   *
   * Round 1290: this doc comment's own "with no warning to them" was an
   * acknowledged, never-closed gap -- every other collaborator-impacting
   * action in this file (invite, role change, removal, ownership
   * transfer, project deletion, self-leave) already emails the affected
   * party, but a token rotation silently broke every other
   * collaborator's calendar app subscription with zero signal. The owner
   * who triggered this already knows; only the OTHER collaborators need
   * telling.
   *
   * Round 1313: unlike every sibling owner-only mutation in this file
   * (role change just below, removal, ownership transfer, project
   * deletion, self-leave), this route never got the matching
   * withIdempotency() wrap -- a response lost in transit after
   * fetchWithWakeRetry's own documented risk window (the server already
   * committed, but the reply never arrived) made its retry rotate the
   * token a SECOND time and send every collaborator a second, confusing
   * "your calendar subscription link was reset" email for what the owner
   * experienced as one click -- and silently invalidated the very token
   * from attempt 1 the owner never even got to see. requireProjectOwner
   * moves inside the withIdempotency callback for the identical reason
   * every sibling route's own doc comment already gives: a genuine retry
   * never reaches it, since the wrap short-circuits first with the first
   * attempt's own cached response.
   */
  router.post(
    "/projects/:id/calendar-feed-token/regenerate",
    calendarFeedTokenRateLimiter,
    asyncRoute(async (req, res) => {
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${req.params.id}/calendar-feed-token/regenerate`, async () => {
        const project = requireProjectOwner(db, req.params.id, req.userId!);
        const token = regenerateCalendarFeedToken(db, req.params.id);
        if (emailSender.configured) {
          const isHebrew = req.query.lang !== "en";
          const subject = isHebrew
            ? `קישור הלוח שנה של "${project.name}" ב-Forge AI אופס`
            : `The calendar link for "${project.name}" on Forge AI was reset`;
          const emailBody = isHebrew
            ? `בעל/ת הפרויקט "${project.name}" ב-Forge AI אפס/ה את קישור הלוח שנה. ההרשמה הקיימת שלך בלוח השנה הפסיקה לעבוד -- יש להירשם מחדש מתוך הפרויקט.`
            : `The owner of "${project.name}" on Forge AI reset the calendar subscription link. Your existing calendar subscription has stopped working -- you'll need to re-subscribe from within the project.`;
          for (const collaborator of listCollaborators(db, project.id)) {
            try {
              await emailSender.send(collaborator.email, subject, emailBody);
            } catch {
              // Swallowed, deliberately, same as this route family's own
              // convention -- the rotation itself already succeeded and
              // was already committed; a failed best-effort notification
              // must never turn that into an error response.
            }
          }
        }
        return { status: 200, body: { token } };
      });
      res.json(body);
    }),
  );

  /**
   * Round 1405 originally gated this with requireProjectAccess, reasoning
   * (incorrectly) that it mirrored the calendar-feed-token GET route's own
   * "no new exposure" logic. That logic only holds for a READ capability:
   * the calendar feed only ever exposes records a viewer can already see
   * through the live app. This route hands out the opposite -- a durable
   * token that lets its holder create records (and fire the resulting
   * automation fan-out: WhatsApp/email/outbound-webhook sends) through the
   * fully unauthenticated public route (routes/webhookIn.ts), with no
   * further access check once issued. A "viewer" collaborator categorically
   * cannot create a record anywhere else in this app -- every record-
   * mutating route uses requireProjectWriteAccess precisely to enforce that
   * (see requireProjectWriteAccess's own doc comment above) -- so handing
   * them this token was a real privilege escalation: round 1406 round-tripped
   * through this exact file without catching it, since it only touched
   * app.ts's body-parsing middleware, not this route's own access check.
   * requireProjectWriteAccess here closes it, matching every other route
   * that can lead to a new record being created.
   */
  router.get(
    "/projects/:id/inbound-webhook-token",
    asyncRoute(async (req, res) => {
      requireProjectWriteAccess(db, req.params.id, req.userId!);
      res.json({
        token: getOrCreateInboundWebhookToken(db, req.params.id),
        lastInboundWebhookAt: getLastInboundWebhookAt(db, req.params.id),
        // Round 1471: see recordInboundWebhookFailure's own doc comment
        // (packages/db) -- the failure-side counterpart to
        // lastInboundWebhookAt just above.
        lastInboundWebhookFailure: getLastInboundWebhookFailure(db, req.params.id),
      });
    }),
  );

  /**
   * Round 1405: once any collaborator has fetched the token above and
   * configured it into an external service (Stripe, Typeform), there
   * must be a way to invalidate it -- mirrors the calendar-feed-token
   * regenerate route's own shape exactly: requireProjectOwner (rotating
   * this also breaks every other collaborator's already-configured
   * external integration with no other warning, the identical tradeoff
   * that route's own doc comment already names), rate-limited, and
   * wrapped in withIdempotency with requireProjectOwner moved inside the
   * callback, for the identical "a retry must never rotate twice" reason
   * that route's own round-1313 fix gives.
   *
   * Round 1419: round 1405's original version here deliberately did NOT
   * email every other collaborator the way the calendar-feed-token sibling
   * route above does, reasoning that this token "only ever configures the
   * OWNER's own external integration dashboard" with no equivalent harm to
   * warn anyone else about. Round 1407 (a later round) invalidated that
   * exact premise: the GET route above was widened from owner-only to
   * requireProjectWriteAccess specifically so an EDITOR collaborator could
   * also fetch this token and wire it into their own external service --
   * at which point rotating it silently breaks THEIR integration too, with
   * a real external sender (Stripe, Typeform) now POSTing to a token that
   * 404s, losing real orders/leads/payment events with no signal anywhere.
   * Mirrors the calendar route's own round-1290 fix exactly.
   *
   * Round 1687: round 1290's fix was copied verbatim, including its
   * unfiltered `listCollaborators(db, project.id)` loop -- but that loop's
   * audience was correct there only because the calendar-feed-token GET
   * route it mirrors is requireProjectAccess (open to viewers too), so
   * every collaborator, viewer included, really could have subscribed.
   * This route's own GET route above is requireProjectWriteAccess (round
   * 1407, by design -- a viewer categorically cannot create a record
   * anywhere else in this app, so handing them this token would be a
   * privilege escalation): a viewer collaborator never could fetch this
   * token or see any UI to configure it (CollaboratorsPanel.tsx/
   * EntityPanel.tsx both hide the whole inbound-webhook section for
   * readOnly users), so "if you had configured an external service... you'll
   * need to copy the new URL from within the project" is simply false for
   * them -- there is no such UI they can reach. Excluding viewers here
   * matches this route's own narrower access boundary instead of blindly
   * re-using the calendar route's broader one.
   */
  router.post(
    "/projects/:id/inbound-webhook-token/regenerate",
    inboundWebhookTokenRateLimiter,
    asyncRoute(async (req, res) => {
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${req.params.id}/inbound-webhook-token/regenerate`, async () => {
        const project = requireProjectOwner(db, req.params.id, req.userId!);
        const token = regenerateInboundWebhookToken(db, req.params.id);
        if (emailSender.configured) {
          const isHebrew = req.query.lang !== "en";
          const subject = isHebrew
            ? `כתובת ה-Webhook הנכנס של "${project.name}" ב-Forge AI אופסה`
            : `The inbound webhook URL for "${project.name}" on Forge AI was reset`;
          const emailBody = isHebrew
            ? `בעל/ת הפרויקט "${project.name}" ב-Forge AI אפס/ה את כתובת ה-Webhook הנכנס. אם הגדרת שירות חיצוני (כמו Stripe או Typeform) לשלוח לכתובת הישנה, הוא הפסיק לעבוד -- יש להעתיק את הכתובת החדשה מתוך הפרויקט ולהגדיר אותה שם מחדש.`
            : `The owner of "${project.name}" on Forge AI reset the inbound webhook URL. If you had configured an external service (like Stripe or Typeform) to send to the old URL, it has stopped working -- you'll need to copy the new URL from within the project and update it there.`;
          // Round 1687: viewers never had access to this token (see the doc
          // comment above) -- only editor collaborators could have configured
          // an external integration with it.
          for (const collaborator of listCollaborators(db, project.id).filter((c) => c.role !== "viewer")) {
            try {
              await emailSender.send(collaborator.email, subject, emailBody);
            } catch {
              // Swallowed, deliberately, same as this route family's own
              // convention -- the rotation itself already succeeded and
              // was already committed; a failed best-effort notification
              // must never turn that into an error response.
            }
          }
        }
        return { status: 200, body: { token } };
      });
      res.json(body);
    }),
  );

  /**
   * A project's name is otherwise only ever set once at creation
   * (deriveName's auto-derived first few words of the description), with
   * no way to fix it -- including the generic "(copy)" suffix a clone
   * starts with. requireProjectAccess (not requireProjectOwner): a
   * collaborator has the exact same full read/write access as the owner
   * everywhere else, and a project's display name is no different.
   *
   * Round 1601: unlike every other "rename X" PATCH mutation in this app
   * (entity/field labels, checkpoints, roles/personas/assumptions -- round
   * 960's own doc comment gives the exact hazard), this route and its
   * sibling just below it never got the matching withIdempotency() wrap.
   * A response lost in transit after fetchWithWakeRetry's own documented
   * retry fires, with a genuinely newer rename from another
   * tab/collaborator landing in between, means the stale retry silently
   * overwrites that newer name back to the old one with no error to
   * either side -- the identical bug round 960 already fixed for every
   * other rename in the app, just never ported here.
   * requireProjectWriteAccess moves inside the withIdempotency callback
   * for the identical reason every sibling route's own doc comment
   * already gives: a genuine retry never reaches it, since the wrap
   * short-circuits first with the first attempt's own cached response.
   */
  router.patch(
    "/projects/:id/name",
    projectMetadataRateLimiter,
    asyncRoute(async (req, res) => {
      const parsed = RenameProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { body } = await withIdempotency(db, idempotencyKey, req.userId!, `PATCH /projects/${req.params.id}/name`, async () => {
        const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
        const updated = updateProjectName(db, project.id, parsed.data.name);
        return { status: 200, body: { project: updated } };
      });
      res.json(body);
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
   *
   * Round 1601: same withIdempotency() gap, and the same reason, as the
   * name route right above.
   */
  router.patch(
    "/projects/:id/description",
    projectMetadataRateLimiter,
    asyncRoute(async (req, res) => {
      const parsed = UpdateProjectDescriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { body } = await withIdempotency(db, idempotencyKey, req.userId!, `PATCH /projects/${req.params.id}/description`, async () => {
        const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
        const updated = updateProjectDescription(db, project.id, parsed.data.description);
        return { status: 200, body: { project: updated } };
      });
      res.json(body);
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
    projectCreationRateLimiter,
    asyncRoute(async (req, res) => {
      const source = requireProjectAccess(db, req.params.id, req.userId!);
      const suffix = isHebrewText(source.description) ? " (עותק)" : " (copy)";
      // Round 1410: this route builds its own `name` by string concatenation
      // and writes it straight to insertProject, bypassing CreateProjectSchema/
      // RenameProjectSchema entirely -- so the PROJECT_NAME_MAX_LENGTH ceiling
      // those two schemas enforce everywhere else silently didn't apply here.
      // Repeatedly cloning a clone chains this suffix with no bound
      // ("X" -> "X (copy)" -> "X (copy) (copy)" -> ...), and the result feeds
      // straight into the same collaborator-broadcast emails round 1408
      // closed this exact amplification for. Truncated, not rejected with a
      // 400: this value is server-synthesized, not something the user typed
      // into an editable field, so there's nothing for a validation error to
      // ask them to fix.
      const rawName = `${source.name}${suffix}`;
      const name = rawName.length > PROJECT_NAME_MAX_LENGTH
        ? `${source.name.slice(0, PROJECT_NAME_MAX_LENGTH - suffix.length)}${suffix}`
        : rawName;
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${source.id}/clone`, async () => {
        const cloned = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name,
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
   *
   * Round 1256: like invite/role-change/removal/transfer-ownership before
   * their own fixes (rounds 1253/1254/1254/1255), this gave every
   * collaborator on the project zero signal that their access was just
   * revoked -- arguably the starkest version of that same gap, since
   * deleteProject's cascade (collaborators.ts's own module comment) drops
   * every collaborator row on this project in one shot, and App.tsx's
   * subscribeProjectGone/subscribeViewerDemoted only self-correct an
   * already-open tab's in-session state, so an offline collaborator finds
   * out only by noticing the project missing next time they look.
   */
  router.delete(
    "/projects/:id",
    projectDeletionRateLimiter,
    asyncRoute(async (req, res) => {
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(db, idempotencyKey, req.userId!, `DELETE /projects/${req.params.id}`, async () => {
        const project = requireProjectOwner(db, req.params.id, req.userId!);
        if (activePipelines.has(project.id)) {
          throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
        }
        // Round 1256: must be read BEFORE deleteProject's own cascade
        // erases these very rows -- see this route's own doc comment above.
        const collaboratorsBeforeDelete = listCollaborators(db, project.id);
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
        if (collaboratorsBeforeDelete.length > 0 && emailSender.configured) {
          const isHebrew = req.query.lang !== "en";
          const subject = isHebrew ? `הפרויקט "${project.name}" ב-Forge AI נמחק` : `"${project.name}" on Forge AI was deleted`;
          const body = isHebrew
            ? `הפרויקט "${project.name}" ב-Forge AI נמחק על ידי הבעלים שלו, ואין לך יותר גישה אליו.`
            : `"${project.name}" on Forge AI was deleted by its owner, and you no longer have access to it.`;
          for (const collaborator of collaboratorsBeforeDelete) {
            try {
              await emailSender.send(collaborator.email, subject, body);
            } catch {
              // Swallowed, deliberately, same as this route family's own
              // convention -- the delete itself already succeeded and was
              // already committed; a failed best-effort notification must
              // never turn that into an error response.
            }
          }
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

  /**
   * Round 1253: until now this route gave the invited user zero signal that
   * it happened -- no email, no desktop notification, nothing (confirmed by
   * `sharedProjectSeen.ts`'s own round-401 doc comment, which built an
   * in-app "New share" chip specifically because no other signal existed,
   * and whose own closing note left a real email notification open only
   * "if שלומי explicitly asks for real email infrastructure" -- infra that
   * now exists and is already used, unprompted, for four other
   * notifications: login-code, forgot-password, change-email (round 1206),
   * and change-password (round 1252)). Best-effort, mirroring those same
   * routes' own swallowed-send contract: the grant itself already
   * succeeded and was already committed, so a failed send must never
   * surface as an error on this request. Checked BEFORE calling
   * addCollaborator (not via its own return value, which is `void`) --
   * addCollaborator is deliberately idempotent (CollaboratorsPanel.tsx's
   * own doc comment on `handleInvite`), so re-inviting someone already on
   * the project is a silent no-op with nothing for them to be notified
   * about.
   */
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
      const isNewGrant = getCollaboratorRole(db, project.id, invited.id) === null;
      addCollaborator(db, project.id, invited.id, parsed.data.role);
      // Round 1665: the one sibling in this route's own "invite/role-change/
      // removal/ownership-transfer" access-change family (see the PATCH
      // role route and DELETE route just below, rounds 1636/1654) that
      // never got an audit-trail entry -- going from no access to some role
      // is the single most fundamental access change there is, yet it left
      // no trace once the grant was later changed or removed. Gated on
      // isNewGrant, same as the email send just below: addCollaborator is
      // deliberately idempotent, so re-inviting an existing collaborator is
      // a silent no-op with no actual access change to log.
      if (isNewGrant) {
        insertCollaboratorAccessChange(db, {
          projectId: project.id,
          targetUserId: invited.id,
          changedByUserId: req.userId!,
          action: "invited",
          previousRole: null,
          newRole: parsed.data.role,
        });
      }
      if (isNewGrant && emailSender.configured) {
        const isHebrew = parsed.data.lang !== "en";
        const subject = isHebrew ? `הוזמנת לפרויקט "${project.name}" ב-Forge AI` : `You were invited to "${project.name}" on Forge AI`;
        const body = isHebrew
          ? `הוזמנת לשתף פעולה בפרויקט "${project.name}" ב-Forge AI, עם הרשאת ${parsed.data.role === "viewer" ? "צפייה בלבד" : "עריכה"}.\n\nהיכנסו לחשבונכם כדי לראות אותו.`
          : `You were invited to collaborate on "${project.name}" on Forge AI, with ${parsed.data.role === "viewer" ? "view-only" : "editor"} access.\n\nSign in to your account to see it.`;
        try {
          await emailSender.send(invited.email, subject, body);
        } catch {
          // Swallowed, deliberately, same as the auth.ts notification
          // routes' own convention -- the invite itself already succeeded
          // and was already committed to the database; a failed
          // best-effort notification must never turn that into an error
          // response.
        }
      }
      res.status(201).json({ collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) });
    }),
  );

  /**
   * Owner-only, like inviting itself: changes an existing collaborator's
   * role between "editor" (full read/write) and "viewer" (read-only,
   * enforced by requireProjectWriteAccess on every mutating route). Does
   * NOT let the owner target their own id -- ownership isn't a role row at
   * all, so there is no "role" of the owner's to change.
   *
   * Round 1171: had no volumetric throttle at all, unlike every sibling
   * mutation in this file. Shares inviteCollaboratorRateLimiter's own
   * budget rather than a new dedicated limiter -- inviting, changing a
   * role, removing, and (below) transferring ownership are all the same
   * real question: how much can this owner churn who has access to, or
   * owns, this project.
   *
   * Round 1254: like the sibling invite route before round 1253's own
   * fix, this gave the AFFECTED collaborator zero signal that their own
   * access level just changed -- rounds 886/891's subscribeViewerDemoted
   * only self-corrects an already-open tab's in-session UI state, so a
   * collaborator who's offline or has the tab closed has no way to find
   * out until they happen to notice different buttons next time they
   * open the project. Best-effort, mirroring round 1253's own
   * swallowed-send contract exactly: the role change itself already
   * succeeded and was already committed.
   */
  router.patch(
    "/projects/:id/collaborators/:userId/role",
    inviteCollaboratorRateLimiter,
    asyncRoute(async (req, res) => {
      const parsed = UpdateCollaboratorRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `PATCH /projects/${req.params.id}/collaborators/${req.params.userId}/role`, async () => {
        const project = requireProjectOwner(db, req.params.id, req.userId!);
        if (req.params.userId === project.ownerId) {
          throw new HttpError(400, "The project owner doesn't have a collaborator role to change", "CANNOT_CHANGE_OWNER_ROLE");
        }
        const previousRole = getCollaboratorRole(db, project.id, req.params.userId);
        if (previousRole === null) {
          throw new HttpError(404, "Collaborator not found", "COLLABORATOR_NOT_FOUND");
        }
        updateCollaboratorRole(db, project.id, req.params.userId, parsed.data.role);
        // Round 1636: docs/security.md's own "Section 40" note named this
        // exact gap explicitly -- a role change had no "who did this"
        // trail at all, unlike checkpoint creation/restore (rounds 1567/
        // 1568) and record deletion (round 1632). Logged unconditionally,
        // even when previousRole === parsed.data.role (a no-op resubmit),
        // mirroring insertRecordDeletion's own "every real DB write gets
        // logged" convention -- the affected-user notification email just
        // below is a different, narrower concern (only a REAL change is
        // worth emailing someone about) and deliberately stays untouched.
        insertCollaboratorAccessChange(db, {
          projectId: project.id,
          targetUserId: req.params.userId,
          changedByUserId: req.userId!,
          action: "role_changed",
          previousRole,
          newRole: parsed.data.role,
        });
        // Round 1262: mirrors the sibling invite route's own isNewGrant
        // check (round 1253) -- without comparing against the role this
        // collaborator already had, re-submitting the same role (a UI
        // double-click, or a retried request this withIdempotency wrap
        // itself doesn't catch on its very first attempt) sent a "your
        // access was changed to X" email claiming a change that never
        // happened.
        const affected = previousRole !== parsed.data.role ? findUserById(db, req.params.userId) : null;
        if (affected && emailSender.configured) {
          const isHebrew = parsed.data.lang !== "en";
          const roleLabel = parsed.data.role === "viewer" ? (isHebrew ? "צפייה בלבד" : "view-only") : isHebrew ? "עריכה" : "editor";
          const subject = isHebrew ? `ההרשאה שלך בפרויקט "${project.name}" ב-Forge AI השתנתה` : `Your access to "${project.name}" on Forge AI was changed`;
          const emailBody = isHebrew
            ? `ההרשאה שלך בפרויקט "${project.name}" ב-Forge AI שונתה להרשאת ${roleLabel}.`
            : `Your access to "${project.name}" on Forge AI was changed to ${roleLabel}.`;
          try {
            await emailSender.send(affected.email, subject, emailBody);
          } catch {
            // Swallowed, deliberately, same as the invite route's own send
            // above -- the role change itself already succeeded and was
            // already committed to the database; a failed best-effort
            // notification must never turn that into an error response.
          }
        }
        return { status: 200, body: { collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * Round 1719: the invite route's own notification email (just above) only
   * ever fires once, gated on isNewGrant -- addCollaborator is deliberately
   * idempotent (its own doc comment, packages/db/src/collaborators.ts), so
   * re-submitting the same invite is a silent no-op with no second email.
   * An invitee who never actually received that first email (the send
   * above is best-effort and swallows its own failures; RESEND_API_KEY may
   * not have been configured yet at invite time) had no way to get it
   * resent -- the only existing workaround, removing then re-inviting
   * them, fires its own "you were removed" email first (the DELETE route
   * below), so even that sends a confusing extra message just to resend
   * one notification.
   *
   * Deliberately does NOT touch collaborator_access_changes (no access
   * actually changed here) or addedAt/role (unlike the role-change route
   * just above, nothing here is a real mutation to log) -- this route's
   * only job is re-sending the exact same template the invite route above
   * already sends, for the role the collaborator currently holds. Mirrors
   * /auth/resend-verification's own shape (routes/auth.ts): a 503
   * *_EMAIL_NOT_CONFIGURED when there's no provider to send through at
   * all, and a real send failure surfaces as an explicit error instead of
   * being swallowed -- unlike every other best-effort notification in this
   * file, this route's entire purpose IS the email, so silently returning
   * success when nothing was actually sent would be worse than an error.
   */
  router.post(
    "/projects/:id/collaborators/:userId/resend-invite",
    inviteCollaboratorRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectOwner(db, req.params.id, req.userId!);
      const parsed = ResendInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const role = getCollaboratorRole(db, project.id, req.params.userId);
      if (role === null) {
        throw new HttpError(404, "Collaborator not found", "COLLABORATOR_NOT_FOUND");
      }
      if (!emailSender.configured) {
        throw new HttpError(
          503,
          "Collaborator invite emails aren't available on this deployment yet -- no email provider is configured",
          "COLLABORATOR_EMAIL_NOT_CONFIGURED",
        );
      }
      const target = findUserById(db, req.params.userId);
      if (!target) {
        throw new HttpError(404, "Collaborator not found", "COLLABORATOR_NOT_FOUND");
      }
      const isHebrew = parsed.data.lang !== "en";
      const subject = isHebrew ? `הוזמנת לפרויקט "${project.name}" ב-Forge AI` : `You were invited to "${project.name}" on Forge AI`;
      const body = isHebrew
        ? `הוזמנת לשתף פעולה בפרויקט "${project.name}" ב-Forge AI, עם הרשאת ${role === "viewer" ? "צפייה בלבד" : "עריכה"}.\n\nהיכנסו לחשבונכם כדי לראות אותו.`
        : `You were invited to collaborate on "${project.name}" on Forge AI, with ${role === "viewer" ? "view-only" : "editor"} access.\n\nSign in to your account to see it.`;
      try {
        await emailSender.send(target.email, subject, body);
      } catch (err) {
        throw new HttpError(502, `Failed to resend the invite email: ${(err as Error).message}`, "COLLABORATOR_EMAIL_SEND_FAILED");
      }
      res.status(204).end();
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
   *
   * Round 1171: had no volumetric throttle at all. Shares
   * inviteCollaboratorRateLimiter's own budget, the same "churn who has
   * access to this project" question as invite/role-change/transfer-
   * ownership -- keyed by req.userId regardless of whether this request
   * is an owner removing someone else or a collaborator leaving on their
   * own, so a self-service "leave" never collides with a separate
   * account's own unrelated allowance.
   *
   * Round 1191: same withIdempotency() extension, and the same reason, as
   * POST .../transfer-ownership's own round-1189 fix -- docs/wakeRetry-
   * idempotency-design.md's standing inventory classified this whole
   * route as "already safe" because removeCollaborator (a plain
   * `DELETE ... WHERE`) is a no-op on a retried call, but that reasoning
   * never checked the AUTH GATE that runs before it. For the self-leave
   * path specifically (isSelf below), the first successful call removes
   * the caller's own collaborator row, so requireProjectAccess on a
   * retry -- the caller is no longer the owner OR a collaborator --
   * throws its own 404 "Project not found" for a leave that, from the
   * caller's own point of view, already fully succeeded. The owner-
   * removes-someone-else path has no such issue (the owner's own access
   * is untouched by removing a different collaborator), but this route
   * serves both, so the fix covers it unconditionally.
   *
   * Round 1254: the owner-removes-someone-else path gave the removed
   * collaborator zero signal, the same gap round 1254's own role-change
   * fix above just closed -- see that route's own doc comment. Never
   * sent for the self-leave path (isSelf): notifying someone that they
   * just did the thing they themselves asked to do is pure noise, not a
   * signal. `lang` has nowhere to live in a bodyless DELETE, so it's
   * read as a query param instead, the one place left for it on this
   * route.
   */
  router.delete(
    "/projects/:id/collaborators/:userId",
    inviteCollaboratorRateLimiter,
    asyncRoute(async (req, res) => {
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(db, idempotencyKey, req.userId!, `DELETE /projects/${req.params.id}/collaborators/${req.params.userId}`, async () => {
        const project = requireProjectAccess(db, req.params.id, req.userId!);
        const isSelf = req.params.userId === req.userId;
        if (project.ownerId !== req.userId! && !isSelf) {
          throw new HttpError(403, "Only the project owner can remove a different collaborator", "COLLABORATOR_CANNOT_REMOVE_OTHERS");
        }
        // Round 1269: mirrors the sibling PATCH-role route's own
        // previousRole !== newRole check (round 1262) -- removeCollaborator
        // is a plain DELETE with no "did this actually remove a row" signal,
        // so without first confirming the target was still a real
        // collaborator, a retried/duplicate DELETE (e.g. two collaborator-
        // panel tabs both showing the same stale list, each removing the
        // same person) found the target still existed as a USER and sent a
        // second, spurious "you were removed" email for a no-op removal.
        // Round 1636: read once and reused below (the audit-log entry
        // needs the actual role value, not just whether one existed) --
        // previously this called getCollaboratorRole a second time, just
        // below, purely to re-derive the same boolean for wasSelfCollaborator.
        const targetRoleBeforeRemoval = getCollaboratorRole(db, project.id, req.params.userId);
        const wasCollaborator = !isSelf && targetRoleBeforeRemoval !== null;
        const removed = wasCollaborator ? findUserById(db, req.params.userId) : null;
        // Round 1277: mirrors `wasCollaborator` just above (round 1269) for
        // the self-leave path, as defense in depth -- in practice a
        // genuine SECOND ordinary self-leave call (no idempotency-key
        // replay involved) already 404s at requireProjectAccess above
        // before ever reaching this line, since the caller lost their own
        // access on the first call (round 1191's own doc comment). This
        // guard only matters for a theoretical race between two in-flight
        // requests reaching here before either commits. Naturally stays
        // null for the owner calling this on their own id too:
        // getCollaboratorRole always returns null for the owner (they're
        // never a row in project_collaborators), so there's no
        // self-notifying-self case either.
        const wasSelfCollaborator = isSelf && targetRoleBeforeRemoval !== null;
        const leaver = wasSelfCollaborator ? findUserById(db, req.userId!) : null;
        removeCollaborator(db, project.id, req.params.userId);
        // Round 1636: docs/security.md's own "Section 40" note named this
        // exact gap -- removing a collaborator had no "who did this" trail
        // at all, the sibling gap the role-change route's own fix just
        // above closed. Only logged when a row was actually removed
        // (wasCollaborator/wasSelfCollaborator, the same guards `removed`/
        // `leaver` already use just above), so a no-op DELETE (retried
        // idempotency replay, or the owner targeting their own id) never
        // adds a spurious entry.
        if (wasCollaborator || wasSelfCollaborator) {
          insertCollaboratorAccessChange(db, {
            projectId: project.id,
            targetUserId: req.params.userId,
            changedByUserId: req.userId!,
            action: "removed",
            previousRole: targetRoleBeforeRemoval,
            newRole: null,
          });
        }
        if (removed && emailSender.configured) {
          const isHebrew = req.query.lang !== "en";
          const subject = isHebrew ? `הוסרת מהפרויקט "${project.name}" ב-Forge AI` : `You were removed from "${project.name}" on Forge AI`;
          const body = isHebrew
            ? `הוסרת מהפרויקט "${project.name}" ב-Forge AI ואין לך יותר גישה אליו.`
            : `You were removed from "${project.name}" on Forge AI and no longer have access to it.`;
          try {
            await emailSender.send(removed.email, subject, body);
          } catch {
            // Swallowed, deliberately, same as this route family's own
            // convention -- the removal itself already succeeded and was
            // already committed to the database; a failed best-effort
            // notification must never turn that into an error response.
          }
        }
        // Round 1277: the owner previously got zero signal when a
        // collaborator left on their own -- every OTHER direction of a
        // collaborator-list change already notifies the affected party
        // (invite, role change, owner-removes-collaborator just above,
        // ownership transfer, project deleted), but a shrinking roster via
        // self-leave was the one remaining silent case. `owner` can be null
        // if the owner's own account was somehow since deleted (should-
        // never-happen, same defensive style as getOwnerInfo above).
        if (leaver && emailSender.configured) {
          const owner = findUserById(db, project.ownerId);
          if (owner) {
            const isHebrew = req.query.lang !== "en";
            const subject = isHebrew
              ? `${leaver.email} עזב/ה את הפרויקט "${project.name}" ב-Forge AI`
              : `${leaver.email} left "${project.name}" on Forge AI`;
            const body = isHebrew
              ? `${leaver.email} עזב/ה את הפרויקט "${project.name}" ב-Forge AI ואינו/ה יותר משתתף/ת בו.`
              : `${leaver.email} left "${project.name}" on Forge AI and is no longer a collaborator on it.`;
            try {
              await emailSender.send(owner.email, subject, body);
            } catch {
              // Swallowed, deliberately, same as this route family's own
              // convention.
            }
          }
        }
        return { status: 204, body: null };
      });
      res.status(status).end();
    }),
  );

  /**
   * Owner-only. The target must already be a collaborator on this project
   * (any role) -- getCollaboratorRole naturally returns null for a userId
   * that's either not a collaborator at all OR the project's own current
   * owner (who was never a collaborator row to begin with, see
   * collaborators.ts's own module comment), so this one check also already
   * rejects "transfer to yourself" with no extra code. transferProjectOwnership
   * (packages/db) swaps project.ownerId and demotes the previous owner to
   * an "editor" collaborator in one call, so they keep full access instead
   * of losing it outright.
   *
   * Round 1171: had no rate limiter at all when this route was first
   * added (round 1170) -- same gap round 1146/1169 already found and
   * fixed on this file's other owner-only mutations. Shares
   * inviteCollaboratorRateLimiter's own budget, the same reasoning as the
   * role-change/remove routes above: one real question for this whole
   * family of actions.
   *
   * Round 1189: same withIdempotency() extension, and the same reason, as
   * DELETE /projects/:id's own fix (round 945, see its doc comment) --
   * this route's own effect INVALIDATES the exact auth check
   * (requireProjectOwner) a retry re-evaluates: once a transfer succeeds,
   * the caller is no longer project.ownerId, so fetchWithWakeRetry's own
   * retry of a response lost in transit (its documented, accepted risk
   * window -- docs/wakeRetry-idempotency-design.md) got a plain 404
   * "Project not found" for a transfer that, from the caller's own point
   * of view, already fully succeeded -- CollaboratorsPanel's
   * handleTransferOwnership surfaces that 404 as a generic error message,
   * reading as "the project is gone" rather than "you handed it off"
   * right after the user did exactly that. requireProjectOwner has to
   * move INSIDE the withIdempotency callback for the identical reason
   * DELETE /projects/:id's own doc comment already explains: a genuine
   * retry never reaches it, the wrap short-circuits first with the first
   * attempt's own cached response.
   *
   * Round 1255: like the role-change and removal routes before round
   * 1254's own fix, this gave the new owner zero signal despite being
   * the single biggest access-change action in the file -- the new
   * owner gains full control (including the ability to delete the
   * project outright) with no email telling them so if they're offline
   * or don't have the project open. Best-effort, mirroring round 1254's
   * own swallowed-send contract exactly: the transfer itself already
   * succeeded and was already committed. The previous owner initiated
   * the transfer themselves, so -- same "notifying someone of the thing
   * they themselves just did is noise" rationale as the self-leave path
   * above -- they get nothing.
   */
  router.post(
    "/projects/:id/transfer-ownership",
    inviteCollaboratorRateLimiter,
    asyncRoute(async (req, res) => {
      const parsed = TransferOwnershipSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, `POST /projects/${req.params.id}/transfer-ownership`, async () => {
        const project = requireProjectOwner(db, req.params.id, req.userId!);
        const previousRole = getCollaboratorRole(db, project.id, parsed.data.userId);
        if (previousRole === null) {
          throw new HttpError(404, "Collaborator not found", "COLLABORATOR_NOT_FOUND");
        }
        const updated = transferProjectOwnership(db, project.id, parsed.data.userId);
        // Round 1654: docs/security.md's own "Section 40" note named
        // role_changed/removed as this audit trail's scope (round 1636),
        // but ownership transfer -- the single biggest access-change
        // action in this file (round 1255's own doc comment just above)
        // -- was left out of that same sweep, even though it's the exact
        // "who changed whose access and how" event this table exists to
        // capture. newRole: null mirrors "removed"'s own shape -- "owner"
        // isn't a representable CollaboratorRole, so the action name
        // itself conveys the outcome.
        insertCollaboratorAccessChange(db, {
          projectId: project.id,
          targetUserId: parsed.data.userId,
          changedByUserId: req.userId!,
          action: "ownership_transferred",
          previousRole,
          newRole: null,
        });
        // Round 1781: the other half of this same handoff -- the acting
        // user's own unrestricted "owner" standing was just reduced to a
        // capped "editor" collaborator (transferProjectOwnership, above)
        // -- is itself a real access change this audit trail exists to
        // capture, not just the new owner's gain. previousRole: null for
        // the same reason newRole: null is used just above: "owner" isn't
        // a representable CollaboratorRole.
        insertCollaboratorAccessChange(db, {
          projectId: project.id,
          targetUserId: req.userId!,
          changedByUserId: req.userId!,
          action: "previous_owner_demoted",
          previousRole: null,
          newRole: "editor",
        });
        const newOwner = findUserById(db, parsed.data.userId);
        if (newOwner && emailSender.configured) {
          const isHebrew = parsed.data.lang !== "en";
          const subject = isHebrew ? `הפרויקט "${project.name}" ב-Forge AI הועבר אליך` : `"${project.name}" on Forge AI was transferred to you`;
          const emailBody = isHebrew
            ? `הפרויקט "${project.name}" ב-Forge AI הועבר אליך וכעת אתה הבעלים שלו.`
            : `"${project.name}" on Forge AI was transferred to you, and you are now its owner.`;
          try {
            await emailSender.send(newOwner.email, subject, emailBody);
          } catch {
            // Swallowed, deliberately, same as this route family's own
            // convention -- the transfer itself already succeeded and was
            // already committed to the database; a failed best-effort
            // notification must never turn that into an error response.
          }
        }
        return { status: 200, body: { collaborators: listCollaborators(db, updated.id), owner: getOwnerInfo(db, updated), project: updated } };
      });
      res.status(status).json(body);
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
          const { spec: candidateSpec, providerName } = await generateSpec(combinedDescription, provider, isHebrewText(project.description));
          // Round 1759: this route used to store `candidateSpec` outright,
          // the exact same bug round 1714 fixed for /refine -- generateSpec
          // has no awareness of the CURRENT spec, so its candidate can
          // silently omit an entity/field/role/persona/assumption the user
          // manually added on this very screen (AddEntityForm/AddFieldForm/
          // AddRoleForm/etc. are only ever reachable pre-build, i.e. exactly
          // while this route is the one in play) moments before answering
          // an open question or typing an additional request and clicking
          // Build. Merging keeps everything already on project.spec and
          // only adds what the fresh candidate introduces that doesn't
          // already exist, instead of replacing outright.
          const nextSpec = mergeRefinedSpec(project.spec, candidateSpec);
          const oversizedField = findOversizedGeneratedSpecField(nextSpec);
          if (oversizedField) {
            throw new HttpError(
              422,
              `This would grow the app's ${oversizedField}, past what a single app can safely hold. Try a more focused request, or remove an existing entity/field first.`,
              "REFINED_SPEC_TOO_LARGE",
            );
          }
          const updated = updateProjectSpec(db, project.id, nextSpec);
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
    buildPipelineRateLimiter,
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
          createdByUserId: req.userId!,
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
        const { spec: candidateSpec, providerName } = await generateSpec(combinedDescription, provider, isHebrewText(project.description));
        // Round 1714: see mergeRefinedSpec's own doc comment -- generateSpec
        // has no awareness of the CURRENT spec, so a candidate it returns
        // can silently omit entities/fields/roles the project already has
        // (confirmed live: the very first refine of a Templates-Gallery
        // project routinely dropped whole curated entities). Merging keeps
        // every current entity/field/role and only adds what the candidate
        // introduces that doesn't already exist, instead of replacing
        // outright.
        const nextSpec = mergeRefinedSpec(project.spec, candidateSpec);
        const oversizedField = findOversizedGeneratedSpecField(nextSpec);
        if (oversizedField) {
          throw new HttpError(
            422,
            `This refinement would grow the app's ${oversizedField}, past what a single app can safely hold. Try a more focused request, or remove an existing entity/field first.`,
            "REFINED_SPEC_TOO_LARGE",
          );
        }
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
          createdByUserId: req.userId!,
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.get(
    "/projects/:id/checkpoints",
    checkpointRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Resolves each checkpoint's raw createdByUserId into a display email
      // here, at the route layer, rather than baking it into the checkpoint
      // row/schema itself -- see CheckpointSchema's own doc-comment for why.
      const collaboratorEmails: Record<string, string> = {};
      const owner = getOwnerInfo(db, project);
      if (owner) collaboratorEmails[owner.userId] = owner.email;
      for (const collaborator of listCollaborators(db, project.id)) {
        collaboratorEmails[collaborator.userId] = collaborator.email;
      }
      // Round 1568: the restore counterpart to createdByUserId above --
      // resolved via the exact same collaboratorEmails map, since a
      // restore's own actor is just as often the owner or a collaborator
      // as a checkpoint's creator is. undefined (never a fabricated value)
      // for a project that's never had a checkpoint restored.
      res.json({ checkpoints: listCheckpoints(db, project.id), collaboratorEmails, lastRestore: getLastCheckpointRestore(db, project.id) });
    }),
  );

  /**
   * Round 1632: the read side of the record-deletion audit trail -- any
   * collaborator (including a read-only viewer, same access level as
   * GET .../checkpoints above) can see who deleted what and when. Returns
   * the raw deletedByUserId rather than a resolved collaboratorEmails map
   * (unlike GET .../entities/:entityName's own createdByUserId resolution)
   * since the one caller (CollaboratorsPanel.tsx) already has owner/
   * collaborators loaded from its own listCollaborators call and can
   * resolve the email itself -- no reason to duplicate that lookup here.
   */
  router.get(
    "/projects/:id/record-deletions",
    checkpointRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ deletions: listRecordDeletions(db, project.id) });
    }),
  );

  /**
   * Round 1636: the sibling read endpoint for the audit trail the two
   * routes above (PATCH .../role, DELETE .../:userId) now write to --
   * mirrors GET .../record-deletions exactly (same requireProjectAccess,
   * same rate limiter, any collaborator can read it, not just the owner),
   * for the same reason: CollaboratorsPanel.tsx's own Copy/Download report
   * is already "the one surface a collaborator can already reach for
   * 'what happened on this project'" (see collaboratorsReport.ts's own
   * doc comment), so this is a read, not a write -- raw userIds, resolved
   * into emails by the caller the same way record-deletions already is.
   */
  router.get(
    "/projects/:id/collaborator-access-log",
    checkpointRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ changes: listCollaboratorAccessChanges(db, project.id) });
    }),
  );

  /**
   * Round 1639: the sibling read endpoint for the audit trail the two
   * .../label PATCH routes above now write to -- mirrors GET
   * .../collaborator-access-log exactly (same requireProjectAccess, same
   * rate limiter, any collaborator can read it, not just the owner), for
   * the same reason: this is a read, not a write.
   */
  router.get(
    "/projects/:id/schema-label-edits",
    checkpointRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ edits: listSchemaLabelEdits(db, project.id) });
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
    checkpointRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/checkpoints/${req.params.checkpointId}/restore`,
        async () => {
          const checkpoint = tryGetCheckpoint(db, req.params.checkpointId);
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
            // Round 1568: closes the half of docs/security.md's "No audit
            // log" gap round 1567 left open -- see recordCheckpointRestore's
            // own doc comment (packages/db) for why restore needed its own
            // audit columns, separate from checkpoints.createdByUserId.
            recordCheckpointRestore(db, project.id, checkpoint.id, req.userId!);
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
    checkpointRateLimiter,
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
    checkpointRateLimiter,
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
    expensiveReadRateLimiter,
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
    expensiveReadRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before backing up its data", "BUILD_REQUIRED");
      }
      const columnOrders = parseColumnOrdersQueryParam(req.query.columnOrders);
      const entries = generateBackupZipEntries(db, project, columnOrders, uploadsDir);
      /**
       * Round 1557: unlike /export's buildZip(files) just above (harmless
       * in practice there, since `files` is a fixed-size generated-app
       * skeleton bounded by entity/field counts, not user data), this
       * route's own entries scale with every entity's row count AND one
       * entry per uploaded file across every record (addUploadedFileEntries,
       * backup.ts) -- genuinely unbounded as a project's real data grows,
       * with no cap anywhere in this codebase. buildZip throws a plain
       * Error (every throw site's message contains "Zip64") once that
       * crosses one of its own five writer limits (entry count, per-entry
       * name/size, or total archive size) -- uncaught, that's the exact
       * "unexplained 500" failure class the /export route's own try/catch
       * just above was deliberately built to avoid, just never ported to
       * this sibling route whose underlying data can actually reach it.
       */
      let zip: Buffer;
      try {
        zip = buildZip(entries);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Zip64")) {
          throw new HttpError(
            422,
            "This project has too much data (too many records or uploaded files) to back up as a single ZIP file",
            "BACKUP_ARCHIVE_TOO_LARGE",
          );
        }
        throw err;
      }
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
            hadAttachment: Boolean(resolvedAttachment),
            waMessageId: result.waMessageId,
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
    whatsappMessagesReadRateLimiter,
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

  /**
   * Round 1171: had no volumetric throttle at all -- a single unbounded
   * DELETE over the whole message-history table for this project, which
   * any collaborator with write access (not just the owner) can call in a
   * tight loop with nothing server-side slowing it down.
   */
  router.delete(
    "/projects/:id/integrations/whatsapp/messages",
    whatsappHistoryRateLimiter,
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
   *
   * Round 1171: shares the bulk-clear route's own whatsappHistoryRateLimiter
   * -- the same real question (how much message-history housekeeping can
   * this account do), whether it's done one row or the whole table at a
   * time.
   */
  router.delete(
    "/projects/:id/integrations/whatsapp/messages/:messageId",
    whatsappHistoryRateLimiter,
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
    expensiveReadRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before viewing its Business Twin", "BUILD_REQUIRED");
      }
      // Round 1392: the overdue/due-soon classification below needs the
      // real business owner's own calendar date, not the server process's
      // OS timezone (UTC on Render) -- see twin.ts's own startOfDayInTimeZone
      // doc comment. Mirrors scheduleTimezone's own client-detected/
      // server-validated pattern (isValidIanaTimeZone, just above); an
      // absent or invalid value falls back to "UTC" rather than rejecting
      // the request, the same default every schedule rule created before
      // scheduleTimezone existed already gets.
      const requestedTimeZone = typeof req.query.timezone === "string" ? req.query.timezone : "";
      const timeZone = requestedTimeZone && isValidIanaTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
      res.json({ twin: computeBusinessTwin(db, project, new Date(), timeZone) });
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
    entityCountsRateLimiter,
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
    recordListRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      // Round 1613: resolves each record's raw createdByUserId into a
      // display email here, at the route layer -- the exact same
      // owner+collaborators lookup GET .../checkpoints already does for
      // its own createdByUserId, for the identical reason (the db layer
      // only ever stores a bare userId, never a fabricated/cached email).
      const collaboratorEmails: Record<string, string> = {};
      const owner = getOwnerInfo(db, project);
      if (owner) collaboratorEmails[owner.userId] = owner.email;
      for (const collaborator of listCollaborators(db, project.id)) {
        collaboratorEmails[collaborator.userId] = collaborator.email;
      }
      // Round 1638: listRecords() had no limit at all (flagged since round
      // 375, never implemented) -- an entity with tens of thousands of
      // rows meant every single load of this table sent its entire result
      // set over the wire, parsed it, and rendered it, no matter how large
      // it grew. totalCount is real (SELECT COUNT(*)), not records.length,
      // so the client can tell "every record fit" apart from "capped" even
      // when the count happens to land exactly on the cap. Every other
      // caller of listRecords (backup, Business Twin, seed, webhook
      // lookups, automations) is intentionally left unbounded -- only this
      // one interactive route opts into the cap.
      const totalCount = countRecords(db, project.id, entity);
      const records = listRecords(db, project.id, entity, RECORD_LIST_RESPONSE_CAP);
      res.json({ records, collaboratorEmails, totalCount, truncated: totalCount > records.length });
    }),
  );

  /**
   * Round 1678: the route just above's own truncation hint
   * (`entity.recordList.truncatedHint`, EntityPanel.tsx) literally tells a
   * user past RECORD_LIST_RESPONSE_CAP to "export to CSV to get all of
   * them" -- but EntityPanel's handleExportCsv/handleExportJson/handleCopy
   * all built their output from that exact same capped `records` state,
   * so the promise was false: an entity over the cap could never actually
   * be fully exported through this app's own UI. This sibling route is
   * deliberately uncapped -- see the round-1638 comment above for why
   * backup/Business Twin/seed/webhook lookups/automations all already
   * call listRecords() with no limit; export is the one interactive case
   * that is a genuine one-shot action, not a page a person stares at, so
   * it belongs in that same unbounded group rather than the capped one.
   * No collaboratorEmails/totalCount/truncated here: EntityPanel only
   * calls this to build a CSV/JSON/clipboard export, none of which render
   * createdByUserId or need to re-derive the already-known truncation
   * state.
   */
  router.get(
    "/projects/:id/entities/:entityName/export",
    expensiveReadRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const records = listRecords(db, project.id, entity);
      res.json({ records });
    }),
  );

  router.post(
    "/projects/:id/entities/:entityName",
    recordWriteRateLimiter,
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
            record = insertRecord(db, project.id, entity, req.body ?? {}, req.userId!);
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
          } else {
            // Round 1413: this header has no server-side provenance check --
            // any collaborator with write access can set it on an ordinary
            // single-record create, not just the CSV-import path that's
            // meant to send it (see the comment above). An editor who wants
            // to defeat this project's automations already has a much
            // bigger hammer available via the automation-rule CRUD routes
            // themselves (PATCH/DELETE .../automations/:ruleId, both gated
            // by this same requireProjectWriteAccess), so this isn't a
            // privilege escalation -- but unlike disabling a rule, it leaves
            // zero trace anywhere a project owner would look. This log line
            // closes that trace gap without touching the header's existing
            // behavior.
            console.warn(
              `X-Suppress-Automations: record ${record.id} created on entity "${entity.name}" of project ${project.id} by user ${req.userId} with automations suppressed`,
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
    fileUploadRateLimiter,
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
      // Round 1211: normalized to the entity's own canonical-cased name
      // now that findEntity has resolved it -- multer's own destination
      // callback (createUploadMiddleware above) and this route's own
      // response body below both read req.params.entityName directly, so
      // a differently-cased but still-resolving :entityName (findEntity's
      // own case-insensitive fallback, round 1162 -- a real, demonstrated
      // occurrence after a case-only entity rename, or simply a stale
      // client) would otherwise write the file to, and return a url
      // naming, a directory cased differently from every downstream
      // reader of the same descriptor: coerceValue's round-1210 fix
      // (packages/db/src/repository.ts) requires the stored url to match
      // this record's own canonical entity.name exactly, rejecting a
      // completely legitimate upload the moment its descriptor is saved
      // into a record; resolveUploadedFilePath/deleteUploadedFile
      // (uploadPaths.ts) rebuild the physical path from the canonical
      // entityName they're called with, never finding a file actually
      // written under the mismatched casing either.
      req.params.entityName = entity.name;
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
   *
   * Round 1169: this route shared its own path with the POST route above
   * yet had no rate limiter at all -- unlike the WhatsApp attachment pair
   * it mirrors, whose own DELETE sibling already sits behind
   * whatsappRateLimiter the same as its POST. deleteUploadedFile's silent
   * no-op for a non-matching url means this never needed a real file on
   * disk to hammer. Now shares fileUploadRateLimiter with the POST route
   * above (one combined budget per account across both verbs on this
   * path), the same way whatsappRateLimiter is already shared between its
   * own upload/delete pair.
   */
  router.delete(
    "/projects/:id/entities/:entityName/fields/:fieldName/upload",
    fileUploadRateLimiter,
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
    specEditRateLimiter,
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
          const previousLabel = entity.label ?? entity.name;
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) => (e.name === entity.name ? { ...e, label: parsed.data.label } : e)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1639: docs/security.md's own "Section 40" note still named
          // this exact gap -- an entity/field label rename is a live,
          // post-build edit that overwrote the previous label in place with
          // no "who did this" trail. Unlike round 1636's collaborator
          // role-change log (which logs a no-op resubmit too, since even an
          // unchanged role still represents a real access decision), a
          // resubmit of the exact same label is never a rename at all --
          // logging it would just add noise to a log whose entire purpose
          // is "what changed," so only a genuine label change is recorded.
          if (previousLabel !== parsed.data.label) {
            insertSchemaLabelEdit(db, {
              projectId: project.id,
              changedByUserId: req.userId!,
              action: "entity_renamed",
              entityName: entity.name,
              fieldName: null,
              previousLabel,
              newLabel: parsed.data.label,
            });
          }
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
    specEditRateLimiter,
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
          const previousLabel = field.label ?? field.name;
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name
                ? { ...e, fields: e.fields.map((f) => (f.name === field.name ? { ...f, label: parsed.data.label } : f)) }
                : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1639: the field-rename sibling of the entity-rename log
          // just above -- see its own doc comment for why a genuine
          // no-op (same label) is never logged.
          if (previousLabel !== parsed.data.label) {
            insertSchemaLabelEdit(db, {
              projectId: project.id,
              changedByUserId: req.userId!,
              action: "field_renamed",
              entityName: entity.name,
              fieldName: field.name,
              previousLabel,
              newLabel: parsed.data.label,
            });
          }
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
    specEditRateLimiter,
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
    specEditRateLimiter,
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
      // Round 1196: same case-insensitive tolerance, same reason, as the
      // identical check in the POST .../fields route just above.
      if (
        parsed.data.type === "relation" &&
        !project.spec.entities.some((e) => e.name === parsed.data.relationTo || e.name.toLowerCase() === parsed.data.relationTo?.toLowerCase())
      ) {
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
          const nextField: Field = {
            ...field,
            type: parsed.data.type,
            enumValues: parsed.data.type === "enum" ? parsed.data.enumValues : undefined,
            enumLabels:
              parsed.data.type === "enum" && field.enumLabels
                ? (() => {
                    const prevLabelsByLowerValue = new Map(
                      Object.entries(field.enumLabels!).map(([value, label]) => [value.toLowerCase(), label]),
                    );
                    const next: Record<string, string> = {};
                    for (const value of parsed.data.enumValues!) {
                      const label = field.enumLabels![value] ?? prevLabelsByLowerValue.get(value.toLowerCase());
                      if (label !== undefined) next[value] = label;
                    }
                    return next;
                  })()
                : undefined,
            relationTo: parsed.data.type === "relation" ? parsed.data.relationTo : undefined,
          };
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name ? { ...e, fields: e.fields.map((f) => (f.name === field.name ? nextField : f)) } : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1100: a field's type can change here just as freely as it
          // can be removed entirely (the field/entity-removal routes'
          // own round-1099 fix) -- same pre-build-only gate, same lack of
          // any project.status requirement on automation rule creation
          // (round 998). validateAutomationFieldValue/validateAutomationToField
          // (above) are only ever run once, at the moment a rule is
          // created or PATCHed -- never re-checked against a field that
          // later changes shape out from under an existing rule. A
          // field_equals rule's own fieldValue (e.g. "Delivered" against
          // an enum) or a toMode:"field" rule's own toField (which must
          // stay text/longtext -- "only a text field can hold a phone
          // number or email address") can both be silently invalidated by
          // this exact route, with nothing to notice and nothing to
          // disable it -- the same permanently-silent-failure shape round
          // 1099 just closed for removal, left open here for a type
          // change. Unlike disableAutomationRulesForField (built for
          // "this field doesn't exist anymore," unconditional), this
          // re-validates each referencing rule's own stored value against
          // the field's NEW type specifically, since many type changes
          // (text -> longtext, or an enum keeping the same value) leave a
          // referencing rule perfectly valid and must not disable it.
          for (const rule of listAutomationRules(db, project.id)) {
            if (rule.entityName !== entity.name || !rule.enabled) continue;
            let stillValid = true;
            if (rule.fieldName === field.name && rule.fieldValue) {
              try {
                validateAutomationFieldValue(nextField, rule.fieldValue);
              } catch {
                stillValid = false;
              }
            }
            if (stillValid && rule.toField === field.name) {
              try {
                validateAutomationToField(nextField);
              } catch {
                stillValid = false;
              }
            }
            // Round 1492: this loop's own doc comment above claims every
            // stored value that depends on the field's type gets
            // re-validated here -- but fieldOperator (round 1491) didn't
            // exist when this loop was written and was never added to it.
            // "greater_than"/"less_than" are only ever accepted against a
            // number/date field (validateAutomationFieldOperator); without
            // this check, retyping a number/date field to anything else
            // (e.g. text, to allow a free-text range like "60-90 min") left
            // such a rule enabled but permanently dead -- matchesFieldOperator
            // (automations.ts) computes Number(actual) for the new, no-longer-
            // numeric stored value, gets NaN, and silently never fires again.
            // The exact same "permanently, silently dead rule" failure shape
            // this loop exists to prevent for fieldValue/toField, reopened by
            // the one field it didn't know about.
            if (stillValid && rule.fieldName === field.name && rule.fieldOperator) {
              try {
                validateAutomationFieldOperator(nextField, rule.fieldOperator);
              } catch {
                stillValid = false;
              }
            }
            if (!stillValid) {
              updateAutomationRule(db, project.id, rule.id, { enabled: false });
            }
          }
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
    specEditRateLimiter,
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
        // Round 1775: the same "who did this" trail round 1639 already gave
        // entity/field label renames -- see schemaLabelEdits.ts's own
        // SchemaLabelEditAction doc comment for why `roles` is the one
        // sibling store this round closes (assumptions/personas are the
        // identical, deliberately deferred follow-up).
        insertSchemaLabelEdit(db, {
          projectId: project.id,
          changedByUserId: req.userId!,
          action: "role_added",
          entityName: "Roles",
          fieldName: null,
          previousLabel: "",
          newLabel: parsed.data.role,
        });
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** See POST /projects/:id/roles's own doc comment just above -- same extension, same reasoning. */
  router.post(
    "/projects/:id/assumptions",
    specEditRateLimiter,
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
        // Round 1776: see the roles routes' own doc comment (round 1775) above.
        insertSchemaLabelEdit(db, {
          projectId: project.id,
          changedByUserId: req.userId!,
          action: "assumption_added",
          entityName: "Assumptions",
          fieldName: null,
          previousLabel: "",
          newLabel: parsed.data.assumption,
        });
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
    specEditRateLimiter,
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
        // Round 1776: see the roles routes' own doc comment (round 1775) above.
        insertSchemaLabelEdit(db, {
          projectId: project.id,
          changedByUserId: req.userId!,
          action: "persona_added",
          entityName: "Personas",
          fieldName: null,
          previousLabel: "",
          newLabel: parsed.data.persona,
        });
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
    specEditRateLimiter,
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
        const removedRole = project.spec.roles[index];
        const nextSpec = { ...project.spec, roles: project.spec.roles.filter((_, i) => i !== index) };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        // Round 1775: see the POST /roles route's own doc comment above.
        insertSchemaLabelEdit(db, {
          projectId: project.id,
          changedByUserId: req.userId!,
          action: "role_removed",
          entityName: "Roles",
          fieldName: null,
          previousLabel: removedRole,
          newLabel: "",
        });
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** Round 943: same withIdempotency() extension as the roles DELETE route just above -- see its own doc comment. */
  router.delete(
    "/projects/:id/assumptions/:index",
    specEditRateLimiter,
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
          const removedAssumption = project.spec.assumptions[index];
          const nextSpec = { ...project.spec, assumptions: project.spec.assumptions.filter((_, i) => i !== index) };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1776: see the roles routes' own doc comment (round 1775) above.
          insertSchemaLabelEdit(db, {
            projectId: project.id,
            changedByUserId: req.userId!,
            action: "assumption_removed",
            entityName: "Assumptions",
            fieldName: null,
            previousLabel: removedAssumption,
            newLabel: "",
          });
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
    specEditRateLimiter,
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
          const removedPersona = project.spec.personas[index];
          const nextSpec = { ...project.spec, personas: project.spec.personas.filter((_, i) => i !== index) };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1776: see the roles routes' own doc comment (round 1775) above.
          insertSchemaLabelEdit(db, {
            projectId: project.id,
            changedByUserId: req.userId!,
            action: "persona_removed",
            entityName: "Personas",
            fieldName: null,
            previousLabel: removedPersona,
            newLabel: "",
          });
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
    specEditRateLimiter,
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
        const previousRole = project.spec.roles[index];
        const nextSpec = { ...project.spec, roles: project.spec.roles.map((r, i) => (i === index ? parsed.data.role : r)) };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        // Round 1775: see the POST /roles route's own doc comment above --
        // same "no-op resubmit isn't a rename" rule as entity/field labels.
        if (previousRole !== parsed.data.role) {
          insertSchemaLabelEdit(db, {
            projectId: project.id,
            changedByUserId: req.userId!,
            action: "role_renamed",
            entityName: "Roles",
            fieldName: null,
            previousLabel: previousRole,
            newLabel: parsed.data.role,
          });
        }
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** Round 943: same withIdempotency() extension as the roles PATCH route just above -- see its own doc comment. */
  router.patch(
    "/projects/:id/assumptions/:index",
    specEditRateLimiter,
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
          const previousAssumption = project.spec.assumptions[index];
          const nextSpec = {
            ...project.spec,
            assumptions: project.spec.assumptions.map((a, i) => (i === index ? parsed.data.assumption : a)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1776: see the roles PATCH route's own doc comment (round
          // 1775) above -- same "no-op resubmit isn't a rename" rule.
          if (previousAssumption !== parsed.data.assumption) {
            insertSchemaLabelEdit(db, {
              projectId: project.id,
              changedByUserId: req.userId!,
              action: "assumption_renamed",
              entityName: "Assumptions",
              fieldName: null,
              previousLabel: previousAssumption,
              newLabel: parsed.data.assumption,
            });
          }
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
    specEditRateLimiter,
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
          const previousPersona = project.spec.personas[index];
          const nextSpec = {
            ...project.spec,
            personas: project.spec.personas.map((p, i) => (i === index ? parsed.data.persona : p)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1776: see the roles PATCH route's own doc comment (round
          // 1775) above -- same "no-op resubmit isn't a rename" rule.
          if (previousPersona !== parsed.data.persona) {
            insertSchemaLabelEdit(db, {
              projectId: project.id,
              changedByUserId: req.userId!,
              action: "persona_renamed",
              entityName: "Personas",
              fieldName: null,
              previousLabel: previousPersona,
              newLabel: parsed.data.persona,
            });
          }
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
    specEditRateLimiter,
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
          // Round 1186: resolved via the shared findEntity helper (round
          // 1162's own case-insensitive fallback), instead of this
          // route's own ad hoc exact-case checks against the raw URL
          // path segment -- the sole remaining holdout among every
          // entity-level route in this file, all of which already go
          // through findEntity. Round 1180 already patched this exact
          // route's dependent-relation guard just below for the same
          // bug class, in the same function, without catching that the
          // existence check and removal filters around it had the
          // identical gap: an AI-generated spec recasing an entity's own
          // name (the same real, recurring behavior rounds 1159-1185
          // established) threw a false 404 here, blocking a legitimate
          // deletion outright with a misleading "no such screen" error.
          const entity = findEntity(project, req.params.entityName);
          if (project.spec.entities.length <= 1) {
            throw new HttpError(400, "Cannot remove the last remaining screen -- at least one is required", "VALIDATION_ERROR");
          }
          // Round 1180: case-insensitive, matching the established
          // relationTo-resolution convention (rounds 1159-1178) everywhere
          // else in this app -- an AI-generated spec's relationTo can
          // legitimately differ in letter case from the real target
          // entity's declared name, and this guard used to compare them
          // exact-case. When that happened, deleting the entity the OTHER
          // one's relation field actually points to silently succeeded
          // instead of being blocked: the surviving entity's relation
          // field is left with a relationTo naming an entity that no
          // longer exists at all, not merely case-different.
          const dependent = project.spec.entities.find(
            (e) =>
              e.name !== entity.name && e.fields.some((f) => f.type === "relation" && f.relationTo?.toLowerCase() === entity.name.toLowerCase()),
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
            entities: project.spec.entities.filter((e) => e.name !== entity.name),
            screens: project.spec.screens.filter((s) => s.entity !== entity.name),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1099: same pre-build gap as the field-removal route's
          // own fix just above, for a rule that triggers on this whole
          // entity (entityName) rather than just one of its fields.
          disableAutomationRulesForEntity(db, project.id, entity.name);
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
    specEditRateLimiter,
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
   * Round 1216: record/project/automation-rule all already have a
   * "Duplicate" action (handleDuplicate/handleBulkDuplicate in
   * EntityPanel.tsx, /projects/:id/clone, round 1047's
   * handleDuplicateRule) -- an entire ENTITY never did. A user building a
   * CRM who already shaped "Customer" (name/email/phone/address/notes,
   * enums, a relation) and now wants a similarly-shaped "Vendor" had to
   * manually replay every single AddFieldForm submission one field at a
   * time; this clones the whole field list in one request, so they can
   * rename/tweak from a real starting point instead. Same pre-build-only
   * gate and activePipelines guard as every sibling spec-edit route (see
   * the entity-add route's own comment just above) -- once built, the
   * real database table and generated code already exist and a spec-only
   * clone wouldn't create a matching table anyway. The new entity's
   * fields are copied verbatim, INCLUDING any `relationTo` -- deliberately
   * not rewritten to point at the new entity even for a self-relation,
   * matching EntityPanel's own handleDuplicate convention of cloning a
   * record's own values as-is rather than reinterpreting them; a
   * relationTo naming the clone's own source entity still names a real,
   * valid entity in this spec either way, so there's nothing to fix up.
   * The new label/name derivation mirrors /projects/:id/clone's own
   * Hebrew-aware " (עותק)"/" (copy)" suffix exactly, then runs the result
   * through the same `deriveEntityName` the manual add-entity route above
   * uses, so a repeated duplicate (or a name that happens to collide with
   * an existing one) still gets a real, unique table name instead of a
   * silent collision.
   */
  /** Same withIdempotency() extension as POST /projects/:id/roles above -- see its own doc comment. */
  router.post(
    "/projects/:id/entities/:entityName/duplicate",
    specEditRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot duplicate a screen after the project has already been built", "ENTITY_DUPLICATE_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-add route above -- see its
      // own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `POST /projects/${project.id}/entities/${req.params.entityName}/duplicate`,
        async () => {
          const entity = findEntity(project, req.params.entityName);
          const sourceLabel = entity.label ?? entity.name;
          const suffix = isHebrewText(sourceLabel) ? " (עותק)" : " (copy)";
          // Round 1791 (the same hazard round 1410 already closed for POST
          // /projects/:id/clone's own synthesized `name`): this label is
          // built by plain string concatenation with no
          // SPEC_LABEL_MAX_LENGTH cap, unlike every other route that
          // accepts an entity label (RenameEntityLabelSchema/
          // AddEntitySchema etc., all .max(SPEC_LABEL_MAX_LENGTH) via Zod)
          // -- EntitySchema's own label field (packages/shared) has no
          // length limit of its own, so an overlong value here doesn't
          // throw or get rejected, it just silently bypasses the one cap
          // every other label-accepting path enforces, and an entity
          // repeatedly duplicated off itself chains the suffix with no
          // bound, the same amplification round 1410 describes for clone.
          // Truncated, not rejected with a 400, for the same reason round
          // 1410 gives: this value is server-synthesized, not something
          // the user typed into an editable field.
          const rawLabel = `${sourceLabel}${suffix}`;
          const newLabel = rawLabel.length > SPEC_LABEL_MAX_LENGTH
            ? `${sourceLabel.slice(0, SPEC_LABEL_MAX_LENGTH - suffix.length)}${suffix}`
            : rawLabel;
          const name = deriveEntityName(newLabel, project.spec.entities.map((e) => e.name));
          const newEntity: Entity = {
            ...entity,
            name,
            label: newLabel,
            fields: entity.fields.map((f) => ({ ...f })),
          };
          const newScreens = deriveScreensForNewEntity(name, project.spec.entities, project.spec.screens);
          const nextSpec = {
            ...project.spec,
            entities: [...project.spec.entities, newEntity],
            screens: [...project.spec.screens, ...newScreens],
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
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
    specEditRateLimiter,
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
      // Round 1196: case-insensitive, mirroring findEntity's own round-1162
      // fallback -- this route's relationTo dropdown is populated from the
      // client's own `allEntities`, which can go stale by letter case alone
      // if a DIFFERENT browser tab/collaborator renames the target entity
      // (a supported, case-only-safe live action, see migrate.ts) between
      // this form being opened and submitted; this exact client-side race
      // is otherwise blocked by this file's own cross-entity busy-gating
      // (anyEntityOrAddBusy in App.tsx), but that gating has no visibility
      // across separate tabs/sessions, so the server's own check still
      // needs this same tolerance every other relationTo-resolution call
      // site in this app already has (rounds 1159-1188).
      if (
        parsed.data.type === "relation" &&
        !project.spec.entities.some((e) => e.name === parsed.data.relationTo || e.name.toLowerCase() === parsed.data.relationTo?.toLowerCase())
      ) {
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
    specEditRateLimiter,
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
          // Round 1187: capture findField's resolved field and reuse its
          // real name below, instead of discarding it and falling back to
          // the raw, possibly differently-cased req.params.fieldName --
          // now that findField has its own case-insensitive fallback
          // (mirroring findEntity's), a URL spelled with different casing
          // would otherwise pass this existence check via the fallback
          // while the filter/disable calls below, still keyed off the raw
          // param, silently matched nothing: a false 200 with the field
          // left in place and no automation rule disabled, worse than the
          // 404 this replaced.
          const field = findField(entity, req.params.fieldName);
          if (entity.fields.length <= 1) {
            throw new HttpError(400, "Cannot remove the last remaining field -- at least one is required", "VALIDATION_ERROR");
          }
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) =>
              e.name === entity.name ? { ...e, fields: e.fields.filter((f) => f.name !== field.name) } : e,
            ),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          // Round 1099: an automation rule can be created before the
          // project's first build (round 998's own, deliberate,
          // already-tested design -- rule creation has no project.status
          // guard, "pre-configuring automations ahead of the first
          // build"), which means one can already exist referencing this
          // field by the time it's removed here. diffAndMigrate's own
          // disable-sweep (migrate.ts) only ever runs on a REFINE, diffing
          // against a previously-BUILT spec -- for a field added and
          // removed entirely before the very first build, there is no
          // "previous build" for that sweep to diff against at all, so a
          // rule left dangling this way was never disabled by anything,
          // anywhere: not at creation (by design), not here (missing
          // until now), and not at the first build either. Reusing the
          // exact same helper migrate.ts's own sweep already uses for the
          // identical post-build case, so a pre-build removal degrades a
          // referencing rule exactly the same way instead of leaving it to
          // fail "no destination configured" forever with no explanation.
          disableAutomationRulesForField(db, project.id, entity.name, field.name);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  router.patch(
    "/projects/:id/entities/:entityName/:recordId",
    recordWriteRateLimiter,
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
            record = updateRecord(db, project.id, entity, recordId, req.body ?? {}, req.userId!);
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
          } else {
            // Round 1413: same audit-trace gap as the POST route above --
            // see its own comment.
            console.warn(
              `X-Suppress-Automations: record ${record.id} updated on entity "${entity.name}" of project ${project.id} by user ${req.userId} with automations suppressed`,
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
    recordWriteRateLimiter,
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
           * Round 1527: EntityPanel.tsx's own deferred-delete undo window
           * (UNDO_WINDOW_MS, see its handleDelete) can leave this real
           * DELETE pending for up to 5s after the row already vanished
           * from the deleting tab's own view -- long enough for a SECOND
           * tab/collaborator, unaware of the pending delete, to open and
           * successfully save an edit to the same still-genuinely-alive
           * record. Without this check, that save succeeded silently and
           * was then discarded the moment this deferred delete finally
           * ran, with no warning to either user -- the same failure shape
           * round 1017's own comment on handleDelete already documents,
           * but that fix only ever protects the SAME tab's own open edit
           * form, not a second session's. `expectedRecord`, when the
           * client sends it (the exact snapshot taken the moment Delete
           * was clicked), lets this route detect that drift and reject
           * instead of deleting -- EntityPanel.tsx's commitPendingDelete
           * already restores the row and surfaces an error on any
           * rejection here, the same existing path a FOREIGN KEY failure
           * just below already takes.
           */
          const expectedRecord = (req.body as { expectedRecord?: EntityRecord } | undefined)?.expectedRecord;
          if (expectedRecord && before && computeChangedFields(entity, expectedRecord, before).size > 0) {
            throw new HttpError(
              409,
              "This record was changed by someone else after it was deleted here -- the deletion was cancelled",
              "RECORD_MODIFIED_SINCE_DELETE",
            );
          }
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
          // Round 1632: the delete half of the createdByUserId/updatedByUserId
          // audit-trail pair (rounds 1613/1617) -- a deleted row has nowhere
          // left to carry a column, so this writes to a small separate log
          // table instead, using the same `before` snapshot already read
          // above (the row itself is already gone by this point). Computed
          // from `before`, not re-read, for the same reason the
          // "record_deleted" automation trigger just below reads `before`
          // too -- there's no other state a deleted row has left.
          if (before) {
            insertRecordDeletion(db, {
              projectId: project.id,
              entityName: entity.name,
              recordId,
              recordLabel: recordDisplayLabel(entity, before, isHebrewText(project.description) ? "he" : "en"),
              deletedByUserId: req.userId!,
            });
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
    automationsReadRateLimiter,
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
      // Round 1664: same collaboratorEmails resolution convention as
      // GET .../checkpoints and GET .../entities/:entityName -- resolves
      // each rule's raw createdByUserId/updatedByUserId (round 1664) into
      // a display email at this route layer, rather than baking email
      // lookups into packages/db's own rowToRule.
      const collaboratorEmails: Record<string, string> = {};
      const owner = getOwnerInfo(db, project);
      if (owner) collaboratorEmails[owner.userId] = owner.email;
      for (const collaborator of listCollaborators(db, project.id)) {
        collaboratorEmails[collaborator.userId] = collaborator.email;
      }
      res.json({ rules, collaboratorEmails });
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
    automationsReadRateLimiter,
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
   * bypass. Round 1261: unlike that retry route, this call passes
   * isManualTest=true -- a successful Test must not ALSO mark today's
   * real scheduled occurrence as already sent (isScheduledRuleDue reads
   * exactly the two columns a Test would otherwise update), the opposite
   * of what the retry route intentionally does (round 972, letting a
   * successful retry un-pause the rest of the day's own automatic ticks).
   * Every other trigger needs a real record to interpolate
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
            // Round 1261: isManualTest=true -- see fireScheduledRule's own
            // doc comment on that parameter for why this route specifically
            // must not let a successful test mark today's real scheduled
            // occurrence as already sent.
            await fireScheduledRule(db, whatsapp, emailSender, project, rule, new Date(), true);
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
          // Round 1276: isManualTest=true -- see fireRule's own doc comment
          // on that parameter. Mirrors the schedule branch's identical
          // isManualTest=true just above (round 1261), for the exact same
          // false-positive-notification reason.
          await fireRule(db, whatsapp, emailSender, project, entity, rule, record, uploadsDir, `${req.protocol}://${req.get("host")}`, true);
          const [latestRun] = listAutomationRuns(db, project.id, rule.id, 1);
          return { status: 200, body: { run: latestRun ?? null } };
        },
      );
      res.status(status).json(body);
    }),
  );

  router.post(
    "/projects/:id/entities/:entityName/automations",
    automationRuleRateLimiter,
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
        if (data.fieldOperator) validateAutomationFieldOperator(field, data.fieldOperator);
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
            fieldOperator: data.fieldOperator ?? null,
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
          }, req.userId!);
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
    automationRuleRateLimiter,
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
            if (next.fieldOperator) validateAutomationFieldOperator(field, next.fieldOperator);
          }
          if (next.toMode === "field" && next.toField) {
            validateAutomationToField(findField(entity, next.toField));
          }
          try {
            const rule = updateAutomationRule(db, project.id, req.params.ruleId, parsed.data, req.userId!);
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
    automationRuleRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectWriteAccess(db, req.params.id, req.userId!);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        `DELETE /projects/${project.id}/automations/${req.params.ruleId}`,
        async () => {
          // Round 1666: the delete half of the automation-rule audit-trail
          // pair round 1664 (createdByUserId/updatedByUserId) closed for
          // create/update -- read before deleting, since the row itself
          // (and with it, any single "name" field to snapshot) is gone
          // once deleteAutomationRule returns, the same reason round 1632's
          // own record-deletion log reads `before` first.
          const before = getAutomationRule(db, project.id, req.params.ruleId);
          try {
            deleteAutomationRule(db, project.id, req.params.ruleId);
          } catch (err) {
            if (err instanceof NotFoundError) {
              throw new HttpError(404, `Automation rule "${req.params.ruleId}" not found`, "AUTOMATION_RULE_NOT_FOUND");
            }
            throw err;
          }
          if (before) {
            insertAutomationRuleDeletion(db, {
              projectId: project.id,
              ruleId: before.id,
              entityName: before.entityName,
              trigger: before.trigger,
              actionType: before.actionType,
              deletedByUserId: req.userId!,
            });
          }
          return { status: 204, body: null };
        },
      );
      res.status(status).end();
    }),
  );

  /**
   * Round 1666: the read side of the automation-rule deletion audit trail --
   * mirrors GET .../record-deletions and GET .../collaborator-access-log
   * exactly (same requireProjectAccess, any collaborator can read it, not
   * just the owner), for the same reason: CollaboratorsPanel.tsx's own
   * Copy/Download report is already the one surface a collaborator can
   * reach for "what happened on this project."
   */
  router.get(
    "/projects/:id/automation-rule-deletions",
    checkpointRateLimiter,
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ deletions: listAutomationRuleDeletions(db, project.id) });
    }),
  );

  return router;
}
