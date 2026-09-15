import assert from "node:assert/strict";
import { test } from "node:test";
import { detectInitialLang, dirFor, translate, translations } from "./language.js";

test("detectInitialLang trusts a valid stored value", () => {
  assert.equal(detectInitialLang("en"), "en");
  assert.equal(detectInitialLang("he"), "he");
});

test("detectInitialLang defaults to Hebrew for null or a corrupted value, never throws", () => {
  assert.equal(detectInitialLang(null), "he");
  assert.equal(detectInitialLang("fr"), "he");
  assert.equal(detectInitialLang(""), "he");
});

test("dirFor maps each language to the correct writing direction", () => {
  assert.equal(dirFor("he"), "rtl");
  assert.equal(dirFor("en"), "ltr");
});

test("translate returns the right string for a known key in each language", () => {
  assert.equal(translate("he", "topbar.logout"), "יציאה");
  assert.equal(translate("en", "topbar.logout"), "Log out");
});

test("translate falls back to Hebrew, then to the raw key, instead of throwing on a missing key", () => {
  // Every English key must also exist in Hebrew, or the fallback chain breaks silently.
  for (const key of Object.keys(translations.en)) {
    assert.ok(key in translations.he, `"${key}" exists in English but not Hebrew`);
  }
  assert.equal(translate("en", "this.key.does.not.exist"), "this.key.does.not.exist");
});

test("every Hebrew key has an English counterpart (no untranslated strings)", () => {
  for (const key of Object.keys(translations.he)) {
    assert.ok(key in translations.en, `"${key}" exists in Hebrew but not English`);
  }
});
