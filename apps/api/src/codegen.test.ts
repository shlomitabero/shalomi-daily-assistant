import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { transformSync } from "esbuild";
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
    "web/public/icon.svg",
    "web/public/manifest.json",
    "web/public/sw.js",
    "web/src/App.jsx",
    "web/src/api.js",
    "web/src/components/EntityView.jsx",
    "web/src/components/GlobalSearch.jsx",
    "web/src/entities/Customer.jsx",
    "web/src/entities/Service.jsx",
    "web/src/main.jsx",
    "web/src/styles.css",
    "web/src/theme.js",
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

// Regression test: `new Date("2026-09-15")` parses that date-only string
// as UTC midnight, but the generated CalendarView's own grid cells are
// built with `new Date(year, month, day)` (local midnight) and compared
// with local getters -- so for any viewer whose local time is behind UTC,
// a record was silently placed one calendar day earlier than its actual
// stored date. Executes the real generated buildCalendarMonth/
// isSameCalendarDay/parseFieldDate functions (extracted from real codegen
// output, not reimplemented here) under a behind-UTC TZ, the same
// "run the real generated code" standard the CSV-import date test uses.
test("the exported CalendarView places a record on its correct calendar day even for a viewer in a timezone behind UTC", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  const dateHelperSrc = entityViewJsx.match(/const CALENDAR_DATE_FORMAT[\s\S]*?\nfunction parseFieldDate\(raw\) \{[\s\S]*?\n\}\n/)?.[0];
  const sameDaySrc = entityViewJsx.match(/function isSameCalendarDay\(a, b\) \{[\s\S]*?\n\}\n/)?.[0];
  const buildMonthSrc = entityViewJsx.match(/function buildCalendarMonth\(records, field, year, month\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(dateHelperSrc && sameDaySrc && buildMonthSrc, "expected to find parseFieldDate/isSameCalendarDay/buildCalendarMonth in generated output");

  const buildCalendarMonth = new Function(`${dateHelperSrc}\n${sameDaySrc}\n${buildMonthSrc}\nreturn buildCalendarMonth;`)();

  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const field = { name: "date", type: "date" };
    const records = [{ id: 1, date: "2026-09-15" }];
    const days = buildCalendarMonth(records, field, 2026, 8); // September 2026
    const sep14 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 14);
    const sep15 = days.find((d) => d.inCurrentMonth && d.date.getDate() === 15);
    assert.equal(sep15.records.length, 1, "the record must land on the 15th, not shift to the 14th");
    assert.equal(sep14.records.length, 0);
  } finally {
    process.env.TZ = originalTz;
  }
});

// The exported CalendarView had prev/next month navigation but no quick way
// back to the current month once you'd paged away -- the same gap the
// live-preview app's own EntityPanel.tsx had before round 146 added a
// "Today" button there. Ports the identical fix here: a real
// isSameCalendarMonth(a, b) helper (mirroring isSameCalendarDay right above
// it) drives a Today button's disabled state. Executes the real generated
// isSameCalendarMonth function, extracted from real codegen output.
test("the exported CalendarView's isSameCalendarMonth is true only for two dates in the same calendar month and year", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const sameMonthSrc = entityViewJsx.match(/function isSameCalendarMonth\(a, b\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(sameMonthSrc, "expected to find isSameCalendarMonth in generated output");

  const isSameCalendarMonth = new Function(`${sameMonthSrc}\nreturn isSameCalendarMonth;`)() as (a: Date, b: Date) => boolean;

  assert.equal(isSameCalendarMonth(new Date(2026, 8, 1), new Date(2026, 8, 30)), true, "same month/year, different day");
  assert.equal(isSameCalendarMonth(new Date(2026, 8, 30), new Date(2026, 9, 1)), false, "across a month boundary");
  assert.equal(isSameCalendarMonth(new Date(2025, 8, 15), new Date(2026, 8, 15)), false, "same month but a different year");
});

// Confirms the Today button is actually wired into CalendarView's JSX
// (disabled by isCurrentMonth, calling onToday), not just that the helper
// function above exists in isolation -- the same "static-check the JSX
// plus execute the real helper" split this file already uses for board/
// calendar view coverage.
test("the exported CalendarView renders a Today button wired to onToday and disabled on the current month", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const calendarViewSource = entityViewJsx.slice(entityViewJsx.indexOf("function CalendarView"), entityViewJsx.indexOf("function CalendarView") + 2000);
  assert.match(calendarViewSource, /calendar-today-btn/);
  assert.match(calendarViewSource, /onClick=\{onToday\}/);
  assert.match(calendarViewSource, /disabled=\{isCurrentMonth\}/);

  const stylesCss = generateExportFiles(project).find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.calendar-today-btn/);
});

// Regression test: DATE_FIELD_NAME_HINTS lists "scheduledat" as a
// recognized hint, but every real date field in the domain library
// (spec-engine/domainEntities.ts) follows an "XxxDate" naming convention
// -- including WorkOrder's own "scheduledDate", the field this hint was
// presumably meant to catch. "scheduledDate".toLowerCase() is
// "scheduleddate", which the misspelled "scheduledat" hint never
// matches, so this hint was silently dead in the exported app too (the
// same duplicated-code gap as the live-preview version). Runs the real
// generated findDateField, not a reimplementation.
test("the exported EntityView's findDateField recognizes 'scheduledDate' as a known date-field name, matching the domain library's own WorkOrder entity", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const findDateFieldSrc = entityViewJsx.match(/const DATE_FIELD_NAME_HINTS[\s\S]*?\nfunction findDateField\(fields\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(findDateFieldSrc, "expected to find DATE_FIELD_NAME_HINTS/findDateField in generated output");

  const findDateField = new Function(`${findDateFieldSrc}\nreturn findDateField;`)() as (fields: unknown[]) => { name: string } | null;
  const fields = [
    { name: "createdNote", type: "date" },
    { name: "scheduledDate", type: "date" },
  ];
  assert.equal(findDateField(fields)?.name, "scheduledDate");
});

// Regression test: the same UTC-vs-local mismatch as the CalendarView test
// above, but in the main record table's per-cell date renderer (Cell,
// reused by the table, the Kanban board, and global search results) --
// `new Date(value)` parses a stored "YYYY-MM-DD" value as UTC midnight,
// and toLocaleDateString renders in the viewer's *local* time, so any
// viewer whose local time is behind UTC would see a date field displayed
// one calendar day earlier than what's actually stored. Compiles the real
// generated Cell component's JSX with esbuild (the same transform this
// repo's own build uses) and actually renders it with a minimal JSX
// runtime stub, rather than reimplementing or string-matching the logic.
test("the exported record table's date cell shows the correct calendar day even for a viewer in a timezone behind UTC", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  const dateHelperSrc = entityViewJsx.match(/const CALENDAR_DATE_FORMAT[\s\S]*?\nfunction parseFieldDate\(raw\) \{[\s\S]*?\n\}\n/)?.[0];
  const cellSrc = entityViewJsx.match(/function Cell\(\{ field, value, relationLabel \}\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(dateHelperSrc && cellSrc, "expected to find parseFieldDate/Cell in generated output");

  const transformed = transformSync(`${dateHelperSrc}\n${cellSrc}`, { loader: "jsx", jsxFactory: "h", jsxFragment: "Frag" }).code;
  const Cell = new Function("h", "Frag", `${transformed}\nreturn Cell;`)(
    (_type: unknown, _props: unknown, ...children: unknown[]) => (children.length === 1 ? children[0] : children),
    Symbol("Fragment"),
  );

  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const rendered = Cell({ field: { type: "date" }, value: "2026-03-15" });
    assert.equal(rendered, "3/15/2026", "must render the 15th, not shift back to the 14th");
  } finally {
    process.env.TZ = originalTz;
  }
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

// The live-preview app's own EntityPanel.tsx got a "Columns" menu (hide/show
// individual table columns, persisted in localStorage) in round 138, but the
// exported app's separate CalendarView-style EntityView.jsx never picked it
// up -- the same live-preview-then-codegen gap round 147 found and fixed for
// the calendar view's own Today button. Confirms the menu, the
// visibleFields filtering (applied to the table header/body but NOT to CSV
// export, matching the live-preview app's own "whole-record action" rule),
// and the persistence helpers are all actually present in the generated
// output.
test("the exported EntityView renders a 'Columns' menu to hide/show individual table columns, ported from the Forge AI live preview", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /function getHiddenColumns/);
  assert.match(entityViewJsx, /function toggleColumnVisibility/);
  assert.match(entityViewJsx, /columns-menu-btn/);
  assert.match(entityViewJsx, /columns-menu-panel/);
  assert.match(entityViewJsx, /visibleFields/);
  // The table header/body must use the filtered list...
  assert.match(entityViewJsx, /\{visibleFields\.map\(\(f\) => \(\s*<th/);
  assert.match(entityViewJsx, /\{visibleFields\.map\(\(f\) => \(\s*<td/);
  // ...but CSV export must still see every field, hidden or not.
  const handleExportCsvSrc = entityViewJsx.match(/function handleExportCsv\(\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(handleExportCsvSrc, "expected to find handleExportCsv in generated output");
  assert.doesNotMatch(handleExportCsvSrc!, /visibleFields/, "CSV export must ignore hidden columns, the same as the live-preview app");

  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.columns-menu-panel/);
});

// Executes the real generated getHiddenColumns/toggleColumnVisibility
// functions (extracted from real codegen output, not reimplemented) against
// a fake localStorage, the same "run the real generated code" standard this
// file's other persistence-backed tests use.
test("the exported EntityView's getHiddenColumns/toggleColumnVisibility persist per entity via a real localStorage round trip", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const storageKeySrc = entityViewJsx.match(/const HIDDEN_COLUMNS_STORAGE_KEY[\s\S]*?\nfunction toggleColumnVisibility\(entityName, fieldName\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(storageKeySrc, "expected to find the hidden-columns persistence helpers in generated output");

  const store: Record<string, string> = {};
  const fakeLocalStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
  const { getHiddenColumns, toggleColumnVisibility } = new Function(
    "localStorage",
    `${storageKeySrc}\nreturn { getHiddenColumns, toggleColumnVisibility };`,
  )(fakeLocalStorage) as {
    getHiddenColumns: (entityName: string) => Set<string>;
    toggleColumnVisibility: (entityName: string, fieldName: string) => Set<string>;
  };

  assert.deepEqual([...getHiddenColumns("Customer")], [], "a never-touched entity starts with no hidden columns");

  const afterFirstToggle = toggleColumnVisibility("Customer", "email");
  assert.deepEqual([...afterFirstToggle], ["email"]);
  assert.deepEqual([...getHiddenColumns("Customer")], ["email"], "the hidden state must actually persist to localStorage, not just live in memory");
  assert.deepEqual([...getHiddenColumns("Deal")], [], "hiding a column on one entity must not affect a different entity");

  const afterSecondToggle = toggleColumnVisibility("Customer", "email");
  assert.deepEqual([...afterSecondToggle], [], "toggling the same field again must un-hide it");
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

// Regression test: handleDuplicate/handleBulkDelete/handleMove each awaited
// a real network call (createRecord/deleteRecord/updateRecord) with no
// try/catch at all, unlike handleSubmit and handleImportFile right next to
// them in this same file, and unlike the live-preview app's own
// EntityPanel.tsx, where all three of these already wrap the same calls in
// try/catch + setError. A rejected request here (a dropped connection, an
// unexpected server error, a record already deleted by someone else)
// became an unhandled promise rejection with zero visible feedback -- the
// user's click just silently did nothing. Executes the real generated
// handler functions (extracted from real codegen output, not
// reimplemented) with a rejecting mock of the underlying API call and
// asserts setError actually gets called with the rejection's message.
// (handleDelete itself is deliberately NOT covered here: since round 194
// it's an optimistic delete behind an undo window -- see the dedicated
// undo-toast test below -- and the real deleteRecord call it eventually
// makes, once the window closes, has no UI left to report a failure to,
// exactly like the live preview's own commitPendingDelete.)
test("the exported EntityView's handleDuplicate/handleBulkDelete/handleMove surface a failed request instead of silently swallowing it", async () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  const displayFieldHintsSrc = entityViewJsx.match(/const DISPLAY_FIELD_NAME_HINTS = \[[^\]]*\];\n/)?.[0];
  const pickDisplayFieldSrc = entityViewJsx.match(/export function pickDisplayField\(entity\) \{[\s\S]*?\n\}\n/)?.[0]?.replace("export ", "");
  const recordDisplayLabelSrc = entityViewJsx.match(/export function recordDisplayLabel\(entity, record\) \{[\s\S]*?\n\}\n/)?.[0]?.replace("export ", "");
  const handleDuplicateSrc = entityViewJsx.match(/async function handleDuplicate\(id\) \{[\s\S]*?\n  \}\n/)?.[0];
  const handleBulkDeleteSrc = entityViewJsx.match(/async function handleBulkDelete\(\) \{[\s\S]*?\n  \}\n/)?.[0];
  const handleMoveSrc = entityViewJsx.match(/async function handleMove\(id, fieldName, value\) \{[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(
    displayFieldHintsSrc && pickDisplayFieldSrc && recordDisplayLabelSrc && handleDuplicateSrc && handleBulkDeleteSrc && handleMoveSrc,
    "expected to find DISPLAY_FIELD_NAME_HINTS/pickDisplayField/recordDisplayLabel/handleDuplicate/handleBulkDelete/handleMove in generated output",
  );

  const entity = project.spec.entities[0];
  const records = [{ id: 1, name: "Dana", email: "dana@example.com", status: "New" }];
  const rejection = new Error("network error");

  async function runHandler(handlerSrc: string, invoke: (fn: (...args: unknown[]) => Promise<void>) => Promise<void>) {
    let capturedError: string | undefined;
    const fn = new Function(
      "window",
      "entity",
      "records",
      "selectedIds",
      "setSelectedIds",
      "setError",
      "deleteRecord",
      "createRecord",
      "updateRecord",
      "refresh",
      `${displayFieldHintsSrc}\n${pickDisplayFieldSrc}\n${recordDisplayLabelSrc}\n${handlerSrc}\nreturn ${handlerSrc.match(/^async function (\w+)/)![1]};`,
    )(
      { confirm: () => true },
      entity,
      records,
      new Set([1]),
      () => {},
      (msg: string) => {
        capturedError = msg;
      },
      async () => {
        throw rejection;
      },
      async () => {
        throw rejection;
      },
      async () => {
        throw rejection;
      },
      async () => {},
    );
    await invoke(fn);
    return capturedError;
  }

  assert.equal(await runHandler(handleDuplicateSrc, (fn) => fn(1)), rejection.message, "handleDuplicate must call setError on failure");
  assert.equal(await runHandler(handleBulkDeleteSrc, (fn) => fn()), rejection.message, "handleBulkDelete must call setError on failure");
  assert.equal(await runHandler(handleMoveSrc, (fn) => fn(1, "status", "Won")), rejection.message, "handleMove must call setError on failure");
});

// Regression test, separate from the one above: even after round 71 wrapped
// handleBulkDelete in a try/catch, it still awaited a bare
// Promise.all(ids.map(deleteRecord)) inside that try -- a single rejected
// delete (a dropped connection, a record another tab already removed)
// rejected the whole Promise.all immediately, so setSelectedIds(new Set())
// and refresh() right after it never ran. Any records that DID delete
// successfully stayed listed, and selected, in a now-stale table. Runs the
// real generated handleBulkDelete with a mock deleteRecord that fails for
// exactly one of three selected ids.
test("the exported EntityView's handleBulkDelete refreshes and keeps only the ids that actually failed selected, instead of Promise.all's all-or-nothing hiding the deletes that succeeded", async () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const handleBulkDeleteSrc = entityViewJsx.match(/async function handleBulkDelete\(\) \{[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(handleBulkDeleteSrc, "expected to find handleBulkDelete in generated output");

  let capturedError: string | undefined;
  let capturedSelectedIds: Set<number> | undefined;
  let refreshCalled = 0;
  const attemptedIds: number[] = [];

  const fn = new Function(
    "window",
    "entity",
    "selectedIds",
    "setSelectedIds",
    "setError",
    "deleteRecord",
    "refresh",
    `${handleBulkDeleteSrc}\nreturn handleBulkDelete;`,
  )(
    { confirm: () => true },
    { name: "Customer" },
    new Set([1, 2, 3]),
    (next: Set<number>) => {
      capturedSelectedIds = next;
    },
    (msg: string) => {
      capturedError = msg;
    },
    async (_entityName: string, id: number) => {
      attemptedIds.push(id);
      if (id === 2) throw new Error("record 2 network error");
    },
    async () => {
      refreshCalled += 1;
    },
  );
  await fn();

  assert.deepEqual(
    attemptedIds.slice().sort(),
    [1, 2, 3],
    "must attempt every selected id, not stop at the first failure",
  );
  assert.deepEqual(
    [...capturedSelectedIds!].sort(),
    [2],
    "only the id that actually failed should remain selected -- the two that succeeded must be cleared",
  );
  assert.equal(capturedError, "1 of 3 records could not be deleted.");
  assert.equal(
    refreshCalled,
    1,
    "refresh() must still run so the table reflects the records that WERE successfully deleted, even on a partial failure",
  );
});

/**
 * Regression test: the exported app's own EntityView.jsx is a deliberate
 * duplicate of the live-preview EntityPanel.tsx, and its refresh() had
 * the exact same stale-async-overwrites-newer-setState race this session
 * already found and fixed in EntityPanel.tsx itself -- refresh() is
 * called independently from handleSubmit/handleDelete/handleDuplicate/
 * handleBulkDelete/handleImportFile/handleMove/the mount effect, with no
 * guard against two calls overlapping. handleDuplicate in particular has
 * no confirmation dialog, so a user double-clicking "duplicate" on two
 * rows in quick succession starts two overlapping refresh() calls, and
 * if the first (now stale) call's listRecords resolved after the second
 * (newer) call's, its setRecords silently clobbered the newer, correct
 * table with stale data. Deterministic, not timing-based: holds the
 * FIRST refresh's listRecords call open past the SECOND refresh's own
 * completion. Runs the real generated refresh function.
 */
test("the exported EntityView's refresh ignores a stale, still-in-flight refresh's records once a newer refresh has already completed", async () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const refreshSrc = entityViewJsx.match(/ {2}async function refresh\(\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(refreshSrc, "expected to find refresh in generated output");

  let listRecordsCallCount = 0;
  let resolveFirstCall!: () => void;
  const firstCallHeld = new Promise<void>((resolve) => {
    resolveFirstCall = resolve;
  });
  const capturedRecordsByCall: unknown[][] = [];
  const refreshRequestId = { current: 0 };

  const fn = new Function(
    "refreshRequestId",
    "setLoading",
    "listRecords",
    "entity",
    "setRecords",
    "setError",
    `${refreshSrc}\nreturn refresh;`,
  )(
    refreshRequestId,
    () => {},
    async () => {
      listRecordsCallCount += 1;
      if (listRecordsCallCount === 1) {
        await firstCallHeld; // the stale "first" refresh's own network call stays open
        return { records: [{ id: 1, name: "stale" }] };
      }
      return { records: [{ id: 2, name: "fresh" }] };
    },
    { name: "Customer" },
    (records: unknown[]) => {
      capturedRecordsByCall.push(records);
    },
    () => {},
  ) as () => Promise<void>;

  const stalePromise = fn();
  await Promise.resolve(); // let the stale call actually start and reach its held-open listRecords call
  const freshPromise = fn();
  await freshPromise;

  assert.equal(capturedRecordsByCall.length, 1, "the fresh (second) refresh must have applied its own records");
  assert.deepEqual(capturedRecordsByCall[0], [{ id: 2, name: "fresh" }]);

  resolveFirstCall();
  await stalePromise;

  assert.equal(
    capturedRecordsByCall.length,
    1,
    "the stale (first) refresh resolving afterward must never call setRecords again and overwrite the fresh records",
  );
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

// Round 117/118 found and fixed the exact same untested boolean-CSV gap
// in two other independent copies of this formatting logic
// (apps/api/src/backup.ts and codegen.ts's own server-side
// backupFieldDisplayValue). This is a THIRD, separate copy -- the
// per-entity "Export CSV" button's client-side fieldDisplayValue/
// recordsToCsv, embedded in the exported app's EntityView.jsx -- and the
// existing tests above only ever check for the functions' *presence*
// (regex-matching their signatures), never their actual rendered output
// for any field type. Extracts and executes the real generated
// csvEscape/fieldDisplayValue/recordsToCsv (not a reimplementation), the
// same technique round 118 introduced for this file.
test("the exported EntityView's own CSV-export formatting renders booleans as TRUE/FALSE and enum values as their translated labels", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const csvEscapeSrc = entityViewJsx.match(/function csvEscape\(value\) \{[\s\S]*?\n\}\n/)?.[0];
  const fieldDisplayValueSrc = entityViewJsx.match(/function fieldDisplayValue\(field, value, relatedRecords\) \{[\s\S]*?\n\}\n/)?.[0];
  const recordsToCsvSrc = entityViewJsx.match(/function recordsToCsv\(fields, records, relatedRecords\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(csvEscapeSrc && fieldDisplayValueSrc && recordsToCsvSrc, "expected to find csvEscape/fieldDisplayValue/recordsToCsv in the generated EntityView.jsx");

  const { recordsToCsv } = new Function(`${csvEscapeSrc}\n${fieldDisplayValueSrc}\n${recordsToCsvSrc}\nreturn { recordsToCsv };`)();

  const fields = [
    { name: "title", label: "Title", type: "text" },
    { name: "done", label: "Done", type: "boolean" },
    { name: "status", label: "Status", type: "enum", enumLabels: { New: "New", Won: "Won!" } },
  ];
  const records = [
    { title: "Task A", done: true, status: "Won" },
    { title: "Task B", done: false, status: "New" },
  ];

  const csv = recordsToCsv(fields, records, {});
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Title,Done,Status");
  assert.equal(lines[1], "Task A,TRUE,Won!");
  assert.equal(lines[2], "Task B,FALSE,New");
});

test("the exported EntityView asks for confirmation before deleting a single record, naming it by its own display label, not just count", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  assert.match(entityViewJsx, /function handleDelete\(id\) \{\s*const index = records\.findIndex/);
  assert.match(entityViewJsx, /window\.confirm\(`Delete "\$\{label\}"\? This can't be undone\.`\)/);
});

/**
 * New in this round: the exported standalone app's own Delete button had
 * no undo at all -- unlike the live Forge AI preview (round 184's own
 * undo toast), a single click on Delete (past the confirm dialog) was
 * instantly irreversible in the exported app. Ports the identical fix:
 * the record disappears from view right away (so the table still feels
 * instant), but the real DELETE request is delayed behind a real
 * UNDO_WINDOW_MS window, with a toast offering Undo. Executes the real
 * generated restoreRecordAt (extracted from real codegen output, not
 * reimplemented), mirroring apps/web/src/entityFormatting.test.ts's own
 * restoreRecordAt coverage.
 */
test("the exported EntityView's restoreRecordAt reinserts a record at its original index, not at the end or via mutation", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const restoreSrc = entityViewJsx.match(/export function restoreRecordAt\(records, record, index\) \{[\s\S]*?\n\}\n/)?.[0]?.replace("export ", "");
  assert.ok(restoreSrc, "expected to find restoreRecordAt in generated output");

  const restoreRecordAt = new Function(`${restoreSrc}\nreturn restoreRecordAt;`)() as (
    records: { id: number }[],
    record: { id: number },
    index: number,
  ) => { id: number }[];

  const records = [{ id: 1 }, { id: 2 }, { id: 4 }];
  const restored = restoreRecordAt(records, { id: 3 }, 2);
  assert.deepEqual(
    restored.map((r) => r.id),
    [1, 2, 3, 4],
    "the record must land back at its original index, not get appended to the end",
  );
  assert.deepEqual(records.map((r) => r.id), [1, 2, 4], "the original array must not be mutated");

  const clamped = restoreRecordAt(records, { id: 99 }, 50);
  assert.deepEqual(clamped.map((r) => r.id), [1, 2, 4, 99], "an out-of-range index must clamp to the end rather than throw");
});

test("the exported EntityView renders a real Undo toast after a single-record delete, wired to a real UNDO_WINDOW_MS-delayed commit", () => {
  const files = generateExportFiles(project);
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  assert.match(entityViewJsx, /const UNDO_WINDOW_MS = 5000;/);
  assert.match(entityViewJsx, /const \[pendingDelete, setPendingDelete\] = useState\(null\);/);
  assert.match(entityViewJsx, /function commitPendingDelete\(pending\) \{\s*deleteRecord\(entity\.name, pending\.id\)\.catch/);
  assert.match(entityViewJsx, /function handleUndoDelete\(\) \{/);
  assert.match(entityViewJsx, /className="entity-undo-toast"/);
  assert.match(entityViewJsx, /onClick=\{handleUndoDelete\}/);
  // handleDelete must remove the record from view immediately (optimistic),
  // not wait on the real request the way it used to.
  assert.match(entityViewJsx, /setRecords\(\(prev\) => prev\.filter\(\(r\) => r\.id !== id\)\)/);
  // A second delete arriving mid-undo-window must commit the first one for
  // real rather than letting two undo windows overlap.
  assert.match(entityViewJsx, /if \(pendingDeleteRef\.current\) \{\s*clearTimeout\(pendingDeleteRef\.current\.timeoutId\);\s*commitPendingDelete\(pendingDeleteRef\.current\);/);
  // The delete must actually go through the delayed-commit setTimeout, not
  // be committed for real immediately -- otherwise there'd be no undo
  // window at all despite the toast being shown.
  assert.match(entityViewJsx, /const timeoutId = setTimeout\(\(\) => \{\s*setPendingDelete\(\(current\) => \{\s*if \(current\?\.id !== id\) return current;\s*commitPendingDelete\(current\);\s*return null;\s*\}\);\s*\}, UNDO_WINDOW_MS\);/);
  assert.match(entityViewJsx, /setPendingDelete\(\{ id, record, index, label, timeoutId \}\);/);

  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.entity-undo-toast/);
  assert.match(stylesCss, /\.link-button/);
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

// Regression test: the exported app's CSV import validates numbers and enum
// values client-side (a row-numbered error before anything is even sent to
// the server) but, until now, silently accepted any string at all for a
// "date" field -- the same gap round 62 found in repository.ts and round 64
// found in this very file's own server-side coerce(), just recurring a
// third time in a fourth, independent copy: this file's *client-side*
// buildImportRecords(), which the comment right above handleImportFile
// claims already validates every field "client-side". Executes the actual
// generated buildImportRecords/matchesImportHeader/isValidDate functions
// (extracted from real codegen output, not reimplemented here) so a future
// edit to this template can't silently reintroduce the gap.
test("the exported EntityView's CSV import rejects a date field value that isn't a real, well-formed calendar date", () => {
  const dateProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Appointment",
          label: "Appointment",
          fields: [
            { name: "date", label: "Date", type: "date", required: true },
            { name: "notes", label: "Notes", type: "text" },
          ],
        },
      ],
    },
  };
  const entityViewJsx = generateExportFiles(dateProject).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  const isValidDateSrc = entityViewJsx.match(/const DATE_FORMAT[\s\S]*?\nfunction isValidDate\(value\) \{[\s\S]*?\n\}\n/)?.[0];
  const headerSrc = entityViewJsx.match(/function matchesImportHeader\(header, field\) \{[\s\S]*?\n\}\n/)?.[0];
  const importSrc = entityViewJsx.match(/function buildImportRecords\(fields, rows\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(isValidDateSrc && headerSrc && importSrc, "expected to find isValidDate/matchesImportHeader/buildImportRecords in generated output");

  const buildImportRecords = new Function(`${isValidDateSrc}\n${headerSrc}\n${importSrc}\nreturn buildImportRecords;`)();

  const fields = dateProject.spec.entities[0].fields;
  const rows = [
    ["Date", "Notes"],
    ["2024-01-15", "valid"],
    ["2024-13-45", "impossible date"],
    ["not-a-date", "garbage"],
  ];
  const { records, errors } = buildImportRecords(fields, rows);

  assert.deepEqual(records, [{ date: "2024-01-15", notes: "valid" }]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Row 2: "2024-13-45" isn't a valid date/);
  assert.match(errors[1], /Row 3: "not-a-date" isn't a valid date/);
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
});

// Regression test: runSearch used to await a bare
// Promise.all(entities.map(searchEntity)) -- one entity whose records
// failed to load (a transient network blip, a cold-starting backend)
// rejected the WHOLE search, blanking out results from every OTHER
// entity that searched fine. A user with, say, 9 working entity tables
// and 1 flaky one got a bare error message instead of the 9 entities'
// worth of results they could otherwise see. Runs the real generated
// runSearch/searchEntity with a mock listRecords that fails for exactly
// one of three entities.
test("the exported GlobalSearch's runSearch shows results from every entity that succeeded, instead of Promise.all's all-or-nothing blanking everything on one entity's failure", async () => {
  const files = generateExportFiles(project);
  const globalSearchJsx = files.find((f) => f.path === "web/src/components/GlobalSearch.jsx")!.content;
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  const matchesSearchSrc = entityViewJsx.match(/export function matchesSearch\([\s\S]*?\n\}\n/)?.[0]?.replace("export ", "");
  const searchEntitySrc = globalSearchJsx.match(/async function searchEntity\([\s\S]*?\n\}\n/)?.[0];
  const runSearchSrc = globalSearchJsx.match(/ {2}async function runSearch\(q\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(
    matchesSearchSrc && searchEntitySrc && runSearchSrc,
    "expected to find matchesSearch/searchEntity/runSearch in generated output",
  );

  const entityA = { name: "Alpha", label: "Alpha", fields: [{ name: "name", label: "Name", type: "text" }] };
  const entityB = { name: "Beta", label: "Beta", fields: [{ name: "name", label: "Name", type: "text" }] };
  const entityC = { name: "Gamma", label: "Gamma", fields: [{ name: "name", label: "Name", type: "text" }] };
  const rejection = new Error("network error");

  let capturedResults: unknown[] | undefined;
  let capturedError: string | undefined;

  const fn = new Function(
    "entities",
    "listRecords",
    "setLoading",
    "setError",
    "setResults",
    "setSearched",
    "setSelectedIndex",
    "searchRequestId",
    `${matchesSearchSrc}\n${searchEntitySrc}\n${runSearchSrc}\nreturn runSearch;`,
  )(
    [entityA, entityB, entityC],
    async (entityName: string) => {
      if (entityName === "Beta") throw rejection;
      return { records: [{ id: 1, name: `match-${entityName}` }] };
    },
    () => {},
    (msg: string) => {
      capturedError = msg;
    },
    (results: unknown[]) => {
      capturedResults = results;
    },
    () => {},
    () => {},
    { current: 0 },
  ) as (q: string) => Promise<void>;

  await fn("match");

  assert.deepEqual(
    (capturedResults ?? []).map((r) => (r as { entityName: string }).entityName),
    ["Alpha", "Gamma"],
    "must still show results from the entities that searched successfully",
  );
  assert.match(
    capturedError!,
    /1 of 3/,
    "a partial failure must report how many entities failed, not the raw single-entity rejection",
  );

  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /\.search-overlay/);
  assert.match(stylesCss, /\.global-search-group-selected/);
});

/**
 * Regression test: the exported app's own GlobalSearch.jsx is a deliberate
 * duplicate of the live-preview GlobalSearchPanel.tsx's runSearch, and it
 * had the exact same stale-async-overwrites-newer-setState race this
 * session already found and fixed in GlobalSearchPanel.tsx itself (round
 * 95) -- a second, more recent search that resolves before a slower first
 * one lets the first search's late-arriving setResults silently clobber
 * the newer, correct results on screen. Deterministic, not timing-based:
 * holds the FIRST search's listRecords call open past the SECOND search's
 * own completion. Runs the real generated runSearch/searchEntity.
 */
test("the exported GlobalSearch's runSearch ignores a stale, still-in-flight search's results once a newer search has already completed", async () => {
  const files = generateExportFiles(project);
  const globalSearchJsx = files.find((f) => f.path === "web/src/components/GlobalSearch.jsx")!.content;
  const entityViewJsx = files.find((f) => f.path === "web/src/components/EntityView.jsx")!.content;

  const matchesSearchSrc = entityViewJsx.match(/export function matchesSearch\([\s\S]*?\n\}\n/)?.[0]?.replace("export ", "");
  const searchEntitySrc = globalSearchJsx.match(/async function searchEntity\([\s\S]*?\n\}\n/)?.[0];
  const runSearchSrc = globalSearchJsx.match(/ {2}async function runSearch\(q\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(
    matchesSearchSrc && searchEntitySrc && runSearchSrc,
    "expected to find matchesSearch/searchEntity/runSearch in generated output",
  );

  const entityA = { name: "Alpha", label: "Alpha", fields: [{ name: "name", label: "Name", type: "text" }] };

  let listRecordsCallCount = 0;
  let resolveFirstCall!: () => void;
  const firstCallHeld = new Promise<void>((resolve) => {
    resolveFirstCall = resolve;
  });
  const capturedResultsByCall: unknown[][] = [];
  const searchRequestId = { current: 0 };

  const fn = new Function(
    "entities",
    "listRecords",
    "setLoading",
    "setError",
    "setResults",
    "setSearched",
    "setSelectedIndex",
    "searchRequestId",
    `${matchesSearchSrc}\n${searchEntitySrc}\n${runSearchSrc}\nreturn runSearch;`,
  )(
    [entityA],
    async () => {
      listRecordsCallCount += 1;
      if (listRecordsCallCount === 1) {
        await firstCallHeld; // the stale "first" search's own network call stays open
        return { records: [{ id: 1, name: "stale-target" }] };
      }
      return { records: [{ id: 2, name: "fresh-target" }] };
    },
    () => {},
    () => {},
    (results: unknown[]) => {
      capturedResultsByCall.push(results);
    },
    () => {},
    () => {},
    searchRequestId,
  ) as (q: string) => Promise<void>;

  const stalePromise = fn("target");
  await Promise.resolve(); // let the stale call actually start and reach its held-open listRecords call
  const freshPromise = fn("target");
  await freshPromise;

  assert.equal(capturedResultsByCall.length, 1, "the fresh (second) search must have applied its own results");
  assert.deepEqual(
    (capturedResultsByCall[0][0] as { sample: unknown[] }).sample,
    [{ id: 2, name: "fresh-target" }],
  );

  resolveFirstCall();
  await stalePromise;

  assert.equal(
    capturedResultsByCall.length,
    1,
    "the stale (first) search resolving afterward must never call setResults again and overwrite the fresh results",
  );
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

// Round 117 found that apps/api/src/backup.ts's boolean CSV rendering was
// completely untested -- and that an *omitted* boolean field renders
// "FALSE", not blank, because rowToRecord coerces a stored NULL through
// Boolean(value) before the CSV writer ever sees it. This exported app's
// server.js has its own independent copy of that exact same rowToRecord +
// backupFieldDisplayValue pair (see codegen.ts's template), so the same
// gap and the same invariant apply here too -- confirmed by extracting and
// executing the real generated functions (not a reimplementation), the
// same technique the buildZip test below uses, rather than the heavier
// spawn-a-real-server approach the /api/backup integration test above
// uses (unnecessary here since no HTTP or real SQLite round-trip is
// involved).
test("the exported server.js's own rowToRecord + backupFieldDisplayValue render a boolean as TRUE/FALSE, and an omitted boolean as FALSE rather than blank", () => {
  const serverJs = generateExportFiles(project).find((f) => f.path === "server.js")!.content;
  const rowToRecordSrc = serverJs.match(/function rowToRecord\(entity, row\) \{[\s\S]*?\n\}\n/)?.[0];
  const backupFieldDisplayValueSrc = serverJs.match(/function backupFieldDisplayValue\(field, value, recordsByEntity\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(rowToRecordSrc, "expected to find rowToRecord in generated server.js");
  assert.ok(backupFieldDisplayValueSrc, "expected to find backupFieldDisplayValue in generated server.js");

  const { rowToRecord, backupFieldDisplayValue } = new Function(
    `${rowToRecordSrc}\n${backupFieldDisplayValueSrc}\nreturn { rowToRecord, backupFieldDisplayValue };`,
  )();

  const entity = { name: "Task", fields: [{ name: "done", type: "boolean" }] };
  const trueRecord = rowToRecord(entity, { id: 1, createdAt: "", done: 1 });
  const falseRecord = rowToRecord(entity, { id: 2, createdAt: "", done: 0 });
  const unsetRecord = rowToRecord(entity, { id: 3, createdAt: "" }); // no "done" column value at all

  assert.equal(backupFieldDisplayValue(entity.fields[0], trueRecord.done, {}), "TRUE");
  assert.equal(backupFieldDisplayValue(entity.fields[0], falseRecord.done, {}), "FALSE");
  assert.equal(backupFieldDisplayValue(entity.fields[0], unsetRecord.done, {}), "FALSE");
});

// Regression test: the exported app's own embedded buildZip() (a
// necessary copy of apps/api/src/zip.ts, since the exported app has zero
// runtime dependency on this repo) had drifted from it -- missing the
// UTF-8 general-purpose-bit-flag zip.ts's own test below documents, and
// missing the >65535-entries guard zip.test.ts has. Neither was reachable
// through this app's own backup endpoint (entity names are always plain
// ASCII identifiers -- see codegen.ts's own assertSafe -- and a real
// project has nowhere near 65535 entities), so it was never a live bug,
// but it's still worth keeping the two copies in sync rather than letting
// a real reader-compatibility/entry-count fix applied to zip.ts silently
// never reach the exported app. Extracts and executes the real generated
// buildZip/crc32/CRC_TABLE (not a reimplementation) via a direct Python
// zipfile check, the same "spec-strict reader" technique zip.test.ts uses
// (the system `unzip` auto-detects UTF-8 regardless of the flag, so it
// wouldn't catch a regression here).
test("the exported app's embedded buildZip sets the UTF-8 flag and rejects more than 65535 entries, matching the live zip.ts", () => {
  const serverJs = generateExportFiles(project).find((f) => f.path === "server.js")!.content;
  const crcTableSrc = serverJs.match(/const CRC_TABLE = \(\(\) => \{[\s\S]*?\n\}\)\(\);\n/)?.[0];
  const crc32Src = serverJs.match(/function crc32\(buf\) \{[\s\S]*?\n\}\n/)?.[0];
  const dosSrc = serverJs.match(/const DOS_TIME[\s\S]*?const DOS_DATE.*\n/)?.[0];
  const buildZipSrc = serverJs.match(/function buildZip\(entries\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(crcTableSrc && crc32Src && dosSrc && buildZipSrc, "expected to find CRC_TABLE/crc32/DOS_TIME/DOS_DATE/buildZip in generated server.js");

  const buildZip = new Function(`${crcTableSrc}\n${crc32Src}\n${dosSrc}\n${buildZipSrc}\nreturn buildZip;`)();

  const hebrewName = "לקוחות.csv";
  const zip = buildZip([{ path: hebrewName, content: "a,b\n1,2\n" }]);
  const dir = mkdtempSync(path.join(tmpdir(), "codegen-zip-utf8-test-"));
  const zipPath = path.join(dir, "out.zip");
  writeFileSync(zipPath, zip);
  try {
    const output = execFileSync(
      "python3",
      ["-c", "import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).namelist()[0])", zipPath],
      { encoding: "utf8" },
    ).trim();
    assert.equal(output, hebrewName);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const tooMany = Array.from({ length: 65536 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
  assert.throws(() => buildZip(tooMany), /Zip64/i);
});

// PWA support for the exported standalone app -- installable to a phone's
// home screen, opening in its own window without browser chrome, and
// staying usable through a flaky connection. Requested directly by שלומי
// ("build a feature Claude doesn't have") after being asked to pick a
// concrete direction: a real, installable app on her phone, not a browser
// tab -- exactly what a web app manifest + service worker provide.

test("generateExportFiles produces a real web app manifest naming the project, with standalone display and an SVG icon", () => {
  const files = generateExportFiles(project);
  const manifestFile = files.find((f) => f.path === "web/public/manifest.json");
  assert.ok(manifestFile, "expected web/public/manifest.json in the export (Vite's publicDir, copied verbatim to dist/)");
  const manifest = JSON.parse(manifestFile!.content);
  assert.equal(manifest.name, project.name);
  assert.equal(manifest.display, "standalone", "standalone display is what actually hides the browser chrome once installed");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.length > 0);
  assert.ok(manifest.icons.every((icon: { src: string }) => icon.src === "/icon.svg"));

  const iconFile = files.find((f) => f.path === "web/public/icon.svg")!;
  assert.match(iconFile.content, /<svg[^>]*viewBox="0 0 192 192"/);
  assert.match(iconFile.content, />B<\/text>/, "Beauty Clinic Manager's icon should show its initial, 'B'");
});

test("a very long project name gets a truncated short_name, so it doesn't get cut off unpredictably on a real home screen", () => {
  const longNameProject: Project = { ...project, name: "The Complete Beauty and Wellness Clinic Management Platform" };
  const files = generateExportFiles(longNameProject);
  const manifest = JSON.parse(files.find((f) => f.path === "web/public/manifest.json")!.content);
  assert.equal(manifest.name, longNameProject.name, "the full name is still kept for the install prompt/app-switcher");
  assert.ok(manifest.short_name.length <= 14, `short_name should be truncated, got "${manifest.short_name}"`);
});

test("a Hebrew project name gets a Hebrew icon initial, not a mangled half-character from a raw UTF-16 index", () => {
  const hebrewProject: Project = { ...project, name: "מספרת יופי" };
  const files = generateExportFiles(hebrewProject);
  const iconFile = files.find((f) => f.path === "web/public/icon.svg")!;
  assert.match(iconFile.content, />מ<\/text>/);
});

test("the exported index.html links the manifest and icon, and sets a real theme-color", () => {
  const html = generateExportFiles(project).find((f) => f.path === "web/index.html")!.content;
  assert.match(html, /<link rel="manifest" href="\/manifest\.json" \/>/);
  assert.match(html, /<meta name="theme-color" content="#d9622b" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon\.svg" \/>/);
});

test("main.jsx registers the service worker only after the app's own first render, and never lets a failed registration surface as an error", () => {
  const mainJsx = generateExportFiles(project).find((f) => f.path === "web/src/main.jsx")!.content;
  const renderIndex = mainJsx.indexOf("createRoot");
  const registerIndex = mainJsx.indexOf("serviceWorker.register");
  assert.ok(renderIndex !== -1 && registerIndex !== -1);
  assert.ok(renderIndex < registerIndex, "registration must come after the render call, not block the app's first paint");
  assert.match(mainJsx, /navigator\.serviceWorker\.register\("\/sw\.js"\)\.catch\(\(\) => \{\}\)/);
});

/**
 * Regression-style behavioral test (not just a string match): runs the real
 * generated service worker's fetch handler against a mocked self/caches/fetch,
 * confirming a request to /api/* is never intercepted (no event.respondWith
 * call at all -- the browser's own real network fetch runs untouched), while
 * an ordinary static asset request IS intercepted and resolves to a real
 * Response. A stale cached response for this app's own live business data
 * (today's appointments, a customer list) would be actively wrong, not just
 * out of date, so this is the one behavior that must never regress silently.
 */
test("the exported service worker's fetch handler never intercepts /api/ requests but does intercept ordinary static asset requests", async () => {
  const swJs = generateExportFiles(project).find((f) => f.path === "web/public/sw.js")!.content;

  const listeners: Record<string, (event: unknown) => void> = {};
  const fakeSelf = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners[type] = handler;
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const fakeCaches = {
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    match: async () => undefined,
    keys: async () => [],
    delete: async () => {},
  };
  const fakeFetch = async () => new Response("ok", { status: 200 });

  new Function("self", "caches", "fetch", swJs)(fakeSelf, fakeCaches, fakeFetch);
  assert.ok(listeners.fetch, "expected the exported sw.js to register a fetch listener");

  let apiRespondWithCalled = false;
  listeners.fetch({
    request: new Request("http://localhost/api/Customer"),
    respondWith: () => {
      apiRespondWithCalled = true;
    },
  });
  assert.equal(apiRespondWithCalled, false, "an /api/ GET must never be intercepted with respondWith");

  let assetResponsePromise: Promise<Response> | undefined;
  listeners.fetch({
    request: new Request("http://localhost/assets/index-abc123.js"),
    respondWith: (p: Promise<Response>) => {
      assetResponsePromise = p;
    },
  });
  assert.ok(assetResponsePromise, "an ordinary static asset request must be intercepted");
  const assetResponse = await assetResponsePromise!;
  assert.equal(await assetResponse.text(), "ok");
});

/**
 * The strongest proof this feature actually works: writes the FULL export
 * (not just server.js, like the tests above) to a real directory, runs a
 * real `vite build` (the exact command this export's own package.json
 * promises), then spawns the real server.js and fetches /manifest.json,
 * /icon.svg, and /sw.js from it -- confirming Vite's publicDir convention
 * genuinely copies web/public/* to dist/* at the paths index.html/main.jsx
 * actually reference, not just that the generated source strings look
 * right in isolation.
 */
test("a real vite build of the exported app actually serves the manifest, icon, and service worker at the root paths the app references", async () => {
  const files = generateExportFiles(project);
  const dir = mkdtempSync(path.join(tmpdir(), "codegen-pwa-test-"));
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  for (const file of files) {
    const filePath = path.join(dir, file.path);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content);
  }

  try {
    execFileSync(path.join(dir, "node_modules", ".bin", "vite"), ["build"], { cwd: dir, stdio: "pipe" });

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
      const deadline = Date.now() + 5000;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`server.js exited early (code ${child.exitCode}):\n${stderr}`);
        }
        try {
          const manifestRes = await fetch(`http://localhost:${port}/manifest.json`);
          assert.equal(manifestRes.status, 200);
          const manifest = await manifestRes.json();
          assert.equal(manifest.name, project.name);

          const iconRes = await fetch(`http://localhost:${port}/icon.svg`);
          assert.equal(iconRes.status, 200);
          assert.match(await iconRes.text(), /<svg/);

          const swRes = await fetch(`http://localhost:${port}/sw.js`);
          assert.equal(swRes.status, 200);
          assert.match(await swRes.text(), /addEventListener\("fetch"/);
          return;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    } finally {
      child.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * New in this round: the exported standalone app never had a dark mode at
 * all -- every color in styles.css was a hardcoded hex value, unlike the
 * live Forge AI preview (round 42's own dark mode toggle). Someone who
 * exports and self-hosts their app loses that. theme.js mirrors the live
 * preview's own theme/theme.ts exactly (same storage key fallback order):
 * an explicit stored choice always wins; otherwise the OS-level
 * prefers-color-scheme decides; light when there's no signal at all.
 * Executes the real generated detectInitialTheme, not a reimplementation.
 */
test("the exported theme.js's detectInitialTheme prefers an explicit stored choice, then the system preference, then light", () => {
  const themeJs = generateExportFiles(project).find((f) => f.path === "web/src/theme.js")!.content;
  assert.match(themeJs, /THEME_STORAGE_KEY/);

  const themeJsBody = themeJs.replace(/^export /gm, "");
  const detectInitialTheme = new Function(`${themeJsBody}\nreturn detectInitialTheme;`)() as (
    stored: string | null,
    prefersDark?: boolean,
  ) => string;

  assert.equal(detectInitialTheme(null, false), "light", "no stored choice, no system preference -> light");
  assert.equal(detectInitialTheme(null, true), "dark", "no stored choice, system prefers dark -> dark");
  assert.equal(detectInitialTheme("light", true), "light", "an explicit stored 'light' wins even if the system prefers dark");
  assert.equal(detectInitialTheme("dark", false), "dark", "an explicit stored 'dark' wins even if the system prefers light");
  assert.equal(detectInitialTheme("not-a-real-value", true), "dark", "a corrupted stored value falls back to the system preference");
});

test("the exported App.jsx renders a real theme toggle button wired to detectInitialTheme and localStorage, matching the live preview's own ThemeSwitcher", () => {
  const files = generateExportFiles(project);
  const appJsx = files.find((f) => f.path === "web/src/App.jsx")!.content;

  assert.match(appJsx, /import \{ THEME_STORAGE_KEY, detectInitialTheme \} from "\.\/theme\.js";/);
  assert.match(appJsx, /className="theme-switch"/);
  assert.match(appJsx, /setTheme\(\(current\) => \(current === "dark" \? "light" : "dark"\)\)/);
  assert.match(appJsx, /document\.documentElement\.setAttribute\("data-theme", theme\)/);
  assert.match(appJsx, /localStorage\.setItem\(THEME_STORAGE_KEY, theme\)/);

  // The exported CSS actually reacts to the attribute the toggle sets, via
  // real CSS variables -- not just a button that flips unused state.
  const stylesCss = files.find((f) => f.path === "web/src/styles.css")!.content;
  assert.match(stylesCss, /:root\[data-theme="dark"\]/);
  assert.match(stylesCss, /body \{ font-family: [^;]+; margin: 0; background: var\(--bg\); color: var\(--text\); \}/);
});

test("render.yaml's service name is a safe slug even for a project name with spaces, punctuation, and Hebrew", () => {
  const messyName: Project = { ...project, name: 'לקוחות שלי! (v2) — "Best" App?' };
  const files = generateExportFiles(messyName);
  const renderYaml = files.find((f) => f.path === "render.yaml")!.content;
  const nameLine = renderYaml.split("\n").find((l) => l.trim().startsWith("name:"))!;
  const name = nameLine.split("name:")[1].trim();
  assert.match(name, /^[a-z0-9-]+$/, `render.yaml service name must be a safe slug, got: "${name}"`);
});

/**
 * Regression test: the exported app's own badgeTone copy (a deliberate
 * duplicate of apps/web/src/entityFormatting.ts's, per this codebase's
 * "duplicate small formatting helpers per surface" pattern) had the same
 * gap as the live-preview version -- the built-in InsuranceClaim domain
 * entity's own status enum uses "Denied" right alongside "Approved", but
 * only "Approved" read as a colored badge; "Denied" fell through to the
 * same neutral gray as a genuinely undecided "Submitted"/"UnderReview"
 * state. Runs the real generated badgeTone (extracted from real codegen
 * output, not reimplemented here), not a reference copy.
 */
test("the exported EntityView's badgeTone classifies 'Denied' as negative, matching InsuranceClaim's real status enum", () => {
  const entityViewJsx = generateExportFiles(project).find((f) => f.path === "web/src/components/EntityView.jsx")!.content;
  const badgeToneSrc = entityViewJsx.match(/const POSITIVE_WORDS[\s\S]*?\nfunction badgeTone\(rawValue\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(badgeToneSrc, "expected to find POSITIVE_WORDS/NEGATIVE_WORDS/badgeTone in generated output");

  const badgeTone = new Function(`${badgeToneSrc}\nreturn badgeTone;`)() as (v: string) => string;
  assert.equal(badgeTone("Denied"), "negative");
  assert.equal(badgeTone("Approved"), "positive");
});
