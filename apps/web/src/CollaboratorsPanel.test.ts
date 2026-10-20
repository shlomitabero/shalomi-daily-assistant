import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CollaboratorRole, ProjectCollaborator } from "@forge/shared";
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

function makeCollaborator(userId: string, email: string, role: CollaboratorRole = "editor"): ProjectCollaborator {
  return { userId, email, addedAt: new Date().toISOString(), role };
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
 * New in this round: the header never showed how many people actually
 * have access to the project at all -- unlike every sibling overlay panel
 * (HistoryPanel's own checkpoint count, App.tsx's "My projects" count),
 * which all show a live count right next to their own <h2>. Confirms the
 * real count is the owner PLUS every collaborator (not just
 * collaborators.length on its own, which would silently exclude the
 * owner), and that it only renders once both the owner and the
 * collaborator list have actually loaded -- never a misleading "0" or
 * "1" flashed before the real fetch resolves.
 */
test("CollaboratorsPanel's header shows the real total count -- the owner plus every collaborator -- once loaded, and nothing before that", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");
    const yossi = makeCollaborator("u2", "yossi@example.com");
    let resolveFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        await fetchGate;
        return new Response(
          JSON.stringify({ collaborators: [dana, yossi], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      assert.equal(document.querySelector(".collab-count"), null, "the count must not render before the real fetch has resolved");

      resolveFetch!();
      await waitForCondition(() => document.querySelector(".collab-count") !== null);
      assert.match(
        document.querySelector(".collab-count")!.textContent ?? "",
        /3 with access/,
        "the count must be the owner (1) plus both real collaborators (2) = 3, not just collaborators.length",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a failed initial load here was strictly worse than
 * the 4 panels fixed in round 328 -- the bare error line rendered, but
 * `collaborators === null && !error` was now false (error got set), so
 * the branch fell through to the "loaded" render: an empty <ul> with no
 * owner row, no collaborator list, no empty-state message, and no way to
 * retry short of closing and reopening the whole panel. Mirrors
 * BusinessTwinPanel's own loadTwin-retry pattern: a new, narrowly-scoped
 * loadError state (separate from the existing error, which also covers
 * invite/remove/leave failures) used only by the initial load's own catch
 * block.
 */
test("CollaboratorsPanel shows a real error with a Retry button when the initial load fails, instead of a silently empty list", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com");
    let callCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Server exploded" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelector(".error-retry-row") !== null);

      assert.match(document.querySelector(".error-retry-row p.error")!.textContent ?? "", /Server exploded/);
      assert.equal(
        document.querySelector(".error-retry-row p.error")!.getAttribute("role"),
        "status",
        "the error must be announced to screen readers, not just shown visually",
      );
      assert.equal(document.querySelector(".collab-list"), null, "a real load failure must not also render an empty, misleading collaborator list");
      assert.equal(document.body.textContent?.includes("Loading"), false, "a real load failure must not keep claiming it's still loading");

      const retryButton = document.querySelector(".error-retry-row button") as HTMLButtonElement;
      assert.ok(retryButton, "expected a real Retry button");

      fireEvent.click(retryButton);
      await waitForCondition(() => document.querySelector(".collab-list") !== null);

      assert.equal(document.querySelector(".error-retry-row"), null, "the error+Retry row must disappear once the retry succeeds");
      assert.match(document.body.textContent ?? "", /dana@example\.com/, "the real collaborator from the successful retry must now render");
      assert.match(document.body.textContent ?? "", /amit@example\.com/, "the real owner from the successful retry must now render");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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
 * New in this round: re-inviting an existing collaborator while the role
 * dropdown is set to a DIFFERENT role than the one they already have must
 * say so explicitly -- addCollaborator (packages/db/src/collaborators.ts)
 * is idempotent and leaves an existing collaborator's role untouched, so
 * the plain "already has access" message alone would let the owner
 * believe the role they just picked took effect, when it silently didn't.
 */
test("CollaboratorsPanel tells the owner their role pick was ignored when re-inviting an existing collaborator at a different role", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "editor");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/collaborators") {
        // The real idempotent no-op: 201 with the SAME, unchanged role.
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

      fireEvent.change(document.querySelector('.collab-invite-form input[type="email"]') as HTMLInputElement, {
        target: { value: "dana@example.com" },
      });
      fireEvent.change(document.querySelector('.collab-invite-form select[aria-label]') as HTMLSelectElement, {
        target: { value: "viewer" },
      });
      fireEvent.submit(document.querySelector(".collab-invite-form")!);

      await waitForCondition(() => document.body.textContent?.includes("role wasn't changed") ?? false);
      assert.ok(document.body.textContent?.includes("dana@example.com"), "the message must name the real invited email");
      assert.ok(
        !document.body.textContent?.includes("already has access to this project."),
        "re-inviting at a different role must show the role-aware message, not the plain 'already has access to this project.' one",
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

/**
 * New in this round: collaborators are no longer a single flat grant --
 * the owner's invite form now lets them pick a role ("editor", the
 * default, or "viewer"), and that choice is sent to the server. Confirms
 * the default submission (no role touched) sends "editor", and that
 * picking "viewer" in the select actually changes what gets sent -- not
 * just a cosmetic option that the submit ignores.
 */
test("CollaboratorsPanel's invite form defaults to the 'editor' role, and submits 'viewer' when that's picked", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "viewer");
    const requestBodies: unknown[] = [];

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/collaborators") {
        requestBodies.push(JSON.parse(init!.body as string));
        return new Response(
          JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelector(".collab-invite-form") !== null);

      const roleSelect = document.querySelector('.collab-invite-form select[aria-label]') as HTMLSelectElement;
      assert.equal(roleSelect.value, "editor", "the invite role must default to editor, matching every collaborator's access before roles existed");

      fireEvent.change(document.querySelector('.collab-invite-form input[type="email"]') as HTMLInputElement, {
        target: { value: "dana@example.com" },
      });
      fireEvent.change(roleSelect, { target: { value: "viewer" } });
      fireEvent.submit(document.querySelector(".collab-invite-form")!);
      await waitForCondition(() => requestBodies.length === 1);

      assert.deepEqual(requestBodies[0], { email: "dana@example.com", role: "viewer" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the owner can change an existing collaborator's role
 * via a per-row select (a non-owner sees the role as a plain, read-only
 * chip instead). Confirms the select starts at the collaborator's real
 * current role, changing it sends a real PATCH to the role route, and the
 * list re-renders from the server's response.
 */
test("CollaboratorsPanel lets the owner change a collaborator's role via a per-row select, which sends a real PATCH and updates the list", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "editor");
    const danaAsViewer = makeCollaborator("u1", "dana@example.com", "viewer");
    let patchCalls = 0;
    let patchBody: unknown;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/collaborators/u1/role") {
        patchCalls += 1;
        patchBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ collaborators: [danaAsViewer] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);

      const rowSelect = document.querySelector(".collab-list li select") as HTMLSelectElement;
      assert.ok(rowSelect, "the owner's view must show a real role select for each collaborator");
      assert.equal(rowSelect.value, "editor");

      fireEvent.change(rowSelect, { target: { value: "viewer" } });
      await waitForCondition(() => patchCalls === 1);

      assert.deepEqual(patchBody, { role: "viewer" });
      await waitForCondition(() => (document.querySelector(".collab-list li select") as HTMLSelectElement)?.value === "viewer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * A non-owner never gets to change anyone's role -- they see the same
 * role shown as plain, read-only text instead of a select, matching the
 * existing "read-only list" convention for everything else owner-only on
 * this panel (inviting, removing).
 */
test("CollaboratorsPanel shows a collaborator's role as read-only text (not a select) for a non-owner viewer of the panel", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "viewer");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(false, "u2");
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);

      assert.equal(document.querySelector(".collab-list li select"), null, "a non-owner must never see an editable role control");
      assert.ok(document.querySelector(".collab-role-chip"), "a non-owner must still see the collaborator's role, just as read-only text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 680: handleRoleChange does a full setCollaborators(collaborators)
 * replace from its own server response, while handleRemove does a local
 * filter -- so a role-update PATCH for one collaborator still in flight
 * while a different collaborator's removal completes meant the role
 * update's stale response, once it finally landed, could resurrect the
 * just-removed collaborator (the PATCH's own server snapshot still
 * included them, since the server hadn't processed the DELETE yet when it
 * computed that response). Mirrors HistoryPanel's own restore/delete
 * cross-gate for the identical shape: both the role select AND the
 * remove/leave buttons are now disabled while EITHER a role update OR a
 * removal is in flight anywhere on the list, not just the one row calling
 * it -- so the two requests this bug needed can never actually overlap.
 */
test("CollaboratorsPanel disables every row's role select and remove button while either a role update or a removal is in flight anywhere on the list", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "editor");
    const yossi = makeCollaborator("u2", "yossi@example.com", "editor");
    const danaAsViewer = makeCollaborator("u1", "dana@example.com", "viewer");
    let resolvePatch: (() => void) | undefined;
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    let deleteCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana, yossi] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/collaborators/u1/role") {
        await patchGate;
        // The server's own snapshot at the moment it handled this PATCH --
        // would still include u2 (yossi) if a DELETE for yossi had raced
        // in and resolved first, since the server captures this response
        // body from whatever it saw at PATCH-handling time.
        return new Response(JSON.stringify({ collaborators: [danaAsViewer, yossi] }), {
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
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const rows = Array.from(document.querySelectorAll(".collab-list li"));
      const danaSelect = rows[0].querySelector("select") as HTMLSelectElement;
      const yossiRemoveBtn = rows[1].querySelector("button") as HTMLButtonElement;
      assert.equal(danaSelect.disabled, false);
      assert.equal(yossiRemoveBtn.disabled, false);

      fireEvent.change(danaSelect, { target: { value: "viewer" } });

      // While dana's role PATCH is still in flight, yossi's remove button
      // (a DIFFERENT row) must already be disabled -- the bug this fixes
      // is specifically that it wasn't, letting the DELETE below fire
      // concurrently with the still-pending PATCH.
      assert.equal(yossiRemoveBtn.disabled, true, "a different row's remove button must be disabled while any role update is in flight");
      assert.equal(danaSelect.disabled, true, "the select itself must also be disabled while its own update is pending");

      // A disabled button's click handler never fires (browser/jsdom both
      // suppress it) -- confirms the cross-gate doesn't just look
      // disabled, it genuinely blocks the DELETE that would have raced.
      fireEvent.click(yossiRemoveBtn);
      assert.equal(deleteCalls, 0, "clicking a disabled remove button must never actually call the DELETE endpoint");

      resolvePatch!();
      await waitForCondition(() => yossiRemoveBtn.disabled === false);
      assert.equal((rows[0].querySelector("select") as HTMLSelectElement).value, "viewer", "dana's role update must have landed normally");

      // Now that nothing is in flight, removing yossi must work exactly
      // as before -- the fix only adds a cross-gate, it doesn't block
      // removal once the role update is actually done.
      fireEvent.click(yossiRemoveBtn);
      await waitForCondition(() => deleteCalls === 1);
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 689: round 680's own fix cross-gated handleRoleChange against
 * handleRemove (both do a full setCollaborators(...) replace from their
 * own server response, so one still in flight can resurrect a
 * collaborator the other already resolved locally) -- but handleInvite
 * does the exact same full-replace (see its own `setCollaborators(
 * collaborators)` on a successful addCollaborator) and was left out of
 * that cross-gate entirely, in both directions: the invite button was
 * only ever disabled by its own inviteBusy, and the role select/remove/
 * leave buttons were only ever disabled by updatingRoleUserId/
 * removingUserId, with no awareness invite could be in flight too.
 */
test("CollaboratorsPanel cross-gates the invite form against any role update or removal in flight, and vice versa", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "editor");
    const yossi = makeCollaborator("u2", "yossi@example.com", "editor");
    const newGuy = makeCollaborator("u3", "new@example.com", "editor");
    let resolveInvite: (() => void) | undefined;
    const invitePromise = new Promise<void>((resolve) => {
      resolveInvite = resolve;
    });
    let resolveDelete: (() => void) | undefined;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    let inviteCalls = 0;
    let deleteCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana, yossi] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/collaborators") {
        inviteCalls += 1;
        await invitePromise;
        // The server's own snapshot at invite-handling time -- still
        // includes yossi, since a concurrent DELETE for yossi must never
        // be allowed to actually race against this in the first place.
        return new Response(JSON.stringify({ collaborators: [dana, yossi, newGuy] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/collaborators/u2") {
        deleteCalls += 1;
        await deletePromise;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const rows = Array.from(document.querySelectorAll(".collab-list li"));
      const danaSelect = rows[0].querySelector("select") as HTMLSelectElement;
      const yossiRemoveBtn = rows[1].querySelector("button") as HTMLButtonElement;
      const emailInput = document.querySelector('.collab-invite-form input[type="email"]') as HTMLInputElement;
      const inviteBtn = document.querySelector('.collab-invite-form button[type="submit"]') as HTMLButtonElement;

      // Direction 1: an invite in flight must disable every row's own
      // controls, not just the invite form itself.
      fireEvent.change(emailInput, { target: { value: "new@example.com" } });
      fireEvent.submit(document.querySelector(".collab-invite-form")!);

      assert.equal(danaSelect.disabled, true, "a role select must be disabled while an invite is in flight");
      assert.equal(yossiRemoveBtn.disabled, true, "a remove button must be disabled while an invite is in flight");

      fireEvent.click(yossiRemoveBtn);
      assert.equal(deleteCalls, 0, "clicking a disabled remove button while an invite is in flight must never call the DELETE endpoint");

      resolveInvite!();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 3);
      await waitForCondition(() => danaSelect.disabled === false);
      assert.equal(inviteCalls, 1, "exactly one invite request must have fired");

      // Direction 2: a removal in flight must disable the invite form too.
      const rowsAfterInvite = Array.from(document.querySelectorAll(".collab-list li"));
      const yossiRemoveBtn2 = rowsAfterInvite[1].querySelector("button") as HTMLButtonElement;
      fireEvent.click(yossiRemoveBtn2);

      assert.equal(inviteBtn.disabled, true, "the invite button must be disabled while a removal is in flight");

      fireEvent.change(emailInput, { target: { value: "another@example.com" } });
      fireEvent.click(inviteBtn);
      assert.equal(inviteCalls, 1, "clicking the invite button while it is disabled must never fire a second invite request");

      resolveDelete!();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);
      await waitForCondition(() => inviteBtn.disabled === false);
      assert.equal(deleteCalls, 1, "exactly one delete request must have fired");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
