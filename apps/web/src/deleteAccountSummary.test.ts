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

test("formatDeleteAccountSummary uses singular phrasing for exactly 1 owned project", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatDeleteAccountSummary(1, 0, tr), "1 project you own will be permanently deleted, including all of its data.");
});

test("formatDeleteAccountSummary reports shared-only phrasing when there are no owned projects", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatDeleteAccountSummary(0, 2, tr), "Your access to 2 shared projects will be removed.");
});

test("formatDeleteAccountSummary uses singular phrasing for exactly 1 shared project", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(formatDeleteAccountSummary(0, 1, tr), "Your access to 1 shared project will be removed.");
});

test("formatDeleteAccountSummary reports both counts distinctly when both exist", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(
    formatDeleteAccountSummary(2, 3, tr),
    "2 projects you own will be permanently deleted (including all of their data), and your access to 3 more shared projects will be removed.",
  );
});

test("formatDeleteAccountSummary uses singular phrasing for owned and shared independently in the combined case", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  assert.equal(
    formatDeleteAccountSummary(1, 1, tr),
    "1 project you own will be permanently deleted (including all of its data), and your access to 1 more shared project will be removed.",
  );
  assert.equal(
    formatDeleteAccountSummary(1, 3, tr),
    "1 project you own will be permanently deleted (including all of its data), and your access to 3 more shared projects will be removed.",
  );
  assert.equal(
    formatDeleteAccountSummary(3, 1, tr),
    "3 projects you own will be permanently deleted (including all of their data), and your access to 1 more shared project will be removed.",
  );
});

test("formatDeleteAccountSummary in Hebrew", () => {
  const tr = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  assert.equal(formatDeleteAccountSummary(2, 0, tr), "2 פרויקטים שבבעלותך יימחקו לצמיתות, כולל כל הנתונים שלהם.");
  assert.equal(formatDeleteAccountSummary(1, 0, tr), "1 פרויקט שבבעלותך יימחק לצמיתות, כולל כל הנתונים שלו.");
  assert.equal(formatDeleteAccountSummary(0, 2, tr), "הגישה שלך ל-2 פרויקטים ששותפו איתך תוסר.");
  assert.equal(formatDeleteAccountSummary(0, 1, tr), "הגישה שלך ל-1 פרויקט ששותף איתך תוסר.");
});
