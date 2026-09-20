import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

/**
 * Real DOM test infrastructure for this project (previously nonexistent --
 * every prior round's TSX-handler tests extracted plain functions and ran
 * them via new Function, never a real render). Swaps the jsdom window/
 * document onto the global scope for the duration of one test, the same
 * pattern jest-environment-jsdom and vitest's jsdom environment use: React
 * and @testing-library/react only touch `document` lazily inside their own
 * runtime (render/events/cleanup), not at module-import time, so setting
 * these globals right before calling render() is enough for a real DOM
 * render, real focus(), and real keyboard events to all work exactly as
 * they would in a browser.
 */
async function withJsdom<T>(fn: () => T): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  const replacements: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    KeyboardEvent: window.KeyboardEvent,
  };
  // Plain assignment (Object.assign) throws for `navigator`: recent Node
  // versions define a read-only global `navigator` (its own runtime info,
  // unrelated to a browser's) via a getter-only property descriptor, not a
  // writable data property. defineProperty overwrites the descriptor itself
  // rather than trying to set through it, so it works for every property
  // uniformly, Node-provided or not.
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
    const result = fn();
    // React's own event system schedules a re-throw of any error caught
    // during a dispatched DOM event on the next macrotask (so a bug inside
    // an event handler doesn't get silently absorbed by whatever synchronous
    // try/catch invoked the dispatch) -- letting a full tick pass here,
    // before the jsdom globals below are torn down, is what actually
    // surfaces that error against a live `window`/`document` instead of a
    // bare "window is not defined" ReferenceError chasing this function
    // after it already returned and restored the originals.
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

function TestDialog() {
  const containerRef = useDialogFocusTrap<HTMLDivElement>();
  return React.createElement(
    "div",
    { ref: containerRef, tabIndex: -1 },
    React.createElement("button", { id: "first" }, "First"),
    React.createElement("button", { id: "second" }, "Second"),
    React.createElement("button", { id: "last" }, "Last"),
  );
}

test("useDialogFocusTrap moves focus into the dialog when it mounts, keeps Tab cycling within it, and restores focus on unmount", async () => {
  await withJsdom(() => {
    const trigger = document.createElement("button");
    trigger.id = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    assert.equal(document.activeElement, trigger, "sanity check: the trigger must actually be focused before the dialog opens");

    const { unmount } = render(React.createElement(TestDialog));

    const first = document.getElementById("first")!;
    const last = document.getElementById("last")!;
    assert.equal(document.activeElement, first, "focus must move into the dialog's first focusable element on mount");

    // Tab on the last element must wrap around to the first, not leak out
    // to whatever's behind the (visually hidden but still focusable) dialog.
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    assert.equal(document.activeElement, first, "Tab on the last element must wrap around to the first");

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    assert.equal(document.activeElement, last, "Shift+Tab on the first element must wrap around to the last");

    unmount();
    assert.equal(document.activeElement, trigger, "closing the dialog must return focus to whatever triggered it");
  });
});
