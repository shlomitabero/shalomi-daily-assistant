import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { AuthScreen } from "./AuthScreen.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

/** Same jsdom-swap technique as useDialogFocusTrap.test.ts. */
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

function renderAuthScreen(onAuthenticated: (user: unknown) => void) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AuthScreen, { onAuthenticated })),
    ),
  );
}

/**
 * Regression test for a real DOM contract that a plain function-extraction
 * test (this project's usual technique for TSX handlers, since it has no
 * real DOM before round 79) cannot actually verify: a *disabled* HTML
 * button genuinely suppresses click events per the HTML spec -- jsdom
 * implements that suppression, a synthetic mock of an onClick handler
 * does not. AuthScreen's own comment explains why this matters:
 * switching forms while a signup/login request is in flight would let
 * that request resolve and silently sign the user in under whichever
 * account they were trying to abandon.
 *
 * The mocked fetch below is deliberately *controllable*, not permanently
 * pending: fetchApi (api.ts) starts a real setTimeout(REQUEST_TIMEOUT_MS)
 * around every request that's only cleared once the request settles, and
 * handleSubmit's own `await signup(...)` only completes once fetch does.
 * A fetch mock that never resolves at all leaves both genuinely dangling
 * past the end of the test -- a real, minutes-long timer that keeps the
 * whole node:test process alive, and an unresolved promise chain
 * node:test itself flags ("Promise resolution is still pending but the
 * event loop has already resolved"). Resolving it explicitly, inside
 * act(), right after the assertions that need it still pending, lets
 * every async chain this test started actually finish before the test
 * itself does.
 */
test("AuthScreen's mode-toggle button is genuinely inert (not just visually disabled) while a submit is in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveFetch!: (value: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => (resolveFetch = resolve))) as typeof fetch;
    try {
      renderAuthScreen(() => {});

      const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
      const [passwordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });
      fireEvent.change(passwordInput, { target: { value: "correct-horse" } });
      fireEvent.change(confirmPasswordInput, { target: { value: "correct-horse" } });

      const initialHeading = document.querySelector("h1")!.textContent;

      const form = document.querySelector("form.auth-form")!;
      fireEvent.submit(form);

      const submitButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
      const toggleButton = document.querySelector("button.link-button") as HTMLButtonElement;
      assert.equal(submitButton.disabled, true, "the submit button must be disabled while the request is in flight");
      assert.equal(toggleButton.disabled, true, "the mode-toggle button must be disabled while the request is in flight");

      // A disabled button's onClick must not fire at all in a real DOM --
      // the mode (and the heading it drives) must stay exactly as it was.
      fireEvent.click(toggleButton);
      assert.equal(
        document.querySelector("h1")!.textContent,
        initialHeading,
        "clicking a disabled toggle button must not switch modes, since the browser suppresses its click event entirely",
      );

      // Let the pending request finish so nothing from this test is still
      // in flight once it returns.
      await act(async () => {
        resolveFetch(new Response(JSON.stringify({ error: "invalid credentials", code: "INVALID_CREDENTIALS" }), { status: 401 }));
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Confirms the typed email/password genuinely reach the signup request
 * body, not just the input's own DOM `.value` -- the distinction that
 * matters ever since jsdomWarmup.ts's own fix: react-dom's one-time
 * `isInputEventSupported` check (see jsdomWarmup.ts's comment for the full
 * root cause) used to get permanently cached `false` in every jsdom test
 * file in this project, silently breaking onChange for every controlled
 * text field -- which this test file's own earlier fireEvent.change calls
 * on email/password never actually caught, because neither existing test
 * here ever reads back anything derived from React state driven by those
 * fields (only the DOM node's own `.value`, and unrelated `busy`-state
 * button-disabled checks). This is the first test in this file to actually
 * verify the typed values flow all the way through handleSubmit into the
 * real request signup() sends.
 */
test("AuthScreen sends the exact typed email/password in the signup request body", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_input: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ user: { id: 1, email: "dana@example.com" }, token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      renderAuthScreen(() => {});

      const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
      const [passwordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });
      fireEvent.change(passwordInput, { target: { value: "correct-horse-battery" } });
      fireEvent.change(confirmPasswordInput, { target: { value: "correct-horse-battery" } });

      const form = document.querySelector("form.auth-form")!;
      await act(async () => {
        fireEvent.submit(form);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof capturedBody, "string", "the signup request must actually have been sent with a body");
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.email, "dana@example.com", "the exact typed email must reach the signup request body, not a stale empty value");
      assert.equal(
        parsed.password,
        "correct-horse-battery",
        "the exact typed password must reach the signup request body, not a stale empty value",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AuthScreen's mode-toggle button works normally (and clears state) before any submit is in flight", async () => {
  await withJsdom(() => {
    renderAuthScreen(() => {});

    const initialHeading = document.querySelector("h1")!.textContent;
    const toggleButton = document.querySelector("button.link-button") as HTMLButtonElement;
    assert.equal(toggleButton.disabled, false, "the toggle button must not be disabled with no request in flight");

    fireEvent.click(toggleButton);

    assert.notEqual(
      document.querySelector("h1")!.textContent,
      initialHeading,
      "clicking the toggle button when idle must actually switch between signup and login",
    );
  });
});

/**
 * There's no "forgot password" flow (yet, see docs/roadmap.md's own open
 * candidates list), so a typo'd password at signup is a permanently
 * locked-out account -- this confirm-password field (mirroring
 * ChangePasswordPanel's own established mismatch check) is the only real
 * defense against that. Confirms the mismatch is actually caught
 * client-side: zero requests reach the network, and the real error
 * message shows.
 */
test("AuthScreen blocks signup entirely when password and confirmPassword don't match, with zero requests sent", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      throw new Error("must never be called");
    }) as typeof fetch;
    try {
      renderAuthScreen(() => {});

      const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
      const [passwordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });
      fireEvent.change(passwordInput, { target: { value: "correct-horse-battery" } });
      fireEvent.change(confirmPasswordInput, { target: { value: "wrong-battery" } });

      const form = document.querySelector("form.auth-form")!;
      await act(async () => {
        fireEvent.submit(form);
        await Promise.resolve();
      });

      assert.equal(requestCount, 0, "a mismatched confirmation must never send a real signup request");
      assert.match(document.querySelector(".error")!.textContent ?? "", /match/i);
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "status", "the error must be announced to screen readers, not just shown visually");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Login mode has no confirm-password field at all -- there's nothing to typo-check against on an existing account, only a real password to authenticate with. */
test("AuthScreen's confirm-password field only appears in signup mode, never in login mode", async () => {
  await withJsdom(() => {
    renderAuthScreen(() => {});
    assert.equal(document.querySelectorAll('input[type="password"]').length, 2, "signup mode must show both password and confirm-password fields");

    const toggleButton = document.querySelector("button.link-button") as HTMLButtonElement;
    fireEvent.click(toggleButton);

    assert.equal(document.querySelectorAll('input[type="password"]').length, 1, "login mode must show only the single password field");
  });
});

/**
 * The email field had neither `autoComplete` nor `name` at all, and
 * PasswordInput's own `<input>` toggles its `type` between "password" and
 * "text" for the show/hide eye icon -- browsers decide whether to offer to
 * save/autofill a login form largely from these attributes, so a real user
 * reported the browser never remembered their email or password here. This
 * asserts the attributes a password manager actually keys off, in both
 * modes (login's own autoComplete values differ from signup's).
 */
test("AuthScreen's email and password fields carry the autocomplete/name attributes a browser password manager needs to remember the login", async () => {
  await withJsdom(() => {
    renderAuthScreen(() => {});
    // starts in signup mode
    const emailInputSignup = document.querySelector('input[type="email"]') as HTMLInputElement;
    assert.equal(emailInputSignup.name, "email");
    assert.equal(emailInputSignup.autocomplete, "username");
    const passwordInputSignup = document.querySelector('input[name="password"]') as HTMLInputElement;
    assert.ok(passwordInputSignup, "password field must carry a name attribute");
    assert.equal(passwordInputSignup.autocomplete, "new-password");

    const toggleButton = document.querySelector("button.link-button") as HTMLButtonElement;
    fireEvent.click(toggleButton);

    const emailInputLogin = document.querySelector('input[type="email"]') as HTMLInputElement;
    assert.equal(emailInputLogin.name, "email");
    assert.equal(emailInputLogin.autocomplete, "username");
    const passwordInputLogin = document.querySelector('input[name="password"]') as HTMLInputElement;
    assert.equal(passwordInputLogin.autocomplete, "current-password");
  });
});

/**
 * Once RESEND_API_KEY is configured server-side, POST /auth/login no longer
 * returns a token for a correct password -- it returns `{ requiresCode: true,
 * loginCodeId }`, and the real login only completes once the matching code
 * is submitted to /auth/login/verify-code. This drives that whole flow
 * through real DOM events (login form -> code-entry form -> onAuthenticated),
 * distinguishing the two requests by their URL rather than by call order.
 */
test("AuthScreen shows a code-entry step after a correct password returns requiresCode, and completes login once the right code is submitted", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let verifyCodeBody: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/login/verify-code")) {
        verifyCodeBody = init?.body as string;
        return new Response(JSON.stringify({ user: { id: "u1", email: "dana@example.com" }, token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ requiresCode: true, loginCodeId: "code-id-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      let authenticatedUser: unknown;
      renderAuthScreen((user) => {
        authenticatedUser = user;
      });

      // switch to login mode
      fireEvent.click(document.querySelector("button.link-button") as HTMLButtonElement);

      const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = document.querySelector('input[name="password"]') as HTMLInputElement;
      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });
      fireEvent.change(passwordInput, { target: { value: "correct-horse-battery" } });

      await act(async () => {
        fireEvent.submit(document.querySelector("form.auth-form")!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(authenticatedUser, undefined, "requiresCode must not authenticate yet");
      const codeInput = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
      assert.ok(codeInput, "the code-entry step must now be showing");
      // the original email/password inputs must be gone, not just hidden
      assert.equal(document.querySelector('input[type="email"]'), null);

      fireEvent.change(codeInput, { target: { value: "123456" } });
      await act(async () => {
        fireEvent.submit(document.querySelector("form.auth-form")!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.deepEqual(authenticatedUser, { id: "u1", email: "dana@example.com" });
      assert.equal(JSON.parse(verifyCodeBody!).loginCodeId, "code-id-1");
      assert.equal(JSON.parse(verifyCodeBody!).code, "123456");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AuthScreen's code-entry 'back' button returns to the login form and clears the entered code", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ requiresCode: true, loginCodeId: "code-id-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      renderAuthScreen(() => {});
      fireEvent.click(document.querySelector("button.link-button") as HTMLButtonElement);
      fireEvent.change(document.querySelector('input[type="email"]') as HTMLInputElement, { target: { value: "dana@example.com" } });
      fireEvent.change(document.querySelector('input[name="password"]') as HTMLInputElement, { target: { value: "correct-horse-battery" } });

      await act(async () => {
        fireEvent.submit(document.querySelector("form.auth-form")!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.ok(document.querySelector('input[inputmode="numeric"]'), "must be on the code-entry step");

      const backButton = document.querySelector("button.link-button") as HTMLButtonElement;
      fireEvent.click(backButton);

      assert.equal(document.querySelector('input[inputmode="numeric"]'), null, "must be back on the email/password form");
      assert.ok(document.querySelector('input[type="email"]'), "email field must be showing again");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
