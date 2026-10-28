import "../jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LanguageSwitcher } from "./LanguageSwitcher.js";
import { LanguageProvider } from "./LanguageContext.js";
import { ThemeProvider } from "../theme/ThemeContext.js";

/** Same jsdom-swap technique as the rest of this project's real-DOM tests. */
async function withJsdom<T>(fn: () => Promise<T> | T): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
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

function renderLanguageSwitcher() {
  render(React.createElement(ThemeProvider, null, React.createElement(LanguageProvider, null, React.createElement(LanguageSwitcher, null))));
}

/**
 * Round 1135: a fresh survey found that this toggle-button group (and two
 * siblings elsewhere in the app -- EntityPanel.tsx's table/board/calendar
 * view toggle, BusinessTwinPanel.tsx's dashboard/report toggle, plus
 * codegen.ts's own copy of the EntityPanel one) marked its selected option
 * with nothing but a CSS class (`lang-btn-active`), invisible to a screen
 * reader -- the exact WCAG 4.1.2 gap PasswordInput.tsx's own show/hide
 * toggle already avoids via `aria-pressed`. A screen-reader user had no way
 * to tell which language button was actually selected; both buttons read
 * identically.
 */
test("LanguageSwitcher's buttons report their selected state via aria-pressed, not just a CSS class", async () => {
  await withJsdom(async () => {
    renderLanguageSwitcher();
    const buttons = document.querySelectorAll(".lang-btn") as NodeListOf<HTMLButtonElement>;
    assert.equal(buttons.length, 2, "expected one button for Hebrew and one for English");
    const [heBtn, enBtn] = buttons;

    // jsdom's own navigator.language defaults to "en-US", with no stored
    // choice yet, so LanguageContext's own detectInitialLang resolves to
    // English first.
    assert.equal(enBtn.getAttribute("aria-pressed"), "true", "the currently-selected language button must report aria-pressed=true");
    assert.equal(heBtn.getAttribute("aria-pressed"), "false", "the unselected language button must report aria-pressed=false");

    fireEvent.click(heBtn);
    assert.equal(heBtn.getAttribute("aria-pressed"), "true", "clicking a language button must flip its own aria-pressed to true");
    assert.equal(enBtn.getAttribute("aria-pressed"), "false", "switching languages must flip the previously-selected button's aria-pressed back to false");
  });
});
