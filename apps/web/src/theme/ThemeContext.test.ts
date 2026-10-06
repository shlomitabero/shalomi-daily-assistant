import "../jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ThemeProvider, useTheme } from "./ThemeContext.js";
import { THEME_STORAGE_KEY } from "./theme.js";

/** Same jsdom-swap technique as the rest of this project's real-DOM tests. */
async function withJsdom<T>(fn: (fakeMatchMedia: FakeMatchMedia) => Promise<T> | T): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const fakeMatchMedia = createFakeMatchMedia(false);
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
  // jsdom itself doesn't implement matchMedia at all (window.matchMedia is
  // undefined) -- this project's other real-DOM tests never needed it since
  // ThemeContext's own guard (`!window.matchMedia`) already made that safe.
  // This is the first test file that needs a real, event-dispatching one.
  (window as unknown as { matchMedia: typeof fakeMatchMedia.matchMedia }).matchMedia = fakeMatchMedia.matchMedia;
  try {
    const result = await fn(fakeMatchMedia);
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

interface FakeMatchMedia {
  matchMedia: (query: string) => MediaQueryList;
  fireSystemChange: (matchesDark: boolean) => void;
}

/** A minimal, event-dispatching stand-in for the browser's real matchMedia. */
function createFakeMatchMedia(initialMatchesDark: boolean): FakeMatchMedia {
  let matches = initialMatchesDark;
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
    removeEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as MediaQueryList;
  return {
    matchMedia: () => mql,
    fireSystemChange: (matchesDark: boolean) => {
      matches = matchesDark;
      for (const cb of listeners.slice()) cb({ matches: matchesDark });
    },
  };
}

function TestConsumer() {
  const { theme, toggleTheme } = useTheme();
  return React.createElement(
    "div",
    null,
    React.createElement("span", { "data-testid": "theme-value" }, theme),
    React.createElement("button", { onClick: toggleTheme }, "toggle"),
  );
}

/**
 * Regression test for a real gap flagged by round 290's Explore survey and
 * confirmed by reading theme.ts's own JSDoc contract ("an explicit stored
 * choice always wins; otherwise falls back to the system preference"): the
 * old ThemeProvider wrote every theme -- including one it had only just
 * derived from the system, never chosen by the person -- to localStorage on
 * mount. That silently turned "no explicit choice yet" into "an explicit
 * choice" on a person's very first visit, so neither a live system
 * light/dark switch nor a fresh reload could ever follow the system again on
 * that device. Confirms the fixed provider actually follows a live
 * `prefers-color-scheme` change when nobody has picked a theme yet.
 */
test("ThemeProvider follows a live system preference change when the user has never made an explicit choice", async () => {
  await withJsdom(async (fakeMatchMedia) => {
    render(React.createElement(ThemeProvider, null, React.createElement(TestConsumer)));

    assert.equal(document.documentElement.getAttribute("data-theme"), "light", "starts light: no stored choice, system starts light");
    assert.equal(localStorage.getItem(THEME_STORAGE_KEY), null, "must not silently persist a system-derived (non-explicit) theme");

    act(() => fakeMatchMedia.fireSystemChange(true));
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark", "must follow the system switching to dark");

    act(() => fakeMatchMedia.fireSystemChange(false));
    assert.equal(document.documentElement.getAttribute("data-theme"), "light", "must follow the system switching back to light");
  });
});

/**
 * Companion regression test: once a person has an explicit stored choice
 * (from a prior visit's toggle), a later system-level light/dark switch must
 * never silently override it -- theme.ts's own contract says the explicit
 * choice always wins.
 */
test("ThemeProvider ignores a system preference change once an explicit choice is already stored", async () => {
  await withJsdom(async (fakeMatchMedia) => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(React.createElement(ThemeProvider, null, React.createElement(TestConsumer)));

    assert.equal(document.documentElement.getAttribute("data-theme"), "light", "the stored explicit choice must win over the system's initial state");

    act(() => fakeMatchMedia.fireSystemChange(true));
    assert.equal(
      document.documentElement.getAttribute("data-theme"),
      "light",
      "an explicit stored choice must never be overridden by a later system preference change",
    );
  });
});

/**
 * Companion regression test for the other way an explicit choice can arise
 * mid-session (toggleTheme, not a value already in storage from a prior
 * visit): the system-preference listener is attached once at mount, so it
 * must re-check whether an explicit choice exists at the time each system
 * event fires, not only at listener-setup time.
 */
test("ThemeProvider ignores a system preference change after the user explicitly toggles mid-session", async () => {
  await withJsdom(async (fakeMatchMedia) => {
    render(React.createElement(ThemeProvider, null, React.createElement(TestConsumer)));
    assert.equal(document.documentElement.getAttribute("data-theme"), "light");

    const toggleButton = document.querySelector("button")!;
    fireEvent.click(toggleButton);
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark", "toggling must switch the theme immediately");
    assert.equal(localStorage.getItem(THEME_STORAGE_KEY), "dark", "toggling must persist the explicit choice");

    act(() => fakeMatchMedia.fireSystemChange(false));
    assert.equal(
      document.documentElement.getAttribute("data-theme"),
      "dark",
      "a system change after an explicit mid-session toggle must not revert it",
    );
  });
});
