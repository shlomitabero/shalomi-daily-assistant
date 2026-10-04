import "../jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LanguageProvider, useTranslation } from "./LanguageContext.js";
import { STORAGE_KEY } from "./language.js";

/** Same jsdom-swap technique as this project's other real-DOM tests. */
async function withJsdom<T>(fn: () => Promise<T> | T, navigatorLanguage = "en-US"): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  Object.defineProperty(window.navigator, "language", { value: navigatorLanguage, configurable: true });
  const replacements: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    localStorage: window.localStorage,
  };
  const originalDescriptors: Record<string, PropertyDescriptor | undefined> = {};
  for (const key of Object.keys(replacements)) {
    originalDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value: replacements[key],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  try {
    const result = await fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return result;
  } finally {
    cleanup();
    for (const key of Object.keys(replacements)) {
      const original = originalDescriptors[key];
      if (original) Object.defineProperty(globalThis, key, original);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

function TestConsumer() {
  const { lang, setLang } = useTranslation();
  return React.createElement(
    "div",
    null,
    React.createElement("span", { "data-testid": "lang-value" }, lang),
    React.createElement("button", { onClick: () => setLang("he") }, "he"),
    React.createElement("button", { onClick: () => setLang("en") }, "en"),
  );
}

/**
 * Regression test for the same gap round 290 already found and fixed in the
 * sibling ThemeContext.tsx: language.ts's own JSDoc contract is "an explicit
 * stored choice always wins; otherwise falls back to the browser locale" --
 * but the old LanguageProvider wrote every lang, including one it had only
 * just derived from navigator.language, to localStorage on mount. That
 * silently turned "no explicit choice yet" into "an explicit choice" on a
 * person's very first visit, so a different person on a shared browser
 * profile (or the same person after a real OS/browser-language change)
 * could never be auto-detected again on that device.
 */
test("LanguageProvider does not silently persist a browser-derived (non-explicit) language", async () => {
  await withJsdom(async () => {
    render(React.createElement(LanguageProvider, null, React.createElement(TestConsumer)));

    assert.equal(document.querySelector('[data-testid="lang-value"]')!.textContent, "en", "starts en: no stored choice, browser locale is en-US");
    assert.equal(localStorage.getItem(STORAGE_KEY), null, "must not silently persist a browser-derived (non-explicit) language");
  }, "en-US");
});

/**
 * Companion: once a person has an explicit stored choice (from a prior
 * visit's LanguageSwitcher click), it must win over whatever the browser's
 * own locale is -- language.ts's own contract says the explicit choice
 * always wins, and it must stay that way even though the browser here would
 * otherwise auto-detect Hebrew.
 */
test("LanguageProvider's stored explicit choice wins over the browser locale", async () => {
  await withJsdom(async () => {
    localStorage.setItem(STORAGE_KEY, "en");
    render(React.createElement(LanguageProvider, null, React.createElement(TestConsumer)));

    assert.equal(
      document.querySelector('[data-testid="lang-value"]')!.textContent,
      "en",
      "the stored explicit choice must win over the browser's Hebrew locale",
    );
  }, "he-IL");
});

/**
 * Companion: setLang (the real LanguageSwitcher action) must still persist
 * normally -- the fix must only block the *auto-detected* mount value from
 * being written, not a real, explicit user choice made afterward.
 */
test("LanguageProvider persists a real setLang choice immediately", async () => {
  await withJsdom(async () => {
    render(React.createElement(LanguageProvider, null, React.createElement(TestConsumer)));
    assert.equal(localStorage.getItem(STORAGE_KEY), null, "sanity check: nothing persisted yet from the auto-detected mount");

    fireEvent.click(document.querySelector("button")!);
    assert.equal(document.querySelector('[data-testid="lang-value"]')!.textContent, "he", "clicking must switch the language immediately");
    assert.equal(localStorage.getItem(STORAGE_KEY), "he", "an explicit setLang call must persist immediately");
  }, "en-US");
});
