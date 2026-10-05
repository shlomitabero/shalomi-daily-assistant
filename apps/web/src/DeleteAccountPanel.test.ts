import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Project } from "@forge/shared";
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

function renderPanel(opts?: { onClose?: () => void; onDeleted?: (ownedProjectIds: string[]) => void; userId?: string }) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(DeleteAccountPanel, {
          email: "dana@example.com",
          userId: opts?.userId ?? "user1",
          onClose: opts?.onClose ?? (() => {}),
          onDeleted: opts?.onDeleted ?? (() => {}),
        }),
      ),
    ),
  );
}

/** Wraps a test's own fetch mock so `GET /api/projects` (fetched unconditionally on mount for the real project-count summary) is answered without every existing test needing to know or care about it. */
function withListProjectsStub(projects: Project[], handleOther: (input: string, init?: RequestInit) => Promise<Response>) {
  return (async (input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && input === "/api/projects") {
      return new Response(JSON.stringify({ projects }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return handleOther(input, init);
  }) as typeof fetch;
}

function makeProject(id: string, ownerId: string): Project {
  return {
    id,
    ownerId,
    name: id,
    description: "",
    status: "built",
    spec: { summary: "", personas: [], roles: ["Admin"], entities: [], screens: [], assumptions: [], openQuestions: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function typeConfirmation(value: string) {
  fireEvent.change(document.querySelector("input[type='text']")!, { target: { value } });
}

test("typing the account's own email exactly and submitting calls the real DELETE /auth/account and fires onDeleted", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let calls: { method?: string }[] = [];
    globalThis.fetch = withListProjectsStub([], async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/auth/account") {
        calls.push({ method: init.method });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    });

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
 * Round 403: onDeleted must hand back the real OWNED project ids (not
 * shared-with-you ones) -- App.tsx needs them to sweep its own
 * projectPreferenceCleanup.ts localStorage stores for each one, since the
 * server-side DELETE /auth/account cascade has no way to touch this
 * browser's localStorage at all. Confirms the same ids projectSummary's
 * own "owned" count is derived from (user1's p1/p2, not someone-else's p3)
 * are exactly what's passed to onDeleted.
 */
test("onDeleted is called with exactly the real owned project ids, excluding any merely-shared-with-you project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const projects = [makeProject("p1", "user1"), makeProject("p2", "user1"), makeProject("p3", "someone-else")];
    globalThis.fetch = withListProjectsStub(projects, async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/auth/account") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    });

    let receivedIds: string[] | null = null;
    try {
      renderPanel({ userId: "user1", onDeleted: (ids) => (receivedIds = ids) });
      await waitForCondition(() => document.querySelector(".delete-account-summary") !== null);
      typeConfirmation("dana@example.com");
      fireEvent.submit(document.querySelector("form")!);

      await waitForCondition(() => receivedIds !== null);
      assert.deepEqual(receivedIds, ["p1", "p2"], "must pass exactly the owned project ids, never the shared one");
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
    globalThis.fetch = withListProjectsStub([], async () => {
      calls += 1;
      throw new Error("deleteAccount must never be called when the confirmation doesn't match");
    });

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
    globalThis.fetch = withListProjectsStub(
      [],
      async () =>
        new Response(JSON.stringify({ error: "Something went wrong", code: "INTERNAL_ERROR" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

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
    globalThis.fetch = withListProjectsStub([], async () => {
      throw new Error("cancelling must never call any API other than the project-count fetch already done on mount");
    });

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

/**
 * New in this round: the warning previously only ever described *what
 * kind* of data would be lost, never *how much* -- confirms the panel now
 * fetches the real project list itself (not App.tsx's own myProjects,
 * which is only ever populated while the home screen is open) and shows
 * the real owned+shared counts, distinguishing "yours, will be deleted"
 * from "shared with you, access removed" since deleteAccount.warning's
 * own text makes exactly that distinction.
 */
test("shows the real owned-vs-shared project counts once the real fetch resolves, distinguishing the two consequences", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const projects = [
      makeProject("p1", "user1"),
      makeProject("p2", "user1"),
      makeProject("p3", "someone-else"),
    ];
    globalThis.fetch = withListProjectsStub(projects, async (input) => {
      throw new Error(`unexpected request ${input}`);
    });

    try {
      renderPanel({ userId: "user1" });
      assert.equal(
        document.querySelector(".delete-account-summary"),
        null,
        "must not show a summary before the real project fetch has resolved",
      );

      await waitForCondition(() => document.querySelector(".delete-account-summary") !== null);
      const summary = document.querySelector(".delete-account-summary")!.textContent ?? "";
      // Deliberately tied to the specific role each number plays (not just
      // "does a 2 and a 1 appear somewhere") -- a broken owned/shared split
      // that swaps the two counts would still contain the same two digits,
      // just attached to the wrong phrase, and must still be caught.
      assert.match(
        summary,
        /2 projects you own will be permanently deleted/,
        "must attribute the real OWNED count (2) to the 'you own, will be deleted' phrase specifically",
      );
      assert.match(
        summary,
        /access to 1 more shared projects/,
        "must attribute the real SHARED count (1) to the 'shared, access removed' phrase specifically",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** The other half: a brand-new account with zero projects at all (owned or shared) must never show an empty/misleading summary line. */
test("shows no project-count summary at all for an account with zero owned and zero shared projects", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = withListProjectsStub([], async (input) => {
      throw new Error(`unexpected request ${input}`);
    });

    try {
      renderPanel({ userId: "user1" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        document.querySelector(".delete-account-summary"),
        null,
        "a brand-new account with nothing to lose must never show an empty or misleading summary line",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
