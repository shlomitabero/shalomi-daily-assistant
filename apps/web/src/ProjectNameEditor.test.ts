import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Project } from "@forge/shared";
import { ProjectNameEditor } from "./ProjectNameEditor.js";
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

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "Original Name",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: { summary: "s", personas: [], roles: ["Admin"], entities: [], screens: [], assumptions: [], openQuestions: [] },
};

function renderEditor(onRenamed: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(ProjectNameEditor, { project, onRenamed })),
    ),
  );
}

test("clicking the project name enters edit mode, and saving a real change calls renameProject and reports the result", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/name") {
        renameCalls += 1;
        const body = JSON.parse(init.body as string) as { name: string };
        return new Response(JSON.stringify({ project: { ...project, name: body.name } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEditor((p) => renamedProjects.push(p));

      const heading = document.querySelector(".project-name") as HTMLElement;
      assert.ok(heading, "expected the clickable project name heading");
      fireEvent.click(heading);

      const input = (await waitForCondition(() => document.querySelector(".project-name-edit input") !== null).then(
        () => document.querySelector(".project-name-edit input") as HTMLInputElement,
      ))!;
      assert.equal(input.value, "Original Name");

      fireEvent.change(input, { target: { value: "A Much Better Name" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.equal(renameCalls, 1);
      assert.equal(renamedProjects[0].name, "A Much Better Name");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Locks in the observable outcome of pressing Escape: no rename request,
 * no onRenamed call, back to the read-only view showing the original
 * name. This does NOT exercise the `cancelling` ref guard itself --
 * empirically confirmed (a throwaway probe script, deleted before this
 * commit) that jsdom, unlike real Chromium, does not fire a "blur" event
 * when the focused element is removed from the DOM, so removing the
 * guard entirely still passes this test in jsdom. The guard exists for a
 * real browser risk, confirmed with a direct Playwright probe against
 * real Chromium instead (removing a focused input DOES dispatch blur
 * there) and with an end-to-end Playwright pass on the actual running
 * app (see docs/roadmap.md's entry for this round) -- this test is kept
 * anyway as real, if narrower, coverage of Escape's basic contract.
 */
test("pressing Escape while editing cancels without saving, and returns to the read-only view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async () => {
      renameCalls += 1;
      throw new Error("renameProject must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEditor((p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".project-name") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-name-edit input") !== null);
      const input = document.querySelector(".project-name-edit input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      // The Escape handler unmounts the input synchronously; give any
      // spurious blur-triggered save a real chance to fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renameCalls, 0, "Escape must not trigger a rename request");
      assert.equal(renamedProjects.length, 0);
      assert.equal(
        document.querySelector(".project-name-edit"),
        null,
        "should be back to the non-editing view after Escape",
      );
      assert.match((document.querySelector(".project-name") as HTMLElement).textContent ?? "", /Original Name/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
