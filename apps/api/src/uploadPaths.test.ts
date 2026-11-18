import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Project } from "@forge/shared";
import { applyMigrations, insertRecord, openDatabase, type ForgeDatabase } from "@forge/db";
import { collectUploadedFileZipEntries } from "./uploadPaths.js";

function createTestDb(p: Project): ForgeDatabase {
  const db = openDatabase(":memory:");
  applyMigrations(db, p.id, p.spec);
  return db;
}

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "test",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "test",
    personas: [],
    roles: [],
    entities: [],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

/**
 * Round 2200: the code-export ZIP's generated EntityView.jsx renders a
 * file field's stored descriptor as a real, clickable <a href>/<img src>
 * pointed at /api/uploads/<projectId>/<entityName>/<filename> -- but until
 * this round, nothing ever bundled the actual uploaded bytes into that
 * ZIP, so the link 404ed forever against the exported app's own origin.
 * Mirrors generateBackupZipEntries' own identical round-1203 fix for the
 * data-backup ZIP, reusing the exact same validated resolveUploadedFilePath
 * resolution deleteUploadedFile uses to find what to delete.
 */
test("collectUploadedFileZipEntries bundles a file field's real uploaded bytes at the exact path the generated server's own /api/uploads route serves", () => {
  const fileProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        {
          name: "Applicant",
          fields: [
            { name: "name", label: "Name", type: "text", required: true },
            { name: "resume", label: "Resume", type: "file", required: false },
          ],
        },
      ],
    },
  };
  const db = createTestDb(fileProject);
  const applicant = fileProject.spec.entities[0];
  const uploadsDir = mkdtempSync(path.join(tmpdir(), "forge-export-upload-test-"));
  try {
    const filename = `${randomUUID()}.pdf`;
    mkdirSync(path.join(uploadsDir, fileProject.id, "Applicant"), { recursive: true });
    const realBytes = Buffer.from("%PDF-fake-resume-bytes");
    writeFileSync(path.join(uploadsDir, fileProject.id, "Applicant", filename), realBytes);
    insertRecord(db, fileProject.id, applicant, {
      name: "Dana Levi",
      resume: JSON.stringify({ url: `/api/uploads/${fileProject.id}/Applicant/${filename}`, name: "dana-resume.pdf", size: realBytes.length, mimeType: "application/pdf" }),
    });
    insertRecord(db, fileProject.id, applicant, { name: "No resume yet" });

    const entries = collectUploadedFileZipEntries(db, uploadsDir, fileProject);
    assert.equal(entries.length, 1, "a record with no file set must not produce an entry");
    assert.equal(
      entries[0].path,
      `uploads/${fileProject.id}/Applicant/${filename}`,
      "the entry's path must exactly match the relative url the generated EntityView.jsx's own <a href> already points at, so no rewriting is needed on either side",
    );
    assert.ok(Buffer.isBuffer(entries[0].content), "the entry's content must be the real binary bytes, not a string");
    assert.deepEqual(entries[0].content, realBytes, "the bundled bytes must exactly match what was actually uploaded");
  } finally {
    rmSync(uploadsDir, { recursive: true, force: true });
  }
});

/**
 * Round 2200: mirrors resolveUploadedFilePath's own best-effort contract
 * (deleteUploadedFile's identical silent-skip) -- an entity with no file
 * fields at all must never be queried, and a stored descriptor that
 * doesn't resolve to a real file on disk (already deleted, malformed, or
 * simply unset) must be skipped rather than throwing and failing the
 * whole export over one missing attachment.
 */
test("collectUploadedFileZipEntries skips entities with no file fields and records whose file doesn't resolve to a real upload, without throwing", () => {
  const mixedProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      entities: [
        { name: "Note", fields: [{ name: "title", label: "Title", type: "text", required: true }] },
        {
          name: "Applicant",
          fields: [
            { name: "name", label: "Name", type: "text", required: true },
            { name: "resume", label: "Resume", type: "file", required: false },
          ],
        },
      ],
    },
  };
  const db = createTestDb(mixedProject);
  insertRecord(db, mixedProject.id, mixedProject.spec.entities[0], { title: "unrelated note" });
  insertRecord(db, mixedProject.id, mixedProject.spec.entities[1], {
    name: "Already deleted",
    resume: JSON.stringify({ url: `/api/uploads/${mixedProject.id}/Applicant/${randomUUID()}.pdf`, name: "gone.pdf", size: 1, mimeType: "application/pdf" }),
  });
  const uploadsDir = mkdtempSync(path.join(tmpdir(), "forge-export-upload-test-"));
  try {
    const entries = collectUploadedFileZipEntries(db, uploadsDir, mixedProject);
    assert.deepEqual(entries, [], "a Note record (no file fields) and an Applicant record whose file was never actually written to disk must both be skipped, with no throw");
  } finally {
    rmSync(uploadsDir, { recursive: true, force: true });
  }
});
