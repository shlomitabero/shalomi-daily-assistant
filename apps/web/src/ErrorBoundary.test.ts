import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

/**
 * Same jsdom-swap technique as AuthScreen.test.ts/BuildProgress.test.ts.
 * Passes the real JSDOM instance (not just `window`) into `fn`, since
 * jsdom's own `location.reload` is a non-configurable own property (it
 * can't be swapped out with a spy the way other globals here can) --
 * callers that need to prove `window.location.reload()` genuinely ran use
 * `dom.virtualConsole`'s own "jsdomError" event instead (jsdom emits
 * "Not implemented: navigation to another Document" there every time
 * reload() is actually invoked, since jsdom doesn't implement real page
 * navigation).
 */
async function withJsdom<T>(fn: (dom: JSDOM) => Promise<T> | T): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const replacements: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
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
    return await fn(dom);
  } finally {
    for (const key of Object.keys(replacements)) {
      if (originalDescriptors[key]) {
        Object.defineProperty(globalThis, key, originalDescriptors[key]!);
      } else {
        delete (globalThis as unknown as Record<string, unknown>)[key];
      }
    }
  }
}

function Throws(): never {
  throw new Error("deliberate render-time crash, for this test only");
}

/**
 * Round 1299: ErrorBoundary.tsx is the fix for the exact gap
 * BuildProgress.tsx's own comment names in passing but never closed --
 * no error boundary existed anywhere in apps/web, so any uncaught
 * render-time exception unmounted the whole tree to a blank page. Renders
 * a real component that genuinely throws during render (not a
 * reimplementation of React's own catch mechanism), confirming the real
 * fallback UI appears instead of the tree going blank, and that it offers
 * a real recovery action (a reload button that calls the real
 * window.location.reload).
 */
test("ErrorBoundary renders a recoverable fallback instead of a blank page when a child throws during render", async () => {
  await withJsdom(async (dom) => {
    // React itself also logs the caught error to console.error (its own
    // dev-mode diagnostic, separate from componentDidCatch's own call) --
    // suppressed here so this deliberate, expected crash doesn't look like
    // a real test failure in the suite's own output.
    const originalConsoleError = console.error;
    console.error = () => {};
    let jsdomNavigationAttempted = false;
    dom.virtualConsole.on("jsdomError", (err) => {
      if (/navigation to another Document/.test(err.message)) jsdomNavigationAttempted = true;
    });

    try {
      const { container } = render(
        React.createElement(ErrorBoundary, null, React.createElement(Throws)),
      );

      const banner = container.querySelector('[role="alert"]');
      assert.ok(banner, "expected the fallback's error banner to render instead of a blank page");
      assert.match(banner!.textContent ?? "", /went wrong|השתבש/);

      const reloadButton = container.querySelector("button");
      assert.ok(reloadButton, "expected a reload button in the fallback");
      fireEvent.click(reloadButton!);
      // jsdom doesn't implement real page navigation, so calling the
      // real window.location.reload() surfaces as this own "not
      // implemented" jsdomError event -- confirming the button's onClick
      // genuinely invoked the real reload(), not a reimplementation.
      assert.equal(jsdomNavigationAttempted, true, "clicking the reload button must call the real window.location.reload");
    } finally {
      console.error = originalConsoleError;
      cleanup();
    }
  });
});

/**
 * Companion: a child that does NOT throw must render completely normally,
 * through the boundary, with no fallback shown at all -- confirms the
 * boundary is transparent in the ordinary, non-crashing case, the vast
 * majority of real renders.
 */
test("ErrorBoundary renders its children normally when nothing throws", async () => {
  await withJsdom(async () => {
    try {
      const { container, getByText } = render(
        React.createElement(ErrorBoundary, null, React.createElement("p", null, "all good")),
      );
      assert.ok(getByText("all good"));
      assert.equal(container.querySelector('[role="alert"]'), null, "the fallback must not render when nothing crashed");
    } finally {
      cleanup();
    }
  });
});
