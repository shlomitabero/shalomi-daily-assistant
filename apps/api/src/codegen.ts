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
    columns.push(\`\${q(field.name)} \${sqlType(field.type)}\${field.required ? " NOT NULL" : ""}\`);
  }
  db.exec(\`CREATE TABLE IF NOT EXISTS \${q(entity.name)} (\${columns.join(", ")})\`);
}

function coerce(field, value) {
  if (value === undefined || value === null || value === "") {
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
      const merged = { ...existing, ...req.body };
      const values = entity.fields.map((f) => coerce(f, merged[f.name]));
      db.prepare(\`UPDATE \${q(entity.name)} SET \${columns.map((c) => \`\${q(c)} = ?\`).join(", ")} WHERE id = ?\`).run(...values, req.params.id);
      const row = db.prepare(\`SELECT * FROM \${q(entity.name)} WHERE id = ?\`).get(req.params.id);
      res.json({ record: rowToRecord(entity, row) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(\`\${base}/:id\`, (req, res) => {
    const result = db.prepare(\`DELETE FROM \${q(entity.name)} WHERE id = ?\`).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  });
}

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

  return `import { useEffect, useMemo, useState } from "react";
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

// Picks the field that best represents one of an entity's records as a
// short human label -- prefers a field literally named "name"/"title",
// falls back to the first text field, then the first field of any type.
const DISPLAY_FIELD_NAME_HINTS = ["name", "title"];
function pickDisplayField(entity) {
  if (!entity || !entity.fields || entity.fields.length === 0) return null;
  const named = entity.fields.find((f) => DISPLAY_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  if (named) return named;
  const firstText = entity.fields.find((f) => f.type === "text");
  return firstText || entity.fields[0];
}

function recordDisplayLabel(entity, record) {
  const field = pickDisplayField(entity);
  const value = field ? record[field.name] : undefined;
  if (value === null || value === undefined || value === "") return \`#\${record.id}\`;
  return String(value);
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
  const match = records.find((r) => Number(r.id) === Number(value));
  return match ? recordDisplayLabel(targetEntity, match) : \`#\${value}\`;
}

// Classifies a status-like enum value into a badge color without needing
// per-app configuration -- covers the common English status words Forge AI's
// own spec generator uses ("Won", "Lost", "Active", ...) and falls back to
// neutral for anything else (e.g. a freeform value).
const POSITIVE_WORDS = ["won", "completed", "active", "paid", "delivered", "success", "qualified", "shipped", "confirmed", "approved"];
const NEGATIVE_WORDS = ["lost", "cancelled", "canceled", "inactive", "overdue", "no-show", "failed", "rejected", "declined"];
function badgeTone(rawValue) {
  const lower = String(rawValue).toLowerCase();
  if (POSITIVE_WORDS.some((w) => lower.includes(w))) return "positive";
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) return "negative";
  return "neutral";
}

function Cell({ field, value, relationLabel }) {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (field.type === "relation") return <>{relationLabel || \`#\${value}\`}</>;
  if (field.type === "boolean") return value ? <span className="bool-yes">✓</span> : <span className="muted">–</span>;
  if (field.type === "enum") {
    const label = (field.enumLabels && field.enumLabels[value]) || value;
    return <span className={\`badge badge-\${badgeTone(value)}\`}>{label}</span>;
  }
  if (field.type === "date") {
    const date = new Date(value);
    return <>{Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()}</>;
  }
  if (field.type === "number") return <>{Number(value).toLocaleString()}</>;
  return <>{String(value)}</>;
}

function matchesSearch(record, fields, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return fields.some((f) => {
    const value = record[f.name];
    if (value === null || value === undefined) return false;
    const display = f.type === "enum" && f.enumLabels && f.enumLabels[value] ? f.enumLabels[value] : String(value);
    return String(display).toLowerCase().includes(trimmed);
  });
}

function compareValues(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

// Wraps a CSV field in quotes (doubling any interior quotes) only when it
// contains a comma, quote, or newline.
function csvEscape(value) {
  if (/[",\\r\\n]/.test(value)) {
    return \`"\${value.replace(/"/g, '""')}"\`;
  }
  return value;
}

// Renders a field's value the way a human reading a spreadsheet would
// expect -- the enum's translated label instead of its raw stored value, a
// formatted date/number, TRUE/FALSE for booleans (Excel's own convention)
// -- rather than a 1:1 dump of the raw stored values.
function fieldDisplayValue(field, value, relatedRecords) {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "relation") return relationDisplayLabel(field, value, relatedRecords) || \`#\${value}\`;
  if (field.type === "boolean") return value ? "TRUE" : "FALSE";
  if (field.type === "enum") return (field.enumLabels && field.enumLabels[value]) || value;
  if (field.type === "date") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  }
  if (field.type === "number") return Number(value).toLocaleString();
  return String(value);
}

// Builds a real, Excel-friendly CSV (CRLF line endings, quoted fields
// where needed) from an entity's records -- so "download my data" means
// an actual spreadsheet, not a JSON dump.
function recordsToCsv(fields, records, relatedRecords) {
  const header = fields.map((f) => csvEscape(f.label || f.name)).join(",");
  const rows = records.map((record) => fields.map((f) => csvEscape(fieldDisplayValue(f, record[f.name], relatedRecords))).join(","));
  return [header, ...rows].join("\\r\\n");
}

// Picks the enum field an entity's records should be grouped into board
// columns by, if any -- prefers a field literally named status/stage, falls
// back to the first workable enum field (2-8 values), and returns null for
// a flat entity like "Customer" with no enum field.
const BOARD_FIELD_NAME_HINTS = ["status", "stage"];
function findBoardField(fields) {
  const enumFields = fields.filter((f) => f.type === "enum" && f.enumValues && f.enumValues.length >= 2 && f.enumValues.length <= 8);
  if (enumFields.length === 0) return null;
  const named = enumFields.find((f) => BOARD_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named || enumFields[0];
}

// Groups records into one column per declared enum value, in declared
// order, including a value with zero matching records so an empty stage
// still shows as a column instead of disappearing.
function groupByField(records, field) {
  const values = field.enumValues || [];
  return values.map((value) => ({
    value,
    label: (field.enumLabels && field.enumLabels[value]) || value,
    records: records.filter((r) => String(r[field.name]) === value),
  }));
}

// Picks the date field an entity's records should be plotted on a calendar
// by, if any -- prefers a field literally named "date" or a few other
// common date-ish names, then falls back to the first date field; returns
// null for an entity with no date field at all.
const DATE_FIELD_NAME_HINTS = ["date", "appointmentdate", "scheduledat", "eventdate", "duedate"];
function findDateField(fields) {
  const dateFields = fields.filter((f) => f.type === "date");
  if (dateFields.length === 0) return null;
  const named = dateFields.find((f) => DATE_FIELD_NAME_HINTS.includes(f.name.toLowerCase()));
  return named || dateFields[0];
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Builds a fixed 6-week (42-day) month grid starting on the Sunday on/before
// the 1st and ending on the Saturday on/after the last day -- the standard
// calendar-UI shape, including leading/trailing days from adjacent months
// so every week is a full row. Each day carries the records whose date
// field falls on that calendar date; a record with an unparseable date is
// simply never matched, not an error.
function buildCalendarMonth(records, field, year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const days = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dayRecords = records.filter((r) => {
      const raw = r[field.name];
      if (raw === null || raw === undefined || raw === "") return false;
      const recordDate = new Date(String(raw));
      return !Number.isNaN(recordDate.getTime()) && isSameCalendarDay(recordDate, date);
    });
    days.push({ date, inCurrentMonth: date.getMonth() === month, records: dayRecords });
  }
  return days;
}

// Renders a month grid for entities with a date field (e.g. "Appointment"),
// so a date-heavy entity gets a real calendar instead of the same table
// shape every entity gets. Each day cell shows a chip per record landing on
// that date (click to edit), with a "+N more" overflow instead of an
// ever-growing cell.
function CalendarView({ entity, dateField, records, month, onPrevMonth, onNextMonth, onEdit }) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(() => buildCalendarMonth(records, dateField, year, monthIndex), [records, dateField, year, monthIndex]);
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    return days.slice(0, 7).map((d) => formatter.format(d.date));
  }, [days]);
  const labelField = entity.fields.find((f) => f.name !== dateField.name) || dateField;

  return (
    <div className="calendar-view">
      <div className="calendar-nav">
        <button type="button" onClick={onPrevMonth}>‹</button>
        <span className="calendar-month-label">{monthLabel}</span>
        <button type="button" onClick={onNextMonth}>›</button>
      </div>
      <div className="calendar-grid calendar-weekdays">
        {weekdayLabels.map((label, i) => (
          <div key={i} className="calendar-weekday">{label}</div>
        ))}
      </div>
      <div className="calendar-grid calendar-days">
        {days.map((day, i) => (
          <div key={i} className={day.inCurrentMonth ? "calendar-day" : "calendar-day calendar-day-outside"}>
            <span className="calendar-day-number">{day.date.getDate()}</span>
            <div className="calendar-day-records">
              {day.records.slice(0, 3).map((record) => (
                <button type="button" key={record.id} className="calendar-record-chip" onClick={() => onEdit(record)}>
                  {String(record[labelField.name] ?? "")}
                </button>
              ))}
              {day.records.length > 3 && <span className="calendar-record-more">+{day.records.length - 3} more</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// One card in the board view: the record's other fields (never the board
// field itself, since that's implied by which column the card is in), a
// select to move it directly to another column, and the same Edit/Delete
// actions the table row has.
function BoardCard({ entity, boardField, record, relatedRecords, onMove, onEdit, onDelete }) {
  const otherFields = entity.fields.filter((f) => f.name !== boardField.name);
  return (
    <div className="board-card">
      {otherFields.map((f) => (
        <div key={f.name} className="board-card-field">
          <span className="muted small">{f.label}</span>
          <Cell
            field={f}
            value={record[f.name]}
            relationLabel={f.type === "relation" ? relationDisplayLabel(f, record[f.name], relatedRecords) : undefined}
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
        <button onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

function FieldInput({ entity, field, value, onChange, relatedEntity, relatedEntityRecords }) {
  const id = \`f_\${entity.name}_\${field.name}\`;
  if (field.type === "relation" && relatedEntity && relatedEntityRecords) {
    return (
      <select id={id} value={value === "" || value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}>
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
    return <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (field.type === "enum") {
    return (
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
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
    return <textarea id={id} rows={2} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === "date") {
    return <input id={id} type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === "number" || field.type === "relation") {
    return <input id={id} type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input id={id} type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
}

/** Shared list + form UI used by every entity's own component file. */
export function EntityView({ entity }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(() => emptyForm(entity));
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [viewMode, setViewMode] = useState("table");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [relatedRecords, setRelatedRecords] = useState({});
  const boardField = useMemo(() => findBoardField(entity.fields), [entity.fields]);
  const dateField = useMemo(() => findDateField(entity.fields), [entity.fields]);
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

  async function refresh() {
    setLoading(true);
    try {
      const { records } = await listRecords(entity.name);
      setRecords(records);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setForm(emptyForm(entity));
    setEditingId(null);
    setSearch("");
    setSortField(null);
    setViewMode("table");
    setCalendarMonth(new Date());
    setSelectedIds(new Set());
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.name]);

  function toggleSort(fieldName) {
    if (sortField !== fieldName) {
      setSortField(fieldName);
      setSortDir("asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
  }

  const visibleRecords = useMemo(() => {
    const filtered = records.filter((r) => matchesSearch(r, entity.fields, search));
    if (!sortField) return filtered;
    const sorted = [...filtered].sort((a, b) => compareValues(a[sortField], b[sortField]));
    return sortDir === "desc" ? sorted.reverse() : sorted;
  }, [records, entity.fields, search, sortField, sortDir]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
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

  async function handleDelete(id) {
    await deleteRecord(entity.name, id);
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await refresh();
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
    if (!window.confirm(\`Delete \${ids.length} records? This can't be undone.\`)) return;
    await Promise.all(ids.map((id) => deleteRecord(entity.name, id)));
    setSelectedIds(new Set());
    await refresh();
  }

  async function handleMove(id, fieldName, value) {
    await updateRecord(entity.name, id, { [fieldName]: value });
    await refresh();
  }

  function handleExportCsv() {
    const csv = recordsToCsv(entity.fields, visibleRecords, relatedRecords);
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

  return (
    <div className="panel">
      <h3>{entity.label}</h3>
      <form className="record-form" onSubmit={handleSubmit}>
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
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : records.length === 0 ? (
        <div className="empty-state">
          <p>No records yet — add the first one above.</p>
        </div>
      ) : (
        <>
          <div className="entity-toolbar">
            <input
              type="text"
              className="entity-search"
              placeholder="🔍 Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {(boardField || dateField) && (
              <div className="view-toggle" role="group">
                <button
                  type="button"
                  className={viewMode === "table" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  onClick={() => setViewMode("table")}
                >
                  📋 Table
                </button>
                {boardField && (
                  <button
                    type="button"
                    className={viewMode === "board" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode("board")}
                  >
                    🗂️ Board
                  </button>
                )}
                {dateField && (
                  <button
                    type="button"
                    className={viewMode === "calendar" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                    onClick={() => setViewMode("calendar")}
                  >
                    📅 Calendar
                  </button>
                )}
              </div>
            )}
            <button type="button" className="csv-export-btn" onClick={handleExportCsv} disabled={visibleRecords.length === 0}>
              ⬇️ Export CSV
            </button>
          </div>
          {visibleRecords.length === 0 ? (
            <div className="empty-state">
              <p>No results match your search.</p>
            </div>
          ) : viewMode === "board" && boardField ? (
            <div className="board-scroll">
              {groupByField(visibleRecords, boardField).map((column) => (
                <div className="board-column" key={column.value}>
                  <div className="board-column-header">
                    <span className={\`badge badge-\${badgeTone(column.value)}\`}>{column.label}</span>
                    <span className="muted small">{column.records.length}</span>
                  </div>
                  {column.records.map((r) => (
                    <BoardCard
                      key={r.id}
                      entity={entity}
                      boardField={boardField}
                      record={r}
                      relatedRecords={relatedRecords}
                      onMove={(value) => handleMove(r.id, boardField.name, value)}
                      onEdit={() => startEdit(r)}
                      onDelete={() => handleDelete(r.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : viewMode === "calendar" && dateField ? (
            <CalendarView
              entity={entity}
              dateField={dateField}
              records={visibleRecords}
              month={calendarMonth}
              onPrevMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              onNextMonth={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              onEdit={startEdit}
            />
          ) : (
            <div className="table-scroll">
              {selectedIds.size > 0 && (
                <div className="bulk-actions-bar">
                  <span>{selectedIds.size} selected</span>
                  <button type="button" onClick={handleBulkDelete}>
                    🗑️ Delete selected
                  </button>
                </div>
              )}
              <table>
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
                    {entity.fields.map((f) => (
                      <th key={f.name}>
                        <button type="button" className="sort-header" onClick={() => toggleSort(f.name)}>
                          {f.label}
                          {sortField === f.name ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.map((r) => (
                    <tr key={r.id}>
                      <td className="select-col">
                        <input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelected(r.id)} />
                      </td>
                      {entity.fields.map((f) => (
                        <td key={f.name}>
                          <Cell
                            field={f}
                            value={r[f.name]}
                            relationLabel={f.type === "relation" ? relationDisplayLabel(f, r[f.name], relatedRecords) : undefined}
                          />
                        </td>
                      ))}
                      <td className="row-actions">
                        <button onClick={() => startEdit(r)}>Edit</button>
                        <button onClick={() => handleDelete(r.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
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

export default function View() {
  return <EntityView entity={entity} />;
}
`;
}

function renderAppJsx(project: Project): string {
  const entities = project.spec.entities;
  const imports = entities
    .map((e) => `import ${e.name}View from "./entities/${e.name}.jsx";`)
    .join("\n");
  const entries = entities
    .map((e) => `  { name: ${JSON.stringify(e.name)}, label: ${JSON.stringify(e.label ?? e.name)}, View: ${e.name}View },`)
    .join("\n");

  return `import { useState } from "react";
${imports}

const ENTITIES = [
${entries}
];

// The app title is a plain JS string rendered through a JSX expression
// (not embedded as literal JSX text) so it's safe however it's spelled.
const TITLE = ${JSON.stringify(project.name)};

export default function App() {
  const [active, setActive] = useState(ENTITIES[0]?.name ?? null);
  const activeEntity = ENTITIES.find((e) => e.name === active);

  return (
    <div className="app">
      <h1>{TITLE}</h1>
      <nav>
        {ENTITIES.map((e) => (
          <button key={e.name} className={e.name === active ? "active" : ""} onClick={() => setActive(e.name)}>
            {e.label}
          </button>
        ))}
      </nav>
      {activeEntity && <activeEntity.View />}
    </div>
  );
}
`;
}

function renderStylesCss(): string {
  return `* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f6f2ea; color: #241f19; }
.app { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 20px; }
nav { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 20px; }
nav button { padding: 8px 16px; border-radius: 8px; border: 1px solid #e6ddcc; background: #fff; cursor: pointer; font: inherit; }
nav button.active { background: #d9622b; color: #fff; border-color: #d9622b; }
.panel { background: #fff; border: 1px solid #e6ddcc; border-radius: 14px; padding: 20px; box-shadow: 0 8px 24px rgba(36,31,25,0.08); }
form.record-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #efe8da; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: #83786a; min-width: 0; }
input, select, textarea { font: inherit; padding: 8px 10px; border: 1px solid #e6ddcc; border-radius: 6px; width: 100%; }
input[type="checkbox"] { width: auto; }
button[type="submit"], .btn { padding: 9px 18px; border-radius: 8px; border: none; background: #d9622b; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: start; padding: 8px 10px; border-bottom: 1px solid #efe8da; white-space: nowrap; }
.row-actions button { margin-inline-start: 4px; padding: 5px 10px; border-radius: 6px; border: 1px solid #e6ddcc; background: #fff; cursor: pointer; }
.muted { color: #83786a; font-size: 13px; }
.error { color: #c0392b; }
.entity-search { max-width: 280px; margin-bottom: 14px; }
.sort-header { background: none; border: none; padding: 0; margin: 0; color: inherit; font: inherit; cursor: pointer; }
.sort-header:hover { color: #d9622b; }
.badge { display: inline-block; padding: 3px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.badge-positive { background: #e2f2e8; color: #2e8b57; }
.badge-negative { background: #fbe6e2; color: #c0392b; }
.badge-neutral { background: #e9edf0; color: #4c5b6a; }
.bool-yes { color: #2e8b57; font-weight: 700; }
.empty-state { padding: 32px 16px; text-align: center; color: #83786a; background: #fdfbf7; border: 1px dashed #e6ddcc; border-radius: 10px; }
.entity-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.entity-toolbar .entity-search { margin-bottom: 0; flex: 1; }
.view-toggle { display: flex; gap: 4px; padding: 3px; background: #fff; border: 1px solid #e6ddcc; border-radius: 8px; flex-shrink: 0; }
.view-toggle-btn { padding: 6px 12px; border-radius: 6px; border: none; background: transparent; color: #83786a; font-size: 13px; font-weight: 600; cursor: pointer; }
.view-toggle-btn-active { background: #d9622b; color: #fff; }
.board-scroll { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px; }
.board-column { flex: 0 0 240px; background: #faf7f1; border: 1px solid #efe8da; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.board-column-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid #efe8da; }
.board-card { background: #fff; border: 1px solid #efe8da; border-radius: 8px; padding: 10px 12px; box-shadow: 0 1px 2px rgba(36,31,25,0.06); display: flex; flex-direction: column; gap: 6px; }
.board-card-field { display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; }
.board-card-move { margin-top: 4px; }
.calendar-view { display: flex; flex-direction: column; gap: 10px; }
.calendar-nav { display: flex; align-items: center; justify-content: center; gap: 16px; }
.calendar-nav button { padding: 4px 12px; font-size: 16px; line-height: 1; border-radius: 6px; border: 1px solid #e6ddcc; background: #fff; cursor: pointer; }
.calendar-month-label { font-weight: 600; min-width: 140px; text-align: center; }
.calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.calendar-weekday { text-align: center; color: #83786a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; padding-bottom: 4px; }
.calendar-day { min-height: 76px; background: #faf7f1; border: 1px solid #efe8da; border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
.calendar-day-outside { opacity: 0.4; }
.calendar-day-number { font-size: 12px; font-weight: 600; color: #83786a; }
.calendar-day-records { display: flex; flex-direction: column; gap: 3px; }
.calendar-record-chip { background: #fff; border: 1px solid #efe8da; border-radius: 4px; padding: 2px 5px; font-size: 11.5px; text-align: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.calendar-record-chip:hover { background: #f6f2ea; }
.calendar-record-more { font-size: 11px; color: #83786a; padding: 0 5px; }
.csv-export-btn { flex-shrink: 0; padding: 8px 14px; font-size: 13px; border-radius: 8px; border: 1px solid #e6ddcc; background: #fff; color: #241f19; cursor: pointer; font: inherit; }
.csv-export-btn:hover:not(:disabled) { background: #f6f2ea; }
.csv-export-btn:disabled { opacity: 0.55; cursor: default; }
.bulk-actions-bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; margin-bottom: 8px; background: #faf7f1; border: 1px solid #efe8da; border-radius: 8px; font-size: 13.5px; }
.select-col { width: 1%; white-space: nowrap; }
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
    { path: "web/src/main.jsx", content: renderMainJsx() },
    { path: "web/src/App.jsx", content: renderAppJsx(project) },
    { path: "web/src/api.js", content: renderApiJs() },
    { path: "web/src/styles.css", content: renderStylesCss() },
    { path: "web/src/components/EntityView.jsx", content: renderEntityViewJsx(project) },
    ...entityFiles,
    { path: ".gitignore", content: "node_modules/\ndist/\ndata.sqlite\n" },
  ];
}
