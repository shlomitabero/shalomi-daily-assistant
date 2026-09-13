import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Entity, Project } from "@forge/shared";
import {
  applyMigrations,
  getProject,
  insertProject,
  listProjects,
  markProjectBuilt,
  insertRecord,
  listRecords,
  updateRecord,
  deleteRecord,
  type ForgeDatabase,
} from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { generateSpec } from "@forge/spec-engine";
import { HttpError } from "../httpError.js";

const CreateProjectSchema = z.object({
  description: z.string().min(1, "description is required"),
  name: z.string().optional(),
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

function requireProject(db: ForgeDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) {
    throw new HttpError(404, `Project "${id}" not found`);
  }
  return project;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function createProjectsRouter(db: ForgeDatabase, provider?: SpecProvider): Router {
  const router = Router();

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
        name: name ?? deriveName(description),
        description,
        spec,
      });
      res.status(201).json({ project, providerName });
    }),
  );

  router.get(
    "/projects",
    asyncRoute(async (_req, res) => {
      res.json({ projects: listProjects(db) });
    }),
  );

  router.get(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      res.json({ project: requireProject(db, req.params.id) });
    }),
  );

  router.post(
    "/projects/:id/build",
    asyncRoute(async (req, res) => {
      const project = requireProject(db, req.params.id);
      applyMigrations(db, project.id, project.spec);
      const updated = markProjectBuilt(db, project.id);
      res.json({ project: updated });
    }),
  );

  router.get(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProject(db, req.params.id);
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
      const project = requireProject(db, req.params.id);
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
      const project = requireProject(db, req.params.id);
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
      const project = requireProject(db, req.params.id);
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
