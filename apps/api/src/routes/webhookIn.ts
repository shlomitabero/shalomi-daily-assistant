import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ForgeDatabase } from "@forge/db";
import { getInboundWebhookToken, insertRecord, recordInboundWebhookDelivery } from "@forge/db";
import { ProductSpecSchema, type Project } from "@forge/shared";
import type { WhatsAppWebManager } from "../whatsappWeb.js";
import type { EmailSender } from "../email.js";
import { runAutomationsForRecordChange } from "../automations.js";
import { createRateLimiter } from "../auth/rateLimit.js";
import { withIdempotency } from "../idempotency.js";
import { HttpError } from "../httpError.js";

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
            record = insertRecord(db, projectId, entity, req.body ?? {});
          } catch (err) {
            if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
              throw new HttpError(400, "This record references another record that doesn't exist", "INVALID_RELATION_TARGET");
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
          );
          return { status: 201, body: { id: record.id } };
        },
      );
      res.status(status).json(body);
    }),
  );

  return router;
}
