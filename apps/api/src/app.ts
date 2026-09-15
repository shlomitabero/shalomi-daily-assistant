import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ValidationError, NotFoundError, type ForgeDatabase } from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { createProjectsRouter } from "./routes/projects.js";
import { createAuthRouter } from "./routes/auth.js";
import { HttpError } from "./httpError.js";

/**
 * `staticDir` is the built web app (apps/web/dist). Passing it makes this
 * one Express process serve both the API and the frontend, which is what a
 * single free-tier host (e.g. a Render web service) needs — see
 * apps/api/src/server.ts and render.yaml. Tests never pass it, so the test
 * suite never touches the filesystem for this.
 */
export function createApp(db: ForgeDatabase, provider?: SpecProvider, staticDir?: string): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", createAuthRouter(db));
  app.use("/api", createProjectsRouter(db, provider));

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, code: "VALIDATION_ERROR" });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message, code: "NOT_FOUND" });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  });

  return app;
}
