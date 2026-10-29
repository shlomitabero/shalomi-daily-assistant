import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChangePasswordPanel } from "./ChangePasswordPanel.js";
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

function renderPanel(onClose: () => void = () => {}) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(ChangePasswordPanel, { onClose })),
    ),
  );
}

function fillForm(current: string, next: string, confirm: string) {
  const inputs = document.querySelectorAll("input[type='password']");
  fireEvent.change(inputs[0], { target: { value: current } });
  fireEvent.change(inputs[1], { target: { value: next } });
  fireEvent.change(inputs[2], { target: { value: confirm } });
}

test("submitting matching passwords calls the real changePassword API with the entered values and shows a success message", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let calls: { method?: string; body: string }[] = [];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/auth/password") {
        calls.push({ method: init.method, body: init.body as string });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      fillForm("my-current-password", "my-new-password", "my-new-password");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => calls.length === 1);
      const body = JSON.parse(calls[0].body) as { currentPassword: string; newPassword: string };
      assert.equal(body.currentPassword, "my-current-password");
      assert.equal(body.newPassword, "my-new-password");

      await waitForCondition(() => document.querySelector(".success") !== null);
      const successText = document.querySelector(".success")!.textContent ?? "";
      assert.match(successText, /changed/i);
      // Round 1154: PATCH /auth/password's own real side effect
      // (deleteOtherSessionsForUser, see routes/auth.ts's own doc comment)
      // silently signs out every other session -- the success message must
      // say so, not leave a user who changed their password specifically
      // to kick out a lost device with zero confirmation it actually
      // happened.
      assert.match(successText, /other sessions|other device/i);
      // Round 1158: every other dynamic-text surface in this app uses
      // role="status"/"alert"; this success message had none at all.
      assert.equal(document.querySelector(".success")!.getAttribute("role"), "status");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a mismatched confirmation never calls the API and shows a mismatch error instead", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("changePassword must never be called when the confirmation doesn't match");
    }) as typeof fetch;

    try {
      renderPanel();
      fillForm("my-current-password", "my-new-password", "a-typo-in-the-confirmation");
      fireEvent.submit(document.querySelector("form")!);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(calls, 0, "the API must never be called when new/confirm don't match");
      const errorEl = document.querySelector(".error");
      assert.ok(errorEl, "expected a visible mismatch error");
      assert.match(errorEl!.textContent ?? "", /match/i);
      assert.equal(document.querySelector(".success"), null, "must not show success after a client-side rejection");
      // Round 1158: every other dynamic-text surface in this app uses
      // role="status"/"alert"; this error message had none at all.
      assert.equal(errorEl!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a server error (e.g. wrong current password) is shown to the user instead of a silent failure", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Current password is incorrect", code: "INVALID_CURRENT_PASSWORD" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      renderPanel();
      fillForm("wrong-current-password", "my-new-password", "my-new-password");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.equal(document.querySelector(".success"), null, "must not show success on a server-rejected request");
      // Round 1158: every other dynamic-text surface in this app uses
      // role="status"/"alert"; this error message had none at all.
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1245: this panel is a real dialog (useDialogFocusTrap), whose own
 * Escape handler closes the whole thing unless the event's target sits
 * under data-escape-handled-locally -- none of the three password inputs
 * ever had that marker. The whole component unmounts on close (App.tsx
 * renders it conditionally), so a typed new password isn't just visually
 * cleared, it's destroyed. Passes a REAL onClose spy (not renderPanel's own
 * no-op default) specifically to prove Escape here only clears the draft
 * and never also closes the panel, mirroring the identical test already
 * added for CollaboratorsPanel (round 1062), AutomationsPanel (round 1056),
 * and WhatsAppPanel (round 1061).
 */
test("Escape clears an in-progress password draft instead of closing the dialog, and a second Escape on the now-pristine form closes it normally", async () => {
  await withJsdom(async () => {
    let closeCalls = 0;
    renderPanel(() => {
      closeCalls += 1;
    });
    fillForm("my-current-password", "my-new-password", "my-new-password");
    const inputs = document.querySelectorAll("input[type='password']") as NodeListOf<HTMLInputElement>;

    fireEvent.keyDown(inputs[0], { key: "Escape" });
    assert.equal(inputs[0].value, "", "Escape must clear the current-password field");
    assert.equal(inputs[1].value, "", "Escape must clear the new-password field");
    assert.equal(inputs[2].value, "", "Escape must clear the confirm-password field");
    assert.equal(closeCalls, 0, "Escape clearing an in-progress draft must never also close the whole dialog");
    assert.ok(document.querySelector('[role="dialog"]'), "the dialog itself must still be in the DOM after that Escape");

    // Mirrors the identical round-362/1056/1061/1062 regression: once the
    // form is genuinely pristine (nothing left to clear), Escape must
    // close the dialog normally, not get silently swallowed.
    fireEvent.keyDown(inputs[0], { key: "Escape" });
    assert.equal(closeCalls, 1, "Escape on an already-pristine form must close the dialog normally");
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
