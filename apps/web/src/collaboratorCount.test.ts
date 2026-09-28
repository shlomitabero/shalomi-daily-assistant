import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCollaboratorCount } from "./collaboratorCount.js";
import { translate } from "./i18n/language.js";

test("formatCollaboratorCount reports the real count in English", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatCollaboratorCount(1, tr), "1 with access");
  assert.equal(formatCollaboratorCount(4, tr), "4 with access");
});

test("formatCollaboratorCount reports the real count in Hebrew", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatCollaboratorCount(1, tr), "1 עם גישה");
  assert.equal(formatCollaboratorCount(3, tr), "3 עם גישה");
});
