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
startScheduledAutomationsLoop(db, whatsapp, emailSender);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Forge AI listening on http://localhost:${port} (db: ${dbPath})`);
});
