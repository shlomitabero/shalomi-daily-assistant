import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Checkpoint } from "@forge/shared";
import { CheckpointLabelEditor } from "./CheckpointLabelEditor.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

/** Same jsdom-swap technique as EntityLabelEditor.test.ts, whose click-to-edit shape this component mirrors exactly. */
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

const checkpoint: Checkpoint = {
  id: "cp1",
  projectId: "proj1",
  label: "Initial build",
  kind: "build",
  spec: { summary: "s", personas: [], roles: ["Admin"], entities: [], screens: [], assumptions: [], openQuestions: [] },
  createdAt: new Date().toISOString(),
};

function renderEditor(onRenamed: (c: Checkpoint) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(CheckpointLabelEditor, { checkpoint, projectId: "proj1", onRenamed })),
    ),
  );
}

test("clicking the checkpoint label enters edit mode, and saving a real change calls renameCheckpoint and reports the result", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/checkpoints/cp1") {
        renameCalls += 1;
        const body = JSON.parse(init.body as string) as { label: string };
        return new Response(
          JSON.stringify({ checkpoint: { ...checkpoint, label: body.label } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamed: Checkpoint[] = [];
      renderEditor((c) => renamed.push(c));

      const label = document.querySelector(".checkpoint-label") as HTMLElement;
      assert.ok(label, "expected the clickable checkpoint label");
      fireEvent.click(label);

      await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
      const input = document.querySelector(".checkpoint-label-edit input") as HTMLInputElement;
      assert.equal(input.value, "Initial build");

      fireEvent.change(input, { target: { value: "before the pricing overhaul" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamed.length === 1);
      assert.equal(renameCalls, 1);
      assert.equal(renamed[0].label, "before the pricing overhaul");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap in this sibling component. */
test("the checkpoint label is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderEditor(() => {});

    const label = document.querySelector(".checkpoint-label") as HTMLElement;
    assert.equal(label.getAttribute("role"), "button");
    assert.equal(label.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(label, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
    assert.ok(document.querySelector(".checkpoint-label-edit input"), "Enter should have entered edit mode");
  });
});

/**
 * Locks in the observable outcome of pressing Escape, the same narrower
 * (but real) contract EntityLabelEditor.test.ts's identical test documents
 * -- this does NOT exercise the `cancelling` ref guard itself, since jsdom
 * doesn't fire a real "blur" when the focused element is removed from the
 * DOM the way real Chromium does.
 */
test("pressing Escape while editing a checkpoint label cancels without saving, and returns to the read-only view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async () => {
      renameCalls += 1;
      throw new Error("renameCheckpoint must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamed: Checkpoint[] = [];
      renderEditor((c) => renamed.push(c));

      fireEvent.click(document.querySelector(".checkpoint-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
      const input = document.querySelector(".checkpoint-label-edit input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renameCalls, 0, "Escape must not trigger a rename request");
      assert.equal(renamed.length, 0);
      assert.equal(document.querySelector(".checkpoint-label-edit"), null, "should be back to the non-editing view after Escape");
      assert.match((document.querySelector(".checkpoint-label") as HTMLElement).textContent ?? "", /Initial build/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Mirrors ProjectNameEditor's/EntityLabelEditor's own "no-op save" contract:
 * clicking away without actually changing the text (a common way to just
 * glance at the current label) must not send a request at all, and must
 * still return to the read-only view.
 */
test("blurring without changing the checkpoint label is a no-op -- no request sent", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async () => {
      renameCalls += 1;
      throw new Error("renameCheckpoint must never be called when the label was not actually changed");
    }) as typeof fetch;

    try {
      const renamed: Checkpoint[] = [];
      renderEditor((c) => renamed.push(c));

      fireEvent.click(document.querySelector(".checkpoint-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
      const input = document.querySelector(".checkpoint-label-edit input") as HTMLInputElement;

      fireEvent.blur(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renameCalls, 0);
      assert.equal(renamed.length, 0);
      assert.equal(document.querySelector(".checkpoint-label-edit"), null, "should be back to the read-only view");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
