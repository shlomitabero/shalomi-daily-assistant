import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ForgeDatabase } from "@forge/db";
import { deleteRecord, getInboundWebhookToken, getRecord, insertRecord, insertRecordDeletion, isValidDateString, listRecords, recordInboundWebhookDelivery, recordInboundWebhookFailure, updateRecord } from "@forge/db";
import { isHebrewText } from "@forge/spec-engine";
import { ProductSpecSchema, type Entity, type Project } from "@forge/shared";
import type { WhatsAppWebManager } from "../whatsappWeb.js";
import type { EmailSender } from "../email.js";
import { runAutomationsForRecordChange } from "../automations.js";
import { createRateLimiter } from "../auth/rateLimit.js";
import { withIdempotency } from "../idempotency.js";
import { HttpError } from "../httpError.js";
import { recordDisplayLabel } from "../displayField.js";
import { computeChangedFields, deleteReplacedFileFields, parseRecordId } from "./projects.js";

/**
 * Round 1607: shared by both the create route below and its new sibling
 * update route -- previously inlined once, duplicated here only because a
 * second route now needs the exact same "resolve project+entity from a
 * token" lookup. Behavior-preserving extraction: every branch that used to
 * write its own `res.status(404)...` now just returns null, and both
 * callers translate that the same way the original single route did.
 */
function resolveWebhookTarget(db: ForgeDatabase, projectId: string, entityName: string, token: string): { project: Project; entity: Entity } | null {
  const stored = getInboundWebhookToken(db, projectId);
  if (!stored || !token || !tokenMatches(token, stored)) return null;
  const row = db.prepare("SELECT id, ownerId, name, description, spec_json, status, createdAt FROM projects WHERE id = ?").get(projectId) as
    | { id: string; ownerId: string; name: string; description: string; spec_json: string; status: string; createdAt: string }
    | undefined;
  if (!row) return null;
  // Mirrors routes/calendar.ts's own round-1185 reasoning: a stored spec
  // that no longer parses against today's (only ever stricter) schema is a
  // real, expected case for an older project -- treated the same as "not
  // found" here rather than calling packages/db's own getProject (whose
  // strict ProductSpecSchema.parse would throw instead), so this public
  // route degrades the same way the other one does instead of 500ing.
  const parsed = ProductSpecSchema.safeParse(JSON.parse(row.spec_json));
  if (!parsed.success || row.status !== "built") return null;
  const entity = parsed.data.entities.find((e) => e.name === entityName) ?? parsed.data.entities.find((e) => e.name.toLowerCase() === entityName.toLowerCase());
  if (!entity) return null;
  const project: Project = {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    spec: parsed.data,
    status: row.status as Project["status"],
    createdAt: row.createdAt,
  };
  return { project, entity };
}

function tokenMatches(provided: string, stored: string): boolean {
  const providedBuf = Buffer.from(provided, "utf8");
  const storedBuf = Buffer.from(stored, "utf8");
  if (providedBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(providedBuf, storedBuf);
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/**
 * Round 1511: this route's entity-name lookup two lines below already
 * falls back to a case-insensitive match, because an external sender
 * (Stripe, Typeform, a website's own form handler -- this file's own
 * top-of-file comment) can't be trusted to match this app's exact
 * casing. The same reasoning was never extended to FIELD names inside
 * the body itself: insertRecord/coerceValue (packages/db/src/repository.ts)
 * look up `data[field.name]` with an exact-case key and no fallback, so a
 * real integrator who configures a webhook payload template by hand and
 * types e.g. "Name" where this entity's field is actually "name" either
 * gets a 400 "Field is required" (a required field) or silently has that
 * value discarded as null (an optional field) -- even though a value was
 * genuinely sent, just under different letter case. EntitySchema's own
 * `.refine` already guarantees no two fields on one entity collide
 * case-insensitively, so this remap can never be ambiguous. Deliberately
 * scoped to this route rather than insertRecord/coerceValue themselves --
 * every other caller (the authenticated create route, CSV import) already
 * builds its body from entity.fields' own exact casing and must not change
 * behavior.
 */
function normalizeBodyKeys(entity: Entity, body: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(body)) {
    if (entity.fields.some((f) => f.name === key)) continue;
    const match = entity.fields.find((f) => f.name.toLowerCase() === key.toLowerCase());
    if (match && !(match.name in normalized)) {
      normalized[match.name] = value;
    }
  }
  return normalized;
}

/**
 * Round 1512: normalizeBodyKeys just above only remaps the body's own
 * KEYS to each field's real casing -- the VALUES it carries flow straight
 * into insertRecord untouched. coerceValue's own enum branch
 * (packages/db/src/repository.ts) is an exact-case Array.includes check
 * with no fallback, so an external sender who submits e.g.
 * {"status": "new"} against an enumValues list of ["New", "Contacted",
 * "Won"] gets the identical "a value was genuinely sent, just under
 * different letter case" rejection round 1511 already fixed for field
 * names -- even though the exact same reasoning, and a ready-made
 * precedent, already exists for CSV import's own case-insensitive
 * raw-value match (apps/web/src/entityFormatting.ts). Mirrors that
 * precedent's own unguarded `.find()` (first case-insensitive match
 * wins) rather than adding new ambiguity-rejection behavior this
 * codebase doesn't already apply to raw enum values elsewhere.
 * Deliberately scoped to this route and to enum values only, the same
 * "must not change behavior for every other caller" boundary
 * normalizeBodyKeys' own doc comment draws.
 *
 * Round 1513: extends the same reasoning to boolean fields. coerceValue's
 * boolean branch (repository.ts) accepts only the exact strings
 * "true"/"false" (plus 1/0/"1"/"0") -- "True", "FALSE", "TRUE" all throw
 * the identical "a value was genuinely sent, just under different letter
 * case" rejection this file already fixed for field names and enum
 * values.
 *
 * Round 1514: round 1513 itself (and round 1512 before it) explicitly
 * flagged and deferred the CSV-import precedent's broader value *shape*
 * acceptance -- entityFormatting.ts's BOOLEAN_TRUE_VALUES/
 * BOOLEAN_FALSE_VALUES already treats "yes"/"no"/"כן"/"לא" as valid
 * booleans, not just case variants of "true"/"false". A real integrator
 * mapping a yes/no checkbox field to "Yes"/"No" -- a completely natural
 * webhook payload shape -- got the exact same unjustified 400 rejection.
 * Duplicated the two word lists locally rather than cross-importing
 * apps/web into apps/api, mirroring this file's own established
 * "mirror, don't cross-import" convention for every other helper here.
 *
 * Round 1551: extends the same reasoning to date fields -- the one
 * coercible field type rounds 1511-1514 never reached. coerceValue's own
 * date branch (packages/db/src/repository.ts) is isValidDateString's
 * strict `^\d{4}-\d{2}-\d{2}$` regex with zero tolerance for anything
 * else, so an ISO-8601 timestamp with a time component (e.g.
 * "2024-01-15T00:00:00Z") -- the single most common real-world shape a
 * third-party integrator, or even this app's own `Date.prototype.toISOString()`,
 * would send for a date -- gets the identical "a value was genuinely
 * sent, just not in the exact shape this route expected" rejection
 * already closed for field names, enum values/labels, and boolean
 * casing/shape. Unlike those siblings, a bad date value throws for the
 * WHOLE record regardless of field.required (coerceValue's date branch
 * isn't gated by it), so this one is worse: the record is rejected
 * outright, not just one field silently nulled.
 *
 * Round 1553: extends the same reasoning to number fields -- the last
 * remaining coercible field type. coerceValue's own number/relation
 * branch (packages/db/src/repository.ts) is a bare `Number(raw)` plus
 * `Number.isFinite`, with zero tolerance for anything but a plain numeric
 * string, and -- like the date branch above -- throws for the WHOLE
 * record regardless of field.required. A webhook body carrying ordinary
 * currency/thousands-separator formatting for an amount field (e.g.
 * `"$1,234.56"` or `"1,200"`, exactly what a real integrator's own form
 * or payment-provider payload plausibly sends) fails `Number.isFinite`
 * outright. Strips thousands-separator commas, common currency symbols,
 * and surrounding whitespace before retrying; only overwrites the value
 * when the cleaned string actually parses, so a genuinely non-numeric
 * value still falls through unchanged and is correctly rejected by
 * coerceValue as before. Deliberately scoped to `number` only, not the
 * sibling `relation` type that shares coerceValue's own branch -- a
 * foreign-key id has no realistic currency-formatted shape to be lenient
 * about, unlike an amount field.
 *
 * Round 1584: extends the same reasoning to relation fields after all --
 * round 1553's own scoping-out only ruled out being lenient about a raw
 * foreign-key id's own formatting (there's no realistic currency-style
 * shape for an id to be lenient about), but never considered the
 * identical case-insensitive-match problem CSV import already solves for
 * relation columns: a real external integrator has no API to discover
 * this app's internal numeric record ids at all, so the only identifier
 * they could plausibly send for e.g. an Order's `customer` relation field
 * is the related record's own human name/label (`{"customer": "Acme
 * Corp"}`) -- exactly the shape CSV import's own buildImportRecords
 * (apps/web/src/entityFormatting.ts) already resolves via
 * recordDisplayLabel, case-insensitively. Without this, that payload hits
 * coerceValue's bare `Number(raw)` relation branch (repository.ts, shared
 * with the number branch above) and throws for the WHOLE record --
 * the exact same severity round 1551/1553 already flagged for date/number.
 * Resolves via this project's own target entity + its records, matching
 * recordDisplayLabel case-insensitively; mirrors this file's own
 * established first-case-insensitive-match-wins convention (round 1512's
 * doc comment) rather than importing CSV import's stricter ambiguity-
 * rejection. A value that already parses as a number, or matches no
 * record, falls through unchanged to today's existing behavior.
 *
 * Round 1644: that "already parses as a number" short-circuit, above, was
 * itself wrong -- it skipped the label lookup entirely for any
 * numeric-looking value, silently treating it as this app's own internal
 * record id instead. A huge fraction of real-world display labels are
 * themselves numeric-looking (a membership number, invoice number, room
 * number, SKU), and buildImportRecords' own sibling resolution
 * (entityFormatting.ts, quoted in its own doc comment there) never makes
 * that mistake: a label match always wins first there, and a bare number
 * is never treated as an id at all -- only the literal "#<digits>"
 * shorthand is, and only as the last resort when no label matches. Without
 * this, a webhook payload referencing a Customer by a numeric membership
 * code (e.g. `{"customer": "2024"}`) that happens to collide with a
 * *different* Customer record's real internal id of 2024 silently attaches
 * the new record to the wrong customer -- a silent cross-record data
 * corruption, not just a rejected request. Now the label lookup always
 * runs first, matching this route's own existing case-insensitive
 * precedent (round 1512); only when no record's label matches does the
 * raw value fall through to be treated as a literal id, same as before.
 */
const WEBHOOK_BOOLEAN_TRUE_VALUES = ["true", "1", "yes", "כן"];
const WEBHOOK_BOOLEAN_FALSE_VALUES = ["false", "0", "no", "לא"];
const WEBHOOK_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const WEBHOOK_NUMBER_FORMATTING = /[,$€£₪\s]/g;
// Round 1627: accounting-style negatives wrap the whole number in
// parentheses instead of a leading "-" (e.g. "($1,234.56)" for -1234.56) --
// the shape QuickBooks/Xero/many payment-provider exports use for a refund
// or chargeback line. WEBHOOK_NUMBER_FORMATTING already strips the currency
// symbol/comma/whitespace inside, but the parens themselves aren't in that
// character class, so `Number("(1234.56)")` is still NaN and the whole
// record gets hard-rejected -- the same "a real value was sent, just not in
// the exact shape this route expected" gap the currency/thousands-separator
// leniency above (round 1584-era) already closed for the positive case.
const WEBHOOK_PARENTHESIZED_NEGATIVE = /^\((.*)\)$/;

function normalizeBodyValues(
  db: ForgeDatabase,
  projectId: string,
  allEntities: Entity[],
  entity: Entity,
  body: Record<string, unknown>,
  lang: "he" | "en",
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };
  // Round 1796: two or more relation fields on the same entity can share
  // the identical target entity (e.g. Order.accountManager and
  // Order.backupManager both -> Employee) -- without this, each one
  // independently re-ran listRecords + a full recordDisplayLabel pass over
  // every target record, turning one webhook POST's cost into O(fields x
  // records) instead of O(distinct target entities x records). Keyed by
  // target entity name, built lazily the first time a given target is
  // actually needed; mirrors backup.ts's own recordIndexByEntity, built
  // once per export for the identical reason (there eagerly, since backup
  // always visits every entity anyway; here lazily, since a single
  // webhook body only ever touches the handful of entities its own
  // relation fields target).
  const recordsByTargetEntity = new Map<string, ReturnType<typeof listRecords>>();
  for (const field of entity.fields) {
    const raw = normalized[field.name];
    if (typeof raw !== "string") continue;
    // Round 1598: every comparison below (relation label match, date regex,
    // enum/label match, boolean word list) is an exact or anchored match
    // against `value`, none of which tolerate incidental leading/trailing
    // whitespace (coerceValue, packages/db/src/repository.ts, doesn't
    // either) -- an entirely plausible shape for a real external sender
    // (Zapier/Make field mapping, a hand-built HTML form). Trimmed once
    // here and written back unconditionally (not just when a deeper match
    // below also fires), so a value that's ALREADY valid once trimmed --
    // e.g. enum raw `"New "` when `"New"` is already a valid enumValue --
    // still gets its whitespace stripped before reaching coerceValue,
    // which would otherwise reject it on an exact-includes check of its
    // own. The `number` branch already tolerated this as a side effect of
    // its own formatting regex also stripping `\s`; this makes it uniform
    // across relation/date/enum/boolean instead of accidental for one type.
    const value = raw.trim();
    if (field.type === "relation" && field.relationTo) {
      normalized[field.name] = value;
      const targetEntity =
        allEntities.find((e) => e.name === field.relationTo) ?? allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase());
      // `lang` matters here specifically when the target entity's own
      // display field (pickDisplayField, displayField.ts) falls back to a
      // `date` field (no name/title/text field to prefer) -- recordDisplayLabel
      // formats dates with toLocaleDateString, and en/he produce different
      // strings for the same date. Every other recordDisplayLabel call in
      // this file (and automations.ts/backup.ts/twin.ts/whatsapp.ts) already
      // passes the project's real language; this call used to silently
      // default to "en", so a Hebrew project's own he-IL-formatted label
      // (the one shown everywhere else) would never match here.
      if (targetEntity) {
        if (!recordsByTargetEntity.has(targetEntity.name)) {
          recordsByTargetEntity.set(targetEntity.name, listRecords(db, projectId, targetEntity));
        }
        // Round 1804: unlike the enum branch below (which deliberately keeps
        // first-match-wins for two enum values sharing a label -- see round
        // 1541's own comment), a relation label collision is a real,
        // realistic data-integrity risk: two records sharing the same
        // display label (e.g. two customers both named "John Smith") is
        // common, and silently binding to whichever happens to come first
        // in listRecords' own result order writes a WRONG foreign key with
        // no indication anything was ambiguous. Mirrors CSV import's own
        // precedent for this exact shape (entityFormatting.ts's
        // buildImportRecords, round 1162's doc comment there): resolve only
        // on an unambiguous single match; on zero OR multiple matches,
        // leave the raw label in place so coerceValue's existing relation
        // branch (packages/db/src/repository.ts) rejects it with its own
        // ValidationError, exactly as a genuinely unmatched label already
        // does today -- never guess.
        const matches = recordsByTargetEntity
          .get(targetEntity.name)!
          .filter((r) => recordDisplayLabel(targetEntity, r, lang).toLowerCase() === value.toLowerCase());
        if (matches.length === 1) normalized[field.name] = String(matches[0].id);
      }
    } else if (field.type === "date") {
      normalized[field.name] = value;
      if (!isValidDateString(value)) {
        const match = WEBHOOK_DATE_PREFIX.exec(value);
        if (match && isValidDateString(match[0])) normalized[field.name] = match[0];
      }
    } else if (field.type === "number") {
      normalized[field.name] = value;
      if (!Number.isFinite(Number(value))) {
        const parenMatch = WEBHOOK_PARENTHESIZED_NEGATIVE.exec(value);
        const unwrapped = parenMatch ? `-${parenMatch[1]}` : value;
        const cleaned = unwrapped.replace(WEBHOOK_NUMBER_FORMATTING, "");
        if (cleaned !== "" && cleaned !== "-" && Number.isFinite(Number(cleaned))) normalized[field.name] = cleaned;
      }
    } else if (field.type === "enum" && field.enumValues) {
      normalized[field.name] = value;
      if (!field.enumValues.includes(value)) {
        const match =
          field.enumValues.find((v) => v.toLowerCase() === value.toLowerCase()) ??
          // Round 1541: the raw-value match above only ever matches the
          // field's internal/stored values, never its own enumLabels --
          // the human-readable text actually shown in this project's live
          // picker UI. An external integrator who only ever sees the
          // displayed label (e.g. a Hebrew refine's "חדש" for the stored
          // value "New") naturally configures their webhook body with that
          // same text, the identical "a real value was sent, just not in
          // the exact shape this route expected" gap rounds 1511-1514
          // already closed for field-name/boolean casing and shape. Mirrors
          // CSV import's own label-match precedent (entityFormatting.ts,
          // round 1084), but -- like round 1512's own raw-value match right
          // above -- deliberately keeps this route's simpler first-match-
          // wins behavior rather than adding CSV import's ambiguity-
          // rejection for two values sharing an identical label.
          field.enumValues.find((v) => (field.enumLabels?.[v] ?? v).toLowerCase() === value.toLowerCase());
        if (match) normalized[field.name] = match;
      }
    } else if (field.type === "boolean") {
      normalized[field.name] = value;
      if (value !== "true" && value !== "false") {
        const lower = value.toLowerCase();
        if (WEBHOOK_BOOLEAN_TRUE_VALUES.includes(lower)) normalized[field.name] = "true";
        else if (WEBHOOK_BOOLEAN_FALSE_VALUES.includes(lower)) normalized[field.name] = "false";
      }
    } else if (field.type === "file") {
      // Round 1746: unlike every other coercible type above, there is no
      // "real value sent, just not in the exact shape expected" leniency
      // possible here -- coerceValue's own file branch (repository.ts)
      // only ever accepts this server's own internal upload-descriptor
      // JSON, whose shape (an exact /api/uploads/<projectId>/<entityName>/
      // <uuid> path this server generated at upload time) no external
      // sender could ever construct. An external integrator sending a
      // perfectly reasonable plain URL for a field that happens to be
      // typed `file` in this project (a receipt link, an uploaded form
      // attachment) 100%-reproducibly hit coerceValue's "must be a valid
      // file descriptor" ValidationError, which -- same as every other
      // field's own coercion failure -- aborted the WHOLE insertRecord/
      // updateRecord call, hard-rejecting the entire record (every other,
      // perfectly valid field included) over one field this route could
      // never have accepted regardless of shape. Dropping the KEY (not
      // just blanking the value) degrades this the same way an unmapped
      // field already does elsewhere in this codebase: coerceValue's own
      // isEmpty path either throws a clear "is required" error (if the
      // field is required -- itself more useful signal than today's
      // confusing descriptor message) or stores null, letting the rest of
      // the record still get created.
      //
      // An already-empty value (`""`/whitespace-only -- coerceValue's own
      // isEmpty definition) must NOT be dropped this way, though: deleting
      // the key makes updateRecord's own `hasOwnProperty.call(data, ...)`
      // check (repository.ts) see this field as never having been
      // mentioned at all, so an explicit "clear this field" update
      // (sending `receipt: ""` to wipe a previously-uploaded file) would
      // silently leave the OLD stored descriptor -- and its on-disk file
      // -- untouched instead of clearing it, exactly the partial-update
      // semantics that same hasOwnProperty check exists to preserve for
      // every field a caller legitimately doesn't mention. An empty value
      // already degrades correctly on its own via that same isEmpty path
      // without this branch's help, so only a genuinely non-empty,
      // un-droppable value needs dropping here.
      if (value !== "") delete normalized[field.name];
    }
  }
  return normalized;
}

/**
 * Round 1405: every automation trigger before this one (record_created,
 * field_equals, record_updated, record_deleted, schedule) only ever fires
 * from something that happens INSIDE this app. There was no way for an
 * external event -- a Stripe payment, a Typeform or website form
 * submission -- to create a record here at all, short of a human
 * re-typing the data in or a one-off CSV import. Outbound webhooks
 * (automation_rules' own webhookUrl/webhookSecret, round 974) are fully
 * built, with no inbound counterpart.
 *
 * Deliberately a SEPARATE router, mounted in app.ts before
 * createAuthRouter/createProjectsRouter, mirroring createCalendarFeedRouter's
 * own placement and reasoning exactly: an external webhook sender (Stripe,
 * Typeform, a website's own form handler) has no session cookie and can't
 * be made to attach an Authorization header, so this can never go through
 * requireAuth the way every other project-scoped route does. The token
 * itself -- see getOrCreateInboundWebhookToken's own doc comment -- IS the
 * whole authentication.
 *
 * Builds the body's fields straight into a new record via the exact same
 * insertRecord + runAutomationsForRecordChange pair the normal
 * `POST /projects/:id/entities/:entityName` route uses, so a record
 * created this way is indistinguishable from one created through the live
 * app -- the same field coercion/validation, the same required-field
 * enforcement (coerceValue's own ValidationError), and the same
 * record_created automation fan-out (which can itself chain into a
 * WhatsApp/email/outbound-webhook send, or another record elsewhere).
 *
 * 404s uniformly for "project doesn't exist", "entity doesn't exist", "no
 * token generated yet", and "token mismatch" -- mirroring the calendar
 * feed route's own identical convention, so this can't be used as an
 * oracle to enumerate real project ids or entity names.
 */
export function createInboundWebhookRouter(db: ForgeDatabase, whatsapp: WhatsAppWebManager, emailSender: EmailSender, uploadsDir: string): Router {
  const router = Router();

  /**
   * Keyed by project+token together (the actual resource being hit), not
   * just the project id alone, mirroring calendarFeedRateLimiter's own
   * reasoning exactly: a wrong guess against one project's token can't
   * exhaust a real integration's own budget for that same project. This
   * route has no req.userId to key by in the first place -- it can never
   * go through requireAuth (see this router's own doc comment above) --
   * so without this, anyone who was ever handed (or who correctly
   * guesses) this URL could script a tight loop directly against it,
   * each call doing a real insertRecord write plus firing every matching
   * automation rule (a real WhatsApp/email/webhook send). A real
   * third-party webhook sender (Stripe, Typeform) fires once per genuine
   * external event, nowhere close to this budget.
   */
  const webhookInRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => `${req.params.projectId}:${typeof req.query.token === "string" ? req.query.token : ""}`,
    message: "Too many webhook requests. Please try again later.",
  });

  router.post(
    "/public/webhook-in/:projectId/:entityName",
    webhookInRateLimiter,
    asyncRoute(async (req, res) => {
      const { projectId, entityName } = req.params;
      const provided = typeof req.query.token === "string" ? req.query.token : "";
      const target = resolveWebhookTarget(db, projectId, entityName, provided);
      if (!target) {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      const { project, entity } = target;
      // Round 1418: a real third-party sender (Stripe, Typeform, a generic
      // form-posting service) retries a delivery on any non-2xx response or
      // timeout -- that's normal, documented behavior, not an edge case --
      // and until now this route had no dedup of any kind, unlike every
      // other mutating route in the app (see withIdempotency's own doc
      // comment). A retried delivery re-ran insertRecord (a real duplicate
      // row) and re-fired runAutomationsForRecordChange (a real duplicate
      // WhatsApp/email/webhook send to an actual recipient). This route has
      // no req.userId (it's deliberately pre-auth, token-based -- see this
      // file's own top-of-file comment), so it can't call withIdempotency
      // the way every authenticated route does; idempotency_keys' own
      // "userId" column is just a plain TEXT scoping field with no FK, so
      // projectId is passed in that slot instead, with the route string
      // already carrying projectId+entityName too (matching round 528's own
      // per-resource-interpolation convention) -- an external sender that
      // supports idempotency keys (Stripe's own outbound retries resend the
      // identical event body, so a key derived from it would work too, but
      // this route can't assume any particular body shape) can opt in via
      // the same X-Idempotency-Key header every authenticated route already
      // recognizes; a sender that doesn't send one gets today's unguarded
      // behavior unchanged, per withIdempotency's own deliberate opt-in design.
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        projectId,
        `POST /public/webhook-in/${projectId}/${entityName}`,
        async () => {
          let record: ReturnType<typeof insertRecord>;
          try {
            record = insertRecord(
              db,
              projectId,
              entity,
              normalizeBodyValues(
                db,
                projectId,
                project.spec.entities,
                entity,
                normalizeBodyKeys(entity, req.body ?? {}),
                isHebrewText(project.description) ? "he" : "en",
              ),
            );
          } catch (err) {
            // Round 1471: see recordInboundWebhookFailure's own doc comment
            // (packages/db) for why this is recorded here specifically --
            // the sender presented a valid token and hit a real entity, so
            // unlike the 404 branches above, this really is "a configured
            // integration whose payload needs fixing," the case the
            // project owner can actually act on.
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              const reason = "This record references another record that doesn't exist";
              recordInboundWebhookFailure(db, projectId, reason);
              throw new HttpError(400, reason, "INVALID_RELATION_TARGET");
            }
            if (err instanceof Error) {
              recordInboundWebhookFailure(db, projectId, err.message);
            }
            throw err;
          }
          // Round 1456: see recordInboundWebhookDelivery's own doc comment --
          // placed inside this callback (never on a replayed delivery, which
          // skips the callback entirely, same reasoning withIdempotency's own
          // comment above already gives for not re-firing the automation
          // below), so only a genuinely new delivery ever updates it.
          recordInboundWebhookDelivery(db, projectId);
          // Not awaited -- see runAutomationsForRecordChange's own comment on
          // the normal record-create route this mirrors: a WhatsApp/email/
          // webhook send is a real network round-trip, and the external
          // caller (Stripe, Typeform) is only waiting on an ack that their
          // own event was received, not on anything downstream of it. Firing
          // it from inside this callback (not after withIdempotency returns)
          // means a replayed retry -- which skips the callback entirely --
          // never re-fires it either.
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
            // Round 1470: lets a rule target "inbound_webhook" specifically,
            // distinct from the blanket "record_created" every other
            // creation path (the authenticated route, CSV import) still
            // reports as "app".
            "inbound_webhook",
          );
          return { status: 201, body: { id: record.id } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Round 1607: the create route above (and every write path before it)
   * could only ever INSERT a new row -- there was no way for an external
   * sender to update one it had already created, even though this route's
   * own named integrations (Stripe, Typeform) routinely send a *sequence*
   * of events about the *same* underlying object (checkout.session.created
   * -> charge.succeeded -> charge.refunded for one order). Without this,
   * every follow-up event became an unrelated, duplicate new row, with the
   * original left stuck at its first-seen state forever, and any
   * record_created/inbound_webhook automation (e.g. "notify on new Order")
   * double-fired for what was really one real-world purchase.
   *
   * Addressed the smallest well-contained way: the create route already
   * hands back `{ id: record.id }` (round 1405) -- a caller that stores
   * that id can now POST follow-up updates straight to this sibling route
   * instead of only ever creating a fresh row. Reuses every existing
   * validation/coercion/rate-limit/idempotency/failure-tracking mechanism
   * in this file unchanged (resolveWebhookTarget, normalizeBodyKeys/Values,
   * webhookInRateLimiter, withIdempotency, recordInboundWebhookFailure) --
   * the only new logic is updateRecord instead of insertRecord, and firing
   * the "updated" event (already supported by runAutomationsForRecordChange,
   * used by the authenticated PATCH route) instead of "created".
   */
  router.post(
    "/public/webhook-in/:projectId/:entityName/:recordId",
    webhookInRateLimiter,
    asyncRoute(async (req, res) => {
      const { projectId, entityName } = req.params;
      const provided = typeof req.query.token === "string" ? req.query.token : "";
      const target = resolveWebhookTarget(db, projectId, entityName, provided);
      if (!target) {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      const { project, entity } = target;
      const recordId = parseRecordId(req.params.recordId);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        projectId,
        `POST /public/webhook-in/${projectId}/${entityName}/${recordId}`,
        async () => {
          // Round 1609: moved inside this callback -- withIdempotency
          // short-circuits with the first attempt's own cached response
          // for a genuine replay (same key, status "done") WITHOUT ever
          // calling this callback at all (see its own doc comment, and
          // round 1310's PATCH /auth/password precedent for the same
          // rule). A check placed outside, like this one used to be, runs
          // against CURRENT database state on every call -- including a
          // replay -- so if the referenced record is deleted between a
          // successful first delivery and a sender's retry with the same
          // key (ordinary cleanup, or a chained automation), the retry
          // would 404 "Record not found" for a request that, per the
          // cached idempotency record, already succeeded. Mirrors how
          // routes/projects.ts's own PATCH .../:recordId route already
          // does its own `before = getRecord(...)` lookup inside its
          // withIdempotency callback for the identical reason.
          const before = getRecord(db, projectId, entity, recordId);
          if (!before) {
            throw new HttpError(404, "Record not found", "WEBHOOK_IN_RECORD_NOT_FOUND");
          }
          let record: ReturnType<typeof updateRecord>;
          try {
            record = updateRecord(
              db,
              projectId,
              entity,
              recordId,
              normalizeBodyValues(
                db,
                projectId,
                project.spec.entities,
                entity,
                normalizeBodyKeys(entity, req.body ?? {}),
                isHebrewText(project.description) ? "he" : "en",
              ),
            );
          } catch (err) {
            // Same FOREIGN KEY constraint translation as the create route
            // above -- see its own comment for why this is reachable.
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              const reason = "This record references another record that doesn't exist";
              recordInboundWebhookFailure(db, projectId, reason);
              throw new HttpError(400, reason, "INVALID_RELATION_TARGET");
            }
            if (err instanceof Error) {
              recordInboundWebhookFailure(db, projectId, err.message);
            }
            throw err;
          }
          recordInboundWebhookDelivery(db, projectId);
          // Round 1699: mirrors the authenticated PATCH route's own
          // unchained deleteReplacedFileFields call (routes/projects.ts)
          // exactly -- deleteReplacedFileFields only ever deletes the OLD
          // value of a file field that actually changed, never the new
          // one, so there's no race against the "updated" automation
          // below reading the file off the NEW record (unlike the sibling
          // delete route's own round-1696 fix, which has to chain via
          // `.finally()` because it deletes every file field unconditionally
          // and the "deleted" automation reads the record being removed).
          // Before this round, a webhook-driven update that replaced or
          // cleared a file field (e.g. `{"photo": ""}`) never cleaned up
          // the old uploaded file at all -- the same storage-leak class
          // round 1696 closed for this file's sibling delete route, just
          // never audited for this route too.
          void deleteReplacedFileFields(uploadsDir, projectId, entity, before, record);
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
            "inbound_webhook",
          );
          return { status: 200, body: { id: record.id } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Round 1683: the create and update routes above let an external sender
   * (Stripe, Typeform, a website's own form handler) keep one record in
   * sync across a whole sequence of events about it -- but there was no
   * way to remove one at all, even though these same integrations
   * routinely send deletion-shaped events just as often (a Stripe
   * subscription cancellation, a Typeform response deletion, a website's
   * own "unsubscribe"/"cancel" webhook). A dedicated path segment rather
   * than the real DELETE HTTP verb, consistent with this file's own
   * POST-only convention above (a webhook sender almost always POSTs its
   * event payload regardless of what it represents) and sidestepping any
   * sender/proxy limitation on attaching a body to a DELETE request.
   * Reuses every mechanism already established by this file's own
   * siblings: resolveWebhookTarget, webhookInRateLimiter, withIdempotency,
   * parseRecordId, and the FOREIGN KEY -> 409 translation the authenticated
   * DELETE route (routes/projects.ts) already applies.
   */
  router.post(
    "/public/webhook-in/:projectId/:entityName/:recordId/delete",
    webhookInRateLimiter,
    asyncRoute(async (req, res) => {
      const { projectId, entityName } = req.params;
      const provided = typeof req.query.token === "string" ? req.query.token : "";
      const target = resolveWebhookTarget(db, projectId, entityName, provided);
      if (!target) {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      const { project, entity } = target;
      const recordId = parseRecordId(req.params.recordId);
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status } = await withIdempotency(
        db,
        idempotencyKey,
        projectId,
        `POST /public/webhook-in/${projectId}/${entityName}/${recordId}/delete`,
        async () => {
          // Round 1609's own "check inside the callback" rule, see the
          // update route's identical comment above for why.
          const before = getRecord(db, projectId, entity, recordId);
          if (!before) {
            throw new HttpError(404, "Record not found", "WEBHOOK_IN_RECORD_NOT_FOUND");
          }
          try {
            deleteRecord(db, projectId, entity, recordId);
          } catch (err) {
            // Same FOREIGN KEY constraint translation as the authenticated
            // DELETE route (routes/projects.ts) -- another record still
            // referencing this one through a relation field is just as
            // real a possibility for a webhook-driven delete.
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              const reason = "Cannot delete this record -- another record still references it through a relation field";
              recordInboundWebhookFailure(db, projectId, reason);
              throw new HttpError(409, reason, "RECORD_HAS_DEPENDENT_RECORDS");
            }
            if (err instanceof Error) {
              recordInboundWebhookFailure(db, projectId, err.message);
            }
            throw err;
          }
          recordInboundWebhookDelivery(db, projectId);
          // Round 1632's own convention (routes/projects.ts) -- a deleted
          // row has nowhere left to carry a "who did this" column, so this
          // writes to the same audit log instead. deletedByUserId: null,
          // same as the create/update routes' own lack of req.userId --
          // this route is deliberately pre-auth, token-based.
          insertRecordDeletion(db, {
            projectId,
            entityName: entity.name,
            recordId,
            recordLabel: recordDisplayLabel(entity, before, isHebrewText(project.description) ? "he" : "en"),
            deletedByUserId: null,
          });
          // Round 1696: mirrors the authenticated DELETE route's own
          // round-1015 fix exactly -- deleteReplacedFileFields's own
          // `deleteUploadedFile` does a real `await rm` against the same
          // path a "record_deleted" automation can independently read back
          // off disk (fireEmailAction's own `await readFile`, or
          // whatsappWeb.ts's sendMessage doing the same before handing off
          // to the socket). Before this round, this route's own file
          // cleanup didn't exist at all -- a record with a file-type field
          // deleted through this public, token-authed route (any built
          // entity can have one issued against it) leaked its uploaded
          // file on disk forever, the exact storage-leak class
          // deleteReplacedFileFields exists everywhere else to prevent.
          // Chaining via `.finally()` (never racing an independent call)
          // guarantees the automation's own file read always happens
          // before the unlink, for the same reason round 1015's own
          // comment on the authenticated route gives.
          const automationsRun = runAutomationsForRecordChange(
            db,
            whatsapp,
            emailSender,
            project,
            entity,
            "deleted",
            before,
            new Set(),
            uploadsDir,
            `${req.protocol}://${req.get("host")}`,
            "inbound_webhook",
          );
          void automationsRun.finally(() => deleteReplacedFileFields(uploadsDir, projectId, entity, before, null));
          return { status: 204, body: null };
        },
      );
      res.status(status).end();
    }),
  );

  return router;
}
