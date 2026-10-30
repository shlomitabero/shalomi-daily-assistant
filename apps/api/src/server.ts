import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { startScheduledAutomationsLoop } from "./automations.js";
import { createStore } from "./store.js";
import { WhatsAppWebManager } from "./whatsappWeb.js";
import { ResendEmailSender } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(__dirname, "..", "data", "forge.sqlite");
const port = Number(process.env.PORT ?? 4000);
const webDistDir = path.join(__dirname, "..", "..", "web", "dist");

const db = createStore(dbPath);
// Kept alongside the sqlite file: on a host with no persistent disk (like
// this app's current free-tier Render deployment), both are equally wiped
// on redeploy -- a real, disclosed limitation (see docs/roadmap.md), not
// something this path choice tries to hide.
const whatsappSessionsDir = path.join(path.dirname(dbPath), "whatsapp-sessions");
const whatsapp = new WhatsAppWebManager({ db, sessionsRootDir: whatsappSessionsDir });
const uploadsDir = path.join(path.dirname(dbPath), "uploads");
// Round 996: constructed once here and passed to both createApp and
// startScheduledAutomationsLoop below -- each defaults to its own new
// ResendEmailSender() when not given one (see createApp's own doc
// comment), which would otherwise mean two separate instances reading
// the same RESEND_API_KEY independently for no reason. Only harmless
// duplication today (ResendEmailSender holds no per-instance state
// beyond that one env var), but a single shared instance is the more
// obviously correct wiring, matching how `whatsapp` itself is already
// constructed once and passed to both.
const emailSender = new ResendEmailSender();
const app = createApp(db, undefined, webDistDir, whatsapp, emailSender, uploadsDir);
// Deliberately started here, not inside createApp() -- see
// startScheduledAutomationsLoop's own comment for why.
const stopAutomationsLoop = startScheduledAutomationsLoop(db, whatsapp, emailSender);

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Forge AI listening on http://localhost:${port} (db: ${dbPath})`);
});

// Round 1298: this deployment's own host (Render, see render.yaml) sends
// SIGTERM on every redeploy, restart, and scale event -- an entirely
// routine occurrence, not a crash -- and until now nothing here handled
// it, so the process was killed immediately: any in-flight HTTP request,
// WhatsApp send still queued in whatsappWeb.ts's own per-project
// sendQueue, or automations tick already running were all cut off with
// no drain. stopAutomationsLoop (returned above) is exactly the stop()
// startScheduledAutomationsLoop's own doc comment already anticipated "a
// future server shutdown handler" calling; server.close() stops accepting
// new connections while letting already-open ones finish normally. The
// timer is a last-resort safety net for a connection that never finishes
// on its own (a stuck keep-alive, a hung request) -- it must never block
// a deploy indefinitely, but the expected path is the close() callback
// firing well before it.
function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, shutting down gracefully...`);
  stopAutomationsLoop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
