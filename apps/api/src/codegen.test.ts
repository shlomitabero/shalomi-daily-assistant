import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { generateExportFiles } from "./codegen.js";

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "Beauty Clinic Manager",
  description: "Appointment management for a beauty clinic.",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "test",
    personas: [],
    roles: ["Admin"],
    screens: [],
    assumptions: [],
    openQuestions: [],
    entities: [
      {
        name: "Customer",
        label: "לקוחות",
        fields: [
          { name: "name", label: "שם", type: "text", required: true },
          {
            name: "status",
            label: "סטטוס",
            type: "enum",
            required: true,
            enumValues: ["New", "Won"],
            enumLabels: { New: "חדש", Won: "הצליח" },
          },
        ],
      },
      {
        name: "Service",
        label: "שירותים",
        fields: [{ name: "title", label: "כותרת", type: "text", required: true }],
      },
    ],
  },
};

test("generateExportFiles produces a real multi-file React (Vite) + Express project", () => {
  const files = generateExportFiles(project);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    ".gitignore",
    "README.md",
    "package.json",
    "render.yaml",
    "server.js",
    "vite.config.js",
    "web/index.html",
    "web/src/App.jsx",
    "web/src/api.js",
    "web/src/components/EntityView.jsx",
    "web/src/components/GlobalSearch.jsx",
    "web/src/entities/Customer.jsx",
    "web/src/entities/Service.jsx",
    "web/src/main.jsx",
    "web/src/styles.css",
  ]);
});

test("generated package.json is valid JSON with express + react + vite, and start builds before serving", () => {
  const files = generateExportFiles(project);
  const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
  assert.equal(pkg.private, true);
  assert.ok(pkg.dependencies.express);
  assert.ok(pkg.dependencies.react);
  assert.ok(pkg.dependencies["react-dom"]);
  assert.ok(pkg.devDependencies.vite);
  assert.ok(pkg.devDependencies["@vitejs/plugin-react"]);
  // The one-command "npm install && npm start" promise from ADR 0003 still
  // holds even though there's now a real build step: start builds first.
  assert.equal(pkg.scripts.start, "vite build && node server.js");
});

test("generated server.js is syntactically valid JavaScript and serves dist/, not public/", () => {
  const files = generateExportFiles(project);
  const serverJs = files.find((f) => f.path === "server.js")!.content;
  assert.match(serverJs, /express\.static\(path\.join\(__dirname, "dist"\)\)/);
  const dir = mkdtempSync(path.join(tmpdir(), "codegen-test-"));
  const filePath = path.join(dir, "server.js");
  writeFileSync(filePath, serverJs);
  try {
    // --check parses without executing -- catches template-string/syntax bugs
    // in the generated source without needing a real server or dependencies.
    execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generated server.js embeds the entity metadata with names and labels intact", () => {
  const files = generateExportFiles(project);
  const serverJs = files.find((f) => f.path === "server.js")!.content;
  assert.match(serverJs, /"name": "Customer"/);
  assert.match(serverJs, /"label": "לקוחות"/);
  assert.match(serverJs, /"New": "חדש"/);
});

// Regression test: "Order" (a real Forge AI domain entity, see
// domainEntities.ts) is a reserved SQL keyword. Before every table/column
// name in the generated server.js was double-quoted, `CREATE TABLE Order
// (...)` crashed the whole exported app at startup with a SQL syntax
// error -- caught not by the syntax-only checks above (esbuild/node --check
// both parse fine; this is a *runtime* SQL error) but by actually
// downloading, unzipping, npm-installing, and running a real export with an
// Order entity. This test reproduces that with a real child process and a
// real SQLite database, standing in for that manual check going forward.
test("generated server.js works end-to-end for an entity named after a reserved SQL keyword (e.g. Order)", async () => {
  const keywordProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "customerName", label: "Customer", type: "text", required: true },
            { name: "group", label: "Group", type: "text", required: false }, // a column name that's also a keyword
          ],
        },
      ],
    },
  };
  const files = generateExportFiles(keywordProject);
  const serverJs = files.find((f) => f.path === "server.js")!.content;

  const dir = mkdtempSync(path.join(tmpdir(), "codegen-keyword-test-"));
  // The generated server.js imports "express" as a bare ESM specifier, which
  // (unlike CommonJS require) ignores NODE_PATH -- symlink this repo's
  // hoisted node_modules in instead of a slow real `npm install`.
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "server.js"), serverJs);

  const port = 34000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    // Poll for the server to come up (or crash) instead of a fixed sleep.
    const deadline = Date.now() + 5000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server.js exited early (code ${child.exitCode}):\n${stderr}`);
      }
      try {
        const res = await fetch(`http://localhost:${port}/api/Order`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { records: [] });

        // Also exercise the keyword column name end-to-end (create + read).
        const createRes = await fetch(`http://localhost:${port}/api/Order`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerName: "Dana", group: "VIP" }),
        });
        assert.equal(createRes.status, 201);
        const created = await createRes.json();
        assert.equal(created.record.group, "VIP");
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression test: the exported standalone app's own coerce() function
// (a separate copy of packages/db/src/repository.ts's coerceValue, since
// this app has no dependency on Forge AI at runtime) validated every
// structured field type except "date", the same gap round 62 found and
// fixed in repository.ts -- a date field silently accepted any string at
// all and stored it verbatim. Reproduced here against a real generated,
// spawned server (not just the coerce() source text) so a future edit to
// this template can't reintroduce the gap without this test catching it.
test("generated server.js rejects a date field value that isn't a real, well-formed calendar date", async () => {
  const dateProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Appointment",
          fields: [
            { name: "customerName", type: "text", required: true },
            { name: "date", type: "date", required: true },
          ],
        },
      ],
    },
  };
  const files = generateExportFiles(dateProject);
  const serverJs = files.find((f) => f.path === "server.js")!.content;

  const dir = mkdtempSync(path.join(tmpdir(), "codegen-date-test-"));
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "server.js"), serverJs);

  const port = 44000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 5000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server.js exited early (code ${child.exitCode}):\n${stderr}`);
      }
      try {
        await fetch(`http://localhost:${port}/api/entities`);
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (child.exitCode !== null) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

    const validRes = await fetch(`http://localhost:${port}/api/Appointment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerName: "Dana", date: "2026-05-20" }),
    });
    assert.equal(validRes.status, 201);
    const valid = await validRes.json();
    assert.equal(valid.record.date, "2026-05-20");

    for (const bad of ["not-a-real-date-at-all", "2024/01/15", "2024-13-45", "2024-02-30"]) {
      const badRes = await fetch(`http://localhost:${port}/api/Appointment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerName: "Dana", date: bad }),
      });
      assert.equal(badRes.status, 400, `expected "${bad}" to be rejected as an invalid date`);
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every generated .jsx/.js file is syntactically valid, checked with a real parser (esbuild)", async () => {
  const esbuild = await import("esbuild");
  const files = generateExportFiles(project);
  for (const file of files.filter((f) => f.path.endsWith(".jsx") || f.path.endsWith(".js"))) {
    if (file.path === "server.js") continue; // already checked above with node --check
    assert.doesNotThrow(
      () => esbuild.transformSync(file.content, { loader: file.path.endsWith(".jsx") ? "jsx" : "js" }),
      `${file.path} should be valid JS/JSX`,
    );
  }
});

test("each entity gets its own real component file with its literal field list, not a shared runtime-schema blob", () => {
  const files = generateExportFiles(project);
  const customerJsx = files.find((f) => f.path === "web/src/entities/Customer.jsx")!.content;
  assert.match(customerJsx, /"name": "name"/);
  assert.match(customerJsx, /"label": "שם"/);
  assert.match(customerJsx, /EntityView/);

  const serviceJsx = files.find((f) => f.path === "web/src/entities/Service.jsx")!.content;
  assert.match(serviceJsx, /"name": "title"/);
  assert.doesNotMatch(serviceJsx, /"name": "name"/); // Customer's fields must not leak into Service's file

  const appJsx = files.find((f) => f.path === "web/src/App.jsx")!.content;
  assert.match(appJsx, /import CustomerView, \{ entity as CustomerEntity \} from ".\/entities\/Customer\.jsx"/);
  assert.match(appJsx, /import ServiceView, \{ entity as ServiceEntity \} from ".\/entities\/Service\.jsx"/);
});

test("a project name with JSX-significant characters doesn't break the generated App.jsx", () => {
  const tricky: Project = { ...project, name: `My "App" {with} <weird> chars & backtick \`` };
  const files = generateExportFiles(tricky);
  const appJsx = files.find((f) => f.path === "web/src/App.jsx")!.content;
  assert.match(appJsx, /const TITLE = /);
});

test("generated web/index.html sets RTL when entity labels are Hebrew", () => {
  const files = generateExportFiles(project);
  const html = files.find((f) => f.path === "web/index.html")!.content;
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="he"/);
});

test("refuses to export an unsafe entity/field name rather than emitting broken SQL or JS", () => {
  const malicious: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [{ name: "Bad; DROP TABLE x;--", fields: [{ name: "n", type: "text", required: true }] }],
    },
  };
  assert.throws(() => generateExportFiles(malicious));
});

test("the exported EntityView renders status badges, formatted dates/numbers, search, and sortable columns -- not the old plain table", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  // Status badge classification (mirrors apps/web/src/entityFormatting.ts)
  assert.match(entityViewJsx, /badgeTone/);
  assert.match(entityViewJsx, /badge-\$\{badgeTone\(value\)\}/);
  // Locale-formatted dates/numbers instead of raw values
  assert.match(entityViewJsx, /toLocaleDateString/);
  assert.match(entityViewJsx, /toLocaleString/);
  // A real search box and click-to-sort headers, not just a static table
  assert.match(entityViewJsx, /entity-search/);
  assert.match(entityViewJsx, /matchesSearch/);
  assert.match(entityViewJsx, /sort-header/);
  assert.match(entityViewJsx, /toggleSort/);
  // The old plain-text formatCell helper is gone, replaced by the Cell component
  assert.doesNotMatch(entityViewJsx, /function formatCell/);
});

test("the exported EntityView renders a real Kanban board for entities with a status/stage-like enum field", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /findBoardField/);
  assert.match(entityViewJsx, /groupByField/);
  assert.match(entityViewJsx, /function BoardCard/);
  assert.match(entityViewJsx, /board-column/);
  assert.match(entityViewJsx, /handleMove/);
  // The exported CSS carries the matching board styling, not just the component code
  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.board-card/);
  assert.match(stylesCss, /\.view-toggle/);
});

test("the exported EntityView renders a real month-calendar view for entities with a date field", () => {
  const withDate: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        ...project.spec.entities,
        {
          name: "Appointment",
          label: "תורים",
          fields: [
            { name: "customerName", label: "שם לקוח", type: "text", required: true },
            { name: "date", label: "תאריך", type: "date", required: true },
          ],
        },
      ],
    },
  };
  const files = generateExportFiles(withDate);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /findDateField/);
  assert.match(entityViewJsx, /buildCalendarMonth/);
  assert.match(entityViewJsx, /function CalendarView/);
  assert.match(entityViewJsx, /calendar-day/);
  // The exported CSS carries the matching calendar styling, not just the component code
  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.calendar-grid/);
  assert.match(stylesCss, /\.calendar-record-chip/);
});

test("the exported CalendarView picks its day-chip label via pickDisplayField, not just whichever field happens to come first after the date field", () => {
  // Mirrors the live-preview fix in apps/web/src/entityFormatting.ts
  // (calendarChipLabelField): every built-in domain entity happens to
  // declare its "name"/"title" field before its date field, so "first
  // field that isn't the date field" has always coincidentally agreed with
  // the real display field there -- but an AI-generated spec has no such
  // ordering guarantee. This asserts the generated component actually
  // reuses pickDisplayField (already generated earlier in the same file for
  // recordDisplayLabel) instead of the old blind first-field fallback.
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const calendarViewSource = entityViewJsx.slice(entityViewJsx.indexOf("function CalendarView"));
  assert.match(calendarViewSource, /pickDisplayField\(entity\)/);
});

test("the exported EntityView renders a real CSV export button backed by RFC-4180-correct CSV building", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /function recordsToCsv/);
  assert.match(entityViewJsx, /function csvEscape/);
  // CSV/formula injection guard (CWE-1236): a value starting with =, +, -,
  // or @ must be prefixed with a leading single quote before the usual
  // comma/quote wrapping, mirroring the same fix in the live-preview app's
  // own entityFormatting.ts and the generated server.js's backup endpoint.
  assert.match(entityViewJsx, /\^\[=\+\\-@\\t\\r\]/);
  assert.match(entityViewJsx, /handleExportCsv/);
  assert.match(entityViewJsx, /csv-export-btn/);
  assert.match(entityViewJsx, /new Blob\(\["\\uFEFF" \+ csv\]/);
  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.csv-export-btn/);
});

test("the exported EntityView renders real bulk-select + bulk-delete for table rows", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /toggleSelected/);
  assert.match(entityViewJsx, /toggleSelectAllVisible/);
  assert.match(entityViewJsx, /handleBulkDelete/);
  assert.match(entityViewJsx, /window\.confirm/);
  assert.match(entityViewJsx, /bulk-actions-bar/);
  assert.match(entityViewJsx, /el\.indeterminate/);
  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.bulk-actions-bar/);
  assert.match(stylesCss, /input\[type="checkbox"\]/);
});

test("the exported EntityView renders a real Duplicate action (table and board views) that copies a record via a real createRecord call", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /async function handleDuplicate\(id\)/);
  assert.match(entityViewJsx, /await createRecord\(entity\.name, copy\)/);
  // No confirmation dialog for duplicating, unlike delete -- it creates
  // data rather than destroying it.
  const duplicateFnBody = entityViewJsx.slice(
    entityViewJsx.indexOf("async function handleDuplicate"),
    entityViewJsx.indexOf("async function handleDuplicate") + 300,
  );
  assert.doesNotMatch(duplicateFnBody, /window\.confirm/);
  // Wired into both the table row actions and the Kanban board card.
  assert.match(entityViewJsx, /onClick=\{\(\) => handleDuplicate\(r\.id\)\}>Duplicate<\/button>/);
  assert.match(entityViewJsx, /onDuplicate=\{\(\) => handleDuplicate\(r\.id\)\}/);
  assert.match(entityViewJsx, /<button onClick=\{onDuplicate\}>Duplicate<\/button>/);
});

test("the exported EntityView renders a real picker for relation fields, not a raw numeric ID input", () => {
  const withRelation: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        ...project.spec.entities,
        {
          name: "Courier",
          label: "Courier",
          fields: [{ name: "name", label: "Name", type: "text", required: true }],
        },
        {
          name: "Order",
          label: "Order",
          fields: [
            { name: "customerName", label: "Customer", type: "text", required: true },
            { name: "courierId", label: "Assigned Courier", type: "relation", required: false, relationTo: "Courier" },
          ],
        },
      ],
    },
  };
  const files = generateExportFiles(withRelation);

  // Each entity's own field list carries relationTo, same "real editable
  // code, not a runtime schema" principle as the rest of that file.
  const orderJsx = files.find((f) => f.path === "web/src/entities/Order.jsx")!.content;
  assert.match(orderJsx, /"relationTo": "Courier"/);

  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /const ALL_ENTITIES = /);
  assert.match(entityViewJsx, /function pickDisplayField/);
  assert.match(entityViewJsx, /function recordDisplayLabel/);
  assert.match(entityViewJsx, /function relationDisplayLabel/);
  // The relation branch of FieldInput renders a real <select> of related
  // records, not the old raw number input.
  assert.match(entityViewJsx, /relatedEntity && relatedEntityRecords/);
  assert.match(entityViewJsx, /relatedEntityRecords\.map/);
  // CSV export also resolves the related record's label, not the raw id.
  assert.match(entityViewJsx, /function recordsToCsv\(fields, records, relatedRecords\)/);
});

test("generateExportFiles includes a real render.yaml matching this repo's own proven Render Blueprint structure", () => {
  const files = generateExportFiles(project);
  const renderYaml = files.find((f) => f.path === "render.yaml")!.content;
  assert.match(renderYaml, /^services:\n {2}- type: web\n {4}name: /);
  assert.match(renderYaml, /runtime: node/);
  assert.match(renderYaml, /plan: free/);
  assert.match(renderYaml, /buildCommand: npm install/);
  assert.match(renderYaml, /startCommand: npm start/);

  const readme = files.find((f) => f.path === "README.md")!.content;
  assert.match(readme, /## Deploy it/);
  assert.match(readme, /render\.yaml/);
  assert.match(readme, /render\.com/i);
});

test("the exported EntityView asks for confirmation before deleting a single record, naming it by its own display label, not just count", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /async function handleDelete\(id\) \{\s*const record = records\.find/);
  assert.match(entityViewJsx, /window\.confirm\(`Delete "\$\{label\}"\? This can't be undone\.`\)/);
});

test("the exported EntityView renders a real CSV import (the complement to CSV export), ported from the Forge AI live preview", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /function parseCsv\(text\)/);
  assert.match(entityViewJsx, /function buildImportRecords\(fields, rows\)/);
  assert.match(entityViewJsx, /async function handleImportFile\(e\)/);
  assert.match(entityViewJsx, /csv-import-label/);
  assert.match(entityViewJsx, /Promise\.allSettled/);
  // A required relation field refuses the whole import with one clear
  // error rather than guessing at foreign keys -- same rule as the live
  // preview's buildImportRecords.
  assert.match(entityViewJsx, /CSV import isn't supported yet for entities with a required relation field/);

  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.csv-import-row/);
  assert.match(stylesCss, /\.csv-import-errors/);
});

test("the exported app includes a real cross-entity global search, ported from the Forge AI live preview", () => {
  const files = generateExportFiles(project);
  const globalSearchJsx = files.find((f) => f.path === "web/src/components/GlobalSearch.jsx")!.content;
  // Reuses EntityView's own matchesSearch/recordDisplayLabel rather than
  // re-implementing the matching rule a second time.
  assert.match(globalSearchJsx, /import \{ matchesSearch, recordDisplayLabel \} from ".\/EntityView\.jsx"/);
  assert.match(globalSearchJsx, /export function GlobalSearch/);
  assert.match(globalSearchJsx, /global-search-group-selected/);
  assert.match(globalSearchJsx, /ArrowDown/);
  assert.match(globalSearchJsx, /ArrowUp/);

  // EntityView.jsx must actually export what GlobalSearch.jsx imports.
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /export function matchesSearch/);
  assert.match(entityViewJsx, /export function recordDisplayLabel/);

  // App.jsx wires it up: Ctrl/Cmd+K opens it, each entity import also pulls
  // in that entity's own field list (needed to search its records), and a
  // visible shortcut hint makes the affordance discoverable.
  const appJsx = files.find((f) => f.path === "web/src/App.jsx")!.content;
  assert.match(appJsx, /import \{ GlobalSearch \} from ".\/components\/GlobalSearch\.jsx"/);
  assert.match(appJsx, /entity as CustomerEntity/);
  assert.match(appJsx, /fields: CustomerEntity\.fields/);
  assert.match(appJsx, /ctrlKey \|\| e\.metaKey/);
  assert.match(appJsx, /shortcut-hint/);

  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.search-overlay/);
  assert.match(stylesCss, /\.global-search-group-selected/);
});

test("the exported App.jsx renders a real 'Backup All Data' link pointing at the generated server's own /api/backup endpoint", () => {
  const files = generateExportFiles(project);
  const appJsx = files.find((f) => f.path === "web/src/App.jsx")!.content;
  assert.match(appJsx, /href="\/api\/backup"/);
  assert.match(appJsx, /backup-all-btn/);
});

test("the generated server.js's /api/backup endpoint returns a real ZIP with one CSV per entity, containing real inserted data", async () => {
  const files = generateExportFiles(project);
  const serverJs = files.find((f) => f.path === "server.js")!.content;
  assert.match(serverJs, /function buildZip\(entries\)/);
  assert.match(serverJs, /app\.get\("\/api\/backup"/);

  const dir = mkdtempSync(path.join(tmpdir(), "codegen-backup-test-"));
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "server.js"), serverJs);

  const port = 39000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 5000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server.js exited early (code ${child.exitCode}):\n${stderr}`);
      }
      try {
        await fetch(`http://localhost:${port}/api/entities`);
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (child.exitCode !== null) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

    const createCustomer = await fetch(`http://localhost:${port}/api/Customer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dana Levi", status: "Won" }),
    });
    assert.equal(createCustomer.status, 201);
    // A stored field can hold arbitrary text (an AI-generated spec's field,
    // a WhatsApp-sourced message) -- not just values this app itself ever
    // wrote -- so the generated backup endpoint's CSV must guard a value
    // that would otherwise be interpreted as a spreadsheet formula when
    // opened in Excel/Sheets/LibreOffice (CSV/formula injection, CWE-1236).
    await fetch(`http://localhost:${port}/api/Customer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "=cmd|' /C calc'!A1", status: "New" }),
    });
    await fetch(`http://localhost:${port}/api/Service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Haircut" }),
    });

    const backupRes = await fetch(`http://localhost:${port}/api/backup`);
    assert.equal(backupRes.status, 200);
    assert.equal(backupRes.headers.get("content-type"), "application/zip");
    const zipBuffer = Buffer.from(await backupRes.arrayBuffer());

    const zipPath = path.join(dir, "backup.zip");
    writeFileSync(zipPath, zipBuffer);
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    const extractDir = path.join(dir, "extracted");
    execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "pipe" });

    const customerCsv = readFileSync(path.join(extractDir, "Customer.csv"), "utf8");
    assert.match(customerCsv, /^﻿/, "expected a UTF-8 BOM so Excel opens Hebrew text correctly");
    assert.match(customerCsv, /Dana Levi/);
    assert.match(customerCsv, /הצליח/, "expected the enum's translated label, not the raw stored value 'Won'");
    assert.match(
      customerCsv,
      /'=cmd\|' \/C calc'!A1/,
      "the formula-like name must be guarded with a leading single quote, not left as a live formula",
    );

    const serviceCsv = readFileSync(path.join(extractDir, "Service.csv"), "utf8");
    assert.match(serviceCsv, /Haircut/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render.yaml's service name is a safe slug even for a project name with spaces, punctuation, and Hebrew", () => {
  const messyName: Project = { ...project, name: 'לקוחות שלי! (v2) — "Best" App?' };
  const files = generateExportFiles(messyName);
  const renderYaml = files.find((f) => f.path === "render.yaml")!.content;
  const nameLine = renderYaml.split("\n").find((l) => l.trim().startsWith("name:"))!;
  const name = nameLine.split("name:")[1].trim();
  assert.match(name, /^[a-z0-9-]+$/, `render.yaml service name must be a safe slug, got: "${name}"`);
});
