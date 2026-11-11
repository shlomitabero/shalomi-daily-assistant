import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const indexHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html");

/**
 * Round 1943: a live Playwright pass noticed one unexplained "Failed to
 * load resource: 404" console error on every single fresh page load --
 * confirmed by reading index.html directly: it declared no favicon at
 * all, so every browser fell back to its own automatic /favicon.ico
 * request, which this app never serves. A harmless but real, universal
 * 404 on every page load. Reads the real file from disk (not a copy),
 * so this fails against the actual unfixed markup, not a stale fixture.
 */
test("index.html declares a favicon, so browsers don't fall back to an unserved automatic /favicon.ico request", () => {
  const html = readFileSync(indexHtmlPath, "utf8");
  assert.match(html, /<link\s+rel="icon"[^>]*href="data:image\/svg\+xml[^"]+"/, "expected an inline SVG favicon <link> in the document head");
});
