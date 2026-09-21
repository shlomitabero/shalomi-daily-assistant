import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Checkpoint, Project } from "@forge/shared";
import { HistoryPanel } from "./HistoryPanel.js";
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

function makeCheckpoint(id: string, label: string): Checkpoint {
  return {
    id,
    projectId: "proj1",
    label,
    spec: {
      summary: "s",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Regression test: handleRestore only disabled the ONE button whose own
 * checkpoint.id matched the in-flight busyId, leaving every other
 * checkpoint's restore button clickable while a restore request was still
 * pending. Clicking a second checkpoint's restore button in that window
 * fired a second, concurrent restoreCheckpoint request -- whichever
 * response landed last would silently overwrite the other's result via
 * onRestored, with no error and no visible sign anything had raced. Fixed
 * by disabling every restore button (not just the busy row's) whenever any
 * restore is in flight (`disabled={busyId !== null}`).
 */
test("HistoryPanel disables every restore button while one restore is in flight, so a second checkpoint can't be restored concurrently", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    const cp2 = makeCheckpoint("cp2", "Refine: add invoices");
    let restore1Resolved = false;
    let resolveRestore1!: (value: Response) => void;
    let restore2Calls = 0;
    const restoredProjects: string[] = [];

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        // Rendered in this exact order (the component doesn't re-sort), so
        // buttons[0] is cp1's own restore button (held open below) and
        // buttons[1] is cp2's (must never fire while cp1 is in flight).
        return new Response(JSON.stringify({ checkpoints: [cp1, cp2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/checkpoints/cp1/restore") {
        return new Promise<Response>((resolve) => {
          resolveRestore1 = (value) => {
            restore1Resolved = true;
            resolve(value);
          };
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/checkpoints/cp2/restore") {
        restore2Calls += 1;
        return new Response(JSON.stringify({ project: { id: "proj1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              onRestored: (project: Project) => restoredProjects.push(project.id),
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      const buttons = Array.from(document.querySelectorAll(".checkpoint-list button")) as HTMLButtonElement[];
      assert.equal(buttons.length, 2, "expected one restore button per checkpoint");

      // Click the first checkpoint's restore button -- its request is held
      // open (resolveRestore1 not yet called) to simulate "still in flight".
      fireEvent.click(buttons[0]);
      await waitForCondition(() => buttons[0].disabled && buttons[1].disabled);

      // Attempting to restore the second checkpoint while the first is
      // still pending must be a no-op: the button is disabled, so the real
      // browser (and jsdom, confirmed empirically) never dispatches the
      // click to React's handler at all.
      fireEvent.click(buttons[1]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(restore2Calls, 0, "a disabled second restore button must never fire a second restore request");

      resolveRestore1(
        new Response(JSON.stringify({ project: { id: "proj1-restored" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await waitForCondition(() => restoredProjects.length === 1);
      assert.deepEqual(restoredProjects, ["proj1-restored"]);
    } finally {
      // Guards against leaking the real, un-mocked REQUEST_TIMEOUT_MS
      // (180s) timer api.ts's request() starts for cp1's restore -- if an
      // assertion above throws before the request is otherwise resolved,
      // that live timer would keep this test file's process alive well
      // past any reasonable shell-level timeout (the exact "permanently-
      // pending fetch mock" footgun this project's own tests avoid
      // elsewhere).
      if (!restore1Resolved) {
        resolveRestore1(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      globalThis.fetch = originalFetch;
    }
  });
});
