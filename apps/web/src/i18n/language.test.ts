import assert from "node:assert/strict";
import { test } from "node:test";
import { detectInitialLang, dirFor, translate, translations } from "./language.js";

test("detectInitialLang trusts a valid stored value", () => {
  assert.equal(detectInitialLang("en"), "en");
  assert.equal(detectInitialLang("he"), "he");
});

test("detectInitialLang defaults to Hebrew for a corrupted stored value even with no browser info, never throws", () => {
  assert.equal(detectInitialLang(null), "he");
  assert.equal(detectInitialLang("fr"), "he");
  assert.equal(detectInitialLang(""), "he");
});

test("detectInitialLang picks Hebrew for a Hebrew browser locale when nothing is stored", () => {
  assert.equal(detectInitialLang(null, "he"), "he");
  assert.equal(detectInitialLang(null, "he-IL"), "he");
  assert.equal(detectInitialLang(null, "HE-il"), "he");
});

test("detectInitialLang picks English for any non-Hebrew browser locale when nothing is stored", () => {
  assert.equal(detectInitialLang(null, "en-US"), "en");
  assert.equal(detectInitialLang(null, "fr-FR"), "en");
  assert.equal(detectInitialLang(null, "ar"), "en");
});

test("detectInitialLang lets a stored preference override the browser locale", () => {
  assert.equal(detectInitialLang("en", "he-IL"), "en");
  assert.equal(detectInitialLang("he", "en-US"), "he");
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

test("translate fills in {placeholder} params without touching the rest of the string", () => {
  const result = translate("en", "build.subtitle", { current: 2, total: 5 });
  assert.equal(result, "The AI Team is working now, in real time. Step 2 of 5.");
});

test("translate leaves an unmatched {placeholder} alone rather than throwing", () => {
  const result = translate("en", "build.subtitle", { current: 2 });
  assert.match(result, /\{total\}/);
});

test("every Hebrew key has an English counterpart (no untranslated strings)", () => {
  for (const key of Object.keys(translations.he)) {
    assert.ok(key in translations.en, `"${key}" exists in Hebrew but not English`);
  }
});
