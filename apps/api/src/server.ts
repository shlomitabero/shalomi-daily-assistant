import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(__dirname, "..", "data", "forge.sqlite");
const port = Number(process.env.PORT ?? 4000);

const db = createStore(dbPath);
const app = createApp(db);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Forge AI API listening on http://localhost:${port} (db: ${dbPath})`);
});
