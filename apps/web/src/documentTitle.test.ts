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

test("formatDocumentTitle omits the unread prefix entirely when the count is zero or unspecified", () => {
  assert.equal(formatDocumentTitle("My Shop", 0), "My Shop · Forge AI");
  assert.equal(formatDocumentTitle("My Shop"), "My Shop · Forge AI");
});

test("formatDocumentTitle prefixes a real unread WhatsApp count ahead of everything else, Gmail/Slack-style", () => {
  assert.equal(formatDocumentTitle("My Shop", 3), "(3) My Shop · Forge AI");
});

test("formatDocumentTitle's unread prefix still applies with no project open", () => {
  assert.equal(formatDocumentTitle(null, 7), "(7) Forge AI");
});
