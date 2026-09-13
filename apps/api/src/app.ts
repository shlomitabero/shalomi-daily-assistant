import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ValidationError, NotFoundError, type ForgeDatabase } from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { createProjectsRouter } from "./routes/projects.js";
import { HttpError } from "./httpError.js";

export function createApp(db: ForgeDatabase, provider?: SpecProvider): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", createProjectsRouter(db, provider));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
