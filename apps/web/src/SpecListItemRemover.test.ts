import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Project } from "@forge/shared";
import { AddAssumptionForm, AddRoleForm, AssumptionItem, RoleChip } from "./SpecListItemRemover.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

/** Same jsdom-swap technique as EntityLabelEditor.test.ts and the rest of this project's real-DOM tests. */
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

const baseProject: Project = {
  id: "proj1",
  ownerId: "user1",
  name: "Test Project",
  description: "test",
  status: "draft",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "s",
    personas: [],
    roles: ["Admin", "Manager"],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [],
    assumptions: ["First assumption", "Second assumption"],
    openQuestions: [],
  },
};

function renderRoleChip(onRemoved: (p: Project) => void, canRemove = true) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(RoleChip, { role: "Manager", projectId: "proj1", index: 1, canRemove, onRemoved }),
      ),
    ),
  );
}

function renderAssumptionItem(onRemoved: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AssumptionItem, { assumption: "Second assumption", projectId: "proj1", index: 1, onRemoved }),
      ),
    ),
  );
}

function renderAddRoleForm(onAdded: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddRoleForm, { projectId: "proj1", onAdded })),
    ),
  );
}

function renderAddAssumptionForm(onAdded: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddAssumptionForm, { projectId: "proj1", onAdded })),
    ),
  );
}

test("clicking a role chip's remove button calls the real DELETE endpoint by index and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/projects/proj1/roles/1") {
        deleteCalls += 1;
        const remaining = { ...baseProject, spec: { ...baseProject.spec, roles: ["Admin"] } };
        return new Response(JSON.stringify({ project: remaining }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderRoleChip((p) => removedProjects.push(p));

      const button = document.querySelector(".chip-remove") as HTMLButtonElement;
      assert.ok(button, "expected a remove button on the role chip");
      fireEvent.click(button);

      await waitForCondition(() => removedProjects.length === 1);
      assert.equal(deleteCalls, 1);
      assert.deepEqual(removedProjects[0].spec.roles, ["Admin"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a role chip's remove button is disabled when canRemove is false (the last remaining role), and clicking it does nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("removeRole must never be called when canRemove is false");
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderRoleChip((p) => removedProjects.push(p), false);

      const button = document.querySelector(".chip-remove") as HTMLButtonElement;
      assert.equal(button.disabled, true, "the remove button must be disabled when this is the last remaining role");
      fireEvent.click(button);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(removedProjects.length, 0, "a disabled button's click must not trigger a removal");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a role chip surfaces a real removal error (e.g. the last-role guard) instead of silently doing nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Cannot remove the last remaining role -- at least one role is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderRoleChip((p) => removedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-remove") as HTMLButtonElement);

      await waitForCondition(() => document.querySelector(".chip-removable .error") !== null);
      assert.equal(removedProjects.length, 0, "onRemoved must not fire when the request failed");
      assert.match((document.querySelector(".chip-removable .error") as HTMLElement).textContent ?? "", /last remaining role/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking an assumption's remove button calls the real DELETE endpoint by index and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/projects/proj1/assumptions/1") {
        deleteCalls += 1;
        const remaining = { ...baseProject, spec: { ...baseProject.spec, assumptions: ["First assumption"] } };
        return new Response(JSON.stringify({ project: remaining }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderAssumptionItem((p) => removedProjects.push(p));

      const button = document.querySelector(".assumption-remove") as HTMLButtonElement;
      assert.ok(button, "expected a remove button on the assumption item");
      fireEvent.click(button);

      await waitForCondition(() => removedProjects.length === 1);
      assert.equal(deleteCalls, 1);
      assert.deepEqual(removedProjects[0].spec.assumptions, ["First assumption"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("submitting the add-role form calls the real POST endpoint with the trimmed value and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedRole: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/roles") {
        postedRole = (JSON.parse(init.body as string) as { role: string }).role;
        const withNewRole = { ...baseProject, spec: { ...baseProject.spec, roles: [...baseProject.spec.roles, postedRole] } };
        return new Response(JSON.stringify({ project: withNewRole }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddRoleForm((p) => addedProjects.push(p));

      const input = document.querySelector(".spec-add-item-form input") as HTMLInputElement;
      const button = document.querySelector(".spec-add-item-form button") as HTMLButtonElement;
      assert.ok(input && button, "expected an add-role input and submit button");
      assert.equal(button.disabled, true, "the submit button must start disabled with an empty input");

      fireEvent.change(input, { target: { value: "  Warehouse Manager  " } });
      fireEvent.click(button);

      await waitForCondition(() => addedProjects.length === 1);
      assert.equal(postedRole, "Warehouse Manager", "the posted role must be trimmed before sending");
      assert.deepEqual(addedProjects[0].spec.roles, ["Admin", "Manager", "Warehouse Manager"]);
      assert.equal(input.value, "", "the input must clear after a successful add");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the add-role form surfaces a real error instead of silently doing nothing, and never fires onAdded", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "role is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddRoleForm((p) => addedProjects.push(p));

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, {
        target: { value: "Auditor" },
      });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => document.querySelector(".spec-add-item-form .error") !== null);
      assert.equal(addedProjects.length, 0, "onAdded must not fire when the request failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("submitting the add-assumption form calls the real POST endpoint with the trimmed value and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedAssumption: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/assumptions") {
        postedAssumption = (JSON.parse(init.body as string) as { assumption: string }).assumption;
        const withNewAssumption = {
          ...baseProject,
          spec: { ...baseProject.spec, assumptions: [...baseProject.spec.assumptions, postedAssumption] },
        };
        return new Response(JSON.stringify({ project: withNewAssumption }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddAssumptionForm((p) => addedProjects.push(p));

      const input = document.querySelector(".spec-add-item-form input") as HTMLInputElement;
      const button = document.querySelector(".spec-add-item-form button") as HTMLButtonElement;
      fireEvent.change(input, { target: { value: "  Only one warehouse  " } });
      fireEvent.click(button);

      await waitForCondition(() => addedProjects.length === 1);
      assert.equal(postedAssumption, "Only one warehouse");
      assert.deepEqual(addedProjects[0].spec.assumptions, ["First assumption", "Second assumption", "Only one warehouse"]);
      assert.equal(input.value, "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
