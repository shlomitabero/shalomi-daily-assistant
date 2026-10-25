import { isIP } from "node:net";
import path from "node:path";
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
  type AutomationRule,
  type ForgeDatabase,
} from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { recordDisplayLabel } from "./displayField.js";
import { isPathInsideDir, UPLOADED_FILENAME } from "./uploadPaths.js";
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
    const fieldName = match[1];
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
    const storedFilename = parsed.url.slice(parsed.url.lastIndexOf("/") + 1);
    if (!storedFilename || !UPLOADED_FILENAME.test(storedFilename)) continue;
    const filePath = path.join(uploadsDir, projectId, entity.name, storedFilename);
    if (!isPathInsideDir(filePath, uploadsDir)) continue;
    return { filePath, fileName: parsed.name, mimeType: parsed.mimeType };
  }
  return null;
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
export function interpolateTemplate(template: string, entity: Entity, record: EntityRecord, lang: Lang): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, fieldName: string) => {
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
    if (field?.type === "number") return Number(value).toLocaleString(LOCALE[lang]);
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
): EntityRecord {
  const resolved: EntityRecord = { ...record };
  for (const field of entity.fields) {
    if (field.type !== "relation") continue;
    const value = record[field.name];
    if (value === null || value === undefined) continue;
    const targetEntity = field.relationTo ? allEntities.find((e) => e.name === field.relationTo) : undefined;
    const targetRecord = targetEntity ? getRecord(db, projectId, targetEntity, Number(value)) : undefined;
    resolved[field.name] = targetRecord ? recordDisplayLabel(targetEntity!, targetRecord) : `#${value}`;
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
 */
export function matchesTrigger(
  rule: AutomationRule,
  event: "created" | "updated" | "deleted",
  record: EntityRecord,
  changedFields: Set<string>,
): boolean {
  if (rule.trigger === "record_created") {
    return event === "created";
  }
  if (rule.trigger === "record_deleted") {
    return event === "deleted";
  }
  if (event === "deleted") return false;
  if (!rule.fieldName) return false;
  if (event === "updated" && !changedFields.has(rule.fieldName)) return false;
  const actual = record[rule.fieldName];
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
    if (!matchesTrigger(rule, event, record, changedFields)) continue;
    try {
      await fireRule(db, whatsapp, project, entity, rule, record, uploadsDir, baseUrl);
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
): Promise<void> {
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
      now,
    );
    return;
  }
  const message =
    entity && record
      ? interpolateTemplate(
          rule.messageTemplate,
          entity,
          resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record),
          isHebrewText(project.description) ? "he" : "en",
        )
      : rule.messageTemplate;
  const payload = {
    event: rule.trigger,
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
    const res = await fetch(rule.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "manual",
    });
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
      now,
    );
  } catch (err) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      {
        status: "failed",
        error: err instanceof Error ? err.message : "Webhook request failed",
      },
      rule.actionType,
      record ? Number(record.id) : null,
      now,
    );
  } finally {
    clearTimeout(timeout);
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
  project: Project,
  entity: Entity,
  rule: AutomationRule,
  record: EntityRecord,
  uploadsDir: string,
  baseUrl: string,
): Promise<void> {
  if (rule.actionType === "webhook") {
    await fireWebhookAction(db, project, entity, rule, record, baseUrl);
    return;
  }
  const to = rule.toMode === "static" ? rule.toNumber : rule.toField ? record[rule.toField] : null;
  if (!to || typeof to !== "string" || !to.trim()) {
    recordAutomationRun(
      db,
      project.id,
      rule.id,
      { status: "failed", error: "This record has no value in the configured phone-number field" },
      rule.actionType,
      Number(record.id),
    );
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(db, project.id, rule.id, { status: "failed", error: WHATSAPP_NOT_CONNECTED_ERROR }, rule.actionType, Number(record.id));
    return;
  }
  const templateRecord = resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record);
  const lang: Lang = isHebrewText(project.description) ? "he" : "en";
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
  project: Project,
  rule: AutomationRule,
  // Round 924: same purpose as fireWebhookAction's own `now` parameter --
  // defaults to the real current time, but runScheduledAutomationsCheck
  // passes its own already-injected `now` so the recorded run's own
  // timestamp lines up with the exact clock that decided this rule was
  // due, which hasTooManyConsecutiveFailuresToday then judges "today"
  // against.
  now: Date = new Date(),
): Promise<void> {
  if (rule.actionType === "webhook") {
    await fireWebhookAction(db, project, null, rule, null, null, now);
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
      now,
    );
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(db, project.id, rule.id, { status: "failed", error: WHATSAPP_NOT_CONNECTED_ERROR }, rule.actionType, null, now);
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
    now,
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
 */
export function hasTooManyConsecutiveFailuresToday(db: ForgeDatabase, rule: AutomationRule, now: Date): boolean {
  const todayUtc = now.toISOString().slice(0, 10);
  const runs = listAutomationRuns(db, rule.projectId, rule.id, 2 * AUTOMATION_RUNS_RETENTION_LIMIT)
    .filter((run) => run.error !== WHATSAPP_NOT_CONNECTED_ERROR)
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
  now: Date = new Date(),
): Promise<void> {
  const rules = listEnabledScheduledRules(db);
  for (const rule of rules) {
    if (!isScheduledRuleDue(rule, now)) continue;
    if (hasTooManyConsecutiveFailuresToday(db, rule, now)) continue;
    const project = getProject(db, rule.projectId);
    if (!project) continue;
    try {
      await fireScheduledRule(db, whatsapp, project, rule, now);
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
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    void runScheduledAutomationsCheck(db, whatsapp);
  }, intervalMs);
  return () => clearInterval(timer);
}
