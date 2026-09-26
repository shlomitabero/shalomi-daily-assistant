import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { detectInitialLang, dirFor, resolveErrorMessage, translate, translations } from "./language.js";

/**
 * Walks apps/api/src and extracts every `new HttpError(status, message,
 * "CODE")` call site's code, so the translation-coverage test below checks
 * against the real, current set of codes the API can actually send instead
 * of a hand-maintained list that can silently drift out of sync -- which is
 * exactly how PIPELINE_IN_PROGRESS and ALREADY_BUILT shipped with no
 * translation at all until a real user hit the untranslated fallback.
 */
function findThrownHttpErrorCodes(): Set<string> {
  const apiSrcDir = fileURLToPath(new URL("../../../api/src", import.meta.url));
  const codes = new Set<string>();
  const codePattern = /new HttpError\(\s*\d+\s*,[\s\S]*?"([A-Z_]+)"\s*\)/g;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const contents = readFileSync(fullPath, "utf-8");
        for (const match of contents.matchAll(codePattern)) {
          codes.add(match[1]);
        }
      }
    }
  }
  walk(apiSrcDir);
  return codes;
}

/**
 * Walks the whole apps/web/src UI source tree and extracts every literal
 * `t("some.key")` call (the `t` helper from useTranslation()/LanguageContext),
 * so the coverage test below checks against every translation key a
 * component can actually request at runtime -- not just the `error.*`
 * codes findThrownHttpErrorCodes already covers. A typo'd or renamed key
 * used in a component but missing from one of the dictionaries doesn't
 * throw: `translate()` silently falls back to the raw key string, so a
 * real user would just see literal text like "entity.dupplicate" on
 * screen instead of a translated label, with nothing failing loudly.
 * Only literal string-argument calls are found (a dynamic key built from
 * a variable can't be statically checked); that mirrors the same known
 * limitation as findThrownHttpErrorCodes above.
 */
function findUsedTranslationKeys(): Set<string> {
  const webSrcDir = fileURLToPath(new URL("..", import.meta.url));
  const keys = new Set<string>();
  const keyPattern = /\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
        const contents = readFileSync(fullPath, "utf-8");
        for (const match of contents.matchAll(keyPattern)) {
          keys.add(match[1]);
        }
      }
    }
  }
  walk(webSrcDir);
  return keys;
}

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

test("resolveErrorMessage translates a known server error code into the current language", () => {
  assert.equal(
    resolveErrorMessage("he", { error: "Build the project before refining it", code: "BUILD_REQUIRED" }),
    "צריך לבנות את הפרויקט קודם.",
  );
  assert.equal(
    resolveErrorMessage("en", { error: "Build the project before refining it", code: "BUILD_REQUIRED" }),
    "You need to build the project first.",
  );
});

test("resolveErrorMessage falls back to the raw English error text for an unrecognized code", () => {
  assert.equal(
    resolveErrorMessage("he", { error: "Some brand-new server error", code: "SOME_FUTURE_CODE" }),
    "Some brand-new server error",
  );
});

test("resolveErrorMessage falls back to a generic message when there's no code and no error text at all", () => {
  assert.equal(resolveErrorMessage("he", {}), "Request failed");
});

test("NETWORK_ERROR (synthesized client-side when a network request is genuinely unreachable, see wakeRetry.ts) has both translations", () => {
  assert.ok("error.NETWORK_ERROR" in translations.he);
  assert.ok("error.NETWORK_ERROR" in translations.en);
});

test("REQUEST_FAILED (synthesized client-side in api.ts when a real HTTP error response's body isn't valid JSON, so the server's own code/error never arrives) has both translations", () => {
  assert.ok("error.REQUEST_FAILED" in translations.he);
  assert.ok("error.REQUEST_FAILED" in translations.en);
});

test("every HttpError code the API can send has a Hebrew and an English translation", () => {
  // Scans the real apps/api/src source (see findThrownHttpErrorCodes above)
  // instead of checking against a hand-maintained list -- a hardcoded list
  // already silently missed ALREADY_BUILT, PIPELINE_IN_PROGRESS, and
  // WHATSAPP_NOT_CONNECTED, which is exactly the failure mode this test
  // exists to catch: a new HttpError call site with no matching dictionary
  // entry falls back to a raw, untranslated English message for a
  // Hebrew-speaking user instead of failing this test loudly.
  const thrownCodes = findThrownHttpErrorCodes();
  assert.ok(thrownCodes.size > 10, `expected to find many HttpError codes in apps/api/src, only found ${thrownCodes.size} -- the source scan itself may be broken`);
  for (const code of thrownCodes) {
    const key = `error.${code}`;
    assert.ok(key in translations.he, `missing Hebrew translation for ${key}`);
    assert.ok(key in translations.en, `missing English translation for ${key}`);
  }
});

test("findThrownHttpErrorCodes actually finds the known, real HttpError codes (sanity check on the scan itself)", () => {
  const thrownCodes = findThrownHttpErrorCodes();
  for (const code of ["VALIDATION_ERROR", "PROJECT_NOT_FOUND", "PIPELINE_IN_PROGRESS", "ALREADY_BUILT", "WHATSAPP_NOT_CONNECTED"]) {
    assert.ok(thrownCodes.has(code), `scan should have found "${code}" being thrown somewhere in apps/api/src`);
  }
});

test("every translation key a UI component actually requests via t(...) exists in both Hebrew and English", () => {
  // Scans the real apps/web/src component source (see findUsedTranslationKeys
  // above) instead of just checking the two dictionaries against each other:
  // a key can be present in both `he` and `en` and still not be the key a
  // component actually calls, or a component can call a key that's in
  // neither -- neither case is caught by the he/en symmetry tests above.
  const usedKeys = findUsedTranslationKeys();
  assert.ok(usedKeys.size > 100, `expected to find many t(...) calls across apps/web/src, only found ${usedKeys.size} -- the source scan itself may be broken`);
  for (const key of usedKeys) {
    assert.ok(key in translations.he, `component calls t("${key}") but translations.he has no such key`);
    assert.ok(key in translations.en, `component calls t("${key}") but translations.en has no such key`);
  }
});

test("findUsedTranslationKeys actually finds known, real t(...) call sites (sanity check on the scan itself)", () => {
  const usedKeys = findUsedTranslationKeys();
  for (const key of ["topbar.logout", "entity.duplicate", "whatsapp.title", "search.title", "lang.he"]) {
    assert.ok(usedKeys.has(key), `scan should have found t("${key}") being called somewhere in apps/web/src`);
  }
});
