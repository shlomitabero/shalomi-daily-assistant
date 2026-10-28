import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Project } from "@forge/shared";
import { ProjectDescriptionEditor } from "./ProjectDescriptionEditor.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

/** Same jsdom-swap technique as ProjectNameEditor.test.ts. */
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
  description: "A CRM with customers and deals, typo: paymints.",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: { summary: "s", personas: [], roles: ["Admin"], entities: [], screens: [], assumptions: [], openQuestions: [] },
};

function renderEditor(onChanged: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(ProjectDescriptionEditor, { project, onChanged })),
    ),
  );
}

test("clicking the description enters edit mode, and saving a real change calls updateProjectDescription and reports the result", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let editCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/description") {
        editCalls += 1;
        const body = JSON.parse(init.body as string) as { description: string };
        return new Response(JSON.stringify({ project: { ...project, description: body.description } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderEditor((p) => changedProjects.push(p));

      const paragraph = document.querySelector(".project-description") as HTMLElement;
      assert.ok(paragraph, "expected the clickable description paragraph");
      fireEvent.click(paragraph);

      const textarea = (await waitForCondition(
        () => document.querySelector(".project-description-edit textarea") !== null,
      ).then(() => document.querySelector(".project-description-edit textarea") as HTMLTextAreaElement))!;
      assert.equal(textarea.value, project.description);

      fireEvent.change(textarea, { target: { value: "A CRM with customers and deals, with payments." } });
      fireEvent.blur(textarea);

      await waitForCondition(() => changedProjects.length === 1);
      assert.equal(editCalls, 1);
      assert.equal(changedProjects[0].description, "A CRM with customers and deals, with payments.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap in this sibling component. */
test("the description paragraph is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderEditor(() => {});

    const paragraph = document.querySelector(".project-description") as HTMLElement;
    assert.equal(paragraph.getAttribute("role"), "button");
    assert.equal(paragraph.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(paragraph, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".project-description-edit textarea") !== null);
    assert.ok(document.querySelector(".project-description-edit textarea"), "Enter should have entered edit mode");
  });
});

/** Mirrors ProjectNameEditor.test.ts's own Escape test -- same rationale for not exercising the `cancelling` ref itself under jsdom. */
test("pressing Escape while editing cancels without saving, and returns to the read-only view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let editCalls = 0;
    globalThis.fetch = (async () => {
      editCalls += 1;
      throw new Error("updateProjectDescription must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderEditor((p) => changedProjects.push(p));

      fireEvent.click(document.querySelector(".project-description") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-description-edit textarea") !== null);
      const textarea = document.querySelector(".project-description-edit textarea") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(textarea, { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(editCalls, 0, "Escape must not trigger an edit request");
      assert.equal(changedProjects.length, 0);
      assert.equal(
        document.querySelector(".project-description-edit"),
        null,
        "should be back to the non-editing view after Escape",
      );
      assert.match((document.querySelector(".project-description") as HTMLElement).textContent ?? "", /paymints/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for a real bug found by round 1087's Explore survey: the
 * `cancelling` ref's design assumes the spurious post-cancel blur really
 * does re-invoke save() once, letting it reset the flag back to false
 * there. A direct Playwright probe against real Chromium found this
 * assumption wrong -- that blur never reaches an already-unmounted
 * fiber's onBlur -- so the flag set by cancelEditing() stays `true`
 * forever and silently swallows the very next real save, with no error.
 * Fixed by resetting the flag in startEditing() too.
 */
test("editing the description, cancelling with Escape, then editing it again for real must not be silently swallowed", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let editCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/description") {
        editCalls += 1;
        const body = JSON.parse(init.body as string) as { description: string };
        return new Response(JSON.stringify({ project: { ...project, description: body.description } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderEditor((p) => changedProjects.push(p));

      // First session: start, change the draft, then cancel with Escape.
      fireEvent.click(document.querySelector(".project-description") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-description-edit textarea") !== null);
      let textarea = document.querySelector(".project-description-edit textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(textarea, { key: "Escape" });
      await waitForCondition(() => document.querySelector(".project-description-edit") === null);
      assert.equal(editCalls, 0, "Escape must not itself trigger an edit request");

      // Second session on the SAME instance: a real edit, saved via blur.
      fireEvent.click(document.querySelector(".project-description") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-description-edit textarea") !== null);
      textarea = document.querySelector(".project-description-edit textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "A CRM with customers and deals, with payments." } });
      fireEvent.blur(textarea);

      await waitForCondition(() => changedProjects.length === 1);
      assert.equal(editCalls, 1, "the real edit after a prior cancel must not be swallowed");
      assert.equal(changedProjects[0].description, "A CRM with customers and deals, with payments.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("saving an empty or whitespace-only draft cancels back to the read-only view instead of sending a request", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let editCalls = 0;
    globalThis.fetch = (async () => {
      editCalls += 1;
      throw new Error("updateProjectDescription must never be called for a blank draft");
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderEditor((p) => changedProjects.push(p));

      fireEvent.click(document.querySelector(".project-description") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-description-edit textarea") !== null);
      const textarea = document.querySelector(".project-description-edit textarea") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "   " } });
      fireEvent.blur(textarea);

      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(editCalls, 0);
      assert.equal(changedProjects.length, 0);
      assert.equal(document.querySelector(".project-description-edit"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1158: a failed edit's error message had no role at all, unlike
 * every other panel's own error text in this app (role="status"/"alert").
 * A screen-reader user got zero announcement that the edit failed.
 */
test("a failed description edit shows its error with role=alert, so a screen reader announces it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Server exploded." }), { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      renderEditor(() => {});
      fireEvent.click(document.querySelector(".project-description") as HTMLElement);
      await waitForCondition(() => document.querySelector(".project-description-edit textarea") !== null);
      const textarea = document.querySelector(".project-description-edit textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "A new real description." } });
      fireEvent.blur(textarea);

      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
