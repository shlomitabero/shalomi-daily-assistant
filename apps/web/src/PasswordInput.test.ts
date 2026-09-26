import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PasswordInput } from "./PasswordInput.js";
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

function renderPasswordInput(value: string, onChange: (v: string) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(PasswordInput, { value, onChange, required: true })),
    ),
  );
}

/**
 * New in this round: every password field in the app (signup/login, and
 * all three fields on the change-password form) was plain
 * type="password" with no way to check what you'd actually typed. This
 * shared component is the fix -- confirms the default hidden state, that
 * the toggle button genuinely flips the real input's own type attribute
 * (not just some cosmetic icon change), and that it flips back.
 */
test("PasswordInput starts hidden (type=password) and the toggle button reveals/re-hides the real input type", async () => {
  await withJsdom(async () => {
    let value = "";
    renderPasswordInput(value, (v) => (value = v));

    const input = document.querySelector("input") as HTMLInputElement;
    const toggle = document.querySelector(".password-toggle") as HTMLButtonElement;
    assert.ok(input && toggle, "expected both the real input and the toggle button to render");
    assert.equal(input.type, "password", "must start hidden");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");

    fireEvent.click(toggle);
    assert.equal(input.type, "text", "clicking the toggle must reveal the real typed password, not just change an icon");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");

    fireEvent.click(toggle);
    assert.equal(input.type, "password", "clicking again must re-hide it");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
  });
});

test("PasswordInput's aria-label reflects the current hidden/visible state, for screen-reader users", async () => {
  await withJsdom(async () => {
    renderPasswordInput("", () => {});
    const toggle = document.querySelector(".password-toggle") as HTMLButtonElement;

    assert.match(toggle.getAttribute("aria-label") ?? "", /show/i, "hidden state must announce 'show password'");
    fireEvent.click(toggle);
    assert.match(toggle.getAttribute("aria-label") ?? "", /hide/i, "visible state must announce 'hide password'");
  });
});

test("PasswordInput still forwards every real keystroke to onChange regardless of visibility, and toggling never clears the typed value", async () => {
  await withJsdom(async () => {
    // A real, stateful wrapper (mirroring how AuthScreen/ChangePasswordPanel
    // actually use this component with useState) -- a plain mutable closure
    // variable wouldn't feed the typed value back into the controlled
    // input's own `value` prop on the next render, which would make this
    // test pass even if a real regression broke the actual onChange wiring.
    function Harness() {
      const [value, setValue] = useState("");
      return React.createElement(PasswordInput, { value, onChange: setValue, required: true });
    }
    render(React.createElement(ThemeProvider, null, React.createElement(LanguageProvider, null, React.createElement(Harness))));

    const input = document.querySelector("input") as HTMLInputElement;
    const toggle = document.querySelector(".password-toggle") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "hunter2" } });
    assert.equal(input.value, "hunter2", "typing while hidden must still update the real, controlled input value");

    fireEvent.click(toggle);
    assert.equal(input.value, "hunter2", "revealing the password must show the same real value just typed, not clear it");
  });
});

test("PasswordInput's toggle button is type=button, so pressing it inside a form never submits it", async () => {
  await withJsdom(async () => {
    renderPasswordInput("", () => {});
    const toggle = document.querySelector(".password-toggle") as HTMLButtonElement;
    assert.equal(toggle.type, "button", "the toggle must never act as a submit button");
  });
});
