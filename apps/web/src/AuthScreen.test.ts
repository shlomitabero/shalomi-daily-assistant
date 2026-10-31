import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { AuthScreen } from "./AuthScreen.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

/**
 * Same jsdom-swap technique as useDialogFocusTrap.test.ts. `url` lets the
 * reset-password tests below simulate actually following an emailed
 * `?resetToken=...` link -- AuthScreen reads that query param once, at
 * mount, from `window.location.search`.
 */
async function withJsdom<T>(fn: () => Promise<T> | T, url = "http://localhost/"): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
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
 * Round 716 added a real "forgot password" recovery path for an account
 * locked out by a typo'd signup password, but catching the typo right
 * here -- before it ever reaches the server -- is still better than
 * making someone go through that whole flow for a mistake made seconds
 * ago. This confirm-password field (mirroring ChangePasswordPanel's own
 * established mismatch check) is that first line of defense. Confirms
 * the mismatch is actually caught client-side: zero requests reach the
 * network, and the real error message shows.
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

/**
 * Round 1155: the code-entry step's only prior recovery path for a slow/
 * lost transactional email was "Back" (full restart), which also silently
 * burned the first code (routes/auth.ts's own deleteLoginCodesForUser runs
 * on every /auth/login call). email/password are still sitting in this
 * component's own state at this step, so "Resend code" just re-runs the
 * same login() call handleSubmit already makes, swaps in the fresh
 * loginCodeId, and shows a confirmation -- without discarding the
 * email/password fields or returning to the login form.
 */
test("AuthScreen's code-entry 'Resend code' button re-requests a fresh code without leaving the code-entry step, and shows a confirmation", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let loginCalls = 0;
    globalThis.fetch = (async () => {
      loginCalls += 1;
      return new Response(JSON.stringify({ requiresCode: true, loginCodeId: `code-id-${loginCalls}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      renderAuthScreen(() => {});
      fireEvent.click(document.querySelector("button.link-button") as HTMLButtonElement); // switch to login
      fireEvent.change(document.querySelector('input[type="email"]') as HTMLInputElement, { target: { value: "dana@example.com" } });
      fireEvent.change(document.querySelector('input[name="password"]') as HTMLInputElement, { target: { value: "correct-horse-battery" } });

      await act(async () => {
        fireEvent.submit(document.querySelector("form.auth-form")!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(loginCalls, 1);
      fireEvent.change(document.querySelector('input[inputmode="numeric"]') as HTMLInputElement, { target: { value: "111111" } });

      const resendButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Resend code") as HTMLButtonElement;
      assert.ok(resendButton, "expected a 'Resend code' button on the code-entry step");

      await act(async () => {
        fireEvent.click(resendButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(loginCalls, 2, "resend must call the real login endpoint again, not just redisplay the same step");
      assert.ok(document.querySelector('input[inputmode="numeric"]'), "must still be on the code-entry step, not back on the login form");
      assert.equal(
        (document.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value,
        "",
        "the previously-typed (now-invalidated) code must be cleared after a resend",
      );
      assert.match(document.body.textContent ?? "", /new code has been sent/i, "the resend must show a real confirmation, not resend silently");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 716: the real "forgot password" recovery flow. The link only
 * makes sense in login mode (there's no existing password to have
 * forgotten while signing up for the first time); submitting the typed
 * email always shows the same generic confirmation, mirroring
 * routes/auth.ts's own deliberate "never reveal whether the email has an
 * account" response.
 */
test("AuthScreen's 'Forgot password?' link only shows in login mode, and submitting an email calls the real endpoint and shows the generic confirmation", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_input: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ sent: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      renderAuthScreen(() => {});
      // starts in signup mode -- no "Forgot password?" link yet.
      assert.equal(
        Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Forgot password?"),
        false,
        "signup mode has no existing password to have forgotten",
      );

      fireEvent.click(document.querySelector("button.link-button") as HTMLButtonElement); // switch to login
      const forgotLink = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Forgot password?") as HTMLButtonElement;
      assert.ok(forgotLink, "expected a 'Forgot password?' link in login mode");

      fireEvent.click(forgotLink);
      assert.equal(
        document.querySelector('input[type="password"]') === null,
        true,
        "the forgot-password step shows only an email field, no password input",
      );
      const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });

      await act(async () => {
        fireEvent.submit(document.querySelector("form.auth-form")!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(JSON.parse(capturedBody!).email, "dana@example.com");
      assert.equal(
        document.querySelector('input[type="email"]') === null,
        true,
        "must show the confirmation, not the email form, once sent",
      );
      assert.match(document.body.textContent ?? "", /sent a password reset link/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1156: the sibling gap to round 1155's own login-code "Resend"
 * fix -- a password-reset email is exactly as prone to arriving late or
 * landing in spam, and the only prior recovery was clicking "Back" and
 * going through "Forgot password?" again from scratch. email is already
 * in component state at this step, so "Resend email" just re-runs the
 * same forgotPassword() call handleForgotPasswordSubmit already makes,
 * without leaving the confirmation screen.
 */
test("AuthScreen's forgot-password confirmation screen has a 'Resend email' button that re-requests the real endpoint and shows a confirmation", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let sendCalls = 0;
    let lastBody: string | undefined;
    globalThis.fetch = (async (_input: string, init?: RequestInit) => {
      sendCalls += 1;
      lastBody = init?.body as string;
      return new Response(JSON.stringify({ sent: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      renderAuthScreen(() => {});
      fireEvent.click(document.querySelector("button.link-button") as HTMLButtonElement); // switch to login
      const forgotLink = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Forgot password?") as HTMLButtonElement;
      fireEvent.click(forgotLink);
      fireEvent.change(document.querySelector('input[type="email"]') as HTMLInputElement, { target: { value: "dana@example.com" } });

      await act(async () => {
        fireEvent.submit(document.querySelector("form.auth-form")!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(sendCalls, 1);
      const resendButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Resend email") as HTMLButtonElement;
      assert.ok(resendButton, "expected a 'Resend email' button on the confirmation screen");

      await act(async () => {
        fireEvent.click(resendButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(sendCalls, 2, "resend must call the real forgot-password endpoint again, not just redisplay the same confirmation");
      assert.equal(JSON.parse(lastBody!).email, "dana@example.com");
      assert.match(document.body.textContent ?? "", /sent a password reset link/i, "the original confirmation must still be showing");
      assert.match(document.body.textContent ?? "", /sent again/i, "the resend must show its own confirmation, not resend silently");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Following the real emailed link (`?resetToken=...`) must show the
 * reset-password form instead of the normal login/signup screen --
 * confirms the whole real flow through real DOM events: typing a new
 * password, submitting, and the success state's "Go to login" button
 * actually clearing the URL and returning to a fresh login form.
 */
test("AuthScreen shows the reset-password form when the URL carries a resetToken, submits it to the real endpoint, and 'Go to login' clears the URL afterward", async () => {
  await withJsdom(
    async () => {
      const originalFetch = globalThis.fetch;
      let capturedBody: string | undefined;
      globalThis.fetch = (async (_input: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      try {
        renderAuthScreen(() => {});

        assert.equal(
          document.querySelector('input[type="email"]') === null,
          true,
          "the reset-password form must show instead of the normal login/signup form",
        );
        const [newPasswordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
        assert.ok(newPasswordInput, "expected a new-password field");
        assert.ok(confirmPasswordInput, "expected a confirm-password field");

        fireEvent.change(newPasswordInput, { target: { value: "brand-new-password" } });
        fireEvent.change(confirmPasswordInput, { target: { value: "brand-new-password" } });

        await act(async () => {
          fireEvent.submit(document.querySelector("form.auth-form")!);
          await Promise.resolve();
          await Promise.resolve();
        });

        assert.equal(JSON.parse(capturedBody!).token, "abc123");
        assert.equal(JSON.parse(capturedBody!).newPassword, "brand-new-password");
        assert.match(document.body.textContent ?? "", /password has been reset/i);
        // Round 1154: POST /auth/reset-password's own real side effect
        // (deleteAllSessionsForUser, see routes/auth.ts's own doc comment)
        // silently signs out every existing session on every device -- the
        // success message must say so, not leave someone else still logged
        // in elsewhere silently kicked out with no explanation anywhere.
        assert.match(document.body.textContent ?? "", /other device|every device|all devices|previous sessions/i);

        const goToLoginButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("login")) as HTMLButtonElement;
        fireEvent.click(goToLoginButton);

        assert.ok(document.querySelector('input[type="email"]'), "must return to the normal login form");
        assert.equal(window.location.search, "", "the resetToken query param must be stripped from the URL after returning to login");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    "http://localhost/?resetToken=abc123",
  );
});

/**
 * Round 879: this state's own doc comment (AuthScreen.tsx, the resetToken
 * useState initializer) claims the URL's resetToken param is "stripped
 * from the URL... once the reset actually completes" -- but only
 * handleBackToLogin (an explicit, voluntary button click) ever did that.
 * A successful reset left the token sitting in the URL bar, so a
 * completely ordinary refresh (or re-opening the same emailed link a
 * second time) before clicking "Go to login" remounted AuthScreen with
 * the same resetToken still in the URL, re-showing the reset-password FORM
 * instead of the success message -- and submitting it failed, since the
 * server already deleted that single-use token on the first success,
 * surfacing a confusing "expired or invalid" error for someone who had, in
 * fact, already succeeded. Confirms the URL is cleared the moment the
 * reset itself succeeds, not only when "Go to login" is clicked.
 */
test("AuthScreen strips the resetToken query param from the URL the moment the reset itself succeeds, not only when 'Go to login' is later clicked", async () => {
  await withJsdom(
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
      try {
        renderAuthScreen(() => {});
        const [newPasswordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
        fireEvent.change(newPasswordInput, { target: { value: "brand-new-password" } });
        fireEvent.change(confirmPasswordInput, { target: { value: "brand-new-password" } });

        await act(async () => {
          fireEvent.submit(document.querySelector("form.auth-form")!);
          await Promise.resolve();
          await Promise.resolve();
        });

        assert.match(document.body.textContent ?? "", /password has been reset/i, "the success message must still be showing right after submit");
        assert.equal(
          window.location.search,
          "",
          "the resetToken query param must already be stripped the moment the reset succeeds, before 'Go to login' is ever clicked",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    "http://localhost/?resetToken=abc123",
  );
});

/**
 * Round 914's finding: a server-rejected token (expired, already
 * consumed, or unknown -- RESET_TOKEN_INVALID) left the user on a dead-
 * end screen with only the error paragraph and no navigation control at
 * all, unlike the sibling resetDone success branch two cases above (has
 * a "back to login" button) and forgotPasswordMode's own pre-send branch
 * (has one too). The rejection is unconditional on every resubmission --
 * retyping the password can never fix it -- so the user had no in-app
 * way back to login short of manually editing the browser URL.
 */
test("AuthScreen's reset-password form shows a 'back to login' button after the server rejects the token, not just a dead-end error", async () => {
  await withJsdom(
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "This reset link has expired or is invalid. Please request a new one.", code: "RESET_TOKEN_INVALID" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        renderAuthScreen(() => {});
        const [newPasswordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
        fireEvent.change(newPasswordInput, { target: { value: "brand-new-password" } });
        fireEvent.change(confirmPasswordInput, { target: { value: "brand-new-password" } });

        await act(async () => {
          fireEvent.submit(document.querySelector("form.auth-form")!);
          await Promise.resolve();
          await Promise.resolve();
        });

        assert.ok(document.querySelector(".error"), "expected the real rejection error to render");

        const backButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("login")) as
          | HTMLButtonElement
          | undefined;
        assert.ok(backButton, "expected a 'back to login' button even after the token is rejected, not a dead end");

        fireEvent.click(backButton!);
        assert.ok(document.querySelector('input[type="email"]'), "clicking it must return to the normal login form");
        assert.equal(window.location.search, "", "the invalid resetToken query param must be stripped from the URL too");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    "http://localhost/?resetToken=abc123",
  );
});

test("AuthScreen's reset-password form rejects a mismatched confirmation client-side, with zero requests sent", async () => {
  await withJsdom(
    async () => {
      const originalFetch = globalThis.fetch;
      let requestCount = 0;
      globalThis.fetch = (async () => {
        requestCount += 1;
        throw new Error("must never be called");
      }) as typeof fetch;
      try {
        renderAuthScreen(() => {});
        const [newPasswordInput, confirmPasswordInput] = document.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
        fireEvent.change(newPasswordInput, { target: { value: "brand-new-password" } });
        fireEvent.change(confirmPasswordInput, { target: { value: "something-else-entirely" } });

        await act(async () => {
          fireEvent.submit(document.querySelector("form.auth-form")!);
          await Promise.resolve();
        });

        assert.equal(requestCount, 0, "a mismatched confirmation must never send a real reset-password request");
        assert.match(document.querySelector(".error")!.textContent ?? "", /match/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    "http://localhost/?resetToken=abc123",
  );
});

/**
 * Round 1370: handleSubmit had no guard against racing ITSELF -- the same
 * own-click reentrancy gap rounds 1363-1369 closed for EntityPanel/
 * AutomationsPanel/WhatsAppPanel/CollaboratorsPanel/useAddableSpecItem/
 * ChangeEmailPanel/ChangePasswordPanel/App.tsx. POST /auth/login has no
 * withIdempotency protection at all, unlike every other mutating auth
 * route -- a fast double-click/double-Enter on the login button must only
 * ever reach login() once, not fire two independent requests that could
 * each mint their own login-code row and race each other's
 * deleteLoginCodesForUser cleanup (see handleSubmit's own doc comment).
 */
test("AuthScreen's submit button guards against a fast double-click, so only one login request ever fires for one submission", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const calls: { body: string }[] = [];
    const pending: { resolveFirstLogin: (() => void) | null } = { resolveFirstLogin: null };
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/login") && init?.method === "POST") {
        calls.push({ body: init.body as string });
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            pending.resolveFirstLogin = resolve;
          });
        } else {
          await new Promise(() => {});
        }
        return new Response(JSON.stringify({ user: { id: "u1", email: "dana@example.com" }, token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
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

      const form = document.querySelector("form.auth-form")!;
      fireEvent.submit(form);
      fireEvent.submit(form);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(
        calls.length,
        1,
        "a fast double submit must only ever reach login() once -- the second click must be blocked by busy, not fire its own independent request",
      );

      await act(async () => {
        pending.resolveFirstLogin?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.deepEqual(authenticatedUser, { id: "u1", email: "dana@example.com" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
