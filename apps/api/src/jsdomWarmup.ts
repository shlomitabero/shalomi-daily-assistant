import { JSDOM } from "jsdom";

/**
 * Must be the FIRST import in every real-DOM test file in this package,
 * before importing anything that transitively pulls in react-dom (react,
 * @testing-library/react, a dynamically-imported generated .jsx component)
 * -- side-effect only, nothing to import from it. A plain top-level
 * statement sitting textually between two import lines in the same file
 * does NOT get this ordering for free: ES module semantics resolve and
 * fully evaluate every static import in a file before any of that file's
 * own top-level body code runs, so a warmup written inline (rather than as
 * its own already-imported module) would still run after react-dom's
 * first evaluation, too late to matter. Identical copy of this project's
 * own apps/web/src/jsdomWarmup.ts -- see that file's doc comment for the
 * full isInputEventSupported/activeElement.attachEvent explanation; apps/api
 * has no cross-package import path to reuse it directly.
 */
const warmupDom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node"] as const) {
  Object.defineProperty(globalThis, key, {
    value: (warmupDom.window as unknown as Record<string, unknown>)[key],
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
