import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Entity, EntityRecord, Project } from "@forge/shared";
import {
  AUTOMATION_RUNS_RETENTION_LIMIT,
  getProject,
  getRecord,
  insertWhatsAppMessage,
  listAutomationRuns,
  listEnabledAutomationRulesForEntity,
  listEnabledScheduledRules,
  recordAutomationRun,
  WHATSAPP_NOT_CONNECTED_ERROR,
  EMAIL_NOT_CONFIGURED_ERROR,
  type AutomationRule,
  type ForgeDatabase,
} from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { recordDisplayLabel } from "./displayField.js";
import type { EmailAttachment, EmailSender } from "./email.js";
import { resolveUploadedFilePath } from "./uploadPaths.js";
import { findMatchingRecord } from "./whatsapp.js";
import type { WhatsAppAttachment, WhatsAppWebManager } from "./whatsappWeb.js";

type Lang = "he" | "en";
const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };
const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Mirrors entityFormatting.ts's own parseFieldDate: a stored "YYYY-MM-DD"
 * date field parsed at local midnight (not `new Date(value)` directly,
 * which parses as UTC midnight and can print the wrong calendar day for a
 * viewer/recipient behind UTC).
 */
function parseFieldDate(raw: string): Date {
  const match = DATE_FORMAT.exec(raw);
  if (match) {
    const [, yearStr, monthStr, dayStr] = match;
    return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  }
  return new Date(raw);
}

/**
 * Mirrors backup.ts's own fileFieldDisplayName (and entityFormatting.ts's
 * parseFileFieldValue on the client side) -- a "file" field's stored value
 * is a JSON-encoded `{url, name, size, mimeType}` descriptor, not plain
 * text like every other field type, so interpolateTemplate below needs
 * just the filename out of it.
 */
function fileFieldDisplayName(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    const parsed = JSON.parse(value) as { name?: unknown };
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // not a file descriptor -- treated as no file, same as an empty value
  }
  return "";
}

/**
 * The webhook action's own JSON payload embeds the raw, untouched
 * EntityRecord straight from the DB (fireWebhookAction below) -- unlike
 * `message`, which interpolateTemplate carefully special-cases `file`
 * fields for (fileFieldDisplayName, just the filename). Every OTHER field
 * type genuinely IS just its stored value already, but a `file` field's
 * stored value is itself a JSON-ENCODED `{url, name, size, mimeType}`
 * descriptor string -- JSON.stringify-ing the whole payload then embeds
 * that descriptor as a doubly-escaped JSON STRING nested inside the outer
 * JSON body (e.g. `"pdf": "{\"url\":...}"`), not a usable nested object.
 * Worse, even parsed, `url` is this server's own relative path (e.g.
 * "/api/uploads/..."), meaningless to the exact external consumer this
 * feature's own create-rule UI advertises ("works with Zapier, Slack,
 * Make, or any other system") -- none of those auto-parse a JSON string
 * buried inside a JSON value, and none of them know this server's own
 * origin to resolve a relative path against even if they did.
 *
 * Returns a plain Record (not EntityRecord -- that type is string | number
 * | boolean | null only, and a resolved file descriptor is a nested
 * object) with every file field's descriptor parsed and its `url`
 * rewritten to a real, fully-qualified URL the receiving service can
 * actually fetch; every other field is passed through untouched. A value
 * that isn't a real file descriptor at all (empty, malformed) is left
 * exactly as-is -- the same graceful degradation fileFieldDisplayName
 * already uses for the identical class of bad input.
 *
 * Round 916: `coerceValue` (packages/db/src/repository.ts, round 908) is
 * the only write-time funnel that rejects a file-field url outside this
 * server's own upload-route shape -- it doesn't retroactively sanitize a
 * row written before that guard shipped. Round 908 added the matching
 * read-time scheme check to every OTHER place that parses this same
 * descriptor (entityFormatting.ts's and codegen.ts's own
 * parseFileFieldValue) as defense-in-depth for exactly that legacy data,
 * but missed this one: `new URL(parsed.url, baseUrl)` silently ignores
 * `baseUrl` whenever `parsed.url` is itself absolute (has its own
 * scheme) -- confirmed directly: `new URL("javascript:...", "https://
 * example.com").toString()` returns the untouched "javascript:..." string
 * -- so a pre-908 "javascript:"/"data:"/attacker-controlled-absolute-URL
 * descriptor passed straight through, verbatim, into this webhook's own
 * JSON payload, one hop further than round 908 ever checked. Rejected the
 * same way a malformed descriptor already is (left untouched, not
 * thrown), mirroring entityFormatting.ts's own SAFE_FILE_URL regex.
 */
const SAFE_FILE_URL = /^\/api\/uploads\/[^/]+\/[^/]+\/[^/]+$/;

export function resolveFileFieldsForWebhook(entity: Entity, record: EntityRecord, baseUrl: string): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...record };
  for (const field of entity.fields) {
    if (field.type !== "file") continue;
    const rawValue = resolved[field.name];
    if (typeof rawValue !== "string" || rawValue === "") continue;
    let parsed: { url?: unknown; name?: unknown; size?: unknown; mimeType?: unknown };
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      continue;
    }
    if (typeof parsed.url !== "string" || !SAFE_FILE_URL.test(parsed.url)) continue;
    resolved[field.name] = { url: new URL(parsed.url, baseUrl).toString(), name: parsed.name, size: parsed.size, mimeType: parsed.mimeType };
  }
  return resolved;
}

/**
 * Round 1188: mirrors routes/projects.ts's own findField convention
 * (exact match first, case-insensitive fallback second) for every place in
 * this file that resolves a FIELD NAME STORED ON THE RULE OR INSIDE A
 * TEMPLATE -- rule.fieldName/toField and a template's own {{placeholder}}
 * text are persisted strings, authored against whatever casing a field had
 * at rule-creation time. packages/db/src/migrate.ts explicitly treats a
 * later case-only field rename (type unchanged) as "the same field" and
 * deliberately does NOT disable a referencing rule for it (its own
 * prevFieldByLowerName leniency, migrate.ts:470-473) -- but
 * repository.ts's rowToRecord keys every record strictly by the entity's
 * CURRENT field.name, so a stale, differently-cased stored string here
 * would silently stop matching anything in the record object: a trigger
 * condition that can never match again, a toField destination that
 * resolves to nothing, and a template placeholder left as raw literal text
 * in a real outbound message -- all without any error surfacing anywhere.
 * Falls back to the original string, unresolved, when no field matches at
 * all (a genuinely removed field, or a typo), preserving every existing
 * caller's own documented "unmatched reference" behavior for that case.
 */
function resolveStoredFieldName(entity: Entity, fieldName: string): string {
  const field = entity.fields.find((f) => f.name === fieldName) ?? entity.fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
  return field?.name ?? fieldName;
}

/**
 * Mirrors routes/projects.ts's own deleteUploadedFile -- the only other
 * place that ever turns a file field's stored `{url, name, size,
 * mimeType}` descriptor back into a real path on disk (uploadsDir/
 * projectId/entityName/<storedFilename>, where <storedFilename> is
 * whatever the URL's own last path segment names, never the raw
 * descriptor's `name` -- that's the ORIGINAL upload name, which
 * createUploadMiddleware deliberately never uses as the stored filename).
 * Before this, a WhatsApp message template referencing a file field (e.g.
 * "here's your invoice: {{invoice}}") sent only the bare filename as
 * plain text -- fileFieldDisplayName's own doc comment explains why
 * that's the right text to interpolate, but the real file itself was
 * never actually attached to the message, even though Baileys supports
 * sending one alongside its caption. Scoped to the FIRST file field
 * referenced in the template (in placeholder order) that has a real
 * value -- WhatsApp (and Baileys) only support one media attachment per
 * message, so a template naming more than one file field can only ever
 * attach one of them regardless of how this picks.
 *
 * Round 850's finding: this comment already called out mirroring
 * deleteUploadedFile, but never actually mirrored its round-849 fix --
 * EntitySchema's own `name` has no character-set restriction, so
 * `path.join(uploadsDir, projectId, entity.name, storedFilename)` could
 * resolve outside uploadsDir entirely the same way the write/delete
 * sides already (and separately) proved exploitable in rounds 848/849,
 * except here the result is READ and then attached to and sent as a real
 * WhatsApp message to whatever `toNumber`/`toField` the automation rule
 * names -- an arbitrary-file-read-and-exfiltration primitive, not just a
 * write or delete one, reachable by any user who controls a project (an
 * entity name, a file field's own unvalidated JSON value, and a WhatsApp
 * automation rule are all things an ordinary project owner can set).
 * Returns null (no attachment) rather than throwing when the resolved
 * path would escape uploadsDir, matching this function's own existing
 * "silently skip, fall back to plain text" contract for every other
 * malformed-descriptor case right above.
 *
 * Round 918: this comment named the exact fix needed (round 849's own
 * UPLOADED_FILENAME check) but the function below never actually applied
 * it -- `isPathInsideDir` alone only bounds the resolved path to
 * uploadsDir ITSELF, not to this specific project+entity's own
 * subdirectory within it, so an entity named e.g.
 * "../someOtherProjectId/SomeEntity" still passes that check while
 * resolving into a DIFFERENT project's own upload folder (the exact
 * cross-project reach round 849's own writeup already named as reachable
 * against the delete primitive, "directly usable against another
 * project's real uploads too"). Requiring the filename to match
 * UPLOADED_FILENAME doesn't stop that cross-project resolution, but it
 * does confine what it can actually read-and-exfiltrate there to a file
 * some upload, somewhere, was really once named -- never an arbitrary
 * path a crafted descriptor could otherwise invent -- the same
 * defense-in-depth deleteUploadedFile already has for the identical
 * path-construction shape.
 */
export function findTemplateFileAttachment(
  uploadsDir: string,
  projectId: string,
  entity: Entity,
  template: string,
  record: EntityRecord,
): WhatsAppAttachment | null {
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const fieldName = resolveStoredFieldName(entity, match[1]);
    const field = entity.fields.find((f) => f.name === fieldName && f.type === "file");
    if (!field) continue;
    const rawValue = record[fieldName];
    if (typeof rawValue !== "string" || rawValue === "") continue;
    let parsed: { url?: unknown; name?: unknown; mimeType?: unknown };
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      continue;
    }
    if (typeof parsed.url !== "string" || typeof parsed.name !== "string" || typeof parsed.mimeType !== "string") continue;
    // Round 1270: delegates the path-building/validation this function's
    // own doc comment already claimed to mirror, rather than actually
    // re-duplicating it -- resolveUploadedFilePath's own case-insensitive
    // sibling-directory fallback (same round) now also covers a file
    // referenced by a WhatsApp automation whose entity was later renamed
    // by letter case only, which this inline copy never would have.
    const filePath = resolveUploadedFilePath(uploadsDir, projectId, entity.name, rawValue);
    if (!filePath) continue;
    return { filePath, fileName: parsed.name, mimeType: parsed.mimeType };
  }
  return null;
}

/**
 * Round 1325: email has no such one-attachment limitation -- unlike the
 * WhatsApp caller findTemplateFileAttachment above was written for,
 * EmailAttachment[]/the Resend payload (email.ts) already support
 * multiple attachments end-to-end. Reusing that function for
 * fireEmailAction's own call site meant an email template referencing two
 * or more distinct file fields (e.g. "{{invoice}} and {{receipt}}")
 * silently attached only whichever field matched first in placeholder
 * order, dropping the rest with no error, warning, or log -- the exact
 * same field-resolution/path-validation logic as above, just collecting
 * every distinct matching field instead of returning on the first one.
 * Deduplicates by resolved field name so a placeholder repeated twice in
 * the same template (e.g. in both the subject and the body) doesn't
 * attach the same file twice.
 */
export function findAllTemplateFileAttachments(
  uploadsDir: string,
  projectId: string,
  entity: Entity,
  template: string,
  record: EntityRecord,
): WhatsAppAttachment[] {
  const attachments: WhatsAppAttachment[] = [];
  const seenFieldNames = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const fieldName = resolveStoredFieldName(entity, match[1]);
    if (seenFieldNames.has(fieldName)) continue;
    const field = entity.fields.find((f) => f.name === fieldName && f.type === "file");
    if (!field) continue;
    seenFieldNames.add(fieldName);
    const rawValue = record[fieldName];
    if (typeof rawValue !== "string" || rawValue === "") continue;
    let parsed: { url?: unknown; name?: unknown; mimeType?: unknown };
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      continue;
    }
    if (typeof parsed.url !== "string" || typeof parsed.name !== "string" || typeof parsed.mimeType !== "string") continue;
    const filePath = resolveUploadedFilePath(uploadsDir, projectId, entity.name, rawValue);
    if (!filePath) continue;
    attachments.push({ filePath, fileName: parsed.name, mimeType: parsed.mimeType });
  }
  return attachments;
}

/**
 * Interpolates {{fieldName}} placeholders in a message template from a
 * record's own field values, e.g. "Hi {{customerName}}, ..." -- an
 * unmatched placeholder (a typo'd field name, or one removed by a later
 * refine) is left untouched verbatim rather than silently collapsing to
 * an empty string, so a broken template is visible in the sent message
 * instead of reading as grammatically fine but wrong.
 *
 * `record` must already have every relation field's value resolved to its
 * display-label string (see resolveRelationFieldsForTemplate below) --
 * this function itself never touches the database. Enum (translated
 * label) and boolean (TRUE/FALSE) format the same way
 * entityFormatting.ts's/backup.ts's own fieldDisplayValue does for CSV
 * export, but date/number deliberately do NOT follow fieldDisplayValue's
 * lead of leaving those two raw -- that function's own doc comment
 * explains its raw values exist only so a CSV export/import round-trips
 * exactly (a locale-formatted "1,500"/"1/2/2024" would fail buildImportRecords'
 * re-parse). A WhatsApp message is never re-imported; it's pure one-way
 * human reading, the same situation the on-screen table cell (via
 * formatDateValue/formatNumberValue) is already in, so date/number here
 * follow THAT convention instead -- locale-formatted, using `lang` (no
 * stored per-project language preference exists, so this is picked the
 * same way twin.ts already does via isHebrewText(project.description)).
 *
 * "file" gets its own branch for the identical reason fieldDisplayValue
 * (backup.ts/entityFormatting.ts) and calendarIcs.ts already carved one
 * out: without it, a template referencing a file field (the create-rule
 * UI's own hint explicitly invites referencing ANY field by name) sent
 * the raw JSON upload descriptor -- url, size, mimeType, the server's own
 * internal upload path -- verbatim to a real WhatsApp recipient or
 * webhook endpoint, instead of just the filename a human actually wants.
 */
/**
 * V8/ICU's Number.prototype.toLocaleString("he-IL") silently prepends a
 * U+200E LEFT-TO-RIGHT MARK right before the minus sign of any negative
 * number -- real, invisible Unicode, not a rendering artifact -- to keep
 * the sign from visually reordering when that string is embedded inside
 * RTL-rendered text on screen. interpolateTemplate's number branch below
 * builds the literal, final text of a real outbound WhatsApp/email
 * automation message, not on-screen UI -- there's no RTL bidi context
 * left to protect once this string leaves the app, so for a Hebrew
 * project ("he"), any rule whose template references a negative "number"
 * field (a balance due, a refund, a discount) would otherwise embed this
 * invisible character into the literal message sent to a real recipient,
 * and into the stored whatsapp_messages row WhatsAppPanel's own log shows
 * back to the business owner, with nothing about it visible at all.
 */
function stripBidiMarks(s: string): string {
  return s.replace(/[‎‏]/g, "");
}

export function interpolateTemplate(template: string, entity: Entity, record: EntityRecord, lang: Lang): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, rawFieldName: string) => {
    const fieldName = resolveStoredFieldName(entity, rawFieldName);
    const value = record[fieldName];
    if (value === null || value === undefined) return match;
    const field = entity.fields.find((f) => f.name === fieldName);
    if (field?.type === "boolean") return value ? "TRUE" : "FALSE";
    if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
    if (field?.type === "file") return fileFieldDisplayName(value);
    if (field?.type === "date") {
      const date = parseFieldDate(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(LOCALE[lang]);
    }
    if (field?.type === "number") return stripBidiMarks(Number(value).toLocaleString(LOCALE[lang]));
    // "createdAt" is a reserved key repository.ts's own insert always sets
    // on every EntityRecord, never a declared entity field -- so `field`
    // above is always undefined for it, and it would otherwise fall
    // through to the generic raw-String(value) branch below, sending a
    // raw ISO-8601 timestamp ("2024-01-15T08:30:00.000Z") to a real
    // WhatsApp recipient instead of a locale-formatted one, even though
    // the create-rule UI's own hint invites referencing any field by name
    // and {{createdAt}} is a very natural guess. Mirrors the on-screen
    // table's own "Created" column (entityFormatting.ts's
    // formatRecordCreatedAt) exactly -- toLocaleString (date+time), not
    // toLocaleDateString like the declared-"date"-field branch above,
    // since createdAt carries real time-of-day information a declared
    // "date" field never does.
    if (fieldName === "createdAt") {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(LOCALE[lang]);
    }
    return String(value);
  });
}

/**
 * A message template's {{fieldName}} placeholder has no way to tell a
 * relation field apart from a text field (the create-rule UI's own hint
 * explicitly invites referencing any field by name) -- but a relation
 * field's own stored, raw value is just the target record's numeric id
 * (see repository.ts's rowToRecord/coerceValue), not anything a real
 * WhatsApp recipient could read. Resolves every relation field on `record`
 * to the same human display label the UI itself would show (falling back
 * to "#<id>" exactly like relationDisplayLabel does when the target entity
 * or record can't be found), so interpolateTemplate above never has to
 * touch the database and stays trivially unit-testable.
 */
function resolveRelationFieldsForTemplate(
  db: ForgeDatabase,
  projectId: string,
  entity: Entity,
  allEntities: Entity[],
  record: EntityRecord,
  lang: Lang = "en",
): EntityRecord {
  const resolved: EntityRecord = { ...record };
  for (const field of entity.fields) {
    if (field.type !== "relation") continue;
    const value = record[field.name];
    if (value === null || value === undefined) continue;
    // Round 1160: entity-name comparison here must tolerate a letter-case
    // mismatch the same way migrate.ts's own round-1159 fix already does for
    // FK generation -- without this, an outbound WhatsApp/email message's
    // {{relationField}} placeholder silently fell back to the raw "#<id>"
    // instead of the related record's real display label whenever
    // relationTo differed from its target entity's name only by case.
    const relationTo = field.relationTo;
    const targetEntity = relationTo ? allEntities.find((e) => e.name.toLowerCase() === relationTo.toLowerCase()) : undefined;
    const targetRecord = targetEntity ? getRecord(db, projectId, targetEntity, Number(value)) : undefined;
    resolved[field.name] = targetRecord ? recordDisplayLabel(targetEntity!, targetRecord, lang) : `#${value}`;
  }
  return resolved;
}

/**
 * Whether a rule's own trigger matches this particular record create/
 * update/delete. "field_equals" only fires on an update when the matching
 * field was actually part of this update's own payload (changedFields) --
 * not merely whenever its current value happens to equal the target
 * value -- so a rule for status="Delivered" fires once, the moment status
 * is set to "Delivered", not again on every later unrelated edit to that
 * same already-delivered record.
 *
 * Round 969: "deleted" is deliberately excluded from ever matching
 * "field_equals" (or "schedule", which never matches any record event at
 * all) -- a rule for status="Delivered" fired on every record UPDATE that
 * sets status to "Delivered", but a record about to be deleted isn't
 * "being set to" its own current field values; without this explicit
 * exclusion, a field_equals rule whose target value happened to match the
 * record's last stored value would also silently fire on every single
 * deletion of a record in that state, a behavior nobody configuring a
 * field_equals rule asked for or would expect. A user who wants an
 * automation on deletion has an explicit "record_deleted" trigger for
 * exactly that, below.
 *
 * Round 1330: "record_updated" fires on every update regardless of which
 * fields changed -- the generic counterpart to "field_equals"' single-
 * field/single-value shape, for a rule that wants to know about ANY edit
 * to a record (an audit-style notification), not just one specific field
 * reaching one specific value.
 */
export function matchesTrigger(
  rule: AutomationRule,
  event: "created" | "updated" | "deleted",
  record: EntityRecord,
  changedFields: Set<string>,
  entity: Entity,
): boolean {
  if (rule.trigger === "record_created") {
    return event === "created";
  }
  if (rule.trigger === "record_deleted") {
    return event === "deleted";
  }
  if (rule.trigger === "record_updated") {
    // Round 1340: unlike record_created/record_deleted (a POST/DELETE can
    // never be a no-op), a PATCH genuinely can be -- EntityPanel.tsx's
    // bulk-update "Apply to N" sends the same field/value to every
    // selected record regardless of whether a given record already holds
    // it, and routes/projects.ts's PATCH route still fires this trigger
    // with event === "updated" either way. Without this check, a
    // record_updated rule fired a real outbound WhatsApp/email/webhook for
    // every record in a bulk-update batch, including the ones nothing
    // actually changed on. Mirrors field_equals' own identical
    // changedFields check a few lines below.
    return event === "updated" && changedFields.size > 0;
  }
  // Round 1098: the doc comment above already claims "schedule, which
  // never matches any record event at all" -- but nothing below this
  // point actually enforced that; it relied entirely on `fieldName` being
  // null for a schedule rule, which findAutomationRuleInvariantViolation/
  // CreateAutomationRuleSchema (routes/projects.ts) never actually
  // required. A rule whose trigger was switched away from "field_equals"
  // via a PATCH that didn't also explicitly null fieldName/fieldValue (the
  // bundled web UI always does, but any other direct API caller need
  // not) kept its stale field condition -- and listEnabledAutomationRules
  // ForEntity (packages/db/src/automations.ts) returns schedule rules to
  // runAutomationsForRecordChange too, so that stale condition would then
  // silently ALSO fire the schedule rule on every matching record create/
  // update, duplicating a real WhatsApp/webhook/email send on top of its
  // own real scheduled firing.
  if (rule.trigger !== "field_equals") return false;
  if (event === "deleted") return false;
  if (!rule.fieldName) return false;
  // Round 1188: rule.fieldName is the field's casing as of rule creation,
  // not necessarily its current declared name -- see resolveStoredFieldName's
  // own doc comment above.
  const fieldName = resolveStoredFieldName(entity, rule.fieldName);
  if (event === "updated" && !changedFields.has(fieldName)) return false;
  const actual = record[fieldName];
  if (actual === null || actual === undefined) return false;
  return String(actual) === rule.fieldValue;
}

/**
 * Evaluates every enabled automation rule for one entity against a single
 * record create/update/delete, and fires any that match. Deliberately not
 * meant to be awaited inline on the record create/update/delete route's
 * own hot path (see routes/projects.ts's own comment at the call site) --
 * a WhatsApp send is a real network round-trip, and this side effect must
 * never add latency to, or fail, the record-save response the user is
 * actually waiting on. Every failure mode below (no destination number,
 * not connected, send error, project deleted mid-flight) is caught and
 * recorded on the rule itself via recordAutomationRun, never thrown --
 * this function itself never rejects.
 *
 * Round 969: for a "deleted" event, `record` is the row's own last-known
 * state immediately before deletion (the DELETE route's own `before`
 * snapshot, already fetched there for file cleanup) -- fireRule below
 * never re-reads the record from the database, so interpolating
 * {{field}} placeholders, resolving a toMode:"field" destination, or
 * finding a file attachment all still work off that same in-memory
 * snapshot even though the row itself may already be gone by the time
 * this actually runs (it's fire-and-forget, scheduled after the response
 * already went out).
 */
export async function runAutomationsForRecordChange(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  project: Project,
  entity: Entity,
  event: "created" | "updated" | "deleted",
  record: EntityRecord,
  changedFields: Set<string>,
  uploadsDir: string,
  baseUrl: string,
): Promise<void> {
  const rules = listEnabledAutomationRulesForEntity(db, project.id, entity.name);
  for (const rule of rules) {
    if (!matchesTrigger(rule, event, record, changedFields, entity)) continue;
    try {
      await fireRule(db, whatsapp, emailSender, project, entity, rule, record, uploadsDir, baseUrl);
    } catch (err) {
      // Defensive only -- fireRule's own try/catch below already handles
      // every expected failure mode. This exists so a genuinely
      // unexpected error (e.g. a storage error from recordAutomationRun
      // itself) can never escape and crash whatever fire-and-forget
      // caller triggered this, since nothing downstream is awaiting or
      // handling this promise's rejection.
      console.error(`Automation rule ${rule.id} on project ${project.id} failed unexpectedly`, err);
    }
  }
}

// Private IPv4 ranges, loopback, link-local (169.254.0.0/16 also covers the
// AWS/GCP/Azure instance-metadata IP, 169.254.169.254 -- the single most
// common real-world SSRF target), and the IPv6 loopback/link-local
// equivalents -- a webhook URL is entirely user-supplied (any project
// collaborator can type one in), and this server would otherwise make an
// outbound request to wherever it points, from inside whatever network this
// process happens to run on. This is a deliberately cheap, hostname/literal-
// IP-string check, not full SSRF-proofing (no DNS-rebinding protection --
// fireWebhookAction's own fetch call does guard against a redirect-following
// bypass, via redirect: "manual", round 859) -- raising the bar against the
// common case at low complexity, not a guarantee against a determined
// attacker with DNS control.
// These dotted-decimal prefix patterns only mean anything for a genuine
// IPv4 literal -- isAllowedWebhookUrl below only runs them against a
// hostname that Node's own net.isIP already confirmed is one. Without
// that guard, an ordinary *public* hostname that merely starts with the
// same digits (e.g. "10.example.com", "192.168.mycompany.io",
// "172.16.shop.com") would match these as a plain string prefix and be
// wrongly blocked, even though it isn't a private IP at all -- a false
// positive with no security benefit, just a webhook URL a real business
// has no way to use.
// Round 899: 100.64.0.0/10 is the shared/CGNAT address space (RFC 6598).
// It is reachable the same way the other private ranges above are, and it
// matters for this guard specifically because it hosts Alibaba Cloud's
// instance-metadata endpoint (100.100.100.200) -- the Alibaba-cloud
// equivalent of the AWS/GCP/Azure 169.254.169.254 metadata IP this list
// already blocks. The second octet runs 64-127, expressed the same
// non-byte-aligned way as the existing 172.16-172.31 entry above.
const BLOCKED_IPV4_HOSTNAME_PATTERNS = [
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

// Safe to run against any hostname as-is: "localhost" is an exact match,
// and a colon is never valid in an ordinary DNS hostname (only inside the
// bracketed IPv6-literal form a URL's own hostname can take), so none of
// these can ever collide with a real public domain name's spelling.
const BLOCKED_OTHER_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  // IPv6's own "unspecified address" analogue of 0.0.0.0 above --
  // connecting to it routes to the local host the same way 0.0.0.0 does,
  // and Node's URL parser canonicalizes every all-zero spelling
  // ("[::0]", "[0:0:0:0:0:0:0:0]", "[0::0]", etc.) to this same "[::]".
  /^\[?::\]?$/,
  /^\[?::1\]?$/,
  // The real fe80::/10 link-local range is every address whose first 10
  // bits are 1111111010 -- i.e. first hex group fe80-febf (first byte
  // fixed at 0xfe, second byte's top two bits fixed at "10"), not just
  // the single literal group "fe80" a plain `/^fe80:/` only matches. A
  // real link-local address almost always has a non-zero interface
  // identifier in the low 64 bits (e.g. "fe81::1", "fe9a::abcd"), which
  // the old literal-prefix check let straight through.
  /^\[?fe[89ab][0-9a-f]:/i,
  // The real fc00::/7 unique-local (ULA) range is every address whose
  // first byte is 0xfc or 0xfd -- first hex group fc00-fdff -- not just
  // the two literal groups "fc00"/"fd00" a plain `/^fc00:|^fd00:/` only
  // matches. Almost every real-world ULA is "locally assigned" under
  // fd00::/8 with a random 40-bit global ID (RFC 4193), so a real one
  // looks like "fd12:3456:789a::1", never literally "fd00:...." -- the
  // old literal-prefix check let every one of those straight through,
  // bypassing this exact SSRF guard via the IPv6 side.
  /^\[?f[cd][0-9a-f]{2}:/i,
];

/**
 * Node's URL parser normalizes an IPv4-mapped IPv6 literal (e.g.
 * "[::ffff:169.254.169.254]", or the same address written in hex as
 * "[::ffff:a9fe:a9fe]") into its own canonical bracketed hex form --
 * neither form is itself a dotted-decimal IPv4 literal or matches any of
 * BLOCKED_OTHER_HOSTNAME_PATTERNS' IPv6-only patterns, so a blocked IPv4
 * target (the cloud instance-metadata IP included) could sail straight
 * through isAllowedWebhookUrl wrapped in this form. Unwraps it back to
 * the embedded IPv4 address so BLOCKED_IPV4_HOSTNAME_PATTERNS above still
 * catches it.
 *
 * `64:ff9b::` is the second real-world encoding of the identical hazard:
 * RFC 6052's well-known NAT64 prefix, used by networks that actually
 * perform NAT64/DNS64 translation (common on IPv6-mostly networks and
 * some cloud/container egress setups) to embed an IPv4 destination inside
 * an IPv6 literal the exact same way "::ffff:" does. Confirmed empirically
 * that Node's URL parser canonicalizes "[64:ff9b::169.254.169.254]" to
 * "[64:ff9b::a9fe:a9fe]" -- the identical hex-pair shape "::ffff:" already
 * produces, just under this other prefix, which the original regex never
 * matched at all.
 */
function extractIPv4MappedAddress(hostname: string): string | null {
  const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const match = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(stripped);
  if (!match) return null;
  const tail = match[1]!;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hexMatch) return null;
  const high = parseInt(hexMatch[1]!, 16);
  const low = parseInt(hexMatch[2]!, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Exported for direct unit testing -- see automations.test.ts. */
export function isAllowedWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  const hostToCheck = extractIPv4MappedAddress(hostname) ?? hostname;
  if (isIP(hostToCheck) === 4 && BLOCKED_IPV4_HOSTNAME_PATTERNS.some((p) => p.test(hostToCheck))) return false;
  return !BLOCKED_OTHER_HOSTNAME_PATTERNS.some((p) => p.test(hostToCheck));
}

/**
 * Round 1076: mirrors whatsappWeb.ts's own per-project sendQueue (round
 * 794) and email.ts's own ResendEmailSender.sendQueue (round 1073), for the
 * structurally identical hazard -- EntityPanel.tsx's bulk-update "Apply to
 * N" fires N concurrent PATCH requests, each independently triggering a
 * matching webhook automation rule (deliberately left un-suppressed for
 * bulk-update, same reasoning as the other two action types' own doc
 * comments), with zero spacing between any of the resulting POSTs. Unlike
 * Resend's single shared API key, each webhook rule can point at a wholly
 * different destination -- keyed per webhookUrl (a `Map`, like WhatsApp's
 * own per-project map), so only sends to the SAME destination are
 * serialized against each other; two rules posting to different URLs stay
 * fully independent, same as WhatsApp's own per-project independence.
 */
const webhookSendQueue = new Map<string, Promise<void>>();
const WEBHOOK_SEND_SPACING_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The actual webhook fetch, run one at a time per destination URL through
 * webhookSendQueue above -- chained off whatever is already queued for
 * this URL, with the fixed delay appended AFTER each actual send so the
 * next queued one doesn't go out back-to-back with it. A failed send
 * still rejects for its own caller (fireWebhookAction's own try/catch
 * below records the failure exactly as before) without jamming the queue
 * for the next send -- the same shape ResendEmailSender.send's own queue
 * uses.
 *
 * Round 1096: fixes the identical gap found and fixed in that same
 * ResendEmailSender queue -- `fetch` itself rejects (not just resolves
 * with a non-ok Response) on a real network failure or on
 * fireWebhookAction's own 10s AbortController timeout for a hanging
 * destination, so `queuedFetch` can reject here too. The old
 * `queuedFetch.then(() => delay(...)).catch(() => {})` shape only ran its
 * delay on the fulfilled path -- a rejection skipped straight to the
 * `.catch`, resolving immediately with zero spacing right after the
 * failure (an unreachable or timed-out destination) most likely to
 * recur on an immediate retry. Running the delay on both the fulfilled
 * and rejected paths closes that the same way.
 */
function queuedWebhookFetch(url: string, init: RequestInit): Promise<Response> {
  const previousInQueue = webhookSendQueue.get(url) ?? Promise.resolve();
  const queuedFetch = previousInQueue.then(() => fetch(url, init));
  const nextInQueue = queuedFetch.then(
    () => delay(WEBHOOK_SEND_SPACING_MS),
    () => delay(WEBHOOK_SEND_SPACING_MS),
  );
  webhookSendQueue.set(url, nextInQueue);
  void nextInQueue.finally(() => {
    if (webhookSendQueue.get(url) === nextInQueue) webhookSendQueue.delete(url);
  });
  return queuedFetch;
}

/**
 * The webhook counterpart to the WhatsApp send in fireRule/fireScheduledRule
 * below -- posts a small JSON payload describing the event instead of
 * sending a message. `entity`/`record` are null for a schedule rule (there's
 * no triggering record at all), in which case messageTemplate is sent
 * verbatim in the payload's own `message` field, same as fireScheduledRule's
 * WhatsApp path already does for the identical reason -- `baseUrl` is
 * `null` for that same case (nothing to resolve a file field's URL
 * against with no record). A 10s timeout keeps a slow/hanging destination
 * from blocking this automation (and, since this is fire-and-forget
 * background work either way, from leaking an open connection)
 * indefinitely.
 */
async function fireWebhookAction(
  db: ForgeDatabase,
  project: Project,
  entity: Entity | null,
  rule: AutomationRule,
  record: EntityRecord | null,
  baseUrl: string | null,
  // Round 924: defaults to the real current time for every existing
  // (record-triggered) caller, unchanged -- fireScheduledRule below
  // passes its own already-injected `now` instead, so a scheduled rule's
  // recorded run timestamp lines up with the same clock
  // hasTooManyConsecutiveFailuresToday judges "today" against, rather
  // than silently drifting to the real wall clock.
  now: Date = new Date(),
  // Round 1261: see recordAutomationRun's own doc comment (packages/db).
  // Only fireScheduledRule's own Test-route call site ever passes true.
  skipRuleSummaryUpdate: boolean = false,
): Promise<void> {
  // Round 991: see AutomationRun.recordSnapshot's own doc comment --
  // "record_deleted" is the one trigger a later retry can never re-fetch
  // the record for, since the triggering event IS that record's deletion.
  const recordSnapshot = rule.trigger === "record_deleted" && record ? JSON.stringify(record) : null;
  if (!rule.webhookUrl || !isAllowedWebhookUrl(rule.webhookUrl)) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      {
        status: "failed",
        error: "This rule has no valid webhook URL configured",
      },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      randomUUID(),
      skipRuleSummaryUpdate,
    );
    return;
  }
  const message =
    entity && record
      ? interpolateTemplate(
          rule.messageTemplate,
          entity,
          resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record, isHebrewText(project.description) ? "he" : "en"),
          isHebrewText(project.description) ? "he" : "en",
        )
      : rule.messageTemplate;
  // Round 1165: this feature's own doc comments advertise compatibility
  // with "Zapier, Slack, Make, or any other system" -- every one of those
  // documents itself as expecting a stable delivery id in the payload so
  // the receiver can deduplicate a resend from a genuinely new event. The
  // manual Retry route (round 971) re-fires this exact function against
  // the same rule/record/trigger, producing an identical-looking payload
  // with no field a receiver could use to tell "this is a resend" from
  // "this is a second, distinct event" -- generated up front (rather than
  // left to recordAutomationRun's own internal id generation, which only
  // ran AFTER the POST had already gone out) so it can be included in
  // what's actually sent over the wire, and then passed through to
  // recordAutomationRun below so the stored run row's own id matches
  // exactly what the receiver saw.
  const deliveryId = randomUUID();
  const payload = {
    event: rule.trigger,
    ruleId: rule.id,
    deliveryId,
    project: { id: project.id, name: project.name },
    entity: entity?.name ?? null,
    message,
    record: entity && record && baseUrl ? resolveFileFieldsForWebhook(entity, record, baseUrl) : record ?? null,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    // Round 859: isAllowedWebhookUrl above only ever validates rule.webhookUrl
    // itself -- without redirect: "manual", Node's own fetch (undici)
    // defaults to silently following up to 20 redirects, re-requesting
    // whatever Location a 3xx response names with NO re-validation against
    // that guard. An attacker only needs to control (or compromise) any
    // ordinary public HTTP(S) endpoint -- trivially passing the hostname
    // check -- then respond with a redirect to the cloud instance-metadata
    // address (169.254.169.254) or any other blocked target, and every bit
    // of the hardening above is defeated in one hop. This is the single
    // most common real-world SSRF bypass technique, strictly easier than
    // the DNS-rebinding attack isAllowedWebhookUrl's own comment already
    // discloses as out of scope -- unlike DNS rebinding, it needs no DNS
    // control or timing race at all. redirect: "manual" makes fetch return
    // the raw 3xx response instead of following it (confirmed empirically:
    // status/ok reflect the redirect response itself, not an opaque
    // browser-only type) -- res.ok below is already false for any 3xx, so
    // this alone, with no other change, turns a followed redirect into an
    // ordinary reported failure.
    // Round 974: see AutomationRule's own doc comment on webhookSecret --
    // null (every rule created before this round, or one that simply never
    // set it) leaves this identical to the request this function always
    // sent.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (rule.webhookSecret) headers.authorization = `Bearer ${rule.webhookSecret}`;
    const res = await queuedWebhookFetch(rule.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "manual",
    });
    // Same re-check-after-await hazard fireRule's own WhatsApp branch
    // already documents (its own comment a few dozen lines above) --
    // queuedWebhookFetch is a genuine network round-trip (up to the 10s
    // timeout below), during which this project could have been deleted.
    // deleteProject's own deleteAutomationRulesForProject already removed
    // every automation_runs row for this project synchronously; without
    // this check, recordAutomationRun below would silently recreate one
    // for a project id that no longer exists -- a permanently orphaned
    // row nothing else will ever clean up, since automation_runs has no
    // foreign key/cascade of its own.
    if (!getProject(db, project.id)) return;
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      {
        status: res.ok ? "sent" : "failed",
        error: res.ok ? null : `Webhook responded with status ${res.status}`,
      },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      deliveryId,
      skipRuleSummaryUpdate,
    );
  } catch (err) {
    if (!getProject(db, project.id)) return;
    // Round 1327: a timed-out request rejects with fetch/undici's own
    // generic AbortError ("This operation was aborted" or similar), which
    // tells a user debugging a failed webhook rule nothing about WHY it
    // failed -- indistinguishable from a DNS failure, a connection refusal,
    // or any other genuine network error. Special-cased the same way
    // email.ts's ResendEmailSender.performSend already does for its own
    // identical AbortController timeout, so this stays a single, stable,
    // always-identical literal (the timeout itself is the fixed 10_000ms
    // constant above, never configurable) that AUTOMATION_CONFIG_ERROR_CODES
    // (apps/web/src/api.ts) can translate like every other whole-rule
    // misconfiguration message.
    const message = controller.signal.aborted ? "Webhook request timed out after 10000ms" : err instanceof Error ? err.message : "Webhook request failed";
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      {
        status: "failed",
        error: message,
      },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      deliveryId,
      skipRuleSummaryUpdate,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Round 996: the email counterpart to fireWebhookAction above, following
 * its exact same shape -- `entity`/`record` are null for a schedule rule
 * (no triggering record at all), in which case messageTemplate/emailSubject
 * are sent verbatim rather than interpolated, same as fireWebhookAction's
 * own payload message and fireScheduledRule's own WhatsApp path already do
 * for the identical reason. `emailSender.configured` is false whenever
 * RESEND_API_KEY isn't set (see email.ts's own doc comment) -- checked
 * first, mirroring fireRule's own pre-send whatsapp.getStatus() check,
 * so a deployment that never configured email support fails this one
 * rule's own run with a clear, specific error instead of throwing.
 */
async function fireEmailAction(
  db: ForgeDatabase,
  emailSender: EmailSender,
  project: Project,
  entity: Entity | null,
  rule: AutomationRule,
  record: EntityRecord | null,
  uploadsDir: string | null = null,
  now: Date = new Date(),
  // Round 1261: see fireWebhookAction's own identical parameter just above.
  skipRuleSummaryUpdate: boolean = false,
): Promise<void> {
  // Round 991: see AutomationRun.recordSnapshot's own doc comment --
  // "record_deleted" is the one trigger a later retry can never re-fetch
  // the record for, since the triggering event IS that record's deletion.
  const recordSnapshot = rule.trigger === "record_deleted" && record ? JSON.stringify(record) : null;
  // Round 1188: resolve against the entity's current field casing -- see
  // resolveStoredFieldName's own doc comment. entity/record are null only
  // for a schedule rule (no record context at all), in which case toField
  // can't be resolved either and the existing `record ?` guard below
  // already yields null regardless.
  const resolvedToField = entity && rule.toField ? resolveStoredFieldName(entity, rule.toField) : rule.toField;
  const to = rule.toMode === "static" ? rule.toEmail : resolvedToField && record ? record[resolvedToField] : null;
  if (!to || typeof to !== "string" || !to.trim()) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: "This rule has no destination email address configured" },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      randomUUID(),
      skipRuleSummaryUpdate,
    );
    return;
  }
  // Round 1080: unlike a toMode:"static" destination (validated at rule-
  // creation time by CreateAutomationRuleSchema's own z.string().email()),
  // a toMode:"field" destination's value is only known per-record at send
  // time, so it never passes through that schema at all -- the WhatsApp
  // sibling action already guards the identical gap (whatsappWeb.ts's own
  // sendMessage normalizePhone/leading-zero checks, see its doc comment)
  // before ever touching the real network call, but fireEmailAction here
  // only ever checked non-empty. A field picked off a record (e.g. an
  // AutomationsPanel.tsx toField dropdown entry that isn't actually an
  // email field) would otherwise be POSTed straight to Resend's API as-is.
  // Reuses the exact same z.string().email() validator the static path
  // already enforces, so both destination modes agree on what counts as
  // valid rather than each having its own independently-drifting notion.
  if (!z.string().email().safeParse(to).success) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: "invalid_email_address" },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      randomUUID(),
      skipRuleSummaryUpdate,
    );
    return;
  }
  if (!emailSender.configured) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: EMAIL_NOT_CONFIGURED_ERROR },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      randomUUID(),
      skipRuleSummaryUpdate,
    );
    return;
  }
  const lang: Lang = isHebrewText(project.description) ? "he" : "en";
  const subjectTemplate = rule.emailSubject ?? "";
  const bodyTemplate = rule.messageTemplate;
  let subject = subjectTemplate;
  let body = bodyTemplate;
  // Round 1013: resolved from `record` (the raw, pre-interpolation value),
  // not templateRecord -- same reasoning as fireRule's own WhatsApp
  // attachment lookup just below: resolveRelationFieldsForTemplate only
  // ever rewrites relation fields, so both carry the identical raw
  // {url,...} descriptor for any file field.
  let attachments: EmailAttachment[] | undefined;
  if (entity && record) {
    const templateRecord = resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record, lang);
    subject = interpolateTemplate(subjectTemplate, entity, templateRecord, lang);
    body = interpolateTemplate(bodyTemplate, entity, templateRecord, lang);
    if (uploadsDir) {
      // Round 1014: round 1013's own fix only ever scanned bodyTemplate,
      // missing a file field referenced ONLY in emailSubject -- which
      // interpolates its own {{field}} placeholders completely
      // independently of the body (round 1000's own fix, confirmed by
      // CreateAutomationRuleSchema/AutomationsPanel.tsx placing no
      // restriction on which field types can appear in either template).
      // Scanning body-then-subject as one combined string preserves round
      // 1013's own already-tested precedence (a body reference still wins
      // when both templates happen to reference a file field) while now
      // also catching a subject-only reference.
      // Round 1325: unlike fireRule's own WhatsApp branch just below (one
      // attachment max, a real Baileys/WhatsApp limitation), email can
      // carry every distinct file field the template references.
      const templateAttachments = findAllTemplateFileAttachments(uploadsDir, project.id, entity, `${bodyTemplate}\n${subjectTemplate}`, record);
      const resolved: EmailAttachment[] = [];
      for (const attachment of templateAttachments) {
        // Same disk-error degradation fireRule's own WhatsApp branch
        // already documents: the referenced upload may have been
        // deleted/replaced since this rule last ran, or the uploads
        // directory may not be readable for some other reason -- that
        // degrades to sending without that one file simply missing,
        // never a reported send FAILURE.
        const fileBuffer = await readFile(attachment.filePath).catch(() => null);
        if (fileBuffer) {
          resolved.push({ filename: attachment.fileName, content: fileBuffer.toString("base64") });
        }
      }
      if (resolved.length > 0) {
        attachments = resolved;
      }
    }
  }
  try {
    await emailSender.send(to, subject, body, attachments);
    // Same re-check-after-await hazard fireWebhookAction's own identical
    // comment documents, applied to this sibling action's own genuine
    // network round-trip (a real Resend API call) -- without it,
    // recordAutomationRun below would silently recreate an
    // automation_runs row for a project deleteProject already removed
    // every such row for, permanently orphaned since that table has no
    // foreign key/cascade of its own.
    if (!getProject(db, project.id)) return;
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "sent", error: null },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      randomUUID(),
      skipRuleSummaryUpdate,
    );
  } catch (err) {
    if (!getProject(db, project.id)) return;
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: err instanceof Error ? err.message : "Email send failed" },
      rule.actionType,
      record ? Number(record.id) : null,
      recordSnapshot,
      now,
      randomUUID(),
      skipRuleSummaryUpdate,
    );
  }
}

/**
 * Round 971: exported so routes/projects.ts's manual Retry route (POST
 * .../runs/:runId/retry) can re-invoke this SAME single-attempt logic
 * directly, against the record's current state, instead of duplicating
 * it -- a retry is just firing the rule again, not a different code path.
 */
export async function fireRule(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  project: Project,
  entity: Entity,
  rule: AutomationRule,
  record: EntityRecord,
  uploadsDir: string,
  baseUrl: string,
  // Round 1276: mirrors fireScheduledRule's own isManualTest (round 1261) --
  // only routes/projects.ts's POST .../test route's non-schedule branch
  // passes true. Unlike that schedule-rule case, there's no "already due
  // today" concept for a record-triggered rule to protect, but the exact
  // same false-positive-notification risk still applies: App.tsx's
  // failing-automations badge/count and its "newly failing" desktop
  // notification (round 1218) both key off rule.lastStatus === "failed",
  // which recordAutomationRun below unconditionally updated for every
  // Test click on a field_equals/record_created/record_deleted rule --
  // a user deliberately testing against bad data (or simply triggering a
  // real, unrelated failure) saw it reported as if production had just
  // started failing. The manual Retry route (round 971/972, the other
  // caller of this function) deliberately keeps isManualTest=false, since
  // a successful retry SHOULD count as the rule's real last outcome.
  isManualTest: boolean = false,
): Promise<void> {
  const now = new Date();
  if (rule.actionType === "webhook") {
    await fireWebhookAction(db, project, entity, rule, record, baseUrl, now, isManualTest);
    return;
  }
  if (rule.actionType === "send_email") {
    await fireEmailAction(db, emailSender, project, entity, rule, record, uploadsDir, now, isManualTest);
    return;
  }
  // Round 991: see AutomationRun.recordSnapshot's own doc comment --
  // "record_deleted" is the one trigger a later retry can never re-fetch
  // the record for, since the triggering event IS that record's deletion.
  const recordSnapshot = rule.trigger === "record_deleted" ? JSON.stringify(record) : null;
  // Round 1188: resolve against the entity's current field casing -- see
  // resolveStoredFieldName's own doc comment.
  const resolvedToField = rule.toField ? resolveStoredFieldName(entity, rule.toField) : null;
  const rawTo = rule.toMode === "static" ? rule.toNumber : resolvedToField ? record[resolvedToField] : null;
  // Round 1321: a phone-like-named field can end up typed "number" (the AI
  // spec generator has no way to know "phone" should be text, and a phone
  // number "looks numeric"), in which case repository.ts stores and
  // returns it as a real JS number, never a string -- so this rule's own
  // toMode:"field" destination always failed with "no value in the
  // configured phone-number field" for a perfectly valid number, even
  // though the record plainly has one. Mirrors the identical fix already
  // made for the same underlying defect in two other call sites:
  // whatsapp.ts's findMatchingRecord (round 1278, inbound message ->
  // record) and entityFormatting.ts's findRecordPhoneNumber (round 1286,
  // the "Send WhatsApp" button's own visibility check).
  const to = typeof rawTo === "number" ? String(rawTo) : rawTo;
  if (!to || typeof to !== "string" || !to.trim()) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: "This record has no value in the configured phone-number field" },
      rule.actionType,
      Number(record.id),
      recordSnapshot,
      now,
      randomUUID(),
      isManualTest,
    );
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: WHATSAPP_NOT_CONNECTED_ERROR },
      rule.actionType,
      Number(record.id),
      recordSnapshot,
      now,
      randomUUID(),
      isManualTest,
    );
    return;
  }
  const lang: Lang = isHebrewText(project.description) ? "he" : "en";
  const templateRecord = resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record, lang);
  const message = interpolateTemplate(rule.messageTemplate, entity, templateRecord, lang);
  // `record`, not templateRecord -- a file field's own stored value is
  // never touched by resolveRelationFieldsForTemplate (that only rewrites
  // relation fields), so both carry the identical raw {url,...} descriptor
  // for any file field; using the original avoids any accidental coupling
  // to a transform this lookup has nothing to do with.
  const attachment = findTemplateFileAttachment(uploadsDir, project.id, entity, rule.messageTemplate, record) ?? undefined;
  const result = await whatsapp.sendMessage(project.id, to, message, attachment);
  // Same re-check-after-await hazard the manual send route already
  // documents (routes/projects.ts's POST .../whatsapp/send) -- sendMessage
  // above is a genuine await (a real network round-trip), during which
  // this project could have been deleted. Without this, insertWhatsAppMessage
  // and recordAutomationRun below would silently recreate rows for a
  // project id that no longer exists.
  if (!getProject(db, project.id)) return;
  const match = project.status === "built" ? findMatchingRecord(db, project, to) : null;
  insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "out",
    fromNumber: status.phoneNumber ?? "",
    toNumber: to,
    body: message,
    matchedEntityName: match?.entityName ?? null,
    matchedRecordId: match?.recordId ?? null,
    matchedLabel: match?.label ?? null,
    status: result.ok ? "sent" : "failed",
  });
  recordAutomationRun(
    db,
    project.id,
    rule.id,
    { status: result.ok ? "sent" : "failed", error: result.ok ? null : (result.error ?? "Send failed") },
    rule.actionType,
    Number(record.id),
    recordSnapshot,
    now,
    randomUUID(),
    isManualTest,
  );
}

const WEEKDAY_SHORT_NAME_TO_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Round 967: the rule's own wall-clock date/time/day-of-week in
 * `timeZone`, read off the real IANA timezone database (via Intl) rather
 * than computed as a fixed UTC offset -- this is what makes a schedule
 * rule's day-of-week and time-of-day stay correct across a DST
 * transition with zero code re-running anywhere: the same `timeZone`
 * string ("Asia/Jerusalem", say) means a different real UTC offset in
 * January than in July, and Intl already knows exactly which, for every
 * date, forever (including past/future DST rule changes a government
 * might legislate, as long as Node's own bundled tzdata is kept current).
 * Passing `timeZone: "UTC"` reproduces the exact previous behavior
 * (`now.toISOString()`'s own date/time components, `now.getUTCDay()`) --
 * the default every rule created before this column existed still gets.
 */
function wallClockIn(now: Date, timeZone: string): { date: string; hhmm: string; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  // Some ICU builds return "24" rather than "00" for midnight even with
  // hour12:false -- a known Intl quirk, not specific to any one timeZone.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${hour}:${get("minute")}`,
    dayOfWeek: WEEKDAY_SHORT_NAME_TO_INDEX[get("weekday")],
  };
}

/**
 * Whether a "schedule" rule is due to fire at `now`. Checks "has its
 * scheduled time of day already passed today" rather than "does the
 * current time exactly equal the scheduled time" -- the periodic checker
 * below only ticks once a minute (and could occasionally run a little
 * late under load, or miss a tick entirely across a process restart), so
 * an exact-match comparison could silently skip an entire day. Reusing
 * `lastTriggeredAt`/`lastStatus` (already recorded by recordAutomationRun
 * on every fire) to track "already *succeeded* today" means this needs no
 * extra column for that -- once it's actually sent today, it stays
 * not-due until the rule's own local date (see wallClockIn above) rolls
 * over, however many ticks happen in between.
 *
 * Round 967: "today," "time of day," and "day of week" are all now the
 * rule's own wall-clock values in its `scheduleTimezone` (defaulting to
 * "UTC" for a rule with none set -- every rule created before this round
 * -- which reproduces the exact previous UTC-only behavior bit-for-bit).
 * Before this, scheduleTimeUtc/scheduleDaysOfWeek were always interpreted
 * as literal UTC with no way to express "my own local time" at all -- a
 * user in a timezone ahead of UTC picking, say, local Monday 00:30 had to
 * know to check the "Sunday" box instead, since that moment falls on UTC
 * Sunday, not Monday. Storing the real IANA zone instead of asking the
 * user to do that conversion themselves means this also self-corrects
 * across DST twice a year, with no stale baked-in offset to go stale.
 *
 * Deliberately gated on `lastStatus === "sent"`, not just "already
 * attempted today" -- WhatsApp disconnects are an acknowledged,
 * no-auto-reconnect reality (see whatsappWeb.ts's own module comment), so
 * a rule whose one daily attempt lands in exactly that window would
 * otherwise record a "failed" lastTriggeredAt and then silently stay
 * not-due for the rest of the day even after the owner reconnects minutes
 * later -- a once-daily "send today's report" automation (this app's own
 * flagship feature) skipping an entire day on pure bad luck, with no
 * manual re-fire control anywhere in AutomationsPanel.tsx to recover.
 * Gating on the real outcome instead lets a failed attempt keep retrying
 * on every subsequent tick (still just once per successful send).
 */
export function isScheduledRuleDue(rule: AutomationRule, now: Date): boolean {
  if (rule.trigger !== "schedule" || !rule.scheduleTimeUtc) return false;
  const timeZone = rule.scheduleTimezone ?? "UTC";
  const { date: today, hhmm: currentHHMM, dayOfWeek } = wallClockIn(now, timeZone);
  if (rule.lastTriggeredAt && wallClockIn(new Date(rule.lastTriggeredAt), timeZone).date === today && rule.lastStatus === "sent") {
    return false;
  }
  if (rule.scheduleDaysOfWeek) {
    const days = rule.scheduleDaysOfWeek.split(",").map(Number);
    if (!days.includes(dayOfWeek)) return false;
  }
  return currentHHMM >= rule.scheduleTimeUtc;
}

/**
 * The schedule-trigger sibling of fireRule above -- deliberately a
 * separate, simpler function rather than fireRule with record/entity
 * arguments forced to null: a schedule rule has no triggering record at
 * all, so there's nothing to resolve a toMode:"field" destination from
 * (schema validation requires toMode:"static" for a schedule rule, see
 * routes/projects.ts's CreateAutomationRuleSchema) and no {{field}}
 * placeholder could ever resolve to anything, so messageTemplate is sent
 * verbatim rather than run through interpolateTemplate. Everything past
 * that point -- the WhatsApp send, the message-log entry, and recording
 * the outcome on the rule -- mirrors fireRule exactly.
 */
export async function fireScheduledRule(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  project: Project,
  rule: AutomationRule,
  // Round 924: same purpose as fireWebhookAction's own `now` parameter --
  // defaults to the real current time, but runScheduledAutomationsCheck
  // passes its own already-injected `now` so the recorded run's own
  // timestamp lines up with the exact clock that decided this rule was
  // due, which hasTooManyConsecutiveFailuresToday then judges "today"
  // against.
  now: Date = new Date(),
  // Round 1261: set by routes/projects.ts's POST .../test route alone, for
  // a "schedule"-trigger rule, so a manual Test's own successful send
  // never marks today's REAL scheduled occurrence as already having
  // happened -- see recordAutomationRun's own doc comment (packages/db)
  // for the full reasoning. The real scheduler (runScheduledAutomationsCheck
  // below) and the existing manual Retry route both leave this at its
  // default false, unchanged.
  isManualTest: boolean = false,
): Promise<void> {
  if (rule.actionType === "webhook") {
    await fireWebhookAction(db, project, null, rule, null, null, now, isManualTest);
    return;
  }
  if (rule.actionType === "send_email") {
    await fireEmailAction(db, emailSender, project, null, rule, null, null, now, isManualTest);
    return;
  }
  const to = rule.toNumber;
  if (!to || !to.trim()) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      {
        status: "failed",
        error: "This rule has no destination phone number configured",
      },
      rule.actionType,
      null,
      null,
      now,
      randomUUID(),
      isManualTest,
    );
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: WHATSAPP_NOT_CONNECTED_ERROR },
      rule.actionType,
      null,
      null,
      now,
      randomUUID(),
      isManualTest,
    );
    return;
  }
  const result = await whatsapp.sendMessage(project.id, to, rule.messageTemplate);
  // Same re-check-after-await hazard fireRule's own identical line documents.
  if (!getProject(db, project.id)) return;
  const match = project.status === "built" ? findMatchingRecord(db, project, to) : null;
  insertWhatsAppMessage(db, {
    projectId: project.id,
    direction: "out",
    fromNumber: status.phoneNumber ?? "",
    toNumber: to,
    body: rule.messageTemplate,
    matchedEntityName: match?.entityName ?? null,
    matchedRecordId: match?.recordId ?? null,
    matchedLabel: match?.label ?? null,
    status: result.ok ? "sent" : "failed",
  });
  recordAutomationRun(
    db,
    project.id,
    rule.id,
    {
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : (result.error ?? "Send failed"),
    },
    rule.actionType,
    null,
    null,
    now,
    randomUUID(),
    isManualTest,
  );
}

// Round 924: how many consecutive failed attempts a scheduled rule may
// retry on within a single day before this tick stops firing it for the
// rest of that day -- see hasTooManyConsecutiveFailuresToday's own doc
// comment just below for why this exists.
const MAX_CONSECUTIVE_SCHEDULE_FAILURES_PER_DAY = 5;

/**
 * Round 924: caps how many times a scheduled rule's own daily attempt
 * retries against a destination that keeps failing. isScheduledRuleDue
 * above deliberately keeps a failed attempt "due" on every subsequent
 * tick for the rest of the day -- by design, to recover from a
 * transient WhatsApp disconnect (see its own doc comment) -- but that
 * same design retried a PERMANENTLY failing destination (a wrong or
 * blocked number, a webhook that reliably errors) every single minute,
 * forever, with no cap at all: a real WhatsApp-Web number-flagging risk
 * whatsappWeb.ts's own module comment already warns about, and
 * unbounded hammering of a webhook endpoint.
 *
 * Reuses the rule's own already-retained recent runs (recordAutomationRun
 * keeps the newest AUTOMATION_RUNS_RETENTION_LIMIT=20, comfortably more
 * than this needs) rather than adding a new counter column: looks at the
 * most recent MAX_CONSECUTIVE_SCHEDULE_FAILURES_PER_DAY runs, newest
 * first, and stops retrying only once every one of them is both
 * "failed" AND from today. A single success breaks the streak
 * immediately (the newest run is "sent", not "failed"), and a new UTC
 * day does too (yesterday's failed runs no longer match "today"), so
 * this never permanently disables a rule -- it only quiets a storm of
 * identical failures within the one day they happened, exactly
 * mirroring isScheduledRuleDue's own "retry today, fresh start
 * tomorrow" contract.
 *
 * Round 934: a "WhatsApp is not connected" failure (fireScheduledRule's
 * own pre-send check, just above) is excluded from this count entirely
 * -- it's evidence the owner simply hadn't reconnected yet, not evidence
 * the destination itself is broken, and counting it toward this cap
 * could trip it on nothing more than a brief disconnect. Once tripped,
 * this check returns true forever for the rest of the day (no new run
 * ever gets recorded to change the window), which directly contradicts
 * isScheduledRuleDue's own documented guarantee of recovering "even
 * after the owner reconnects minutes later" -- a daily report could go
 * completely unsent for the rest of the day over a 5-minute outage.
 *
 * Round 1263: a run's own isTest flag (AutomationRun.isTest's own doc
 * comment) is excluded from this count for the identical reason -- round
 * 1261 already stopped a manual Test from marking today's real
 * occurrence as "already sent" via isScheduledRuleDue, but every Test
 * still inserted a fully real automation_runs row with no way to tell it
 * apart from a genuine scheduler-tick failure. Debugging a broken rule
 * by clicking Test repeatedly (five failed attempts while iterating on a
 * fix is an entirely ordinary troubleshooting flow) could trip this cap
 * on nothing but Test clicks, silently skipping that day's real
 * scheduled send even after the real misconfiguration was fixed --
 * directly contradicting Test's own stated "no side effects on the real
 * schedule" contract, the same root cause as round 1261 but a different
 * downstream consumer of the same unconditional history row.
 *
 * Round 951: isScheduledRuleDue keeps this rule "due" every single tick
 * (every 60s, startScheduledAutomationsLoop) for the rest of the day after
 * ANY failure, disconnect included -- so one ordinary outage can easily
 * produce dozens of consecutive "WhatsApp is not connected" rows, far more
 * than this function's old default lookback (listAutomationRuns' own
 * default limit, matching AUTOMATION_RUNS_RETENTION_LIMIT exactly). That
 * let a disconnect flood evict a real failure from the table entirely
 * (recordAutomationRun's own retention prune, packages/db/src/automations.ts,
 * used to cut across both kinds of row together) before a second real
 * failure could ever join it in the same lookback window -- silently
 * defeating this cap for the very ordinary combination of a permanently
 * wrong destination plus a long outage, exactly the number-flagging risk
 * round 924 exists to bound. recordAutomationRun's prune now keeps the
 * newest AUTOMATION_RUNS_RETENTION_LIMIT rows of EACH kind independently,
 * so a disconnect flood of any length can no longer evict a real failure
 * -- but this function's own lookback still has to be widened to match,
 * or it would just fail to ever SEE those real rows within its own
 * narrower fetch, even though they're still safely in the table.
 *
 * Round 959: exported (was module-private) so GET /projects/:id/automations
 * (routes/projects.ts) can surface this same computed state to the client
 * as `pausedForToday` -- this cap's mechanics were always documented here,
 * but nothing ever told the user a rule had actually been paused for the
 * rest of the day, as opposed to still actively retrying every minute. A
 * user who noticed one failure, fixed the destination, and checked back
 * had no way to know their fix wouldn't take effect until tomorrow's UTC
 * rollover, since fixing the destination doesn't itself clear this cap --
 * only a new successful run or a new UTC day does, and neither happens
 * while the scheduler keeps skipping the rule.
 *
 * Round 967: deliberately left on a plain UTC "today" boundary, unlike
 * isScheduledRuleDue's own switch to the rule's scheduleTimezone -- this
 * is an internal safety cap on retry volume, not a user-visible "did my
 * message go out today" guarantee, so its day boundary landing a few
 * hours off from the rule's own local midnight has no real-world
 * consequence (the cap still resets once per real day, just not exactly
 * at this rule's own local midnight). Not an oversight to "fix" later.
 *
 * Round 1032: EMAIL_NOT_CONFIGURED_ERROR (a send_email rule's own
 * deployment-level "no RESEND_API_KEY" gap) is the exact same shape of
 * transient, not-the-rule's-fault fault as a WhatsApp disconnect, and now
 * gets its own independent retention bucket to match (recordAutomationRun,
 * packages/db/src/automations.ts) -- excluded here for the identical
 * reason, and the lookback widened from 2x to 3x AUTOMATION_RUNS_RETENTION_LIMIT
 * since there are now three independently-retained buckets (WhatsApp,
 * email, everything else) that can each contribute up to that many rows
 * ahead of a real failure in triggeredAt order.
 */
export function hasTooManyConsecutiveFailuresToday(db: ForgeDatabase, rule: AutomationRule, now: Date): boolean {
  const todayUtc = now.toISOString().slice(0, 10);
  const runs = listAutomationRuns(db, rule.projectId, rule.id, 3 * AUTOMATION_RUNS_RETENTION_LIMIT)
    .filter((run) => run.error !== WHATSAPP_NOT_CONNECTED_ERROR && run.error !== EMAIL_NOT_CONFIGURED_ERROR && !run.isTest)
    .slice(0, MAX_CONSECUTIVE_SCHEDULE_FAILURES_PER_DAY);
  if (runs.length < MAX_CONSECUTIVE_SCHEDULE_FAILURES_PER_DAY) return false;
  return runs.every((run) => run.status === "failed" && run.triggeredAt.slice(0, 10) === todayUtc);
}

/**
 * One tick of the periodic scheduler: every enabled schedule rule across
 * every project, fires whichever ones isScheduledRuleDue says are due
 * right now. `now` defaults to the real current time but is injectable
 * so tests can check "is this rule due" behavior deterministically
 * instead of depending on when the test happens to run (see this file's
 * own test for the exact lesson this avoids -- fake timers plus
 * waitForCondition is a documented hazard elsewhere in this codebase).
 * Each rule's own failure is caught and recorded, never thrown, the same
 * contract runAutomationsForRecordChange already has -- this is called
 * from a bare setInterval tick (startScheduledAutomationsLoop below)
 * with nothing to catch a rejection.
 */
export async function runScheduledAutomationsCheck(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  now: Date = new Date(),
): Promise<void> {
  const rules = listEnabledScheduledRules(db);
  for (const rule of rules) {
    if (!isScheduledRuleDue(rule, now)) continue;
    if (hasTooManyConsecutiveFailuresToday(db, rule, now)) continue;
    const project = getProject(db, rule.projectId);
    if (!project) continue;
    try {
      await fireScheduledRule(db, whatsapp, emailSender, project, rule, now);
    } catch (err) {
      console.error(`Scheduled automation rule ${rule.id} on project ${project.id} failed unexpectedly`, err);
    }
  }
}

/**
 * Starts the real periodic check -- called once from server.ts's own
 * top-level startup script, deliberately NEVER from createApp() itself
 * (app.ts), since app.test.ts's withServer helper calls createApp() fresh
 * per test with no corresponding place to stop a background interval;
 * starting it there would leak a live setInterval per test across
 * hundreds of tests. Returns a stop() so a caller that DOES want to tear
 * this down (a future server shutdown handler) can.
 */
export function startScheduledAutomationsLoop(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  emailSender: EmailSender,
  intervalMs = 60_000,
): () => void {
  // isScheduledRuleDue's own "already sent today" guard reads
  // rule.lastTriggeredAt/lastStatus, which recordAutomationRun only
  // writes once fireScheduledRule's own send/webhook call resolves --
  // nothing here previously stopped a NEW tick from starting while a
  // PREVIOUS tick was still mid-flight awaiting one. A webhook rule's
  // own 10s-per-rule timeout (fireWebhookAction), or several schedule
  // rules queued through whatsappWeb.ts's own per-project sendQueue
  // (each with its own ~1200ms post-send spacing delay), can push one
  // tick's total runtime past this 60s interval with nothing unusual
  // going on -- not a contrived edge case. Without this guard, the next
  // tick's own listEnabledScheduledRules read still sees the same
  // pre-update rule, isScheduledRuleDue returns true again, and
  // fireScheduledRule runs a second time concurrently with the first --
  // a real duplicate WhatsApp message to a real recipient, or a
  // duplicate webhook POST to an external system with no idempotency
  // key of its own (unlike idempotency.ts, which only covers
  // user-initiated HTTP requests, not this internal scheduler). Mirrors
  // the same "skip starting new work while existing work for this key is
  // still in flight" idiom already used elsewhere in this codebase
  // (whatsappWeb.ts's pendingConnect/pendingCleanup, routes/projects.ts's
  // activePipelines) -- scoped to this loop's own closure, not a
  // module-level flag, so direct test calls to runScheduledAutomationsCheck
  // itself are never affected by it.
  let tickInFlight = false;
  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void runScheduledAutomationsCheck(db, whatsapp, emailSender).finally(() => {
      tickInFlight = false;
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
