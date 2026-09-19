import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { WhatsAppWebManager } from "./whatsappWeb.js";

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
const app = createApp(db, undefined, webDistDir, whatsapp);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Forge AI listening on http://localhost:${port} (db: ${dbPath})`);
});
