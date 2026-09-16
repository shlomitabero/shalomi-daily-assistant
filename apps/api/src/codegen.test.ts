import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.match(appJsx, /import CustomerView from ".\/entities\/Customer\.jsx"/);
  assert.match(appJsx, /import ServiceView from ".\/entities\/Service\.jsx"/);
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

test("the exported EntityView renders a real CSV export button backed by RFC-4180-correct CSV building", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /function recordsToCsv/);
  assert.match(entityViewJsx, /function csvEscape/);
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

test("render.yaml's service name is a safe slug even for a project name with spaces, punctuation, and Hebrew", () => {
  const messyName: Project = { ...project, name: 'לקוחות שלי! (v2) — "Best" App?' };
  const files = generateExportFiles(messyName);
  const renderYaml = files.find((f) => f.path === "render.yaml")!.content;
  const nameLine = renderYaml.split("\n").find((l) => l.trim().startsWith("name:"))!;
  const name = nameLine.split("name:")[1].trim();
  assert.match(name, /^[a-z0-9-]+$/, `render.yaml service name must be a safe slug, got: "${name}"`);
});
