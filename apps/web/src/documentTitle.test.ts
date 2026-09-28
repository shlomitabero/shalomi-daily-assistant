import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDocumentTitle } from "./documentTitle.js";

test("formatDocumentTitle falls back to the plain app name when no project is open", () => {
  assert.equal(formatDocumentTitle(null), "Forge AI");
});

test("formatDocumentTitle prefixes the real project name ahead of the app name", () => {
  assert.equal(formatDocumentTitle("ניהול מלאי בחנות"), "ניהול מלאי בחנות · Forge AI");
});

test("formatDocumentTitle works for an English project name too", () => {
  assert.equal(formatDocumentTitle("My Shop"), "My Shop · Forge AI");
});
