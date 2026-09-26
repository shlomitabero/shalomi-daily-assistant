import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

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

function renderPanel(onClose: () => void = () => {}) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(ShortcutsPanel, { onClose })),
    ),
  );
}

test("renders a real dialog listing every actual shortcut, not a placeholder", async () => {
  await withJsdom(async () => {
    renderPanel();
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "expected a real dialog element");
    assert.equal(dialog!.getAttribute("aria-modal"), "true");

    const rows = document.querySelectorAll(".shortcuts-row");
    // Ctrl+K, "/", "?", Escape, j/down, k/up, Enter -- 7 rows.
    assert.equal(rows.length, 7, "expected one row per known shortcut");

    const kbds = Array.from(document.querySelectorAll(".shortcuts-keys kbd")).map((el) => el.textContent);
    assert.ok(kbds.includes("Ctrl"), "expected Ctrl+K to be listed");
    assert.ok(kbds.includes("/"), 'expected "/" to be listed');
    assert.ok(kbds.includes("?"), 'expected "?" (this panel\'s own shortcut) to be listed');
    assert.ok(kbds.includes("Esc"), "expected Escape to be listed");
    assert.ok(kbds.includes("j"), "expected j (row-down) to be listed");
    assert.ok(kbds.includes("k"), "expected k (row-up) to be listed");
    assert.ok(kbds.includes("Enter"), "expected Enter (edit row) to be listed");

    // Each row's description comes from t(row.descriptionKey) -- a dynamic
    // key, not a string literal -- so this also proves that call site
    // actually resolves to real translated text at runtime, not a raw,
    // untranslated key like "shortcuts.search" leaking onto the screen.
    const descriptions = Array.from(rows).map((row) => row.querySelector("span:last-child")?.textContent);
    assert.ok(descriptions.some((d) => /search/i.test(d ?? "")), "expected a real, translated search-shortcut description");
    assert.ok(
      descriptions.every((d) => !d?.startsWith("shortcuts.")),
      "no row should ever render a raw, untranslated key",
    );
  });
});

test("clicking Close calls onClose", async () => {
  await withJsdom(async () => {
    let closed = 0;
    renderPanel(() => {
      closed += 1;
    });
    const buttons = Array.from(document.querySelectorAll("button"));
    const closeButton = buttons.find((b) => b.textContent === "Close");
    assert.ok(closeButton, "expected to find the Close button");
    fireEvent.click(closeButton!);
    assert.equal(closed, 1);
  });
});
