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
  // Defaults to a per-process temp dir, same convention as whatsappManager's
  // own default a few lines down -- tests that don't care about uploaded
  // files at all (the overwhelming majority) never need to pass this or
  // clean anything up themselves.
  uploadsDir: string = path.join(os.tmpdir(), "forge-uploads"),
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
  /**
   * Registered BEFORE createAuthRouter/createProjectsRouter below, and
   * deliberately with no auth check of its own -- a plain <img src> or
   * download <a href> in the real UI can't attach an Authorization
   * header, so if this ran through requireAuth (as it would if mounted
   * after createProjectsRouter, whose own router.use(requireAuth(db))
   * applies to every path under the shared /api prefix it's mounted at,
   * matched or not) every uploaded file would be unreachable from the
   * actual rendered page the moment it tried to show one. Access control
   * here is the same "unguessable URL" model most simple file-hosting
   * setups use instead: each stored filename is a fresh randomUUID() (see
   * routes/projects.ts's upload route), never the original filename, so
   * reaching a specific file means already holding the exact URL a
   * legitimate upload or record read handed out.
   *
   * The upload route (routes/projects.ts's createUploadMiddleware) never
   * restricts what a file's own content type can be -- only its *stored
   * filename's* extension is sanitized, purely against path traversal
   * (see safeFileExtension's own comment). A malicious uploader can
   * therefore attach a real `.html` or `.svg` file to any file-type
   * field; express.static would otherwise serve it back with that exact
   * Content-Type, and EntityPanel.tsx links every file field open with a
   * plain <a href=...> -- so any other collaborator who opens that link
   * would have the attacker's script execute on this app's own origin,
   * with access to this app's own localStorage session token. Forcing
   * every response from this route to download instead of render inline
   * closes that off regardless of what content type was uploaded, without
   * needing to maintain a content-type/extension allowlist that a spoofed
   * multipart Content-Type header could bypass anyway. nosniff is
   * defense-in-depth alongside it, against a browser trying to sniff and
   * render the body despite the attachment disposition.
   */
  app.use(
    "/api/uploads",
    express.static(uploadsDir, {
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", "attachment");
      },
    }),
  );
  app.use("/api", createAuthRouter(db, whatsappManager, resolvedEmailSender, activePipelines, uploadsDir));
  app.use("/api", createProjectsRouter(db, provider, whatsappManager, resolvedEmailSender, activePipelines, uploadsDir));

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use(errorMiddleware);

  return app;
}

/**
 * Exported (rather than left as an inline app.use(...) arrow function) so
 * app.test.ts can exercise the res.headersSent branch directly against a
 * minimal fake Response -- triggering it through a real HTTP round-trip
 * would mean an actual Express response whose socket really gets torn
 * down, not something a test can assert on afterwards.
 *
 * A streaming route (e.g. routes/projects.ts's streamPipeline, the
 * build/refine SSE endpoint) already calls res.writeHead(200, ...) long
 * before this middleware could ever run -- an error thrown after that
 * point still has to land here (Express has no other error path), but
 * every branch below calls res.status(...)/res.json(...), which throws its
 * own synchronous ERR_HTTP_HEADERS_SENT once headers are already on the
 * wire, masking the real error and leaving the connection to die with no
 * response body at all. Handing it to Express's own default final handler
 * via next(err) instead is exactly what Express's error-handling docs
 * recommend for this case: it destroys the connection without attempting
 * to write a second, invalid response.
 */
export function errorMiddleware(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // eslint-disable-next-line no-console
    console.error(err);
    next(err);
    return;
  }
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
}
