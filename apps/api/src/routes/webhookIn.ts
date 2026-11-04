import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ForgeDatabase } from "@forge/db";
import { getInboundWebhookToken, insertRecord, isValidDateString, listRecords, recordInboundWebhookDelivery, recordInboundWebhookFailure } from "@forge/db";
import { ProductSpecSchema, type Entity, type Project } from "@forge/shared";
import type { WhatsAppWebManager } from "../whatsappWeb.js";
import type { EmailSender } from "../email.js";
import { runAutomationsForRecordChange } from "../automations.js";
import { createRateLimiter } from "../auth/rateLimit.js";
import { withIdempotency } from "../idempotency.js";
import { HttpError } from "../httpError.js";
import { recordDisplayLabel } from "../displayField.js";

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
 */
const WEBHOOK_BOOLEAN_TRUE_VALUES = ["true", "1", "yes", "כן"];
const WEBHOOK_BOOLEAN_FALSE_VALUES = ["false", "0", "no", "לא"];
const WEBHOOK_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const WEBHOOK_NUMBER_FORMATTING = /[,$€£₪\s]/g;

function normalizeBodyValues(db: ForgeDatabase, projectId: string, allEntities: Entity[], entity: Entity, body: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };
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
      if (!Number.isFinite(Number(value))) {
        const targetEntity =
          allEntities.find((e) => e.name === field.relationTo) ?? allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase());
        if (targetEntity) {
          const match = listRecords(db, projectId, targetEntity).find((r) => recordDisplayLabel(targetEntity, r).toLowerCase() === value.toLowerCase());
          if (match) normalized[field.name] = String(match.id);
        }
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
        const cleaned = value.replace(WEBHOOK_NUMBER_FORMATTING, "");
        if (cleaned !== "" && Number.isFinite(Number(cleaned))) normalized[field.name] = cleaned;
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
      const stored = getInboundWebhookToken(db, projectId);
      if (!stored || !provided || !tokenMatches(provided, stored)) {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      const row = db.prepare("SELECT id, ownerId, name, description, spec_json, status, createdAt FROM projects WHERE id = ?").get(projectId) as
        | { id: string; ownerId: string; name: string; description: string; spec_json: string; status: string; createdAt: string }
        | undefined;
      if (!row) {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      // Mirrors routes/calendar.ts's own round-1185 reasoning: a stored
      // spec that no longer parses against today's (only ever stricter)
      // schema is a real, expected case for an older project -- treated
      // the same as "not found" here rather than calling packages/db's
      // own getProject (whose strict ProductSpecSchema.parse would throw
      // instead), so this public route degrades the same way the other
      // one does instead of 500ing.
      const parsed = ProductSpecSchema.safeParse(JSON.parse(row.spec_json));
      if (!parsed.success || row.status !== "built") {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      const entity = parsed.data.entities.find((e) => e.name === entityName) ?? parsed.data.entities.find((e) => e.name.toLowerCase() === entityName.toLowerCase());
      if (!entity) {
        res.status(404).json({ error: "Webhook not found", code: "WEBHOOK_IN_NOT_FOUND" });
        return;
      }
      const project: Project = {
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        description: row.description,
        spec: parsed.data,
        status: row.status as Project["status"],
        createdAt: row.createdAt,
      };
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
              normalizeBodyValues(db, projectId, parsed.data.entities, entity, normalizeBodyKeys(entity, req.body ?? {})),
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

  return router;
}
