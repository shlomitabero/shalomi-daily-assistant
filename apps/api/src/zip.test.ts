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

test("buildZip throws a clear, actionable error instead of a raw RangeError when the entry count exceeds the non-Zip64 16-bit limit", () => {
  // The end-of-central-directory record's entry-count fields are 16-bit,
  // so more than 65535 entries would need Zip64 (not implemented here).
  // Without a guard, Buffer#writeUInt16LE throws its own generic
  // "value... must be <= 65535" RangeError deep inside the function,
  // giving a caller (e.g. the backup/export routes) no indication this
  // was an entry-count problem specifically.
  const tooMany = Array.from({ length: 65536 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
  // Matching specifically on "Zip64" (not just "65535", which the raw
  // Buffer RangeError's own generic message also happens to contain) is
  // what actually distinguishes the intended, descriptive error from the
  // pre-fix accidental one.
  assert.throws(() => buildZip(tooMany), /Zip64/i);
});

test("buildZip throws a clear, actionable error instead of a raw RangeError when a single entry's own file name exceeds the non-Zip64 16-bit limit", () => {
  // The local/central header's own file-name-length field is also 16-bit
  // (a different fixed-width field than the entry-count one just above,
  // but the identical failure shape) -- nothing upstream caps an
  // entity/field name's length (EntitySchema/FieldSchema's own `name` has
  // no `.max()`), so a long enough name reaches buildZip and would
  // otherwise fail deep inside Buffer#writeUInt16LE with the same raw,
  // unhelpful RangeError the entry-count guard above exists to avoid.
  const tooLongName = "x".repeat(70000) + ".csv";
  assert.throws(() => buildZip([{ path: tooLongName, content: "data" }]), /Zip64/i);

  // A name right at the boundary must still succeed -- this isn't an
  // overly strict guard rejecting ordinary long-but-valid names.
  const atLimit = "y".repeat(0xffff);
  assert.doesNotThrow(() => buildZip([{ path: atLimit, content: "data" }]));
});

/**
 * Round 1038: the entries.length/nameBuf.length guards above cover this
 * writer's two 16-bit fields, but it also has several 32-bit fields with
 * the identical "no Zip64 support" ~4GB ceiling (each entry's own
 * compressed/uncompressed size, its local-header offset in the central
 * directory, and the end record's own central-directory size/offset) --
 * none of which had an equivalent guard. Without one, a single entry
 * whose own content exceeds ~4GB fails deep inside Buffer#writeUInt32LE
 * with the same generic, unhelpful RangeError the other two guards exist
 * to avoid (confirmed via a direct repro:
 * Buffer.alloc(46).writeUInt32LE(0x100000000, 42) throws exactly that).
 * `backup.ts`'s own doc comments already describe "tens of thousands of
 * linked records" as a plausible real dataset, so a single entity's CSV
 * (or the whole backup's cumulative size) reaching this scale isn't
 * purely theoretical.
 */
test("buildZip throws a clear, actionable error instead of a raw RangeError when a single entry's own data exceeds the non-Zip64 32-bit size limit", () => {
  const oversized = Buffer.alloc(0xffffffff + 1);
  // Matching on "Zip64" (not the Buffer RangeError's own generic message,
  // which also happens to contain large numbers) is what distinguishes
  // the intended, descriptive error from the pre-fix accidental one. The
  // guard runs before crc32 ever touches this buffer, so this throws
  // immediately rather than first paying the cost of hashing ~4GB.
  assert.throws(() => buildZip([{ path: "huge.csv", content: oversized }]), /Zip64/i);
});

/**
 * Round 1038: the sibling 32-bit field to the one just above -- each
 * entry's own local-header OFFSET in the central directory, the running
 * total of every entry's header+name+data processed so far. A single
 * entry under the per-entry size limit from the test above can still
 * push this running total past ~4GB for whichever entry comes after it.
 * Needs one real ~4GB entry (so its own crc32 genuinely runs, unlike the
 * test above) to exercise this specific field, not just the per-entry one.
 */
test("buildZip throws a clear, actionable error instead of a raw RangeError when the running total offset across multiple entries exceeds the non-Zip64 32-bit limit", () => {
  // Comfortably under the single-entry limit (so the guard tested above
  // never fires for THIS entry), but close enough to it that adding this
  // entry's own local header (30 bytes) and file name ("big.csv", 7
  // bytes) tips the running total over the 32-bit limit by the time the
  // second, tiny entry is processed.
  const almostMax = Buffer.alloc(0xffffffff - 10);
  assert.throws(
    () => buildZip([{ path: "big.csv", content: almostMax }, { path: "small.csv", content: "x" }]),
    /Zip64/i,
    "the second entry's own local-header offset must be rejected once the running total from the first entry alone already exceeds the 32-bit limit",
  );
});
