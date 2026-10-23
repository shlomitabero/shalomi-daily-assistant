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
