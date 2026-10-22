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

function renderReadme(project: Project, exportedAt: Date): string {
  const entityList = project.spec.entities
    .map((e) => `- **${e.label ?? e.name}** (\`${e.name}\`) — \`web/src/entities/${e.name}.jsx\``)
    .join("\n");
  return `# ${project.name}

Exported from Forge AI on **${exportedAt.toISOString().slice(0, 10)}**. This
is a complete, standalone application — running it never talks back to
Forge AI, and there is nothing else to install beyond what's in
\`package.json\`. This is a snapshot taken at export time: if you keep
refining the live project in Forge AI afterward, re-export it to get those
later changes -- this folder does not update itself.

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

**Its storage isn't permanent on the free plan**: \`data.sqlite\` lives on
the service's own disk, and a redeploy or restart wipes it back to empty
-- fine for trying this out or sharing a demo link, but not for real data
you need to keep. For that, add a persistent Disk to the service in
Render's dashboard (or use one of Render's paid plans that includes one),
or point this app at an external database instead.

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
- \`data.sqlite\` — your data. Back it up like any file -- and if you
  deployed this on Render's free plan, back it up *before* every redeploy
  or restart, since that plan's disk doesn't survive one (see "Deploy it"
  above).

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

const ENTITY_NAMES = new Set(ENTITIES.map((e) => e.name));

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
    // Requires relationTo to actually name one of ENTITIES' own entities --
    // a dangling relationTo (e.g. the target entity got renamed/removed by a
    // later refine, leaving this field's own relationTo string stale) would
    // otherwise reference a table that's never created, which makes every
    // single insert into THIS table fail with "no such table", not just
    // writes that actually set the relation field. Mirrors migrate.ts's own
    // entityNames.has(field.relationTo) guard.
    const references = field.type === "relation" && field.relationTo && ENTITY_NAMES.has(field.relationTo) ? \` REFERENCES \${q(field.relationTo)}(id)\` : "";
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
  // Date.UTC(year, ...) silently adds 1900 to a year in 0-99 (legacy
  // ECMA-262 behavior), which would wrongly reject "0099-01-01" -- so the
  // date is built via setUTCFullYear, whose year argument has no such
  // special-casing, instead of passed through Date.UTC.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function coerce(field, value) {
  const isEmpty = value === undefined || value === null || value === "" || (typeof value === "string" && value.trim() === "");
  if (isEmpty) {
    if (field.required) throw new Error(\`Field "\${field.name}" is required\`);
    return null;
  }
  if (field.type === "number" || field.type === "relation") {
    if (Array.isArray(value)) throw new Error(\`Field "\${field.name}" must be a number\`);
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(\`Field "\${field.name}" must be a number\`);
    return n;
  }
  if (field.type === "boolean") {
    if (value === true || value === "true" || value === 1 || value === "1") return 1;
    if (value === false || value === "false" || value === 0 || value === "0") return 0;
    throw new Error(\`Field "\${field.name}" must be a boolean\`);
  }
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
      // PRAGMA foreign_keys (above) throws this exact message when a
      // relation field's value references a record that doesn't exist --
      // a relation picker is built from relatedRecords fetched earlier, so
      // submitting a create referencing a record deleted in the meantime
      // hits this exact constraint. Translated into a real, actionable 400
      // instead of the raw SQLite message, the same translation the live
      // Forge AI backend's own create route uses (and this same generated
      // server's own DELETE route already does for its own FK case below).
      if (err.message === "FOREIGN KEY constraint failed") {
        return res.status(400).json({ error: "This record references another record that no longer exists" });
      }
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
      // Same FK-constraint translation as the POST route above, for the
      // identical reason -- an edit's relation field can just as easily
      // reference a record deleted in the meantime as a create can.
      if (err.message === "FOREIGN KEY constraint failed") {
        return res.status(400).json({ error: "This record references another record that no longer exists" });
      }
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
// injection, CWE-1236), and a stored field can hold arbitrary text. A value
// that already starts with a literal "'" is also prefixed with one more
// "'" -- this backup CSV is re-importable via the general entity CSV
// import below, which shares its unescapeCsvGuard: without this, a value
// like "'-interesting" exports to the same bytes as the guard applied to
// "-interesting", so import can't tell them apart and drops the real
// apostrophe. Mirrors this file's own general-import csvEscape below,
// which already carries this fix.
function csvEscape(value) {
  const guarded = /^[=+\\-@\\t\\r']/.test(value) ? \`'\${value}\` : value;
  if (/[",\\r\\n]/.test(guarded)) {
    return \`"\${guarded.replace(/"/g, '""')}"\`;
  }
  return guarded;
}

// This file's own parseFileFieldValue (used by fieldDisplayValue etc.)
// lives in the EntityView.jsx template (renderEntityViewJsx), not here --
// this template (renderServerJs) is a separate generated file with no
// access to it, so backupFieldDisplayValue below needs its own minimal
// copy. Mirrors backup.ts's own server-side fileFieldDisplayName exactly
// (just the filename, no url/size/mimeType needed here).
function backupFileFieldDisplayName(value) {
  if (typeof value !== "string" || value === "") return "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // not a file descriptor -- treated as no file, same as an empty value
  }
  return "";
}

// Mirrors the exported app's own pickDisplayField above -- the last-resort
// fallback skips relation fields too, since a join/line-item entity with
// no name/title/text field would otherwise have this backup CSV show the
// *related* record's own raw internal id as this record's own label.
// Round 749: also skips "file" for the same reason -- would otherwise
// String() a file field's raw JSON upload descriptor as this record's
// own label. Round 762: the "first text field" step also tries
// "longtext" as a second choice (never a tiebreak over a real "text"
// field), the same free-text-kind convention this codebase's other
// text/longtext checks already follow.
// Round 795: the name-hint step itself also excludes "relation"/"file" --
// round 793 fixed this exact gap in every OTHER copy of this logic
// (apps/api/src/displayField.ts, apps/web/src/entityFormatting.ts, and
// this file's own pickDisplayField above) but missed this fourth,
// separately-named copy (BACKUP_DISPLAY_FIELD_HINTS vs
// DISPLAY_FIELD_NAME_HINTS) baked into the exported app's own /api/backup
// endpoint. A field can legitimately be named "title" while being a
// relation (Employee { title: relation->JobTitle }) or "name" while being
// a file (Document { name: file }), and without this exclusion that field
// won by name alone before the type-aware fallback steps below ever ran --
// leaking a relation's raw foreign-key id or a file's raw JSON upload
// descriptor (including its internal /api/uploads/... path) straight into
// a downloaded backup CSV's relation column.
const BACKUP_DISPLAY_FIELD_HINTS = ["name", "title"];
function backupPickDisplayField(entity) {
  const named = entity.fields.find((f) => BACKUP_DISPLAY_FIELD_HINTS.includes(f.name.toLowerCase()) && f.type !== "relation" && f.type !== "file");
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text") || entity.fields.find((f) => f.type === "longtext");
  if (firstText) return firstText;
  const firstDisplayable = entity.fields.find((f) => f.type !== "relation" && f.type !== "file");
  return firstDisplayable || entity.fields[0] || null;
}

function backupRecordDisplayLabel(entity, record) {
  const field = backupPickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return \`#\${record.id}\`;
  if (field && field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field && field.type === "enum") return (field.enumLabels && field.enumLabels[String(value)]) || String(value);
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
  // Round 749: this backup-specific sibling of fieldDisplayValue (below)
  // was left with this exact gap when file-field support first landed in
  // this file -- flagged then as "needs the whole feature decision
  // first" and deliberately deferred, per docs/roadmap.md. A file field's
  // raw stored value is a JSON descriptor ({"url":...,"name":...,...}),
  // not something a spreadsheet reader would recognize -- mirrors
  // fieldDisplayValue's own file branch, giving just the filename (via
  // backupFileFieldDisplayName above, since this template has no access
  // to the EntityView.jsx template's own parseFileFieldValue).
  if (field.type === "file") return backupFileFieldDisplayName(value);
  return String(value);
}

// Resolving a relation field used to records.find(...) a full linear
// scan of the related entity's whole record array, repeated once per
// row -- O(N*M) for N rows and M related records. A per-entity
// id->record Map (built once below, before any CSV is rendered) turns
// that lookup into O(1).
function entityToCsv(entity, records, recordIndexByEntity) {
  // Same label-collision gap recordsToCsv above is guarded against --
  // two fields on this entity can legally share a label.
  const labelOccurrences = {};
  for (const f of entity.fields) {
    const label = f.label || f.name;
    labelOccurrences[label] = (labelOccurrences[label] || 0) + 1;
  }
  const header = entity.fields
    .map((f) => {
      const label = f.label || f.name;
      const ambiguous = (labelOccurrences[label] || 0) > 1;
      return csvEscape(ambiguous ? label + " (" + f.name + ")" : label);
    })
    .join(",");
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

// An AI-generated spec's enum field can declare a duplicate value (nothing
// else in this app edits enumValues directly, so a stored project almost
// never gets one any other way). Every <select> built from enumValues keys
// its <option> by the raw value, so a duplicate renders the same choice
// twice; groupByField/groupRecordsByField below are worse -- each
// duplicate became its own column/group with the exact same
// records.filter(...) result, silently duplicating every matching
// record's card/row across two identical columns. De-duping here, once
// (order-preserving), fixes all three shapes of the same root cause.
function uniqueEnumValues(values) {
  return Array.from(new Set(values || []));
}

// Mirrors the live preview's own formatEntityRecordCount (entityFormatting.ts) --
// no translator here since this exported app has no i18n, so the English
// phrasing is hardcoded, matching entity.recordCount.all/.filtered's EN strings.
function formatEntityRecordCount(shown, total) {
  return shown === total ? \`\${total} records\` : \`\${shown} of \${total} records\`;
}

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
    // Mirrors the live preview's own entityRecentSearches.ts readStore(), and
    // this file's own getGlobalSearchRecentSearches a few hundred lines
    // below: a non-string entry (corrupted/foreign localStorage) must not
    // survive into the returned store, since addEntityRecentSearch/
    // removeEntityRecentSearch both call .toLowerCase() on every existing
    // entry unconditionally -- an un-filtered non-string there throws
    // uncaught from inside the search box's own onKeyDown handler.
    const store = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) store[key] = value.filter((v) => typeof v === "string");
    }
    return store;
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
// How many pixels an ArrowLeft/ArrowRight press widens or narrows a column via the resize handle's keyboard fallback.
const RESIZE_KEYBOARD_STEP = 20;
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
// Mirrors the live preview's own sortKeysPreference.ts isSortKey/
// isSortKeyArray exactly: unlike this file's own sibling stores just above
// (getPersistedGroupField's typeof check, getPersistedViewMode's enum
// check), this one had no per-element shape validation at all -- a
// malformed entry (foreign data sharing this origin-wide, unscoped key, or
// any other corruption) flowed straight into sortRecordsMulti's own
// destructuring loop over every sort key, which throws on a non-object
// entry, uncaught, with no error boundary anywhere in this app.
function isSortKey(value) {
  if (value === null || typeof value !== "object") return false;
  return typeof value.field === "string" && (value.direction === "asc" || value.direction === "desc");
}
function isSortKeyArray(value) {
  return Array.isArray(value) && value.every(isSortKey);
}
function readSortKeysStore() {
  try {
    const raw = localStorage.getItem(SORT_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isSortKeyArray(value)) store[key] = value;
    }
    return store;
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
// Drops any persisted filter naming a field entity.fields no longer has.
// The live preview's own round-493 fix only needed a live-refine
// re-validation effect, since its schema can change while a tab stays
// mounted -- this exported app's schema is frozen at export time, so no
// such effect runs here either, but round 509 already established a
// different, simpler reachability path for the same stale-localStorage
// shape: loading a newer export of the same project in a browser that
// still holds an older export's localStorage for that origin (keyed only
// by entity name, with no export-version dimension). A stale filter here
// doesn't just render a wrong value -- visibleRecords' own .every() check
// hides EVERY record once the filtered field no longer exists on any of
// them, with no visible "Clear filters" button to recover if that was the
// entity's only filterable field (round 570).
function sanitizeFieldFilters(filters, fields) {
  const fieldNames = new Set(fields.map((f) => f.name));
  const cleaned = {};
  for (const [name, value] of Object.entries(filters)) {
    if (fieldNames.has(name)) cleaned[name] = value;
  }
  return cleaned;
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

// Which grouped-table-view group keys are collapsed, per entity+groupField.
// Mirrors the live preview's own collapsedGroupsPreference.ts. Previously a
// grouped table always rendered every one of a group's rows, defeating
// the point of grouping a sizeable table to see just the groups you care
// about.
//
// groupFieldName is part of the key (not just entity) because
// groupRecordsByField's own group keys are field-independent: every
// boolean field's two groups are keyed by the literal strings "true"/
// "false", and an enum field's groups are keyed by its raw enum values --
// so two boolean fields, or two enum fields sharing a value, would
// otherwise collapse each other's groups the moment "Group by" switched
// from one to the other.
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
function getPersistedCollapsedGroups(entityName, groupFieldName) {
  const store = readCollapsedGroupsStore();
  const keys = store[entityName + ":" + groupFieldName];
  return Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
}
function setPersistedCollapsedGroups(entityName, groupFieldName, keys) {
  const store = readCollapsedGroupsStore();
  const mapKey = entityName + ":" + groupFieldName;
  const deduped = [...new Set(keys)];
  if (deduped.length === 0) delete store[mapKey];
  else store[mapKey] = deduped;
  writeCollapsedGroupsStore(store);
  return deduped;
}

// Which board-view column values are collapsed, per entity+boardField.
// Mirrors the live preview's own collapsedBoardColumnsPreference.ts --
// deliberately a SEPARATE store from the one just above (table groups and
// board columns can be keyed by different fields, so sharing storage
// would conflate the two). Previously a board column always rendered
// every one of its own cards, even a huge "Done" column.
//
// boardFieldName is part of the key even though it's never a direct user
// choice the way groupFieldName is: findBoardField recomputes which field
// drives the board from the entity's CURRENT fields every render, so
// editing the entity's fields can silently swap which field holds that
// role -- without this dimension in the key, the newly-chosen field would
// inherit whichever columns were collapsed under the field that used to
// hold it.
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
function getPersistedCollapsedBoardColumns(entityName, boardFieldName) {
  const store = readCollapsedBoardColumnsStore();
  const values = store[entityName + ":" + boardFieldName];
  return Array.isArray(values) ? values.filter((v) => typeof v === "string") : [];
}
function setPersistedCollapsedBoardColumns(entityName, boardFieldName, values) {
  const store = readCollapsedBoardColumnsStore();
  const mapKey = entityName + ":" + boardFieldName;
  const deduped = [...new Set(values)];
  if (deduped.length === 0) delete store[mapKey];
  else store[mapKey] = deduped;
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
  // Date.UTC(year, ...) silently adds 1900 to a year in 0-99 (legacy
  // ECMA-262 behavior), which would wrongly reject "0099-01-01" -- so the
  // date is built via setUTCFullYear, whose year argument has no such
  // special-casing, instead of passed through Date.UTC.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Picks the field that best represents one of an entity's records as a
// short human label -- prefers a field literally named "name"/"title",
// falls back to the first text field, then the first non-relation field
// of any other type, then -- only if literally every field is itself a
// relation -- the first field regardless. A join/line-item entity (e.g.
// Enrollment { studentId: relation, courseId: relation, grade: enum })
// can legitimately have no name/title/text field at all, and without the
// relation exclusion here recordDisplayLabel would render the *related*
// record's own raw internal id as this record's own label.
// Round 749: also excludes "file" for the same reason -- a document-
// centric join entity with no name/title/text field either would
// otherwise String() a file field's raw JSON upload descriptor
// ({url,name,size,mimeType}) as this record's own label.
// Round 762: the "first text field" step also tries "longtext" as a
// second choice (never a tiebreak over a real "text" field), the same
// free-text-kind convention this codebase's other text/longtext checks
// already follow.
// Round 793: the name-hint step itself also excludes "relation"/"file" --
// a field can legitimately be named "title" or "name" while being a
// relation (e.g. Employee { title: relation->JobTitle }) or a file (e.g.
// Document { name: file }), and without this exclusion that field won by
// name alone before the type-aware fallback steps below ever ran.
const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];
export function pickDisplayField(entity) {
  if (!entity || !entity.fields || entity.fields.length === 0) return null;
  const named = entity.fields.find(
    (f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()) && f.type !== "relation" && f.type !== "file",
  );
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text") || entity.fields.find((f) => f.type === "longtext");
  if (firstText) return firstText;
  const firstDisplayable = entity.fields.find((f) => f.type !== "relation" && f.type !== "file");
  return firstDisplayable || entity.fields[0];
}

export function recordDisplayLabel(entity, record) {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return \`#\${record.id}\`;
  if (field?.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field?.type === "enum") return field.enumLabels?.[String(value)] ?? String(value);
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
// round 458: the "un-"/"dis-" negated forms below must stay listed here too --
// each contains a POSITIVE_WORDS entry as a literal substring ("unpaid"
// contains "paid", etc.), the same "inactive"/"active" shape "inactive"
// already handles, mirrored from apps/web/src/entityFormatting.ts's own fix.
const NEGATIVE_WORDS = [
  "lost", "cancelled", "canceled", "inactive", "overdue", "no-show", "failed", "rejected", "declined", "denied",
  "unpaid", "undelivered", "unconfirmed", "unapproved", "disapproved", "unqualified", "disqualified", "unshipped",
];
// Mirrors the live preview's own entityFormatting.ts formatRecordCreatedAt
// (round 168): every record carries a real, server-assigned createdAt
// (see insertRecord below), but the exported app's own table never showed
// it anywhere -- the only way to tell when a record was actually added
// was to open it and guess, or check the CSV export's raw data.
function formatRecordCreatedAt(createdAt) {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

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

// A \`file\` field's stored value is a JSON-encoded {url, name, size,
// mimeType} descriptor (set by the live Forge AI preview's own upload
// endpoint), not a plain string like every other field type -- a record
// with no file chosen yet, or one from before this field existed, stores
// "" or null instead, so this returns null rather than throwing on
// anything that doesn't parse as the expected shape. Mirrors the live
// preview's own entityFormatting.ts parseFileFieldValue.
function parseFileFieldValue(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed.url === "string" && typeof parsed.name === "string") {
      return { url: parsed.url, name: parsed.name, size: Number(parsed.size) || 0, mimeType: String(parsed.mimeType || "") };
    }
  } catch {
    // not a file descriptor -- treated as no file, same as an empty value
  }
  return null;
}

// Mirrors the live preview's own entityFormatting.ts isImageMimeType.
function isImageMimeType(mimeType) {
  return mimeType.startsWith("image/");
}

// A relation cell already shows a label resolved from a *different*
// record (see relationDisplayLabel), not the raw stored value an inline
// editor would need to edit -- mirrors the live preview's own
// entityFormatting.ts isInlineEditableField (round 206).
//
// "file" is excluded for the same reason: its real editing UI (choosing
// and uploading a file) needs more room and more state than a single
// inline table cell gives it -- see FieldInput's own "file" branch below,
// the only one that would need an upload endpoint to work at all (which
// this exported app doesn't have). Without this exclusion, double-
// clicking a file cell let a user inline-edit the raw JSON descriptor as
// free text, silently corrupting the stored attachment. Mirrors the live
// preview's own entityFormatting.ts isInlineEditableField.
export function isInlineEditableField(field) {
  return field.type !== "relation" && field.type !== "file";
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

// Mirrors the live preview's own splitHighlightSegments (entityFormatting.ts)
// verbatim: splits text around every case-insensitive occurrence of query,
// so a table cell can show *where* a search matched, not just that the row
// did. A blank query (or no match) returns the whole text as one unmatched
// segment, so callers never need a separate no-match branch.
function splitHighlightSegments(text, query) {
  const trimmed = query.trim();
  if (!trimmed) return [{ text, matched: false }];
  const escaped = trimmed.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const re = new RegExp(escaped, "gi");
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), matched: false });
    segments.push({ text: match[0], matched: true });
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex++;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), matched: false });
  return segments.length > 0 ? segments : [{ text, matched: false }];
}

function Highlighted({ text, query }) {
  if (!query || !query.trim()) return <>{text}</>;
  return (
    <>
      {splitHighlightSegments(text, query).map((seg, i) =>
        seg.matched ? (
          <mark key={i} className="search-match">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function LinkifiedText({ text, query }) {
  return (
    <>
      {splitLinkSegments(text).map((seg, i) =>
        seg.href ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="cell-link">
            {seg.text}
          </a>
        ) : (
          <Highlighted key={i} text={seg.text} query={query} />
        ),
      )}
    </>
  );
}

function Cell({ field, value, relationLabel, highlightQuery, onJumpToRecord }) {
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
  if (field.type === "boolean") return value ? <span className="bool-yes" aria-label="Yes">✓</span> : <span className="muted" aria-label="No">–</span>;
  if (field.type === "enum") {
    const label = String((field.enumLabels && field.enumLabels[value]) || value);
    return (
      <span className={\`badge badge-\${badgeTone(value)}\`}>
        <Highlighted text={label} query={highlightQuery} />
      </span>
    );
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
        <LinkifiedText text={String(value)} query={highlightQuery} />
      </span>
    );
  }
  if (field.type === "file") {
    const fileValue = parseFileFieldValue(value);
    if (!fileValue) return <span className="muted">—</span>;
    return (
      <a href={fileValue.url} target="_blank" rel="noopener noreferrer" className="file-cell-link" title={fileValue.name}>
        {isImageMimeType(fileValue.mimeType) ? (
          <img src={fileValue.url} alt={fileValue.name} className="file-cell-thumbnail" />
        ) : (
          <span className="file-cell-name">
            <Highlighted text={fileValue.name} query={highlightQuery} />
          </span>
        )}
      </a>
    );
  }
  return <LinkifiedText text={String(value)} query={highlightQuery} />;
}

// A relation field is matched against its resolved display label (e.g.
// "Dana Levi"), the same text a table cell actually shows, rather than the
// raw stored foreign-key id -- otherwise a search for the customer name
// shown right there on screen finds nothing. relatedRecords is optional so
// a caller with no relation data on hand yet still gets the previous,
// id-only behavior instead of a required-but-unavailable argument.
//
// A number field has the same gap for a different reason: the table cell
// (EntityView.jsx) renders it through .toLocaleString(), adding thousands
// separators (1500 -> "1,500") -- but this matched against the field's own
// plain String(value) ("1500"), so typing back the exact digits shown on
// screen, comma included, found nothing. Checked against both the plain
// and the formatted string (space-joined), so either "1500" or "1,500"
// still finds the same row.
//
// A date field had the identical gap, for the identical reason, and was
// simply missed when the fix above was made: the table cell (Cell(),
// above) renders it via parseFieldDate + toLocaleDateString(), a real
// formatted string ("2026-03-15" -> "3/15/2026") -- but this matched
// against the raw stored "YYYY-MM-DD" string, so typing back the exact
// date shown on screen found nothing.
//
// A boolean field has a related but distinct gap: groupRecordsByField
// (above) already shows a real "Yes"/"No" label for this field type's two
// values (the same "small, fixed value space" category boolean shares with
// enum), but this matched the raw stored JS boolean's String(value) form
// ("true"/"false"), text that appears nowhere in the actual UI (the table
// cell itself renders a checkmark/dash, not even that). Typing "Yes"/"No"
// -- the exact words shown in the group-by header for the same field --
// found nothing.
//
// A file field has the same gap for the same reason: the table cell
// (Cell(), above) shows just the attachment's filename via
// parseFileFieldValue, not the raw stored JSON descriptor ({"url":...,
// "name":...,...}) -- so this both over-matched (searching "url", a
// mimetype, or the raw byte size matched every record with a file) and
// under-matched (a filename containing a quote or backslash is JSON-
// escaped in the raw stored string, so typing back the exact filename
// shown on screen could fail to match).
export function matchesSearch(record, fields, query, relatedRecords) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return fields.some((f) => {
    const value = record[f.name];
    if (value === null || value === undefined) return false;
    if (f.type === "date") {
      const date = parseFieldDate(value);
      const formatted = Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
      return \`\${value} \${formatted}\`.toLowerCase().includes(trimmed);
    }
    if (f.type === "file") {
      return (parseFileFieldValue(value)?.name || "").toLowerCase().includes(trimmed);
    }
    const display =
      f.type === "enum" && f.enumLabels && f.enumLabels[value]
        ? f.enumLabels[value]
        : f.type === "relation" && relatedRecords
          ? relationDisplayLabel(f, value, relatedRecords)
          : f.type === "number" && typeof value === "number"
            ? \`\${value} \${value.toLocaleString()}\`
            : f.type === "boolean"
              ? value ? "Yes" : "No"
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
//
// An enum field has the same gap: the table cell renders
// (field.enumLabels && field.enumLabels[value]) || value, and matchesSearch
// already resolves it the same way, but this never did -- clicking an enum
// column's header sorted by the raw stored value instead of the label
// shown on screen.
//
// A file field has the identical gap: its stored value is the JSON upload
// descriptor (parseFileFieldValue), but the cell renders just the filename
// -- without this, clicking the column header sorts by the descriptor
// string instead of the filename shown on screen. Mirrors this file's own
// identical "file" branch used for search (line ~1786) and CSV export
// (line ~1896).
function resolveSortValue(fieldName, value, fields, relatedRecords) {
  const field = fields?.find((f) => f.name === fieldName);
  if (field?.type === "enum") return (field.enumLabels && field.enumLabels[value]) || value;
  if (field?.type === "file") return parseFileFieldValue(value)?.name || "";
  if (field?.type !== "relation" || !relatedRecords) return value;
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
      const cmp = compareValues(
        resolveSortValue(field, a[field], fields, relatedRecords),
        resolveSortValue(field, b[field], fields, relatedRecords),
      );
      if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

// Wraps a CSV field in quotes (doubling any interior quotes) only when it
// contains a comma, quote, or newline. A value starting with =, +, -, @, or
// a tab/CR is prefixed with a leading single quote first -- spreadsheet
// apps treat an unguarded cell like that as a formula (CSV/formula
// injection, CWE-1236), and a stored field can hold arbitrary text. A value
// that already starts with a literal "'" also gets one more "'" prefixed,
// even though a single leading apostrophe already makes spreadsheet apps
// treat the cell as plain text -- without that, a value like
// "'-interesting" (a real apostrophe immediately followed by a guarded
// character) exports to the exact same bytes as the guard applied to
// "-interesting", so the import side below could not tell them apart and
// silently dropped the real apostrophe.
function csvEscape(value) {
  const guarded = /^[=+\\-@\\t\\r']/.test(value) ? \`'\${value}\` : value;
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
  // A file field's raw stored value is a JSON descriptor ({"url":...,
  // "name":...,...}), not something a spreadsheet reader would recognize
  // -- the CSV export has no way to also carry the uploaded bytes
  // themselves (same limitation the live preview's own CSV export and
  // the backup ZIP's CSV export already have), so this gives just the
  // filename, mirroring both of those.
  if (field.type === "file") return parseFileFieldValue(value)?.name || "";
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

// A field's display label is never enforced unique (only its name is), so
// two fields on the same entity can legally share a label via the Field
// Label editor. Every place that renders a field's label as human-facing
// text (CSV headers, print sheets, board cards) needs the same
// disambiguation, so it is centralized here: count how many fields share
// each label, then fieldDisplayLabel appends a field's own (always-
// unique) name whenever its label is not unique.
function fieldLabelOccurrences(fields) {
  const occurrences = {};
  for (const f of fields) {
    const label = f.label || f.name;
    occurrences[label] = (occurrences[label] || 0) + 1;
  }
  return occurrences;
}

function fieldDisplayLabel(field, occurrences) {
  const label = field.label || field.name;
  return (occurrences[label] || 0) > 1 ? label + " (" + field.name + ")" : label;
}

// Builds a real, Excel-friendly CSV (CRLF line endings, quoted fields
// where needed) from an entity's records -- so "download my data" means
// an actual spreadsheet, not a JSON dump. includeId, when true, prepends
// each record's own id as a leading "id" column -- "id" is a reserved
// field name, so it can never collide with a real field's header -- which
// buildImportRecords below recognizes on the way back in, letting a
// re-imported copy of your own export UPDATE those records instead of
// only ever creating duplicates. Only the real "Export CSV" download
// below opts in; Copy (pasted into chat/email, never re-imported) doesn't.
function recordsToCsv(fields, records, relatedRecords, includeId) {
  const labelOccurrences = fieldLabelOccurrences(fields);
  const headerCells = fields.map((f) => fieldDisplayLabel(f, labelOccurrences));
  const header = (includeId ? ["id", ...headerCells] : headerCells).map(csvEscape).join(",");
  const rows = records.map((record) => {
    const cells = fields.map((f) => fieldDisplayValue(f, record[f.name], relatedRecords));
    return (includeId ? [String(record.id), ...cells] : cells).map(csvEscape).join(",");
  });
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

function matchesImportHeader(header, field, labelOccurrences) {
  const normalized = header.trim().toLowerCase();
  // A blank header can never legitimately refer to any field -- without
  // this, (field.label || "") is itself "" for any field with no label
  // set, so a blank/unnamed CSV column would match the FIRST unlabeled
  // field and silently import unrelated data into it.
  if (!normalized) return false;
  // recordsToCsv's own header row uses fieldDisplayLabel, not the raw
  // label, whenever two fields share a label -- "Amount (subtotal)", not
  // "Amount". Without also matching that disambiguated form, re-importing
  // a CSV this app itself just exported for an entity with any
  // same-labeled fields silently fails to match either column, and both
  // fields' data comes back null with no error reported at all.
  return (
    normalized === field.name.toLowerCase() ||
    normalized === (field.label || "").toLowerCase() ||
    normalized === fieldDisplayLabel(field, labelOccurrences).toLowerCase()
  );
}

// Turns parsed CSV rows into record payloads matching entity.fields --
// the reverse of fieldDisplayValue. Columns are matched to fields by
// header text (label or field name, case-insensitively); an unmatched
// column is ignored. A relation field's cell (e.g. "Dana Levi") is
// resolved back to the related record's real id the same way
// relationDisplayLabel renders it forward -- matching recordDisplayLabel
// case-insensitively against relatedRecords, or accepting the literal
// "#<id>" form directly (see entityFormatting.ts's buildImportRecords for
// the full reasoning this mirrors). When relatedRecords for this field's
// target isn't available at all, it falls back to the original
// "impossible from a CSV cell" treatment: an optional column is ignored,
// and a required relation field refuses the whole import with one clear
// error instead of guessing.
function buildImportRecords(fields, rows, relatedRecords) {
  if (rows.length === 0) return { records: [], errors: [] };

  // Unlike number/enum/date below, a boolean cell used to have no
  // rejection path at all: anything outside this exact true-list
  // (including a Hebrew "כן"/"לא", "no", or a typo) silently became
  // false with zero error reported -- mirrors the same fix in
  // entityFormatting.ts's buildImportRecords. Declared inside the
  // function (not module scope) so this file's own tests can extract
  // and run buildImportRecords in isolation via regex, as they already
  // do for isValidDate/matchesImportHeader.
  const BOOLEAN_TRUE_VALUES = ["true", "1", "yes", "כן"];
  const BOOLEAN_FALSE_VALUES = ["false", "0", "no", "לא"];

  const relationResolvable = (f) => !!f.relationTo && ALL_ENTITIES.some((e) => e.name === f.relationTo) && !!(relatedRecords && relatedRecords[f.relationTo]);

  // A required "file" field can never be satisfied from a CSV cell either
  // (same reasoning as the relation case below -- see entityFormatting.ts's
  // own buildImportRecords, which this mirrors): its real value is a JSON
  // descriptor an upload endpoint sets, never something a CSV cell could
  // supply. Must be caught here, upfront, not just skipped per-row below --
  // otherwise every imported row silently omits the field and the server's
  // own coerce() then rejects every single row with "Field is required",
  // one wasted POST per row, instead of refusing the whole import with one
  // clear reason before any request is even sent.
  const requiredUnsupported = fields.find((f) => (f.type === "file" && f.required) || (f.type === "relation" && f.required && !relationResolvable(f)));
  if (requiredUnsupported) {
    return {
      records: [],
      errors: [\`CSV import isn't supported yet for entities with a required \${requiredUnsupported.type} field ("\${requiredUnsupported.label || requiredUnsupported.name}").\`],
    };
  }

  const [header, ...dataRows] = rows;
  // A header cell literally "id" is recordsToCsv's own re-import-friendly
  // leading column, not matched against real fields at all (see
  // entityFormatting.ts's buildImportRecords for the full reasoning --
  // "id" is a reserved field name, so this can never collide with one).
  const idColumnIndex = header.findIndex((cell) => cell.trim().toLowerCase() === "id");

  // See entityFormatting.ts's buildImportRecords for why: a field is
  // claimed by at most one column, in header order, so two fields sharing
  // a label don't both resolve to the same first-matching field.
  const claimedFieldNames = new Set();
  const labelOccurrences = fieldLabelOccurrences(fields);
  const columnFields = header.map((cell, index) => {
    if (index === idColumnIndex) return null;
    const match = fields.find((f) => !claimedFieldNames.has(f.name) && matchesImportHeader(cell, f, labelOccurrences));
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

    if (idColumnIndex !== -1) {
      const rawId = (row[idColumnIndex] || "").trim();
      if (rawId !== "") {
        const parsedId = Number(rawId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          rowError = \`Row \${rowIndex + 1}: "\${rawId}" isn't a valid record id.\`;
        } else {
          record.id = parsedId;
        }
      }
    }

    for (const field of rowError ? [] : fields) {
      const columnIndex = columnFields.findIndex((f) => f && f.name === field.name);
      const trimmedCell = columnIndex === -1 ? "" : (row[columnIndex] || "").trim();
      // Reverses the leading "'" that csvEscape (this file's own guard
      // against CSV/formula injection, CWE-1236) prepends to a value
      // starting with =, +, -, @, a tab/CR, or a literal "'" itself --
      // without this, re-importing a CSV this app itself exported would
      // permanently bake that guard apostrophe into the data. Strips
      // exactly one leading apostrophe whenever what follows is itself one
      // of those same guarded characters (now including "'"), so a value
      // that genuinely starts with a literal "'" followed by an ordinary
      // character is left untouched.
      const raw = trimmedCell[0] === "'" && /^[=+\\-@\\t\\r']/.test(trimmedCell.slice(1)) ? trimmedCell.slice(1) : trimmedCell;

      // A file field's real value is a JSON descriptor set by an upload
      // endpoint, not something a CSV cell can supply -- skipped the same
      // way the live preview's own buildImportRecords skips it (there's
      // no file to attach from a CSV cell, required or not), instead of
      // letting a typed-in cell value overwrite -- or a required check
      // reject -- a field no CSV import can ever actually satisfy.
      if (field.type === "file") continue;

      if (field.type === "relation") {
        if (!relationResolvable(field)) continue;
        if (raw === "") {
          if (field.required) {
            rowError = \`Row \${rowIndex + 1}: missing required field "\${field.label || field.name}".\`;
            break;
          }
          record[field.name] = null;
          continue;
        }
        const targetEntity = ALL_ENTITIES.find((e) => e.name === field.relationTo);
        const targetRecords = relatedRecords[field.relationTo];
        // A real display-label match always wins over the "#<id>" shorthand below --
        // see the live preview's own buildImportRecords for why.
        const matches = targetRecords.filter((r) => recordDisplayLabel(targetEntity, r).toLowerCase() === raw.toLowerCase());
        if (matches.length === 1) {
          record[field.name] = Number(matches[0].id);
          continue;
        }
        if (matches.length === 0) {
          const hashMatch = raw.match(/^#(\\d+)$/);
          if (hashMatch) {
            const id = Number(hashMatch[1]);
            if (targetRecords.some((r) => Number(r.id) === id)) {
              record[field.name] = id;
              continue;
            }
          }
          rowError = \`Row \${rowIndex + 1}: "\${raw}" doesn't match any \${targetEntity.label || targetEntity.name} record for field "\${field.label || field.name}".\`;
          break;
        }
        rowError = \`Row \${rowIndex + 1}: "\${raw}" matches more than one \${targetEntity.label || targetEntity.name} record for field "\${field.label || field.name}" -- use its "#<id>" form instead.\`;
        break;
      }

      if (raw === "") {
        if (field.required) {
          rowError = \`Row \${rowIndex + 1}: missing required field "\${field.label || field.name}".\`;
          break;
        }
        record[field.name] = field.type === "boolean" ? false : null;
        continue;
      }

      if (field.type === "boolean") {
        const lower = raw.toLowerCase();
        if (BOOLEAN_TRUE_VALUES.includes(lower)) {
          record[field.name] = true;
        } else if (BOOLEAN_FALSE_VALUES.includes(lower)) {
          record[field.name] = false;
        } else {
          rowError = \`Row \${rowIndex + 1}: "\${raw}" isn't a recognized yes/no value for field "\${field.label || field.name}".\`;
          break;
        }
      } else if (field.type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
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
//
// A relation field is just as fixed-value-space as an enum, but had no
// filter dropdown at all -- mirrors the live preview's own
// entityFormatting.ts fix. Only offered once relatedRecords confirms the
// relation actually resolves to a loaded set of records, the same
// "resolvable" guard relationResolvable (above) already uses.
function findFilterableFields(fields, relatedRecords) {
  const relationFields = fields.filter(
    (f) => f.type === "relation" && f.relationTo && ALL_ENTITIES.some((e) => e.name === f.relationTo) && relatedRecords && relatedRecords[f.relationTo],
  );
  return [...findFilterableEnumFields(fields), ...fields.filter((f) => f.type === "boolean"), ...relationFields];
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

// The "(other)" overflow bucket below needs its own key, distinct from
// every real declared enum value -- enumValues has no restriction on its
// contents, so a spec can legitimately declare "__other__" itself as a
// real enum value, colliding with the synthetic bucket's own React/Set
// key (EntityView.jsx's collapsedBoardColumns) and silently collapsing
// both together. Appending underscores until the key no longer matches
// anything in enumValues guarantees no collision.
function otherGroupKey(enumValues) {
  const known = new Set(enumValues || []);
  let key = "__other__";
  while (known.has(key)) key += "_";
  return key;
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
  const values = uniqueEnumValues(field.enumValues);
  const columns = values.map((value) => ({
    value,
    label: (field.enumLabels && field.enumLabels[value]) || value,
    records: records.filter((r) => String(r[field.name]) === value),
  }));
  const known = new Set(values);
  const other = records.filter((r) => !known.has(String(r[field.name] || "")));
  if (other.length > 0) {
    columns.push({ value: otherGroupKey(field.enumValues), label: "Other", records: other, isOther: true });
  }
  return columns;
}

// Whether a field's own value space is small and fixed enough to group the
// plain table by -- distinct from groupByField above (Kanban board columns
// only, enum-only, always includes empty columns). Mirrors the live
// preview's own entityFormatting.ts isGroupableField (round 219).
//
// A relation field is exactly as fixed-value-space as an enum -- its own
// options are the related entity's current records -- and the sibling
// toolbar filter dropdown (findFilterableFields above, round 721) already
// treats it that way, with the identical "resolvable" guard: only once
// relatedRecords confirms the relation actually resolves to a loaded set
// of records, so a stale relationTo or not-yet-loaded data never offers a
// group-by option with nothing real to group by. Mirrors the live
// preview's own entityFormatting.ts isGroupableField widening (round 738).
function isGroupableField(field, relatedRecords) {
  if (field.type === "enum" || field.type === "boolean") return true;
  return field.type === "relation" && !!field.relationTo && ALL_ENTITIES.some((e) => e.name === field.relationTo) && !!(relatedRecords && relatedRecords[field.relationTo]);
}

// Partitions records into ordered groups by one groupable field's value,
// omitting any group with zero matching records. For an enum field, groups
// follow the field's own declared enumValues order, with a final "(other)"
// bucket for any legacy value no longer in enumValues. For a boolean
// field there are only ever the two fixed groups, true then false. For a
// relation field, groups follow the related entity's own current record
// order, labeled via the same recordDisplayLabel used elsewhere, with any
// record whose stored id is empty or no longer resolves (a dangling
// reference to a deleted related record) collected into the same "(other)"
// bucket the enum branch uses. Mirrors the live preview's own
// entityFormatting.ts groupRecordsByField.
function groupRecordsByField(records, field, relatedRecords) {
  if (field.type === "boolean") {
    const groups = [];
    const truthy = records.filter((r) => Boolean(r[field.name]));
    const falsy = records.filter((r) => !r[field.name]);
    if (truthy.length > 0) groups.push({ key: "true", label: "Yes", records: truthy });
    if (falsy.length > 0) groups.push({ key: "false", label: "No", records: falsy });
    return groups;
  }
  if (field.type === "relation") {
    const targetEntity = field.relationTo ? ALL_ENTITIES.find((e) => e.name === field.relationTo) : undefined;
    const relatedList = field.relationTo && relatedRecords ? relatedRecords[field.relationTo] : undefined;
    if (!targetEntity || !relatedList) return [];
    const groups = [];
    const knownIds = new Set(relatedList.map((r) => r.id));
    for (const related of relatedList) {
      const matched = records.filter((r) => Number(r[field.name]) === related.id);
      if (matched.length > 0) groups.push({ key: String(related.id), label: recordDisplayLabel(targetEntity, related), records: matched });
    }
    const other = records.filter((r) => {
      const v = r[field.name];
      return v === null || v === undefined || v === "" || !knownIds.has(Number(v));
    });
    if (other.length > 0) groups.push({ key: otherGroupKey(undefined), label: "Other", records: other });
    return groups;
  }
  const groups = [];
  const known = new Set(field.enumValues || []);
  for (const value of uniqueEnumValues(field.enumValues)) {
    const matched = records.filter((r) => String(r[field.name] || "") === value);
    if (matched.length > 0) groups.push({ key: value, label: (field.enumLabels && field.enumLabels[value]) || value, records: matched });
  }
  const other = records.filter((r) => !known.has(String(r[field.name] || "")));
  if (other.length > 0) groups.push({ key: otherGroupKey(field.enumValues), label: "Other", records: other });
  return groups;
}

// Picks the date field an entity's records should be plotted on a calendar
// by, if any -- prefers a field literally named "date" or a few other
// common date-ish names, then falls back to the first date field; returns
// null for an entity with no date field at all. "startdate" (round 573) is
// here for the same reason "enddate" is in END_DATE_FIELD_NAME_HINTS below --
// without it, a startDate/endDate pair only picked startDate as the start
// field by luck of field-declaration order.
const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduleddate", "eventdate", "duedate", "startdate"];
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
// Round 778: the fallback below now excludes relation/file fields too,
// mirroring pickDisplayField's own exclusion -- an entity with no
// name/title/text field whose fallback lands on a relation field used to
// show a raw related-record id (or a blank chip when null), and a file
// field used to leak its raw upload descriptor. See entityFormatting.ts's
// own calendarChipLabelField doc comment for the full rationale.
function calendarLabelField(entity, dateField) {
  const preferred = pickDisplayField(entity);
  return (
    (preferred && preferred.name !== dateField.name ? preferred : null) ||
    entity.fields.find((f) => f.name !== dateField.name && f.type !== "relation" && f.type !== "file") ||
    dateField
  );
}

// Round 778: resolves calendarLabelField's own chosen field to the actual
// string the live calendar day-chip should display -- the chip used to
// render the raw stored value with zero type awareness (not even enum).
// Mirrors entityFormatting.ts's own calendarChipLabelValue.
function calendarLabelValue(labelField, record) {
  const value = record[labelField.name];
  if (value === null || value === undefined) return "";
  if (labelField.type === "boolean") return value ? "TRUE" : "FALSE";
  if (labelField.type === "enum") return (labelField.enumLabels && labelField.enumLabels[value]) || String(value);
  return String(value);
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

// RFC 5545 §3.1's 75-octet limit counts UTF-8 bytes, not JS string length -- a Hebrew character is 1 UTF-16 unit but 2 UTF-8 bytes, so counting characters let a Hebrew line through unfolded (or folded into still-oversized chunks) exactly when this app's own primary-language content needed folding most.
function utf8ByteLength(s) {
  return new TextEncoder().encode(s).length;
}

function foldIcsLine(line) {
  if (utf8ByteLength(line) <= 75) return line;
  const chars = Array.from(line);
  const parts = [];
  let current = "";
  let limit = 75;
  for (const ch of chars) {
    const candidate = current + ch;
    if (current !== "" && utf8ByteLength(candidate) > limit) {
      parts.push(current);
      current = ch;
      limit = 74;
    } else {
      current = candidate;
    }
  }
  if (current !== "") parts.push(current);
  return parts.join("\\r\\n ");
}

// Mirrors this file's own EntityView table cells (bare toLocaleDateString()/
// toLocaleString(), no explicit locale -- this exported app has no
// language-switching mechanism of its own). Falls back to the raw stored
// value when it isn't a parseable date, the same "never show nothing"
// behavior this file's own fieldDisplayValue uses.
function formatIcsDescriptionDate(value) {
  if (typeof value !== "string") return value;
  const date = parseFieldDate(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function formatIcsDescriptionNumber(value) {
  return typeof value === "number" ? value.toLocaleString() : value;
}

// Builds a real RFC 5545 .ics calendar, one all-day VEVENT per record --
// every field other than the date/label fields becomes a "Label: value"
// line in DESCRIPTION, and a relation field resolves to its real display
// label rather than a raw id.
function buildCalendarIcs(entity, dateField, labelField, records, relatedRecords, now, endField, orderedFields = entity.fields) {
  const dtstamp = formatIcsTimestamp(now || new Date());
  const descriptionFields = orderedFields.filter((f) => f.name !== dateField.name && f.name !== labelField.name && f.name !== (endField && endField.name));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", foldIcsLine(\`PRODID:-//Forge AI//\${icsEscapeText(entity.label || entity.name)}//EN\`), "CALSCALE:GREGORIAN"];
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
    const rawLabelValue = record[labelField.name];
    const labelRaw =
      labelField.type === "boolean" && rawLabelValue !== null && rawLabelValue !== undefined
        ? rawLabelValue ? "TRUE" : "FALSE"
        : labelField.type === "enum"
          ? (labelField.enumLabels && labelField.enumLabels[rawLabelValue]) || rawLabelValue
          : rawLabelValue;
    const summary = String(labelRaw ?? entity.label ?? entity.name);
    // Same label-collision gap the exported app's Business Twin-equivalent
    // text builders were fixed for -- only field.name is unique, never
    // .label, so two description fields here can legally share a label.
    // Disambiguated with each field's own name, so a real calendar app
    // does not show two identical-looking lines with no way to tell them
    // apart.
    const descriptionLabelOccurrences = {};
    for (const f of descriptionFields) {
      const label = f.label || f.name;
      descriptionLabelOccurrences[label] = (descriptionLabelOccurrences[label] || 0) + 1;
    }
    const descriptionLines = descriptionFields
      .map((f) => {
        // A "file" field's stored value is a JSON-encoded descriptor
        // (url/name/size/mimeType), not a plain string -- without this
        // branch it falls into the generic record[f.name] case below and
        // writes that raw JSON verbatim into the exported .ics, leaking
        // the server's internal upload URL path into a file a user might
        // forward or publish. Mirrors the live preview's own
        // calendarIcs.ts (round 694) and this file's own fieldDisplayValue,
        // which already has this exact branch.
        // A "boolean" field's stored value is a real JS boolean
        // (rowToRecord above always yields one) -- without this branch it
        // falls into the generic record[f.name] case and interpolates
        // straight to JS's own lowercase "true"/"false", inconsistent with
        // the uppercase "TRUE"/"FALSE" this file's own fieldDisplayValue
        // (CSV export) already uses for the exact same field type. Mirrors
        // the live preview's own calendarIcs.ts (round 747).
        // "date"/"number" are locale-formatted the same way this file's
        // own EntityView table cells already render them (bare
        // toLocaleDateString()/toLocaleString(), no explicit locale --
        // this exported app has no language-switching mechanism of its
        // own, unlike the live preview's calendarIcs.ts, which threads a
        // real lang argument). Mirrors the live preview's own round-763
        // fix: fieldDisplayValue (CSV export) deliberately leaves these
        // two raw only so a CSV round-trips exactly through
        // buildImportRecords' re-parse, which doesn't apply to this
        // one-way .ics export.
        const value = f.type === "relation" ? relationDisplayLabel(f, record[f.name], relatedRecords) : f.type === "enum" ? ((f.enumLabels && f.enumLabels[record[f.name]]) || record[f.name]) : f.type === "file" ? parseFileFieldValue(record[f.name])?.name || null : f.type === "boolean" ? (record[f.name] ? "TRUE" : "FALSE") : f.type === "date" ? formatIcsDescriptionDate(record[f.name]) : f.type === "number" ? formatIcsDescriptionNumber(record[f.name]) : record[f.name];
        if (value === null || value === undefined || value === "") return null;
        const fieldLabel = f.label || f.name;
        const ambiguous = (descriptionLabelOccurrences[fieldLabel] || 0) > 1;
        return fieldLabel + (ambiguous ? " (" + f.name + ")" : "") + ": " + value;
      })
      .filter((line) => line !== null);
    lines.push("BEGIN:VEVENT");
    lines.push(foldIcsLine(\`UID:\${icsEscapeText(entity.name)}-\${record.id}@forge-ai\`));
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
function CalendarView({ entity, dateField, endDateField, records, month, onPrevMonth, onNextMonth, onToday, onJumpToMonth, onEdit, onDayClick, onReschedule, moveErrorId }) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(() => buildCalendarMonth(records, dateField, year, monthIndex, endDateField), [records, dateField, endDateField, year, monthIndex]);
  const [dragOverDay, setDragOverDay] = useState(null);
  const [expandedDays, setExpandedDays] = useState(new Set());
  // Reaching a date more than a couple of months away previously meant
  // clicking the prev/next chevron that many times -- mirrors the live
  // preview's own fix (EntityPanel.tsx): the month label becomes a button
  // that reveals a native month input, and picking a value jumps straight
  // there via the same onJumpToMonth/setCalendarMonth the chevrons use.
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const monthInputValue = \`\${year}-\${String(monthIndex + 1).padStart(2, "0")}\`;
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
        {showMonthPicker ? (
          <input
            type="month"
            className="calendar-month-input"
            value={monthInputValue}
            autoFocus
            onChange={(e) => {
              const [y, m] = e.target.value.split("-").map(Number);
              if (!y || !m) return;
              onJumpToMonth(new Date(y, m - 1, 1));
              setShowMonthPicker(false);
            }}
            onBlur={() => setShowMonthPicker(false)}
          />
        ) : (
          <button type="button" className="calendar-month-label" onClick={() => setShowMonthPicker(true)} aria-label="Jump to month/year">{monthLabel}</button>
        )}
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
                    const [idPart, originDay] = e.dataTransfer.getData("text/plain").split("|");
                    const id = Number(idPart);
                    if (Number.isNaN(id)) return;
                    const record = records.find((r) => r.id === id);
                    if (record) onReschedule(record, day.date, originDay);
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
                    e.dataTransfer.setData("text/plain", \`\${record.id}|\${dayKey}\`);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(record);
                  }}
                >
                  {calendarLabelValue(labelField, record)}
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

// Hidden off-screen except during an actual print (see the .print-record-sheet
// rule in the generated CSS, which only shows it under @media print) so a
// single record can be printed as a clean paper handout -- the kind of
// "hand someone a paper copy" artifact (an order, a work order, an
// insurance claim) the live Forge AI preview's own EntityPanel.tsx ported
// this same feature for in the first place.
function RecordPrintSheet({ entity, fields, record, relatedRecords }) {
  if (!record) return <div className="print-record-sheet" />;
  const labelOccurrences = fieldLabelOccurrences(fields);
  return (
    <div className="print-record-sheet">
      <h1>{entity.label}</h1>
      <dl>
        {fields.map((f) => (
          <div key={f.name} className="print-field">
            <dt>{fieldDisplayLabel(f, labelOccurrences)}</dt>
            <dd>
              <Cell
                field={f}
                value={record[f.name]}
                relationLabel={f.type === "relation" ? relationDisplayLabel(f, record[f.name], relatedRecords) : undefined}
              />
            </dd>
          </div>
        ))}
      </dl>
      <p className="print-record-footer">Printed on {new Date().toLocaleString()}</p>
    </div>
  );
}

// Same idea as RecordPrintSheet, but for the current table's rows -- whatever
// is checkbox-selected, or every visible row if nothing is selected, same as
// the existing Export CSV button's own selectedOrAllRecords convention.
function RecordListPrintSheet({ entity, fields, records, relatedRecords, show }) {
  if (!show) return <div className="print-list-sheet" />;
  const labelOccurrences = fieldLabelOccurrences(fields);
  return (
    <div className="print-list-sheet">
      <h1>{entity.label}</h1>
      <table>
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.name}>{fieldDisplayLabel(f, labelOccurrences)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              {fields.map((f) => (
                <td key={f.name}>
                  <Cell
                    field={f}
                    value={r[f.name]}
                    relationLabel={f.type === "relation" ? relationDisplayLabel(f, r[f.name], relatedRecords) : undefined}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="print-record-footer">{records.length} records · Printed on {new Date().toLocaleString()}</p>
    </div>
  );
}

// One card in the board view: the record's other fields (never the board
// field itself, since that's implied by which column the card is in), a
// select to move it directly to another column, and the same Edit/Delete
// actions the table row has.
function BoardCard({ orderedFields, boardField, record, relatedRecords, highlightQuery, hasMoveError, onMove, onEdit, onDuplicate, onDelete, onPrint, onJumpToRecord }) {
  // orderedFields (not the entity's raw declared order) -- mirrors round
  // 615's fix for Export CSV/Copy/per-record Print/Print list, so a board
  // card's field order follows the user's drag-reordered columns the same
  // way the on-screen table and every other whole-record render path do.
  const otherFields = orderedFields.filter((f) => f.name !== boardField.name);
  // A record can land in the board's "(other)" column (see groupByField) when
  // its stored value is a legacy one no longer in boardField.enumValues --
  // migrate.ts only ever adds columns on refine, it never rewrites existing
  // row data. Without this, the <select> below would have no <option>
  // matching the controlled value, so the browser silently blanks it
  // (selectedIndex -1) instead of showing the record's real stage.
  const currentBoardValue = String(record[boardField.name] ?? "");
  const knownBoardValues = uniqueEnumValues(boardField.enumValues);
  const boardOptionValues = currentBoardValue && !knownBoardValues.includes(currentBoardValue) ? [currentBoardValue, ...knownBoardValues] : knownBoardValues;
  // The exact same "(other)" column also catches a record whose board
  // field is simply null/unset -- an optional board field left blank at
  // creation, or any pre-existing row after a refine added this field as
  // a brand-new column (migrate.ts's additive-only ALTER TABLE always
  // leaves existing rows NULL). currentBoardValue is then "" too, but
  // the ternary above only ever adds a non-empty stale value to the
  // option list -- it never adds "" itself, so the <select> still has no
  // matching <option> and still blanks out. Mirrors FieldInput's own
  // enum branch, which never hits this because it always renders a
  // disabled "" option unconditionally.
  const hasEmptyBoardOption = currentBoardValue === "";
  const labelOccurrences = fieldLabelOccurrences(otherFields);
  return (
    <div className={hasMoveError ? "board-card board-card-move-error" : "board-card"} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", String(record.id))}>
      {otherFields.map((f) => (
        <div key={f.name} className="board-card-field">
          <span className="muted small">{fieldDisplayLabel(f, labelOccurrences)}</span>
          <Cell
            field={f}
            value={record[f.name]}
            relationLabel={f.type === "relation" ? relationDisplayLabel(f, record[f.name], relatedRecords) : undefined}
            highlightQuery={highlightQuery}
            onJumpToRecord={onJumpToRecord}
          />
        </div>
      ))}
      <select className="board-card-move" value={currentBoardValue} onChange={(e) => onMove(e.target.value)}>
        {hasEmptyBoardOption && (
          <option value="" disabled>
            …
          </option>
        )}
        {boardOptionValues.map((v) => (
          <option key={v} value={v}>
            {(boardField.enumLabels && boardField.enumLabels[v]) || v}
          </option>
        ))}
      </select>
      <div className="row-actions">
        <button onClick={onEdit}>Edit</button>
        <button onClick={onDuplicate}>Duplicate</button>
        <button onClick={onPrint}>Print</button>
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
  // Mirrors the live preview's own fix (EntityPanel.tsx, round 698): a
  // relation field with more than a handful of related records had no way
  // to narrow the plain <select> below -- a browser's own type-ahead
  // inside an open <select> only jumps to an option whose label starts
  // with what's typed, not a substring match.
  const [relationFilter, setRelationFilter] = useState("");
  if (field.type === "relation" && relatedEntity) {
    // relatedEntityRecords is only populated once EntityView's own
    // loadRelated effect resolves its real network fetch -- a useEffect
    // never runs synchronously on the first render, so the add/edit form
    // (rendered unconditionally, with no loading gate of its own) would
    // otherwise fall through to the generic number-input branch below on
    // every single mount. Mirrors the live preview's own fix (EntityPanel.tsx).
    if (!relatedEntityRecords) {
      return (
        <select id={id} disabled aria-busy="true">
          <option value="">Loading…</option>
        </select>
      );
    }
    // loadRelated's own fetch deliberately swallows ANY failure into an
    // empty array, not undefined -- so a transient fetch error leaves
    // relatedEntityRecords genuinely empty rather than still-loading.
    // Mirrors the live preview's own fix (EntityPanel.tsx, round 515):
    // without this, a record whose relation field already holds a real id
    // would have no matching <option> and the browser would silently
    // blank the controlled select, the same bug class the enum branch
    // below already guards against.
    const currentRelationId = value === "" || value === null || value === undefined ? null : Number(value);
    const hasCurrentRelationOption = currentRelationId === null || relatedEntityRecords.some((r) => Number(r.id) === currentRelationId);
    const trimmedFilter = relationFilter.trim().toLowerCase();
    // The current value's own option must always stay visible regardless
    // of the filter text -- otherwise typing a filter that doesn't match
    // the already-selected record would blank the controlled <select> the
    // instant its matching option disappears.
    const filteredRecords =
      trimmedFilter === ""
        ? relatedEntityRecords
        : relatedEntityRecords.filter(
            (r) => Number(r.id) === currentRelationId || recordDisplayLabel(relatedEntity, r).toLowerCase().includes(trimmedFilter),
          );
    return (
      <div className="relation-field-input">
        {relatedEntityRecords.length > 5 && (
          <input
            type="text"
            className="relation-filter-input"
            value={relationFilter}
            onChange={(e) => setRelationFilter(e.target.value)}
            placeholder="Search…"
            aria-label="Search…"
          />
        )}
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
          {!hasCurrentRelationOption && <option value={currentRelationId}>{\`#\${currentRelationId}\`}</option>}
          {filteredRecords.map((r) => (
            <option key={r.id} value={r.id}>
              {recordDisplayLabel(relatedEntity, r)}
            </option>
          ))}
        </select>
      </div>
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
    // A record can carry a legacy value no longer in field.enumValues (e.g.
    // after an AI refine renamed/restructured the field's options --
    // migrate.ts only ever adds columns, it never rewrites existing row
    // data). Without an <option> for it, the controlled value below matches
    // nothing and the browser silently blanks the select instead of showing
    // the record's real stored value (same root cause BoardCard's own move
    // select has, see its own comment).
    const currentEnumValue = String(value ?? "");
    const knownEnumValues = uniqueEnumValues(field.enumValues);
    const enumOptionValues = currentEnumValue && !knownEnumValues.includes(currentEnumValue) ? [currentEnumValue, ...knownEnumValues] : knownEnumValues;
    return (
      <select id={id} required={field.required} value={currentEnumValue} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
        <option value="" disabled>
          …
        </option>
        {enumOptionValues.map((v) => (
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
  if (field.type === "file") {
    // The exported app has no upload endpoint of its own (only the live
    // Forge AI preview can turn a chosen file into the {url, name, size,
    // mimeType} descriptor this field actually stores) -- before this,
    // this fell through to the generic text input below, letting a user
    // type arbitrary text into a required field and silently corrupt an
    // existing attachment's JSON descriptor. A record that already has a
    // file (exported after it was uploaded in the live preview) still
    // shows and keeps it; there's just no way to add, replace, or clear
    // one here.
    const currentFile = parseFileFieldValue(value);
    return (
      <div className="file-field-input" id={id}>
        {currentFile ? (
          <span className="file-field-current">
            <a href={currentFile.url} target="_blank" rel="noopener noreferrer">
              {currentFile.name}
            </a>
          </span>
        ) : (
          <span className="muted">No file</span>
        )}
        <p className="muted small">Files can't be added or changed in an exported app -- only the live Forge AI preview supports file uploads.</p>
      </div>
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

/**
 * True when Enter's real DOM target is a button, link, or other element
 * that already has its own native (or React-handled) meaning for Enter --
 * j/k navigation only ever moves a *visual* "focused row" highlight, never
 * calling .focus() on anything, so the real DOM target can be sitting on a
 * completely unrelated button (the form's own Save button, another row's
 * Delete/Duplicate button) while a row is still visually focused from an
 * earlier j/k press. Mirrors the live Forge AI preview's own
 * entityFormatting.ts exactly.
 */
export function enterTargetsInteractiveElement(target) {
  return Boolean(target?.closest?.('button, a[href], [role="button"], summary'));
}

// Every scrollIntoView call in the exported app passed behavior: "smooth"
// unconditionally, firing a real scroll animation on every keypress and
// click regardless of whether the person has their OS/browser set to
// "prefers-reduced-motion: reduce". A behavior: "smooth" JS option isn't
// something a CSS media query can intercept -- only an element's inherited
// scroll-behavior -- so each call site needs its own check. Mirrors the
// live preview's own entityFormatting.ts scrollIntoViewRespectingMotion.
export function scrollIntoViewRespectingMotion(el, options) {
  if (!el || !el.scrollIntoView) return;
  const prefersReducedMotion = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView(prefersReducedMotion ? { ...options, behavior: "auto" } : options);
}

// The exported app's overlay dialogs (GlobalSearch, ShortcutsPanel) share a
// single module-scoped counter -- the same isAnyDialogOpen() guard the live
// Forge AI preview shares across its own eight dialogs via
// useDialogFocusTrap.ts, just without a reusable hook of its own. EntityView's
// own window-level j/k/x/d/n keydown handlers need to read "is any dialog
// open right now" synchronously inside a native event handler, not re-render
// in response to it: without this, pressing "d"/"x"/"Enter"/"n" while focus
// sits on a non-input control inside an open overlay (a Close button, a
// recent-search chip, "Show all") silently duplicated/selected/edited/
// discarded a background table row the user wasn't even looking at, since
// isTypingTarget alone only catches focus on a real text input.
let openDialogCount = 0;

export function isAnyDialogOpen() {
  return openDialogCount > 0;
}

// GlobalSearch.jsx/ShortcutsPanel.jsx are separate modules from this one, so
// neither can mutate openDialogCount directly -- these two exports are their
// only way to flip the flag on/off as they mount/unmount.
export function markDialogOpen() {
  openDialogCount += 1;
}

export function markDialogClosed() {
  openDialogCount -= 1;
}

export const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Mirrors the live preview's own domInert.ts hideBackgroundFromAssistiveTech:
// marks everything behind an open dialog -- every sibling of every ancestor,
// up to (not including) document.body -- as inert and aria-hidden, so a
// screen reader's virtual cursor can't reach the entity table sitting (only
// visually) behind the overlay. Returns a cleanup that restores exactly what
// this call changed. Shared by GlobalSearch.jsx and ShortcutsPanel.jsx.
export function hideDialogBackgroundFromAssistiveTech(dialogElement) {
  const restorers = [];
  let node = dialogElement;
  while (node && node !== document.body) {
    const parent = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute("data-forge-dialog-inert")) continue;
      const hadInert = sibling.hasAttribute("inert");
      const priorAriaHidden = sibling.getAttribute("aria-hidden");
      sibling.setAttribute("data-forge-dialog-inert", "");
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
      restorers.push(() => {
        sibling.removeAttribute("data-forge-dialog-inert");
        if (!hadInert) sibling.removeAttribute("inert");
        if (priorAriaHidden === null) sibling.removeAttribute("aria-hidden");
        else sibling.setAttribute("aria-hidden", priorAriaHidden);
      });
    }
    node = parent;
  }
  return () => {
    for (const restore of restorers) restore();
  };
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
  // The record startEdit snapshotted \`form\` from, kept separately from
  // \`form\` itself (which the user's own keystrokes mutate field-by-field)
  // so handleSubmit can tell which fields the user actually touched. See
  // handleSubmit's own comment for why this matters. Mirrors the live
  // Forge AI preview's own EntityPanel.tsx.
  const editingOriginalRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  // Forces a fresh FieldInput instance (via its own key below) every time
  // the form's real target changes -- a different record to edit, a new
  // blank create, or a successful submit -- so a relation field's own
  // relationFilter (FieldInput-local state, not lifted into this
  // component) can never survive into an unrelated record/field.
  // editingId alone can't do this: it stays null across two consecutive
  // "create new" sessions. Mirrors the live Forge AI preview's own
  // EntityPanel.tsx.
  const [formInstanceKey, setFormInstanceKey] = useState(0);
  const [search, setSearch] = useState("");
  const [recentSearches, setRecentSearches] = useState(() => getEntityRecentSearches(entity.name));
  const [fieldFilters, setFieldFilters] = useState(() => sanitizeFieldFilters(getPersistedFieldFilters(entity.name), entity.fields));
  const [groupFieldName, setGroupFieldName] = useState(() => getPersistedGroupField(entity.name));
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set(getPersistedCollapsedGroups(entity.name, groupFieldName)));
  const [collapsedBoardColumns, setCollapsedBoardColumns] = useState(
    () => new Set(getPersistedCollapsedBoardColumns(entity.name, (findBoardField(entity.fields) || {}).name || "")),
  );
  const [highlightedRecordId, setHighlightedRecordId] = useState(null);
  const [moveErrorId, setMoveErrorId] = useState(null);
  const [focusedRowId, setFocusedRowId] = useState(null);
  const [sortKeys, setSortKeys] = useState(() => getPersistedSortKeys(entity.name));
  const [viewMode, setViewMode] = useState(() => getPersistedViewMode(entity.name));
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkEditField, setBulkEditField] = useState("");
  const [bulkEditValue, setBulkEditValue] = useState("");
  // handleBulkDelete clears selectedIds synchronously, before any await, so
  // the bulk-actions-bar vanishes on the next render and a second click
  // can't land. handleBulkDuplicate/handleBulkUpdate below have no such
  // synchronous step -- selectedIds is only touched after their own
  // Promise.allSettled resolves -- so without this flag, double-clicking
  // "Duplicate selected" while the first batch was still in flight started
  // a second, independent batch of createRecord calls for the same ids,
  // duplicating every selected record twice instead of once (round 544).
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
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
  const [recordToPrint, setRecordToPrint] = useState(null);
  const [showPrintList, setShowPrintList] = useState(false);
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
  const entityFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(entity.fields), [entity.fields]);
  const dateField = useMemo(() => findDateField(entity.fields), [entity.fields]);
  const endDateField = useMemo(() => (dateField ? findEndDateField(entity.fields, dateField) : null), [entity.fields, dateField]);
  const relationTargets = useMemo(() => {
    const names = entity.fields.filter((f) => f.type === "relation" && f.relationTo).map((f) => f.relationTo);
    return [...new Set(names)].filter((name) => ALL_ENTITIES.some((e) => e.name === name));
  }, [entity.fields]);

  useEffect(() => {
    let cancelled = false;
    // A self-referencing relation target (entity.name itself, e.g.
    // Category.parentCategoryId -> Category) is deliberately excluded from
    // this effect's own fetch -- refresh() below already owns keeping
    // relatedRecords[entity.name] in sync (round 438), merging a
    // newly-created record in immediately. Fetching it here too made this
    // effect a SECOND writer of that same slot: if this effect's own
    // mount-time fetch happened to resolve after refresh() had already
    // merged a freshly-created record in, this effect's stale, pre-creation
    // snapshot would wholesale-replace relatedRecords, silently undoing
    // round 438's fix the moment a user created a same-entity record
    // quickly enough. Mirrors the live preview's own fix (EntityPanel.tsx,
    // round 540).
    const isSelfReferencing = relationTargets.includes(entity.name);
    const otherTargets = relationTargets.filter((name) => name !== entity.name);
    async function loadRelated() {
      if (otherTargets.length === 0) {
        if (!cancelled) {
          setRelatedRecords((prev) => (isSelfReferencing ? { [entity.name]: prev[entity.name] } : {}));
        }
        return;
      }
      const entries = await Promise.all(
        otherTargets.map(async (name) => {
          try {
            const { records: related } = await listRecords(name);
            return [name, related];
          } catch {
            return [name, []];
          }
        }),
      );
      if (!cancelled) {
        setRelatedRecords((prev) => ({
          ...Object.fromEntries(entries),
          ...(isSelfReferencing ? { [entity.name]: prev[entity.name] } : {}),
        }));
      }
    }
    loadRelated();
    return () => {
      cancelled = true;
    };
  }, [relationTargets, entity.name]);

  // Reports this entity's own record count back to the caller whenever
  // records changes -- every mutation already funnels through setRecords,
  // so this one effect keeps the active tab's own nav badge live without a
  // separate call site per mutation. Mirrors the live Forge AI preview's
  // own EntityPanel.tsx (round 305).
  useEffect(() => {
    if (onRecordCountChange) onRecordCountChange(entity.name, records.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name, records.length]);

  // Fires window.print() right after recordToPrint/showPrintList is set --
  // on the next tick (setTimeout 0) so the sheet has already rendered with
  // its new content first. The shared afterprint listener below clears
  // both back to their idle state whether the user actually printed or
  // just cancelled the print dialog.
  useEffect(() => {
    if (!recordToPrint) return;
    const timer = setTimeout(() => window.print(), 0);
    return () => clearTimeout(timer);
  }, [recordToPrint]);

  useEffect(() => {
    if (!showPrintList) return;
    const timer = setTimeout(() => window.print(), 0);
    return () => clearTimeout(timer);
  }, [showPrintList]);

  useEffect(() => {
    function clearPrinted() {
      setRecordToPrint(null);
      setShowPrintList(false);
    }
    window.addEventListener("afterprint", clearPrinted);
    return () => window.removeEventListener("afterprint", clearPrinted);
  }, []);

  async function refresh() {
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    setLoadError(null);
    try {
      const { records } = await listRecords(entity.name);
      if (refreshRequestId.current !== requestId) return;
      const pendingIds = new Set(pendingDeleteRef.current?.entries.map((e) => e.id) ?? []);
      const visible = pendingIds.size === 0 ? records : records.filter((r) => !pendingIds.has(r.id));
      setRecords(visible);
      // A self-referencing relation field (e.g. Category.parentCategoryId ->
      // Category) makes this entity its own relation target. Without this,
      // relatedRecords[entity.name] would only ever be populated once by
      // the loadRelated effect above and never kept in sync with a record
      // this very refresh() just created/edited -- silently hiding a
      // newly-created record from every relation picker pointing back at
      // this same entity. Mirrors the live Forge AI preview's own
      // EntityPanel.tsx fix for the identical gap.
      if (relationTargets.includes(entity.name)) {
        setRelatedRecords((prev) => ({ ...prev, [entity.name]: visible }));
      }
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
    setFieldFilters(sanitizeFieldFilters(getPersistedFieldFilters(entity.name), entity.fields));
    setGroupFieldName(getPersistedGroupField(entity.name));
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

  // Multi-row selection is only ever settable from Table view -- Board's
  // own card and the calendar day cells have no selection checkbox at all
  // -- but selectedIds itself is view-mode-agnostic state, and the
  // toolbar's Copy/Export-CSV/Print-list buttons read it unconditionally
  // in every view. Without this, selecting rows in Table and then
  // switching to Board or Calendar left that stale selection invisible (no
  // highlight on any card) and unreachable, since the table-only
  // bulk-actions-bar (including its own "Clear selection" button) and the
  // table-only Escape-clears-selection shortcut both live inside
  // viewMode==="table" guards. Safe precisely because nothing outside
  // Table view can ever populate selectedIds in the first place. Mirrors
  // the live Forge AI preview's own EntityPanel.tsx.
  useEffect(() => {
    if (viewMode !== "table") setSelectedIds(new Set());
  }, [viewMode]);

  // Which groups are collapsed is scoped per entity+groupFieldName too
  // (also re-running whenever groupFieldName itself changes, e.g. the
  // "Group by" dropdown) -- see COLLAPSED_GROUPS_STORAGE_KEY's own
  // comment above for why groupFieldName has to be part of the key.
  useEffect(() => {
    setCollapsedGroups(new Set(getPersistedCollapsedGroups(entity.name, groupFieldName)));
  }, [entity.name, groupFieldName]);

  // Same reasoning as collapsedGroups' own effect just above -- which
  // board columns are collapsed is scoped per entity+boardField too, in
  // its own separate store.
  useEffect(() => {
    setCollapsedBoardColumns(new Set(getPersistedCollapsedBoardColumns(entity.name, boardField ? boardField.name : "")));
  }, [entity.name, boardField]);

  // Applies an incoming highlightRecordId (from GlobalSearch's own per-row
  // "jump to record" click) once this entity's records have actually
  // loaded -- switching to table view and clearing any leftover search
  // filter, since either could otherwise hide the very row this was
  // supposed to reveal. Reports back via onHighlightHandled so the parent
  // clears its own copy and a second click on the same record can
  // re-trigger it. Mirrors the live Forge AI preview's own EntityPanel.tsx,
  // including the round 461 fix: the filter/view-mode clears below go
  // through the same persisting setters the manual Clear-filters/view-mode
  // buttons use, since a bare setFieldFilters({})/setViewMode("table") only
  // cleared in-memory state -- switching entity tabs swaps in a different
  // component instance with no key, which React also remounts, and the
  // mount-time effects above would reload the stale persisted value. Also
  // clears groupFieldName (round 462 fix): a collapsed group hides its
  // records from the DOM entirely, so a jumped-to record inside one would
  // silently fail to scroll into view or highlight, with no error at all.
  useEffect(() => {
    if (highlightRecordId == null || loading) return;
    setSearch("");
    setFieldFilters(() => {
      setPersistedFieldFilters(entity.name, {});
      return {};
    });
    setViewMode(setPersistedViewMode(entity.name, "table"));
    setGroupFieldName(setPersistedGroupField(entity.name, ""));
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
  const orderedFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(orderedFields), [orderedFields]);
  // The bulk-edit field picker, and the per-field filter dropdowns below,
  // are whole-record-set actions like the table's own column list -- they
  // follow the same drag-reordered column order (orderedFields) rather
  // than the entity's raw declared order. Mirrors the live preview's own
  // EntityPanel.tsx (round 678); moved here (they used to sit right after
  // boardField above, textually before orderedFields existed) for the
  // same reason that round's own fix moved bulkEditableFields there.
  // Round 779: mirrors the live preview's own fix (EntityPanel.tsx) --
  // this used to reuse isInlineEditableField verbatim (excludes relation,
  // correct for THAT predicate's own single-table-cell reason, but not
  // for this toolbar, which renders a full-width FieldInput with a real
  // relation picker). "file" stays excluded: its upload UI needs more
  // state than this toolbar threads through.
  const bulkEditableFields = useMemo(() => orderedFields.filter((f) => f.type !== "file"), [orderedFields]);
  const bulkEditableFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(bulkEditableFields), [bulkEditableFields]);
  const bulkEditFieldDef = useMemo(() => entity.fields.find((f) => f.name === bulkEditField), [entity.fields, bulkEditField]);
  const filterableFields = useMemo(() => findFilterableFields(orderedFields, relatedRecords), [orderedFields, relatedRecords]);
  const filterableFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(filterableFields), [filterableFields]);

  // Which columns actually render in the table -- CSV export and both print
  // sheets (per-record RecordPrintSheet and the list's RecordListPrintSheet)
  // intentionally ignore this and always include every field, the same
  // "whole-record action" distinction the live-preview app's own EntityPanel
  // makes.
  const visibleFields = useMemo(() => orderedFields.filter((f) => !hiddenFields.has(f.name)), [orderedFields, hiddenFields]);
  const visibleFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(visibleFields), [visibleFields]);

  function handleToggleColumn(fieldName) {
    // hiddenFields.size alone over-counts once it holds a name from a field
    // that no longer exists on this entity -- e.g. a user re-running a newer
    // export of the same project in a browser that still has an older
    // export's localStorage for this origin. Count only the hidden names
    // that still name a real field.
    const hiddenCount = entity.fields.filter((f) => hiddenFields.has(f.name)).length;
    const visibleCount = entity.fields.length - hiddenCount;
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

  // Keyboard-operable fallback for the drag above -- mirrors the live
  // preview's own handleMoveColumn (EntityPanel.tsx, round 478).
  function handleMoveColumn(fieldName, direction) {
    const visibleIndex = visibleFields.findIndex((f) => f.name === fieldName);
    if (visibleIndex === -1) return;
    const neighborIndex = direction === "earlier" ? visibleIndex - 1 : visibleIndex + 1;
    if (neighborIndex < 0 || neighborIndex >= visibleFields.length) return;
    const neighborName = visibleFields[neighborIndex].name;
    const fullOrder = orderedFields.map((f) => f.name);
    const next =
      direction === "earlier" ? reorderColumns(fullOrder, fieldName, neighborName) : reorderColumns(fullOrder, neighborName, fieldName);
    setColumnOrderState(setColumnOrder(entity.name, next));
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
    // This is the app's only mousedown-based drag (every other drag uses
    // native HTML5 draggable/onDragStart, which the browser itself already
    // gates to the left button) -- without this guard, a right-click-drag
    // or middle-click-drag on the handle resizes the column exactly like a
    // left-click-drag, since the width math below only reads e.clientX,
    // never which button is held.
    if (e.button !== 0) return;
    e.preventDefault();
    const th = e.currentTarget.parentElement;
    const startWidth = columnWidths[fieldName] ?? th?.getBoundingClientRect().width ?? 150;
    setResizingField({ field: fieldName, startX: e.clientX, startWidth });
  }

  // Keyboard fallback for the resize handle below -- mirrors the
  // column-move buttons' own keyboard-first design rather than leaving
  // resize mouse-drag-only. Mirrors the live preview's own EntityPanel.tsx.
  function handleResizeKeyDown(e, fieldName) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const th = e.currentTarget.parentElement;
    const delta = e.key === "ArrowRight" ? RESIZE_KEYBOARD_STEP : -RESIZE_KEYBOARD_STEP;
    // Derives startWidth from the updater's own \`prev\`, not the outer
    // columnWidths closure -- two ArrowLeft/ArrowRight presses handled in
    // the same React batch would otherwise both read the same pre-update
    // width and the second press would be silently lost.
    setColumnWidths((prev) => {
      const startWidth = prev[fieldName] ?? th?.getBoundingClientRect().width ?? 150;
      const width = computeResizedWidth(startWidth, delta);
      setColumnWidth(entity.name, fieldName, width);
      return { ...prev, [fieldName]: width };
    });
  }

  const visibleRecords = useMemo(() => {
    const matched = records.filter((r) => matchesSearch(r, entity.fields, search, relatedRecords));
    const filtered = matched.filter((r) =>
      Object.entries(fieldFilters).every(([fieldName, value]) => !value || String(r[fieldName] ?? "") === value),
    );
    return sortRecordsMulti(filtered, sortKeys, entity.fields, relatedRecords);
  }, [records, entity.fields, search, fieldFilters, sortKeys, relatedRecords]);

  const hasNumericVisibleField = useMemo(() => visibleFields.some((f) => f.type === "number"), [visibleFields]);

  // Grouping the plain table by a small-value-space field (enum/boolean) --
  // distinct from the Kanban board view (always exactly one auto-picked
  // field, always its own separate view), this lets a person cluster the
  // ordinary table by ANY such field while staying in table view, with
  // search/sort/columns all still applying underneath. Mirrors the live
  // preview's own EntityPanel.tsx (round 219).
  // Same orderedFields rationale as filterableFields/bulkEditableFields
  // above -- the "Group by" dropdown's own option list is a
  // whole-record-set view too.
  const groupableFields = useMemo(
    () => orderedFields.filter((f) => isGroupableField(f, relatedRecords)),
    [orderedFields, relatedRecords],
  );
  const groupableFieldLabelOccurrences = useMemo(() => fieldLabelOccurrences(groupableFields), [groupableFields]);
  const groupField = groupableFields.find((f) => f.name === groupFieldName) || null;
  const recordGroups = useMemo(
    () => (groupField ? groupRecordsByField(visibleRecords, groupField, relatedRecords) : null),
    [groupField, visibleRecords, relatedRecords],
  );

  // The records actually rendered in the table body right now -- unlike
  // visibleRecords, this excludes a collapsed group's records. Mirrors the
  // live preview's own effectivelyVisibleRecords (EntityPanel.tsx).
  const effectivelyVisibleRecords = useMemo(
    () => (recordGroups ? recordGroups.flatMap((group) => (collapsedGroups.has(group.key) ? [] : group.records)) : visibleRecords),
    [recordGroups, collapsedGroups, visibleRecords],
  );

  // Totals row under the table -- sums each visible number-type column over
  // effectivelyVisibleRecords (not visibleRecords), so a collapsed group's
  // records drop out of the grand total just like they drop out of the
  // table body and their own per-group subtotal row. Mirrors the live
  // preview's own EntityPanel.tsx.
  const numericFieldTotals = useMemo(
    () => (hasNumericVisibleField ? sumNumericFields(effectivelyVisibleRecords, visibleFields) : {}),
    [hasNumericVisibleField, effectivelyVisibleRecords, visibleFields],
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
  // buildCalendarMonth deliberately puts the SAME record into every day
  // cell a ranged record (endField) spans, so a multi-night Rental shows up
  // on each night's chip in the grid -- flattening that straight into the
  // export list would hand buildCalendarIcs the same record once per day it
  // occupies, producing N duplicate VEVENTs for one booking, so this dedupes
  // by id. Mirrors the live preview's own EntityPanel.tsx.
  const icsMonthRecords = useMemo(() => {
    if (!dateField) return [];
    const days = buildCalendarMonth(visibleRecords, dateField, calendarMonth.getFullYear(), calendarMonth.getMonth(), endDateField);
    const flat = days.filter((d) => d.inCurrentMonth).flatMap((d) => d.records);
    return Array.from(new Map(flat.map((r) => [r.id, r])).values());
  }, [visibleRecords, dateField, endDateField, calendarMonth]);

  // Scrolls the just-highlighted row into view once it's actually in the
  // rendered table -- runs after visibleRecords updates too, since the row
  // doesn't exist in the DOM until then.
  useEffect(() => {
    if (highlightedRecordId == null) return;
    const row = document.querySelector(\`tr[data-record-id="\${highlightedRecordId}"]\`);
    scrollIntoViewRespectingMotion(row, { behavior: "smooth", block: "center" });
  }, [highlightedRecordId, visibleRecords]);

  // Mirrors the highlighted-row scroll effect above, for the keyboard-
  // focused row instead of a jump-to target.
  useEffect(() => {
    if (focusedRowId == null) return;
    const row = document.querySelector(\`tr[data-record-id="\${focusedRowId}"]\`);
    scrollIntoViewRespectingMotion(row, { behavior: "smooth", block: "nearest" });
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
   *
   * The e.ctrlKey/metaKey/altKey check guards a gap neither of those
   * catches (round 653): e.key is the same bare letter whether or not a
   * modifier is held, so without it Ctrl/Cmd+D (the browser's own
   * bookmark-this-page shortcut) silently duplicated the focused row
   * instead, with no confirm dialog. Mirrors the live preview's own fix.
   *
   * enterTargetsInteractiveElement guards a round-654 gap unique to
   * Enter: j/k's own setFocusedRowId never calls .focus() on anything, so
   * e.target here can be sitting on a completely unrelated button (the
   * form's own Save button) while an earlier j/k press still has some row
   * visually focused -- without this check, Enter on that Save button got
   * hijacked into opening the visually-focused row for editing instead of
   * submitting the form. Mirrors the live preview's own fix.
   */
  useEffect(() => {
    if (viewMode !== "table") return;
    function handleKeyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || isAnyDialogOpen()) return;
      // Grouping/collapse-aware, unlike a flat visibleRecords.map(): a
      // collapsed group's records are skipped from the <tbody> entirely
      // (see the table body render below), so navigating or acting on them
      // by a stale index would silently focus/edit/delete/duplicate a row
      // the user can't even see.
      const visibleIds = (
        recordGroups ? recordGroups.flatMap((group) => (collapsedGroups.has(group.key) ? [] : group.records)) : visibleRecords
      ).map((r) => r.id);
      const isFocusedRowVisible = focusedRowId != null && visibleIds.includes(focusedRowId);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "next"));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRowId((current) => computeNextFocusedRowId(visibleIds, current, "prev"));
      } else if (e.key === "Enter" && isFocusedRowVisible && !e.defaultPrevented && !enterTargetsInteractiveElement(e.target)) {
        const record = visibleRecords.find((r) => r.id === focusedRowId);
        if (record) {
          e.preventDefault();
          startEdit(record);
        }
      } else if (e.key === "x" && isFocusedRowVisible) {
        e.preventDefault();
        toggleSelected(focusedRowId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && isFocusedRowVisible) {
        e.preventDefault();
        handleDelete(focusedRowId);
      } else if (e.key === "d" && isFocusedRowVisible) {
        e.preventDefault();
        handleDuplicate(focusedRowId);
      } else if (e.key === "Escape" && selectedIds.size > 0) {
        e.preventDefault();
        setSelectedIds(new Set());
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode, visibleRecords, focusedRowId, selectedIds, recordGroups, collapsedGroups]);

  /**
   * Ctrl/Cmd+Z triggers the delete-undo toast's own "Undo" action --
   * Delete/Backspace above is a real keyboard shortcut, but undoing that
   * exact delete had none, a small but real inconsistency in an otherwise
   * keyboard-first flow. Not scoped to table view (unlike the j/k/x/d
   * effect above) since the undo window (UNDO_WINDOW_MS) can still be
   * open after switching to board/calendar view. e.shiftKey is excluded
   * since Ctrl/Cmd+Shift+Z is the common OS/app convention for Redo,
   * which this app has no equivalent action for. handleUndoDelete itself
   * already no-ops via pendingDeleteRef when nothing is pending. Mirrors
   * the live Forge AI preview's own EntityPanel.tsx.
   */
  useEffect(() => {
    function handleKeyDown(e) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      if (isTypingTarget(e.target) || isAnyDialogOpen()) return;
      if (!pendingDeleteRef.current) return;
      e.preventDefault();
      handleUndoDelete();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /**
   * "n" jumps straight to a blank add-record form, abandoning whatever
   * edit was in progress -- unlike j/k/Enter above, this isn't scoped to
   * table view: the form itself renders above the table/board/calendar
   * switch and stays reachable from any of them, so the shortcut has to
   * stay active in all three too. Mirrors the live Forge AI preview's own
   * EntityPanel.tsx, including its round-653 modifier-key guard.
   */
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== "n" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || isAnyDialogOpen()) return;
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
        // \`form\` holds a value for EVERY field, including every one the
        // user never touched -- startEdit below just snapshots the whole
        // record into it. Sending \`form\` as-is PATCHes every field back
        // verbatim, reviving whatever stale value was on screen when the
        // dialog opened. If another tab, a drag, or an automation
        // legitimately changed an untouched field on this same record
        // while the dialog was open, saving this form would silently
        // overwrite that real change with the stale one. Every sibling
        // mutation path (commitInlineEdit, handleBulkUpdate, the drag
        // handlers) already sends only the field(s) it actually means to
        // change -- diffing against the snapshot startEdit took, rather
        // than sending \`form\` whole, brings this form in line with that
        // same convention. Mirrors the live Forge AI preview's own fix.
        const original = editingOriginalRef.current;
        const changedOnly = {};
        for (const f of entity.fields) {
          if (!original || form[f.name] !== original[f.name]) {
            changedOnly[f.name] = form[f.name];
          }
        }
        await updateRecord(entity.name, editingId, changedOnly);
      } else {
        await createRecord(entity.name, form);
      }
      setForm(emptyForm(entity));
      setEditingId(null);
      editingOriginalRef.current = null;
      setFormInstanceKey((k) => k + 1);
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
    editingOriginalRef.current = record;
    setFormInstanceKey((k) => k + 1);
  }

  function startCreateForColumn(value, field) {
    setEditingId(null);
    setForm({ ...emptyForm(entity), [field.name]: value });
    setFormInstanceKey((k) => k + 1);
  }

  function startCreateForDate(date, field) {
    setEditingId(null);
    setForm({ ...emptyForm(entity), [field.name]: formatDateForInput(date) });
    setFormInstanceKey((k) => k + 1);
  }

  // The "n" shortcut's own target -- discards an in-progress edit (if
  // any), resets the form, and moves focus to it.
  function startCreateNew() {
    setEditingId(null);
    setForm(emptyForm(entity));
    setFormInstanceKey((k) => k + 1);
    const formEl = document.querySelector(".record-form");
    scrollIntoViewRespectingMotion(formEl, { behavior: "smooth", block: "start" });
    // The record form's own fields now remount on every target switch
    // (keyed on formInstanceKey, just incremented above) -- querying for
    // the first field synchronously here would still find the OLD,
    // about-to-be-replaced node, since React's own state updates only
    // commit after this synchronous handler returns. Deferred one tick.
    setTimeout(() => {
      const firstField = document.querySelector(".record-form input, .record-form select, .record-form textarea");
      firstField?.focus();
    }, 0);
  }

  // Toggles one group's collapsed state and persists the full updated set.
  function toggleGroupCollapsed(groupKey) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      setPersistedCollapsedGroups(entity.name, groupFieldName, [...next]);
      return next;
    });
  }

  // Mirrors toggleGroupCollapsed above, for board columns instead of table groups.
  function toggleBoardColumnCollapsed(columnValue) {
    setCollapsedBoardColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnValue)) next.delete(columnValue);
      else next.add(columnValue);
      setPersistedCollapsedBoardColumns(entity.name, boardField ? boardField.name : "", [...next]);
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
  // Returns whether the record was actually (optimistically) removed, so
  // the record-form's own Delete button below knows whether to close
  // itself -- a caller that just fires-and-forgets (the table row/board
  // card's own Delete button) can ignore the return value entirely.
  function handleDelete(id) {
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return false;
    const record = records[index];
    const label = recordDisplayLabel(entity, record);
    if (!window.confirm(\`Delete "\${label}"? You can undo this for a few seconds after deleting.\`)) return false;

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
    return true;
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
    const visibleIds = effectivelyVisibleRecords.map((r) => r.id);
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
    if (bulkActionBusy) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkActionBusy(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => {
          const record = records.find((r) => r.id === id);
          if (!record) return Promise.reject(new Error("This record no longer exists."));
          const copy = {};
          for (const f of entity.fields) copy[f.name] = record[f.name];
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
    } finally {
      setBulkActionBusy(false);
    }
  }

  // Changing a single shared field's value across several selected records
  // (e.g. marking 15 selected orders "Shipped", or reassigning a batch of
  // orders to a different customer) still meant editing each row one at a
  // time without this -- same Promise.allSettled resilience as
  // handleBulkDelete/handleBulkDuplicate above. Round 779: bulkEditValue
  // is already in the right shape to PATCH directly -- for a relation
  // field it's the chosen record's own id, the exact same value the
  // single-record add/edit form sends through this same updateRecord call.
  async function handleBulkUpdate() {
    if (bulkActionBusy) return;
    const ids = [...selectedIds];
    if (ids.length === 0 || !bulkEditField) return;
    // Mirrors the single-record add/edit form's own pre-submit required-field
    // check above -- without it, leaving a required field at its default
    // blank value fires one doomed PATCH per selected record.
    const bulkEditFieldDef = entity.fields.find((f) => f.name === bulkEditField);
    if (bulkEditFieldDef?.required && (bulkEditValue === "" || bulkEditValue == null)) {
      setError(\`"\${bulkEditFieldDef.label || bulkEditFieldDef.name}" is a required field\`);
      return;
    }
    if (!window.confirm(\`Set this field on \${ids.length} records? This cannot be undone.\`)) return;
    setBulkActionBusy(true);
    setError(null);
    try {
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
    } finally {
      setBulkActionBusy(false);
    }
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

  // Sets the suppress flag before clearing editingCell, for the same
  // reason cancelInlineEdit below does -- a stale blur after unmount can
  // otherwise fire a second real commitInlineEdit() for the same value.
  async function commitInlineEdit() {
    if (!editingCell) return;
    const { recordId, field } = editingCell;
    const value = cellDraft;
    // Mirrors handleBulkUpdate's own identical check above -- without it,
    // clearing a required cell and committing fires a doomed PATCH.
    const fieldDef = entity.fields.find((f) => f.name === field);
    if (fieldDef?.required && (value === "" || value == null)) {
      setError(\`"\${fieldDef.label || fieldDef.name}" is a required field\`);
      setMoveErrorId(recordId);
      return;
    }
    suppressCellBlurCommitRef.current = true;
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
    // A column accepts any drag, not just this board's own cards -- an
    // entity tab (its own onDragStart never calls setData, so its
    // text/plain payload is "") or a file dragged in from the desktop both
    // land here too. Number("") is 0, not NaN, so the check above alone
    // lets id 0 through; without this guard, a nonexistent record would
    // still reach handleMove below, PATCHing an id that was never dragged
    // and surfacing a real "Record 0 not found" error banner. Mirrors the
    // live preview's own fix (round 656) and this file's own calendar
    // drop handler just below, which already guards the identical case.
    if (!record) return;
    // Dropping a card back onto the column it's already in is a real
    // no-op -- nothing actually changed, so there's nothing worth a PATCH
    // request for.
    if (String(record[fieldName] ?? "") === value) return;
    void handleMove(id, fieldName, value);
  }

  // The calendar view's own drag-and-drop, the direct sibling of
  // handleCardDrop above -- dragging a record's chip onto a different day
  // reschedules it there without opening the edit form. Reuses the same
  // handleMoveFields PATCH+refresh, just addressed by the date field's own
  // name and a freshly-formatted "YYYY-MM-DD" value. For a ranged entity
  // (e.g. Rental's startDate/endDate), buildCalendarMonth renders the SAME
  // chip on every day the booking spans, and every instance is draggable --
  // so the day actually dragged (originDay, carried through dataTransfer by
  // the chip's own onDragStart) is not necessarily the record's current
  // start day. Shifting BOTH start and end by the delta between the
  // dropped-on day and originDay (rather than always anchoring start to the
  // drop target) keeps the booking's real duration and moves it by exactly
  // the days dragged, whichever day of the span was grabbed. When originDay
  // is unavailable or equals the record's own start value (the common case
  // of dragging the start day's chip), this reduces to the original
  // start-anchored behavior. Mirrors the live preview's own EntityPanel.tsx
  // (round 211, extended round 383, fixed round 599).
  function handleCalendarDrop(record, dateFieldName, date, originDay) {
    const value = formatDateForInput(date);
    const originValue = originDay ?? String(record[dateFieldName] ?? "");
    if (originValue === value) return;
    const fields = {};
    if (endDateField && dateField && dateFieldName === dateField.name) {
      const rawOldStart = record[dateFieldName];
      const rawEnd = record[endDateField.name];
      if (rawOldStart !== null && rawOldStart !== undefined && rawOldStart !== "" && rawEnd !== null && rawEnd !== undefined && rawEnd !== "") {
        const oldStart = parseFieldDate(String(rawOldStart));
        const oldEnd = parseFieldDate(String(rawEnd));
        const origin = parseFieldDate(originValue);
        if (
          !Number.isNaN(oldStart.getTime()) &&
          !Number.isNaN(oldEnd.getTime()) &&
          !Number.isNaN(origin.getTime()) &&
          oldEnd.getTime() >= oldStart.getTime()
        ) {
          const deltaDays = Math.round((date.getTime() - origin.getTime()) / (24 * 60 * 60 * 1000));
          const newStart = new Date(oldStart);
          newStart.setDate(newStart.getDate() + deltaDays);
          const newEnd = new Date(oldEnd);
          newEnd.setDate(newEnd.getDate() + deltaDays);
          fields[dateFieldName] = formatDateForInput(newStart);
          fields[endDateField.name] = formatDateForInput(newEnd);
        }
      }
    }
    if (!fields[dateFieldName]) fields[dateFieldName] = value;
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
    const csv = recordsToCsv(orderedFields, selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds), relatedRecords, true);
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
      const csv = recordsToCsv(orderedFields, selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds), relatedRecords);
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
    const ics = buildCalendarIcs(entity, dateField, labelField, icsMonthRecords, relatedRecords, new Date(), endDateField, orderedFields);
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
  // record payloads (already validated client-side), then writes each
  // valid row. Uses allSettled rather than assuming success once
  // client-side validation passes, since the server has the final say.
  // A row whose id buildImportRecords resolved (handleExportCsv's own
  // leading "id" column, round-tripped) is PATCHed instead of POSTed, so
  // re-importing an edited copy of your own export updates those exact
  // records instead of creating a duplicate for every one of them.
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
      const { records: parsedRecords, errors: parseErrors } = buildImportRecords(entity.fields, rows, relatedRecords);

      if (parsedRecords.length === 0) {
        setImportErrors(parseErrors);
        setImportMessage(
          parseErrors.length > 0 ? \`Import failed: \${parseErrors.length} errors. No records were created.\` : "The file contained no data rows to import.",
        );
        return;
      }

      const results = await Promise.allSettled(
        parsedRecords.map((record) => {
          const { id, ...data } = record;
          return id != null ? updateRecord(entity.name, id, data) : createRecord(entity.name, data);
        }),
      );
      const serverErrors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
      let createdCount = 0;
      let updatedCount = 0;
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        if (parsedRecords[i].id != null) updatedCount += 1;
        else createdCount += 1;
      });
      const allErrors = [...parseErrors, ...serverErrors];
      setImportErrors(allErrors);
      setImportMessage(
        updatedCount === 0
          ? allErrors.length === 0
            ? \`Imported \${createdCount} records successfully.\`
            : \`Imported \${createdCount} records, skipped \${allErrors.length} rows.\`
          : allErrors.length === 0
            ? \`Imported \${createdCount} new records and updated \${updatedCount} existing records.\`
            : \`Imported \${createdCount} new records, updated \${updatedCount} existing records, skipped \${allErrors.length} rows.\`,
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
                    // A longtext field's own <textarea> has no other way
                    // to insert a newline -- mirrors the full add/edit
                    // form's own identical carve-out. Mirrors the live
                    // Forge AI preview's own EntityPanel.tsx.
                    if (f.type === "longtext" && !(e.ctrlKey || e.metaKey)) return;
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
                highlightQuery={search}
                onJumpToRecord={onJumpToRecord}
              />
            )}
          </td>
        );
      })}
      <td className="muted small created-at-cell">{formatRecordCreatedAt(r.createdAt)}</td>
      <td className="row-actions">
        <button onClick={() => startEdit(r)}>Edit</button>
        <button onClick={() => handleDuplicate(r.id)}>Duplicate</button>
        <button onClick={() => setRecordToPrint(r)}>Print</button>
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
        {/* The create/edit form follows the same drag-reordered column
            order as every other whole-record action -- mirrors the live
            preview's own EntityPanel.tsx (round 678); handleSubmit builds
            a plain keyed object regardless of field order. */}
        {orderedFields.map((f) => (
          <label className="field" key={\`\${f.name}-\${formInstanceKey}\`}>
            <span>
              {fieldDisplayLabel(f, entityFieldLabelOccurrences)}
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
          {editingId != null && (
            <button type="button" onClick={() => handleDuplicate(editingId)}>
              Duplicate
            </button>
          )}
          {editingId != null && (
            <button
              type="button"
              onClick={() => {
                const id = editingId;
                const deleted = handleDelete(id);
                // Only close the form once the delete actually went through
                // -- window.confirm's own Cancel (handleDelete returning
                // false) must leave the in-progress edit exactly as it was.
                if (deleted) {
                  setForm(emptyForm(entity));
                  setEditingId(null);
                  editingOriginalRef.current = null;
                  setFormInstanceKey((k) => k + 1);
                }
              }}
            >
              Delete
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
            <span className="muted entity-record-count">
              {formatEntityRecordCount(visibleRecords.length, records.length)}
            </span>
            {filterableFields.map((f) => {
              // A filter already set to a related record's id, with that
              // record since deleted while the relation field itself
              // survives, has no matching <option> below -- which silently
              // blanks this controlled <select> even though fieldFilters
              // stays set to the now-deleted id. The same "stale value has
              // no <option>" bug class FieldInput's own relation branch
              // already guards against. (The enum branch has the same
              // shape in the live preview app, but can't actually occur
              // here -- this exported app's schema is frozen, so
              // f.enumValues never changes after export.)
              const currentFilterValue = fieldFilters[f.name] || "";
              const knownRelationRecords = f.type === "relation" ? relatedRecords[f.relationTo] || [] : [];
              const hasCurrentRelationOption =
                f.type !== "relation" || currentFilterValue === "" || knownRelationRecords.some((r) => String(r.id) === currentFilterValue);
              return (
              <select
                key={f.name}
                className="entity-status-filter"
                aria-label={"Filter by " + fieldDisplayLabel(f, filterableFieldLabelOccurrences)}
                value={currentFilterValue}
                onChange={(e) =>
                  setFieldFilters((prev) => {
                    const next = { ...prev, [f.name]: e.target.value };
                    setPersistedFieldFilters(entity.name, next);
                    return next;
                  })
                }
              >
                <option value="">{"All " + fieldDisplayLabel(f, filterableFieldLabelOccurrences)}</option>
                {f.type === "boolean" ? (
                  <>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </>
                ) : f.type === "relation" ? (
                  <>
                    {!hasCurrentRelationOption && <option value={currentFilterValue}>{\`#\${currentFilterValue}\`}</option>}
                    {knownRelationRecords.map((r) => (
                      <option key={r.id} value={String(r.id)}>
                        {recordDisplayLabel(ALL_ENTITIES.find((e) => e.name === f.relationTo), r)}
                      </option>
                    ))}
                  </>
                ) : (
                  uniqueEnumValues(f.enumValues).map((v) => (
                    <option key={v} value={v}>
                      {(f.enumLabels && f.enumLabels[v]) || v}
                    </option>
                  ))
                )}
              </select>
              );
            })}
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
                    {fieldDisplayLabel(f, groupableFieldLabelOccurrences)}
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
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
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
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
            >
              {selectedIds.size > 0 ? <>⬇️ Export {selectedIds.size} selected</> : "⬇️ Export CSV"}
            </button>
            <button
              type="button"
              className="print-list-btn"
              onClick={() => setShowPrintList(true)}
              disabled={selectedIds.size === 0 && effectivelyVisibleRecords.length === 0}
            >
              {selectedIds.size > 0 ? <>🖨️ Print {selectedIds.size} selected</> : "🖨️ Print list"}
            </button>
            <div className="columns-menu-wrapper">
              <button type="button" className="columns-menu-btn" onClick={() => setColumnsMenuOpen((v) => !v)} aria-expanded={columnsMenuOpen}>
                🧩 Columns
              </button>
              {columnsMenuOpen && (
                <div className="columns-menu-panel">
                  {orderedFields.map((f) => (
                    <label key={f.name} className="columns-menu-item">
                      <input type="checkbox" checked={!hiddenFields.has(f.name)} onChange={() => handleToggleColumn(f.name)} />
                      {fieldDisplayLabel(f, orderedFieldLabelOccurrences)}
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
                      orderedFields={orderedFields}
                      boardField={boardField}
                      record={r}
                      relatedRecords={relatedRecords}
                      highlightQuery={search}
                      hasMoveError={r.id === moveErrorId}
                      onMove={(value) => handleMove(r.id, boardField.name, value)}
                      onEdit={() => startEdit(r)}
                      onDuplicate={() => handleDuplicate(r.id)}
                      onDelete={() => handleDelete(r.id)}
                      onPrint={() => setRecordToPrint(r)}
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
              onJumpToMonth={(m) => setCalendarMonth(m)}
              onEdit={startEdit}
              onDayClick={(date) => startCreateForDate(date, dateField)}
              onReschedule={(record, date, originDay) => handleCalendarDrop(record, dateField.name, date, originDay)}
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
                      {bulkEditableFields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {fieldDisplayLabel(f, bulkEditableFieldLabelOccurrences)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {bulkEditField && bulkEditFieldDef && (
                    <FieldInput
                      entity={entity}
                      field={bulkEditFieldDef}
                      value={bulkEditValue}
                      onChange={setBulkEditValue}
                      relatedEntity={bulkEditFieldDef.relationTo ? ALL_ENTITIES.find((e) => e.name === bulkEditFieldDef.relationTo) : undefined}
                      relatedEntityRecords={bulkEditFieldDef.relationTo ? relatedRecords[bulkEditFieldDef.relationTo] : undefined}
                    />
                  )}
                  {bulkEditField && (
                    <button type="button" disabled={bulkActionBusy} onClick={handleBulkUpdate}>
                      {bulkActionBusy ? "Updating…" : \`Apply to \${selectedIds.size}\`}
                    </button>
                  )}
                  <button type="button" disabled={bulkActionBusy} onClick={handleBulkDuplicate}>
                    {bulkActionBusy ? "Duplicating…" : "📋 Duplicate selected"}
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
                        checked={effectivelyVisibleRecords.length > 0 && effectivelyVisibleRecords.every((r) => selectedIds.has(r.id))}
                        ref={(el) => {
                          if (!el) return;
                          const someSelected = effectivelyVisibleRecords.some((r) => selectedIds.has(r.id));
                          const allSelected = effectivelyVisibleRecords.length > 0 && effectivelyVisibleRecords.every((r) => selectedIds.has(r.id));
                          el.indeterminate = someSelected && !allSelected;
                        }}
                        onChange={toggleSelectAllVisible}
                      />
                    </th>
                    {visibleFields.map((f, visibleIndex) => {
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
                            {fieldDisplayLabel(f, visibleFieldLabelOccurrences)}
                            {key ? (key.direction === "asc" ? " ▲" : " ▼") : ""}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                          <span className="column-move-buttons">
                            <button
                              type="button"
                              className="column-move-btn"
                              onClick={() => handleMoveColumn(f.name, "earlier")}
                              disabled={visibleIndex === 0}
                              aria-label={\`Move \${fieldDisplayLabel(f, visibleFieldLabelOccurrences)} column earlier\`}
                            >
                              ‹
                            </button>
                            <button
                              type="button"
                              className="column-move-btn"
                              onClick={() => handleMoveColumn(f.name, "later")}
                              disabled={visibleIndex === visibleFields.length - 1}
                              aria-label={\`Move \${fieldDisplayLabel(f, visibleFieldLabelOccurrences)} column later\`}
                            >
                              ›
                            </button>
                          </span>
                          <span
                            className="column-resize-handle"
                            role="slider"
                            tabIndex={0}
                            aria-orientation="horizontal"
                            aria-valuemin={MIN_COLUMN_WIDTH}
                            aria-valuemax={MAX_COLUMN_WIDTH}
                            aria-valuenow={Math.round(columnWidths[f.name] ?? 150)}
                            aria-label={\`Resize \${fieldDisplayLabel(f, visibleFieldLabelOccurrences)} column (use left/right arrow keys)\`}
                            onMouseDown={(e) => startResize(e, f.name)}
                            onKeyDown={(e) => handleResizeKeyDown(e, f.name)}
                          />
                        </th>
                      );
                    })}
                    {(() => {
                      const keyIndex = sortKeys.findIndex((k) => k.field === "createdAt");
                      const key = keyIndex === -1 ? null : sortKeys[keyIndex];
                      return (
                        <th aria-sort={keyIndex === 0 ? (key.direction === "asc" ? "ascending" : "descending") : "none"}>
                          <button type="button" className="sort-header" onClick={(e) => toggleSort("createdAt", e.shiftKey)}>
                            Created
                            {key ? (key.direction === "asc" ? " ▲" : " ▼") : ""}
                            {key && sortKeys.length > 1 && <span className="sort-priority">{keyIndex + 1}</span>}
                          </button>
                        </th>
                      );
                    })()}
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
      <RecordPrintSheet entity={entity} fields={orderedFields} record={recordToPrint} relatedRecords={relatedRecords} />
      <RecordListPrintSheet
        entity={entity}
        fields={orderedFields}
        records={selectedOrAllRecords(records, effectivelyVisibleRecords, selectedIds)}
        relatedRecords={relatedRecords}
        show={showPrintList}
      />
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
import {
  matchesSearch,
  recordDisplayLabel,
  markDialogOpen,
  markDialogClosed,
  DIALOG_FOCUSABLE_SELECTOR,
  hideDialogBackgroundFromAssistiveTech,
  scrollIntoViewRespectingMotion,
} from "./EntityView.jsx";

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
  // Entity groups are shown in descending totalMatches order rather than
  // whichever order the project's entities happen to be declared in --
  // mirrors the live preview's own GlobalSearchPanel.tsx fix. Array.sort
  // is stable (ES2019+), so two entities tied on totalMatches keep their
  // original declared order.
  results.sort((a, b) => b.totalMatches - a.totalMatches);
  const failures = settled.filter((r) => r.status === "rejected");
  return { results, failures, recordsByEntity };
}

// Renders the already-fetched results as a plain, shareable text snapshot --
// same "plain text, not a PDF" reasoning the live preview's own
// searchReport.ts uses for its Copy/Download buttons, which the exported
// app's own GlobalSearch never had at all. expandedSamples mirrors exactly
// what the panel itself is currently showing (including any "Show all"
// expansions, see searchReport.ts's own formatSearchResults), so the
// copied/downloaded text never disagrees with what's actually on screen.
function formatGlobalSearchReport(results, entities, expandedSamples, query) {
  const lines = [\`Search everything — "\${query}"\`, \`Generated \${new Date().toLocaleString()}\`, ""];
  if (results.length === 0) {
    lines.push("No matching results in any entity.");
    return lines.join("\\n").trimEnd();
  }
  for (const result of results) {
    const entity = entities.find((e) => e.name === result.entityName);
    const displayed = expandedSamples[result.entityName] ?? result.sample;
    lines.push(\`\${result.entityLabel} — \${result.totalMatches} results\`);
    for (const record of displayed) {
      lines.push(\`- \${entity ? recordDisplayLabel(entity, record) : "#" + record.id}\`);
    }
    const remaining = result.totalMatches - displayed.length;
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
  const dialogRef = useRef(null);
  // Captured during render, not inside the effect below: an effect runs
  // after React has already committed this render's DOM, which includes
  // applying the search input's own autoFocus. By the time an effect ran,
  // document.activeElement would already be that input, not the real
  // trigger (the toolbar/search-trigger button the user clicked to open
  // this overlay) -- so focus could never actually return to the trigger
  // on close. Mirrors the live preview's own useDialogFocusTrap.ts.
  const previouslyFocusedRef = useRef(document.activeElement);

  // Flips isAnyDialogOpen() on while this overlay is mounted, so
  // EntityView's own table keyboard shortcuts stop firing underneath it.
  useEffect(() => {
    markDialogOpen();
    return () => {
      markDialogClosed();
    };
  }, []);

  // Real dialog behavior, mirroring the live preview's own
  // useDialogFocusTrap.ts: moves focus into the panel on open (unless the
  // search input's own autoFocus already put it there), keeps Tab/Shift+Tab
  // cycling within the panel instead of leaking into the entity table
  // sitting (only visually) behind it, hides that background from
  // assistive tech, and returns focus to whatever triggered this overlay
  // once it closes.
  useEffect(() => {
    const container = dialogRef.current;
    if (!container) return;
    const previouslyFocused = previouslyFocusedRef.current;
    const restoreBackground = hideDialogBackgroundFromAssistiveTech(container);

    function getFocusable() {
      return Array.from(container.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR));
    }

    if (!container.contains(document.activeElement)) {
      const [first] = getFocusable();
      if (!first) container.tabIndex = -1;
      (first || container).focus();
    }

    function handleTabTrap(e) {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handleTabTrap);
    return () => {
      container.removeEventListener("keydown", handleTabTrap);
      restoreBackground();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
  }, []);

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
    scrollIntoViewRespectingMotion(group, { behavior: "smooth", block: "nearest" });
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
  // one. Also patches this entity's own totalMatches in results to this
  // fresh fetch's real count: without it, data that changed since the
  // original search left the header's "N results" text and the remaining
  // calculation reading the original search's now-stale count even though
  // the displayed rows already reflect this fetch's real, current data.
  // Also surfaces a failed fetch via setError (round 663): without this,
  // a rejected listRecords call was an unhandled promise rejection -- the
  // "Loading…" button silently reverted to "Show N more" with zero visible
  // indication anything went wrong, unlike runSearch's own identical
  // listRecords call just above, which already surfaces a failure through
  // this same error banner.
  async function handleShowAll(entityName) {
    const entity = entities.find((e) => e.name === entityName);
    if (!entity) return;
    const requestId = searchRequestId.current;
    setShowAllLoading((prev) => new Set(prev).add(entityName));
    try {
      const { records } = await listRecords(entityName);
      if (searchRequestId.current !== requestId) return;
      // Keeps the shared relation-label lookup in sync with the fresh data
      // this fetch just pulled -- without this, a DIFFERENT entity's own
      // later "Show all" (which reads this exact ref for resolving a
      // relation field pointing at entityName) kept matching against this
      // entity's data as it stood at the ORIGINAL search, not the fresh
      // snapshot already sitting right here in memory.
      lastRecordsByEntityRef.current = { ...lastRecordsByEntityRef.current, [entityName]: records };
      const full = records.filter((r) => matchesSearch(r, entity.fields, query, lastRecordsByEntityRef.current));
      setExpandedSamples((prev) => ({ ...prev, [entityName]: full }));
      setResults((prev) => prev.map((r) => (r.entityName === entityName ? { ...r, totalMatches: full.length } : r)));
    } catch (err) {
      setError(err.message);
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
      await navigator.clipboard.writeText(formatGlobalSearchReport(results, entities, expandedSamples, query));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  function handleDownload() {
    const text = formatGlobalSearchReport(results, entities, expandedSamples, query);
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
    if (e.key === "Escape" && query.length > 0) {
      e.preventDefault();
      setQuery("");
      return;
    }
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
      <div className="search-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="global-search-title">
        <div className="search-header">
          <h2 id="global-search-title">🔍 Search everything</h2>
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
            data-escape-handled-locally={query.length > 0 ? "" : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <button type="submit" disabled={!query.trim()}>Search</button>
        </form>

        {error && (
          <div className="error-retry-row">
            <p className="error" role="status">{error}</p>
            <button type="button" onClick={() => { setExpandedSamples({}); runSearch(query); }}>
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

/**
 * Mirrors the live Forge AI preview's own ShortcutsPanel.tsx: the exported
 * app ported every keyboard-shortcut *mechanic* (j/k row nav, Enter→edit,
 * x→toggle select, n→new record, Delete/Backspace→delete, d→duplicate,
 * Ctrl/Cmd+Enter→submit, Ctrl/Cmd+K and "/"→search) but never gave its own
 * users any way to discover them -- pressing "?" (the convention "/" itself
 * already borrows from Slack/GitHub) did nothing, and the one static
 * "Ctrl+K" hint next to the search button never mentioned the other seven.
 * This static list dialog, and the "?" wiring in App.jsx below, close that
 * gap so a real end user of the exported app -- who has no way back to the
 * Forge AI platform or its docs -- can actually find this feature set.
 */
function renderShortcutsPanelJsx(): string {
  return `import { useEffect, useRef } from "react";
import {
  markDialogOpen,
  markDialogClosed,
  DIALOG_FOCUSABLE_SELECTOR,
  hideDialogBackgroundFromAssistiveTech,
} from "./EntityView.jsx";

const SHORTCUTS = [
  { keys: ["Ctrl", "K"], description: "Open search across the whole app" },
  { keys: ["/"], description: "Open search across the whole app" },
  { keys: ["?"], description: "Show this shortcuts list" },
  { keys: ["Esc"], description: "Close the open panel" },
  { keys: ["j", "↓"], description: "Move to the next table row" },
  { keys: ["k", "↑"], description: "Move to the previous table row" },
  { keys: ["Enter"], description: "Edit the focused table row" },
  { keys: ["x"], description: "Select/deselect the focused row" },
  { keys: ["n"], description: "Jump to the add-record form" },
  { keys: ["Delete", "Backspace"], description: "Delete the focused table row" },
  { keys: ["Ctrl", "Z"], description: "Undo the last delete" },
  { keys: ["d"], description: "Duplicate the focused table row" },
  { keys: ["Ctrl", "Enter"], description: "Submit the form (even from a multi-line text field)" },
  { keys: ["Esc"], description: "Clear the table's multi-row selection" },
];

export function ShortcutsPanel({ onClose }) {
  const dialogRef = useRef(null);
  // Captured during render, not inside the effect below: an effect runs
  // after React has already committed this render's DOM. By the time an
  // effect ran, document.activeElement would already be whatever this
  // panel's own focus-move-in logic focused, not the real trigger (the
  // topbar button the user clicked to open it) -- so focus could never
  // actually return to the trigger on close. Mirrors GlobalSearch.jsx and
  // the live preview's own useDialogFocusTrap.ts.
  const previouslyFocusedRef = useRef(document.activeElement);

  // Flips isAnyDialogOpen() on while this overlay is mounted, so
  // EntityView's own table keyboard shortcuts stop firing underneath it --
  // without this, pressing "n"/"Delete"/"d" while just reading this very
  // cheat-sheet (focus starts on its own Close button, since the panel has
  // no text input to autoFocus instead) would silently discard an
  // in-progress edit, pop a delete confirmation, or duplicate a record the
  // user wasn't even looking at.
  useEffect(() => {
    markDialogOpen();
    return () => {
      markDialogClosed();
    };
  }, []);

  // Real dialog behavior, mirroring GlobalSearch.jsx's own trap and the
  // live preview's useDialogFocusTrap.ts: moves focus into the panel on
  // open, keeps Tab/Shift+Tab cycling within it instead of leaking into the
  // entity table sitting (only visually) behind it, hides that background
  // from assistive tech, and returns focus to whatever triggered this
  // panel once it closes.
  useEffect(() => {
    const container = dialogRef.current;
    if (!container) return;
    const previouslyFocused = previouslyFocusedRef.current;
    const restoreBackground = hideDialogBackgroundFromAssistiveTech(container);

    function getFocusable() {
      return Array.from(container.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR));
    }

    if (!container.contains(document.activeElement)) {
      const [first] = getFocusable();
      if (!first) container.tabIndex = -1;
      (first || container).focus();
    }

    function handleTabTrap(e) {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handleTabTrap);
    return () => {
      container.removeEventListener("keydown", handleTabTrap);
      restoreBackground();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
  }, []);

  return (
    <div className="search-overlay">
      <div className="search-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div className="search-header">
          <h2 id="shortcuts-title">⌨️ Keyboard shortcuts</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <ul className="shortcuts-list">
          {SHORTCUTS.map((row, i) => (
            <li key={i} className="shortcuts-row">
              <span className="shortcuts-keys">
                {row.keys.map((key, j) => (
                  <kbd key={j}>{key}</kbd>
                ))}
              </span>
              <span>{row.description}</span>
            </li>
          ))}
        </ul>
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

  return `import { useEffect, useMemo, useRef, useState } from "react";
import { listEntityCounts } from "./api.js";
import { GlobalSearch } from "./components/GlobalSearch.jsx";
import { ShortcutsPanel } from "./components/ShortcutsPanel.jsx";
import { isAnyDialogOpen } from "./components/EntityView.jsx";
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

// Mirrors the live preview's own isEditableEventTarget (App.tsx) verbatim:
// guards a single-character keyboard shortcut so it doesn't hijack that
// character when it's typed into an ordinary text field instead.
function isEditableEventTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [highlightRecordId, setHighlightRecordId] = useState(null);
  const storedTheme = readStoredTheme();
  const [theme, setTheme] = useState(() => detectInitialTheme(storedTheme, prefersDarkFromSystem()));
  // theme.js's own contract is "an explicit stored choice always wins;
  // otherwise falls back to the system preference" -- but persisting every
  // theme, including one just derived from the system, on mount would
  // silently turn "no choice yet" into "an explicit choice" on a person's
  // very first visit, so neither a later system light/dark switch nor a
  // fresh reload could ever follow the system again on that device
  // (mirrors the live preview's own ThemeContext.tsx fix). This ref tracks
  // whether a real explicit choice (found in storage at mount, or made via
  // the theme-switch button below) exists, and only *that* gets persisted
  // or blocks the system-change listener below.
  const hasExplicitChoiceRef = useRef(storedTheme === "light" || storedTheme === "dark");
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

  // handleReorderEntityTab above is drag-and-drop only -- the same
  // keyboard-accessibility gap the live preview's own handleMoveColumn
  // (EntityPanel.tsx, round 478) already closed for table columns. Mirrors
  // the live preview's own handleMoveEntityTab (App.tsx, round 662).
  function handleMoveEntityTab(entityName, direction) {
    const index = orderedEntities.findIndex((e) => e.name === entityName);
    if (index === -1) return;
    const neighborIndex = direction === "earlier" ? index - 1 : index + 1;
    if (neighborIndex < 0 || neighborIndex >= orderedEntities.length) return;
    const neighborName = orderedEntities[neighborIndex].name;
    const fullOrder = orderedEntities.map((e) => e.name);
    const next =
      direction === "earlier"
        ? reorderEntityTabs(fullOrder, entityName, neighborName)
        : reorderEntityTabs(fullOrder, neighborName, entityName);
    setEntityTabOrderState(setEntityTabOrder(next));
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
  // Escape closes it -- unless GlobalSearch's own input still has an
  // unsaved query, in which case the first Escape clears that query
  // instead (mirrors the live preview's own GlobalSearchPanel.tsx +
  // useDialogFocusTrap.ts data-escape-handled-locally convention: GlobalSearch
  // marks its input while there's text in it, and this listener checks for
  // that marker before closing, so clearing the search box doesn't cost the
  // whole overlay on the very same keypress).
  //
  // "/" is a second, equally familiar way to open the same search (round
  // 199 in the live preview, App.tsx), guarded by isEditableEventTarget so
  // it doesn't hijack every literal "/" a person types into this entity's
  // own search box or a record's text field instead of opening the overlay.
  //
  // isAnyDialogOpen() guards all three open branches (round 655): showSearch
  // and showShortcuts are two independent booleans, not mutually exclusive
  // like the live preview's own openPanel() -- without this, pressing "?"
  // then "/" (or the reverse) stacked GlobalSearch and ShortcutsPanel on top
  // of each other, and each one's own hideDialogBackgroundFromAssistiveTech
  // marked the OTHER overlay (not just the real background) inert and
  // aria-hidden, trapping focus in whichever panel mounted first while the
  // one actually visible on top became unreachable by keyboard or screen
  // reader. Only the three open branches check it, not Escape below --
  // unlike the live preview, where Escape is handled separately by
  // useDialogFocusTrap.ts, this same handler's own Escape branch is what
  // closes an already-open dialog, so gating it the same way would make
  // Escape unable to close anything.
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        if (isAnyDialogOpen()) return;
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      if (e.key === "/" && !isEditableEventTarget(e.target)) {
        if (isAnyDialogOpen()) return;
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      if (e.key === "?" && !isEditableEventTarget(e.target)) {
        if (isAnyDialogOpen()) return;
        e.preventDefault();
        setShowShortcuts(true);
        return;
      }
      if (e.key === "Escape") {
        if (e.target && e.target.closest && e.target.closest("[data-escape-handled-locally]")) return;
        setShowSearch(false);
        setShowShortcuts(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Mirrors the live Forge AI preview's own ThemeProvider: the choice is
  // applied via a data-theme attribute on <html> so plain CSS variables
  // can react to it. Persistence itself lives in the theme-switch button's
  // own onClick below, not here -- see hasExplicitChoiceRef's comment.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Follows the OS light/dark switch live, same as the live preview, but
  // only until the user actually makes an explicit choice of their own via
  // the theme-switch button -- checked on every system change (not just at
  // listener-setup time), so an explicit choice made mid-session still
  // blocks a later system switch from silently overriding it.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    function handleSystemThemeChange(e) {
      if (hasExplicitChoiceRef.current) return;
      setTheme(e.matches ? "dark" : "light");
    }
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  return (
    <div className="app">
      <div className="app-header">
        <h1>{TITLE}</h1>
        <div className="app-header-actions">
          <button
            type="button"
            className="theme-switch"
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              hasExplicitChoiceRef.current = true;
              try {
                localStorage.setItem(THEME_STORAGE_KEY, next);
              } catch {
                // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
              }
              setTheme(next);
            }}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button type="button" className="search-trigger" onClick={() => setShowSearch(true)}>
            🔍 Search <span className="shortcut-hint">Ctrl+K · /</span>
          </button>
          <button type="button" className="search-trigger" onClick={() => setShowShortcuts(true)}>
            ⌨️ Keyboard shortcuts <span className="shortcut-hint">?</span>
          </button>
          <a className="backup-all-btn" href="/api/backup" download="backup.zip">
            ⬇️ Backup All Data
          </a>
        </div>
      </div>
      <nav>
        {orderedEntities.map((e, entityTabIndex) => (
          <span key={e.name} className="tab-wrapper">
            <button
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
            <span className="tab-move-buttons">
              <button
                type="button"
                className="tab-move-btn"
                onClick={() => handleMoveEntityTab(e.name, "earlier")}
                disabled={entityTabIndex === 0}
                aria-label={\`Move \${e.label} tab earlier\`}
              >
                ‹
              </button>
              <button
                type="button"
                className="tab-move-btn"
                onClick={() => handleMoveEntityTab(e.name, "later")}
                disabled={entityTabIndex === orderedEntities.length - 1}
                aria-label={\`Move \${e.label} tab later\`}
              >
                ›
              </button>
            </span>
          </span>
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
        // orderedEntities (the entity tab bar's own drag/keyboard-reordered
        // order), not the raw ENTITIES -- GlobalSearch's result groups and
        // arrow-key navigation follow this prop's own order exactly.
        <GlobalSearch
          entities={orderedEntities}
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
      {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}
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
.file-cell-link { display: inline-flex; align-items: center; }
.file-cell-name { color: var(--accent-deep); text-decoration: underline; }
.file-cell-thumbnail { max-width: 48px; max-height: 48px; border-radius: 4px; object-fit: cover; }
.file-field-input { display: flex; flex-direction: column; gap: 4px; }
.file-field-current { display: flex; align-items: center; gap: 8px; }
.search-match { background: var(--accent-soft); color: var(--accent-deep); border-radius: 3px; padding: 0 1px; }
.link-button:hover { opacity: 0.85; }
.entity-search { max-width: 280px; margin-bottom: 14px; }
.sort-header { background: none; border: none; padding: 0; margin: 0; color: inherit; font: inherit; cursor: pointer; }
.sort-header:hover { color: var(--accent); }
.sort-priority { display: inline-flex; align-items: center; justify-content: center; min-width: 15px; height: 15px; margin-inline-start: 3px; padding: 0 3px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-deep); font-size: 10px; font-weight: 700; vertical-align: middle; }
.resizable-col { position: relative; }
.resizable-col-drag-over { background: var(--accent-soft); }
.column-move-buttons { display: inline-flex; margin-inline-start: 4px; gap: 2px; }
.column-move-btn { background: none; border: none; padding: 0 2px; margin: 0; color: var(--muted); font: inherit; line-height: 1; cursor: pointer; }
.column-move-btn:hover:not(:disabled), .column-move-btn:focus-visible { color: var(--text); }
.column-move-btn:disabled { color: var(--muted); opacity: 0.35; cursor: default; }
.column-resize-handle { position: absolute; top: 0; bottom: 0; inset-inline-end: 0; width: 6px; cursor: col-resize; user-select: none; touch-action: none; z-index: 1; }
.column-resize-handle:focus-visible { outline: 2px solid var(--accent-deep); outline-offset: -1px; }
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
.entity-record-count { white-space: nowrap; }
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
.tab-wrapper { display: inline-flex; align-items: center; gap: 2px; }
.tab-move-buttons { display: inline-flex; gap: 1px; }
.tab-move-btn { background: none; border: none; padding: 0 2px; margin: 0; color: var(--muted); font: inherit; line-height: 1; cursor: pointer; }
.tab-move-btn:hover:not(:disabled), .tab-move-btn:focus-visible { color: var(--text); }
.tab-move-btn:disabled { color: var(--muted); opacity: 0.35; cursor: default; }
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
.calendar-month-label { background: none; border: none; padding: 0; margin: 0; color: inherit; font: inherit; font-weight: 600; min-width: 140px; text-align: center; cursor: pointer; }
.calendar-month-label:hover { color: var(--accent); }
.calendar-month-input { min-width: 140px; text-align: center; font-weight: 600; }
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
.csv-export-btn, .ics-export-btn, .copy-records-btn, .print-list-btn { flex-shrink: 0; padding: 8px 14px; font-size: 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.csv-export-btn:hover:not(:disabled), .ics-export-btn:hover:not(:disabled), .copy-records-btn:hover:not(:disabled), .print-list-btn:hover:not(:disabled) { background: var(--bg); }
.csv-export-btn:disabled, .ics-export-btn:disabled, .copy-records-btn:disabled, .print-list-btn:disabled { opacity: 0.55; cursor: default; }
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
.shortcuts-list { list-style: none; margin: 0; padding: 0; }
.shortcuts-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.shortcuts-row:last-child { border-bottom: none; }
.shortcuts-keys { display: flex; gap: 4px; flex-shrink: 0; }
.shortcuts-keys kbd { padding: 2px 7px; border: 1px solid var(--border); border-radius: 4px; font-size: 0.75rem; font-family: monospace; background: var(--bg); color: var(--text); }
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
.print-record-sheet, .print-list-sheet { display: none; }
.print-record-sheet h1, .print-list-sheet h1 { font-size: 20px; margin: 0 0 16px; }
.print-record-sheet dl { margin: 0; }
.print-field { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-soft); }
.print-field dt { flex: 0 0 160px; font-weight: 600; color: var(--muted); }
.print-field dd { margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.print-record-footer { margin-top: 24px; font-size: 12px; color: var(--muted); }
.print-list-sheet table { width: 100%; border-collapse: collapse; }
.print-list-sheet th, .print-list-sheet td { text-align: start; padding: 6px 10px; border-bottom: 1px solid var(--border-soft); font-size: 13px; overflow-wrap: anywhere; }
.print-list-sheet th { font-weight: 600; color: var(--muted); }
@media print {
  body * { visibility: hidden; }
  .print-record-sheet, .print-record-sheet *, .print-list-sheet, .print-list-sheet * { visibility: visible !important; }
  .print-record-sheet, .print-list-sheet { display: block !important; position: absolute; inset: 0; padding: 24px; }
}
`;
}

export function generateExportFiles(project: Project, exportedAt: Date = new Date()): { path: string; content: string }[] {
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
    { path: "README.md", content: renderReadme(project, exportedAt) },
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
    { path: "web/src/components/ShortcutsPanel.jsx", content: renderShortcutsPanelJsx() },
    ...entityFiles,
    { path: ".gitignore", content: "node_modules/\ndist/\ndata.sqlite\n" },
  ];
}
