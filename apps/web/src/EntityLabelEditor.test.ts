import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Entity, Project } from "@forge/shared";
import { EntityLabelEditor } from "./EntityLabelEditor.js";
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

const entity: Entity = {
  name: "Customer",
  label: "Original Label",
  fields: [{ name: "name", type: "text", required: true }],
};

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "Test Project",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: { summary: "s", personas: [], roles: ["Admin"], entities: [entity], screens: [], assumptions: [], openQuestions: [] },
};

function renderEditor(onRenamed: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(EntityLabelEditor, { entity, projectId: "proj1", onRenamed })),
    ),
  );
}

test("clicking the entity label enters edit mode, and saving a real change calls renameEntityLabel and reports the result", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/label") {
        renameCalls += 1;
        const body = JSON.parse(init.body as string) as { label: string };
        const renamedEntity = { ...entity, label: body.label };
        return new Response(
          JSON.stringify({ project: { ...project, spec: { ...project.spec, entities: [renamedEntity] } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEditor((p) => renamedProjects.push(p));

      const heading = document.querySelector(".entity-label") as HTMLElement;
      assert.ok(heading, "expected the clickable entity label heading");
      fireEvent.click(heading);

      await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
      const input = document.querySelector(".entity-label-edit input") as HTMLInputElement;
      assert.equal(input.value, "Original Label");

      fireEvent.change(input, { target: { value: "A Much Better Label" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.equal(renameCalls, 1);
      assert.equal(renamedProjects[0].spec.entities[0].label, "A Much Better Label");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Locks in the observable outcome of pressing Escape, the same narrower
 * (but real) contract ProjectNameEditor.test.ts's identical test documents
 * -- this does NOT exercise the `cancelling` ref guard itself, since jsdom
 * doesn't fire a real "blur" when the focused element is removed from the
 * DOM the way real Chromium does (see that file's own comment and this
 * round's Playwright verification in docs/roadmap.md).
 */
test("pressing Escape while editing cancels without saving, and returns to the read-only view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async () => {
      renameCalls += 1;
      throw new Error("renameEntityLabel must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEditor((p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".entity-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
      const input = document.querySelector(".entity-label-edit input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renameCalls, 0, "Escape must not trigger a rename request");
      assert.equal(renamedProjects.length, 0);
      assert.equal(document.querySelector(".entity-label-edit"), null, "should be back to the non-editing view after Escape");
      assert.match((document.querySelector(".entity-label") as HTMLElement).textContent ?? "", /Original Label/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
