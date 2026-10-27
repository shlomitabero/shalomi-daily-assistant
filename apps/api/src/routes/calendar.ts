import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ForgeDatabase } from "@forge/db";
import { getCalendarFeedToken, listRecords } from "@forge/db";
import { ProductSpecSchema, type Entity, type EntityRecord } from "@forge/shared";
import { isHebrewText } from "@forge/spec-engine";
import { buildCalendarFeedIcs, type RelatedRecordsByEntity } from "../calendarFeed.js";
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
      const entity = parsed.success ? parsed.data.entities.find((e) => e.name === entityName) : undefined;
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
          if (field.type !== "relation" || !field.relationTo || relatedRecords[field.relationTo]) continue;
          const targetEntity = allEntities.find((e) => e.name === field.relationTo);
          if (!targetEntity) continue;
          relatedRecords[field.relationTo] = listRecords(db, projectId, targetEntity) as EntityRecord[];
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
