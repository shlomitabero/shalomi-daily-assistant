import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    ],
  },
};

test("generateExportFiles produces the expected file set", () => {
  const files = generateExportFiles(project);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [".gitignore", "README.md", "package.json", "public/index.html", "server.js"]);
});

test("generated package.json is valid JSON with an express dependency", () => {
  const files = generateExportFiles(project);
  const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
  assert.equal(pkg.private, true);
  assert.ok(pkg.dependencies.express);
  assert.equal(pkg.scripts.start, "node server.js");
});

test("generated server.js is syntactically valid JavaScript", () => {
  const files = generateExportFiles(project);
  const serverJs = files.find((f) => f.path === "server.js")!.content;
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

test("generated index.html sets RTL when entity labels are Hebrew", () => {
  const files = generateExportFiles(project);
  const html = files.find((f) => f.path === "public/index.html")!.content;
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="he"/);
});

test("refuses to export an unsafe entity/field name rather than emitting broken SQL", () => {
  const malicious: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [{ name: "Bad; DROP TABLE x;--", fields: [{ name: "n", type: "text", required: true }] }],
    },
  };
  assert.throws(() => generateExportFiles(malicious));
});
