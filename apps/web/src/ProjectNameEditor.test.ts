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
 * Keyboard-only access: the heading must be focusable and activatable with
 * Enter, not just a mouse click, since this is the project's only path to
 * renaming it. Mirrors the keyboard pattern already used by EntityPanel.tsx's
 * calendar-day cells (role="button" + tabIndex={0} + onKeyDown on Enter/Space).
 */
test("the project name heading is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderEditor(() => {});

    const heading = document.querySelector(".project-name") as HTMLElement;
    assert.equal(heading.getAttribute("role"), "button");
    assert.equal(heading.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(heading, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".project-name-edit input") !== null);
    assert.ok(document.querySelector(".project-name-edit input"), "Enter should have entered edit mode");
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

/**
 * Regression test for a real bug found by round 1087's Explore survey: the
 * `cancelling` ref's whole design assumes the spurious post-cancel blur
 * really does re-invoke save() once, so it can reset the flag back to
 * false there. A direct Playwright probe against real Chromium (not
 * jsdom, which can't dispatch blur-on-unmount at all) found that this
 * assumption is wrong -- React never redelivers that blur to an
 * already-unmounted fiber's onBlur -- so the flag set by cancelEditing()
 * stays `true` forever and silently swallows the very next real save on
 * this same instance, with no error and no visible sign anything is
 * wrong. This doesn't depend on the browser-only blur-on-unmount
 * mechanism to reproduce: once cancelEditing() has set the flag, ANY
 * subsequent save() call (fired here directly via blur, exactly as a real
 * second edit session would) is wrongly swallowed, regardless of how the
 * flag got stuck. Fixed by resetting it in startEditing() too.
 */
test("renaming, cancelling with Escape, then renaming again for real must not be silently swallowed", async () => {
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

      // First session: start, change the draft, then cancel with Escape.
      fireEvent.click(document.querySelector(".project-name") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-name-edit input") !== null);
      let input = document.querySelector(".project-name-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await waitForCondition(() => document.querySelector(".project-name-edit") === null);
      assert.equal(renameCalls, 0, "Escape must not itself trigger a rename");

      // Second session on the SAME instance: a real rename, saved via blur.
      fireEvent.click(document.querySelector(".project-name") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-name-edit input") !== null);
      input = document.querySelector(".project-name-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "A Much Better Name" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.equal(renameCalls, 1, "the real rename after a prior cancel must not be swallowed");
      assert.equal(renamedProjects[0].name, "A Much Better Name");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1158: a failed rename's error message had no role at all, unlike
 * every other panel's own error text in this app (role="status"/"alert").
 * A screen-reader user got zero announcement that the rename failed.
 */
test("a failed rename shows its error with role=alert, so a screen reader announces it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "That name is already taken." }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      renderEditor(() => {});
      fireEvent.click(document.querySelector(".project-name") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-name-edit input") !== null);
      const input = document.querySelector(".project-name-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "A Different Name" } });
      fireEvent.blur(input);

      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
