import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ForgeDatabase } from "@forge/db";
import { getCalendarFeedToken, listRecords } from "@forge/db";
import { ProductSpecSchema } from "@forge/shared";
import { buildCalendarFeedIcs } from "../calendarFeed.js";

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

  router.get(
    "/public/calendar/:projectId/:entityName.ics",
    asyncRoute((req, res) => {
      const { projectId, entityName } = req.params;
      const provided = typeof req.query.token === "string" ? req.query.token : "";
      const stored = getCalendarFeedToken(db, projectId);
      if (!stored || !provided || !tokenMatches(provided, stored)) {
        res.status(404).json({ error: "Calendar feed not found", code: "CALENDAR_FEED_NOT_FOUND" });
        return;
      }
      const project = db.prepare("SELECT spec_json, status FROM projects WHERE id = ?").get(projectId) as
        | { spec_json: string; status: string }
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
      const records = project.status === "built" ? listRecords(db, projectId, entity) : [];
      const ics = buildCalendarFeedIcs(entity, records, projectId);
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
