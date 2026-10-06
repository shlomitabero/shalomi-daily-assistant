import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Field, Project } from "@forge/shared";
import { FieldLabelEditor } from "./FieldLabelEditor.js";
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

const field: Field = { name: "phone", label: "Original Field Label", type: "text", required: true };

const project: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "Test Project",
  description: "test",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "s",
    personas: [],
    roles: ["Admin"],
    entities: [{ name: "Customer", fields: [field] }],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

function renderEditor(onRenamed: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(FieldLabelEditor, { entityName: "Customer", field, projectId: "proj1", onRenamed }),
      ),
    ),
  );
}

test("clicking the field's rename button enters edit mode, and saving a real change calls renameFieldLabel and reports the result", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/phone/label") {
        renameCalls += 1;
        const body = JSON.parse(init.body as string) as { label: string };
        const renamedField = { ...field, label: body.label };
        return new Response(
          JSON.stringify({
            project: {
              ...project,
              spec: { ...project.spec, entities: [{ ...project.spec.entities[0], fields: [renamedField] }] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEditor((p) => renamedProjects.push(p));

      const labelSpan = document.querySelector(".field-label") as HTMLElement;
      assert.ok(labelSpan, "expected the field label span");
      assert.match(labelSpan.textContent ?? "", /Original Field Label/);
      assert.match(labelSpan.textContent ?? "", /\*/, "required field must show the * marker");

      const editButton = document.querySelector(".field-label-edit-btn") as HTMLElement;
      assert.ok(editButton, "expected a dedicated rename button, not the whole label as the click target");
      fireEvent.click(editButton);

      await waitForCondition(() => document.querySelector(".field-label-edit input") !== null);
      const input = document.querySelector(".field-label-edit input") as HTMLInputElement;
      assert.equal(input.value, "Original Field Label");

      fireEvent.change(input, { target: { value: "A Much Better Field Label" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.equal(renameCalls, 1);
      assert.equal(renamedProjects[0].spec.entities[0].fields[0].label, "A Much Better Field Label");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Same narrower (but real) Escape contract EntityLabelEditor.test.ts's
 * identical test documents -- doesn't exercise the `cancelling` ref guard
 * itself (jsdom doesn't fire a real "blur" on unmount the way real
 * Chromium does), verified separately via this round's Playwright pass.
 */
test("pressing Escape while editing cancels without saving, and returns to the read-only view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async () => {
      renameCalls += 1;
      throw new Error("renameFieldLabel must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEditor((p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".field-label-edit-btn") as HTMLElement);
      await waitForCondition(() => document.querySelector(".field-label-edit input") !== null);
      const input = document.querySelector(".field-label-edit input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renameCalls, 0, "Escape must not trigger a rename request");
      assert.equal(renamedProjects.length, 0);
      assert.equal(document.querySelector(".field-label-edit"), null, "should be back to the non-editing view after Escape");
      assert.match((document.querySelector(".field-label") as HTMLElement).textContent ?? "", /Original Field Label/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the edit button click does not bubble into the surrounding <label>'s default click-forwarding behavior", async () => {
  await withJsdom(async () => {
    try {
      let labelClickBubbled = false;
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(
              "label",
              { onClick: () => (labelClickBubbled = true) },
              React.createElement(FieldLabelEditor, { entityName: "Customer", field, projectId: "proj1", onRenamed: () => {} }),
            ),
          ),
        ),
      );

      fireEvent.click(document.querySelector(".field-label-edit-btn") as HTMLElement);
      assert.equal(labelClickBubbled, false, "the rename button's click must not bubble up to the wrapping <label>");
    } finally {
      cleanup();
    }
  });
});
