import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Project } from "@forge/shared";
import { listRecords, type ForgeDatabase } from "@forge/db";

/**
 * Whether `candidate` resolves to `dir` itself or a true descendant of it.
 * Shared by every place that builds a real filesystem path from an entity
 * name -- `EntitySchema`'s own `name` has no character-set restriction
 * anywhere upstream (an AI-generated or directly-API-created name isn't
 * guaranteed to be a safe path segment the way a manually-added one is,
 * which `deriveEntityName` sanitizes), and `migrate.ts`'s own
 * `tableNameFor` only sanitizes that name for the SQL table it derives,
 * never rejecting the build or rewriting the spec's own stored value --
 * so a project can reach `status: "built"` with an entity literally named
 * e.g. `"../../../tmp/evil"`, that exact string preserved verbatim.
 * Resolving both paths handles `..`/`.` segments and relative vs.
 * absolute forms uniformly; comparing with a `path.sep`-prefixed
 * `startsWith` (rather than a bare prefix check) avoids a sibling
 * directory whose name happens to share `dir`'s own prefix (e.g. `dir`
 * itself vs. a sibling `dir-evil`) being mistaken for a descendant.
 */
export function isPathInsideDir(candidate: string, dir: string): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(resolvedDir + path.sep);
}

/**
 * Matches exactly what createUploadMiddleware's own filename callback
 * (routes/projects.ts) always generates (randomUUID() + safeFileExtension's
 * optional dotted extension) -- never anything else. `isPathInsideDir`
 * above only bounds a path to uploadsDir itself, not to any one project's
 * or entity's own subdirectory within it -- entity.name has no character
 * restriction (this file's own doc comment above), so
 * `path.join(uploadsDir, projectId, entityName, filename)` can resolve
 * into a DIFFERENT project's/entity's own upload directory while still
 * legitimately satisfying `isPathInsideDir`. Requiring the filename's own
 * final segment to match this exact shape (round 848/849) doesn't stop
 * that cross-project resolution, but it does narrow what it can actually
 * reach there to a file some upload somewhere was really once named --
 * never an arbitrary path a crafted file-field value could otherwise
 * invent. Shared by every place that reads, attaches, or deletes a `file`
 * field's own stored upload by filename (round 918: round 849's own
 * deleteUploadedFile and round 850's own findTemplateFileAttachment both
 * build this same path and need this same guard).
 */
export const UPLOADED_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;

/**
 * Resolves a `file`-type field's stored descriptor to the real path it
 * names on disk -- the read-only sibling of deleteUploadedFile's own
 * resolution logic below, which both now share. Applies the identical
 * validation: a `file` field's stored value is otherwise-unvalidated,
 * client-settable JSON (coerceValue's "file" case falls through to its
 * plain `String(raw)` default, same as any other untyped field -- see
 * packages/db/repository.ts), so this can never be handed a value and
 * trusted to resolve wherever its own embedded URL points. Only the
 * filename's final path segment is used, and only once it matches
 * UPLOADED_FILENAME exactly (the one shape this server itself ever
 * generates); the project/entity directory segments are NOT inherently
 * safe (entity.name has no character-set restriction), so isPathInsideDir
 * is what actually constrains the resolved target back inside uploadsDir.
 * Returns null for any value that doesn't resolve to a real, safely-
 * bounded upload -- never throws.
 *
 * Round 1270: a case-only entity rename is a true no-op at the db layer
 * (migrate.ts's own case-insensitive rename detection, confirmed across
 * rounds 617-620/954/1160 for exactly this reason) -- but the filesystem
 * is case-sensitive, and createUploadMiddleware wrote this file under
 * whatever casing was canonical AT UPLOAD TIME, which nothing ever moves
 * or renames on a later refine. When the exact-case `entityName` directory
 * has no such file, falls back to a case-insensitive sibling lookup under
 * this same project's own upload root before giving up -- still bounded
 * by `isPathInsideDir`, so this adds no new ability to escape uploadsDir.
 * Every caller (deleteUploadedFile below, backup.ts's own ZIP export,
 * automations.ts's findTemplateFileAttachment) inherits this for free.
 */
export function resolveUploadedFilePath(uploadsDir: string, projectId: string, entityName: string, rawValue: unknown): string | null {
  if (typeof rawValue !== "string" || rawValue === "") return null;
  let url: string;
  try {
    const parsed = JSON.parse(rawValue) as { url?: unknown };
    if (typeof parsed.url !== "string") return null;
    url = parsed.url;
  } catch {
    return null;
  }
  const filename = url.slice(url.lastIndexOf("/") + 1);
  if (!UPLOADED_FILENAME.test(filename)) return null;
  const target = path.join(uploadsDir, projectId, entityName, filename);
  if (!isPathInsideDir(target, uploadsDir)) return null;
  if (existsSync(target)) return target;
  const projectDir = path.join(uploadsDir, projectId);
  try {
    const sibling = readdirSync(projectDir).find((name) => name.toLowerCase() === entityName.toLowerCase() && name !== entityName);
    if (sibling) {
      const fallbackTarget = path.join(projectDir, sibling, filename);
      if (isPathInsideDir(fallbackTarget, uploadsDir) && existsSync(fallbackTarget)) return fallbackTarget;
    }
  } catch {
    // projectDir doesn't exist or isn't readable -- fall through to the
    // original, exact-case target, matching this function's own prior
    // "return the constructed path regardless of whether it exists"
    // contract for a genuinely-missing file.
  }
  return target;
}

/**
 * Deletes one `file`-type field's currently-stored upload from disk,
 * best-effort. Moved here in round 977 (originally routes/projects.ts, round
 * 674/848/849) so pipeline.ts's own migration-cleanup step (round 977) can
 * reuse it too, without routes/projects.ts and pipeline.ts importing from
 * each other in both directions.
 */
export async function deleteUploadedFile(uploadsDir: string, projectId: string, entityName: string, rawValue: unknown): Promise<void> {
  const target = resolveUploadedFilePath(uploadsDir, projectId, entityName, rawValue);
  if (!target) return;
  await rm(target, { force: true }).catch(() => {});
}

/**
 * Round 2200: codegen.ts's generated EntityView.jsx renders a `file`
 * field's existing attachment as a real, clickable <a href={url}>/<img
 * src={url}> (parseFileFieldValue's own round-908 regex requires `url` to
 * already match this exact "/api/uploads/<projectId>/<entityName>/
 * <filename>" shape) -- but the exported app's own generated server.js
 * never served that route, and the /export ZIP never bundled the actual
 * uploaded bytes. A record with a file attached before export rendered
 * what looked like a normal, working link; clicking it 404s against the
 * exported app's own origin, forever, with no warning anywhere (the one
 * UI note next to it only says files "can't be added or changed", never
 * that an EXISTING one won't open). Mirrors backup.ts's own identical
 * round-1203 fix for the data-backup ZIP (reads each file field's current
 * upload via resolveUploadedFilePath, the same validated resolution
 * deleteUploadedFile above uses) -- this one for the code export instead,
 * at ZIP paths ("uploads/<projectId>/<entityName>/<filename>") that match
 * the new static route renderServerJs now generates byte-for-byte, so the
 * already-stored relative URL resolves with no rewriting needed on either
 * side. Best-effort, like every other caller of resolveUploadedFilePath:
 * a value that doesn't resolve to a real upload (already deleted,
 * malformed, or empty) is silently skipped rather than failing the whole
 * export over one missing file.
 */
export function collectUploadedFileZipEntries(db: ForgeDatabase, uploadsDir: string, project: Project): { path: string; content: Buffer }[] {
  const entries: { path: string; content: Buffer }[] = [];
  for (const entity of project.spec.entities) {
    const fileFields = entity.fields.filter((f) => f.type === "file");
    if (fileFields.length === 0) continue;
    const records = listRecords(db, project.id, entity);
    for (const record of records) {
      for (const field of fileFields) {
        const target = resolveUploadedFilePath(uploadsDir, project.id, entity.name, record[field.name]);
        if (!target) continue;
        let content: Buffer;
        try {
          content = readFileSync(target);
        } catch {
          continue;
        }
        // Round 2203: resolveUploadedFilePath's own round-1270 sibling
        // fallback (triggered by a case-only entity rename, a documented
        // no-op at the db layer per migrate.ts -- the upload directory and
        // the record's own stored `url` keep whatever casing was true at
        // upload time forever) can return a path whose own directory
        // segment is a DIFFERENT case than entity.name's CURRENT casing.
        // Re-substituting entity.name here (as this used to do) wrote the
        // real bytes into the ZIP under the wrong-cased path -- one that
        // doesn't match the record's own stored `url`
        // (routes/projects.ts's upload route writes that once, at upload
        // time, under the OLD casing, and never rewrites it on a later
        // rename) that EntityView.jsx's <a href>/<img src> actually
        // renders. Taking the directory segment from `target` itself
        // (the real, possibly-old-cased directory resolveUploadedFilePath
        // actually found) keeps this ZIP path and the stored `url` in
        // exact agreement, so the generated server's own case-sensitive
        // express.static route (Linux/Render, this project's own
        // deployment target) actually serves it -- reopening exactly the
        // dead-link failure round 2200 fixed, just for any project that
        // combines a case-only entity rename with an uploaded file.
        const actualEntityDir = path.basename(path.dirname(target));
        entries.push({ path: `uploads/${project.id}/${actualEntityDir}/${path.basename(target)}`, content });
      }
    }
  }
  return entries;
}
