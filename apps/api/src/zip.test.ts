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

test("buildZip sets the UTF-8 flag so a non-ASCII filename round-trips correctly through a spec-strict reader", () => {
  // The ZIP spec's language-encoding flag (bit 11 of the general-purpose
  // bit flag) tells a reader whether the filename bytes are UTF-8 or the
  // legacy CP437 code page. This project explicitly supports non-ASCII
  // (Hebrew) entity/field labels, so a general-purpose zip writer should
  // set this correctly rather than relying on a reader's own heuristics.
  // The system `unzip` used in the test above auto-detects valid UTF-8
  // regardless of this flag, so it wouldn't catch a regression here --
  // Python's zipfile module is spec-strict and only decodes as UTF-8 when
  // the flag is actually set, so it's used here instead as a real,
  // independent cross-tool check.
  const hebrewName = "לקוחות.csv";
  const zip = buildZip([{ path: hebrewName, content: "a,b\n1,2\n" }]);

  const dir = mkdtempSync(path.join(tmpdir(), "zip-utf8-test-"));
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
});

test("buildZip handles a single file and an empty archive", () => {
  const single = buildZip([{ path: "a.txt", content: "x" }]);
  assert.ok(single.length > 0);
  assert.equal(single.readUInt32LE(0), 0x04034b50);

  const empty = buildZip([]);
  assert.equal(empty.readUInt32LE(0), 0x06054b50);
});
