import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ForgeDatabase } from "@forge/db";
import { getCalendarFeedToken, listRecords } from "@forge/db";
import { ProductSpecSchema, type Entity, type EntityRecord } from "@forge/shared";
import { isHebrewText } from "@forge/spec-engine";
import { buildCalendarFeedIcs, buildCombinedCalendarFeedIcs, type RelatedRecordsByEntity } from "../calendarFeed.js";
import { createRateLimiter } from "../auth/rateLimit.js";

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
 * Round 1006: the live calendar subscription feed -- a "Subscribe" URL
 * pasted once into Google/Apple Calendar or a phone, re-fetched by that
 * calendar app on its own schedule forever. Deliberately a SEPARATE
 * router, mounted in app.ts before createAuthRouter/createProjectsRouter
 * (mirroring the existing /api/uploads static route's own placement and
 * reasoning): a real calendar app re-fetching this URL on a schedule has
 * no session cookie and can't attach an Authorization header, so this can
 * never go through requireAuth the way every other project-scoped route
 * does. The token itself -- a real 256-bit random value (see
 * getOrCreateCalendarFeedToken's own doc comment) -- IS the whole
 * authentication, the same way automation_rules' own webhookSecret
 * authenticates an inbound webhook call with no other identity behind it.
 *
 * 404s uniformly for "project doesn't exist", "entity doesn't exist",
 * "no token generated yet", and "token mismatch" -- never distinguishing
 * which, so this can't be used as an oracle to enumerate real project ids
 * or entity names.
 */
export function createCalendarFeedRouter(db: ForgeDatabase): Router {
  const router = Router();

  /**
   * Round 1070: this route does comparably heavy, fully-synchronous work
   * per request to the /export, /backup, /twin routes that
   * routes/projects.ts's own expensiveReadRateLimiter was added for in
   * round 1053 (a
   * JSON.parse+schema validation of the whole spec, a synchronous
   * listRecords SELECT for the main entity plus every entity any relation
   * field points at, then a full per-record ICS-formatting/escaping/
   * line-folding pass) -- but round 1053's survey never looked at this
   * file, a structurally separate router, so it was left with no
   * volumetric throttle at all. Worse than the routes that fix covered:
   * this one has no req.userId to key by in the first place (see this
   * router's own top-level doc comment: it can never go through
   * requireAuth), so anyone who was ever handed this project's
   * calendar-subscribe URL can script a tight loop directly against it --
   * no login, no account, and no requirement to still be a collaborator --
   * stalling this app's one shared Node event loop for every other
   * user/project too. Keyed by project+token together (the actual
   * resource being hit), not just the project id alone, so a wrong guess
   * against one project's feed can't exhaust a real subscriber's own
   * budget for that same project. A real calendar app re-fetches this on
   * its own schedule, typically every 15 minutes to a few hours, so this
   * cap leaves generous headroom above any legitimate refresh cadence.
   */
  const calendarFeedRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => `${req.params.projectId}:${typeof req.query.token === "string" ? req.query.token : ""}`,
    message: "Too many calendar feed requests. Please try again later.",
  });

  /**
   * Round 1247: the project-wide counterpart to the per-entity route
   * below -- a real project routinely has more than one entity with its
   * own independent date field (a clinic's Appointment.date alongside its
   * Invoice.dueDate, a CRM's Task.deadline alongside an Event.date), each
   * today needing its own separate "Subscribe" URL with zero cross-entity
   * view once pasted into a real calendar app. This route merges every
   * date-bearing entity's records into ONE feed via
   * buildCombinedCalendarFeedIcs.
   *
   * Round 1250: this used to live at the literal path
   * `/public/calendar/:projectId/all.ics` -- registered before the
   * per-entity route specifically to win a registration-order race
   * against that route's own `:entityName.ics` segment for the literal
   * string "all.ics". That only fixed the FIRST-registration half of the
   * problem: Express's own `case sensitive routing` setting defaults to
   * `false` (confirmed: app.ts's `express()` call never overrides it, and
   * a direct Express repro confirms `/all.ics`, `/All.ics`, and
   * `/ALL.ics` are all literally the SAME route to Express's router), so
   * nothing stopped a project from having a real entity literally named
   * "All" (EntitySchema only requires a non-empty string; the entity
   * rename UI has no reserved-word check) and having ITS OWN per-entity
   * subscribe URL permanently, silently shadowed by this route instead --
   * a calendar app pasted-into would keep re-fetching the wrong
   * (combined, every-entity) feed forever, with no error anywhere to
   * reveal the mismatch. Moving this to a path with an EXTRA literal
   * segment (`all/feed.ics`, two segments, vs. the per-entity route's own
   * exactly-one-segment `:entityName.ics` pattern) removes the whole
   * collision class outright: no single-segment entity name, in any
   * letter case, can ever match a path requiring two segments, so this no
   * longer depends on "all" being reserved or enforced anywhere at all.
   * Still registered before the per-entity route (harmless now, but kept
   * since there's no reason to move it) and still shares the exact same
   * token-auth and `calendarFeedRateLimiter` as that route (keyed by
   * project+token together, so this route's own requests share the same
   * budget as that one against the same project -- the right scope,
   * since both are reads against the same underlying resource).
   */
  router.get(
    "/public/calendar/:projectId/all/feed.ics",
    calendarFeedRateLimiter,
    asyncRoute((req, res) => {
      const { projectId } = req.params;
      const provided = typeof req.query.token === "string" ? req.query.token : "";
      const stored = getCalendarFeedToken(db, projectId);
      if (!stored || !provided || !tokenMatches(provided, stored)) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      const project = db.prepare("SELECT spec_json, status, description FROM projects WHERE id = ?").get(projectId) as
        | { spec_json: string; status: string; description: string }
        | undefined;
      if (!project) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      const parsed = ProductSpecSchema.safeParse(JSON.parse(project.spec_json));
      if (!parsed.success) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      const allEntities: Entity[] = parsed.data.entities;
      // Mirrors the per-entity route's own recordsByEntity fetch, but for
      // EVERY entity that has a date field, not just one -- and mirrors
      // its own relatedRecords fetch, but scanning every entity's relation
      // fields (not just one entity's), since a combined feed's
      // DESCRIPTION lines can need to resolve a relation from any of the
      // merged entities, not only the one the route URL used to name.
      const recordsByEntity: RelatedRecordsByEntity = {};
      const relatedRecords: RelatedRecordsByEntity = {};
      if (project.status === "built") {
        for (const entity of allEntities) {
          recordsByEntity[entity.name] = listRecords(db, projectId, entity) as EntityRecord[];
        }
        for (const entity of allEntities) {
          for (const field of entity.fields) {
            if (field.type !== "relation" || !field.relationTo) continue;
            const targetEntity = allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase());
            if (!targetEntity || relatedRecords[targetEntity.name]) continue;
            relatedRecords[targetEntity.name] = recordsByEntity[targetEntity.name] ?? (listRecords(db, projectId, targetEntity) as EntityRecord[]);
          }
        }
      }
      const lang = isHebrewText(project.description) ? "he" : "en";
      const ics = buildCombinedCalendarFeedIcs(allEntities, recordsByEntity, projectId, new Date(), allEntities, relatedRecords, lang);
      if (ics === null) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.send(ics);
    }),
  );

  router.get(
    "/public/calendar/:projectId/:entityName.ics",
    calendarFeedRateLimiter,
    asyncRoute((req, res) => {
      const { projectId, entityName } = req.params;
      const provided = typeof req.query.token === "string" ? req.query.token : "";
      const stored = getCalendarFeedToken(db, projectId);
      if (!stored || !provided || !tokenMatches(provided, stored)) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      const project = db.prepare("SELECT spec_json, status, description FROM projects WHERE id = ?").get(projectId) as
        | { spec_json: string; status: string; description: string }
        | undefined;
      if (!project) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      // A stored spec that no longer parses against today's (only ever
      // stricter) schema is a real, expected case for an older project
      // (see projects.ts's own tryRowToProject comment) -- treated the
      // same as "not found" here, consistent with every other 404 branch
      // above never distinguishing its exact reason.
      const parsed = ProductSpecSchema.safeParse(JSON.parse(project.spec_json));
      // Round 1185: exact-case first (the fast, common path), falling
      // back to case-insensitive -- mirroring routes/projects.ts's own
      // findEntity helper. entityName comes from the URL path segment of
      // a "Subscribe" link the client baked in and pasted into a real
      // calendar app once (EntityPanel.tsx's own subscribe-URL builder),
      // which then re-fetches that exact URL on its own schedule
      // forever, with no UI control to "resubscribe." A live refine
      // recasing this entity's own name (e.g. "customer" -> "Customer",
      // the same cosmetic, non-destructive rename round 988 and every
      // round since established must never be treated like a real
      // drop) used to 404 here permanently, and this router's own
      // deliberate single undifferentiated 404 (see its own module
      // comment) gives a subscribed calendar app no way to tell a
      // cosmetic rename apart from real data loss.
      const entity = parsed.success
        ? parsed.data.entities.find((e) => e.name === entityName) ?? parsed.data.entities.find((e) => e.name.toLowerCase() === entityName.toLowerCase())
        : undefined;
      if (!entity) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      // A project that hasn't been built yet has no real records table to
      // query (listRecords would throw) -- an empty-but-valid feed lets a
      // user set up the subscription URL ahead of building, rather than
      // erroring until they do.
      const allEntities: Entity[] = parsed.success ? parsed.data.entities : [];
      const records = project.status === "built" ? listRecords(db, projectId, entity) : [];
      // Round 1034: fetches every OTHER entity a relation field on this
      // entity actually points at, so buildCalendarFeedIcs's DESCRIPTION
      // can resolve a relation to its target record's real display label
      // instead of the raw foreign-key id -- the same data the client-side
      // one-shot export (EntityPanel.tsx's own relatedRecords state) already
      // has in memory before it ever calls buildCalendarIcs. Only built
      // once per request, and only for entities this one entity's fields
      // actually reference, not the whole project.
      const relatedRecords: RelatedRecordsByEntity = {};
      if (project.status === "built") {
        for (const field of entity.fields) {
          if (field.type !== "relation" || !field.relationTo) continue;
          // Round 1160: case-insensitive, mirroring migrate.ts's own
          // round-1159 fix -- without it, a relationTo differing from its
          // target entity's name only by letter case never found a target
          // entity here at all, leaving calendarFeed.ts's own lookup with
          // nothing to resolve the relation to. Keyed by targetEntity's
          // real, canonical name (not the possibly-differently-cased
          // relationTo string itself), so calendarFeed.ts's own lookup --
          // which resolves the same way -- always finds it.
          const targetEntity = allEntities.find((e) => e.name.toLowerCase() === field.relationTo!.toLowerCase());
          if (!targetEntity || relatedRecords[targetEntity.name]) continue;
          relatedRecords[targetEntity.name] = listRecords(db, projectId, targetEntity) as EntityRecord[];
        }
      }
      const lang = isHebrewText(project.description) ? "he" : "en";
      const ics = buildCalendarFeedIcs(entity, records, projectId, new Date(), allEntities, relatedRecords, lang);
      if (ics === null) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.send(ics);
    }),
  );

  return router;
}
