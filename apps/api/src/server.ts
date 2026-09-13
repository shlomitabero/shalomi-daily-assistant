import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(__dirname, "..", "data", "forge.sqlite");
const port = Number(process.env.PORT ?? 4000);
const webDistDir = path.join(__dirname, "..", "..", "web", "dist");

const db = createStore(dbPath);
const app = createApp(db, undefined, webDistDir);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Forge AI listening on http://localhost:${port} (db: ${dbPath})`);
});
