import type { Entity, Project } from "@forge/shared";

/**
 * Generates a real, standalone, multi-file React (Vite) + Express + SQLite
 * application from a project's ProductSpec. This is the "own your code"
 * export: the output has zero dependency on Forge AI at runtime — no
 * import of our packages, no network call back to this platform. Unlike
 * the original single-HTML-file export (see docs/ADR/0003), this produces
 * an actual per-entity React codebase — one real, editable component file
 * per entity, not one generic runtime-schema-driven blob — because that's
 * what "own your code" means against Base44/Lovable-style exports. See
 * docs/ADR/0005-react-codebase-export.md.
 */

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

function assertSafe(name: string, kind: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to export: unsafe ${kind} identifier "${name}"`);
  }
  return name;
}

function packageName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "forge-exported-app";
}

function isHebrew(text: string): boolean {
  return /[֐-׿]/.test(text);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * The character shown on the generated app icon -- `[...name][0]` (a
 * code-point-aware iterator, not `name[0]`'s raw UTF-16 code unit) so a
 * Hebrew letter or an emoji-led name doesn't split a surrogate pair into a
 * broken half-character glyph.
 */
function appInitial(name: string): string {
  const first = [...name.trim()][0] ?? "?";
  return first.toUpperCase();
}

/**
 * A single-letter app icon as inline SVG -- no image-generation dependency
 * needed (this export's own "zero extra runtime dependency" promise), and
 * SVG scales cleanly to whatever size a phone's home screen actually wants.
 * Modern Android/iOS (16.4+) both accept an SVG manifest icon and
 * apple-touch-icon directly; see renderWebIndexHtml's own comment for the
 * one real gap this leaves (older iOS versions with no update path).
 */
function renderIconSvg(project: Project): string {
  const initial = escapeXml(appInitial(project.name));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="40" fill="#d9622b" />
  <text x="96" y="99" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, 'Segoe UI', Roboto, sans-serif" font-size="104" font-weight="700" fill="#ffffff">${initial}</text>
</svg>
`;
}

/**
 * The web app manifest that makes "Add to Home Screen"/"Install" available
 * at all -- without it, the generated app is just a bookmarked website, the
 * exact gap this feature closes (a real business owner installing their own
 * AI-built app on their phone like any other app, not just a browser tab).
 * `display: "standalone"` is what actually hides the browser chrome once
 * installed.
 */
function renderManifestJson(project: Project): string {
  const name = project.name.trim() || "Forge App";
  return JSON.stringify(
    {
      name,
      short_name: name.length > 14 ? `${name.slice(0, 13)}…` : name,
      start_url: "/",
      display: "standalone",
      background_color: "#f6f2ea",
      theme_color: "#d9622b",
      icons: [
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      ],
    },
    null,
    2,
  );
}

/**
 * A real, minimal service worker -- stale-while-revalidate for the app
 * shell's own static files, so a flaky connection (the actual "works even
 * on weak signal" promise of this feature) still shows the last-known UI
 * instantly while a fresh copy loads in the background, with a cached
 * index.html as the last-resort fallback for a fully offline navigation.
 * Every `/api/*` request is deliberately never intercepted -- a stale
 * cached response for this app's own live business data (a customer list,
 * today's appointments) would be actively wrong, not just slightly out of
 * date, so those must always hit the real network and surface a real
 * failure rather than quietly serving stale records.
 */
function renderServiceWorkerJs(): string {
  return `const CACHE_NAME = "app-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(["/"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => cached || caches.match("/"));
      return cached || network;
    }),
  );
});
`;
}

function renderPackageJson(project: Project): string {
  return JSON.stringify(
    {
      name: packageName(project.name),
      private: true,
      version: "1.0.0",
      description: `Exported from Forge AI: ${project.description}`.slice(0, 200),
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        start: "vite build && node server.js",
      },
      dependencies: {
        express: "^4.21.1",
        react: "^19.3.0",
        "react-dom": "^19.3.0",
      },
      devDependencies: {
        vite: "^8.3.0",
        "@vitejs/plugin-react": "^6.1.1",
      },
      engines: {
        node: ">=22.5.0",
      },
    },
    null,
    2,
  );
}

function renderReadme(project: Project): string {
  const entityList = project.spec.entities
    .map((e) => `- **${e.label ?? e.name}** (\`${e.name}\`) — \`web/src/entities/${e.name}.jsx\``)
    .join("\n");
  return `# ${project.name}

Exported from Forge AI. This is a complete, standalone application —
running it never talks back to Forge AI, and there is nothing else to
install beyond what's in \`package.json\`.

## What this is

${project.description}

## Entities (one real React component file each)

${entityList}

## Running it

\`\`\`bash
npm install
npm start
\`\`\`

\`npm start\` builds the React frontend and then starts the server, all in
one command. Open http://localhost:3000. Data is stored in
\`data.sqlite\` next to \`server.js\` (created automatically on first run).

For active development with hot reload while the API runs separately, use
\`npm run dev\` (Vite dev server) alongside \`node server.js\`.

## Deploy it

A \`render.yaml\` is included, so [Render](https://render.com) can deploy
this without any manual configuration: push this folder to a GitHub repo,
create a new Blueprint on Render pointing at it, and it picks up the build
(\`npm install\`) and start (\`npm start\`) commands automatically. The free
plan works for this — same one-command build/start as running it
locally, just hosted.

Prefer a different host? Any platform that runs a long-lived Node process
(not a serverless/edge-function-only host, since this keeps a SQLite file
on local disk) works the same way: install with \`npm install\`, run with
\`npm start\`, and make sure the platform routes its assigned port through
\`process.env.PORT\` (\`server.js\` already reads it).

## What's here

- \`server.js\` — the entire backend: creates the SQLite schema for every
  entity above and exposes a REST API at \`/api/<Entity>\` (GET list, POST
  create, PATCH update, DELETE) with the same validation rules (required
  fields, enum membership) the Forge AI preview enforced. Serves the built
  frontend from \`dist/\` once you've run \`npm run build\` (or \`npm start\`,
  which does this for you).
- \`web/src/entities/*.jsx\` — one real component per entity, each with its
  own field list as literal, editable code (not fetched from a schema at
  runtime) — open \`web/src/entities/${project.spec.entities[0]?.name ?? "YourEntity"}.jsx\`
  and you'll see exactly which fields it has.
- \`web/src/components/EntityView.jsx\` — the shared list + form UI that
  every entity file uses, the same way a hand-written multi-entity CRUD
  app would share this logic.
- \`web/src/App.jsx\` — the top-level app: entity tabs, wired to the entity
  components above.
- \`web/src/api.js\` — the small REST client every component calls.
- \`data.sqlite\` — your data. Back it up like any file.

## Extending it

There's no magic here. Add a field to an entity by editing its
\`web/src/entities/<Entity>.jsx\` field list *and* the matching entity in
the \`ENTITIES\` array at the top of \`server.js\`, then restart — existing
columns are kept, and SQLite migrates new ones automatically (\`ALTER
TABLE\`, same as Forge AI's own migration engine). There is no
authentication in this export — see Forge AI's own auth in
\`apps/api/src/auth/\` (in the Forge AI repository) for a reference if you
want to add it.
`;
}

function sqlType(type: string): string {
  if (type === "relation") return "INTEGER";
  if (type === "number") return "REAL";
  if (type === "boolean") return "INTEGER";
  return "TEXT";
}

function renderServerJs(project: Project): string {
  for (const entity of project.spec.entities) {
    assertSafe(entity.name, "entity");
    for (const field of entity.fields) {
      assertSafe(field.name, "field");
    }
  }

  const entitiesJson = JSON.stringify(
    project.spec.entities.map((e) => ({
      name: e.name,
      label: e.label ?? e.name,
      fields: e.fields.map((f) => ({
        name: f.name,
        label: f.label ?? f.name,
        type: f.type,
        required: !!f.required,
        enumValues: f.enumValues ?? null,
        enumLabels: f.enumLabels ?? null,
        relationTo: f.relationTo ?? null,
      })),
    })),
    null,
    2,
  );

  return `// Generated by Forge AI — this file has no dependency on Forge AI at
// runtime. It's yours: read it, edit it, deploy it anywhere Node runs.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, "data.sqlite"));
// Without this, a relation field's REFERENCES clause below is pure
// decoration -- SQLite never actually enforces foreign keys unless this
// pragma is turned on for the connection. Mirrors the live Forge AI
// backend's own connection.ts.
db.exec("PRAGMA foreign_keys = ON;");

const ENTITIES = ${entitiesJson};

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
function assertSafe(name) {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(\`Unsafe identifier: \${name}\`);
  return name;
}

// Double-quotes a table/column identifier for SQL -- assertSafe already
// guarantees it's plain [A-Za-z][A-Za-z0-9_]* (no quote characters to
// escape), so this only needs to wrap it. Without this, an entity or field
// name that happens to be a SQL keyword (e.g. an "Order" entity) breaks
// every query with a syntax error.
function q(id) {
  return \`"\${id}"\`;
}

function sqlType(type) {
  if (type === "relation") return "INTEGER";
  if (type === "number") return "REAL";
  if (type === "boolean") return "INTEGER";
  return "TEXT";
}

for (const entity of ENTITIES) {
  assertSafe(entity.name);
  const columns = ["id INTEGER PRIMARY KEY AUTOINCREMENT", "createdAt TEXT NOT NULL"];
  for (const field of entity.fields) {
    assertSafe(field.name);
    // A relation field's REFERENCES clause is what lets PRAGMA foreign_keys
    // above actually block deleting a record another record still points
    // to -- without it, the column is just a plain integer with no real
    // link to the target table. SQLite allows this to forward-reference a
    // table that's declared later in ENTITIES; the constraint is only
    // checked when a row is actually written, not at CREATE TABLE time.
    const references = field.type === "relation" && field.relationTo ? \` REFERENCES \${q(field.relationTo)}(id)\` : "";
    columns.push(\`\${q(field.name)} \${sqlType(field.type)}\${field.required ? " NOT NULL" : ""}\${references}\`);
  }
  db.exec(\`CREATE TABLE IF NOT EXISTS \${q(entity.name)} (\${columns.join(", ")})\`);
}

const DATE_FORMAT = /^(\\d{4})-(\\d{2})-(\\d{2})$/;

// Every date field's canonical stored representation is exactly the
// YYYY-MM-DD shape the web UI's <input type="date"> produces -- rejects
// anything else, including a syntactically-shaped but calendrically
// impossible date like "2024-13-45" (the Date constructor silently rolls
// an out-of-range month/day over into a *different*, wrong date instead
// of rejecting it, so the parsed year/month/day are checked back against
// what was typed).
function isValidDate(value) {
  const match = DATE_FORMAT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function coerce(field, value) {
  const isEmpty = value === undefined || value === null || value === "" || (typeof value === "string" && value.trim() === "");
  if (isEmpty) {
    if (field.required) throw new Error(\`Field "\${field.name}" is required\`);
    return null;
  }
  if (field.type === "number" || field.type === "relation") {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(\`Field "\${field.name}" must be a number\`);
    return n;
  }
  if (field.type === "boolean") return value === true || value === "true" || value === 1 || value === "1" ? 1 : 0;
  if (field.type === "enum") {
    if (field.enumValues && !field.enumValues.includes(String(value))) {
      throw new Error(\`Field "\${field.name}" must be one of: \${field.enumValues.join(", ")}\`);
    }
    return String(value);
  }
  if (field.type === "date") {
    const str = String(value);
    if (!isValidDate(str)) throw new Error(\`Field "\${field.name}" must be a valid date in YYYY-MM-DD format\`);
    return str;
  }
  return String(value);
}

function rowToRecord(entity, row) {
  const record = { id: row.id, createdAt: row.createdAt };
  for (const field of entity.fields) {
    record[field.name] = field.type === "boolean" ? Boolean(row[field.name]) : row[field.name];
  }
  return record;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dist")));

app.get("/api/entities", (_req, res) => res.json({ entities: ENTITIES }));

// One cheap COUNT(*) per entity, for the entity-tabs nav's own record-count
// badge -- mirrors the live Forge AI preview's own GET /entity-counts route
// (round 305).
app.get("/api/entity-counts", (_req, res) => {
  const counts = {};
  for (const entity of ENTITIES) {
    counts[entity.name] = db.prepare(\`SELECT COUNT(*) as count FROM \${q(entity.name)}\`).get().count;
  }
  res.json({ counts });
});

for (const entity of ENTITIES) {
  const base = \`/api/\${entity.name}\`;
  const columns = entity.fields.map((f) => f.name);

  app.get(base, (_req, res) => {
    const rows = db.prepare(\`SELECT * FROM \${q(entity.name)} ORDER BY id DESC\`).all();
    res.json({ records: rows.map((r) => rowToRecord(entity, r)) });
  });

  app.post(base, (req, res) => {
    try {
      const values = entity.fields.map((f) => coerce(f, req.body?.[f.name]));
      const createdAt = new Date().toISOString();
      const placeholders = ["?", ...columns.map(() => "?")].join(", ");
      const stmt = db.prepare(\`INSERT INTO \${q(entity.name)} (createdAt, \${columns.map(q).join(", ")}) VALUES (\${placeholders})\`);
      const result = stmt.run(createdAt, ...values);
      const row = db.prepare(\`SELECT * FROM \${q(entity.name)} WHERE id = ?\`).get(result.lastInsertRowid);
      res.status(201).json({ record: rowToRecord(entity, row) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch(\`\${base}/:id\`, (req, res) => {
    try {
      const existing = db.prepare(\`SELECT * FROM \${q(entity.name)} WHERE id = ?\`).get(req.params.id);
      if (!existing) return res.status(404).json({ error: "Not found" });
      // Only a field actually present in the request body is re-coerced --
      // an untouched field keeps its already-stored raw value as-is, the
      // same fix as the live Forge AI backend's own repository.ts.
      const values = entity.fields.map((f) =>
        req.body && Object.prototype.hasOwnProperty.call(req.body, f.name) ? coerce(f, req.body[f.name]) : existing[f.name],
      );
      db.prepare(\`UPDATE \${q(entity.name)} SET \${columns.map((c) => \`\${q(c)} = ?\`).join(", ")} WHERE id = ?\`).run(...values, req.params.id);
      const row = db.prepare(\`SELECT * FROM \${q(entity.name)} WHERE id = ?\`).get(req.params.id);
      res.json({ record: rowToRecord(entity, row) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(\`\${base}/:id\`, (req, res) => {
    try {
      const result = db.prepare(\`DELETE FROM \${q(entity.name)} WHERE id = ?\`).run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: "Not found" });
      res.status(204).end();
    } catch (err) {
      // PRAGMA foreign_keys (above) throws this exact message when another
      // record's relation field still points at the row being deleted --
      // translated into a real, actionable 409 instead of a generic 500, the
      // same route-level pattern the live Forge AI backend uses.
      if (err.message === "FOREIGN KEY constraint failed") {
        return res.status(409).json({ error: "Cannot delete this record -- another record still references it through a relation field" });
      }
      res.status(400).json({ error: err.message });
    }
  });
}

// A dependency-free ZIP writer (PKZIP "store" method -- no compression),
// the same design Forge AI's own server uses, ported here so this
// exported app keeps its promise of zero runtime dependency on Forge AI.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

function buildZip(entries) {
  // The end-of-central-directory record's entry-count fields (below) are
  // 16-bit, so more than 65535 entries needs the Zip64 extension this
  // writer doesn't implement. Without this check, that case fails deep
  // inside Buffer#writeUInt16LE with a generic "value... must be <= 65535"
  // RangeError that gives no indication this was an entry-count problem --
  // matches the same guard apps/api/src/zip.ts (the live app's own ZIP
  // writer this was ported from) already has.
  if (entries.length > 0xffff) {
    throw new Error(\`buildZip: \${entries.length} entries exceeds the 65535-entry limit of this writer (no Zip64 support)\`);
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, "utf8");
    const dataBuf = Buffer.from(entry.content, "utf8");
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0o644 << 16, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

// "Backup all data": one ZIP with one CSV per entity, mirroring Forge
// AI's own live-preview backup feature and its exact CSV formatting
// rules (BOM + CRLF, relation fields resolved to a display label, enum
// values shown as their translated label) -- duplicated here rather than
// imported, the same pattern every other formatting helper in this
// exported app already follows.
// A value starting with =, +, -, @, or a tab/CR is prefixed with a leading
// single quote before the usual comma/quote/newline wrapping -- spreadsheet
// apps treat an unguarded cell like that as a formula (CSV/formula
// injection, CWE-1236), and a stored field can hold arbitrary text.
function csvEscape(value) {
  const guarded = /^[=+\\-@\\t\\r]/.test(value) ? \`'\${value}\` : value;
  if (/[",\\r\\n]/.test(guarded)) {
    return \`"\${guarded.replace(/"/g, '""')}"\`;
  }
  return guarded;
}

const BACKUP_DISPLAY_FIELD_HINTS = ["name", "title"];
function backupPickDisplayField(entity) {
  const named = entity.fields.find((f) => BACKUP_DISPLAY_FIELD_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText || entity.fields[0] || null;
}

function backupRecordDisplayLabel(entity, record) {
  const field = backupPickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return \`#\${record.id}\`;
  return String(value);
}

function backupFieldDisplayValue(field, value, recordIndexByEntity) {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") {
    const targetEntity = field.relationTo ? ENTITIES.find((e) => e.name === field.relationTo) : null;
    const index = field.relationTo ? recordIndexByEntity[field.relationTo] : null;
    if (!targetEntity || !index) return \`#\${value}\`;
    const match = index.get(Number(value));
    return match ? backupRecordDisplayLabel(targetEntity, match) : \`#\${value}\`;
  }
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return (field.enumLabels && field.enumLabels[String(value)]) || String(value);
  return String(value);
}

// Resolving a relation field used to records.find(...) a full linear
// scan of the related entity's whole record array, repeated once per
// row -- O(N*M) for N rows and M related records. A per-entity
// id->record Map (built once below, before any CSV is rendered) turns
// that lookup into O(1).
function entityToCsv(entity, records, recordIndexByEntity) {
  const header = entity.fields.map((f) => csvEscape(f.label || f.name)).join(",");
  const rows = records.map((record) =>
    entity.fields.map((f) => csvEscape(backupFieldDisplayValue(f, record[f.name], recordIndexByEntity))).join(","),
  );
  return [header, ...rows].join("\\r\\n");
}

app.get("/api/backup", (_req, res) => {
  const recordsByEntity = {};
  const recordIndexByEntity = {};
  for (const entity of ENTITIES) {
    const rows = db.prepare(\`SELECT * FROM \${q(entity.name)} ORDER BY id DESC\`).all();
    const records = rows.map((r) => rowToRecord(entity, r));
    recordsByEntity[entity.name] = records;
    recordIndexByEntity[entity.name] = new Map(records.map((r) => [Number(r.id), r]));
  }
  const zipEntries = ENTITIES.map((entity) => ({
    path: \`\${entity.name}.csv\`,
    content: "\\uFEFF" + entityToCsv(entity, recordsByEntity[entity.name], recordIndexByEntity),
  }));
  const zip = buildZip(zipEntries);
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", 'attachment; filename="backup.zip"');
  res.send(zip);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(\`\${${JSON.stringify(project.name)}} running at http://localhost:\${port}\`));
`;
}

/**
 * A real Render.com Blueprint (render.yaml), in the same proven structure
 * this platform's own render.yaml uses (see the repository root) — not a
 * speculative format. Render auto-detects this file and offers to deploy
 * from it with zero manual dashboard configuration. `buildCommand`/
 * `startCommand` just run the same `npm install`/`npm start` the README
 * already documents, so this isn't a second, divergent way to run the app.
 */
function renderRenderYaml(project: Project): string {
  const name = packageName(project.name);
  return `services:
  - type: web
    name: ${name}
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
`;
}

function renderViteConfig(): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
`;
}

function renderWebIndexHtml(project: Project): string {
  const hebrew = project.spec.entities.some((e) => isHebrew(e.label ?? ""));
  const dir = hebrew ? "rtl" : "ltr";
  const lang = hebrew ? "he" : "en";
  const title = project.name.replace(/</g, "&lt;");

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#d9622b" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<!-- apple-touch-icon technically wants a raster PNG on iOS versions before
     16.4 (2023) -- an SVG here is a known, accepted gap rather than adding
     an image-generation dependency to keep this a real trade-off, not an
     overlooked one; every current iOS/Android/desktop browser installs
     correctly from this SVG alone. -->
<link rel="apple-touch-icon" href="/icon.svg" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.jsx"></script>
</body>
</html>
`;
}

function renderMainJsx(): string {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered after the initial render, not before -- a failed/slow
// registration must never block the app's own first paint. Also why this
// swallows a rejection instead of surfacing it: a browser with no service
// worker support (or one that blocks it, e.g. some in-app webviews) should
// silently fall back to a normal, always-online page rather than error.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
`;
}

function renderApiJs(): string {
  return `const API_BASE = "/api";

async function request(path, opts) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts && opts.headers) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || \`Request failed (\${res.status})\`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

export function listRecords(entityName) {
  return request(\`/\${entityName}\`);
}

export function createRecord(entityName, data) {
  return request(\`/\${entityName}\`, { method: "POST", body: JSON.stringify(data) });
}

export function updateRecord(entityName, id, data) {
  return request(\`/\${entityName}/\${id}\`, { method: "PATCH", body: JSON.stringify(data) });
}

export function deleteRecord(entityName, id) {
  return request(\`/\${entityName}/\${id}\`, { method: "DELETE" });
}

export function listEntityCounts() {
  return request("/entity-counts");
}
`;
}

function renderEntityViewJsx(project: Project): string {
  // A light manifest of every entity's own field list (just enough to
  // resolve a relation field's target: which entity it points to, and
  // which of that entity's fields is the best human-readable label) --
  // baked in as real data, same principle as each entity's own field list
  // in entities/<Name>.jsx, not fetched from a schema at runtime.
  const allEntitiesJson = JSON.stringify(
    project.spec.entities.map((e) => ({
      name: e.name,
      fields: e.fields.map((f) => ({ name: f.name, type: f.type })),
    })),
    null,
    2,
  );

  return `import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createRecord, deleteRecord, listRecords, updateRecord } from "../api.js";

// See the comment on generateExportFiles' allEntitiesJson for why this
// exists: it lets a relation field on one entity resolve a human label from
// another entity's own records, without needing a runtime schema fetch.
const ALL_ENTITIES = ${allEntitiesJson};

function emptyForm(entity) {
  const form = {};
  for (const f of entity.fields) form[f.name] = f.type === "boolean" ? false : "";
  return form;
}

// Which of an entity's own columns the "Columns" menu has hidden from its
// table view, persisted per entity (this single-tenant exported app has no
// project id to scope by, unlike the live-preview app's own
// columnVisibility.ts) so the choice survives a reload.
const HIDDEN_COLUMNS_STORAGE_KEY = "forge_hidden_columns";
function readHiddenColumnsStore() {
  try {
    const raw = localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeHiddenColumnsStore(store) {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getHiddenColumns(entityName) {
  const store = readHiddenColumnsStore();
  return new Set(Array.isArray(store[entityName]) ? store[entityName] : []);
}
function toggleColumnVisibility(entityName, fieldName) {
  const store = readHiddenColumnsStore();
  const hidden = new Set(Array.isArray(store[entityName]) ? store[entityName] : []);
  if (hidden.has(fieldName)) hidden.delete(fieldName);
  else hidden.add(fieldName);
  store[entityName] = [...hidden];
  writeHiddenColumnsStore(store);
  return hidden;
}

// Recent queries typed into an entity's own filter-as-you-type search box,
// persisted per entity (same single-tenant scoping as the hidden-columns
// store above -- this exported app has no project id to scope by, unlike
// the live preview's own entityRecentSearches.ts) so a query typed last
// week doesn't have to be retyped from scratch.
const ENTITY_RECENT_SEARCHES_STORAGE_KEY = "forge_entity_recent_searches";
const MAX_RECENT_SEARCHES = 5;
function readEntityRecentSearchesStore() {
  try {
    const raw = localStorage.getItem(ENTITY_RECENT_SEARCHES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeEntityRecentSearchesStore(store) {
  try {
    localStorage.setItem(ENTITY_RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
}
function getEntityRecentSearches(entityName) {
  const store = readEntityRecentSearchesStore();
  return Array.isArray(store[entityName]) ? store[entityName] : [];
}
function addEntityRecentSearch(entityName, query) {
  const trimmed = query.trim();
  const store = readEntityRecentSearchesStore();
  if (!trimmed) return Array.isArray(store[entityName]) ? store[entityName] : [];
  const existing = Array.isArray(store[entityName]) ? store[entityName] : [];
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  store[entityName] = next;
  writeEntityRecentSearchesStore(store);
  return next;
}
function removeEntityRecentSearch(entityName, query) {
  const store = readEntityRecentSearchesStore();
  const existing = Array.isArray(store[entityName]) ? store[entityName] : [];
  const next = existing.filter((q) => q.toLowerCase() !== query.toLowerCase());
  store[entityName] = next;
  writeEntityRecentSearchesStore(store);
  return next;
}
function clearEntityRecentSearches(entityName) {
  const store = readEntityRecentSearchesStore();
  delete store[entityName];
  writeEntityRecentSearchesStore(store);
}

// A column's own drag-resized width, persisted per entity (same
// single-tenant scoping as the hidden-columns store above) so it survives
// a reload. Mirrors the live preview's own columnWidths.ts.
const MIN_COLUMN_WIDTH = 60;
const MAX_COLUMN_WIDTH = 480;
const COLUMN_WIDTHS_STORAGE_KEY = "forge_column_widths";
function readColumnWidthsStore() {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeColumnWidthsStore(store) {
  try {
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getColumnWidths(entityName) {
  const store = readColumnWidthsStore();
  return { ...(store[entityName] ?? {}) };
}
function setColumnWidth(entityName, fieldName, width) {
  const store = readColumnWidthsStore();
  const widths = { ...(store[entityName] ?? {}), [fieldName]: width };
  store[entityName] = widths;
  writeColumnWidthsStore(store);
  return widths;
}
function clearColumnWidths(entityName) {
  const store = readColumnWidthsStore();
  delete store[entityName];
  writeColumnWidthsStore(store);
  return {};
}

// The actual drag math: how far the mouse has moved since the drag started,
// added to the column's width at that moment, clamped to a sane range.
// Unlike the live preview's own computeResizedWidth, there's no RTL case to
// handle here -- the exported app has no lang/dir switching at all (see
// round 200's own note that it's English-only).
export function computeResizedWidth(startWidth, deltaX) {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + deltaX));
}

// A column's own drag-reordered position, persisted per entity (same
// single-tenant scoping as the hidden-columns/column-widths stores above)
// so it survives a reload. Mirrors the live preview's own columnOrder.ts.
const COLUMN_ORDER_STORAGE_KEY = "forge_column_order";
function readColumnOrderStore() {
  try {
    const raw = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeColumnOrderStore(store) {
  try {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getColumnOrder(entityName) {
  const store = readColumnOrderStore();
  return Array.isArray(store[entityName]) ? store[entityName] : [];
}
function setColumnOrder(entityName, order) {
  const store = readColumnOrderStore();
  store[entityName] = order;
  writeColumnOrderStore(store);
  return order;
}

// The table's own "Group by" field, "Table/Board/Calendar" view choice, and
// multi-column sort, each persisted per entity (same single-tenant scoping
// as the hidden-columns/column-widths/column-order stores above) so they
// survive a reload -- mirrors the live preview's own groupByPreference.ts,
// viewModePreference.ts, and sortKeysPreference.ts. Previously all three
// were plain useState with no persistence at all: switching to Board view,
// grouping by a field, or sorting a column was silently lost on every
// reload, unlike every other per-entity view preference this exported app
// already remembers.
const GROUP_FIELD_STORAGE_KEY = "forge_group_field";
function readGroupFieldStore() {
  try {
    const raw = localStorage.getItem(GROUP_FIELD_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeGroupFieldStore(store) {
  try {
    localStorage.setItem(GROUP_FIELD_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getPersistedGroupField(entityName) {
  const store = readGroupFieldStore();
  return typeof store[entityName] === "string" ? store[entityName] : "";
}
function setPersistedGroupField(entityName, fieldName) {
  const store = readGroupFieldStore();
  if (fieldName) store[entityName] = fieldName;
  else delete store[entityName];
  writeGroupFieldStore(store);
  return fieldName;
}

const VIEW_MODE_STORAGE_KEY = "forge_view_mode";
function readViewModeStore() {
  try {
    const raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeViewModeStore(store) {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getPersistedViewMode(entityName) {
  const store = readViewModeStore();
  const mode = store[entityName];
  return mode === "table" || mode === "board" || mode === "calendar" ? mode : "table";
}
function setPersistedViewMode(entityName, mode) {
  const store = readViewModeStore();
  if (mode === "table") delete store[entityName];
  else store[entityName] = mode;
  writeViewModeStore(store);
  return mode;
}

const SORT_KEYS_STORAGE_KEY = "forge_sort_keys";
function readSortKeysStore() {
  try {
    const raw = localStorage.getItem(SORT_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeSortKeysStore(store) {
  try {
    localStorage.setItem(SORT_KEYS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getPersistedSortKeys(entityName) {
  const store = readSortKeysStore();
  return Array.isArray(store[entityName]) ? store[entityName] : [];
}
function setPersistedSortKeys(entityName, keys) {
  const store = readSortKeysStore();
  if (keys.length === 0) delete store[entityName];
  else store[entityName] = keys;
  writeSortKeysStore(store);
  return keys;
}

// Mirrors the live preview's own fieldFiltersPreference.ts. Previously
// fieldFilters had no persistence at all, so a deliberately-set per-field
// filter didn't survive switching away from this entity's tab and back,
// unlike its sort order, grouping, hidden columns, and column widths, every
// one of which already survives the same switch.
const FIELD_FILTERS_STORAGE_KEY = "forge_field_filters";
function readFieldFiltersStore() {
  try {
    const raw = localStorage.getItem(FIELD_FILTERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeFieldFiltersStore(store) {
  try {
    localStorage.setItem(FIELD_FILTERS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getPersistedFieldFilters(entityName) {
  const store = readFieldFiltersStore();
  const filters = store[entityName];
  return filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
}
function setPersistedFieldFilters(entityName, filters) {
  const store = readFieldFiltersStore();
  const cleaned = {};
  for (const [field, value] of Object.entries(filters)) {
    if (value) cleaned[field] = value;
  }
  if (Object.keys(cleaned).length === 0) delete store[entityName];
  else store[entityName] = cleaned;
  writeFieldFiltersStore(store);
  return cleaned;
}

// Which grouped-table-view group keys are collapsed, per entity. Mirrors
// the live preview's own collapsedGroupsPreference.ts. Previously a
// grouped table always rendered every one of a group's rows, defeating
// the point of grouping a sizeable table to see just the groups you care
// about.
const COLLAPSED_GROUPS_STORAGE_KEY = "forge_collapsed_groups";
function readCollapsedGroupsStore() {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeCollapsedGroupsStore(store) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getPersistedCollapsedGroups(entityName) {
  const store = readCollapsedGroupsStore();
  const keys = store[entityName];
  return Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
}
function setPersistedCollapsedGroups(entityName, keys) {
  const store = readCollapsedGroupsStore();
  const deduped = [...new Set(keys)];
  if (deduped.length === 0) delete store[entityName];
  else store[entityName] = deduped;
  writeCollapsedGroupsStore(store);
  return deduped;
}

// Which board-view column values are collapsed, per entity. Mirrors the
// live preview's own collapsedBoardColumnsPreference.ts -- deliberately
// a SEPARATE store from the one just above (table groups and board
// columns can be keyed by different fields, so sharing storage would
// conflate the two). Previously a board column always rendered every one
// of its own cards, even a huge "Done" column.
const COLLAPSED_BOARD_COLUMNS_STORAGE_KEY = "forge_collapsed_board_columns";
function readCollapsedBoardColumnsStore() {
  try {
    const raw = localStorage.getItem(COLLAPSED_BOARD_COLUMNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeCollapsedBoardColumnsStore(store) {
  try {
    localStorage.setItem(COLLAPSED_BOARD_COLUMNS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}
function getPersistedCollapsedBoardColumns(entityName) {
  const store = readCollapsedBoardColumnsStore();
  const values = store[entityName];
  return Array.isArray(values) ? values.filter((v) => typeof v === "string") : [];
}
function setPersistedCollapsedBoardColumns(entityName, values) {
  const store = readCollapsedBoardColumnsStore();
  const deduped = [...new Set(values)];
  if (deduped.length === 0) delete store[entityName];
  else store[entityName] = deduped;
  writeCollapsedBoardColumnsStore(store);
  return deduped;
}

// Applies a persisted (possibly stale) column order to the entity's current
// real field list: a field the order mentions keeps its persisted relative
// position, and any field the order doesn't mention (a newly added field,
// or an order saved before it existed) is appended at the end in the
// entity's own original order. Mirrors the live preview's own
// applyColumnOrder (columnOrder.ts) verbatim.
function applyColumnOrder(fields, order) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const ordered = [];
  for (const name of order) {
    const field = byName.get(name);
    if (field) {
      ordered.push(field);
      byName.delete(name);
    }
  }
  for (const field of fields) {
    if (byName.has(field.name)) ordered.push(field);
  }
  return ordered;
}

// Computes the new full field-name order after dragging sourceName's column
// header to just before targetName's. Mirrors the live preview's own
// reorderColumns (columnOrder.ts) verbatim.
function reorderColumns(order, sourceName, targetName) {
  if (sourceName === targetName) return order;
  if (!order.includes(sourceName) || !order.includes(targetName)) return order;
  const withoutSource = order.filter((name) => name !== sourceName);
  const targetIndex = withoutSource.indexOf(targetName);
  const result = [...withoutSource];
  result.splice(targetIndex, 0, sourceName);
  return result;
}

// Mirrors the same check the server's own coerce() runs (see renderServerJs)
// -- rejecting a bad date here, before the row is ever POSTed, gives the
// user a row-numbered CSV import error instead of a generic server error
// with no row context attached.
const DATE_FORMAT = /^(\\d{4})-(\\d{2})-(\\d{2})$/;
function isValidDate(value) {
  const match = DATE_FORMAT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Picks the field that best represents one of an entity's records as a
// short human label -- prefers a field literally named "name"/"title",
// falls back to the first text field, then the first field of any type.
const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];
export function pickDisplayField(entity) {
  if (!entity || !entity.fields || entity.fields.length === 0) return null;
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText || entity.fields[0];
}

export function recordDisplayLabel(entity, record) {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return \`#\${record.id}\`;
  return String(value);
}

// relationDisplayLabel is called once per relation field per row (table/
// board/calendar cells, CSV export, sorting, search) -- it used to scan
// the related entity's entire record array with records.find(...) on
// every single call, O(N*M) total for N rows and M related records (the
// same pattern round 385 fixed in this file's own backup route). Rather
// than threading a pre-built index through every call site, this caches
// the id->record Map per records array instance in a WeakMap: the same
// relatedRecords[entityName] array reference is reused across an entire
// render/export pass (see this component's own relatedRecords state,
// fetched once per refresh), so only the first call against a given
// array pays the O(M) index-build cost -- every later call against that
// same array is O(1). Keying on the array object itself means a later
// refresh that replaces the array naturally invalidates the cache
// instead of ever serving stale data.
const relationIndexCache = new WeakMap();
function relationIndexFor(records) {
  let index = relationIndexCache.get(records);
  if (!index) {
    index = new Map(records.map((r) => [Number(r.id), r]));
    relationIndexCache.set(records, index);
  }
  return index;
}

// Resolves a relation field's stored id into the human label it should
// display. The related entity may legitimately be absent from this
// project's spec (an optional relation whose target wasn't part of the
// description), in which case this degrades to the raw id instead of
// throwing.
function relationDisplayLabel(field, value, relatedRecords) {
  if (value === null || value === undefined || value === "") return "";
  const targetEntity = field.relationTo ? ALL_ENTITIES.find((e) => e.name === field.relationTo) : null;
  const records = field.relationTo ? relatedRecords[field.relationTo] : null;
  if (!targetEntity || !records) return \`#\${value}\`;
  const match = relationIndexFor(records).get(Number(value));
  return match ? recordDisplayLabel(targetEntity, match) : \`#\${value}\`;
}

// Classifies a status-like enum value into a badge color without needing
// per-app configuration -- covers the common English status words Forge AI's
// own spec generator uses ("Won", "Lost", "Active", ...) and falls back to
// neutral for anything else (e.g. a freeform value).
const POSITIVE_WORDS = ["won", "completed", "active", "paid", "delivered", "success", "qualified", "shipped", "confirmed", "approved"];
const NEGATIVE_WORDS = ["lost", "cancelled", "canceled", "inactive", "overdue", "no-show", "failed", "rejected", "declined", "denied"];
function badgeTone(rawValue) {
  const lower = String(rawValue).toLowerCase();
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) return "negative";
  if (POSITIVE_WORDS.some((w) => lower.includes(w))) return "positive";
  return "neutral";
}

// Mirrors the live preview's own entityFormatting.ts isDeadlineFieldName/
// getDateUrgency. A date field only reads as a deadline a record can be
// "overdue" against if its own name says so -- a plain date field (e.g.
// dateOfBirth, joinedDate, shipDate) carries no such meaning on its own.
function isDeadlineFieldName(fieldName) {
  const lower = fieldName.toLowerCase();
  return lower.includes("due") || lower.includes("deadline");
}
const DUE_SOON_WINDOW_DAYS = 3;
function getDateUrgency(value, today) {
  const date = parseFieldDate(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = today || new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const daysUntil = Math.round((date.getTime() - startOfToday.getTime()) / dayMs);
  if (daysUntil < 0) return "overdue";
  if (daysUntil < DUE_SOON_WINDOW_DAYS) return "dueSoon";
  return null;
}

// A relation cell already shows a label resolved from a *different*
// record (see relationDisplayLabel), not the raw stored value an inline
// editor would need to edit -- mirrors the live preview's own
// entityFormatting.ts isInlineEditableField (round 206).
export function isInlineEditableField(field) {
  return field.type !== "relation";
}

// Splits text into plain-vs-link segments so a table cell can render a real,
// clickable link for a URL or email address embedded in a text/longtext
// field's value (a "Website" or "Email" field on a Customer/Vendor/Lead-
// shaped entity is extremely common), instead of the previously-inert
// plain text. Mirrors the live preview's own entityFormatting.ts
// splitLinkSegments verbatim, including trimming common trailing sentence
// punctuation (".", ",", ...) off of a matched URL/email into its own
// plain segment, and not double-matching an "@" inside a URL's own path as
// a second, overlapping email match.
function splitLinkSegments(text) {
  const URL_RE = /https?:\\/\\/[^\\s<>"')]+/g;
  const EMAIL_RE = /[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+/g;
  const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
  const raw = [];
  for (const re of [URL_RE, EMAIL_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      raw.push({ index: match.index, text: match[0], isEmail: re === EMAIL_RE });
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  raw.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const accepted = [];
  let claimedUntil = -1;
  for (const m of raw) {
    if (m.index < claimedUntil) continue;
    accepted.push(m);
    claimedUntil = m.index + m.text.length;
  }
  const segments = [];
  let lastIndex = 0;
  for (const m of accepted) {
    if (m.index > lastIndex) segments.push({ text: text.slice(lastIndex, m.index), href: null });
    const trailingMatch = TRAILING_PUNCTUATION_RE.exec(m.text);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const core = trailing ? m.text.slice(0, m.text.length - trailing.length) : m.text;
    if (core) segments.push({ text: core, href: m.isEmail ? \`mailto:\${core}\` : core });
    if (trailing) segments.push({ text: trailing, href: null });
    lastIndex = m.index + m.text.length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), href: null });
  return segments.length > 0 ? segments : [{ text, href: null }];
}

function LinkifiedText({ text }) {
  return (
    <>
      {splitLinkSegments(text).map((seg, i) =>
        seg.href ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="cell-link">
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function Cell({ field, value, relationLabel, onJumpToRecord }) {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (field.type === "relation") {
    const label = relationLabel || \`#\${value}\`;
    if (onJumpToRecord && field.relationTo) {
      return (
        <button type="button" className="link-button" onClick={() => onJumpToRecord(field.relationTo, Number(value))}>
          {label}
        </button>
      );
    }
    return <>{label}</>;
  }
  if (field.type === "boolean") return value ? <span className="bool-yes">✓</span> : <span className="muted">–</span>;
  if (field.type === "enum") {
    const label = (field.enumLabels && field.enumLabels[value]) || value;
    return <span className={\`badge badge-\${badgeTone(value)}\`}>{label}</span>;
  }
  if (field.type === "date") {
    // parseFieldDate (defined further down, hoisted like any function
    // declaration) avoids the same UTC-vs-local mismatch buildCalendarMonth
    // has below: passing a stored "YYYY-MM-DD" value straight to the Date
    // constructor parses it as UTC midnight, so toLocaleDateString
    // (rendered in the viewer's *local* time) would print one calendar day
    // earlier than the actual stored date for any viewer whose local time
    // is behind UTC.
    const date = parseFieldDate(value);
    const formatted = Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
    const urgency = isDeadlineFieldName(field.name) ? getDateUrgency(value) : null;
    if (!urgency) return <>{formatted}</>;
    return (
      <span className={\`date-\${urgency === "overdue" ? "overdue" : "due-soon"}\`} title={urgency === "overdue" ? "Overdue" : "Due soon"}>
        {formatted}
      </span>
    );
  }
  if (field.type === "number") return <>{Number(value).toLocaleString()}</>;
  if (field.type === "longtext") {
    return (
      <span className="longtext-cell" title={String(value)}>
        <LinkifiedText text={String(value)} />
      </span>
    );
  }
  return <LinkifiedText text={String(value)} />;
}

// A relation field is matched against its resolved display label (e.g.
// "Dana Levi"), the same text a table cell actually shows, rather than the
// raw stored foreign-key id -- otherwise a search for the customer name
// shown right there on screen finds nothing. relatedRecords is optional so
// a caller with no relation data on hand yet still gets the previous,
// id-only behavior instead of a required-but-unavailable argument.
export function matchesSearch(record, fields, query, relatedRecords) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return fields.some((f) => {
    const value = record[f.name];
    if (value === null || value === undefined) return false;
    const display =
      f.type === "enum" && f.enumLabels && f.enumLabels[value]
        ? f.enumLabels[value]
        : f.type === "relation" && relatedRecords
          ? relationDisplayLabel(f, value, relatedRecords)
          : String(value);
    return String(display).toLowerCase().includes(trimmed);
  });
}

// Reinserts a record at its original index -- used by the Undo toast
// below to put a record back exactly where it was, rather than tacking
// it onto the end of the list. Mirrors the live preview's own
// entityFormatting.ts (round 184).
export function restoreRecordAt(records, record, index) {
  const clampedIndex = Math.max(0, Math.min(index, records.length));
  return [...records.slice(0, clampedIndex), record, ...records.slice(clampedIndex)];
}

function compareValues(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

// A relation field's own stored value is a foreign-key id, but the column
// sorts on the label shown in the cell (e.g. "Dana Levi") -- otherwise
// clicking that header sorts by an internal number no one can see, which
// looks broken/random. Mirrors the live preview's own entityFormatting.ts
// resolveSortValue/matchesSearch pattern.
function resolveSortValue(fieldName, value, fields, relatedRecords) {
  const field = fields.find((f) => f.name === fieldName);
  if (field?.type !== "relation") return value;
  return relationDisplayLabel(field, value, relatedRecords);
}

// Sorts a copy of records by several fields in priority order -- each key
// after the first only breaks ties the ones before it left standing.
// Direction is applied per-key inside the comparator (not by reversing the
// whole result afterward), so an earlier key's own tie-break order never
// flips when a later key's direction differs from it. Mirrors the live
// preview's own entityFormatting.ts sortRecordsMulti (round 177).
export function sortRecordsMulti(records, sortKeys, fields, relatedRecords) {
  if (sortKeys.length === 0) return records;
  return [...records].sort((a, b) => {
    for (const { field, direction } of sortKeys) {
      const cmp =
        fields && relatedRecords
          ? compareValues(
              resolveSortValue(field, a[field], fields, relatedRecords),
              resolveSortValue(field, b[field], fields, relatedRecords),
            )
          : compareValues(a[field], b[field]);
      if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

// Wraps a CSV field in quotes (doubling any interior quotes) only when it
// contains a comma, quote, or newline. A value starting with =, +, -, @, or
// a tab/CR is prefixed with a leading single quote first -- spreadsheet
// apps treat an unguarded cell like that as a formula (CSV/formula
// injection, CWE-1236), and a stored field can hold arbitrary text.
function csvEscape(value) {
  const guarded = /^[=+\\-@\\t\\r]/.test(value) ? \`'\${value}\` : value;
  if (/[",\\r\\n]/.test(guarded)) {
    return \`"\${guarded.replace(/"/g, '""')}"\`;
  }
  return guarded;
}

// Renders a field's value the way a human reading a spreadsheet would
// expect -- the enum's translated label instead of its raw stored value,
// TRUE/FALSE for booleans (Excel's own convention) -- rather than a 1:1
// dump of the raw stored values. Numbers and dates are deliberately left
// unformatted (no thousands separator, no locale date reordering): this
// export is the designed inverse of buildImportRecords below, which
// re-parses a number with plain Number() and stores a date as-is -- a
// locale-formatted "1,500" or "1/2/2024" wouldn't round-trip back in.
function fieldDisplayValue(field, value, relatedRecords) {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") return relationDisplayLabel(field, value, relatedRecords) || \`#\${value}\`;
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return (field.enumLabels && field.enumLabels[value]) || value;
  return String(value);
}

// When a bulk-select checkbox selection exists, "Export CSV" should act on
// exactly those records (pulled from the full, unfiltered entity, matching
// handleBulkDelete/handleBulkDuplicate's own existing behavior of acting on
// the raw selection regardless of the current search/filter) instead of
// silently discarding it and exporting whatever the table happens to be
// showing right now. With nothing selected, returns visibleRecords
// unchanged -- today's "export what the table is currently showing" stays
// exactly as it was.
function selectedOrAllRecords(allRecords, visibleRecords, selectedIds) {
  if (selectedIds.size === 0) return visibleRecords;
  return allRecords.filter((r) => selectedIds.has(r.id));
}

// Sums every number-type field across a set of records, for the table's
// own totals row -- driven off whatever is passed in (the already-
// filtered/sorted visibleRecords the table itself renders), so the totals
// always reflect the current search/filter. A missing or non-numeric value
// on an otherwise-numeric field contributes 0 rather than poisoning the
// whole column's total with NaN.
function sumNumericFields(records, fields) {
  const totals = {};
  for (const field of fields) {
    if (field.type !== "number") continue;
    totals[field.name] = records.reduce((sum, record) => {
      const value = record[field.name];
      return sum + (typeof value === "number" && !Number.isNaN(value) ? value : 0);
    }, 0);
  }
  return totals;
}

// Builds a real, Excel-friendly CSV (CRLF line endings, quoted fields
// where needed) from an entity's records -- so "download my data" means
// an actual spreadsheet, not a JSON dump.
function recordsToCsv(fields, records, relatedRecords) {
  const header = fields.map((f) => csvEscape(f.label || f.name)).join(",");
  const rows = records.map((record) => fields.map((f) => csvEscape(fieldDisplayValue(f, record[f.name], relatedRecords))).join(","));
  return [header, ...rows].join("\\r\\n");
}

// Parses CSV text into rows of raw string cells (RFC 4180: quoted fields
// may contain commas, newlines, and doubled-quote escapes) -- the reverse
// of recordsToCsv, so a spreadsheet export (or a hand-edited copy of one)
// can be imported back in. Handles CRLF and bare LF line endings, and
// drops a single trailing blank line rather than emitting a phantom row.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field);
    field = "";
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\\r") {
      if (text[i + 1] === "\\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

function matchesImportHeader(header, field) {
  const normalized = header.trim().toLowerCase();
  return normalized === field.name.toLowerCase() || normalized === (field.label || "").toLowerCase();
}

// Turns parsed CSV rows into record payloads matching entity.fields --
// the reverse of fieldDisplayValue. Columns are matched to fields by
// header text (label or field name, case-insensitively); an unmatched
// column is ignored. A required relation field makes every row
// impossible to satisfy (resolving a label back to a foreign-key id
// needs the related entity's own records loaded), so that refuses the
// whole import with one clear error instead of guessing; an optional
// relation column, if present, is ignored per row.
function buildImportRecords(fields, rows) {
  if (rows.length === 0) return { records: [], errors: [] };

  const requiredRelation = fields.find((f) => f.type === "relation" && f.required);
  if (requiredRelation) {
    return {
      records: [],
      errors: [\`CSV import isn't supported yet for entities with a required relation field ("\${requiredRelation.label || requiredRelation.name}").\`],
    };
  }

  const [header, ...dataRows] = rows;
  // See entityFormatting.ts's buildImportRecords for why: a field is
  // claimed by at most one column, in header order, so two fields sharing
  // a label don't both resolve to the same first-matching field.
  const claimedFieldNames = new Set();
  const columnFields = header.map((cell) => {
    const match = fields.find((f) => !claimedFieldNames.has(f.name) && matchesImportHeader(cell, f));
    if (match) claimedFieldNames.add(match.name);
    return match || null;
  });

  const records = [];
  const errors = [];

  dataRows.forEach((row, rowIndex) => {
    const isBlank = row.every((cell) => cell.trim() === "");
    if (isBlank) return;

    const record = {};
    let rowError = null;

    for (const field of fields) {
      const columnIndex = columnFields.findIndex((f) => f && f.name === field.name);
      const trimmedCell = columnIndex === -1 ? "" : (row[columnIndex] || "").trim();
      // Reverses the leading "'" that csvEscape (this file's own guard
      // against CSV/formula injection, CWE-1236) prepends to a value
      // starting with =, +, -, @, or a tab/CR -- without this,
      // re-importing a CSV this app itself exported would permanently
      // bake that guard apostrophe into the data. Only strips it when the
      // next character is one of the guarded ones, so a value that
      // genuinely starts with a literal "'" is left untouched.
      const raw = trimmedCell[0] === "'" && /^[=+\\-@\\t\\r]/.test(trimmedCell.slice(1)) ? trimmedCell.slice(1) : trimmedCell;

      if (field.type === "relation") continue;

      if (raw === "") {
        if (field.required) {
          rowError = \`Row \${rowIndex + 1}: missing required field "\${field.label || field.name}".\`;
          break;
        }
        record[field.name] = field.type === "boolean" ? false : null;
        continue;
      }

      if (field.type === "boolean") {
        record[field.name] = ["true", "1", "yes"].includes(raw.toLowerCase());
      } else if (field.type === "number") {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          rowError = \`Row \${rowIndex + 1}: "\${raw}" isn't a number for field "\${field.label || field.name}".\`;
          break;
        }
        record[field.name] = n;
      } else if (field.type === "enum") {
        const byValue = field.enumValues && field.enumValues.find((v) => v.toLowerCase() === raw.toLowerCase());
        const byLabel =
          field.enumValues && field.enumValues.find((v) => ((field.enumLabels && field.enumLabels[v]) || v).toLowerCase() === raw.toLowerCase());
        const resolved = byValue || byLabel;
        if (!resolved) {
          rowError = \`Row \${rowIndex + 1}: "\${raw}" isn't a valid option for field "\${field.label || field.name}".\`;
          break;
        }
        record[field.name] = resolved;
      } else if (field.type === "date") {
        if (!isValidDate(raw)) {
          rowError = \`Row \${rowIndex + 1}: "\${raw}" isn't a valid date (expected YYYY-MM-DD) for field "\${field.label || field.name}".\`;
          break;
        }
        record[field.name] = raw;
      } else {
        record[field.name] = raw;
      }
    }

    if (rowError) {
      errors.push(rowError);
    } else {
      records.push(record);
    }
  });

  return { records, errors };
}

// Every enum field with a workable, human-scannable number of distinct
// values (2-8) -- used both by findBoardField below (which picks just one,
// for Kanban grouping) and by the entity table's own per-field filter
// dropdowns (which use every qualifying field at once, since an entity can
// have more than one, e.g. both "Status" and "Priority").
function findFilterableEnumFields(fields) {
  return fields.filter((f) => f.type === "enum" && f.enumValues && f.enumValues.length >= 2 && f.enumValues.length <= 8);
}

// Every field the entity table's own per-field filter dropdown should
// offer -- findFilterableEnumFields's own enum fields, plus every boolean
// field (a boolean's two values are the same workable, human-scannable
// value space the enum filter was built for). findFilterableEnumFields
// itself stays enum-only, since findBoardField above depends on that exact
// scope for Kanban column grouping.
function findFilterableFields(fields) {
  return [...findFilterableEnumFields(fields), ...fields.filter((f) => f.type === "boolean")];
}

// Picks the enum field an entity's records should be grouped into board
// columns by, if any -- prefers a field literally named status/stage, falls
// back to the first workable enum field (2-8 values), and returns null for
// a flat entity like "Customer" with no enum field.
const BOARD_FIELD_NAME_HINTS = ["status", "stage"];
function findBoardField(fields) {
  const enumFields = findFilterableEnumFields(fields);
  if (enumFields.length === 0) return null;
  const named = enumFields.find((f) => BOARD_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named || enumFields[0];
}

// Groups records into one column per declared enum value, in declared
// order, including a value with zero matching records so an empty stage
// still shows as a column instead of disappearing. A record whose stored
// value isn't in the field's current enumValues (a legacy value left
// behind after a refine renamed/restructured the field's options --
// migrations only ever add columns, never rewrite existing row data) is
// collected into a trailing synthetic "(other)" column instead of
// silently vanishing, mirroring groupRecordsByField's own "(other)"
// bucket below.
function groupByField(records, field) {
  const values = field.enumValues || [];
  const columns = values.map((value) => ({
    value,
    label: (field.enumLabels && field.enumLabels[value]) || value,
    records: records.filter((r) => String(r[field.name]) === value),
  }));
  const known = new Set(values);
  const other = records.filter((r) => !known.has(String(r[field.name] || "")));
  if (other.length > 0) {
    columns.push({ value: "__other__", label: "Other", records: other, isOther: true });
  }
  return columns;
}

// Whether a field's own value space is small and fixed enough to group the
// plain table by -- distinct from groupByField above (Kanban board columns
// only, enum-only, always includes empty columns). Mirrors the live
// preview's own entityFormatting.ts isGroupableField (round 219).
function isGroupableField(field) {
  return field.type === "enum" || field.type === "boolean";
}

// Partitions records into ordered groups by one groupable field's value,
// omitting any group with zero matching records. For an enum field, groups
// follow the field's own declared enumValues order, with a final "(other)"
// bucket for any legacy value no longer in enumValues. For a boolean
// field there are only ever the two fixed groups, true then false.
// Mirrors the live preview's own entityFormatting.ts groupRecordsByField.
function groupRecordsByField(records, field) {
  if (field.type === "boolean") {
    const groups = [];
    const truthy = records.filter((r) => Boolean(r[field.name]));
    const falsy = records.filter((r) => !r[field.name]);
    if (truthy.length > 0) groups.push({ key: "true", label: "Yes", records: truthy });
    if (falsy.length > 0) groups.push({ key: "false", label: "No", records: falsy });
    return groups;
  }
  const groups = [];
  const known = new Set(field.enumValues || []);
  for (const value of field.enumValues || []) {
    const matched = records.filter((r) => String(r[field.name] || "") === value);
    if (matched.length > 0) groups.push({ key: value, label: (field.enumLabels && field.enumLabels[value]) || value, records: matched });
  }
  const other = records.filter((r) => !known.has(String(r[field.name] || "")));
  if (other.length > 0) groups.push({ key: "__other__", label: "Other", records: other });
  return groups;
}

// Picks the date field an entity's records should be plotted on a calendar
// by, if any -- prefers a field literally named "date" or a few other
// common date-ish names, then falls back to the first date field; returns
// null for an entity with no date field at all.
const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduleddate", "eventdate", "duedate"];
function findDateField(fields) {
  const dateFields = fields.filter((f) => f.type === "date");
  if (dateFields.length === 0) return null;
  const named = dateFields.find((f) => DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named || dateFields[0];
}

// Picks the field that pairs with startField as a date *range*'s own end
// (e.g. Rental's startDate/endDate) -- matches by name hint, among the
// entity's OTHER date fields, never matching startField back to itself.
// Returns null for the overwhelmingly common case of a plain point-in-time
// date field with no end.
const END_DATE_FIELD_NAME_HINTS = ["enddate", "returndate", "checkoutdate", "untildate", "todate"];
function findEndDateField(fields, startField) {
  const otherDateFields = fields.filter((f) => f.type === "date" && f.name !== startField.name);
  return otherDateFields.find((f) => END_DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase())) || null;
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isSameCalendarMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// A stored date field is always the plain "YYYY-MM-DD" shape -- passing
// that straight to the Date constructor parses it as UTC midnight (the
// date-only form in the Date Time String Format spec), while the calendar
// grid's own cells (gridStart/date below) are built with new Date(year,
// month, day), i.e. *local* midnight. Comparing the two with local getters
// (getFullYear/getMonth/getDate) silently shifts a record back by one
// calendar day for any viewer whose local time is behind UTC (most of the
// Americas) -- confirmed empirically under TZ=America/New_York. Parsing
// the YYYY-MM-DD components directly into a local Date, the same
// construction the grid cells use, keeps both sides in the same timezone.
const CALENDAR_DATE_FORMAT = /^(\\d{4})-(\\d{2})-(\\d{2})$/;
function parseFieldDate(raw) {
  const match = CALENDAR_DATE_FORMAT.exec(raw);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return new Date(raw);
}

// Reverses a calendar grid cell's own local-midnight Date back into the
// plain "YYYY-MM-DD" a date field actually stores -- LOCAL getters, matching
// parseFieldDate's own local construction above, not toISOString() (UTC).
function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return \`\${year}-\${month}-\${day}\`;
}

// Builds a fixed 6-week (42-day) month grid starting on the Sunday on/before
// the 1st and ending on the Saturday on/after the last day -- the standard
// calendar-UI shape, including leading/trailing days from adjacent months
// so every week is a full row. Each day carries the records whose date
// field falls on that calendar date; a record with an unparseable date is
// simply never matched, not an error.
function buildCalendarMonth(records, field, year, month, endField) {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const days = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dayRecords = records.filter((r) => {
      const raw = r[field.name];
      if (raw === null || raw === undefined || raw === "") return false;
      const startDate = parseFieldDate(String(raw));
      if (Number.isNaN(startDate.getTime())) return false;
      if (endField) {
        const rawEnd = r[endField.name];
        if (rawEnd !== null && rawEnd !== undefined && rawEnd !== "") {
          const endDate = parseFieldDate(String(rawEnd));
          if (!Number.isNaN(endDate.getTime()) && endDate.getTime() >= startDate.getTime()) {
            return date.getTime() >= startDate.getTime() && date.getTime() <= endDate.getTime();
          }
        }
      }
      return isSameCalendarDay(startDate, date);
    });
    days.push({ date, inCurrentMonth: date.getMonth() === month, records: dayRecords });
  }
  return days;
}

// The calendar view's own "take it with you" action -- CSV export dumps
// the whole raw table, but a month of appointments/bookings is exactly
// what a real business owner wants to drop straight into their phone's
// real calendar app, which CSV can't do. Picks the same label field
// CalendarView's own day chips already use.
function calendarLabelField(entity, dateField) {
  const preferred = pickDisplayField(entity);
  return (preferred && preferred.name !== dateField.name ? preferred : null) || entity.fields.find((f) => f.name !== dateField.name) || dateField;
}

function icsPad2(n) {
  return String(n).padStart(2, "0");
}

// YYYYMMDD, the VALUE=DATE form RFC 5545 requires for an all-day VEVENT's DTSTART/DTEND.
function formatIcsDate(date) {
  return \`\${date.getFullYear()}\${icsPad2(date.getMonth() + 1)}\${icsPad2(date.getDate())}\`;
}

// UTC "when this file was generated" timestamp (YYYYMMDDTHHMMSSZ) -- not a record's own date, which DTSTART already carries.
function formatIcsTimestamp(date) {
  return \`\${date.getUTCFullYear()}\${icsPad2(date.getUTCMonth() + 1)}\${icsPad2(date.getUTCDate())}T\${icsPad2(date.getUTCHours())}\${icsPad2(date.getUTCMinutes())}\${icsPad2(date.getUTCSeconds())}Z\`;
}

// RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, and newline must be backslash-escaped, or a real calendar app's parser can misread the field boundary or drop the value outright.
function icsEscapeText(value) {
  return value.replace(/\\\\/g, "\\\\\\\\").replace(/;/g, "\\\\;").replace(/,/g, "\\\\,").replace(/\\r\\n|\\r|\\n/g, "\\\\n");
}

// RFC 5545 §3.1 requires folding any content line longer than 75 octets: a CRLF followed by a single leading space starts the continuation.
function foldIcsLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = rest.slice(75);
  }
  parts.push(rest);
  return parts.join("\\r\\n ");
}

// Builds a real RFC 5545 .ics calendar, one all-day VEVENT per record --
// every field other than the date/label fields becomes a "Label: value"
// line in DESCRIPTION, and a relation field resolves to its real display
// label rather than a raw id.
function buildCalendarIcs(entity, dateField, labelField, records, relatedRecords, now, endField) {
  const dtstamp = formatIcsTimestamp(now || new Date());
  const descriptionFields = entity.fields.filter((f) => f.name !== dateField.name && f.name !== labelField.name && f.name !== (endField && endField.name));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", \`PRODID:-//Forge AI//\${icsEscapeText(entity.label || entity.name)}//EN\`, "CALSCALE:GREGORIAN"];
  for (const record of records) {
    const raw = record[dateField.name];
    if (raw === null || raw === undefined || raw === "") continue;
    const match = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(raw));
    if (!match) continue;
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(start.getTime())) continue;
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    if (endField) {
      const rawEnd = record[endField.name];
      const endMatch = rawEnd === null || rawEnd === undefined || rawEnd === "" ? null : /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(rawEnd));
      if (endMatch) {
        const explicitEnd = new Date(Number(endMatch[1]), Number(endMatch[2]) - 1, Number(endMatch[3]));
        if (!Number.isNaN(explicitEnd.getTime()) && explicitEnd.getTime() >= start.getTime()) {
          end.setTime(explicitEnd.getTime());
          end.setDate(end.getDate() + 1);
        }
      }
    }
    const labelRaw = labelField.type === "enum" ? ((labelField.enumLabels && labelField.enumLabels[record[labelField.name]]) || record[labelField.name]) : record[labelField.name];
    const summary = String(labelRaw ?? entity.label ?? entity.name);
    const descriptionLines = descriptionFields
      .map((f) => {
        const value = f.type === "relation" ? relationDisplayLabel(f, record[f.name], relatedRecords) : f.type === "enum" ? ((f.enumLabels && f.enumLabels[record[f.name]]) || record[f.name]) : record[f.name];
        if (value === null || value === undefined || value === "") return null;
        return \`\${f.label || f.name}: \${value}\`;
      })
      .filter((line) => line !== null);
    lines.push("BEGIN:VEVENT");
    lines.push(foldIcsLine(\`UID:\${entity.name}-\${record.id}@forge-ai\`));
    lines.push(\`DTSTAMP:\${dtstamp}\`);
    lines.push(\`DTSTART;VALUE=DATE:\${formatIcsDate(start)}\`);
    lines.push(\`DTEND;VALUE=DATE:\${formatIcsDate(end)}\`);
    lines.push(foldIcsLine(\`SUMMARY:\${icsEscapeText(summary)}\`));
    if (descriptionLines.length > 0) {
      lines.push(foldIcsLine(\`DESCRIPTION:\${icsEscapeText(descriptionLines.join("\\n"))}\`));
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\\r\\n");
}

// Renders a month grid for entities with a date field (e.g. "Appointment"),
// so a date-heavy entity gets a real calendar instead of the same table
// shape every entity gets. Each day cell shows a chip per record landing on
// that date (click to edit), with a "+N more" overflow instead of an
// ever-growing cell.
function CalendarView({ entity, dateField, endDateField, records, month, onPrevMonth, onNextMonth, onToday, onEdit, onDayClick, onReschedule, moveErrorId }) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(() => buildCalendarMonth(records, dateField, year, monthIndex, endDateField), [records, dateField, endDateField, year, monthIndex]);
  const [dragOverDay, setDragOverDay] = useState(null);
  const [expandedDays, setExpandedDays] = useState(new Set());
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const isCurrentMonth = isSameCalendarMonth(month, new Date());
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    return days.slice(0, 7).map((d) => formatter.format(d.date));
  }, [days]);
  // Prefer the entity's real display field ("name"/"title", or the first
  // text field -- see pickDisplayField above) over whichever field merely
  // comes first after the date field: every built-in domain entity happens
  // to declare its identifying field before its date field, but an
  // AI-generated spec has no such ordering guarantee, and "first non-date
  // field" could otherwise land on a boolean, a status, or a foreign-key id.
  const labelField = calendarLabelField(entity, dateField);

  return (
    <div className="calendar-view">
      <div className="calendar-nav">
        <button type="button" className="calendar-today-btn" onClick={onToday} disabled={isCurrentMonth}>Today</button>
        <button type="button" onClick={onPrevMonth} aria-label="Previous month">‹</button>
        <span className="calendar-month-label">{monthLabel}</span>
        <button type="button" onClick={onNextMonth} aria-label="Next month">›</button>
      </div>
      <div className="calendar-grid calendar-weekdays">
        {weekdayLabels.map((label, i) => (
          <div key={i} className="calendar-weekday">{label}</div>
        ))}
      </div>
      <div className="calendar-grid calendar-days">
        {days.map((day, i) => {
          const dayKey = formatDateForInput(day.date);
          const isDragOver = day.inCurrentMonth && dragOverDay === dayKey;
          const isToday = day.inCurrentMonth && isSameCalendarDay(day.date, new Date());
          const dayClasses = ["calendar-day"];
          if (day.inCurrentMonth) {
            dayClasses.push("calendar-day-clickable");
            if (isDragOver) dayClasses.push("calendar-day-drag-over");
          } else {
            dayClasses.push("calendar-day-outside");
          }
          if (isToday) dayClasses.push("calendar-day-today");
          return (
          <div
            key={i}
            className={dayClasses.join(" ")}
            onClick={day.inCurrentMonth ? () => onDayClick(day.date) : undefined}
            title={day.inCurrentMonth ? "Add a record on this day" : undefined}
            tabIndex={day.inCurrentMonth ? 0 : undefined}
            role={day.inCurrentMonth ? "button" : undefined}
            aria-label={day.inCurrentMonth ? "Add a record on this day" : undefined}
            onKeyDown={
              day.inCurrentMonth
                ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onDayClick(day.date);
                  }
                : undefined
            }
            onDragOver={
              day.inCurrentMonth
                ? (e) => {
                    e.preventDefault();
                    setDragOverDay(dayKey);
                  }
                : undefined
            }
            onDragLeave={
              day.inCurrentMonth ? () => setDragOverDay((prev) => (prev === dayKey ? null : prev)) : undefined
            }
            onDrop={
              day.inCurrentMonth
                ? (e) => {
                    e.preventDefault();
                    setDragOverDay(null);
                    const id = Number(e.dataTransfer.getData("text/plain"));
                    if (Number.isNaN(id)) return;
                    const record = records.find((r) => r.id === id);
                    if (record) onReschedule(record, day.date);
                  }
                : undefined
            }
          >
            <span className="calendar-day-number">{day.date.getDate()}</span>
            <div className="calendar-day-records">
              {(expandedDays.has(dayKey) ? day.records : day.records.slice(0, 3)).map((record) => (
                <button
                  type="button"
                  key={record.id}
                  className={record.id === moveErrorId ? "calendar-record-chip calendar-record-chip-move-error" : "calendar-record-chip"}
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.setData("text/plain", String(record.id));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(record);
                  }}
                >
                  {String(record[labelField.name] ?? "")}
                </button>
              ))}
              {day.records.length > 3 && (
                <button
                  type="button"
                  className="calendar-record-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedDays((prev) => {
                      const next = new Set(prev);
                      if (next.has(dayKey)) next.delete(dayKey);
                      else next.add(dayKey);
                      return next;
                    });
                  }}
                >
                  {expandedDays.has(dayKey) ? "Show less" : "+" + (day.records.length - 3) + " more"}
                </button>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// One card in the board view: the record's other fields (never the board
// field itself, since that's implied by which column the card is in), a
// select to move it directly to another column, and the same Edit/Delete
// actions the table row has.
function BoardCard({ entity, boardField, record, relatedRecords, hasMoveError, onMove, onEdit, onDuplicate, onDelete, onJumpToRecord }) {
  const otherFields = entity.fields.filter((f) => f.name !== boardField.name);
  return (
    <div className={hasMoveError ? "board-card board-card-move-error" : "board-card"} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", String(record.id))}>
      {otherFields.map((f) => (
        <div key={f.name} className="board-card-field">
          <span className="muted small">{f.label}</span>
          <Cell
            field={f}
            value={record[f.name]}
            relationLabel={f.type === "relation" ? relationDisplayLabel(f, record[f.name], relatedRecords) : undefined}
            onJumpToRecord={onJumpToRecord}
          />
        </div>
      ))}
      <select className="board-card-move" value={record[boardField.name] ?? ""} onChange={(e) => onMove(e.target.value)}>
        {(boardField.enumValues || []).map((v) => (
          <option key={v} value={v}>
            {(boardField.enumLabels && boardField.enumLabels[v]) || v}
          </option>
        ))}
      </select>
      <div className="row-actions">
        <button onClick={onEdit}>Edit</button>
        <button onClick={onDuplicate}>Duplicate</button>
        <button onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

// autoFocus/onBlur/onKeyDown are only ever set by the entity table's own
// inline cell editor (see EntityView's editingCell state) -- the plain
// add/edit form below the table never passes these, so a field there
// behaves exactly as before. Mirrors the live preview's own FieldInput
// (EntityPanel.tsx, round 206).
function FieldInput({ entity, field, value, onChange, relatedEntity, relatedEntityRecords, autoFocus, onBlur, onKeyDown }) {
  const id = \`f_\${entity.name}_\${field.name}\`;
  if (field.type === "relation" && relatedEntity && relatedEntityRecords) {
    return (
      <select
        id={id}
        required={field.required}
        value={value === "" || value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        <option value="">…</option>
        {relatedEntityRecords.map((r) => (
          <option key={r.id} value={r.id}>
            {recordDisplayLabel(relatedEntity, r)}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <input
        id={id}
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  if (field.type === "enum") {
    return (
      <select id={id} required={field.required} value={value ?? ""} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
        <option value="" disabled>
          …
        </option>
        {(field.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {(field.enumLabels && field.enumLabels[v]) || v}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "longtext") {
    return <textarea id={id} required={field.required} rows={2} value={value ?? ""} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={onBlur} onKeyDown={onKeyDown} />;
  }
  if (field.type === "date") {
    return <input id={id} type="date" required={field.required} value={value ?? ""} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={onBlur} onKeyDown={onKeyDown} />;
  }
  if (field.type === "number" || field.type === "relation") {
    return (
      <input
        id={id}
        type="number"
        step={field.type === "number" ? "any" : undefined}
        required={field.required}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  return <input id={id} type="text" required={field.required} value={value ?? ""} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={onBlur} onKeyDown={onKeyDown} />;
}

// How long a deleted record stays undoable before the delete actually
// reaches the server -- mirrors the live preview's own EntityPanel.tsx
// (round 184) exactly, same window, same reasoning: long enough to notice
// and click Undo, short enough that leaving it pending doesn't feel like
// the delete silently didn't happen.
const UNDO_WINDOW_MS = 5000;

/**
 * j/k (and ArrowDown/ArrowUp) move a keyboard focus between table rows, and
 * Enter opens the focused row for editing -- the table view otherwise has
 * no way to move between records without reaching for the mouse.
 * Deliberately doesn't wrap at either end: a long table is the common case,
 * and wrapping from the last row back to the first (or vice versa) after a
 * refresh/re-sort would silently jump the focus somewhere the user never
 * intended. If the currently-focused id has since scrolled out of the
 * visible set entirely (a search/filter changed, or the record was
 * deleted), treat it the same as "nothing focused yet" and (re)start from
 * the first row, regardless of which direction was pressed. Mirrors the
 * live Forge AI preview's own entityFormatting.ts exactly.
 */
export function computeNextFocusedRowId(visibleIds, currentFocusedId, direction) {
  if (visibleIds.length === 0) return null;
  const currentIndex = currentFocusedId == null ? -1 : visibleIds.indexOf(currentFocusedId);
  if (currentIndex === -1) return visibleIds[0];
  const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  const clampedIndex = Math.max(0, Math.min(nextIndex, visibleIds.length - 1));
  return visibleIds[clampedIndex];
}

/** True while the user is actively typing somewhere else on the page (a text field, a select, a contenteditable region) -- j/k must never hijack keystrokes meant for the search box, a filter dropdown, or the add/edit form. */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Shared list + form UI used by every entity's own component file. */
export function EntityView({ entity, highlightRecordId, onHighlightHandled, onJumpToRecord, onRecordCountChange }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Distinct from the error above (shared by CSV import, bulk-edit, and
  // other mutation failures, each of which already has its own clear
  // recovery path): specifically the initial/refresh listRecords call
  // failing, which otherwise left the panel either showing a dead-end
  // error line or, worse, falling into the empty-state branch below with
  // "No records yet" even though the real problem was a failed fetch.
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(() => emptyForm(entity));
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");
  const [recentSearches, setRecentSearches] = useState(() => getEntityRecentSearches(entity.name));
  const [fieldFilters, setFieldFilters] = useState(() => getPersistedFieldFilters(entity.name));
  const [groupFieldName, setGroupFieldName] = useState(() => getPersistedGroupField(entity.name));
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set(getPersistedCollapsedGroups(entity.name)));
  const [collapsedBoardColumns, setCollapsedBoardColumns] = useState(() => new Set(getPersistedCollapsedBoardColumns(entity.name)));
  const [highlightedRecordId, setHighlightedRecordId] = useState(null);
  const [moveErrorId, setMoveErrorId] = useState(null);
  const [focusedRowId, setFocusedRowId] = useState(null);
  const [sortKeys, setSortKeys] = useState(() => getPersistedSortKeys(entity.name));
  const [viewMode, setViewMode] = useState(() => getPersistedViewMode(entity.name));
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkEditField, setBulkEditField] = useState("");
  const [bulkEditValue, setBulkEditValue] = useState("");
  const [copyStatus, setCopyStatus] = useState("idle");
  const [pendingDelete, setPendingDelete] = useState(null);
  // Mirrors pendingDelete so the unmount-flush effect and a second delete
  // arriving mid-undo-window can read the latest pending delete without
  // depending on a stale render's closure.
  const pendingDeleteRef = useRef(null);
  const [relatedRecords, setRelatedRecords] = useState({});
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [hiddenFields, setHiddenFields] = useState(() => getHiddenColumns(entity.name));
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState(() => getColumnWidths(entity.name));
  const [resizingField, setResizingField] = useState(null);
  const [columnOrder, setColumnOrderState] = useState(() => getColumnOrder(entity.name));
  const [draggedField, setDraggedField] = useState(null);
  const [dragOverField, setDragOverField] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  const [editingCell, setEditingCell] = useState(null);
  const [cellDraft, setCellDraft] = useState(undefined);
  // Set right before an Escape-cancel clears editingCell so the input's own
  // blur (which removing it from the DOM can still trigger) finds the flag
  // already set and skips committing, rather than racing a stale closure's
  // still-non-null editingCell into saving the very value Escape just
  // discarded. Mirrors the live preview's own EntityPanel.tsx (round 206).
  const suppressCellBlurCommitRef = useRef(false);
  // Bumped once per refresh() call, so a stale refresh whose listRecords
  // round trip just happens to take longer than a newer one's (triggered
  // by an overlapping action, e.g. duplicating two rows back to back)
  // can recognize itself as superseded and skip overwriting the newer,
  // still-correct records already on screen.
  const refreshRequestId = useRef(0);
  const boardField = useMemo(() => findBoardField(entity.fields), [entity.fields]);
  const filterableFields = useMemo(() => findFilterableFields(entity.fields), [entity.fields]);
  const dateField = useMemo(() => findDateField(entity.fields), [entity.fields]);
  const endDateField = useMemo(() => (dateField ? findEndDateField(entity.fields, dateField) : null), [entity.fields, dateField]);
  const relationTargets = useMemo(() => {
    const names = entity.fields.filter((f) => f.type === "relation" && f.relationTo).map((f) => f.relationTo);
    return [...new Set(names)].filter((name) => ALL_ENTITIES.some((e) => e.name === name));
  }, [entity.fields]);

  useEffect(() => {
    let cancelled = false;
    async function loadRelated() {
      if (relationTargets.length === 0) {
        setRelatedRecords({});
        return;
      }
      const entries = await Promise.all(
        relationTargets.map(async (name) => {
          try {
            const { records: related } = await listRecords(name);
            return [name, related];
          } catch {
            return [name, []];
          }
        }),
      );
      if (!cancelled) setRelatedRecords(Object.fromEntries(entries));
    }
    loadRelated();
    return () => {
      cancelled = true;
    };
  }, [relationTargets]);

  // Reports this entity's own record count back to the caller whenever
  // records changes -- every mutation already funnels through setRecords,
  // so this one effect keeps the active tab's own nav badge live without a
  // separate call site per mutation. Mirrors the live Forge AI preview's
  // own EntityPanel.tsx (round 305).
  useEffect(() => {
    if (onRecordCountChange) onRecordCountChange(entity.name, records.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name, records.length]);

  async function refresh() {
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    setLoadError(null);
    try {
      const { records } = await listRecords(entity.name);
      if (refreshRequestId.current !== requestId) return;
      setRecords(records);
    } catch (err) {
      if (refreshRequestId.current !== requestId) return;
      setLoadError(err.message);
    } finally {
      if (refreshRequestId.current === requestId) setLoading(false);
    }
  }

  useEffect(() => {
    setForm(emptyForm(entity));
    setEditingId(null);
    setSearch("");
    setRecentSearches(getEntityRecentSearches(entity.name));
    setFieldFilters(getPersistedFieldFilters(entity.name));
    setGroupFieldName(getPersistedGroupField(entity.name));
    setCollapsedGroups(new Set(getPersistedCollapsedGroups(entity.name)));
    setCollapsedBoardColumns(new Set(getPersistedCollapsedBoardColumns(entity.name)));
    setSortKeys(getPersistedSortKeys(entity.name));
    setViewMode(getPersistedViewMode(entity.name));
    setCalendarMonth(new Date());
    setSelectedIds(new Set());
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    setHiddenFields(getHiddenColumns(entity.name));
    setColumnsMenuOpen(false);
    setColumnWidths(getColumnWidths(entity.name));
    setColumnOrderState(getColumnOrder(entity.name));
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name]);

  // Applies an incoming highlightRecordId (from GlobalSearch's own per-row
  // "jump to record" click) once this entity's records have actually
  // loaded -- switching to table view and clearing any leftover search
  // filter, since either could otherwise hide the very row this was
  // supposed to reveal. Reports back via onHighlightHandled so the parent
  // clears its own copy and a second click on the same record can
  // re-trigger it. Mirrors the live Forge AI preview's own EntityPanel.tsx.
  useEffect(() => {
    if (highlightRecordId == null || loading) return;
    setSearch("");
    setFieldFilters({});
    setViewMode("table");
    setHighlightedRecordId(highlightRecordId);
    onHighlightHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRecordId, loading]);

  // Auto-fades the highlight a few seconds after it lands, so an old
  // "jump to record" doesn't stay visually marked forever.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const timer = setTimeout(() => setHighlightedRecordId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedRecordId]);

  // Same auto-fade pattern as highlightedRecordId above, for the per-record
  // move/edit error marker instead of a jump-to highlight.
  useEffect(() => {
    if (moveErrorId == null) return;
    const timer = setTimeout(() => setMoveErrorId(null), 5000);
    return () => clearTimeout(timer);
  }, [moveErrorId]);

  // Fires the real DELETE request for a record the undo window has already
  // closed on (either the timer ran out, or a newer delete pre-empted it).
  // The row was already removed from view the moment Delete was confirmed,
  // on the assumption the real delete would simply succeed later -- but a
  // record another record still points to via a relation field genuinely
  // can't be deleted (a real foreign-key constraint, see server.js's own
  // PRAGMA foreign_keys). This used to be a bare .catch(() => {}), silently
  // discarding that failure: the row stayed gone from view with no error
  // shown at all. Restores the row (same helper handleUndoDelete uses) and
  // surfaces the real error instead.
  async function commitPendingDelete(pending) {
    const results = await Promise.allSettled(pending.entries.map((e) => deleteRecord(entity.name, e.id)));
    const failed = pending.entries.filter((_, i) => results[i].status === "rejected");
    if (failed.length === 0) return;
    setRecords((prev) => failed.reduce((acc, e) => restoreRecordAt(acc, e.record, e.index), prev));
    const firstFailure = results.find((r) => r.status === "rejected");
    setError(
      failed.length === pending.entries.length
        ? firstFailure.reason.message
        : \`\${failed.length} of \${pending.entries.length} records could not be deleted.\`,
    );
  }

  useEffect(() => {
    pendingDeleteRef.current = pendingDelete;
  }, [pendingDelete]);

  // Switching entity tabs remounts this component fresh (each entity's own
  // View wrapper is a distinct component, per entities/<Name>.jsx), so
  // leaving one open mid-undo-window would otherwise silently never
  // actually delete the record. Committing it for real on unmount instead
  // makes "navigate away" behave like the undo window simply ran out
  // early, rather than quietly reverting the delete.
  useEffect(() => {
    return () => {
      const pending = pendingDeleteRef.current;
      if (pending) {
        clearTimeout(pending.timeoutId);
        commitPendingDelete(pending);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Plain click always replaces the whole key list with a single new key
  // (toggling direction in place when that field was already the sole
  // key). Shift-click either appends a new tiebreaker key, or toggles an
  // existing key's own direction without moving its position in the list.
  // Mirrors the live preview's own EntityPanel.tsx toggleSort (round 177).
  function toggleSort(fieldName, additive) {
    setSortKeys((prev) => {
      const existingIndex = prev.findIndex((k) => k.field === fieldName);
      let next;
      if (!additive) {
        next =
          prev.length === 1 && existingIndex === 0
            ? [{ field: fieldName, direction: prev[0].direction === "asc" ? "desc" : "asc" }]
            : [{ field: fieldName, direction: "asc" }];
      } else if (existingIndex === -1) {
        next = [...prev, { field: fieldName, direction: "asc" }];
      } else {
        next = prev.map((k, i) => (i === existingIndex ? { ...k, direction: k.direction === "asc" ? "desc" : "asc" } : k));
      }
      setPersistedSortKeys(entity.name, next);
      return next;
    });
  }

  // The entity's own fields, reordered to match whatever column order the
  // user has actually dragged into place (falling back to the entity's
  // natural order for a field the persisted order doesn't mention). Mirrors
  // the live preview's own EntityPanel.tsx (round 203).
  const orderedFields = useMemo(() => applyColumnOrder(entity.fields, columnOrder), [entity.fields, columnOrder]);

  // Which columns actually render in the table -- CSV export intentionally
  // ignores this and always includes every field, the same "whole-record
  // action" distinction the live-preview app's own EntityPanel makes.
  const visibleFields = useMemo(() => orderedFields.filter((f) => !hiddenFields.has(f.name)), [orderedFields, hiddenFields]);

  function handleToggleColumn(fieldName) {
    const visibleCount = entity.fields.length - hiddenFields.size;
    if (!hiddenFields.has(fieldName) && visibleCount <= 1) return; // keep at least one column visible
    setHiddenFields(toggleColumnVisibility(entity.name, fieldName));
  }

  // Dragging a column header to just before another one's -- reorders the
  // FULL field list (including any currently-hidden fields), not just the
  // visible subset, so a hidden field keeps its relative place once shown
  // again later. Mirrors the live preview's own handleReorderColumn
  // (EntityPanel.tsx, round 203).
  function handleReorderColumn(targetName) {
    setDragOverField(null);
    if (!draggedField || draggedField === targetName) return;
    const fullOrder = orderedFields.map((f) => f.name);
    setColumnOrderState(setColumnOrder(entity.name, reorderColumns(fullOrder, draggedField, targetName)));
    setDraggedField(null);
  }

  // Drag-to-resize a column header. Only attaches real mousemove/mouseup
  // listeners while a drag is actually in progress (resizingField set),
  // removing them the instant it ends -- not a permanent global listener
  // doing nothing most of the time. The width is only persisted to
  // localStorage on mouseup (via setColumnWidth), not on every mousemove,
  // so a fast drag doesn't write to storage dozens of times per second.
  // Mirrors the live preview's own EntityPanel.tsx (round 185).
  useEffect(() => {
    if (!resizingField) return;
    function handleMove(e) {
      const width = computeResizedWidth(resizingField.startWidth, e.clientX - resizingField.startX);
      setColumnWidths((prev) => ({ ...prev, [resizingField.field]: width }));
    }
    function handleUp() {
      setColumnWidths((prev) => {
        const width = prev[resizingField.field];
        if (width != null) setColumnWidth(entity.name, resizingField.field, width);
        return prev;
      });
      setResizingField(null);
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizingField]);

  function startResize(e, fieldName) {
    e.preventDefault();
    const th = e.currentTarget.parentElement;
    const startWidth = columnWidths[fieldName] ?? th?.getBoundingClientRect().width ?? 150;
    setResizingField({ field: fieldName, startX: e.clientX, startWidth });
  }

  const visibleRecords = useMemo(() => {
    const matched = records.filter((r) => matchesSearch(r, entity.fields, search, relatedRecords));
    const filtered = matched.filter((r) =>
      Object.entries(fieldFilters).every(([fieldName, value]) => !value || String(r[fieldName] ?? "") === value),
    );
    return sortRecordsMulti(filtered, sortKeys, entity.fields, relatedRecords);
  }, [records, entity.fields, search, fieldFilters, sortKeys, relatedRecords]);

  const hasNumericVisibleField = useMemo(() => visibleFields.some((f) => f.type === "number"), [visibleFields]);
  const numericFieldTotals = useMemo(
    () => (hasNumericVisibleField ? sumNumericFields(visibleRecords, visibleFields) : {}),
    [hasNumericVisibleField, visibleRecords, visibleFields],
  );

  // Grouping the plain table by a small-value-space field (enum/boolean) --
  // distinct from the Kanban board view (always exactly one auto-picked
  // field, always its own separate view), this lets a person cluster the
  // ordinary table by ANY such field while staying in table view, with
  // search/sort/columns all still applying underneath. Mirrors the live
  // preview's own EntityPanel.tsx (round 219).
  const groupableFields = useMemo(() => entity.fields.filter(isGroupableField), [entity.fields]);
  const groupField = groupableFields.find((f) => f.name === groupFieldName) || null;
  const recordGroups = useMemo(
    () => (groupField ? groupRecordsByField(visibleRecords, groupField) : null),
    [groupField, visibleRecords],
  );

  // Per-group numeric subtotals -- without this, grouping a table by e.g.
  // Order Status still only ever showed one grand total under the whole
  // table (numericFieldTotals above), defeating the point of grouping a
  // numeric entity: a person groups Orders by Status specifically to
  // compare revenue across "Paid" vs "Pending" vs "Cancelled". Mirrors the
  // live preview's own EntityPanel.tsx (round 302).
  const groupNumericTotals = useMemo(() => {
    if (!hasNumericVisibleField || !recordGroups) return null;
    const totals = {};
    for (const group of recordGroups) {
      totals[group.key] = sumNumericFields(group.records, visibleFields);
    }
    return totals;
  }, [hasNumericVisibleField, recordGroups, visibleFields]);

  // Exactly the records the calendar grid's current month is showing -- lets
  // the ICS export button disable itself when the visible month is
  // genuinely empty, not just when the whole entity has no records.
  const icsMonthRecords = useMemo(() => {
    if (!dateField) return [];
    const days = buildCalendarMonth(visibleRecords, dateField, calendarMonth.getFullYear(), calendarMonth.getMonth(), endDateField);
    return days.filter((d) => d.inCurrentMonth).flatMap((d) => d.records);
  }, [visibleRecords, dateField, endDateField, calendarMonth]);

  // Scrolls the just-highlighted row into view once it's actually in the
  // rendered table -- runs after visibleRecords updates too, since the row
  // doesn't exist in the DOM until then.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const row = document.querySelector(\`tr[data-record-id="\${highlightedRecordId}"]\`);
    row?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlightedRecordId, visibleRecords]);

  // Mirrors the highlighted-row scroll effect above, for the keyboard-
  // focused row instead of a jump-to target.
  useEffect(() => {
    if (focusedRowId == null) return;
    const row = document.querySelector(\`tr[data-record-id="\${focusedRowId}"]\`);
    row?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [focusedRowId, visibleRecords]);

  /**
   * j/k (and ArrowDown/ArrowUp) move a keyboard focus between table rows,
   * Enter opens the focused row for editing, "x" toggles that row's own
   * selection checkbox, Delete/Backspace deletes it (reusing
   * handleDelete's own confirm dialog and undo-toast), "d" duplicates
   * it (reusing handleDuplicate verbatim), and Escape clears the whole
   * multi-row selection (reusing the same setSelectedIds(new Set()) the
   * "Clear selection" button already calls) -- the table view previously
   * had no way to move between records, select one for bulk actions,
   * delete one, duplicate one, or back out of a selection, without
   * reaching for the mouse. Only active in table view (board/calendar
   * have their own navigation shapes), and isTypingTarget guards
   * against hijacking keystrokes meant for the search box, a filter
   * dropdown, or the add/edit form. Mirrors the live Forge AI preview's
   * own EntityPanel.tsx.
   */
  useEffect(() => {
    if (viewMode !== "table") return;
    function handleKeyDown(e) {
      if (isTypingTarget(e.target)) return;
      const visibleIds = visibleRecords.map((r) => r.id);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "next"));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "prev"));
      } else if (e.key === "Enter" && focusedRowId != null) {
        const record = visibleRecords.find((r) => r.id === focusedRowId);
        if (record) {
          e.preventDefault();
          startEdit(record);
        }
      } else if (e.key === "x" && focusedRowId != null) {
        e.preventDefault();
        toggleSelected(focusedRowId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && focusedRowId != null) {
        e.preventDefault();
        handleDelete(focusedRowId);
      } else if (e.key === "d" && focusedRowId != null) {
        e.preventDefault();
        handleDuplicate(focusedRowId);
      } else if (e.key === "Escape" && selectedIds.size > 0) {
        e.preventDefault();
        setSelectedIds(new Set());
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode, visibleRecords, focusedRowId, selectedIds]);

  /**
   * "n" jumps straight to a blank add-record form, abandoning whatever
   * edit was in progress -- unlike j/k/Enter above, this isn't scoped to
   * table view: the form itself renders above the table/board/calendar
   * switch and stays reachable from any of them, so the shortcut has to
   * stay active in all three too. Mirrors the live Forge AI preview's own
   * EntityPanel.tsx.
   */
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== "n") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      startCreateNew();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [entity]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    // Checked client-side (with noValidate on the <form>) rather than
    // relying on the browser's own native required-field validation --
    // mirrors the live preview's own identical fix.
    const missingField = entity.fields.find((f) => f.required && (form[f.name] === "" || form[f.name] == null));
    if (missingField) {
      setError(\`"\${missingField.label || missingField.name}" is a required field\`);
      return;
    }
    try {
      if (editingId != null) {
        await updateRecord(entity.name, editingId, form);
      } else {
        await createRecord(entity.name, form);
      }
      setForm(emptyForm(entity));
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(record) {
    const next = {};
    for (const f of entity.fields) next[f.name] = record[f.name] ?? (f.type === "boolean" ? false : "");
    setForm(next);
    setEditingId(record.id);
  }

  function startCreateForColumn(value, field) {
    setEditingId(null);
    setForm({ ...emptyForm(entity), [field.name]: value });
  }

  function startCreateForDate(date, field) {
    setEditingId(null);
    setForm({ ...emptyForm(entity), [field.name]: formatDateForInput(date) });
  }

  // The "n" shortcut's own target -- discards an in-progress edit (if
  // any), resets the form, and moves focus to it.
  function startCreateNew() {
    setEditingId(null);
    setForm(emptyForm(entity));
    const formEl = document.querySelector(".record-form");
    formEl?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    const firstField = document.querySelector(".record-form input, .record-form select, .record-form textarea");
    firstField?.focus();
  }

  // Toggles one group's collapsed state and persists the full updated set.
  function toggleGroupCollapsed(groupKey) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      setPersistedCollapsedGroups(entity.name, [...next]);
      return next;
    });
  }

  // Mirrors toggleGroupCollapsed above, for board columns instead of table groups.
  function toggleBoardColumnCollapsed(columnValue) {
    setCollapsedBoardColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnValue)) next.delete(columnValue);
      else next.add(columnValue);
      setPersistedCollapsedBoardColumns(entity.name, [...next]);
      return next;
    });
  }

  // Deleting a record used to call the real DELETE endpoint the instant the
  // confirm dialog closed -- irreversible the moment you clicked, with the
  // confirm dialog as the only safety net. Removes it from view immediately
  // (so the table still feels instant), but delays the actual API call
  // behind a real UNDO_WINDOW_MS window, showing a toast with an Undo
  // button. Mirrors the live preview's own EntityPanel.tsx exactly (round
  // 184). Only one delete is ever pending at a time: starting a new one
  // commits any still-pending one for real first, rather than letting two
  // undo windows overlap.
  function handleDelete(id) {
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return;
    const record = records[index];
    const label = recordDisplayLabel(entity, record);
    if (!window.confirm(\`Delete "\${label}"? You can undo this for a few seconds after deleting.\`)) return;

    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeoutId);
      commitPendingDelete(pendingDeleteRef.current);
    }

    setError(null);
    setRecords((prev) => prev.filter((r) => r.id !== id));
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    const timeoutId = setTimeout(() => {
      setPendingDelete((current) => {
        if (current?.timeoutId !== timeoutId) return current;
        commitPendingDelete(current);
        return null;
      });
    }, UNDO_WINDOW_MS);

    setPendingDelete({ entries: [{ id, record, index }], message: \`Deleted "\${label}". \`, timeoutId });
  }

  function handleUndoDelete() {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    setRecords((prev) => pending.entries.reduce((acc, e) => restoreRecordAt(acc, e.record, e.index), prev));
    setPendingDelete(null);
  }

  // Copies a record's own field values into a real new record -- no
  // confirmation, unlike delete, since duplicating creates rather than
  // destroys data.
  async function handleDuplicate(id) {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    setError(null);
    try {
      const copy = {};
      for (const f of entity.fields) copy[f.name] = record[f.name];
      await createRecord(entity.name, copy);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    const visibleIds = visibleRecords.map((r) => r.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(\`Delete \${ids.length} records? You can undo this for a few seconds after deleting.\`)) return;

    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timeoutId);
      commitPendingDelete(pendingDeleteRef.current);
    }

    setError(null);
    const idSet = new Set(ids);
    const entries = [];
    records.forEach((r, index) => {
      if (idSet.has(r.id)) entries.push({ id: r.id, record: r, index });
    });
    setRecords((prev) => prev.filter((r) => !idSet.has(r.id)));
    setSelectedIds(new Set());

    const timeoutId = setTimeout(() => {
      setPendingDelete((current) => {
        if (current?.timeoutId !== timeoutId) return current;
        commitPendingDelete(current);
        return null;
      });
    }, UNDO_WINDOW_MS);

    setPendingDelete({ entries, message: \`Deleted \${entries.length} records. \`, timeoutId });
  }

  // Same Promise.allSettled resilience as handleBulkDelete above, and the
  // same per-record copy logic as the single-record handleDuplicate above
  // -- a quick way to create several similar entries at once without
  // repeating single duplicates one at a time. No confirmation, for the
  // same reason handleDuplicate has none: duplicating creates rather than
  // destroys.
  async function handleBulkDuplicate() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setError(null);
    const results = await Promise.allSettled(
      ids.map((id) => {
        const record = records.find((r) => r.id === id);
        const copy = {};
        if (record) for (const f of entity.fields) copy[f.name] = record[f.name];
        return createRecord(entity.name, copy);
      }),
    );
    const failedIds = ids.filter((_, i) => results[i].status === "rejected");
    setSelectedIds(new Set(failedIds));
    if (failedIds.length > 0) {
      const firstFailure = results.find((r) => r.status === "rejected");
      setError(
        failedIds.length === ids.length
          ? firstFailure.reason.message
          : \`\${failedIds.length} of \${ids.length} records could not be duplicated.\`,
      );
    }
    await refresh();
  }

  // Changing a single shared field's value across several selected records
  // (e.g. marking 15 selected orders "Shipped") still meant editing each
  // row one at a time without this -- same Promise.allSettled resilience as
  // handleBulkDelete/handleBulkDuplicate above. Restricted to
  // isInlineEditableField fields (excludes relation), same reason the
  // inline cell editor itself is.
  async function handleBulkUpdate() {
    const ids = [...selectedIds];
    if (ids.length === 0 || !bulkEditField) return;
    setError(null);
    const results = await Promise.allSettled(ids.map((id) => updateRecord(entity.name, id, { [bulkEditField]: bulkEditValue })));
    const failedIds = ids.filter((_, i) => results[i].status === "rejected");
    setSelectedIds(new Set(failedIds));
    if (failedIds.length > 0) {
      const firstFailure = results.find((r) => r.status === "rejected");
      setError(
        failedIds.length === ids.length
          ? firstFailure.reason.message
          : \`\${failedIds.length} of \${ids.length} records could not be updated.\`,
      );
    }
    await refresh();
  }

  // A field's "empty" starting value depends on its type -- switching the
  // bulk-edit field picker from, say, an enum to a boolean must not leave a
  // stale string value FieldInput would render nonsensically.
  function handleBulkEditFieldChange(fieldName) {
    setBulkEditField(fieldName);
    const field = entity.fields.find((f) => f.name === fieldName);
    setBulkEditValue(field && field.type === "boolean" ? false : "");
  }

  async function handleMoveFields(id, fields) {
    setError(null);
    try {
      await updateRecord(entity.name, id, fields);
      await refresh();
    } catch (err) {
      setError(err.message);
      setMoveErrorId(id);
    }
  }

  async function handleMove(id, fieldName, value) {
    await handleMoveFields(id, { [fieldName]: value });
  }

  // Double-clicking a table cell (any field except relation, see
  // isInlineEditableField) opens that one cell for editing right in place,
  // instead of requiring the full add/edit form below the table for a
  // single-value change. Mirrors the live preview's own EntityPanel.tsx
  // (round 206).
  function startInlineEdit(record, field) {
    if (!isInlineEditableField(field)) return;
    setEditingCell({ recordId: record.id, field: field.name });
    setCellDraft(record[field.name]);
  }

  async function commitInlineEdit() {
    if (!editingCell) return;
    const { recordId, field } = editingCell;
    const value = cellDraft;
    setEditingCell(null);
    try {
      await updateRecord(entity.name, recordId, { [field]: value });
      await refresh();
    } catch (err) {
      setError(err.message);
      setMoveErrorId(recordId);
    }
  }

  // Escape discards the in-progress edit instead of saving it.
  function cancelInlineEdit() {
    suppressCellBlurCommitRef.current = true;
    setEditingCell(null);
  }

  function handleCellBlur() {
    if (suppressCellBlurCommitRef.current) {
      suppressCellBlurCommitRef.current = false;
      return;
    }
    void commitInlineEdit();
  }

  // Real native HTML5 drag-and-drop for the board view (draggable +
  // dragstart/dragover/drop), not a mouse-event simulation like the
  // column-resize handle needed -- this is exactly the browser's own
  // built-in drag contract. Reuses the same handleMove the card's own
  // move-to-column <select> already calls, so a drag and a dropdown
  // change both end up doing the identical real PATCH + refresh. Mirrors
  // the live preview's own EntityPanel.tsx (round 186).
  function handleCardDrop(e, fieldName, value) {
    e.preventDefault();
    setDragOverColumn(null);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isNaN(id)) return;
    const record = records.find((r) => r.id === id);
    // Dropping a card back onto the column it's already in is a real
    // no-op -- nothing actually changed, so there's nothing worth a PATCH
    // request for.
    if (record && String(record[fieldName] ?? "") === value) return;
    void handleMove(id, fieldName, value);
  }

  // The calendar view's own drag-and-drop, the direct sibling of
  // handleCardDrop above -- dragging a record's chip onto a different day
  // reschedules it there without opening the edit form. Reuses the same
  // handleMoveFields PATCH+refresh, just addressed by the date field's own
  // name and a freshly-formatted "YYYY-MM-DD" value. For a ranged entity
  // (e.g. Rental's startDate/endDate), shifts endDate by the same number of
  // days so the booking's real duration survives the drag instead of
  // silently becoming an invalid (end before start) range. Mirrors the
  // live preview's own EntityPanel.tsx (round 211, extended round 383).
  function handleCalendarDrop(record, dateFieldName, date) {
    const value = formatDateForInput(date);
    if (String(record[dateFieldName] ?? "") === value) return;
    const fields = { [dateFieldName]: value };
    if (endDateField && dateField && dateFieldName === dateField.name) {
      const rawOldStart = record[dateFieldName];
      const rawEnd = record[endDateField.name];
      if (rawOldStart !== null && rawOldStart !== undefined && rawOldStart !== "" && rawEnd !== null && rawEnd !== undefined && rawEnd !== "") {
        const oldStart = parseFieldDate(String(rawOldStart));
        const oldEnd = parseFieldDate(String(rawEnd));
        if (!Number.isNaN(oldStart.getTime()) && !Number.isNaN(oldEnd.getTime()) && oldEnd.getTime() >= oldStart.getTime()) {
          const deltaDays = Math.round((date.getTime() - oldStart.getTime()) / (24 * 60 * 60 * 1000));
          const newEnd = new Date(oldEnd);
          newEnd.setDate(newEnd.getDate() + deltaDays);
          fields[endDateField.name] = formatDateForInput(newEnd);
        }
      }
    }
    void handleMoveFields(record.id, fields);
  }

  // Persists the current search box value to this entity's recent list once
  // the user signals they're "done" by pressing Enter -- there's no submit
  // button on a live filter-as-you-type box, so Enter is the commit signal.
  // Escape clears the live search value (reusing the same setSearch("")
  // the "Clear search" button already calls) -- the table's own
  // window-level Escape handler (clears the multi-row selection) never
  // reaches this input at all, since it bails out via isTypingTarget the
  // moment this field has focus. Mirrors the live preview's own
  // EntityPanel.tsx handleSearchKeyDown.
  function handleSearchKeyDown(e) {
    if (e.key === "Enter" && search.trim()) {
      setRecentSearches(addEntityRecentSearch(entity.name, search));
    } else if (e.key === "Escape" && search.length > 0) {
      e.preventDefault();
      setSearch("");
    }
  }
  function handleRecentSearchClick(query) {
    setSearch(query);
  }
  function handleRemoveRecentSearch(query) {
    setRecentSearches(removeEntityRecentSearch(entity.name, query));
  }
  function handleClearRecentSearches() {
    clearEntityRecentSearches(entity.name);
    setRecentSearches([]);
  }

  function handleExportCsv() {
    const csv = recordsToCsv(entity.fields, selectedOrAllRecords(records, visibleRecords, selectedIds), relatedRecords);
    const blob = new Blob(["\\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`\${entity.name}.csv\`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCopy() {
    try {
      const csv = recordsToCsv(entity.fields, selectedOrAllRecords(records, visibleRecords, selectedIds), relatedRecords);
      await navigator.clipboard.writeText(csv);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  // The calendar view's own "take it with you" action -- exports exactly
  // the records the calendar grid's current month is showing as a real
  // RFC 5545 .ics calendar.
  function handleExportIcs() {
    if (!dateField) return;
    const labelField = calendarLabelField(entity, dateField);
    const ics = buildCalendarIcs(entity, dateField, labelField, icsMonthRecords, relatedRecords, new Date(), endDateField);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`\${entity.name}.ics\`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // The complement to CSV export: parses an uploaded file, converts it to
  // record payloads (already validated client-side), then POSTs each
  // valid row. Uses allSettled rather than assuming success once
  // client-side validation passes, since the server has the final say.
  async function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setImportBusy(true);
    setImportMessage(null);
    setImportErrors([]);
    setShowImportErrors(false);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const { records: parsedRecords, errors: parseErrors } = buildImportRecords(entity.fields, rows);

      if (parsedRecords.length === 0) {
        setImportErrors(parseErrors);
        setImportMessage(
          parseErrors.length > 0 ? \`Import failed: \${parseErrors.length} errors. No records were created.\` : "The file contained no data rows to import.",
        );
        return;
      }

      const results = await Promise.allSettled(parsedRecords.map((record) => createRecord(entity.name, record)));
      const serverErrors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
      const createdCount = results.length - serverErrors.length;
      const allErrors = [...parseErrors, ...serverErrors];
      setImportErrors(allErrors);
      setImportMessage(
        allErrors.length === 0
          ? \`Imported \${createdCount} records successfully.\`
          : \`Imported \${createdCount} records, skipped \${allErrors.length} rows.\`,
      );
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setImportBusy(false);
    }
  }

  // Extracted so both the flat table and the grouped table (see
  // recordGroups above) can render the identical row -- grouping only
  // changes which records a given <tbody> section lists, never how a
  // single row itself looks.
  const renderRow = (r) => (
    <tr key={r.id} data-record-id={r.id} className={[r.id === highlightedRecordId ? "record-row-highlighted" : null, r.id === focusedRowId ? "record-row-focused" : null, r.id === moveErrorId ? "record-row-move-error" : null].filter(Boolean).join(" ") || undefined}>
      <td className="select-col">
        <input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelected(r.id)} />
      </td>
      {visibleFields.map((f) => {
        const isEditingThisCell = editingCell != null && editingCell.recordId === r.id && editingCell.field === f.name;
        const editable = isInlineEditableField(f);
        return (
          <td
            key={f.name}
            style={columnWidths[f.name] ? { width: columnWidths[f.name] } : undefined}
            className={isEditingThisCell ? "cell-editing" : editable ? "cell-inline-editable" : undefined}
            onDoubleClick={editable && !isEditingThisCell ? () => startInlineEdit(r, f) : undefined}
            title={editable && !isEditingThisCell ? "Double-click to edit quickly" : undefined}
          >
            {isEditingThisCell ? (
              <FieldInput
                entity={entity}
                field={f}
                value={cellDraft}
                onChange={setCellDraft}
                relatedEntity={f.relationTo ? ALL_ENTITIES.find((e) => e.name === f.relationTo) : undefined}
                relatedEntityRecords={f.relationTo ? relatedRecords[f.relationTo] : undefined}
                autoFocus
                onBlur={handleCellBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitInlineEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelInlineEdit();
                  }
                }}
              />
            ) : (
              <Cell
                field={f}
                value={r[f.name]}
                relationLabel={f.type === "relation" ? relationDisplayLabel(f, r[f.name], relatedRecords) : undefined}
                onJumpToRecord={onJumpToRecord}
              />
            )}
          </td>
        );
      })}
      <td className="row-actions">
        <button onClick={() => startEdit(r)}>Edit</button>
        <button onClick={() => handleDuplicate(r.id)}>Duplicate</button>
        <button onClick={() => handleDelete(r.id)}>Delete</button>
      </td>
    </tr>
  );

  return (
    <div className="panel">
      <h3>{entity.label}</h3>
      <form
        className="record-form"
        onSubmit={handleSubmit}
        noValidate
        onKeyDown={(e) => {
          if (e.key === "Escape" && editingId != null) {
            e.preventDefault();
            setForm(emptyForm(entity));
            setEditingId(null);
          } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
      >
        {entity.fields.map((f) => (
          <label className="field" key={f.name}>
            <span>
              {f.label}
              {f.required ? " *" : ""}
            </span>
            <FieldInput
              entity={entity}
              field={f}
              value={form[f.name]}
              onChange={(v) => setForm((prev) => ({ ...prev, [f.name]: v }))}
              relatedEntity={f.relationTo ? ALL_ENTITIES.find((e) => e.name === f.relationTo) : undefined}
              relatedEntityRecords={f.relationTo ? relatedRecords[f.relationTo] : undefined}
            />
          </label>
        ))}
        <div>
          <button type="submit" className="btn">
            {editingId != null ? "Save" : "Add"}
          </button>
          {editingId != null && (
            <button
              type="button"
              onClick={() => {
                setForm(emptyForm(entity));
                setEditingId(null);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      {error && <p className="error" role="status">{error}</p>}
      {loadError && (
        <div className="error-retry-row">
          <p className="error" role="status">{loadError}</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {pendingDelete && (
        <p className="entity-undo-toast" role="status">
          {pendingDelete.message}
          <button type="button" className="link-button" onClick={handleUndoDelete}>
            Undo
          </button>
        </p>
      )}

      <div className="csv-import-row">
        <label className="csv-import-label">
          {importBusy ? "Importing…" : "⬆️ Import CSV"}
          <input type="file" accept=".csv,text/csv" onChange={handleImportFile} disabled={importBusy} hidden />
        </label>
        {importMessage && <span className="muted small">{importMessage}</span>}
        {importErrors.length > 0 && (
          <button type="button" className="import-errors-toggle" onClick={() => setShowImportErrors((v) => !v)}>
            {showImportErrors ? "Hide errors" : "Show errors"}
          </button>
        )}
      </div>
      {showImportErrors && importErrors.length > 0 && (
        <ul className="csv-import-errors">
          {importErrors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      )}

      {loading ? (
        <p className="muted" role="status">Loading…</p>
      ) : records.length === 0 ? (
        loadError ? null : (
          <div className="empty-state">
            <p>No records yet — add the first one above.</p>
          </div>
        )
      ) : (
        <>
          <div className="entity-toolbar">
            <input
              type="text"
              className="entity-search"
              placeholder="🔍 Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {search.length > 0 && (
              <button type="button" className="entity-clear-search" aria-label="Clear search" onClick={() => setSearch("")}>
                ✕
              </button>
            )}
            {filterableFields.map((f) => (
              <select
                key={f.name}
                className="entity-status-filter"
                aria-label={"Filter by " + (f.label || f.name)}
                value={fieldFilters[f.name] || ""}
                onChange={(e) =>
                  setFieldFilters((prev) => {
                    const next = { ...prev, [f.name]: e.target.value };
                    setPersistedFieldFilters(entity.name, next);
                    return next;
                  })
                }
              >
                <option value="">{"All " + (f.label || f.name)}</option>
                {f.type === "boolean" ? (
                  <>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </>
                ) : (
                  (f.enumValues || []).map((v) => (
                    <option key={v} value={v}>
                      {(f.enumLabels && f.enumLabels[v]) || v}
                    </option>
                  ))
                )}
              </select>
            ))}
            {filterableFields.length > 0 && Object.values(fieldFilters).some(Boolean) && (
              <button
                type="button"
                className="entity-clear-filters"
                onClick={() =>
                  setFieldFilters(() => {
                    setPersistedFieldFilters(entity.name, {});
                    return {};
                  })
                }
              >
                Clear all filters
              </button>
            )}
            {viewMode === "table" && groupableFields.length > 0 && (
              <select
                className="entity-group-by"
                aria-label="Group by"
                value={groupFieldName}
                onChange={(e) => setGroupFieldName(setPersistedGroupField(entity.name, e.target.value))}
              >
                <option value="">No grouping</option>
                {groupableFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label || f.name}
                  </option>
                ))}
              </select>
            )}
            {(boardField || dateField) && (
              <div className="view-toggle" role="group">
                <button
                  type="button"
                  className={viewMode === "table" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  onClick={() => setViewMode(setPersistedViewMode(entity.name, "table"))}
                >
                  📋 Table
                </button>
                {boardField && (
                  <button
                    type="button"
                    className={viewMode === "board" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode(setPersistedViewMode(entity.name, "board"))}
                  >
                    🗂️ Board
                  </button>
                )}
                {dateField && (
                  <button
                    type="button"
                    className={viewMode === "calendar" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode(setPersistedViewMode(entity.name, "calendar"))}
                  >
                    📅 Calendar
                  </button>
                )}
              </div>
            )}
            {viewMode === "calendar" && dateField && (
              <button type="button" className="ics-export-btn" onClick={handleExportIcs} disabled={icsMonthRecords.length === 0}>
                📅 Export to Calendar (ICS)
              </button>
            )}
            <button
              type="button"
              className="copy-records-btn"
              onClick={handleCopy}
              disabled={selectedIds.size === 0 && visibleRecords.length === 0}
              aria-live="polite"
              aria-atomic="true"
            >
              {copyStatus === "copied"
                ? "✅ Copied!"
                : copyStatus === "failed"
                  ? "Copy failed"
                  : selectedIds.size > 0
                    ? \`📋 Copy \${selectedIds.size} selected\`
                    : "📋 Copy"}
            </button>
            <button
              type="button"
              className="csv-export-btn"
              onClick={handleExportCsv}
              disabled={selectedIds.size === 0 && visibleRecords.length === 0}
            >
              {selectedIds.size > 0 ? <>⬇️ Export {selectedIds.size} selected</> : "⬇️ Export CSV"}
            </button>
            <div className="columns-menu-wrapper">
              <button type="button" className="columns-menu-btn" onClick={() => setColumnsMenuOpen((v) => !v)} aria-expanded={columnsMenuOpen}>
                🧩 Columns
              </button>
              {columnsMenuOpen && (
                <div className="columns-menu-panel">
                  {entity.fields.map((f) => (
                    <label key={f.name} className="columns-menu-item">
                      <input type="checkbox" checked={!hiddenFields.has(f.name)} onChange={() => handleToggleColumn(f.name)} />
                      {f.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {Object.keys(columnWidths).length > 0 && (
              <button type="button" className="entity-reset-column-widths" onClick={() => setColumnWidths(clearColumnWidths(entity.name))}>
                Reset column widths
              </button>
            )}
            {sortKeys.length > 0 && (
              <button type="button" className="entity-clear-sort" onClick={() => setSortKeys(setPersistedSortKeys(entity.name, []))}>
                Clear sort
              </button>
            )}
          </div>
          {!search.trim() && recentSearches.length > 0 && (
            <div className="entity-search-recent">
              <div className="entity-search-recent-header">
                <span className="muted small">Recent searches</span>
                <button type="button" className="link-button small" onClick={handleClearRecentSearches}>
                  Clear
                </button>
              </div>
              <div className="chips">
                {recentSearches.map((q) => (
                  <span className="chip chip-removable" key={q}>
                    <button type="button" className="chip-text" onClick={() => handleRecentSearchClick(q)}>
                      {q}
                    </button>
                    <button
                      type="button"
                      className="chip-remove"
                      title={\`Remove "\${q}"\`}
                      aria-label={\`Remove "\${q}"\`}
                      onClick={() => handleRemoveRecentSearch(q)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {visibleRecords.length === 0 ? (
            <div className="empty-state">
              <p>No results match your search.</p>
            </div>
          ) : viewMode === "board" && boardField ? (
            <div className="board-scroll">
              {groupByField(visibleRecords, boardField).map((column) => {
                const collapsed = collapsedBoardColumns.has(column.value);
                return (
                <div
                  className={
                    dragOverColumn === column.value
                      ? "board-column board-column-drag-over"
                      : column.isOther
                        ? "board-column board-column-other"
                        : "board-column"
                  }
                  key={column.value}
                  onDragOver={(e) => {
                    if (column.isOther) return;
                    e.preventDefault();
                    setDragOverColumn(column.value);
                  }}
                  onDragLeave={() => setDragOverColumn((prev) => (prev === column.value ? null : prev))}
                  onDrop={(e) => {
                    if (column.isOther) return;
                    handleCardDrop(e, boardField.name, column.value);
                  }}
                >
                  <div className="board-column-header">
                    <div className="board-column-header-info">
                      <button
                        type="button"
                        className="board-column-toggle"
                        onClick={() => toggleBoardColumnCollapsed(column.value)}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? "Expand column" : "Collapse column"}
                      >
                        {collapsed ? "▸" : "▾"}
                      </button>
                      <span className={\`badge badge-\${badgeTone(column.value)}\`}>{column.label}</span>
                      <span className="muted small">{column.records.length}</span>
                    </div>
                    {!column.isOther && (
                      <button
                        type="button"
                        className="board-add-card-btn"
                        title={\`Add a record under "\${column.label}"\`}
                        aria-label={\`Add a record under "\${column.label}"\`}
                        onClick={() => startCreateForColumn(column.value, boardField)}
                      >
                        +
                      </button>
                    )}
                  </div>
                  {!collapsed && column.records.map((r) => (
                    <BoardCard
                      key={r.id}
                      entity={entity}
                      boardField={boardField}
                      record={r}
                      relatedRecords={relatedRecords}
                      hasMoveError={r.id === moveErrorId}
                      onMove={(value) => handleMove(r.id, boardField.name, value)}
                      onEdit={() => startEdit(r)}
                      onDuplicate={() => handleDuplicate(r.id)}
                      onDelete={() => handleDelete(r.id)}
                      onJumpToRecord={onJumpToRecord}
                    />
                  ))}
                </div>
                );
              })}
            </div>
          ) : viewMode === "calendar" && dateField ? (
            <CalendarView
              entity={entity}
              dateField={dateField}
              endDateField={endDateField}
              records={visibleRecords}
              month={calendarMonth}
              onPrevMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              onNextMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              onToday={() => setCalendarMonth(new Date())}
              onEdit={startEdit}
              onDayClick={(date) => startCreateForDate(date, dateField)}
              onReschedule={(record, date) => handleCalendarDrop(record, dateField.name, date)}
              moveErrorId={moveErrorId}
            />
          ) : (
            <div className="table-scroll">
              {selectedIds.size > 0 && (
                <div className="bulk-actions-bar">
                  <span>{selectedIds.size} selected</span>
                  <label className="bulk-edit-field-label">
                    Set field:
                    <select value={bulkEditField} onChange={(e) => handleBulkEditFieldChange(e.target.value)}>
                      <option value="">Choose field…</option>
                      {entity.fields.filter(isInlineEditableField).map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label ?? f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {bulkEditField && (
                    <FieldInput entity={entity} field={entity.fields.find((f) => f.name === bulkEditField)} value={bulkEditValue} onChange={setBulkEditValue} />
                  )}
                  {bulkEditField && (
                    <button type="button" onClick={handleBulkUpdate}>
                      Apply to {selectedIds.size}
                    </button>
                  )}
                  <button type="button" onClick={handleBulkDuplicate}>
                    📋 Duplicate selected
                  </button>
                  <button type="button" onClick={handleBulkDelete}>
                    🗑️ Delete selected
                  </button>
                  <button type="button" onClick={() => setSelectedIds(new Set())}>
                    Clear selection
                  </button>
                </div>
              )}
              <table className={Object.keys(columnWidths).length > 0 ? "entity-table-resized" : undefined}>
                <thead>
                  <tr>
                    <th className="select-col">
                      <input
                        type="checkbox"
                        checked={visibleRecords.length > 0 && visibleRecords.every((r) => selectedIds.has(r.id))}
                        ref={(el) => {
                          if (!el) return;
                          const someSelected = visibleRecords.some((r) => selectedIds.has(r.id));
                          const allSelected = visibleRecords.length > 0 && visibleRecords.every((r) => selectedIds.has(r.id));
                          el.indeterminate = someSelected && !allSelected;
                        }}
                        onChange={toggleSelectAllVisible}
                      />
                    </th>
                    {visibleFields.map((f) => {
                      const keyIndex = sortKeys.findIndex((k) => k.field === f.name);
                      const key = keyIndex === -1 ? null : sortKeys[keyIndex];
                      return (
                        <th
                          key={f.name}
                          aria-sort={keyIndex === 0 ? (key.direction === "asc" ? "ascending" : "descending") : "none"}
                          className={dragOverField === f.name ? "resizable-col resizable-col-drag-over" : "resizable-col"}
                          style={columnWidths[f.name] ? { width: columnWidths[f.name] } : undefined}
                          draggable
                          onDragStart={() => setDraggedField(f.name)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverField(f.name);
                          }}
                          onDragLeave={() => setDragOverField((prev) => (prev === f.name ? null : prev))}
                          onDrop={(e) => {
                            e.preventDefault();
                            handleReorderColumn(f.name);
                          }}
                        >
                          <button type="button" className="sort-header" onClick={(e) => toggleSort(f.name, e.shiftKey)}>
                            {f.label}
                            {key ? (key.direction === "asc" ? " ▲" : " ▼") : ""}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                          <span className="column-resize-handle" onMouseDown={(e) => startResize(e, f.name)} aria-hidden="true" />
                        </th>
                      );
                    })}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {recordGroups
                    ? recordGroups.map((group) => {
                        const collapsed = collapsedGroups.has(group.key);
                        return (
                        <Fragment key={group.key}>
                          <tr className="entity-group-header-row">
                            <td colSpan={visibleFields.length + 2}>
                              <button
                                type="button"
                                className="entity-group-toggle"
                                onClick={() => toggleGroupCollapsed(group.key)}
                                aria-expanded={!collapsed}
                                aria-label={collapsed ? "Expand group" : "Collapse group"}
                              >
                                {collapsed ? "▸" : "▾"}
                              </button>{" "}
                              {group.label} <span className="muted small">({group.records.length})</span>
                            </td>
                          </tr>
                          {!collapsed && group.records.map(renderRow)}
                          {!collapsed && hasNumericVisibleField && (
                            <tr className="entity-group-totals-row">
                              <td className="select-col"></td>
                              {visibleFields.map((f) => (
                                <td key={f.name}>
                                  {f.type === "number" && (
                                    <>
                                      Total: {(groupNumericTotals[group.key][f.name] ?? 0).toLocaleString()}
                                    </>
                                  )}
                                </td>
                              ))}
                              <td></td>
                            </tr>
                          )}
                        </Fragment>
                        );
                      })
                    : visibleRecords.map(renderRow)}
                </tbody>
                {hasNumericVisibleField && (
                  <tfoot>
                    <tr className="entity-totals-row">
                      <th className="select-col"></th>
                      {visibleFields.map((f) => (
                        <th key={f.name}>
                          {f.type === "number" && (
                            <>
                              Total: {(numericFieldTotals[f.name] ?? 0).toLocaleString()}
                            </>
                          )}
                        </th>
                      ))}
                      <th></th>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
`;
}

/**
 * A single query box that searches every entity's records at once, then
 * lets a shortcut/click jump to that entity's tab -- the same feature
 * added to the Forge AI live preview, ported here so an exported app
 * isn't missing it just because it was born as a download. Reuses the
 * exact same `matchesSearch`/`recordDisplayLabel` EntityView.jsx already
 * exports, so a record that matches in a tab's own search matches here
 * too, by construction.
 */
function renderGlobalSearchJsx(): string {
  return `import { useEffect, useRef, useState } from "react";
import { listRecords } from "../api.js";
import { matchesSearch, recordDisplayLabel } from "./EntityView.jsx";

// Fetches every entity's own records once, then searches all of them using
// that same result set as matchesSearch's relatedRecords -- so a relation
// field's search match resolves to its real display label (e.g. "Dana
// Levi") instead of a raw foreign-key id, with no extra network calls
// beyond what searching every entity already required.
async function searchAllEntities(entities, query) {
  const settled = await Promise.allSettled(
    entities.map(async (entity) => {
      const { records } = await listRecords(entity.name);
      return [entity.name, records];
    }),
  );
  const recordsByEntity = {};
  for (const result of settled) {
    if (result.status === "fulfilled") {
      const [name, records] = result.value;
      recordsByEntity[name] = records;
    }
  }
  const results = entities
    .map((entity) => {
      const records = recordsByEntity[entity.name];
      if (!records) return null;
      const matches = records.filter((r) => matchesSearch(r, entity.fields, query, recordsByEntity));
      if (matches.length === 0) return null;
      return { entityName: entity.name, entityLabel: entity.label, totalMatches: matches.length, sample: matches.slice(0, 5) };
    })
    .filter((r) => r !== null);
  const failures = settled.filter((r) => r.status === "rejected");
  return { results, failures, recordsByEntity };
}

// Renders the already-fetched results as a plain, shareable text snapshot --
// same "plain text, not a PDF" reasoning the live preview's own
// searchReport.ts uses for its Copy/Download buttons, which the exported
// app's own GlobalSearch never had at all.
function formatGlobalSearchReport(results, entities, query) {
  const lines = [\`Search everything — "\${query}"\`, \`Generated \${new Date().toLocaleString()}\`, ""];
  if (results.length === 0) {
    lines.push("No matching results in any entity.");
    return lines.join("\\n").trimEnd();
  }
  for (const result of results) {
    const entity = entities.find((e) => e.name === result.entityName);
    lines.push(\`\${result.entityLabel} — \${result.totalMatches} results\`);
    for (const record of result.sample) {
      lines.push(\`- \${entity ? recordDisplayLabel(entity, record) : "#" + record.id}\`);
    }
    const remaining = result.totalMatches - result.sample.length;
    if (remaining > 0) lines.push(\`…and \${remaining} more\`);
    lines.push("");
  }
  return lines.join("\\n").trimEnd();
}

// Recent queries submitted to Global Search, persisted across reloads. This
// single-tenant exported app has no project id to scope by (unlike the live
// preview's own recentSearches.ts, keyed per project) and there's only one
// Global Search in the whole app, so this is a single flat list rather than
// a store keyed by entity name like EntityView's own recent-searches store.
const GLOBAL_SEARCH_RECENT_SEARCHES_STORAGE_KEY = "forge_global_search_recent_searches";
const GLOBAL_SEARCH_MAX_RECENT_SEARCHES = 5;
function getGlobalSearchRecentSearches() {
  try {
    const raw = localStorage.getItem(GLOBAL_SEARCH_RECENT_SEARCHES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
function writeGlobalSearchRecentSearches(list) {
  try {
    localStorage.setItem(GLOBAL_SEARCH_RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
}
function addGlobalSearchRecentSearch(query) {
  const trimmed = query.trim();
  const existing = getGlobalSearchRecentSearches();
  if (!trimmed) return existing;
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, GLOBAL_SEARCH_MAX_RECENT_SEARCHES);
  writeGlobalSearchRecentSearches(next);
  return next;
}
function removeGlobalSearchRecentSearch(query) {
  const next = getGlobalSearchRecentSearches().filter((q) => q.toLowerCase() !== query.toLowerCase());
  writeGlobalSearchRecentSearches(next);
  return next;
}
function clearGlobalSearchRecentSearches() {
  writeGlobalSearchRecentSearches([]);
}

/**
 * Down/Up move a highlight across the result groups (not individual
 * records -- jumping always lands on an entity tab), clamped at the
 * first/last group rather than wrapping, and Enter jumps to whichever
 * group is highlighted. Enter with nothing highlighted still submits the
 * form as a normal search.
 */
export function GlobalSearch({ entities, onClose, onJumpToEntity, onJumpToRecord }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [copyStatus, setCopyStatus] = useState("idle");
  const [recentSearches, setRecentSearches] = useState(() => getGlobalSearchRecentSearches());
  // A group's "and N more" text used to be a dead end -- the extra matches
  // were real (totalMatches said so) but nothing on screen could reach them
  // short of switching tabs and re-filtering the same query by hand. Keyed
  // by entityName so expanding one group's "Show all" never affects
  // another's, mirroring the live preview's own GlobalSearchPanel.tsx.
  const [expandedSamples, setExpandedSamples] = useState({});
  const [showAllLoading, setShowAllLoading] = useState(() => new Set());
  // Bumped once per runSearch call, so a stale search whose network round
  // trip just happens to take longer than a newer one's can recognize
  // itself as superseded and skip applying its now-outdated results.
  const searchRequestId = useRef(0);
  const resultsContainerRef = useRef(null);
  // Every entity's own records from the most recently *completed* search,
  // keyed by entity name -- reused as matchesSearch's relatedRecords so
  // handleShowAll's own relation-field matches resolve to the real display
  // label, not a raw foreign-key id, with zero extra network calls.
  const lastRecordsByEntityRef = useRef({});

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  // Mirrors EntityView's own focusedRowId scroll effect: with more result
  // groups than fit on screen, arrow-key navigation could move the
  // highlight out of view with zero visual cue.
  useEffect(() => {
    if (selectedIndex == null) return;
    const group = resultsContainerRef.current && resultsContainerRef.current.querySelector(\`[data-group-index="\${selectedIndex}"]\`);
    if (group && group.scrollIntoView) group.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedIndex]);

  async function runSearch(q) {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      setSelectedIndex(null);
      return;
    }
    const requestId = ++searchRequestId.current;
    setLoading(true);
    setError(null);
    const { results: succeeded, failures, recordsByEntity } = await searchAllEntities(entities, q);
    if (searchRequestId.current !== requestId) return;
    lastRecordsByEntityRef.current = recordsByEntity;
    setResults(succeeded);
    setSearched(true);
    setSelectedIndex(null);
    if (failures.length > 0) {
      setError(
        failures.length === entities.length
          ? failures[0].reason.message
          : \`Search failed for \${failures.length} of \${entities.length} entities. Results below are from the ones that succeeded.\`,
      );
    }
    setLoading(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setExpandedSamples({});
    setRecentSearches(addGlobalSearchRecentSearch(query));
    await runSearch(query);
  }

  async function handleRecentSearchClick(q) {
    setQuery(q);
    setExpandedSamples({});
    setRecentSearches(addGlobalSearchRecentSearch(q));
    await runSearch(q);
  }

  // Fetches this one entity's records again (a cheap, idempotent GET -- the
  // same request runSearch already made) and re-filters them with no
  // sample cap, so "Show all" reveals every real match instead of just the
  // first 5. Keyed per entity in expandedSamples rather than reusing
  // results in place, so a still-collapsed group elsewhere is untouched.
  // Guarded by searchRequestId the same way runSearch guards its own
  // network round trip: without it, a new search started while this fetch
  // is still in flight resolves into expandedSamples anyway, merging a
  // sample matched against the OLD query into results now showing the NEW
  // one.
  async function handleShowAll(entityName) {
    const entity = entities.find((e) => e.name === entityName);
    if (!entity) return;
    const requestId = searchRequestId.current;
    setShowAllLoading((prev) => new Set(prev).add(entityName));
    try {
      const { records } = await listRecords(entityName);
      if (searchRequestId.current !== requestId) return;
      const full = records.filter((r) => matchesSearch(r, entity.fields, query, lastRecordsByEntityRef.current));
      setExpandedSamples((prev) => ({ ...prev, [entityName]: full }));
    } finally {
      setShowAllLoading((prev) => {
        const next = new Set(prev);
        next.delete(entityName);
        return next;
      });
    }
  }

  function handleRemoveRecentSearch(q) {
    setRecentSearches(removeGlobalSearchRecentSearch(q));
  }

  function handleClearRecentSearches() {
    clearGlobalSearchRecentSearches();
    setRecentSearches([]);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatGlobalSearchReport(results, entities, query));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  function handleDownload() {
    const text = formatGlobalSearchReport(results, entities, query);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "search-results.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleInputKeyDown(e) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev === null ? results.length - 1 : Math.max(prev - 1, 0)));
    } else if (e.key === "Enter" && selectedIndex !== null) {
      e.preventDefault();
      onJumpToEntity(results[selectedIndex].entityName);
    }
  }

  return (
    <div className="search-overlay">
      <div className="search-panel">
        <div className="search-header">
          <h2>🔍 Search everything</h2>
          <div className="search-header-actions">
            {!loading && results.length > 0 && (
              <button type="button" className="small" onClick={handleCopy} aria-live="polite" aria-atomic="true">
                {copyStatus === "copied" ? "Copied!" : copyStatus === "failed" ? "Copy failed" : "Copy"}
              </button>
            )}
            {!loading && results.length > 0 && (
              <button type="button" className="small" onClick={handleDownload}>Download</button>
            )}
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <p className="muted small">Searches across every entity at once, not just the open tab.</p>

        <form className="global-search-form" onSubmit={handleSubmit}>
          <input
            type="text"
            autoFocus
            className="global-search-input"
            placeholder="Type to search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <button type="submit" disabled={!query.trim()}>Search</button>
        </form>

        {error && (
          <div className="error-retry-row">
            <p className="error" role="status">{error}</p>
            <button type="button" onClick={() => runSearch(query)}>
              Try again
            </button>
          </div>
        )}
        {loading && <p className="muted" role="status">Loading…</p>}
        {!loading && !searched && !error && (
          <>
            <p className="muted">Start typing to search.</p>
            {recentSearches.length > 0 && (
              <div className="global-search-recent">
                <div className="global-search-recent-header">
                  <span className="muted small">Recent searches</span>
                  <button type="button" className="link-button small" onClick={handleClearRecentSearches}>
                    Clear
                  </button>
                </div>
                <div className="chips">
                  {recentSearches.map((q) => (
                    <span className="chip chip-removable" key={q}>
                      <button type="button" className="chip-text" onClick={() => handleRecentSearchClick(q)}>
                        {q}
                      </button>
                      <button
                        type="button"
                        className="chip-remove"
                        title={\`Remove "\${q}"\`}
                        aria-label={\`Remove "\${q}"\`}
                        onClick={() => handleRemoveRecentSearch(q)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {!loading && searched && results.length === 0 && !error && <p className="muted">No matching results in any entity.</p>}
        {!loading && results.length > 0 && <p className="muted small">↑↓ to navigate results, Enter to jump to a tab</p>}

        {!loading && results.length > 0 && (
          <div className="global-search-results" ref={resultsContainerRef}>
            {results.map((result, i) => {
              const displayed = expandedSamples[result.entityName] ?? result.sample;
              const remaining = result.totalMatches - displayed.length;
              return (
                <div key={result.entityName} data-group-index={i} className={i === selectedIndex ? "global-search-group global-search-group-selected" : "global-search-group"}>
                  <div className="global-search-group-header">
                    <span className="global-search-entity-label">{result.entityLabel}</span>
                    <span className="muted small">{result.totalMatches} results</span>
                    <button type="button" className="small" onClick={() => onJumpToEntity(result.entityName)}>Go to tab</button>
                  </div>
                  <ul className="global-search-hits">
                    {displayed.map((record) => (
                      <li key={record.id}>
                        <button
                          type="button"
                          className="link-button global-search-hit-button"
                          onClick={() => onJumpToRecord(result.entityName, record.id)}
                        >
                          {recordDisplayLabel(entities.find((e) => e.name === result.entityName), record)}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {remaining > 0 && (
                    <button
                      type="button"
                      className="link-button small global-search-show-all"
                      disabled={showAllLoading.has(result.entityName)}
                      onClick={() => handleShowAll(result.entityName)}
                    >
                      {showAllLoading.has(result.entityName) ? "Loading…" : \`Show all \${remaining} more\`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
`;
}

function renderEntityJsx(entity: Entity): string {
  const fieldsJson = JSON.stringify(
    entity.fields.map((f) => ({
      name: f.name,
      label: f.label ?? f.name,
      type: f.type,
      required: !!f.required,
      enumValues: f.enumValues ?? null,
      enumLabels: f.enumLabels ?? null,
      relationTo: f.relationTo ?? null,
    })),
    null,
    2,
  );

  return `import { EntityView } from "../components/EntityView.jsx";

// This entity's own field list, as real editable code — not fetched from
// a schema at runtime. Add or change a field here (and in the matching
// entry of server.js's ENTITIES array) to change this entity's form/table.
export const entity = {
  name: ${JSON.stringify(entity.name)},
  label: ${JSON.stringify(entity.label ?? entity.name)},
  fields: ${fieldsJson},
};

export default function View({ highlightRecordId, onHighlightHandled, onJumpToRecord, onRecordCountChange }) {
  return (
    <EntityView
      entity={entity}
      highlightRecordId={highlightRecordId}
      onHighlightHandled={onHighlightHandled}
      onJumpToRecord={onJumpToRecord}
      onRecordCountChange={onRecordCountChange}
    />
  );
}
`;
}

/**
 * Mirrors the live Forge AI preview's own theme/theme.ts exactly (same
 * storage key, same fallback order: explicit stored choice, then the
 * system's prefers-color-scheme, then light) -- the exported app deserves
 * the same dark mode the live preview already has, not a lesser copy.
 */
function renderThemeJs(): string {
  return `export const THEME_STORAGE_KEY = "app.theme";

export function detectInitialTheme(storedValue, prefersDark) {
  if (storedValue === "light" || storedValue === "dark") return storedValue;
  return prefersDark ? "dark" : "light";
}
`;
}

function renderAppJsx(project: Project): string {
  const entities = project.spec.entities;
  const imports = entities
    .map((e) => `import ${e.name}View, { entity as ${e.name}Entity } from "./entities/${e.name}.jsx";`)
    .join("\n");
  const entries = entities
    .map(
      (e) =>
        `  { name: ${JSON.stringify(e.name)}, label: ${JSON.stringify(e.label ?? e.name)}, View: ${e.name}View, fields: ${e.name}Entity.fields },`,
    )
    .join("\n");

  return `import { useEffect, useMemo, useState } from "react";
import { listEntityCounts } from "./api.js";
import { GlobalSearch } from "./components/GlobalSearch.jsx";
import { THEME_STORAGE_KEY, detectInitialTheme } from "./theme.js";
${imports}

const ENTITIES = [
${entries}
];

// The app title is a plain JS string rendered through a JSX expression
// (not embedded as literal JSX text) so it's safe however it's spelled.
const TITLE = ${JSON.stringify(project.name)};

// The entity-tab bar's own drag-reordered position, persisted so it
// survives a reload -- mirrors the live Forge AI preview's own
// entityTabOrder.ts, but keyed as one flat array since an exported app only
// ever has the one project baked in (no per-project scoping needed here).
const ENTITY_TAB_ORDER_STORAGE_KEY = "forge_entity_tab_order";
function getEntityTabOrder() {
  try {
    const raw = localStorage.getItem(ENTITY_TAB_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
function setEntityTabOrder(order) {
  try {
    localStorage.setItem(ENTITY_TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
  return order;
}

// Applies a persisted (possibly stale) tab order to ENTITIES' current real
// list: an entity the order mentions keeps its persisted relative position,
// and any entity the order doesn't mention (a newly added entity, or an
// order saved before it existed) is appended at the end in ENTITIES' own
// original order. Mirrors the live preview's own applyColumnOrder
// (columnOrder.ts) -- an entity has a name field just like a table field does.
function applyEntityTabOrder(entities, order) {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const ordered = [];
  for (const name of order) {
    const entity = byName.get(name);
    if (entity) {
      ordered.push(entity);
      byName.delete(name);
    }
  }
  for (const entity of entities) {
    if (byName.has(entity.name)) ordered.push(entity);
  }
  return ordered;
}

// Computes the new full entity-name order after dragging sourceName's tab to
// just before targetName's. Mirrors the live preview's own reorderColumns
// (columnOrder.ts) verbatim.
function reorderEntityTabs(order, sourceName, targetName) {
  if (sourceName === targetName) return order;
  if (!order.includes(sourceName) || !order.includes(targetName)) return order;
  const withoutSource = order.filter((name) => name !== sourceName);
  const targetIndex = withoutSource.indexOf(targetName);
  const result = [...withoutSource];
  result.splice(targetIndex, 0, sourceName);
  return result;
}

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function prefersDarkFromSystem() {
  if (typeof window === "undefined" || !window.matchMedia) return undefined;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function App() {
  const [active, setActive] = useState(ENTITIES[0]?.name ?? null);
  const [showSearch, setShowSearch] = useState(false);
  const [highlightRecordId, setHighlightRecordId] = useState(null);
  const [theme, setTheme] = useState(() => detectInitialTheme(readStoredTheme(), prefersDarkFromSystem()));
  const [entityCounts, setEntityCounts] = useState({});
  const [entityTabOrder, setEntityTabOrderState] = useState(() => getEntityTabOrder());
  const [draggedEntityTab, setDraggedEntityTab] = useState(null);
  const [dragOverEntityTab, setDragOverEntityTab] = useState(null);
  const activeEntity = ENTITIES.find((e) => e.name === active);
  const orderedEntities = useMemo(() => applyEntityTabOrder(ENTITIES, entityTabOrder), [entityTabOrder]);

  // Dragging a tab to just before another one's -- without this, the
  // exported app's nav always mirrored spec.entities' fixed generation
  // order with no way to put the screen you actually use most first, unlike
  // the live preview's own draggable tab bar. Mirrors App.tsx's own
  // handleReorderEntityTab.
  function handleReorderEntityTab(targetName) {
    setDragOverEntityTab(null);
    if (!draggedEntityTab || draggedEntityTab === targetName) return;
    const fullOrder = orderedEntities.map((e) => e.name);
    setEntityTabOrderState(setEntityTabOrder(reorderEntityTabs(fullOrder, draggedEntityTab, targetName)));
    setDraggedEntityTab(null);
  }

  // One cheap COUNT(*) per entity, fetched once on load, so the nav's own
  // record-count badges match the live Forge AI preview's own entity-tabs
  // badges (round 305). A failed fetch here is swallowed -- the badge is a
  // nice-to-have, not worth its own error state.
  useEffect(() => {
    listEntityCounts()
      .then(({ counts }) => setEntityCounts(counts))
      .catch(() => {});
  }, []);

  // Ctrl/Cmd+K opens global search from anywhere in the app (the same
  // command-palette convention Forge AI's own live preview uses), and
  // Escape closes it.
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      if (e.key === "Escape") {
        setShowSearch(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Mirrors the live Forge AI preview's own ThemeProvider: the choice is
  // applied via a data-theme attribute on <html> (so plain CSS variables
  // can react to it) and persisted so a reload keeps the same theme.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
    }
  }, [theme]);

  return (
    <div className="app">
      <div className="app-header">
        <h1>{TITLE}</h1>
        <div className="app-header-actions">
          <button
            type="button"
            className="theme-switch"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button type="button" className="search-trigger" onClick={() => setShowSearch(true)}>
            🔍 Search <span className="shortcut-hint">Ctrl+K</span>
          </button>
          <a className="backup-all-btn" href="/api/backup" download="backup.zip">
            ⬇️ Backup All Data
          </a>
        </div>
      </div>
      <nav>
        {orderedEntities.map((e) => (
          <button
            key={e.name}
            className={e.name === active ? "active" : dragOverEntityTab === e.name ? "drag-over" : ""}
            draggable
            onDragStart={() => setDraggedEntityTab(e.name)}
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragOverEntityTab(e.name);
            }}
            onDragLeave={() => setDragOverEntityTab((prev) => (prev === e.name ? null : prev))}
            onDrop={(ev) => {
              ev.preventDefault();
              handleReorderEntityTab(e.name);
            }}
            onClick={() => setActive(e.name)}
          >
            {e.label}
            {entityCounts[e.name] != null && <span className="tab-count">{entityCounts[e.name]}</span>}
          </button>
        ))}
      </nav>
      {activeEntity && (
        <activeEntity.View
          highlightRecordId={highlightRecordId}
          onHighlightHandled={() => setHighlightRecordId(null)}
          onJumpToRecord={(name, recordId) => {
            setActive(name);
            setHighlightRecordId(recordId);
          }}
          onRecordCountChange={(name, count) =>
            setEntityCounts((prev) => (prev[name] === count ? prev : { ...prev, [name]: count }))
          }
        />
      )}
      {showSearch && (
        <GlobalSearch
          entities={ENTITIES}
          onClose={() => setShowSearch(false)}
          onJumpToEntity={(name) => {
            setActive(name);
            setShowSearch(false);
          }}
          onJumpToRecord={(name, recordId) => {
            setActive(name);
            setHighlightRecordId(recordId);
            setShowSearch(false);
          }}
        />
      )}
    </div>
  );
}
`;
}

function renderStylesCss(): string {
  return `:root {
  color-scheme: light;
  --bg: #f6f2ea;
  --surface: #ffffff;
  --surface-muted: #faf7f1;
  --surface-subtle: #fdfbf7;
  --text: #241f19;
  --muted: #83786a;
  --accent: #d9622b;
  --accent-contrast: #ffffff;
  --accent-soft: #fbe4d4;
  --border: #e6ddcc;
  --border-soft: #efe8da;
  --danger: #c0392b;
  --danger-soft: #fbe6e2;
  --success: #2e8b57;
  --success-soft: #e2f2e8;
  --warning: #a66a06;
  --warning-soft: #faf0d7;
  --steel: #4c5b6a;
  --steel-soft: #e9edf0;
  --shadow-sm: 0 1px 2px rgba(36,31,25,0.06);
  --shadow-md: 0 8px 24px rgba(36,31,25,0.08);
  --shadow-lg: 0 8px 24px rgba(36,31,25,0.12);
  --shadow-xl: 0 12px 32px rgba(36,31,25,0.2);
  --overlay: rgba(36,31,25,0.45);
}
/* Same fallback order as detectInitialTheme in theme.js: an explicit
   data-theme wins, otherwise the OS-level preference decides (until
   the visitor picks one explicitly via the toggle in the header). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #17140f;
    --surface: #262019;
    --surface-muted: #201c16;
    --surface-subtle: #201c16;
    --text: #f3ede2;
    --muted: #a89d8c;
    --accent: #ef7d43;
    --accent-contrast: #1c1108;
    --accent-soft: #3a2618;
    --border: #3a3225;
    --border-soft: #2c271e;
    --danger: #e5766a;
    --danger-soft: #3a2019;
    --success: #6bbf94;
    --success-soft: #1c2e24;
    --warning: #e0b34d;
    --warning-soft: #3a2f14;
    --steel: #9db3c6;
    --steel-soft: #262b30;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
    --shadow-md: 0 8px 24px rgba(0,0,0,0.4);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.4);
    --shadow-xl: 0 12px 32px rgba(0,0,0,0.5);
    --overlay: rgba(0,0,0,0.6);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #17140f;
  --surface: #262019;
  --surface-muted: #201c16;
  --surface-subtle: #201c16;
  --text: #f3ede2;
  --muted: #a89d8c;
  --accent: #ef7d43;
  --accent-contrast: #1c1108;
  --accent-soft: #3a2618;
  --border: #3a3225;
  --border-soft: #2c271e;
  --danger: #e5766a;
  --danger-soft: #3a2019;
  --success: #6bbf94;
  --success-soft: #1c2e24;
  --warning: #e0b34d;
  --warning-soft: #3a2f14;
  --steel: #9db3c6;
  --steel-soft: #262b30;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 8px 24px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.4);
  --shadow-xl: 0 12px 32px rgba(0,0,0,0.5);
  --overlay: rgba(0,0,0,0.6);
}
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
.app { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 20px; }
nav { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 20px; }
nav button { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
nav button.active { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
nav button.drag-over { border-color: var(--accent); border-style: dashed; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: var(--shadow-md); }
form.record-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border-soft); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--muted); min-width: 0; }
input, select, textarea { font: inherit; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; width: 100%; background: var(--surface); color: var(--text); }
input[type="checkbox"] { width: auto; }
button[type="submit"], .btn { padding: 9px 18px; border-radius: 8px; border: none; background: var(--accent); color: var(--accent-contrast); font: inherit; font-weight: 600; cursor: pointer; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: start; padding: 8px 10px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
.row-actions button { margin-inline-start: 4px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
.muted { color: var(--muted); font-size: 13px; }
.error { color: var(--danger); }
.error-retry-row { display: flex; align-items: center; gap: 10px; }
.error-retry-row .error { margin: 0; }
.error-retry-row button { padding: 5px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.entity-undo-toast { display: flex; align-items: center; gap: 10px; background: var(--accent-soft); border: 1px solid var(--accent); color: var(--text); padding: 8px 14px; border-radius: 8px; margin: 0 0 16px; }
.link-button { background: none; border: none; color: var(--accent); padding: 0; text-decoration: underline; font: inherit; font-weight: 600; cursor: pointer; }
.cell-link { color: var(--accent); text-decoration: underline; }
.link-button:hover { opacity: 0.85; }
.entity-search { max-width: 280px; margin-bottom: 14px; }
.sort-header { background: none; border: none; padding: 0; margin: 0; color: inherit; font: inherit; cursor: pointer; }
.sort-header:hover { color: var(--accent); }
.sort-priority { display: inline-flex; align-items: center; justify-content: center; min-width: 15px; height: 15px; margin-inline-start: 3px; padding: 0 3px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-deep); font-size: 10px; font-weight: 700; vertical-align: middle; }
.resizable-col { position: relative; }
.resizable-col-drag-over { background: var(--accent-soft); }
.column-resize-handle { position: absolute; top: 0; bottom: 0; inset-inline-end: 0; width: 6px; cursor: col-resize; user-select: none; touch-action: none; z-index: 1; }
.entity-table-resized { table-layout: fixed; }
.entity-table-resized th, .entity-table-resized td { overflow: hidden; text-overflow: ellipsis; }
.cell-inline-editable { cursor: text; }
.cell-inline-editable:hover { background: var(--accent-soft); }
.cell-editing input, .cell-editing select, .cell-editing textarea { width: 100%; }
.badge { display: inline-block; padding: 3px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.badge-positive { background: var(--success-soft); color: var(--success); }
.badge-negative { background: var(--danger-soft); color: var(--danger); }
.badge-neutral { background: var(--steel-soft); color: var(--steel); }
.date-overdue { color: var(--danger); font-weight: 700; }
.date-due-soon { color: var(--warning); font-weight: 700; }
.bool-yes { color: var(--success); font-weight: 700; }
.empty-state { padding: 32px 16px; text-align: center; color: var(--muted); background: var(--surface-subtle); border: 1px dashed var(--border); border-radius: 10px; }
.entity-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.entity-toolbar .entity-search { margin-bottom: 0; flex: 1; }
.entity-search-recent { margin-top: -6px; margin-bottom: 14px; }
.entity-search-recent-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-block; padding: 5px 14px; border-radius: 999px; background: var(--surface-muted); color: var(--text); border: 1px solid var(--border); font-size: 13.5px; font-weight: 500; }
.chip-removable { display: inline-flex; align-items: center; gap: 6px; }
.chip-text { cursor: pointer; border-radius: 4px; transition: opacity 0.12s ease; }
.chip-text:hover { opacity: 0.7; }
.chip-remove { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: none; border-radius: 999px; background: transparent; color: var(--muted); font-size: 14px; line-height: 1; cursor: pointer; }
.chip-remove:hover { background: var(--surface-muted); color: var(--text); }
.entity-status-filter, .entity-group-by { max-width: 200px; margin-bottom: 0; flex-shrink: 0; }
.entity-group-header-row td { background: var(--surface-subtle); font-weight: 600; padding: 6px 10px; }
.entity-group-totals-row td { background: var(--surface-subtle); border-bottom: 1px solid var(--border); font-weight: 600; }
.entity-group-toggle { background: none; border: none; cursor: pointer; padding: 0 4px; font-size: 12px; color: inherit; }
.tab-count { display: inline-block; margin-inline-start: 6px; padding: 1px 7px; border-radius: 999px; font-size: 11.5px; font-weight: 700; line-height: 1.5; background: var(--steel-soft); color: var(--steel); }
nav button.active .tab-count { background: rgba(255, 255, 255, 0.25); color: inherit; }
.view-toggle { display: flex; gap: 4px; padding: 3px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; flex-shrink: 0; }
.view-toggle-btn { padding: 6px 12px; border-radius: 6px; border: none; background: transparent; color: var(--muted); font-size: 13px; font-weight: 600; cursor: pointer; }
.view-toggle-btn-active { background: var(--accent); color: var(--accent-contrast); }
.board-scroll { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px; }
.board-column { flex: 0 0 240px; background: var(--surface-muted); border: 1px solid var(--border-soft); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.board-column-drag-over { background: var(--accent-soft); border-color: var(--accent); }
.board-column-other { border-style: dashed; }
.board-column-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--border-soft); }
.board-column-header-info { display: flex; align-items: center; gap: 6px; }
.board-column-toggle { background: none; border: none; cursor: pointer; padding: 0 4px; font-size: 12px; color: inherit; }
.board-add-card-btn { background: none; border: none; padding: 0 4px; font-size: 16px; font-weight: 600; opacity: 0.5; cursor: pointer; line-height: 1; }
.board-add-card-btn:hover { opacity: 1; color: var(--accent); }
.board-card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px 12px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 6px; }
.board-card-move-error { border-color: var(--danger); background: var(--danger-soft); }
.board-card-field { display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; }
.board-card-move { margin-top: 4px; }
.calendar-view { display: flex; flex-direction: column; gap: 10px; }
.calendar-nav { display: flex; align-items: center; justify-content: center; gap: 16px; }
.calendar-nav button { padding: 4px 12px; font-size: 16px; line-height: 1; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
.calendar-today-btn { font-size: 13px; }
.calendar-today-btn:disabled { opacity: 0.55; cursor: default; }
.calendar-month-label { font-weight: 600; min-width: 140px; text-align: center; }
.calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.calendar-weekday { text-align: center; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; padding-bottom: 4px; }
.calendar-day { min-height: 76px; background: var(--surface-muted); border: 1px solid var(--border-soft); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
.calendar-day-outside { opacity: 0.4; }
.calendar-day-clickable { cursor: pointer; }
.calendar-day-clickable:hover { border-color: var(--accent); background: var(--accent-soft); }
.calendar-day-drag-over { border-color: var(--accent); background: var(--accent-soft); }
.calendar-day-today { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.calendar-day-number { font-size: 12px; font-weight: 600; color: var(--muted); }
.calendar-day-today .calendar-day-number { color: var(--accent); font-weight: 700; }
.calendar-day-records { display: flex; flex-direction: column; gap: 3px; }
.calendar-record-chip { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 4px; padding: 2px 5px; font-size: 11.5px; text-align: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: grab; color: var(--text); }
.calendar-record-chip:hover { background: var(--bg); }
.calendar-record-chip:active { cursor: grabbing; }
.calendar-record-chip-move-error { background: var(--danger-soft); border-color: var(--danger); }
.calendar-record-more { font-size: 11px; color: var(--muted); padding: 2px 5px; background: none; border: none; text-align: start; cursor: pointer; font: inherit; }
.calendar-record-more:hover { color: var(--text); text-decoration: underline; }
.csv-export-btn, .ics-export-btn, .copy-records-btn { flex-shrink: 0; padding: 8px 14px; font-size: 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.csv-export-btn:hover:not(:disabled), .ics-export-btn:hover:not(:disabled), .copy-records-btn:hover:not(:disabled) { background: var(--bg); }
.csv-export-btn:disabled, .ics-export-btn:disabled, .copy-records-btn:disabled { opacity: 0.55; cursor: default; }
.columns-menu-wrapper { position: relative; flex-shrink: 0; }
.columns-menu-btn { padding: 8px 14px; font-size: 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.columns-menu-btn:hover { background: var(--bg); }
.columns-menu-panel { position: absolute; z-index: 20; top: calc(100% + 6px); inset-inline-end: 0; min-width: 180px; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-lg); }
.columns-menu-item { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--text); }
.csv-import-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 14px; }
.csv-import-label { display: inline-flex; align-items: center; padding: 8px 14px; font-size: 13px; font-weight: 600; border-radius: 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border); cursor: pointer; font: inherit; }
.csv-import-label:has(input:disabled) { opacity: 0.55; cursor: default; }
.csv-import-label:hover { background: var(--bg); }
.import-errors-toggle { padding: 8px 14px; font-size: 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.import-errors-toggle:hover { background: var(--bg); }
.csv-import-errors { margin: -6px 0 14px; padding-inline-start: 20px; color: var(--danger); font-size: 13px; display: flex; flex-direction: column; gap: 3px; }
.bulk-actions-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 8px 12px; margin-bottom: 8px; background: var(--surface-muted); border: 1px solid var(--border-soft); border-radius: 8px; font-size: 13.5px; }
.bulk-edit-field-label { display: flex; align-items: center; gap: 6px; }
.select-col { width: 1%; white-space: nowrap; }
.entity-totals-row th { background: var(--surface-subtle); border-top: 2px solid var(--border); font-weight: 700; text-align: start; }
.app-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
.app-header h1 { margin: 0; }
.app-header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.theme-switch { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 15px; line-height: 1; }
.theme-switch:hover { background: var(--bg); }
.search-trigger { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.search-trigger:hover { background: var(--bg); }
.backup-all-btn { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; font-size: 14px; display: inline-block; }
.backup-all-btn:hover { background: var(--bg); }
.shortcut-hint { margin-inline-start: 6px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; font-size: 0.7rem; font-family: monospace; color: var(--muted); }
.search-overlay { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: flex-start; justify-content: center; padding: 60px 16px; z-index: 20; }
.search-panel { background: var(--surface); border-radius: 14px; padding: 20px; width: 100%; max-width: 560px; max-height: 80vh; overflow-y: auto; box-shadow: var(--shadow-xl); }
.search-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.search-header h2 { margin: 0; font-size: 20px; }
.search-header-actions { display: flex; align-items: center; gap: 8px; }
.global-search-form { display: flex; gap: 8px; margin: 12px 0; }
.global-search-input { flex: 1; }
.global-search-recent { margin-top: 10px; }
.global-search-recent-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.global-search-results { display: flex; flex-direction: column; gap: 16px; }
.global-search-group { border-top: 1px solid var(--border-soft); padding-top: 12px; border-inline-start: 3px solid transparent; padding-inline-start: 9px; margin-inline-start: -12px; }
.global-search-group-selected { border-inline-start-color: var(--accent); background: var(--accent-soft); border-radius: 0 8px 8px 0; }
.global-search-group-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.global-search-entity-label { font-weight: 700; }
.global-search-group-header button.small { margin-inline-start: auto; padding: 4px 10px; font-size: 13px; }
.global-search-hits { margin: 10px 0 0; padding-inline-start: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14.5px; }
.global-search-show-all { margin-top: 6px; font-size: 13px; }
.global-search-hit-button { display: block; width: 100%; text-align: start; white-space: normal; }
.record-row-highlighted, .record-row-highlighted:hover { background: var(--accent-soft); transition: background 1.5s ease; }
.record-row-focused { outline: 2px solid var(--accent); outline-offset: -2px; }
.record-row-move-error, .record-row-move-error:hover { background: var(--danger-soft); transition: background 2s ease; }
`;
}

export function generateExportFiles(project: Project): { path: string; content: string }[] {
  for (const entity of project.spec.entities) {
    assertSafe(entity.name, "entity");
    for (const field of entity.fields) {
      assertSafe(field.name, "field");
    }
  }

  const entityFiles = project.spec.entities.map((entity) => ({
    path: `web/src/entities/${entity.name}.jsx`,
    content: renderEntityJsx(entity),
  }));

  return [
    { path: "package.json", content: renderPackageJson(project) },
    { path: "README.md", content: renderReadme(project) },
    { path: "render.yaml", content: renderRenderYaml(project) },
    { path: "vite.config.js", content: renderViteConfig() },
    { path: "server.js", content: renderServerJs(project) },
    { path: "web/index.html", content: renderWebIndexHtml(project) },
    // Under web/public/, not web/src/ -- Vite's default publicDir (relative
    // to the "web" root vite.config.js declares) copies these verbatim into
    // dist/ at build time, so they end up served at exactly the root paths
    // (/manifest.json, /icon.svg, /sw.js) index.html/main.jsx reference,
    // both in `vite dev` and after a real `vite build`.
    { path: "web/public/manifest.json", content: renderManifestJson(project) },
    { path: "web/public/icon.svg", content: renderIconSvg(project) },
    { path: "web/public/sw.js", content: renderServiceWorkerJs() },
    { path: "web/src/main.jsx", content: renderMainJsx() },
    { path: "web/src/App.jsx", content: renderAppJsx(project) },
    { path: "web/src/api.js", content: renderApiJs() },
    { path: "web/src/theme.js", content: renderThemeJs() },
    { path: "web/src/styles.css", content: renderStylesCss() },
    { path: "web/src/components/EntityView.jsx", content: renderEntityViewJsx(project) },
    { path: "web/src/components/GlobalSearch.jsx", content: renderGlobalSearchJsx() },
    ...entityFiles,
    { path: ".gitignore", content: "node_modules/\ndist/\ndata.sqlite\n" },
  ];
}
