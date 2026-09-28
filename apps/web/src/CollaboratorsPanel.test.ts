import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectCollaborator } from "@forge/shared";
import { CollaboratorsPanel } from "./CollaboratorsPanel.js";
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

function makeCollaborator(userId: string, email: string): ProjectCollaborator {
  return { userId, email, addedAt: new Date().toISOString() };
}

function renderPanel(isOwner = true, currentUserId?: string, onLeft: () => void = () => {}) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(CollaboratorsPanel, { projectId: "proj1", isOwner, currentUserId, onClose: () => {}, onLeft }),
      ),
    ),
  );
}

/**
 * New in this round: removing a collaborator (unlike every other real
 * destructive action in this app -- deleting a project, round 123;
 * deleting a record, round 73) had NO confirmation at all -- one click on
 * "Remove" instantly revoked someone's access, with no "are you sure?"
 * Mirrors handleDeleteProject's own window.confirm gate exactly: declining
 * must leave the collaborator list and the server untouched.
 */
test("CollaboratorsPanel's remove button asks for confirmation, and declining leaves the collaborator and the server untouched", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const dana = makeCollaborator("u1", "dana@example.com");
    let deleteCalls = 0;
    let confirmMessage: string | undefined;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/collaborators/u1") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = ((message: string) => {
      confirmMessage = message;
      return false;
    }) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);

      const removeBtn = document.querySelector(".collab-list button") as HTMLButtonElement;
      fireEvent.click(removeBtn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.match(confirmMessage ?? "", /dana@example\.com/, "the confirm message must name the actual collaborator being removed");
      assert.equal(deleteCalls, 0, "declining the confirm must never call the remove API");
      assert.equal(document.querySelectorAll(".collab-list li").length, 1, "the collaborator must still be listed after declining");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: listCollaborators (collaborators.ts) only ever
 * returns rows from the project_collaborators join table -- the owner
 * isn't in there at all (their access comes from project.ownerId
 * directly), so a collaborator opening this panel could see every OTHER
 * collaborator but never who actually owns the project. The API now
 * returns an `owner` field alongside `collaborators`; this checks the
 * owner renders as the first row with the right badge and no remove
 * button, for the owner's own view of the panel.
 */
test("CollaboratorsPanel shows the owner as the first row with an 'Owner (You)' badge and no remove button, for the owner's own view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(
          JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const rows = Array.from(document.querySelectorAll(".collab-list li"));
      const ownerRow = rows[0];
      assert.ok(ownerRow.classList.contains("collab-owner-row"), "the owner must be the first row, marked with .collab-owner-row");
      assert.match(ownerRow.textContent ?? "", /amit@example\.com/, "the owner row must show the real owner's email");
      assert.match(ownerRow.textContent ?? "", /owner \(you\)/i, "the panel owner must see the 'Owner (You)' badge on their own row");
      assert.equal(ownerRow.querySelector("button"), null, "the owner row must never have a remove button");

      const collaboratorRow = rows[1];
      assert.match(collaboratorRow.textContent ?? "", /dana@example\.com/);
      assert.ok(collaboratorRow.querySelector("button"), "a real collaborator row must still have a remove button");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("CollaboratorsPanel shows the real owner's email with a plain 'Owner' badge (no invite form, no remove buttons) for a non-owner collaborator's view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(
          JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(false);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const ownerRow = document.querySelector(".collab-owner-row") as HTMLElement;
      assert.match(ownerRow.textContent ?? "", /amit@example\.com/, "a collaborator must still see the real owner's email");
      assert.match(ownerRow.textContent ?? "", /owner/i, "a non-owner viewer sees the plain 'Owner' badge, not 'Owner (You)'");
      assert.doesNotMatch(ownerRow.textContent ?? "", /owner \(you\)/i, "a non-owner viewer must never see 'Owner (You)' next to someone else");
      assert.equal(document.querySelector(".collab-invite-form"), null, "a non-owner must never see the invite form");
      assert.equal(document.querySelectorAll(".collab-list button").length, 0, "a non-owner must never see any remove button, including on the owner row");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("CollaboratorsPanel actually removes the collaborator once the confirmation is accepted", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const dana = makeCollaborator("u1", "dana@example.com");
    let deleteCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/collaborators/u1") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);

      const removeBtn = document.querySelector(".collab-list button") as HTMLButtonElement;
      fireEvent.click(removeBtn);
      await waitForCondition(() => deleteCalls === 1);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 0);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: addCollaborator (packages/db/src/collaborators.ts) is
 * deliberately idempotent -- inviting someone already on the project is a
 * silent no-op server-side, still a real 201 with the unchanged list, so
 * the owner previously got zero feedback that nothing actually happened
 * (the form just cleared, exactly as if a real new invite had succeeded).
 * Confirms the panel now tells the owner "already has access" instead of
 * silently doing nothing.
 */
test("CollaboratorsPanel tells the owner when the invited email already has access, instead of silently doing nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/collaborators") {
        // The real idempotent no-op: 201 with the SAME, unchanged list.
        return new Response(
          JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const emailInput = document.querySelector('.collab-invite-form input[type="email"]') as HTMLInputElement;
      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });
      fireEvent.submit(document.querySelector(".collab-invite-form")!);

      await waitForCondition(() => document.body.textContent?.includes("already has access to this project") ?? false);
      assert.ok(document.body.textContent?.includes("dana@example.com"), "the message must name the real invited email");
      assert.equal(emailInput.value, "", "the input must still clear after a no-op invite, matching a real successful one");

      // Typing again to try a different email must clear the stale message
      // right away, not leave it sitting there describing a previous attempt.
      fireEvent.change(emailInput, { target: { value: "someone-else@example.com" } });
      assert.ok(
        !document.body.textContent?.includes("already has access"),
        "the stale 'already has access' message must clear once the owner starts a new invite attempt",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The other half: a genuinely NEW collaborator must never trigger the
 * "already has access" message -- it's conditional on the invited email
 * already being in the list BEFORE the request, not a blanket message
 * shown after every successful invite.
 */
test("CollaboratorsPanel does not show the 'already has access' message for a genuinely new invite", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");
    const yossi = makeCollaborator("u2", "yossi@example.com");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/collaborators") {
        return new Response(
          JSON.stringify({ collaborators: [dana, yossi], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const emailInput = document.querySelector('.collab-invite-form input[type="email"]') as HTMLInputElement;
      fireEvent.change(emailInput, { target: { value: "yossi@example.com" } });
      fireEvent.submit(document.querySelector(".collab-invite-form")!);

      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 3);
      assert.ok(
        !document.body.textContent?.includes("already has access"),
        "a genuinely new collaborator must never trigger the 'already has access' message",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a collaborator invited to someone else's project had
 * no way to actually leave it -- only the owner's own "Remove" button
 * (never shown to a non-owner viewer) could revoke their access. Confirms
 * a non-owner viewer sees a real "Leave" button, but ONLY on their own
 * row -- never on a different collaborator's row, since the API itself
 * only allows removing your own id.
 */
test("CollaboratorsPanel shows a 'Leave' button only on the current user's own row, for a non-owner collaborator's view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");
    const me = makeCollaborator("u2", "me@example.com");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana, me] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(false, "u2");
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const rows = Array.from(document.querySelectorAll(".collab-list li"));
      const danaRow = rows.find((r) => /dana@example\.com/.test(r.textContent ?? ""))!;
      const myRow = rows.find((r) => /me@example\.com/.test(r.textContent ?? ""))!;

      assert.equal(danaRow.querySelector("button"), null, "a non-owner must never see a button on a DIFFERENT collaborator's own row");
      const leaveBtn = myRow.querySelector("button");
      assert.ok(leaveBtn, "the current user's own row must show a real 'Leave' button");
      assert.match(leaveBtn!.textContent ?? "", /leave/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Confirms the "Leave" button's own guard: unlike the owner's "Remove"
 * button (which trims the removed collaborator's own row from the local
 * list), leaving must call the panel's onLeft callback instead -- the
 * caller no longer has access to this project at all once this succeeds,
 * so there's nothing left for this panel to keep showing. Declining the
 * confirm must never call the API or onLeft at all.
 */
test("CollaboratorsPanel's Leave button asks for confirmation, calls the real DELETE with the current user's own id, and fires onLeft once it succeeds -- declining does neither", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const me = makeCollaborator("u2", "me@example.com");
    let deleteCalls = 0;
    let confirmMessage: string | undefined;
    let confirmReturn = false;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [me] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/collaborators/u2") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = ((message: string) => {
      confirmMessage = message;
      return confirmReturn;
    }) as typeof window.confirm;

    let leftCount = 0;
    try {
      // First: decline the confirm.
      renderPanel(false, "u2", () => (leftCount += 1));
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);

      const leaveBtn = document.querySelector(".collab-list button") as HTMLButtonElement;
      fireEvent.click(leaveBtn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.ok(confirmMessage, "expected a real confirmation prompt before leaving");
      assert.equal(deleteCalls, 0, "declining the confirm must never call the real DELETE endpoint");
      assert.equal(leftCount, 0, "declining the confirm must never fire onLeft");

      // Now: accept the confirm.
      confirmReturn = true;
      fireEvent.click(leaveBtn);
      await waitForCondition(() => deleteCalls === 1);
      await waitForCondition(() => leftCount === 1);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});
