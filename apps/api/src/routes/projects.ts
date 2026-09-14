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
  type ForgeDatabase,
} from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { generateSpec, isHebrewText } from "@forge/spec-engine";
import { HttpError } from "../httpError.js";
import { requireAuth } from "../auth/middleware.js";
import { runBuildPipeline } from "../pipeline.js";
import { generateExportFiles } from "../codegen.js";
import { buildZip } from "../zip.js";

const CreateProjectSchema = z.object({
  description: z.string().min(1, "description is required"),
  name: z.string().optional(),
});

const RefineSchema = z.object({
  instruction: z.string().min(1, "instruction is required"),
});

function deriveName(description: string): string {
  const words = description.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 0 ? words : "Untitled Project";
}

function findEntity(project: Project, entityName: string): Entity {
  const entity = project.spec.entities.find((e) => e.name === entityName);
  if (!entity) {
    throw new HttpError(404, `Entity "${entityName}" is not part of this project's spec`);
  }
  return entity;
}

/** 404s (rather than 403s) on a project owned by someone else, to avoid leaking existence. */
function requireOwnedProject(db: ForgeDatabase, id: string, userId: string): Project {
  const project = getProject(db, id);
  if (!project || project.ownerId !== userId) {
    throw new HttpError(404, `Project "${id}" not found`);
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

export function createProjectsRouter(db: ForgeDatabase, provider?: SpecProvider): Router {
  const router = Router();
  router.use(requireAuth(db));

  router.post(
    "/projects",
    asyncRoute(async (req, res) => {
      const parsed = CreateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.message);
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
    "/projects/:id/build",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      await streamPipeline(res, db, project, {
        nextSpec: project.spec,
        changeLabel: isHebrewText(project.description) ? "בנייה ראשונית" : "Initial build",
      });
    }),
  );

  router.post(
    "/projects/:id/refine",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before refining it");
      }
      const parsed = RefineSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.message);
      }
      const { instruction } = parsed.data;
      const combinedDescription = `${project.description}\n\nAdditional requirement: ${instruction}`;
      const { spec: nextSpec } = await generateSpec(combinedDescription, provider);
      await streamPipeline(res, db, project, {
        previousSpec: project.spec,
        nextSpec,
        changeLabel: isHebrewText(instruction) ? `שיפור: ${instruction}` : `Refine: ${instruction}`,
      });
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
        throw new HttpError(404, `Checkpoint "${req.params.checkpointId}" not found`);
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
        throw new HttpError(409, "Build the project before exporting its code");
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
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first");
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
        throw new HttpError(409, "Project has not been built yet — call POST /build first");
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
        throw new HttpError(409, "Project has not been built yet — call POST /build first");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = Number(req.params.recordId);
      const record = updateRecord(db, project.id, entity, recordId, req.body ?? {});
      res.json({ record });
    }),
  );

  router.delete(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireOwnedProject(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = Number(req.params.recordId);
      deleteRecord(db, project.id, entity, recordId);
      res.status(204).end();
    }),
  );

  return router;
}
