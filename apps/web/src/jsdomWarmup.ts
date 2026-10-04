import { JSDOM } from "jsdom";

/**
 * Must be the FIRST import in every real-DOM test file, before importing
 * anything that transitively pulls in react-dom (the component under test,
 * @testing-library/react, etc.) -- side-effect only, nothing to import from
 * it.
 *
 * react-dom computes two module-top-level `var`s exactly once, the instant
 * the module is first evaluated: `canUseDOM` (`typeof window !== 'undefined'
 * && ...`) and, derived from it, `isInputEventSupported`
 * (react-dom/cjs/react-dom.development.js, "SECTION: handle `input` event").
 * Neither is ever recomputed afterward. This project's own jsdom test files
 * install a fresh JSDOM window/document via Object.defineProperty from
 * *inside* an async test callback (see withJsdom() in e.g.
 * BuildProgress.test.ts) -- which necessarily runs *after* the test file's
 * static imports (and therefore react-dom's module evaluation) already
 * happened against plain Node.js, where `window` doesn't exist yet. That
 * permanently caches `isInputEventSupported = false` for the rest of the
 * process, which makes react-dom fall back, for every controlled text
 * <input>/<textarea> in every test afterward, to its ancient IE-era
 * "input event polyfill" path (`handleEventsForInputEventPolyfill` /
 * `startWatchingForValueChange`) -- which calls `activeElement.attachEvent`,
 * an IE-only API jsdom has never implemented, throwing
 * "activeElement.attachEvent is not a function" the moment anything tries
 * to type into such a field, or -- if the crash happens to land somewhere
 * swallowed -- just silently never firing onChange at all (confirmed
 * empirically both ways while writing EntityPanel.test.ts's search-box
 * tests, the first tests in this project to actually depend on a typed
 * value reaching React state rather than just reading back the DOM node's
 * own `.value`).
 *
 * The fix: get a real `window`/`document` into `globalThis` before react-dom
 * is ever imported, so its one-time `canUseDOM`/`isInputEventSupported`
 * checks see a genuine DOM and cache `true`. This window is deliberately
 * NOT the one used to actually render each test -- `withJsdom()` in each
 * test file still installs its own fresh, isolated window per test, for the
 * usual per-test cleanup reasons -- this one only needs to exist for the
 * split second react-dom's module-level code runs.
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
