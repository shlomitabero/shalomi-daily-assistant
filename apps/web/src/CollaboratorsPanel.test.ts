import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { CollaboratorRole, Project, ProjectCollaborator } from "@forge/shared";
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

function renderPanel(
  isOwner = true,
  currentUserId?: string,
  onLeft: () => void = () => {},
  projectName = "Test Project",
  onOwnerTransferred: (project: Project, selfSharedAt: string | undefined) => void = () => {},
) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(CollaboratorsPanel, {
          projectId: "proj1",
          projectName,
          isOwner,
          currentUserId,
          onClose: () => {},
          onLeft,
          onOwnerTransferred,
        }),
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
 * Round 901: the invite form was gated only on `isOwner`, never on whether
 * the initial collaborator list actually loaded. handleInvite's own
 * "already a collaborator, role unchanged" pre-check (see the comment
 * block above it) only works by checking the submitted email against the
 * real list already on screen -- but while that list failed to load,
 * `collaborators` stays at its null initial value, so the pre-check
 * silently evaluates against `[]` instead. Re-inviting someone already on
 * the project in that state would 201 as a no-op (addCollaborator's own
 * documented idempotency) with zero "role unchanged" feedback -- the exact
 * deceptive-success hazard the pre-check exists to catch, just reached via
 * a failed initial load instead of a normal one. Confirms the submit
 * button is disabled while in that state, and that no POST is ever sent.
 */
test("CollaboratorsPanel disables the invite submit button while the initial collaborator list has failed to load, instead of letting a re-invite silently no-op with zero feedback", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ error: "Server exploded" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input} -- the invite form must not be able to submit while the list has failed to load`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelector(".error-retry-row") !== null);

      const emailInput = document.querySelector("input[type='email']") as HTMLInputElement;
      const submitButton = document.querySelector(".collab-invite-form button[type='submit']") as HTMLButtonElement;
      assert.ok(emailInput, "expected the invite form to still render");
      assert.equal(submitButton.disabled, true, "expected the submit button to be disabled while collaborators is still null (load failed)");

      fireEvent.change(emailInput, { target: { value: "dana@example.com" } });
      assert.equal(submitButton.disabled, true, "typing a real email must not re-enable the button while the list has failed to load");
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
 * Round 930: the "role wasn't changed" message above was computed from
 * existingCollaborator -- a snapshot of this panel's own collaborators
 * state captured BEFORE the invite request was sent. If something else
 * changed this collaborator's real role between this panel's last fetch
 * and this submit (another tab/session, or a role-dropdown change still
 * in flight), that stale snapshot can disagree with the FRESH role the
 * POST response actually returns. Dana is shown as "viewer" (stale) when
 * this panel loaded, but the server's real, current role for her is
 * already "editor" (changed elsewhere) -- confirmed by the POST response
 * itself returning her as "editor". The owner re-invites her AT "editor",
 * matching her real, current role exactly: the message must say she
 * already has access, not falsely claim the pick was ignored.
 */
test("CollaboratorsPanel's re-invite message reflects the fresh server response, not a stale pre-request snapshot of the collaborator's role", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const staleDana = makeCollaborator("u1", "dana@example.com", "viewer");
    const freshDana = makeCollaborator("u1", "dana@example.com", "editor");

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        // The panel's own initial load sees Dana as "viewer" -- stale by
        // the time the invite below is actually submitted.
        return new Response(JSON.stringify({ collaborators: [staleDana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/collaborators") {
        // The real, current state: Dana's role was already "editor" by the
        // time this request reached the server (addCollaborator's own
        // idempotent no-op leaves it untouched) -- exactly matching the
        // role the owner is about to pick below.
        return new Response(
          JSON.stringify({ collaborators: [freshDana], owner: { userId: "owner1", email: "amit@example.com" } }),
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
        target: { value: "editor" },
      });
      fireEvent.submit(document.querySelector(".collab-invite-form")!);

      // Note: waiting on "dana@example.com" alone would resolve
      // immediately -- her email is already in the list from the initial
      // (stale) GET, before the invite's own response is even processed.
      // Wait on the actual invite-result message instead.
      await waitForCondition(() => document.body.textContent?.includes("already has access to this project.") ?? false);
      assert.ok(
        !document.body.textContent?.includes("role wasn't changed"),
        "Dana's real, current role (from the fresh response) already matches what the owner picked -- must not claim the pick was ignored",
      );
      assert.ok(
        document.body.textContent?.includes("already has access to this project."),
        "must show the plain 'already has access' message, matching the fresh server state",
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

/**
 * Round 1012: before the real route/button existed, a calendar subscribe
 * URL (EntityPanel.tsx's own "Subscribe" button, round 1006) could never
 * be invalidated once handed out -- a removed/demoted collaborator kept
 * live feed access forever, with no owner-facing way to stop it.
 * Confirms the new "Invalidate existing subscription links" affordance
 * only ever renders for the owner -- a plain collaborator, who can't take
 * this action server-side either (requireProjectOwner), must never be
 * shown a button that would just 404 if clicked.
 */
test("CollaboratorsPanel's calendar-feed regenerate button only renders for the owner", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelector(".collab-calendar-feed-section") !== null);
      cleanup();

      renderPanel(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        document.querySelector(".collab-calendar-feed-section"),
        null,
        "a plain collaborator (not the owner) must never see the regenerate affordance at all",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1012: mirrors the remove-button's own confirm-dialog test above --
 * this action is just as consequential (it breaks every existing
 * subscription, including the owner's own), so it needs the same
 * confirm-before-acting gate, and declining must never call the real API.
 */
test("CollaboratorsPanel's calendar-feed regenerate button asks for confirmation, and declining never calls the real endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    let regenerateCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/calendar-feed-token/regenerate") {
        regenerateCalls += 1;
        return new Response(JSON.stringify({ token: "brand-new-token" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => false) as typeof window.confirm;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelector(".collab-calendar-feed-section") !== null);

      fireEvent.click(document.querySelector(".collab-calendar-feed-section button") as HTMLButtonElement);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(regenerateCalls, 0, "declining the confirm must never call the real regenerate endpoint");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

test("CollaboratorsPanel's calendar-feed regenerate button calls the real endpoint and shows a success message once confirmed", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    let regenerateCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/calendar-feed-token/regenerate") {
        regenerateCalls += 1;
        return new Response(JSON.stringify({ token: "brand-new-token" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel(true);
      await waitForCondition(() => document.querySelector(".collab-calendar-feed-section") !== null);

      const button = document.querySelector(".collab-calendar-feed-section button") as HTMLButtonElement;
      fireEvent.click(button);
      await waitForCondition(() => regenerateCalls === 1);
      await waitForCondition(() => document.querySelector(".collab-calendar-feed-section [role='status']") !== null);

      assert.equal(regenerateCalls, 1, "confirming must call the real regenerate endpoint exactly once");
      assert.equal(button.disabled, false, "the button must re-enable itself once the request settles");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 1247: the "Subscribe to a combined calendar" button, the
 * project-wide counterpart to EntityPanel.tsx's own per-entity subscribe
 * button. Unlike the regenerate section just above (owner-only, since
 * rotating the token breaks every collaborator's subscription), this one
 * must be visible and usable for a plain, non-owner collaborator too --
 * GET .../calendar-feed-token (which this button calls) uses
 * requireProjectAccess, not requireProjectOwner, the exact same access any
 * collaborator already has to EntityPanel.tsx's own per-entity button.
 */
test("CollaboratorsPanel's \"Subscribe to combined calendar\" button is visible to a plain collaborator (not just the owner), and copies the real all/feed.ics URL built from the real token", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj1/calendar-feed-token") {
        tokenCalls += 1;
        return new Response(JSON.stringify({ token: "real-feed-token" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | null = null;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => { writtenText = text; } },
      configurable: true,
    });

    try {
      // Not the owner -- confirms this button is reachable for a plain collaborator too.
      renderPanel(false);
      await waitForCondition(() => document.querySelector(".collab-calendar-subscribe-all-section") !== null);
      assert.equal(
        document.querySelector(".collab-calendar-feed-section"),
        null,
        "a plain collaborator must still never see the owner-only regenerate section",
      );

      const button = document.querySelector(".collab-calendar-subscribe-all-section button") as HTMLButtonElement;
      fireEvent.click(button);
      await waitForCondition(() => tokenCalls === 1);
      await waitForCondition(() => writtenText !== null);

      assert.equal(writtenText, `${window.location.origin}/api/public/calendar/proj1/all/feed.ics?token=real-feed-token`);
    } finally {
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * Round 1062: this panel is a real dialog (useDialogFocusTrap), whose own
 * Escape handler closes the whole thing unless the event's target sits
 * under data-escape-handled-locally -- the invite email input never had
 * that marker. The whole component unmounts on close (App.tsx renders it
 * conditionally), so the typed email isn't just visually cleared, it's
 * destroyed. Passes a REAL onClose spy (not the no-op renderPanel's own
 * default uses) specifically to prove Escape here only clears the invite
 * draft and never also closes the panel, mirroring the identical test
 * already added for AutomationsPanel (round 1056) and WhatsAppPanel
 * (round 1061).
 */
test("CollaboratorsPanel's invite form has Escape-to-clear for an in-progress draft, and a second Escape on the now-pristine form closes the dialog normally", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    let closeCalls = 0;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(CollaboratorsPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              isOwner: true,
              currentUserId: undefined,
              onClose: () => {
                closeCalls += 1;
              },
              onLeft: () => {},
              onOwnerTransferred: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".collab-invite-form") !== null);
      assert.ok(document.querySelector('[role="dialog"]'), "sanity check: a real dialog wired to the real onClose must be open");

      const emailInput = document.querySelector(".collab-invite-form input[type='email']") as HTMLInputElement;
      fireEvent.change(emailInput, { target: { value: "teammate@example.com" } });

      fireEvent.keyDown(emailInput, { key: "Escape" });
      assert.equal(emailInput.value, "", "Escape must clear the drafted email");
      assert.equal(closeCalls, 0, "Escape clearing an in-progress invite draft must never also close the whole dialog");
      assert.ok(document.querySelector('[role="dialog"]'), "the dialog itself must still be in the DOM after that Escape");

      // Mirrors the identical round-362/1056/1061 regression: once the
      // form is genuinely pristine (nothing left to clear), Escape must
      // close the dialog normally, not get silently swallowed.
      fireEvent.keyDown(emailInput, { key: "Escape" });
      assert.equal(closeCalls, 1, "Escape on an already-pristine invite form must close the dialog normally");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1112: every other read-heavy "who/what does this project have"
 * overlay panel in this app (Business Twin, WhatsApp log, Time Machine,
 * Global Search, Automations, EntityPanel's own CSV copy, BuildProgress)
 * already has a Copy companion action -- Collaborators was the one panel
 * left with no way to take its access list anywhere at all, short of a
 * screenshot or transcribing it by hand. Confirms neither button renders
 * before the real fetch resolves, both appear once the owner/collaborator
 * list has loaded, and clicking Copy writes the real formatted report
 * (not a placeholder) to the clipboard.
 */

/**
 * Round 1170: previously the only way an owner could stop being
 * responsible for a project was deleting it outright -- destroying it for
 * every collaborator. Confirms the owner's "Transfer ownership" button
 * asks for confirmation, sends a real POST on confirm, updates the
 * collaborators/owner list from the server's fresh response, and reports
 * the new ownerId back to the caller via onOwnerTransferred -- the signal
 * the host app uses (the same way ProjectNameEditor's onRenamed already
 * does) to update its own held Project and flip every owner-gated control.
 */
test("CollaboratorsPanel's transfer-ownership button asks for confirmation, sends a real POST on confirm, and reports the new owner back via onOwnerTransferred", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const dana = makeCollaborator("u1", "dana@example.com", "editor");
    let transferCalls = 0;
    let confirmMessage: string | undefined;
    let reportedProject: Project | undefined;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/transfer-ownership") {
        transferCalls += 1;
        assert.deepEqual(JSON.parse(init!.body as string), { userId: "u1" });
        return new Response(
          JSON.stringify({
            collaborators: [makeCollaborator("owner1", "amit@example.com", "editor")],
            owner: { userId: "u1", email: "dana@example.com" },
            project: { id: "proj1", ownerId: "u1", name: "Test Project" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = ((message: string) => {
      confirmMessage = message;
      return true;
    }) as typeof window.confirm;

    try {
      renderPanel(true, undefined, () => {}, "Test Project", (project) => {
        reportedProject = project;
      });
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const row = Array.from(document.querySelectorAll(".collab-list li")).find((li) => li.textContent?.includes("dana@example.com"))!;
      const transferBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.includes("Transfer ownership"))!;
      fireEvent.click(transferBtn);

      assert.match(confirmMessage ?? "", /dana@example\.com/, "the confirmation must name the real target collaborator's email");
      await waitForCondition(() => transferCalls === 1);
      await waitForCondition(() => reportedProject?.ownerId === "u1");
      await waitForCondition(() => document.body.textContent?.includes("Ownership transferred") ?? false);

      // The new owner must no longer appear as a collaborator row, and the
      // previous owner must now show up as a real "editor" collaborator.
      assert.equal(
        document.querySelectorAll(".collab-list li").length,
        2,
        "the owner row plus exactly one collaborator row (the previous owner, now demoted)",
      );
      assert.ok(document.body.textContent?.includes("amit@example.com"), "the previous owner must now be listed as a collaborator");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 1195: transferProjectOwnership demotes the previous owner to a
 * brand-new "editor" collaborator row with a fresh addedAt (see that
 * function's own doc comment in packages/db/src/projects.ts) -- which is
 * exactly the same shape listProjectsForUser's own sharedAt join uses to
 * decide the home screen's "New share!" badge. Without the acting owner's
 * own fresh addedAt being passed up and immediately acknowledged (the same
 * way openExistingProject already acknowledges an ordinary shared-project
 * open), transferring ownership away left the former owner's own project
 * looking like a brand-new invite from someone else on their very next
 * trip to the home screen. Confirms onOwnerTransferred's second argument
 * is the acting user's own real addedAt from the server's fresh
 * collaborators response, not undefined and not some other collaborator's.
 */
test("CollaboratorsPanel's transfer-ownership reports the acting owner's own fresh addedAt via onOwnerTransferred's second argument, so the caller can pre-acknowledge it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const dana = makeCollaborator("u1", "dana@example.com", "editor");
    const demotedOwnerAddedAt = "2024-05-01T12:00:00.000Z";

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/transfer-ownership") {
        return new Response(
          JSON.stringify({
            collaborators: [{ userId: "owner1", email: "amit@example.com", addedAt: demotedOwnerAddedAt, role: "editor" }],
            owner: { userId: "u1", email: "dana@example.com" },
            project: { id: "proj1", ownerId: "u1", name: "Test Project" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    let reportedSelfSharedAt: string | undefined = "not-called";
    try {
      // currentUserId is "owner1" -- the acting owner giving the project
      // away, not the new owner "u1" -- mirroring the real-world actor.
      renderPanel(true, "owner1", () => {}, "Test Project", (_project, selfSharedAt) => {
        reportedSelfSharedAt = selfSharedAt;
      });
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 2);

      const row = Array.from(document.querySelectorAll(".collab-list li")).find((li) => li.textContent?.includes("dana@example.com"))!;
      const transferBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.includes("Transfer ownership"))!;
      fireEvent.click(transferBtn);

      await waitForCondition(() => reportedSelfSharedAt !== "not-called");
      assert.equal(
        reportedSelfSharedAt,
        demotedOwnerAddedAt,
        "must report the acting owner's own real fresh addedAt from the server's response, not undefined or some other collaborator's",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

test("CollaboratorsPanel's transfer-ownership button, when declined, leaves the collaborator list and the server untouched", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const dana = makeCollaborator("u1", "dana@example.com");
    let transferCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/collaborators") {
        return new Response(JSON.stringify({ collaborators: [dana] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/transfer-ownership") {
        transferCalls += 1;
        return new Response(JSON.stringify({ collaborators: [dana], owner: null, project: { id: "proj1", ownerId: "u1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => false) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".collab-list li").length === 1);

      const row = document.querySelector(".collab-list li")!;
      const transferBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.includes("Transfer ownership"))!;
      fireEvent.click(transferBtn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(transferCalls, 0, "declining the confirmation must never call the real transfer-ownership endpoint");
      assert.equal(document.querySelectorAll(".collab-list li").length, 1, "the collaborator must still be listed, unchanged");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

test("CollaboratorsPanel shows Copy/Download buttons only once loaded, and Copy writes the real formatted report to the clipboard", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dana = makeCollaborator("u1", "dana@example.com", "viewer");
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/collaborators") {
        return new Response(
          JSON.stringify({ collaborators: [dana], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderPanel(true, undefined, () => {}, "Marketing Site");

      assert.equal(
        Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("Copy list")),
        false,
        "no Copy button should render before the real fetch has resolved",
      );

      await waitForCondition(() => document.querySelector(".collab-count") !== null);

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Copy list"));
      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download list"));
      assert.ok(copyButton, "expected a Copy list button once the owner/collaborator list has loaded");
      assert.ok(downloadButton, "expected a Download list button once the owner/collaborator list has loaded");
      assert.equal(copyButton!.getAttribute("aria-live"), "polite");
      assert.equal(copyButton!.getAttribute("aria-atomic"), "true");

      t.mock.timers.enable({ apis: ["setTimeout"] });

      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Marketing Site/, "the copied text must include the real project name");
      assert.match(writtenText!, /amit@example\.com/, "the copied text must include the real owner's email");
      assert.match(writtenText!, /dana@example\.com/, "the copied text must include the real collaborator's email");
      assert.equal(copyButton!.textContent, "✅ Copied!");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy list", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

test("CollaboratorsPanel's Download button downloads the real list as a named file", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/collaborators") {
        return new Response(
          JSON.stringify({ collaborators: [], owner: { userId: "owner1", email: "amit@example.com" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    // jsdom doesn't implement the real Blob-URL machinery -- stub just
    // enough of it to observe what the click handler actually does, the
    // same technique AutomationsPanel.test.ts's own download test uses.
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    const anchorProto = (globalThis as unknown as { window: { HTMLAnchorElement: { prototype: HTMLAnchorElement } } }).window
      .HTMLAnchorElement.prototype;
    const originalAnchorClick = anchorProto.click;
    let capturedDownloadName: string | null = null;
    let clickCount = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:mock-url";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    anchorProto.click = function (this: HTMLAnchorElement) {
      capturedDownloadName = this.download;
      clickCount += 1;
    };

    try {
      renderPanel(true, undefined, () => {}, "Marketing Site");
      await waitForCondition(() => document.querySelector(".collab-count") !== null);

      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download list"));
      assert.ok(downloadButton, "expected a Download list button once the owner/collaborator list has loaded");

      fireEvent.click(downloadButton!);

      assert.equal(clickCount, 1, "clicking the download button must trigger exactly one real anchor click");
      const downloadName: string = capturedDownloadName ?? "";
      assert.ok(
        downloadName.includes("Marketing-Site") || downloadName.includes("Marketing Site"),
        `expected the downloaded filename to be derived from the real project name, got "${downloadName}"`,
      );
      assert.ok(downloadName.endsWith("collaborators.txt"), `expected a collaborators.txt filename, got "${downloadName}"`);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      anchorProto.click = originalAnchorClick;
    }
  });
});
