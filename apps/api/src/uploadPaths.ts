import { rm } from "node:fs/promises";
import path from "node:path";

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
 * Deletes one `file`-type field's currently-stored upload from disk,
 * best-effort. Moved here in round 977 (originally routes/projects.ts, round
 * 674/848/849) so pipeline.ts's own migration-cleanup step (round 977) can
 * reuse it too, without routes/projects.ts and pipeline.ts importing from
 * each other in both directions.
 *
 * A `file` field's stored value is otherwise-unvalidated, client-settable
 * JSON (coerceValue's "file" case falls through to its plain `String(raw)`
 * default, same as any other untyped field -- see packages/db/
 * repository.ts) -- so this can never be handed a value and trusted to
 * resolve wherever its own embedded URL points. Only the filename's final
 * path segment is used, and only once it matches UPLOADED_FILENAME exactly
 * (the one shape this server itself ever generates).
 *
 * The project/entity directory segments are NOT inherently safe: entity.name
 * (`EntitySchema`'s own `name` has no character-set restriction) can be
 * anything a project's spec claims, including something path-traversal-
 * shaped -- `isPathInsideDir` below is what actually constrains the
 * resolved target back inside `uploadsDir`.
 */
export async function deleteUploadedFile(uploadsDir: string, projectId: string, entityName: string, rawValue: unknown): Promise<void> {
  if (typeof rawValue !== "string" || rawValue === "") return;
  let url: string;
  try {
    const parsed = JSON.parse(rawValue) as { url?: unknown };
    if (typeof parsed.url !== "string") return;
    url = parsed.url;
  } catch {
    return;
  }
  const filename = url.slice(url.lastIndexOf("/") + 1);
  if (!UPLOADED_FILENAME.test(filename)) return;
  const target = path.join(uploadsDir, projectId, entityName, filename);
  if (!isPathInsideDir(target, uploadsDir)) return;
  await rm(target, { force: true }).catch(() => {});
}
