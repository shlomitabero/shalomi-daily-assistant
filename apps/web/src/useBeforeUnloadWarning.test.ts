import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

/**
 * Same jsdom-swap pattern every other hook/component test file in this
 * project already uses (see useDialogFocusTrap.test.ts's own identical
 * copy) -- there is no shared helper module for it.
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
    const result = fn();
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

function TestComponent({ active }: { active: boolean }) {
  useBeforeUnloadWarning(active);
  return null;
}

/**
 * Round 1331: the far more common way an in-progress form draft gets lost
 * isn't the Escape-key discard this app's data-escape-handled-locally
 * convention already guards against (see useDialogFocusTrap.test.ts) but
 * a tab close, refresh, or navigation away -- this confirms the native
 * "leave site?" prompt actually fires while `active` is true, is silent
 * while it's false, and correctly starts/stops firing as `active` itself
 * changes across a re-render (not just once at mount).
 */
test("useBeforeUnloadWarning prevents a beforeunload only while active is true, and stops the moment it becomes false", async () => {
  await withJsdom(() => {
    const { rerender } = render(React.createElement(TestComponent, { active: false }));

    const eventWhileInactive = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(eventWhileInactive);
    assert.equal(eventWhileInactive.defaultPrevented, false, "must not warn while there is no real unsaved draft");

    rerender(React.createElement(TestComponent, { active: true }));
    const eventWhileActive = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(eventWhileActive);
    assert.equal(eventWhileActive.defaultPrevented, true, "must warn once there is a real unsaved draft");

    rerender(React.createElement(TestComponent, { active: false }));
    const eventAfterSaved = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(eventAfterSaved);
    assert.equal(eventAfterSaved.defaultPrevented, false, "must stop warning the moment the draft is saved/cleared, not keep warning forever once it's ever been true");
  });
});

test("useBeforeUnloadWarning removes its own listener on unmount, so a closed dialog never warns on a later unload", async () => {
  await withJsdom(() => {
    const { unmount } = render(React.createElement(TestComponent, { active: true }));
    unmount();

    const eventAfterUnmount = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(eventAfterUnmount);
    assert.equal(eventAfterUnmount.defaultPrevented, false, "an unmounted dialog's own warning must not linger on the window");
  });
});
