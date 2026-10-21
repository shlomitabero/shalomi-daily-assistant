import { isIP } from "node:net";
import type { Entity, EntityRecord, Project } from "@forge/shared";
import {
  getProject,
  getRecord,
  insertWhatsAppMessage,
  listEnabledAutomationRulesForEntity,
  listEnabledScheduledRules,
  recordAutomationRun,
  type AutomationRule,
  type ForgeDatabase,
} from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { recordDisplayLabel } from "./displayField.js";
import { findMatchingRecord } from "./whatsapp.js";
import type { WhatsAppWebManager } from "./whatsappWeb.js";

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
 * update. "field_equals" only fires on an update when the matching field
 * was actually part of this update's own payload (changedFields) -- not
 * merely whenever its current value happens to equal the target value --
 * so a rule for status="Delivered" fires once, the moment status is set
 * to "Delivered", not again on every later unrelated edit to that same
 * already-delivered record.
 */
export function matchesTrigger(
  rule: AutomationRule,
  event: "created" | "updated",
  record: EntityRecord,
  changedFields: Set<string>,
): boolean {
  if (rule.trigger === "record_created") {
    return event === "created";
  }
  if (!rule.fieldName) return false;
  if (event === "updated" && !changedFields.has(rule.fieldName)) return false;
  const actual = record[rule.fieldName];
  if (actual === null || actual === undefined) return false;
  return String(actual) === rule.fieldValue;
}

/**
 * Evaluates every enabled automation rule for one entity against a single
 * record create/update, and fires any that match. Deliberately not meant
 * to be awaited inline on the record create/update route's own hot path
 * (see routes/projects.ts's own comment at the call site) -- a WhatsApp
 * send is a real network round-trip, and this side effect must never add
 * latency to, or fail, the record-save response the user is actually
 * waiting on. Every failure mode below (no destination number, not
 * connected, send error, project deleted mid-flight) is caught and
 * recorded on the rule itself via recordAutomationRun, never thrown --
 * this function itself never rejects.
 */
export async function runAutomationsForRecordChange(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  project: Project,
  entity: Entity,
  event: "created" | "updated",
  record: EntityRecord,
  changedFields: Set<string>,
): Promise<void> {
  const rules = listEnabledAutomationRulesForEntity(db, project.id, entity.name);
  for (const rule of rules) {
    if (!matchesTrigger(rule, event, record, changedFields)) continue;
    try {
      await fireRule(db, whatsapp, project, entity, rule, record);
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
// IP-string check, not full SSRF-proofing (no DNS-rebinding protection, no
// redirect-following check on the response) -- raising the bar against the
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
const BLOCKED_IPV4_HOSTNAME_PATTERNS = [/^127\./, /^0\.0\.0\.0$/, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./];

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
 */
function extractIPv4MappedAddress(hostname: string): string | null {
  const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const match = /^::ffff:(.+)$/.exec(stripped);
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
 * WhatsApp path already does for the identical reason. A 10s timeout keeps a
 * slow/hanging destination from blocking this automation (and, since this
 * is fire-and-forget background work either way, from leaking an open
 * connection) indefinitely.
 */
async function fireWebhookAction(
  db: ForgeDatabase,
  project: Project,
  entity: Entity | null,
  rule: AutomationRule,
  record: EntityRecord | null,
): Promise<void> {
  if (!rule.webhookUrl || !isAllowedWebhookUrl(rule.webhookUrl)) {
    recordAutomationRun(db, project.id, rule.id, {
      status: "failed",
      error: "This rule has no valid webhook URL configured",
    });
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
    record: record ?? null,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(rule.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    recordAutomationRun(db, project.id, rule.id, {
      status: res.ok ? "sent" : "failed",
      error: res.ok ? null : `Webhook responded with status ${res.status}`,
    });
  } catch (err) {
    recordAutomationRun(db, project.id, rule.id, {
      status: "failed",
      error: err instanceof Error ? err.message : "Webhook request failed",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fireRule(
  db: ForgeDatabase,
  whatsapp: WhatsAppWebManager,
  project: Project,
  entity: Entity,
  rule: AutomationRule,
  record: EntityRecord,
): Promise<void> {
  if (rule.actionType === "webhook") {
    await fireWebhookAction(db, project, entity, rule, record);
    return;
  }
  const to = rule.toMode === "static" ? rule.toNumber : rule.toField ? record[rule.toField] : null;
  if (!to || typeof to !== "string" || !to.trim()) {
    recordAutomationRun(db, project.id, rule.id, {
      status: "failed",
      error: "This record has no value in the configured phone-number field",
    });
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(db, project.id, rule.id, { status: "failed", error: "WhatsApp is not connected" });
    return;
  }
  const templateRecord = resolveRelationFieldsForTemplate(db, project.id, entity, project.spec.entities, record);
  const lang: Lang = isHebrewText(project.description) ? "he" : "en";
  const message = interpolateTemplate(rule.messageTemplate, entity, templateRecord, lang);
  const result = await whatsapp.sendMessage(project.id, to, message);
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
  recordAutomationRun(db, project.id, rule.id, {
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : (result.error ?? "Send failed"),
  });
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
 * not-due until the UTC date rolls over, however many ticks happen in
 * between.
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
  const todayUtc = now.toISOString().slice(0, 10);
  if (rule.lastTriggeredAt && rule.lastTriggeredAt.slice(0, 10) === todayUtc && rule.lastStatus === "sent") return false;
  if (rule.scheduleDaysOfWeek) {
    const days = rule.scheduleDaysOfWeek.split(",").map(Number);
    if (!days.includes(now.getUTCDay())) return false;
  }
  const currentHHMM = now.toISOString().slice(11, 16);
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
): Promise<void> {
  if (rule.actionType === "webhook") {
    await fireWebhookAction(db, project, null, rule, null);
    return;
  }
  const to = rule.toNumber;
  if (!to || !to.trim()) {
    recordAutomationRun(db, project.id, rule.id, {
      status: "failed",
      error: "This rule has no destination phone number configured",
    });
    return;
  }
  const status = whatsapp.getStatus(project.id);
  if (status.status !== "connected") {
    recordAutomationRun(db, project.id, rule.id, { status: "failed", error: "WhatsApp is not connected" });
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
  recordAutomationRun(db, project.id, rule.id, {
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : (result.error ?? "Send failed"),
  });
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
    const project = getProject(db, rule.projectId);
    if (!project) continue;
    try {
      await fireScheduledRule(db, whatsapp, project, rule);
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
