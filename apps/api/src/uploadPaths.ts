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
