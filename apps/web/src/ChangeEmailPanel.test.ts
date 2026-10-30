import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { User } from "@forge/shared";
import { ChangeEmailPanel } from "./ChangeEmailPanel.js";
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

function renderPanel(currentEmail = "dana@example.com", onClose: () => void = () => {}, onChanged: (user: User) => void = () => {}) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(ChangeEmailPanel, { currentEmail, onClose, onChanged })),
    ),
  );
}

function fillForm(newEmail: string, confirmEmail: string, currentPassword: string) {
  const emailInputs = document.querySelectorAll("input[type='email']");
  fireEvent.change(emailInputs[0], { target: { value: newEmail } });
  fireEvent.change(emailInputs[1], { target: { value: confirmEmail } });
  fireEvent.change(document.querySelector("input[type='password']")!, { target: { value: currentPassword } });
}

test("submitting a matching new email and confirmation calls the real changeEmail API, shows a success message, and reports the updated user via onChanged", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const calls: { body: string }[] = [];
    const updatedUser: User = { id: "u1", email: "dana.new@example.com", createdAt: "2024-01-01T00:00:00.000Z" };
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/auth/email") {
        calls.push({ body: init.body as string });
        return new Response(JSON.stringify({ user: updatedUser }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    let reportedUser: User | undefined;
    try {
      renderPanel("dana@example.com", () => {}, (user) => {
        reportedUser = user;
      });
      fillForm("dana.new@example.com", "dana.new@example.com", "my-current-password");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => calls.length === 1);
      const body = JSON.parse(calls[0].body) as { currentPassword: string; email: string };
      assert.equal(body.currentPassword, "my-current-password");
      assert.equal(body.email, "dana.new@example.com");

      await waitForCondition(() => document.querySelector(".success") !== null);
      assert.match(document.querySelector(".success")!.textContent ?? "", /changed/i);
      assert.equal(document.querySelector(".success")!.getAttribute("role"), "status");
      assert.deepEqual(reportedUser, updatedUser, "onChanged must report the real updated user back from the API response");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1331: the far more common way this exact draft gets lost isn't
 * Escape (round 1245's own test) but a tab close/refresh/navigation away.
 * Also confirms the one subtlety this panel needs that ChangePasswordPanel's
 * identical fix shares: the typed fields are deliberately left filled after
 * a successful change (the success message replaces the form, but nothing
 * resets `email`/`confirmEmail`/`currentPassword`) -- without excluding
 * `done`, the warning would keep firing forever after a completed, already-
 * saved change, which is exactly the false positive this test guards
 * against.
 */
test("warns before a tab close/refresh while an email-change draft is in progress, but not once the change has actually succeeded", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ user: { id: "u1", email: "dana.new@example.com", createdAt: "2024-01-01T00:00:00.000Z" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      renderPanel();
      fillForm("dana.new@example.com", "dana.new@example.com", "my-current-password");

      const eventWhileDirty = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(eventWhileDirty);
      assert.equal(eventWhileDirty.defaultPrevented, true, "must warn while an email-change draft is in progress");

      fireEvent.submit(document.querySelector("form")!);
      await waitForCondition(() => document.querySelector(".success") !== null);

      const eventAfterSuccess = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(eventAfterSuccess);
      assert.equal(
        eventAfterSuccess.defaultPrevented,
        false,
        "must not warn once the change has actually succeeded, even though the typed fields are still technically non-empty",
      );
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
      throw new Error("changeEmail must never be called when the confirmation doesn't match");
    }) as typeof fetch;

    try {
      renderPanel();
      fillForm("dana.new@example.com", "a-typo@example.com", "my-current-password");
      fireEvent.submit(document.querySelector("form")!);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(calls, 0, "the API must never be called when the new email and confirmation don't match");
      const errorEl = document.querySelector(".error");
      assert.ok(errorEl, "expected a visible mismatch error");
      assert.match(errorEl!.textContent ?? "", /match/i);
      assert.equal(document.querySelector(".success"), null, "must not show success after a client-side rejection");
      assert.equal(errorEl!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1205: the mismatch check used to be a raw, exact-case, untrimmed
 * `===` -- the server's own ChangeEmailSchema normalizes with
 * .toLowerCase() before ever comparing or storing it (the same convention
 * CollaboratorsPanel's own email comparison already follows), so a user
 * typing the same address with different casing or a trailing space
 * (plausible via autofill/paste in one field but manual typing in the
 * other) got a false "don't match" error for two fields the server would
 * have accepted as identical. Confirms the real call still succeeds, and
 * that the actual value sent to the server is trimmed too.
 */
test("a new email differing from its confirmation only by letter case or surrounding whitespace is still accepted as a match", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const calls: { body: string }[] = [];
    const updatedUser: User = { id: "u1", email: "dana.new@example.com", createdAt: "2024-01-01T00:00:00.000Z" };
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/auth/email") {
        calls.push({ body: init.body as string });
        return new Response(JSON.stringify({ user: updatedUser }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      fillForm("Dana.New@Example.com ", " dana.new@example.com", "my-current-password");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => calls.length === 1);
      const body = JSON.parse(calls[0].body) as { email: string };
      assert.equal(body.email, "Dana.New@Example.com", "the submitted value must be trimmed, but not forcibly lowercased -- the server does its own normalization");

      await waitForCondition(() => document.querySelector(".success") !== null);
      assert.equal(document.querySelector(".error"), null, "a same-email-different-case/whitespace pair must never be treated as a mismatch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a server error (e.g. wrong current password, or email already taken) is shown to the user instead of a silent failure", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Current password is incorrect", code: "INVALID_CURRENT_PASSWORD" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      renderPanel();
      fillForm("dana.new@example.com", "dana.new@example.com", "wrong-current-password");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.equal(document.querySelector(".success"), null, "must not show success on a server-rejected request");
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the new-email field starts pre-filled with the account's current email, not blank", async () => {
  await withJsdom(async () => {
    renderPanel("dana@example.com");
    const emailInputs = document.querySelectorAll("input[type='email']") as NodeListOf<HTMLInputElement>;
    assert.equal(emailInputs[0].value, "dana@example.com");
  });
});

/**
 * Round 1245: this panel is a real dialog (useDialogFocusTrap), whose own
 * Escape handler closes the whole thing unless the event's target sits
 * under data-escape-handled-locally -- none of the three inputs ever had
 * that marker, despite this form holding a typed new login email (twice)
 * plus the current password. The whole component unmounts on close
 * (App.tsx renders it conditionally), so the draft isn't just visually
 * cleared, it's destroyed. Passes a REAL onClose spy (not renderPanel's own
 * no-op default) specifically to prove Escape here only resets the draft
 * back to the account's current email and never also closes the panel,
 * mirroring the identical test already added for CollaboratorsPanel (round
 * 1062), AutomationsPanel (round 1056), and WhatsAppPanel (round 1061).
 */
test("Escape resets an in-progress email-change draft back to the current email instead of closing the dialog, and a second Escape on the now-pristine form closes it normally", async () => {
  await withJsdom(async () => {
    let closeCalls = 0;
    renderPanel("dana@example.com", () => {
      closeCalls += 1;
    });
    fillForm("dana.new@example.com", "dana.new@example.com", "my-current-password");
    const emailInputs = document.querySelectorAll("input[type='email']") as NodeListOf<HTMLInputElement>;
    const passwordInput = document.querySelector("input[type='password']") as HTMLInputElement;

    fireEvent.keyDown(emailInputs[0], { key: "Escape" });
    assert.equal(emailInputs[0].value, "dana@example.com", "Escape must reset the new-email field back to the current email");
    assert.equal(emailInputs[1].value, "dana@example.com", "Escape must reset the confirm-email field back to the current email");
    assert.equal(passwordInput.value, "", "Escape must clear the current-password field");
    assert.equal(closeCalls, 0, "Escape clearing an in-progress draft must never also close the whole dialog");
    assert.ok(document.querySelector('[role="dialog"]'), "the dialog itself must still be in the DOM after that Escape");

    // Mirrors the identical round-362/1056/1061/1062 regression: once the
    // form is genuinely pristine (nothing left to clear), Escape must
    // close the dialog normally, not get silently swallowed.
    fireEvent.keyDown(emailInputs[0], { key: "Escape" });
    assert.equal(closeCalls, 1, "Escape on an already-pristine form must close the dialog normally");
  });
});

test("clicking Close calls onClose", async () => {
  await withJsdom(async () => {
    let closed = 0;
    renderPanel("dana@example.com", () => {
      closed += 1;
    });
    const buttons = Array.from(document.querySelectorAll("button"));
    const closeButton = buttons.find((b) => b.textContent === "Close");
    assert.ok(closeButton, "expected to find the Close button");
    fireEvent.click(closeButton!);
    assert.equal(closed, 1);
  });
});
