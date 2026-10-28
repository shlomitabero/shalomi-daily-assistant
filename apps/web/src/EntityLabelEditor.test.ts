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
      React.createElement(LanguageProvider, null, React.createElement(EntityLabelEditor, { entity, allEntities: [entity], projectId: "proj1", onRenamed })),
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
 * Round 1040: EntitySchema only enforces uniqueness on an entity's
 * `name`, never its `label` -- this heading is the only confirmation of
 * which entity's panel is actually on screen, so two entities sharing a
 * label rendered byte-identical, indistinguishable headings here.
 */
test("the entity label heading is disambiguated by its own entity name when another entity shares the same label, but the rename draft is pre-filled with the plain label", async () => {
  await withJsdom(async () => {
    const otherEntity: Entity = { name: "Lead", label: "Original Label", fields: [{ name: "name", type: "text", required: true }] };
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(EntityLabelEditor, { entity, allEntities: [entity, otherEntity], projectId: "proj1", onRenamed: () => {} }),
        ),
      ),
    );

    const heading = document.querySelector(".entity-label") as HTMLElement;
    assert.ok(heading.textContent?.startsWith("Original Label (Customer)"), "the heading must be disambiguated by this entity's own name");

    fireEvent.click(heading);
    await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
    const input = document.querySelector(".entity-label-edit input") as HTMLInputElement;
    assert.equal(input.value, "Original Label", "the rename draft must be pre-filled with the plain label, not the disambiguated display text");
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap in this sibling component. */
test("the entity label heading is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderEditor(() => {});

    const heading = document.querySelector(".entity-label") as HTMLElement;
    assert.equal(heading.getAttribute("role"), "button");
    assert.equal(heading.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(heading, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
    assert.ok(document.querySelector(".entity-label-edit input"), "Enter should have entered edit mode");
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
test("renaming the entity label, cancelling with Escape, then renaming it again for real must not be silently swallowed", async () => {
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

      // First session: start, change the draft, then cancel with Escape.
      fireEvent.click(document.querySelector(".entity-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
      let input = document.querySelector(".entity-label-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await waitForCondition(() => document.querySelector(".entity-label-edit") === null);
      assert.equal(renameCalls, 0, "Escape must not itself trigger a rename");

      // Second session on the SAME instance: a real rename, saved via blur.
      fireEvent.click(document.querySelector(".entity-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
      input = document.querySelector(".entity-label-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "A Much Better Label" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.equal(renameCalls, 1, "the real rename after a prior cancel must not be swallowed");
      assert.equal(renamedProjects[0].spec.entities[0].label, "A Much Better Label");
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
test("a failed label rename shows its error with role=alert, so a screen reader announces it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "That label is already taken." }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      renderEditor(() => {});
      fireEvent.click(document.querySelector(".entity-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".entity-label-edit input") !== null);
      const input = document.querySelector(".entity-label-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "A Different Label" } });
      fireEvent.blur(input);

      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "alert");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
