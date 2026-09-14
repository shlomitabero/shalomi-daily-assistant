import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildZip } from "./zip.js";

test("buildZip produces a real, valid ZIP file the system unzip utility can extract", () => {
  const zip = buildZip([
    { path: "README.md", content: "# Hello\n" },
    { path: "src/server.js", content: "console.log('hi');\n" },
    { path: "empty.txt", content: "" },
  ]);

  const dir = mkdtempSync(path.join(tmpdir(), "zip-test-"));
  const zipPath = path.join(dir, "out.zip");
  writeFileSync(zipPath, zip);

  try {
    // -t verifies the archive's integrity (checksums included).
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });

    execFileSync("unzip", ["-o", zipPath, "-d", dir], { stdio: "pipe" });
    assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), "# Hello\n");
    assert.equal(readFileSync(path.join(dir, "src/server.js"), "utf8"), "console.log('hi');\n");
    assert.equal(readFileSync(path.join(dir, "empty.txt"), "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildZip handles a single file and an empty archive", () => {
  const single = buildZip([{ path: "a.txt", content: "x" }]);
  assert.ok(single.length > 0);
  assert.equal(single.readUInt32LE(0), 0x04034b50);

  const empty = buildZip([]);
  assert.equal(empty.readUInt32LE(0), 0x06054b50);
});
