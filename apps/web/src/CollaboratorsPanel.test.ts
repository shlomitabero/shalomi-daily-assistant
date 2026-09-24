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

function renderPanel() {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(CollaboratorsPanel, { projectId: "proj1", isOwner: true, onClose: () => {} }),
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
