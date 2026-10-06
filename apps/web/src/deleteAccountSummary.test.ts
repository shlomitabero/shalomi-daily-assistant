import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDeleteAccountSummary } from "./deleteAccountSummary.js";
import { translate } from "./i18n/language.js";

test("formatDeleteAccountSummary returns null when there is nothing owned or shared -- nothing to warn about", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatDeleteAccountSummary(0, 0, tr), null);
});

test("formatDeleteAccountSummary reports owned-only phrasing when there are no shared projects", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatDeleteAccountSummary(3, 0, tr), "3 projects you own will be permanently deleted, including all of their data.");
});

test("formatDeleteAccountSummary reports shared-only phrasing when there are no owned projects", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatDeleteAccountSummary(0, 2, tr), "Your access to 2 shared projects will be removed.");
});

test("formatDeleteAccountSummary reports both counts distinctly when both exist", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(
    formatDeleteAccountSummary(2, 1, tr),
    "2 projects you own will be permanently deleted (including all of their data), and your access to 1 more shared projects will be removed.",
  );
});

test("formatDeleteAccountSummary in Hebrew", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatDeleteAccountSummary(2, 0, tr), "2 פרויקטים שבבעלותך יימחקו לצמיתות, כולל כל הנתונים שלהם.");
  assert.equal(formatDeleteAccountSummary(0, 1, tr), "הגישה שלך ל-1 פרויקטים ששותפו איתך תוסר.");
});
