import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ValidationError, NotFoundError, type ForgeDatabase } from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { createProjectsRouter } from "./routes/projects.js";
import { createAuthRouter } from "./routes/auth.js";
import { WhatsAppWebManager } from "./whatsappWeb.js";
import { HttpError } from "./httpError.js";
import { ResendEmailSender, type EmailSender } from "./email.js";

/**
 * `staticDir` is the built web app (apps/web/dist). Passing it makes this
 * one Express process serve both the API and the frontend, which is what a
 * single free-tier host (e.g. a Render web service) needs — see
 * apps/api/src/server.ts and render.yaml. Tests never pass it, so the test
 * suite never touches the filesystem for this.
 *
 * `whatsapp` defaults to a real `WhatsAppWebManager` writing session files
 * under the OS temp dir; tests that exercise WhatsApp behavior construct
 * their own instance with a fake socket factory (see whatsappWeb.test.ts
 * and the WhatsApp tests in app.test.ts) so they never touch the real
 * WhatsApp network.
 *
 * `emailSender` defaults to a real `ResendEmailSender` reading
 * RESEND_API_KEY from the environment -- `.configured` is false whenever
 * that variable isn't set, which is exactly what makes the login-code step
 * (routes/auth.ts) stay off until someone deploying this app actually sets
 * it up. Tests that want to exercise the code step inject their own fake
 * sender (see the login-code tests in app.test.ts) instead of needing a
 * real Resend account.
 */
export function createApp(
  db: ForgeDatabase,
  provider?: SpecProvider,
  staticDir?: string,
  whatsapp?: WhatsAppWebManager,
  emailSender?: EmailSender,
): Express {
  const app = express();
  // Render (and most single-service PaaS hosts) terminates TLS at a proxy
  // and forwards plain HTTP internally, so req.protocol would report
  // "http" here without this.
  app.set("trust proxy", true);
  app.use(cors());
  app.use(express.json());

  const whatsappManager =
    whatsapp ?? new WhatsAppWebManager({ db, sessionsRootDir: path.join(os.tmpdir(), "forge-whatsapp-sessions") });
  const resolvedEmailSender = emailSender ?? new ResendEmailSender();

  // Shared across both routers below (see createProjectsRouter's own
  // comment on activePipelines) so DELETE /auth/account's per-project
  // cleanup loop in routes/auth.ts can guard against the same
  // concurrent-mutation-during-a-genuine-await hazard that every
  // project-scoped route in routes/projects.ts already guards against --
  // a Set private to just one of the two router modules couldn't do that.
  const activePipelines = new Set<string>();

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", createAuthRouter(db, whatsappManager, resolvedEmailSender, activePipelines));
  app.use("/api", createProjectsRouter(db, provider, whatsappManager, activePipelines));

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
