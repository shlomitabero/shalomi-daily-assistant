import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Entity, Project } from "@forge/shared";
import {
  getCheckpoint,
  getProject,
  insertProject,
  listCheckpoints,
  listProjectsForOwner,
  diffAndMigrate,
  updateProjectSpec,
  insertRecord,
  listRecords,
  updateRecord,
  deleteRecord,
  insertWhatsAppMessage,
  listWhatsAppMessages,
  clearWhatsAppMessages,
  type ForgeDatabase,
} from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { enhancePrompt, generateSpec, isHebrewText } from "@forge/spec-engine";
import { formatValidationError, HttpError } from "../httpError.js";
import { requireAuth } from "../auth/middleware.js";
import { runBuildPipeline } from "../pipeline.js";
import { generateExportFiles } from "../codegen.js";
import { generateBackupZipEntries } from "../backup.js";
import { buildZip } from "../zip.js";
import { computeBusinessTwin } from "../twin.js";
import type { WhatsAppWebManager } from "../whatsappWeb.js";
import { findMatchingRecord } from "../whatsapp.js";

const CreateProjectSchema = z.object({
  description: z.string().min(1, "description is required"),
  name: z.string().optional(),
});

const EnhanceIdeaSchema = z.object({
  idea: z.string().min(1, "idea is required"),
});

const RefineSchema = z.object({
  instruction: z.string().min(1, "instruction is required"),
});

const AnswerQuestionsSchema = z.object({
  answers: z.record(z.string(), z.string()).optional().default({}),
  additionalRequest: z.string().optional(),
});

const WhatsAppSendSchema = z.object({
  to: z.string().min(1, "to is required"),
  message: z.string().min(1, "message is required"),
});

/** Exported for direct unit testing of the word-truncation and empty-input fallback below. */
export function deriveName(description: string): string {
  const words = description.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 0 ? words : "Untitled Project";
}

function findEntity(project: Project, entityName: string): Entity {
  const entity = project.spec.entities.find((e) => e.name === entityName);
  if (!entity) {
    throw new HttpError(404, `Entity "${entityName}" is not part of this project's spec`, "ENTITY_NOT_FOUND");
  }
  return entity;
}

/**
 * `Number("abc")` is NaN, which SQLite's driver happily binds as a
 * parameter without throwing (verified empirically) -- so without this
 * check, a malformed :recordId in the URL silently falls through to
 * "Record NaN not found in X", a confusing 404 that leaks the raw
 * coercion result instead of clearly rejecting the bad input.
 */
function parseRecordId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `Invalid record id "${raw}"`, "VALIDATION_ERROR");
  }
  return Number(raw);
}

/** 404s (rather than 403s) on a project owned by someone else, to avoid leaking existence. */
function requireOwnedProject(db: ForgeDatabase, id: string, userId: string): Project {
  const project = getProject(db, id);
  if (!project || project.ownerId !== userId) {
    throw new HttpError(404, `Project "${id}" not found`, "PROJECT_NOT_FOUND");
  }
  return project;
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

export function createProjectsRouter(db: ForgeDatabase, provider: SpecProvider | undefined, whatsapp: WhatsAppWebManager): Router {
  const router = Router();
  router.use(requireAuth(db));

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
   */
  const activePipelines = new Set<string>();

  /**
   * The Prompt Architect Agent: takes a short, rough idea and rewrites it
   * into a fuller, more detailed prompt (same AI-or-heuristic provider seam
   * as generateSpec), without creating a project yet -- the client decides
   * whether to use the enhanced text.
   */
  router.post(
    "/ideas/enhance",
    asyncRoute(async (req, res) => {
      const parsed = EnhanceIdeaSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { enhanced, providerName } = await enhancePrompt(parsed.data.idea);
      res.json({ enhanced, providerName });
    }),
  );

  router.post(
    "/projects",
    asyncRoute(async (req, res) => {
      const parsed = CreateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { description, name } = parsed.data;
      const { spec, providerName } = await generateSpec(description, provider);
      const project = insertProject(db, {
        id: randomUUID(),
        ownerId: req.userId!,
        name: name ?? deriveName(description),
        description,
        spec,
      });
      res.status(201).json({ project, providerName });
    }),
  );

  router.get(
    "/projects",
    asyncRoute(async (req, res) => {
      res.json({ projects: listProjectsForOwner(db, req.userId!) });
    }),
  );

  router.get(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      res.json({ project: requireOwnedProject(db, req.params.id, req.userId!) });
    }),
  );

  router.post(
    "/projects/:id/answers",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      const parsed = AnswerQuestionsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const entries = Object.entries(parsed.data.answers)
        .map(([question, answer]) => [question.trim(), answer.trim()] as const)
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
      activePipelines.add(project.id);
      try {
        const combinedDescription = `${project.description}\n\n${sections.join("\n\n")}`;
        const { spec } = await generateSpec(combinedDescription, provider);
        const updated = updateProjectSpec(db, project.id, spec);
        res.json({ project: updated });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.post(
    "/projects/:id/build",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
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
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.post(
    "/projects/:id/refine",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
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
        const { spec: nextSpec } = await generateSpec(combinedDescription, provider);
        await streamPipeline(res, db, project, {
          previousSpec: project.spec,
          nextSpec,
          changeLabel: isHebrewText(instruction) ? `שיפור: ${instruction}` : `Refine: ${instruction}`,
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.get(
    "/projects/:id/checkpoints",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      res.json({ checkpoints: listCheckpoints(db, project.id) });
    }),
  );

  router.post(
    "/projects/:id/checkpoints/:checkpointId/restore",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      const checkpoint = getCheckpoint(db, req.params.checkpointId);
      if (!checkpoint || checkpoint.projectId !== project.id) {
        throw new HttpError(404, `Checkpoint "${req.params.checkpointId}" not found`, "CHECKPOINT_NOT_FOUND");
      }
      // Restoring never drops columns/tables (migrations are additive-only),
      // so it's always safe: this just ensures the restored spec's schema
      // exists (a no-op unless restoring "forward" to a spec never built)
      // and moves the spec pointer.
      diffAndMigrate(db, project.id, project.spec, checkpoint.spec);
      const updated = updateProjectSpec(db, project.id, checkpoint.spec);
      res.json({ project: updated });
    }),
  );

  router.get(
    "/projects/:id/export",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before exporting its code", "BUILD_REQUIRED");
      }
      const files = generateExportFiles(project);
      const zip = buildZip(files);
      const safeName = project.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app";
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${safeName}.zip"`);
      res.send(zip);
    }),
  );

  router.get(
    "/projects/:id/backup",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before backing up its data", "BUILD_REQUIRED");
      }
      const entries = generateBackupZipEntries(db, project);
      const zip = buildZip(entries);
      const safeName = project.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app";
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${safeName}-backup.zip"`);
      res.send(zip);
    }),
  );

  router.get(
    "/projects/:id/integrations/whatsapp/status",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      res.json(whatsapp.getStatus(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/connect",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      res.json(await whatsapp.connect(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/disconnect",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      await whatsapp.disconnect(project.id);
      res.json(whatsapp.getStatus(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/send",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      const parsed = WhatsAppSendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { to, message } = parsed.data;
      const status = whatsapp.getStatus(project.id);
      if (status.status !== "connected") {
        throw new HttpError(409, "Connect WhatsApp before sending a message", "WHATSAPP_NOT_CONNECTED");
      }
      const result = await whatsapp.sendMessage(project.id, to, message);
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
        fromNumber: status.phoneNumber ?? "",
        toNumber: to,
        body: message,
        matchedEntityName: match?.entityName ?? null,
        matchedRecordId: match?.recordId ?? null,
        matchedLabel: match?.label ?? null,
        status: result.ok ? "sent" : "failed",
      });
      if (!result.ok) {
        res.status(502).json({ ok: false, error: result.error });
        return;
      }
      res.json({ ok: true });
    }),
  );

  router.get(
    "/projects/:id/integrations/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      res.json({ messages: listWhatsAppMessages(db, project.id) });
    }),
  );

  router.delete(
    "/projects/:id/integrations/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      clearWhatsAppMessages(db, project.id);
      res.status(204).end();
    }),
  );

  router.get(
    "/projects/:id/twin",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before viewing its Business Twin", "BUILD_REQUIRED");
      }
      res.json({ twin: computeBusinessTwin(db, project) });
    }),
  );

  router.get(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      res.json({ records: listRecords(db, project.id, entity) });
    }),
  );

  router.post(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const record = insertRecord(db, project.id, entity, req.body ?? {});
      res.status(201).json({ record });
    }),
  );

  router.patch(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = parseRecordId(req.params.recordId);
      const record = updateRecord(db, project.id, entity, recordId, req.body ?? {});
      res.json({ record });
    }),
  );

  router.delete(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = parseRecordId(req.params.recordId);
      deleteRecord(db, project.id, entity, recordId);
      res.status(204).end();
    }),
  );

  return router;
}
