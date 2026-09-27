import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DeleteAccountPanel } from "./DeleteAccountPanel.js";
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

async function waitForCondition(check: () => boolean, maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitForCondition: condition never became true");
}

function renderPanel(opts?: { onClose?: () => void; onDeleted?: () => void }) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(DeleteAccountPanel, {
          email: "dana@example.com",
          onClose: opts?.onClose ?? (() => {}),
          onDeleted: opts?.onDeleted ?? (() => {}),
        }),
      ),
    ),
  );
}

function typeConfirmation(value: string) {
  fireEvent.change(document.querySelector("input[type='text']")!, { target: { value } });
}

test("typing the account's own email exactly and submitting calls the real DELETE /auth/account and fires onDeleted", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let calls: { method?: string }[] = [];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/auth/account") {
        calls.push({ method: init.method });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    let deletedCount = 0;
    try {
      renderPanel({ onDeleted: () => (deletedCount += 1) });
      typeConfirmation("dana@example.com");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => deletedCount === 1);
      assert.equal(calls.length, 1, "the real DELETE /auth/account endpoint must have been called exactly once");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The core guard this whole component exists for: unlike the plain
 * window.confirm used elsewhere in this app, submitting must be a no-op
 * (never touching the network) until the typed text exactly matches the
 * real account email. A blank field, a near-miss, and a case-mismatch (an
 * accidental match a case-sensitive check would reject) all must fail
 * closed with zero requests sent.
 */
test("submitting with a blank, wrong, or non-matching-case confirmation never calls the API", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("deleteAccount must never be called when the confirmation doesn't match");
    }) as typeof fetch;

    try {
      renderPanel();
      fireEvent.submit(document.querySelector("form")!);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, 0, "a blank confirmation must never call the API");

      typeConfirmation("not-the-right-email@example.com");
      fireEvent.submit(document.querySelector("form")!);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls, 0, "a wrong confirmation must never call the API");

      // The button itself must also be disabled while the text doesn't match --
      // not just the form's submit handler silently no-opping.
      const submitButton = Array.from(document.querySelectorAll("button")).find((b) => /delete/i.test(b.textContent ?? ""));
      assert.ok(submitButton, "expected to find the delete-confirm submit button");
      assert.ok((submitButton as HTMLButtonElement).disabled, "the submit button must stay disabled until the email matches exactly");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a server error is shown to the user instead of a silent failure, and onDeleted never fires", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Something went wrong", code: "INTERNAL_ERROR" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    let deletedCount = 0;
    try {
      renderPanel({ onDeleted: () => (deletedCount += 1) });
      typeConfirmation("dana@example.com");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.equal(deletedCount, 0, "onDeleted must never fire when the server rejects the request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking Cancel calls onClose without ever touching the network", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("cancelling must never call the API");
    }) as typeof fetch;

    let closed = 0;
    try {
      renderPanel({ onClose: () => (closed += 1) });
      const buttons = Array.from(document.querySelectorAll("button"));
      const cancelButton = buttons.find((b) => b.textContent === "Cancel");
      assert.ok(cancelButton, "expected to find the Cancel button");
      fireEvent.click(cancelButton!);
      assert.equal(closed, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
