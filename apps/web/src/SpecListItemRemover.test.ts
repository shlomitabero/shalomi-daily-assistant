import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Entity, Field, Project } from "@forge/shared";
import {
  AddAssumptionForm,
  AddEntityForm,
  AddFieldForm,
  AddPersonaForm,
  AddRoleForm,
  AssumptionItem,
  EntitySummaryItem,
  FieldChip,
  PersonaItem,
  RoleChip,
} from "./SpecListItemRemover.js";
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
    personas: ["First persona", "Second persona"],
    roles: ["Admin", "Manager"],
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [],
    assumptions: ["First assumption", "Second assumption"],
    openQuestions: [],
  },
};

function renderRoleChip(
  onRemoved: (p: Project) => void,
  canRemove = true,
  onRenamed: (p: Project) => void = () => {},
  readOnly = false,
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(RoleChip, { role: "Manager", projectId: "proj1", index: 1, canRemove, onRenamed, onRemoved, readOnly }),
      ),
    ),
  );
}

function renderAssumptionItem(
  onRemoved: (p: Project) => void,
  onRenamed: (p: Project) => void = () => {},
  readOnly = false,
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AssumptionItem, {
          assumption: "Second assumption",
          projectId: "proj1",
          index: 1,
          onRenamed,
          onRemoved,
          readOnly,
        }),
      ),
    ),
  );
}

function renderPersonaItem(
  onRemoved: (p: Project) => void,
  onRenamed: (p: Project) => void = () => {},
  readOnly = false,
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(PersonaItem, {
          persona: "Second persona",
          projectId: "proj1",
          index: 1,
          onRenamed,
          onRemoved,
          readOnly,
        }),
      ),
    ),
  );
}

function renderEntitySummaryItem(
  onRemoved: (p: Project) => void,
  canRemove = true,
  onRenamed: (p: Project) => void = () => {},
  readOnly = false,
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(EntitySummaryItem, {
          entity: baseProject.spec.entities[0],
          allEntities: baseProject.spec.entities,
          fieldsSummary: "name *",
          projectId: "proj1",
          canRemove,
          onRenamed,
          onRemoved,
          readOnly,
        }),
      ),
    ),
  );
}

function renderFieldChip(
  onChanged: (p: Project) => void,
  canRemove = true,
  field: Field = { name: "email", type: "text", required: true },
  allEntities: Entity[] = baseProject.spec.entities,
  readOnly = false,
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(FieldChip, {
          field,
          projectId: "proj1",
          entityName: "Customer",
          canRemove,
          onChanged,
          allEntities,
          labelOccurrences: new Map(),
          readOnly,
        }),
      ),
    ),
  );
}

function renderAddFieldForm(
  onAdded: (p: Project) => void,
  allEntities: Entity[] = baseProject.spec.entities,
  readOnly = false,
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AddFieldForm, { projectId: "proj1", entityName: "Customer", allEntities, onAdded, readOnly }),
      ),
    ),
  );
}

function renderAddRoleForm(onAdded: (p: Project) => void, readOnly = false) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddRoleForm, { projectId: "proj1", onAdded, readOnly })),
    ),
  );
}

function renderAddAssumptionForm(onAdded: (p: Project) => void, readOnly = false) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddAssumptionForm, { projectId: "proj1", onAdded, readOnly })),
    ),
  );
}

function renderAddPersonaForm(onAdded: (p: Project) => void, readOnly = false) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddPersonaForm, { projectId: "proj1", onAdded, readOnly })),
    ),
  );
}

function renderAddEntityForm(onAdded: (p: Project) => void, readOnly = false) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddEntityForm, { projectId: "proj1", onAdded, readOnly })),
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

/**
 * Round 932: a role chip's remove-error and rename-error are two
 * independent states (one per hook) rendered in mutually exclusive
 * branches -- the remove error only in the normal view, the rename error
 * only in the rename-edit view. Before this round, starting a rename
 * only ever cleared the rename hook's OWN error, never the OTHER one --
 * so a stale remove error, merely hidden (not cleared) while editing,
 * reappeared the instant a completely unrelated, successful rename
 * returned to the normal view.
 */
test("a role chip's stale remove-error is cleared once a rename is started, instead of reappearing after a later, unrelated successful rename", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        return new Response(JSON.stringify({ error: "Cannot remove the last remaining role -- at least one role is required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/roles/1") {
        const renamed = { ...baseProject, spec: { ...baseProject.spec, roles: ["Admin", "Warehouse Manager"] } };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderRoleChip(
        () => {},
        true,
        (p) => renamedProjects.push(p),
      );

      fireEvent.click(document.querySelector(".chip-remove") as HTMLButtonElement);
      await waitForCondition(() => document.querySelector(".chip-removable .error") !== null);

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the role text");
      fireEvent.change(input, { target: { value: "Warehouse Manager" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      // Compared as a boolean, never the raw node -- round 666's own
      // documented lesson: assert.equal on a real (non-null) DOM element
      // can hang for 90s-2min formatting its circular structure for the
      // failure message instead of failing fast.
      assert.equal(
        document.querySelector(".chip-removable .error") === null,
        true,
        "a stale remove error from before the rename must not survive a later, unrelated successful rename",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking a role chip's text opens an inline edit, and saving it calls the real PATCH endpoint by index", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { role: string; expect?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/roles/1") {
        patchBody = JSON.parse(init.body as string) as { role: string; expect?: string };
        const renamed = { ...baseProject, spec: { ...baseProject.spec, roles: ["Admin", patchBody.role] } };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderRoleChip(() => {}, true, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the role text");
      assert.equal(input.value, "Manager", "the draft must start pre-filled with the current role text");

      fireEvent.change(input, { target: { value: "Warehouse Manager" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.deepEqual(patchBody, { role: "Warehouse Manager", expect: "Manager" });
      assert.deepEqual(renamedProjects[0].spec.roles, ["Admin", "Warehouse Manager"]);
      assert.equal(document.querySelector(".chip-rename-edit"), null, "must return to display mode after a successful save");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap round 483 fixed in a sibling family of click-to-rename components. */
test("a role chip's text is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderRoleChip(() => {});

    const chipText = document.querySelector(".chip-text") as HTMLElement;
    assert.equal(chipText.getAttribute("role"), "button");
    assert.equal(chipText.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(chipText, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".chip-rename-edit input") !== null);
    assert.ok(document.querySelector(".chip-rename-edit input"), "Enter should have entered edit mode");
  });
});

test("pressing Escape while editing a role chip cancels without saving", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renameRole must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderRoleChip(() => {}, true, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else entirely" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renamedProjects.length, 0, "Escape must cancel without ever calling renameRole");
      assert.equal(document.querySelector(".chip-text")?.textContent, "Manager", "the original role text must be shown, unchanged");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for a real bug found by round 1087's Explore survey: the
 * `cancelling` ref in useRenamableSpecItem (shared by RoleChip and every
 * other click-to-rename spec item) assumes the spurious post-cancel blur
 * really does re-invoke save() once, letting it reset the flag back to
 * false there. A direct Playwright probe against real Chromium found this
 * assumption wrong -- that blur never reaches an already-unmounted
 * fiber's onBlur -- so the flag set by cancelEditing() stays `true`
 * forever and silently swallows the very next real save on this same
 * chip, with no error. Fixed by resetting the flag in startEditing() too.
 */
test("renaming a role chip, cancelling with Escape, then renaming it again for real must not be silently swallowed", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/roles/1") {
        renameCalls += 1;
        const body = JSON.parse(init.body as string) as { role: string };
        const renamed = { ...baseProject, spec: { ...baseProject.spec, roles: ["Admin", body.role] } };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderRoleChip(() => {}, true, (p) => renamedProjects.push(p));

      // First session: start, change the draft, then cancel with Escape.
      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      let input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      await waitForCondition(() => document.querySelector(".chip-rename-edit") === null);
      assert.equal(renameCalls, 0, "Escape must not itself trigger a rename");

      // Second session on the SAME chip: a real rename, saved via blur.
      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Warehouse Manager" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.equal(renameCalls, 1, "the real rename after a prior cancel must not be swallowed");
      assert.deepEqual(renamedProjects[0].spec.roles, ["Admin", "Warehouse Manager"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a role chip's rename surfaces a real error instead of silently doing nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "role is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderRoleChip(() => {}, true, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else" } });
      fireEvent.blur(input);

      await waitForCondition(() => document.querySelector(".chip-rename-edit .error") !== null);
      assert.equal(renamedProjects.length, 0, "onRenamed must not fire when the request failed");
      // Round 1158: every other dynamic-text surface in this app uses
      // role="status"/"alert"; this rename error had none at all, unlike
      // this same component's own sibling remove-error (which already has
      // role="alert").
      assert.equal(document.querySelector(".chip-rename-edit .error")!.getAttribute("role"), "alert");
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

test("clicking an assumption's text opens an inline edit, and saving it calls the real PATCH endpoint by index", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { assumption: string; expect?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/assumptions/1") {
        patchBody = JSON.parse(init.body as string) as { assumption: string; expect?: string };
        const renamed = {
          ...baseProject,
          spec: { ...baseProject.spec, assumptions: ["First assumption", patchBody.assumption] },
        };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderAssumptionItem(() => {}, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".assumption-text") as HTMLElement);
      const input = document.querySelector(".assumption-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the assumption text");
      assert.equal(input.value, "Second assumption");

      fireEvent.change(input, { target: { value: "Only one warehouse" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.deepEqual(patchBody, { assumption: "Only one warehouse", expect: "Second assumption" });
      assert.deepEqual(renamedProjects[0].spec.assumptions, ["First assumption", "Only one warehouse"]);
      assert.equal(document.querySelector(".assumption-rename-edit"), null, "must return to display mode after a successful save");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap round 483 fixed in a sibling family of click-to-rename components. */
test("an assumption's text is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderAssumptionItem(() => {});

    const text = document.querySelector(".assumption-text") as HTMLElement;
    assert.equal(text.getAttribute("role"), "button");
    assert.equal(text.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(text, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".assumption-rename-edit input") !== null);
    assert.ok(document.querySelector(".assumption-rename-edit input"), "Enter should have entered edit mode");
  });
});

test("pressing Escape while editing an assumption cancels without saving", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renameAssumption must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderAssumptionItem(() => {}, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".assumption-text") as HTMLElement);
      const input = document.querySelector(".assumption-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else entirely" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renamedProjects.length, 0, "Escape must cancel without ever calling renameAssumption");
      assert.equal(
        document.querySelector(".assumption-text")?.textContent,
        "Second assumption",
        "the original assumption text must be shown, unchanged",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking a persona's remove button calls the real DELETE endpoint by index and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/projects/proj1/personas/1") {
        deleteCalls += 1;
        const remaining = { ...baseProject, spec: { ...baseProject.spec, personas: ["First persona"] } };
        return new Response(JSON.stringify({ project: remaining }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderPersonaItem((p) => removedProjects.push(p));

      const button = document.querySelector(".persona-remove") as HTMLButtonElement;
      assert.ok(button, "expected a remove button on the persona item");
      fireEvent.click(button);

      await waitForCondition(() => removedProjects.length === 1);
      assert.equal(deleteCalls, 1);
      assert.deepEqual(removedProjects[0].spec.personas, ["First persona"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking a persona's text opens an inline edit, and saving it calls the real PATCH endpoint by index", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { persona: string; expect?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/personas/1") {
        patchBody = JSON.parse(init.body as string) as { persona: string; expect?: string };
        const renamed = {
          ...baseProject,
          spec: { ...baseProject.spec, personas: ["First persona", patchBody.persona] },
        };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderPersonaItem(() => {}, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".persona-text") as HTMLElement);
      const input = document.querySelector(".persona-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the persona text");
      assert.equal(input.value, "Second persona");

      fireEvent.change(input, { target: { value: "Busy small-business owners" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.deepEqual(patchBody, { persona: "Busy small-business owners", expect: "Second persona" });
      assert.deepEqual(renamedProjects[0].spec.personas, ["First persona", "Busy small-business owners"]);
      assert.equal(document.querySelector(".persona-rename-edit"), null, "must return to display mode after a successful save");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a persona's text is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderPersonaItem(() => {});

    const text = document.querySelector(".persona-text") as HTMLElement;
    assert.equal(text.getAttribute("role"), "button");
    assert.equal(text.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(text, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".persona-rename-edit input") !== null);
    assert.ok(document.querySelector(".persona-rename-edit input"), "Enter should have entered edit mode");
  });
});

test("pressing Escape while editing a persona cancels without saving", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renamePersona must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderPersonaItem(() => {}, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".persona-text") as HTMLElement);
      const input = document.querySelector(".persona-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else entirely" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renamedProjects.length, 0, "Escape must cancel without ever calling renamePersona");
      assert.equal(
        document.querySelector(".persona-text")?.textContent,
        "Second persona",
        "the original persona text must be shown, unchanged",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking an entity summary's remove button calls the real DELETE endpoint by entity name and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/projects/proj1/entities/Customer") {
        deleteCalls += 1;
        const remaining = {
          ...baseProject,
          spec: { ...baseProject.spec, entities: [{ name: "Deal", fields: [{ name: "amount", type: "number", required: false }] }] },
        };
        return new Response(JSON.stringify({ project: remaining }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderEntitySummaryItem((p) => removedProjects.push(p));

      const button = document.querySelector(".entity-summary-remove") as HTMLButtonElement;
      assert.ok(button, "expected a remove button on the entity summary");
      fireEvent.click(button);

      await waitForCondition(() => removedProjects.length === 1);
      assert.equal(deleteCalls, 1);
      assert.deepEqual(removedProjects[0].spec.entities.map((e) => e.name), ["Deal"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an entity summary's remove button is disabled when canRemove is false (the last remaining entity), and clicking it does nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("removeEntity must never be called when canRemove is false");
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderEntitySummaryItem((p) => removedProjects.push(p), false);

      const button = document.querySelector(".entity-summary-remove") as HTMLButtonElement;
      assert.equal(button.disabled, true, "the remove button must be disabled when this is the last remaining entity");
      fireEvent.click(button);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(removedProjects.length, 0, "a disabled button's click must not trigger a removal");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an entity summary surfaces a real removal error (e.g. a dependent-relation guard) instead of silently doing nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Cannot remove this screen -- "Order" still links to it' }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      renderEntitySummaryItem((p) => removedProjects.push(p));

      fireEvent.click(document.querySelector(".entity-summary-remove") as HTMLButtonElement);

      await waitForCondition(() => document.querySelector(".entity-summary .error") !== null);
      assert.equal(removedProjects.length, 0, "onRemoved must not fire when the request failed");
      assert.match((document.querySelector(".entity-summary .error") as HTMLElement).textContent ?? "", /still links to it/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: entities on the spec-review screen previously had no
 * correction path beyond removal, unlike roles/assumptions right above them
 * on the same screen -- an AI-mislabeled entity could only be fixed after
 * a full build, via EntityPanel.tsx's own EntityLabelEditor. This reuses
 * the exact same renameEntityLabel endpoint that editor already calls, just
 * wired into the pre-build spec-review list too.
 */
test("clicking an entity summary's label opens an inline edit, and saving it calls the real PATCH endpoint by entity name", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { label: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/label") {
        patchBody = JSON.parse(init.body as string) as { label: string };
        const renamed = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], label: patchBody.label }],
          },
        };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEntitySummaryItem(() => {}, true, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".entity-summary-label") as HTMLElement);
      const input = document.querySelector(".entity-summary-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the entity label");
      assert.equal(input.value, "Customer", "the draft must start pre-filled with the current entity label");

      fireEvent.change(input, { target: { value: "Client" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamedProjects.length === 1);
      assert.deepEqual(patchBody, { label: "Client" });
      assert.deepEqual(renamedProjects[0].spec.entities.map((e) => e.label), ["Client"]);
      assert.equal(document.querySelector(".entity-summary-rename-edit"), null, "must return to display mode after a successful save");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1027: an entity's remove and rename are two independent actions
 * both feeding the same onRemoved/onRenamed -> setProject full-state
 * replace, with no server-side staleness guard at all (unlike RoleChip/
 * AssumptionItem/PersonaItem's own stale-index-protected routes). Before
 * this round, clicking remove then immediately clicking the label (before
 * the DELETE's response landed) opened the rename input and let a second,
 * concurrent PATCH .../label go out -- whichever response the browser
 * received last silently overwrote the other's result, up to resurrecting
 * the just-deleted entity with its new label. Confirms the label is now
 * inert while a removal is in flight.
 */
test("an entity summary's label does not open for rename while this same entity's own removal is still in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/projects/proj1/entities/Customer") {
        await deleteGate;
        const remaining = {
          ...baseProject,
          spec: { ...baseProject.spec, entities: [{ name: "Deal", fields: [{ name: "amount", type: "number", required: false }] }] },
        };
        return new Response(JSON.stringify({ project: remaining }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const removedProjects: Project[] = [];
      const renamedProjects: Project[] = [];
      renderEntitySummaryItem(
        (p) => removedProjects.push(p),
        true,
        (p) => renamedProjects.push(p),
      );

      try {
        fireEvent.click(document.querySelector(".entity-summary-remove") as HTMLButtonElement);
        // No real await to poll for here -- the removal is deliberately
        // held open by the gate, so this click's own synchronous busy-
        // state update is already committed by the time the next line runs.
        fireEvent.click(document.querySelector(".entity-summary-label") as HTMLElement);

        // Compared as a boolean, never the raw node -- round 666's own
        // documented lesson about assert.equal hanging on a real DOM node.
        assert.equal(
          document.querySelector(".entity-summary-rename-edit") === null,
          true,
          "clicking the label while the removal is still in flight must not open the rename input",
        );
        assert.equal(renamedProjects.length, 0, "renameEntityLabel must never be called while a removal on this same entity is in flight");
      } finally {
        // Always resolves the gate, even if an assertion above threw --
        // mirrors round 1026's own lesson about a dangling, no-longer-
        // awaited fetch being able to hang the test.
        resolveDelete!();
      }
      await waitForCondition(() => removedProjects.length === 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap round 483 fixed in a sibling family of click-to-rename components. */
test("an entity summary's label is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderEntitySummaryItem(() => {});

    const label = document.querySelector(".entity-summary-label") as HTMLElement;
    assert.equal(label.getAttribute("role"), "button");
    assert.equal(label.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(label, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".entity-summary-rename-edit input") !== null);
    assert.ok(document.querySelector(".entity-summary-rename-edit input"), "Enter should have entered edit mode");
  });
});

test("pressing Escape while editing an entity summary's label cancels without saving", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renameEntityLabel must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEntitySummaryItem(() => {}, true, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".entity-summary-label") as HTMLElement);
      const input = document.querySelector(".entity-summary-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else entirely" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(renamedProjects.length, 0, "Escape must cancel without ever calling renameEntityLabel");
      assert.equal(
        document.querySelector(".entity-summary-label")?.textContent,
        "Customer",
        "the original entity label must be shown, unchanged",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an entity summary's rename surfaces a real error instead of silently doing nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "label is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const renamedProjects: Project[] = [];
      renderEntitySummaryItem(() => {}, true, (p) => renamedProjects.push(p));

      fireEvent.click(document.querySelector(".entity-summary-label") as HTMLElement);
      const input = document.querySelector(".entity-summary-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else" } });
      fireEvent.blur(input);

      await waitForCondition(() => document.querySelector(".entity-summary-rename-edit .error") !== null);
      assert.equal(renamedProjects.length, 0, "onRenamed must not fire when the request failed");
      // Round 1158: every other dynamic-text surface in this app uses
      // role="status"/"alert"; this rename error had none at all.
      assert.equal(document.querySelector(".entity-summary-rename-edit .error")!.getAttribute("role"), "alert");
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

test("submitting the add-persona form calls the real POST endpoint with the trimmed value and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedPersona: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/personas") {
        postedPersona = (JSON.parse(init.body as string) as { persona: string }).persona;
        const withNewPersona = {
          ...baseProject,
          spec: { ...baseProject.spec, personas: [...baseProject.spec.personas, postedPersona] },
        };
        return new Response(JSON.stringify({ project: withNewPersona }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddPersonaForm((p) => addedProjects.push(p));

      const input = document.querySelector(".spec-add-item-form input") as HTMLInputElement;
      const button = document.querySelector(".spec-add-item-form button") as HTMLButtonElement;
      fireEvent.change(input, { target: { value: "  Busy small-business owners  " } });
      fireEvent.click(button);

      await waitForCondition(() => addedProjects.length === 1);
      assert.equal(postedPersona, "Busy small-business owners");
      assert.deepEqual(addedProjects[0].spec.personas, ["First persona", "Second persona", "Busy small-business owners"]);
      assert.equal(input.value, "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("submitting the add-entity form calls the real POST endpoint with the trimmed label and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedLabel: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/entities") {
        postedLabel = (JSON.parse(init.body as string) as { label: string }).label;
        const newEntity = { name: "Payment", label: postedLabel, fields: [{ name: "name", type: "text", required: true }] };
        const withNewEntity = { ...baseProject, spec: { ...baseProject.spec, entities: [...baseProject.spec.entities, newEntity] } };
        return new Response(JSON.stringify({ project: withNewEntity }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddEntityForm((p) => addedProjects.push(p));

      const input = document.querySelector(".spec-add-item-form input") as HTMLInputElement;
      const button = document.querySelector(".spec-add-item-form button") as HTMLButtonElement;
      assert.ok(input && button, "expected an add-entity input and submit button");
      assert.equal(button.disabled, true, "the submit button must start disabled with an empty input");

      fireEvent.change(input, { target: { value: "  Payment  " } });
      fireEvent.click(button);

      await waitForCondition(() => addedProjects.length === 1);
      assert.equal(postedLabel, "Payment", "the posted label must be trimmed before sending");
      assert.deepEqual(
        addedProjects[0].spec.entities.map((e) => e.name),
        ["Customer", "Payment"],
      );
      assert.equal(input.value, "", "the input must clear after a successful add");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the add-entity form surfaces a real error instead of silently doing nothing, and never fires onAdded", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "label is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddEntityForm((p) => addedProjects.push(p));

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, {
        target: { value: "Payment" },
      });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => document.querySelector(".spec-add-item-form .error") !== null);
      assert.equal(addedProjects.length, 0, "onAdded must not fire when the request failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: an entity's *fields* previously had no correction path
 * at all -- unlike roles/assumptions/whole-entities above, the only
 * field-level mutation anywhere in the app was the post-build-only
 * FieldLabelEditor's cosmetic renameFieldLabel. FieldChip/AddFieldForm are
 * the pre-build add/remove/rename counterpart, replacing EntitySummaryItem's
 * old flat, non-interactive `formatEntityFieldSummary` text with real chips.
 */
test("an entity summary renders one interactive field chip per field, plus a nested add-field form, in place of the old static field-list text", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("no request expected in this render-only test");
    }) as typeof fetch;

    try {
      renderEntitySummaryItem(() => {});

      const chips = document.querySelectorAll(".entity-summary-fields .chip-text");
      assert.equal(chips.length, 1, "expected one field chip for the Customer entity's single 'name' field");
      assert.equal(chips[0].textContent, "name *");

      const addFieldInput = document.querySelector(".entity-summary .spec-add-field-form input");
      assert.ok(addFieldInput, "expected a nested add-field form inside the entity summary");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking a field chip's remove button calls the real DELETE endpoint by entity+field name and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && input === "/api/projects/proj1/entities/Customer/fields/email") {
        deleteCalls += 1;
        const remaining = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], fields: [{ name: "name", type: "text", required: true }] }],
          },
        };
        return new Response(JSON.stringify({ project: remaining }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p));

      const button = document.querySelector(".chip-remove") as HTMLButtonElement;
      assert.ok(button, "expected a remove button on the field chip");
      fireEvent.click(button);

      await waitForCondition(() => changedProjects.length === 1);
      assert.equal(deleteCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a field chip's remove button is disabled when canRemove is false (the last remaining field), and clicking it does nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("removeField must never be called when canRemove is false");
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), false);

      const button = document.querySelector(".chip-remove") as HTMLButtonElement;
      assert.equal(button.disabled, true, "the remove button must be disabled when this is the last remaining field");
      fireEvent.click(button);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(changedProjects.length, 0, "a disabled button's click must not trigger a removal");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a field chip surfaces a real removal error (e.g. the last-field guard) instead of silently doing nothing", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Cannot remove the last remaining field -- at least one is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-remove") as HTMLButtonElement);

      await waitForCondition(() => document.querySelector(".chip-removable .error") !== null);
      assert.equal(changedProjects.length, 0, "onChanged must not fire when the request failed");
      assert.match((document.querySelector(".chip-removable .error") as HTMLElement).textContent ?? "", /last remaining field/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Real feature round: a field's `required` flag used to be plain, static
 * " *" text on the chip -- the one property a field chip could never
 * actually fix, unlike its label (click-to-rename). Confirms the new
 * checkbox reflects the field's real current state, and toggling it
 * calls the new PATCH .../required endpoint with the flipped value.
 */
test("a field chip's required checkbox reflects the field's current state, and toggling it calls the real PATCH .../required endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { required: boolean } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/required") {
        patchBody = JSON.parse(init.body as string) as { required: boolean };
        const updated = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], fields: [{ name: "email", type: "text", required: patchBody.required }] }],
          },
        };
        return new Response(JSON.stringify({ project: updated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "email", type: "text", required: true });

      const checkbox = document.querySelector(".chip-field-required input") as HTMLInputElement;
      assert.ok(checkbox, "expected a required checkbox on the field chip");
      assert.equal(checkbox.checked, true, "the checkbox must reflect the field's real current required state");

      fireEvent.click(checkbox);

      await waitForCondition(() => changedProjects.length === 1);
      assert.deepEqual(patchBody, { required: false }, "toggling must send the flipped value");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 931: this chip has three independent error states (remove's own
 * `error`, requiredError, typeError) that all render unconditionally
 * together at the bottom, with nothing distinguishing which action
 * produced which. Before this round, each handler only ever cleared its
 * OWN error at the start of its own action -- so a failed required-toggle
 * left its banner on screen untouched even past a later, completely
 * unrelated, SUCCESSFUL type change, confusingly implying the chip (or
 * the type change that just worked) was still broken.
 */
test("a field chip's required-toggle error banner is cleared by a later, unrelated successful type change", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/required") {
        return new Response(JSON.stringify({ error: "network blip" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/type") {
        const body = JSON.parse(init!.body as string) as { type: string };
        const updated = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], fields: [{ name: "email", type: body.type, required: true }] }],
          },
        };
        return new Response(JSON.stringify({ project: updated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "email", type: "text", required: true });

      fireEvent.click(document.querySelector(".chip-field-required input") as HTMLInputElement);
      await waitForCondition(() => document.querySelector(".chip-removable")?.textContent?.includes("network blip") ?? false);

      fireEvent.change(document.querySelector(".chip-field-type") as HTMLSelectElement, { target: { value: "number" } });
      await waitForCondition(() => changedProjects.length === 1);

      assert.equal(
        document.querySelector(".chip-removable")?.textContent?.includes("network blip") ?? false,
        false,
        "a stale required-toggle error must not survive a later, unrelated successful type change",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("changing a field chip's type select to a plain type (no extra data needed) commits immediately via the real PATCH type endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { type: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/type") {
        patchBody = JSON.parse(init.body as string) as { type: string };
        const updated = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], fields: [{ name: "email", type: patchBody.type, required: true }] }],
          },
        };
        return new Response(JSON.stringify({ project: updated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "email", type: "text", required: true });

      const select = document.querySelector(".chip-field-type") as HTMLSelectElement;
      assert.ok(select, "expected a type select on the field chip");
      assert.equal(select.value, "text");

      fireEvent.change(select, { target: { value: "number" } });

      await waitForCondition(() => changedProjects.length === 1);
      assert.deepEqual(patchBody, { type: "number" }, "switching to a type needing no extra data must commit immediately");
      assert.equal(document.querySelector(".chip-field-type-confirm"), null, "a plain type switch must never open the confirm step");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("changing a field chip's type select to enum opens a draft confirm step requiring values before it commits", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { type: string; enumValues?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/type") {
        patchBody = JSON.parse(init.body as string) as { type: string; enumValues?: string };
        const updated = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [
              {
                ...baseProject.spec.entities[0],
                fields: [{ name: "email", type: "enum", required: true, enumValues: ["New", "Done"] }],
              },
            ],
          },
        };
        return new Response(JSON.stringify({ project: updated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "email", type: "text", required: true });

      const select = document.querySelector(".chip-field-type") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "enum" } });

      const confirmForm = document.querySelector(".chip-field-type-confirm") as HTMLFormElement;
      assert.ok(confirmForm, "switching to enum must open the draft confirm step instead of committing immediately");
      assert.equal(patchBody, undefined, "selecting enum alone must never call the PATCH endpoint yet");

      const confirmButton = confirmForm.querySelector("button[type=submit]") as HTMLButtonElement;
      assert.equal(confirmButton.disabled, true, "the confirm button must stay disabled with no enum values entered yet");

      const enumInput = confirmForm.querySelector("input") as HTMLInputElement;
      fireEvent.change(enumInput, { target: { value: "New, Done" } });
      fireEvent.submit(confirmForm);

      await waitForCondition(() => changedProjects.length === 1);
      assert.deepEqual(patchBody, { type: "enum", enumValues: "New, Done" });
      assert.equal(document.querySelector(".chip-field-type-confirm"), null, "the confirm step must close after a successful commit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 715: before this, a field that was ALREADY "enum"/"relation" had
 * no way at all to edit its own enumValues/relationTo -- re-selecting the
 * type <select>'s own already-selected option fires no onChange (a native
 * <select> never fires change for its current value), and switching away
 * to a different type and back permanently loses the original values
 * (the server's own /type route wipes them the instant the type changes
 * away). Confirms a plain text/number/etc. field shows no such button at
 * all (nothing to edit), while an enum field's own edit button opens the
 * same draft confirm step pre-filled with its current comma-joined
 * enumValues, and submitting commits via the real PATCH type endpoint
 * with the field's own (unchanged) type.
 */
test("a plain (non-enum/relation) field chip shows no \"edit values\" button at all", async () => {
  await withJsdom(async () => {
    renderFieldChip(() => {}, true, { name: "email", type: "text", required: true });
    assert.equal(document.querySelector(".chip-field-edit-values"), null, "a text field has no enumValues/relationTo to edit");
  });
});

test("clicking an existing enum field chip's \"edit values\" button opens the draft confirm step pre-filled with its current values, and submitting commits the edited list via the real PATCH type endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { type: string; enumValues?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/status/type") {
        patchBody = JSON.parse(init.body as string) as { type: string; enumValues?: string };
        const updated = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [
              {
                ...baseProject.spec.entities[0],
                fields: [{ name: "status", type: "enum", required: true, enumValues: ["New", "In Progress", "Done"] }],
              },
            ],
          },
        };
        return new Response(JSON.stringify({ project: updated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip(
        (p) => changedProjects.push(p),
        true,
        { name: "status", type: "enum", required: true, enumValues: ["New", "Done"] },
      );

      const editButton = document.querySelector(".chip-field-edit-values") as HTMLButtonElement;
      assert.ok(editButton, "expected an edit-values button on an existing enum field");
      assert.equal(document.querySelector(".chip-field-type-confirm"), null, "the confirm step must not be open before clicking the button");

      fireEvent.click(editButton);

      const confirmForm = document.querySelector(".chip-field-type-confirm") as HTMLFormElement;
      assert.ok(confirmForm, "clicking the edit-values button must open the draft confirm step");
      const enumInput = confirmForm.querySelector("input") as HTMLInputElement;
      assert.equal(enumInput.value, "New, Done", "the draft must start pre-filled with the field's own current enumValues");

      fireEvent.change(enumInput, { target: { value: "New, In Progress, Done" } });
      fireEvent.submit(confirmForm);

      await waitForCondition(() => changedProjects.length === 1);
      assert.deepEqual(
        patchBody,
        { type: "enum", enumValues: "New, In Progress, Done" },
        "must PATCH the field's own unchanged type alongside the edited values -- not require switching to a different type first",
      );
      assert.equal(document.querySelector(".chip-field-type-confirm"), null, "the confirm step must close after a successful commit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking an existing relation field chip's \"edit target\" button opens the draft confirm step pre-filled with its current relationTo, and submitting commits the new target via the real PATCH type endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { type: string; relationTo?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/supplierId/type") {
        patchBody = JSON.parse(init.body as string) as { type: string; relationTo?: string };
        const updated = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [
              { ...baseProject.spec.entities[0], fields: [{ name: "supplierId", type: "relation", required: false, relationTo: patchBody.relationTo }] },
            ],
          },
        };
        return new Response(JSON.stringify({ project: updated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    const relatedEntities: Entity[] = [
      ...baseProject.spec.entities,
      { name: "Supplier", label: "Supplier", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Warehouse", label: "Warehouse", fields: [{ name: "name", type: "text", required: true }] },
    ];

    try {
      const changedProjects: Project[] = [];
      renderFieldChip(
        (p) => changedProjects.push(p),
        true,
        { name: "supplierId", type: "relation", required: false, relationTo: "Supplier" },
        relatedEntities,
      );

      const editButton = document.querySelector(".chip-field-edit-values") as HTMLButtonElement;
      assert.ok(editButton, "expected an edit-target button on an existing relation field");

      fireEvent.click(editButton);

      const confirmForm = document.querySelector(".chip-field-type-confirm") as HTMLFormElement;
      assert.ok(confirmForm, "clicking the edit-target button must open the draft confirm step");
      const relationSelect = confirmForm.querySelector("select") as HTMLSelectElement;
      assert.equal(relationSelect.value, "Supplier", "the draft must start pre-filled with the field's own current relationTo");

      fireEvent.change(relationSelect, { target: { value: "Warehouse" } });
      fireEvent.submit(confirmForm);

      await waitForCondition(() => changedProjects.length === 1);
      assert.deepEqual(
        patchBody,
        { type: "relation", relationTo: "Warehouse" },
        "must PATCH the field's own unchanged type alongside the new relation target",
      );
      assert.equal(document.querySelector(".chip-field-type-confirm"), null, "the confirm step must close after a successful commit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 799: every other inline-edit control in this file (RoleChip,
 * AssumptionItem, PersonaItem, EntitySummaryItem's label editor, and this
 * same FieldChip's own label-rename editor just below) already supports
 * Escape-to-cancel -- this enum/relation type-change draft, opened either
 * by picking "enum"/"relation" from the type <select> or by the dedicated
 * "edit values"/"edit target" button, was the one left without any way
 * to back out once opened: no Escape handler, no Cancel button, and
 * re-selecting the <select>'s own already-shown value fires no onChange
 * at all (the exact reason the edit button exists in the first place).
 * Covers both halves: Escape on the enum input, and the new explicit
 * Cancel button on the relation select's own draft.
 */
test("pressing Escape while editing an existing enum field's values closes the draft without ever calling the PATCH endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("setFieldType must never be called after Escape cancels the draft");
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "status", type: "enum", required: true, enumValues: ["New", "Done"] });

      const editButton = document.querySelector(".chip-field-edit-values") as HTMLButtonElement;
      fireEvent.click(editButton);
      const confirmForm = document.querySelector(".chip-field-type-confirm") as HTMLFormElement;
      assert.ok(confirmForm, "expected the draft confirm step to open");
      const enumInput = confirmForm.querySelector("input") as HTMLInputElement;

      fireEvent.change(enumInput, { target: { value: "something not yet saved" } });
      fireEvent.keyDown(enumInput, { key: "Escape" });

      assert.equal(changedProjects.length, 0, "Escape must cancel without ever calling setFieldType");
      // Compared as a boolean, not assert.equal(element, null, ...) directly
      // -- when that form of assertion actually fails, node:assert's default
      // diff formatter tries to inspect the real DOM element, which hangs
      // indefinitely on jsdom's circular/huge node structure (confirmed
      // empirically: this exact revert-and-rerun regression check hung for
      // 60+ seconds before being SIGKILLed, with the boolean form below
      // failing in well under a second instead).
      assert.equal(document.querySelector(".chip-field-type-confirm") === null, true, "the draft confirm step must close");
      assert.ok(document.querySelector(".chip-field-edit-values"), "the edit-values button must reappear so the draft can be reopened");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking Cancel while editing an existing relation field's target closes the draft without ever calling the PATCH endpoint", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("setFieldType must never be called after Cancel closes the draft");
    }) as typeof fetch;

    const relatedEntities: Entity[] = [
      ...baseProject.spec.entities,
      { name: "Supplier", label: "Supplier", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Warehouse", label: "Warehouse", fields: [{ name: "name", type: "text", required: true }] },
    ];

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "supplierId", type: "relation", required: false, relationTo: "Supplier" }, relatedEntities);

      const editButton = document.querySelector(".chip-field-edit-values") as HTMLButtonElement;
      fireEvent.click(editButton);
      const confirmForm = document.querySelector(".chip-field-type-confirm") as HTMLFormElement;
      assert.ok(confirmForm, "expected the draft confirm step to open");
      const relationSelect = confirmForm.querySelector("select") as HTMLSelectElement;

      fireEvent.change(relationSelect, { target: { value: "Warehouse" } });
      const cancelButton = Array.from(confirmForm.querySelectorAll("button")).find((b) => b.type === "button") as HTMLButtonElement;
      assert.ok(cancelButton, "expected a real Cancel button in the draft form");
      fireEvent.click(cancelButton);

      assert.equal(changedProjects.length, 0, "Cancel must close the draft without ever calling setFieldType");
      // See the Escape-cancel test above for why this is compared as a
      // boolean rather than assert.equal(element, null, ...) directly.
      assert.equal(document.querySelector(".chip-field-type-confirm") === null, true, "the draft confirm step must close");
      assert.ok(document.querySelector(".chip-field-edit-values"), "the edit-target button must reappear so the draft can be reopened");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1039: renameFieldLabel has no server-side uniqueness check (the
 * same already-fixed gap in ~12 other surfaces -- GlobalSearchPanel,
 * searchReport.ts, print sheets, board cards, CSV/.ics export, etc.), so
 * two sibling fields on this exact screen can be renamed to the identical
 * label in two clicks each. Without disambiguation, their two chips would
 * render byte-identical text, with nothing distinguishing which chip's
 * bare, confirmation-free "x" remove button belongs to which field.
 */
test("a field chip's displayed label is disambiguated by its own field name when a sibling field shares the same label", async () => {
  await withJsdom(async () => {
    const siblingFields: Field[] = [
      { name: "subtotal", label: "Amount", type: "number", required: false },
      { name: "shipping", label: "Amount", type: "number", required: false },
    ];
    const entityWithCollidingFields: Entity = { name: "Order", label: "Order", fields: siblingFields };
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(EntitySummaryItem, {
            entity: entityWithCollidingFields,
            allEntities: [entityWithCollidingFields],
            fieldsSummary: "Amount, Amount",
            projectId: "proj1",
            canRemove: true,
            onRenamed: () => {},
            onRemoved: () => {},
          }),
        ),
      ),
    );

    const chipTexts = Array.from(document.querySelectorAll(".chip-text")).map((el) => el.textContent?.trim());
    assert.ok(chipTexts.some((t) => t?.startsWith("Amount (subtotal)")), "the subtotal field's chip must be disambiguated by its own field name");
    assert.ok(chipTexts.some((t) => t?.startsWith("Amount (shipping)")), "the shipping field's chip must be disambiguated by its own field name");

    // The rename draft's own initial value must stay the plain,
    // non-disambiguated label -- otherwise saving it right back unchanged
    // would silently rename the field to the literal text "Amount (subtotal)".
    fireEvent.click(document.querySelectorAll(".chip-text")[0]);
    const renameInput = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
    assert.equal(renameInput.value, "Amount", "the rename input must be pre-filled with the plain label, not the disambiguated display text");
  });
});

/**
 * Round 1039: renameEntityLabel has the identical gap -- two entities
 * sharing a label render two identical-looking entity-summary headers,
 * each with its own bare, confirmation-free remove button.
 */
test("an entity summary's displayed label is disambiguated by its own entity name when another entity shares the same label", async () => {
  await withJsdom(async () => {
    const collidingEntities: Entity[] = [
      { name: "Lead", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Account", label: "Customer", fields: [{ name: "name", type: "text", required: true }] },
    ];
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(EntitySummaryItem, {
            entity: collidingEntities[0],
            allEntities: collidingEntities,
            fieldsSummary: "name *",
            projectId: "proj1",
            canRemove: true,
            onRenamed: () => {},
            onRemoved: () => {},
          }),
        ),
      ),
    );

    const label = document.querySelector(".entity-summary-label");
    assert.equal(label?.textContent, "Customer (Lead)", "the Lead entity's own header must be disambiguated by its own entity name");

    // Same "plain label in the rename draft" contract as the field-chip
    // test above.
    fireEvent.click(label as Element);
    const renameInput = document.querySelector(".entity-summary-rename-edit input") as HTMLInputElement;
    assert.equal(renameInput.value, "Customer", "the rename input must be pre-filled with the plain label, not the disambiguated display text");
  });
});

/**
 * Round 1039: the relation-target dropdown (both FieldChip's own
 * edit-target draft and AddFieldForm's "add a relation field" picker)
 * offers every other entity by its label, with the identical unresolved
 * collision risk -- confirmed here through FieldChip's own existing
 * relation-edit draft step.
 */
test("a relation field chip's edit-target dropdown disambiguates two candidate entities that share the same label", async () => {
  await withJsdom(async () => {
    const relatedEntities: Entity[] = [
      ...baseProject.spec.entities,
      { name: "Supplier", label: "Vendor", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Distributor", label: "Vendor", fields: [{ name: "name", type: "text", required: true }] },
    ];

    renderFieldChip(
      () => {},
      true,
      { name: "supplierId", type: "relation", required: false, relationTo: "Supplier" },
      relatedEntities,
    );

    const editButton = document.querySelector(".chip-field-edit-values") as HTMLButtonElement;
    fireEvent.click(editButton);
    const confirmForm = document.querySelector(".chip-field-type-confirm") as HTMLFormElement;
    const relationSelect = confirmForm.querySelector("select") as HTMLSelectElement;
    const optionLabels = Array.from(relationSelect.options).map((o) => o.textContent);

    assert.ok(optionLabels.includes("Vendor (Supplier)"), "the Supplier option must be disambiguated by its own entity name");
    assert.ok(optionLabels.includes("Vendor (Distributor)"), "the Distributor option must be disambiguated by its own entity name");
  });
});

/**
 * Round 1027: round 1026's own fieldChipBusy cross-gate disables the type
 * select/required checkbox/remove button while any of the three is in
 * flight, but left the field label itself ungated -- clicking it still
 * opened the rename input and let a concurrent PATCH .../label go out.
 * Mirrors the identical fix just added to EntitySummaryItem above.
 */
test("a field chip's label does not open for rename while this same field's own required-toggle is still in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRequiredPatch: (() => void) | undefined;
    const requiredGate = new Promise<void>((resolve) => {
      resolveRequiredPatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/required") {
        await requiredGate;
        return new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderFieldChip(() => {}, true, { name: "email", type: "text", required: true });

      try {
        fireEvent.click(document.querySelector(".chip-field-required input") as HTMLInputElement);
        fireEvent.click(document.querySelector(".chip-text") as HTMLElement);

        // Compared as a boolean, never the raw node -- round 666's own
        // documented lesson about assert.equal hanging on a real DOM node.
        assert.equal(
          document.querySelector(".chip-rename-edit") === null,
          true,
          "clicking the label while the required-toggle is still in flight must not open the rename input",
        );
      } finally {
        resolveRequiredPatch!();
      }
      await waitForCondition(() => !(document.querySelector(".chip-field-required input") as HTMLInputElement).disabled);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 932: FieldChip's own version of the same gap, but with three
 * siblings instead of one -- `error` (remove), requiredError, and
 * typeError are all hidden (not cleared) while rename.editing is shown,
 * so any of the three could resurface after a later, unrelated,
 * successful rename. Covers requiredError specifically, since
 * handleStartRename has to clear all three together here.
 */
test("a field chip's stale required-toggle error is cleared once a rename is started, instead of reappearing after a later, unrelated successful rename", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/required") {
        return new Response(JSON.stringify({ error: "network blip" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/label") {
        const body = JSON.parse(init!.body as string) as { label: string };
        const renamed = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], fields: [{ name: "email", type: "text", required: true, label: body.label }] }],
          },
        };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p), true, { name: "email", type: "text", required: true });

      fireEvent.click(document.querySelector(".chip-field-required input") as HTMLInputElement);
      await waitForCondition(() => document.querySelector(".chip-removable")?.textContent?.includes("network blip") ?? false);

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the field text");
      fireEvent.change(input, { target: { value: "Email Address" } });
      fireEvent.blur(input);

      await waitForCondition(() => changedProjects.length === 1);
      // Compared as a boolean, never the raw node -- round 666's own
      // documented lesson about assert.equal hanging on a real DOM node.
      assert.equal(
        document.querySelector(".chip-removable")?.textContent?.includes("network blip") ?? false,
        false,
        "a stale required-toggle error from before the rename must not survive a later, unrelated successful rename",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1026: a field chip's remove/required-toggle/type-change actions
 * each independently PATCH/DELETE and each eventually call the same
 * onChanged(project) -- a full project-state replace. Before this round,
 * each action only disabled its OWN control while in flight (requiredBusy
 * only disabled the checkbox, typeBusy only the type select, busy only the
 * remove button), so starting a second action before the first's response
 * lands sends two concurrent requests for the same field -- whichever
 * response is *received* last silently overwrites the other's result in
 * React state, with no error shown. Mirrors CollaboratorsPanel's own
 * role-change/remove/invite cross-gate (rounds 680/930): every one of
 * this chip's three controls must be disabled while ANY of the three
 * actions is in flight, not just its own.
 */
test("a field chip's type select and remove button are also disabled while the required-toggle's own request is still in flight, not just the checkbox itself", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRequiredPatch: (() => void) | undefined;
    const requiredGate = new Promise<void>((resolve) => {
      resolveRequiredPatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/required") {
        await requiredGate;
        return new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderFieldChip(() => {}, true, { name: "email", type: "text", required: true });

      fireEvent.click(document.querySelector(".chip-field-required input") as HTMLInputElement);
      await waitForCondition(() => (document.querySelector(".chip-field-required input") as HTMLInputElement).disabled);

      assert.equal(
        (document.querySelector(".chip-field-type") as HTMLSelectElement).disabled,
        true,
        "the type select must also be disabled while the required-toggle's own request is still in flight, not just the checkbox itself",
      );
      assert.equal(
        (document.querySelector(".chip-remove") as HTMLButtonElement).disabled,
        true,
        "the remove button must also be disabled while the required-toggle's own request is still in flight, not just the checkbox itself",
      );
    } finally {
      // Always resolves the gate, even if an assertion above threw -- a
      // real, no-longer-awaited fetch left permanently pending (round
      // 1026's own first fail-before run hung on exactly this before the
      // gate was moved into `finally`) must never be able to hang the test.
      resolveRequiredPatch!();
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking a field chip's text opens an inline edit, and saving it calls the real PATCH label endpoint by entity+field name", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: { label: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/label") {
        patchBody = JSON.parse(init.body as string) as { label: string };
        const renamed = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [
              { ...baseProject.spec.entities[0], fields: [{ name: "email", type: "text", required: true, label: patchBody.label }] },
            ],
          },
        };
        return new Response(JSON.stringify({ project: renamed }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      assert.ok(input, "expected an inline edit input after clicking the field text");
      assert.equal(input.value, "email", "the draft must start pre-filled with the current field label/name");

      fireEvent.change(input, { target: { value: "Email Address" } });
      fireEvent.blur(input);

      await waitForCondition(() => changedProjects.length === 1);
      assert.deepEqual(patchBody, { label: "Email Address" });
      assert.equal(document.querySelector(".chip-rename-edit"), null, "must return to display mode after a successful save");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1194: see RoleChip's own identical "the instant its rename editor
 * opens" test (round 1147) -- same gap, missed when round 1147's fix was
 * applied to RoleChip/AssumptionItem/PersonaItem but not to this sibling,
 * despite FieldChip's own `ownBusy` doc comment already (incorrectly)
 * claiming to cover "all four of its own actions, including rename".
 * Confirms onBusyChange now fires true the instant this field's rename
 * editor opens (no save in flight), which is what feeds EntitySummaryItem's
 * fieldBusyMap -- and so a sibling field's remove/required/type action, or
 * this entity's own remove, which otherwise stayed enabled the whole time
 * this field's rename draft sat open and unsaved, racing the eventual
 * rename PATCH with no server-side staleness check on either route.
 */
test("FieldChip reports its own busy state up via onBusyChange the instant its rename editor opens, with no save in flight", async () => {
  await withJsdom(async () => {
    const busyCalls: Array<[string, boolean]> = [];
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(FieldChip, {
            field: { name: "email", type: "text", required: true },
            projectId: "proj1",
            entityName: "Customer",
            canRemove: true,
            onChanged: () => {},
            allEntities: baseProject.spec.entities,
            labelOccurrences: new Map(),
            onBusyChange: (fieldName: string, busy: boolean) => busyCalls.push([fieldName, busy]),
          }),
        ),
      ),
    );

    fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
    assert.equal(document.querySelector(".chip-rename-edit") !== null, true, "the rename editor must actually be open");
    assert.equal(
      busyCalls.some(([name, busy]) => name === "email" && busy === true),
      true,
      "opening the rename editor (not yet saving anything) must already report this field as busy",
    );

    busyCalls.length = 0;
    fireEvent.keyDown(document.querySelector(".chip-rename-edit input") as HTMLInputElement, { key: "Escape" });
    assert.equal(document.querySelector(".chip-rename-edit") === null, true, "Escape must cancel the editor without saving");
    assert.equal(
      busyCalls.some(([name, busy]) => name === "email" && busy === false),
      true,
      "cancelling the still-unsaved edit must report this field as no longer busy",
    );
  });
});

/** Mirrors ProjectNameEditor.test.ts's own keyboard-focus test for the identical gap round 483 fixed in a sibling family of click-to-rename components. */
test("a field chip's text is keyboard-focusable and Enter opens edit mode", async () => {
  await withJsdom(async () => {
    renderFieldChip(() => {});

    const chipText = document.querySelector(".chip-text") as HTMLElement;
    assert.equal(chipText.getAttribute("role"), "button");
    assert.equal(chipText.getAttribute("tabIndex"), "0");

    fireEvent.keyDown(chipText, { key: "Enter" });
    await waitForCondition(() => document.querySelector(".chip-rename-edit input") !== null);
    assert.ok(document.querySelector(".chip-rename-edit input"), "Enter should have entered edit mode");
  });
});

test("pressing Escape while editing a field chip cancels without saving", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renameFieldLabel must never be called after Escape cancels the edit");
    }) as typeof fetch;

    try {
      const changedProjects: Project[] = [];
      renderFieldChip((p) => changedProjects.push(p));

      fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
      const input = document.querySelector(".chip-rename-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Something else entirely" } });
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(changedProjects.length, 0, "Escape must cancel without ever calling renameFieldLabel");
      assert.equal(
        document.querySelector(".chip-text")?.textContent,
        "email *",
        "the original field text (with its required marker) must be shown, unchanged",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("submitting the add-field form calls the real POST endpoint scoped to the given entity, with the trimmed label, and reports the returned project", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedLabel: string | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/entities/Customer/fields") {
        postedLabel = (JSON.parse(init.body as string) as { label: string }).label;
        const newField = { name: "phone", type: "text", required: false, label: postedLabel };
        const withNewField = {
          ...baseProject,
          spec: {
            ...baseProject.spec,
            entities: [{ ...baseProject.spec.entities[0], fields: [...baseProject.spec.entities[0].fields, newField] }],
          },
        };
        return new Response(JSON.stringify({ project: withNewField }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddFieldForm((p) => addedProjects.push(p));

      const input = document.querySelector(".spec-add-item-form input") as HTMLInputElement;
      const button = document.querySelector(".spec-add-item-form button") as HTMLButtonElement;
      assert.ok(input && button, "expected an add-field input and submit button");
      assert.equal(button.disabled, true, "the submit button must start disabled with an empty input");

      fireEvent.change(input, { target: { value: "  Phone  " } });
      fireEvent.click(button);

      await waitForCondition(() => addedProjects.length === 1);
      assert.equal(postedLabel, "Phone", "the posted label must be trimmed before sending");
      assert.deepEqual(
        addedProjects[0].spec.entities[0].fields.map((f) => f.name),
        ["name", "phone"],
      );
      assert.equal(input.value, "", "the input must clear after a successful add");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the add-field form surfaces a real error instead of silently doing nothing, and never fires onAdded", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "label is required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddFieldForm((p) => addedProjects.push(p));

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, {
        target: { value: "Phone" },
      });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => document.querySelector(".spec-add-item-form .error") !== null);
      assert.equal(addedProjects.length, 0, "onAdded must not fire when the request failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Real feature round: the add-field form could previously only ever
 * create a plain optional text field -- no way to ask for an enum, a
 * relation, a number, etc. directly. Confirms choosing "enum" reveals a
 * real enum-values input, and submitting sends type+enumValues (split
 * server-side from the comma-separated text) alongside the label.
 */
test("choosing 'enum' as the add-field type reveals an enum-values input, and submitting sends type+enumValues", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedBody: { label: string; type: string; enumValues?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/entities/Customer/fields") {
        postedBody = JSON.parse(init.body as string) as typeof postedBody;
        return new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    try {
      const addedProjects: Project[] = [];
      renderAddFieldForm((p) => addedProjects.push(p));

      assert.equal(
        document.querySelectorAll(".spec-add-field-form input").length,
        1,
        "the enum-values input must not render until 'enum' is actually chosen",
      );

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Status" } });
      fireEvent.change(document.querySelector(".spec-add-field-form select") as HTMLSelectElement, { target: { value: "enum" } });

      const enumValuesInput = document.querySelectorAll(".spec-add-field-form input")[1] as HTMLInputElement;
      assert.ok(enumValuesInput, "expected a second input for enum values once 'enum' is chosen");
      fireEvent.change(enumValuesInput, { target: { value: "New, In Progress, Done" } });

      fireEvent.click(document.querySelector(".spec-add-field-form button") as HTMLButtonElement);
      await waitForCondition(() => addedProjects.length === 1);

      assert.deepEqual(postedBody, { label: "Status", type: "enum", enumValues: "New, In Progress, Done" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The relation half of the same feature: the target is always a
 * `<select>` of this entity's real sibling names (never free text), so
 * there's no "typo vs. deliberate placeholder" ambiguity -- confirms the
 * dropdown is populated from the real entity list passed in, defaults to
 * the first one, and submitting sends type+relationTo.
 */
test("choosing 'relation' as the add-field type reveals a dropdown of this project's real sibling entities, and submitting sends type+relationTo", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let postedBody: { label: string; type: string; relationTo?: string } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input === "/api/projects/proj1/entities/Customer/fields") {
        postedBody = JSON.parse(init.body as string) as typeof postedBody;
        return new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;

    const entities: Entity[] = [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Deal", fields: [{ name: "amount", type: "number", required: false }] },
    ];

    try {
      const addedProjects: Project[] = [];
      renderAddFieldForm((p) => addedProjects.push(p), entities);

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Account" } });
      fireEvent.change(document.querySelector(".spec-add-field-form select") as HTMLSelectElement, { target: { value: "relation" } });

      const relationSelect = document.querySelectorAll(".spec-add-field-form select")[1] as HTMLSelectElement;
      assert.ok(relationSelect, "expected a second select for the relation target once 'relation' is chosen");
      assert.deepEqual(
        Array.from(relationSelect.options).map((o) => o.value),
        ["Customer", "Deal"],
        "the relation target dropdown must list every real entity in this project, including this entity itself",
      );

      fireEvent.change(relationSelect, { target: { value: "Deal" } });
      fireEvent.click(document.querySelector(".spec-add-field-form button") as HTMLButtonElement);
      await waitForCondition(() => addedProjects.length === 1);

      assert.deepEqual(postedBody, { label: "Account", type: "relation", relationTo: "Deal" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1059: the forward half of the same gap, one level up. Round 1026
 * only cross-gated a field chip's own three actions (remove/required-
 * toggle/type-change) against each other; it never considered
 * AddFieldForm -- same screen, same entity, same full-project-replace
 * onChanged/onAdded -- at all. Toggling one field's "required" flag while
 * adding a brand-new field to the same entity fires two concurrent
 * requests that both read-modify-write the whole project.spec with no
 * staleness guard on either route (confirmed by reading routes/projects.ts's
 * own .../fields and .../fields/:name/required handlers), so whichever
 * response the browser *receives* last silently overwrites the other via
 * the shared setProject-style replace.
 */
test("the add-field form is disabled while a sibling field's required-toggle request is still in flight, and a different field's own controls are too", async () => {
  await withJsdom(async () => {
    const twoFieldEntity: Entity = {
      name: "Customer",
      fields: [
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
      ],
    };
    const originalFetch = globalThis.fetch;
    let resolveRequiredPatch: (() => void) | undefined;
    const requiredGate = new Promise<void>((resolve) => {
      resolveRequiredPatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/fields/email/required") {
        await requiredGate;
        return new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } });
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
            React.createElement(EntitySummaryItem, {
              entity: twoFieldEntity,
              allEntities: [twoFieldEntity],
              fieldsSummary: "email, phone",
              projectId: "proj1",
              canRemove: true,
              onRenamed: () => {},
              onRemoved: () => {},
            }),
          ),
        ),
      );

      const requiredCheckboxes = document.querySelectorAll(".chip-field-required input");
      fireEvent.click(requiredCheckboxes[0] as HTMLInputElement); // toggles "email"'s own required flag
      await waitForCondition(() => (requiredCheckboxes[0] as HTMLInputElement).disabled);

      const addFieldInput = document.querySelector(".spec-add-field-form input") as HTMLInputElement;
      const addFieldButton = document.querySelector(".spec-add-field-form button") as HTMLButtonElement;
      assert.equal(
        addFieldInput.disabled,
        true,
        "the add-field form's own input must be disabled while a sibling field's action is still in flight",
      );
      assert.equal(
        addFieldButton.disabled,
        true,
        "the add-field form's own submit button must be disabled while a sibling field's action is still in flight",
      );
      assert.equal(
        (requiredCheckboxes[1] as HTMLInputElement).disabled,
        true,
        "a different field's own required checkbox must also be disabled while a sibling field's action is still in flight",
      );
    } finally {
      // Always resolves the gate, even if an assertion above threw -- see
      // round 1026's own identical comment on why this must live in finally.
      resolveRequiredPatch!();
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The other direction of the same gate: adding a brand-new field must
 * also block every existing sibling field chip's own controls, not just
 * the reverse.
 */
test("a sibling field chip's own controls are disabled while the add-field form's own request is still in flight", async () => {
  await withJsdom(async () => {
    const twoFieldEntity: Entity = {
      name: "Customer",
      fields: [
        { name: "email", type: "text", required: false },
        { name: "phone", type: "text", required: false },
      ],
    };
    const originalFetch = globalThis.fetch;
    let resolveAddPost: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      resolveAddPost = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/projects/proj1/entities/Customer/fields") {
        await addGate;
        return new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } });
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
            React.createElement(EntitySummaryItem, {
              entity: twoFieldEntity,
              allEntities: [twoFieldEntity],
              fieldsSummary: "email, phone",
              projectId: "proj1",
              canRemove: true,
              onRenamed: () => {},
              onRemoved: () => {},
            }),
          ),
        ),
      );

      fireEvent.change(document.querySelector(".spec-add-field-form input") as HTMLInputElement, { target: { value: "Fax" } });
      fireEvent.click(document.querySelector(".spec-add-field-form button") as HTMLButtonElement);

      await waitForCondition(() => (document.querySelector(".chip-field-required input") as HTMLInputElement).disabled);

      assert.equal(
        (document.querySelectorAll(".chip-field-required input")[1] as HTMLInputElement).disabled,
        true,
        "a sibling field chip's own required checkbox must be disabled while the add-field form's own request is still in flight",
      );
      assert.equal(
        (document.querySelector(".chip-remove") as HTMLButtonElement).disabled,
        true,
        "a sibling field chip's own remove button must be disabled while the add-field form's own request is still in flight",
      );
    } finally {
      resolveAddPost!();
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1063: the entity-level counterpart to the two tests just above --
 * round 1059 deliberately deferred cross-gating AddEntityForm against
 * EntitySummaryItem (a bigger lift, crossing into App.tsx), closed this
 * round. App.tsx itself is too large to practically render whole in this
 * test file, so these tests confirm the new plumbing each component now
 * exposes (siblingActionBusy/onBusyChange on EntitySummaryItem,
 * disabled/onBusyChange on AddEntityForm) -- the same props App.tsx's own
 * new entityBusyMap/addEntityBusy aggregation (a direct structural copy
 * of EntitySummaryItem's own already-tested fieldBusyMap/addFieldBusy
 * pattern) wires together.
 */
test("EntitySummaryItem's own remove button and rename are disabled while siblingActionBusy is true, and re-enable once it clears", async () => {
  await withJsdom(async () => {
    const entity = baseProject.spec.entities[0];
    const renderWithSiblingBusy = (siblingActionBusy: boolean) =>
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(EntitySummaryItem, {
              entity,
              allEntities: baseProject.spec.entities,
              fieldsSummary: "name *",
              projectId: "proj1",
              canRemove: true,
              onRenamed: () => {},
              onRemoved: () => {},
              siblingActionBusy,
            }),
          ),
        ),
      );

    renderWithSiblingBusy(true);
    assert.equal(
      (document.querySelector(".entity-summary-remove") as HTMLButtonElement).disabled,
      true,
      "the remove button must be disabled while a sibling entity's own action (or AddEntityForm) is in flight",
    );
    fireEvent.click(document.querySelector(".entity-summary-label") as HTMLElement);
    assert.equal(
      document.querySelector(".entity-summary-rename-edit") === null,
      true,
      "clicking the label must not open the rename editor while siblingActionBusy is true",
    );
    cleanup();

    renderWithSiblingBusy(false);
    assert.equal(
      (document.querySelector(".entity-summary-remove") as HTMLButtonElement).disabled,
      false,
      "the remove button must re-enable once siblingActionBusy clears",
    );
  });
});

test("EntitySummaryItem reports its own busy state up via onBusyChange while its remove is in flight, and clears its entry on unmount", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRemove!: (value: Response) => void;
    const removeHeld = new Promise<Response>((resolve) => {
      resolveRemove = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Customer") return removeHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: Array<[string, boolean]> = [];
    try {
      const { unmount } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(EntitySummaryItem, {
              entity: baseProject.spec.entities[0],
              allEntities: baseProject.spec.entities,
              fieldsSummary: "name *",
              projectId: "proj1",
              canRemove: true,
              onRenamed: () => {},
              onRemoved: () => {},
              onBusyChange: (entityName: string, busy: boolean) => busyCalls.push([entityName, busy]),
            }),
          ),
        ),
      );

      fireEvent.click(document.querySelector(".entity-summary-remove") as HTMLButtonElement);
      await waitForCondition(() => busyCalls.some(([name, busy]) => name === "Customer" && busy === true));

      resolveRemove(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.some(([name, busy]) => name === "Customer" && busy === false));

      busyCalls.length = 0;
      unmount();
      assert.deepEqual(busyCalls, [["Customer", false]], "unmounting must report this entity's own entry as no longer busy, so a removed entity never lingers in the parent's aggregate");
    } finally {
      resolveRemove!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1194: see RoleChip's own identical "the instant its rename editor
 * opens" test (round 1147) -- same gap, missed when round 1147's fix was
 * applied to RoleChip/AssumptionItem/PersonaItem but not to this sibling,
 * which shares the exact same useRenamableSpecItem-based architecture.
 * Confirms onBusyChange now fires true the instant this entity's rename
 * editor opens (no save in flight), which is what a sibling entity's own
 * siblingActionBusy (and so its remove button) depends on -- without this,
 * a sibling entity's remove stayed enabled the whole time this entity's
 * rename draft sat open and unsaved, and entity remove/rename routes have
 * no server-side staleness check at all (see handleStartRename's own
 * round-1027 comment in SpecListItemRemover.tsx).
 */
test("EntitySummaryItem reports its own busy state up via onBusyChange the instant its rename editor opens, with no save in flight", async () => {
  await withJsdom(async () => {
    const busyCalls: Array<[string, boolean]> = [];
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(EntitySummaryItem, {
            entity: baseProject.spec.entities[0],
            allEntities: baseProject.spec.entities,
            fieldsSummary: "name *",
            projectId: "proj1",
            canRemove: true,
            onRenamed: () => {},
            onRemoved: () => {},
            onBusyChange: (entityName: string, busy: boolean) => busyCalls.push([entityName, busy]),
          }),
        ),
      ),
    );

    fireEvent.click(document.querySelector(".entity-summary-label") as HTMLElement);
    assert.equal(document.querySelector(".entity-summary-rename-edit") !== null, true, "the rename editor must actually be open");
    assert.equal(
      busyCalls.some(([name, busy]) => name === "Customer" && busy === true),
      true,
      "opening the rename editor (not yet saving anything) must already report this entity as busy",
    );

    busyCalls.length = 0;
    fireEvent.keyDown(document.querySelector(".entity-summary-rename-edit input") as HTMLInputElement, { key: "Escape" });
    assert.equal(document.querySelector(".entity-summary-rename-edit") === null, true, "Escape must cancel the editor without saving");
    assert.equal(
      busyCalls.some(([name, busy]) => name === "Customer" && busy === false),
      true,
      "cancelling the still-unsaved edit must report this entity as no longer busy",
    );
  });
});

test("AddEntityForm's own input and submit button are disabled while its disabled prop is true, regardless of its own local busy state", async () => {
  await withJsdom(async () => {
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(AddEntityForm, { projectId: "proj1", onAdded: () => {}, disabled: true }),
        ),
      ),
    );
    fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Order" } });
    assert.equal((document.querySelector(".spec-add-item-form input") as HTMLInputElement).disabled, true, "the input must be disabled while the disabled prop is true");
    assert.equal((document.querySelector(".spec-add-item-form button") as HTMLButtonElement).disabled, true, "the submit button must be disabled while the disabled prop is true");
  });
});

test("AddEntityForm reports its own busy state up via onBusyChange while its own add request is in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveAdd!: (value: Response) => void;
    const addHeld = new Promise<Response>((resolve) => {
      resolveAdd = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/projects/proj1/entities") return addHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: boolean[] = [];
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AddEntityForm, { projectId: "proj1", onAdded: () => {}, onBusyChange: (busy: boolean) => busyCalls.push(busy) }),
          ),
        ),
      );

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Order" } });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => busyCalls.includes(true));
      resolveAdd(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.length >= 2 && busyCalls[busyCalls.length - 1] === false);
    } finally {
      resolveAdd!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 696: a viewer collaborator can genuinely land on this exact spec
 * review screen (App.tsx routes any unbuilt project straight to "spec"
 * regardless of role, and a collaborator can be invited before build), and
 * the server already rejects every one of these components' writes with
 * 403 VIEWER_READ_ONLY -- but none of them had ever been gated client-side
 * at all, unlike their two siblings on the same screen (ProjectNameEditor/
 * ProjectDescriptionEditor, both already readOnly-aware). readOnly=true
 * must render each item as plain, non-interactive content (no rename/
 * remove affordance) and omit every add-form entirely, mirroring
 * CheckpointLabelEditor's own established `if (readOnly) return <strong>`
 * pattern.
 */
test("a role chip in readOnly mode renders the plain role text with no rename or remove affordance", async () => {
  await withJsdom(async () => {
    renderRoleChip(() => {}, true, () => {}, true);
    assert.equal(document.body.textContent, "Manager");
    assert.equal(document.querySelector(".chip-remove") === null, true, "a read-only role chip must never show a remove button");
    assert.equal(document.querySelector(".chip-text") === null, true, "a read-only role chip must never show a clickable rename affordance");
  });
});

test("an assumption item in readOnly mode renders the plain text with no rename or remove affordance", async () => {
  await withJsdom(async () => {
    renderAssumptionItem(() => {}, () => {}, true);
    assert.equal(document.body.textContent, "Second assumption");
    assert.equal(document.querySelector(".assumption-remove") === null, true, "a read-only assumption must never show a remove button");
    assert.equal(document.querySelector(".assumption-text") === null, true, "a read-only assumption must never show a clickable rename affordance");
  });
});

test("a persona item in readOnly mode renders the plain text with no rename or remove affordance", async () => {
  await withJsdom(async () => {
    renderPersonaItem(() => {}, () => {}, true);
    assert.equal(document.body.textContent, "Second persona");
    assert.equal(document.querySelector(".persona-remove") === null, true, "a read-only persona must never show a remove button");
    assert.equal(document.querySelector(".persona-text") === null, true, "a read-only persona must never show a clickable rename affordance");
  });
});

test("an entity summary in readOnly mode renders the plain entity label with no rename/remove affordance, its field chips are also read-only, and the add-field form is omitted entirely", async () => {
  await withJsdom(async () => {
    renderEntitySummaryItem(() => {}, true, () => {}, true);
    assert.equal(document.querySelector(".entity-summary-remove") === null, true, "a read-only entity summary must never show a remove button");
    assert.equal(
      document.querySelector(".entity-summary-label[role='button']") === null,
      true,
      "a read-only entity summary's label must never be a clickable rename affordance",
    );
    assert.match(document.body.textContent ?? "", /Customer/);
    assert.equal(document.querySelector(".spec-add-field-form") === null, true, "a read-only entity summary must never show the add-field form");
    assert.equal(document.querySelector(".chip-remove") === null, true, "a read-only entity summary's own field chips must also be read-only");
    assert.equal(document.querySelector("select.chip-field-type") === null, true, "a read-only field chip must never show the field-type select");
  });
});

test("a field chip in readOnly mode renders the plain field label (with the required marker) and no type select, required checkbox, rename, or remove affordance", async () => {
  await withJsdom(async () => {
    renderFieldChip(() => {}, true, { name: "email", type: "text", required: true }, baseProject.spec.entities, true);
    assert.match(document.body.textContent ?? "", /email \*/);
    assert.equal(document.querySelector(".chip-remove") === null, true);
    assert.equal(document.querySelector("select.chip-field-type") === null, true);
    assert.equal(document.querySelector("input[type='checkbox']") === null, true, "a read-only field chip must never show the required checkbox");
    assert.equal(document.querySelector(".chip-text[role='button']") === null, true, "a read-only field chip's label must never be a clickable rename affordance");
  });
});

test("AddRoleForm, AddAssumptionForm, AddPersonaForm, AddEntityForm, and AddFieldForm all render nothing at all in readOnly mode", async () => {
  await withJsdom(async () => {
    renderAddRoleForm(() => {}, true);
    assert.equal(document.querySelector("form") === null, true, "a read-only AddRoleForm must render nothing");
    cleanup();

    renderAddAssumptionForm(() => {}, true);
    assert.equal(document.querySelector("form") === null, true, "a read-only AddAssumptionForm must render nothing");
    cleanup();

    renderAddPersonaForm(() => {}, true);
    assert.equal(document.querySelector("form") === null, true, "a read-only AddPersonaForm must render nothing");
    cleanup();

    renderAddEntityForm(() => {}, true);
    assert.equal(document.querySelector("form") === null, true, "a read-only AddEntityForm must render nothing");
    cleanup();

    renderAddFieldForm(() => {}, baseProject.spec.entities, true);
    assert.equal(document.querySelector("form") === null, true, "a read-only AddFieldForm must render nothing");
  });
});

/**
 * Round 1133: the identical round-1063 cross-gate (EntitySummaryItem vs.
 * AddEntityForm, tested just above), extended to this file's three plain
 * string-list sibling families -- RoleChip/PersonaItem/AssumptionItem vs.
 * their own AddRoleForm/AddPersonaForm/AddAssumptionForm. Unlike entities/
 * fields, these three lists have no stable identity beyond array position,
 * so onBusyChange is keyed by `index` (a number) rather than by name.
 */
test("RoleChip's own remove button and rename are disabled while siblingActionBusy is true, and re-enable once it clears", async () => {
  await withJsdom(async () => {
    const renderWithSiblingBusy = (siblingActionBusy: boolean) =>
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(RoleChip, {
              role: "Manager",
              projectId: "proj1",
              index: 1,
              canRemove: true,
              onRenamed: () => {},
              onRemoved: () => {},
              siblingActionBusy,
            }),
          ),
        ),
      );

    renderWithSiblingBusy(true);
    assert.equal(
      (document.querySelector(".chip-remove") as HTMLButtonElement).disabled,
      true,
      "the remove button must be disabled while a sibling role's own action (or AddRoleForm) is in flight",
    );
    fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
    assert.equal(
      document.querySelector(".chip-rename-edit") === null,
      true,
      "clicking the label must not open the rename editor while siblingActionBusy is true",
    );
    cleanup();

    renderWithSiblingBusy(false);
    assert.equal(
      (document.querySelector(".chip-remove") as HTMLButtonElement).disabled,
      false,
      "the remove button must re-enable once siblingActionBusy clears",
    );
  });
});

test("RoleChip reports its own busy state up via onBusyChange (keyed by index) while its remove is in flight, and clears its entry on unmount", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRemove!: (value: Response) => void;
    const removeHeld = new Promise<Response>((resolve) => {
      resolveRemove = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && input === "/api/projects/proj1/roles/1") return removeHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: Array<[number, boolean]> = [];
    try {
      const { unmount } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(RoleChip, {
              role: "Manager",
              projectId: "proj1",
              index: 1,
              canRemove: true,
              onRenamed: () => {},
              onRemoved: () => {},
              onBusyChange: (index: number, busy: boolean) => busyCalls.push([index, busy]),
            }),
          ),
        ),
      );

      fireEvent.click(document.querySelector(".chip-remove") as HTMLButtonElement);
      await waitForCondition(() => busyCalls.some(([index, busy]) => index === 1 && busy === true));

      resolveRemove(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.some(([index, busy]) => index === 1 && busy === false));

      busyCalls.length = 0;
      unmount();
      assert.deepEqual(busyCalls, [[1, false]], "unmounting must report this role's own entry as no longer busy, so a removed role never lingers in the parent's aggregate");
    } finally {
      resolveRemove!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1147: round 1133's own `ownBusy` here only ever included
 * `rename.busy` (true while the save PATCH is in flight), never
 * `rename.editing` (true the moment the rename form opens, before
 * anything is submitted). So opening this chip's own rename editor never
 * reported busy up to App.tsx at all -- a SIBLING role's own remove
 * button stayed enabled the whole time a draft rename sat open and
 * unsaved. Removing that sibling shifts every later role's own array
 * index, which changes THIS chip's own `key={`${index}-${role}`}` in
 * App.tsx and makes React unmount it, silently discarding the open editor
 * and its typed draft with no warning. This confirms `onBusyChange` now
 * fires `true` the instant the editor opens (no save in flight needed),
 * and `false` again once it's cancelled -- never actually saving, so this
 * is purely about the `editing` state, not `rename.busy`.
 */
test("RoleChip reports its own busy state up via onBusyChange the instant its rename editor opens, with no save in flight", async () => {
  await withJsdom(async () => {
    const busyCalls: Array<[number, boolean]> = [];
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(RoleChip, {
            role: "Manager",
            projectId: "proj1",
            index: 1,
            canRemove: true,
            onRenamed: () => {},
            onRemoved: () => {},
            onBusyChange: (index: number, busy: boolean) => busyCalls.push([index, busy]),
          }),
        ),
      ),
    );

    fireEvent.click(document.querySelector(".chip-text") as HTMLElement);
    assert.equal(document.querySelector(".chip-rename-edit") !== null, true, "the rename editor must actually be open");
    assert.equal(
      busyCalls.some(([index, busy]) => index === 1 && busy === true),
      true,
      "opening the rename editor (not yet saving anything) must already report this role's own index as busy",
    );

    busyCalls.length = 0;
    fireEvent.keyDown(document.querySelector(".chip-rename-edit input") as HTMLInputElement, { key: "Escape" });
    assert.equal(document.querySelector(".chip-rename-edit") === null, true, "Escape must cancel the editor without saving");
    assert.equal(
      busyCalls.some(([index, busy]) => index === 1 && busy === false),
      true,
      "cancelling the still-unsaved edit must report this role's own index as no longer busy",
    );
  });
});

test("AssumptionItem's own remove button and rename are disabled while siblingActionBusy is true, and re-enable once it clears", async () => {
  await withJsdom(async () => {
    const renderWithSiblingBusy = (siblingActionBusy: boolean) =>
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AssumptionItem, {
              assumption: "Second assumption",
              projectId: "proj1",
              index: 1,
              onRenamed: () => {},
              onRemoved: () => {},
              siblingActionBusy,
            }),
          ),
        ),
      );

    renderWithSiblingBusy(true);
    assert.equal(
      (document.querySelector(".assumption-remove") as HTMLButtonElement).disabled,
      true,
      "the remove button must be disabled while a sibling assumption's own action (or AddAssumptionForm) is in flight",
    );
    fireEvent.click(document.querySelector(".assumption-text") as HTMLElement);
    assert.equal(
      document.querySelector(".assumption-rename-edit") === null,
      true,
      "clicking the label must not open the rename editor while siblingActionBusy is true",
    );
    cleanup();

    renderWithSiblingBusy(false);
    assert.equal(
      (document.querySelector(".assumption-remove") as HTMLButtonElement).disabled,
      false,
      "the remove button must re-enable once siblingActionBusy clears",
    );
  });
});

test("AssumptionItem reports its own busy state up via onBusyChange (keyed by index) while its remove is in flight, and clears its entry on unmount", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRemove!: (value: Response) => void;
    const removeHeld = new Promise<Response>((resolve) => {
      resolveRemove = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && input === "/api/projects/proj1/assumptions/1") return removeHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: Array<[number, boolean]> = [];
    try {
      const { unmount } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AssumptionItem, {
              assumption: "Second assumption",
              projectId: "proj1",
              index: 1,
              onRenamed: () => {},
              onRemoved: () => {},
              onBusyChange: (index: number, busy: boolean) => busyCalls.push([index, busy]),
            }),
          ),
        ),
      );

      fireEvent.click(document.querySelector(".assumption-remove") as HTMLButtonElement);
      await waitForCondition(() => busyCalls.some(([index, busy]) => index === 1 && busy === true));

      resolveRemove(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.some(([index, busy]) => index === 1 && busy === false));

      busyCalls.length = 0;
      unmount();
      assert.deepEqual(busyCalls, [[1, false]], "unmounting must report this assumption's own entry as no longer busy, so a removed assumption never lingers in the parent's aggregate");
    } finally {
      resolveRemove!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

/** Round 1147: see RoleChip's own identical "the instant its rename editor opens" test -- same gap, same fix. */
test("AssumptionItem reports its own busy state up via onBusyChange the instant its rename editor opens, with no save in flight", async () => {
  await withJsdom(async () => {
    const busyCalls: Array<[number, boolean]> = [];
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(AssumptionItem, {
            assumption: "Second assumption",
            projectId: "proj1",
            index: 1,
            onRenamed: () => {},
            onRemoved: () => {},
            onBusyChange: (index: number, busy: boolean) => busyCalls.push([index, busy]),
          }),
        ),
      ),
    );

    fireEvent.click(document.querySelector(".assumption-text") as HTMLElement);
    assert.equal(document.querySelector(".assumption-rename-edit") !== null, true, "the rename editor must actually be open");
    assert.equal(
      busyCalls.some(([index, busy]) => index === 1 && busy === true),
      true,
      "opening the rename editor (not yet saving anything) must already report this assumption's own index as busy",
    );

    busyCalls.length = 0;
    fireEvent.keyDown(document.querySelector(".assumption-rename-edit input") as HTMLInputElement, { key: "Escape" });
    assert.equal(document.querySelector(".assumption-rename-edit") === null, true, "Escape must cancel the editor without saving");
    assert.equal(
      busyCalls.some(([index, busy]) => index === 1 && busy === false),
      true,
      "cancelling the still-unsaved edit must report this assumption's own index as no longer busy",
    );
  });
});

test("PersonaItem's own remove button and rename are disabled while siblingActionBusy is true, and re-enable once it clears", async () => {
  await withJsdom(async () => {
    const renderWithSiblingBusy = (siblingActionBusy: boolean) =>
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(PersonaItem, {
              persona: "Second persona",
              projectId: "proj1",
              index: 1,
              onRenamed: () => {},
              onRemoved: () => {},
              siblingActionBusy,
            }),
          ),
        ),
      );

    renderWithSiblingBusy(true);
    assert.equal(
      (document.querySelector(".persona-remove") as HTMLButtonElement).disabled,
      true,
      "the remove button must be disabled while a sibling persona's own action (or AddPersonaForm) is in flight",
    );
    fireEvent.click(document.querySelector(".persona-text") as HTMLElement);
    assert.equal(
      document.querySelector(".persona-rename-edit") === null,
      true,
      "clicking the label must not open the rename editor while siblingActionBusy is true",
    );
    cleanup();

    renderWithSiblingBusy(false);
    assert.equal(
      (document.querySelector(".persona-remove") as HTMLButtonElement).disabled,
      false,
      "the remove button must re-enable once siblingActionBusy clears",
    );
  });
});

test("PersonaItem reports its own busy state up via onBusyChange (keyed by index) while its remove is in flight, and clears its entry on unmount", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRemove!: (value: Response) => void;
    const removeHeld = new Promise<Response>((resolve) => {
      resolveRemove = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && input === "/api/projects/proj1/personas/1") return removeHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: Array<[number, boolean]> = [];
    try {
      const { unmount } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(PersonaItem, {
              persona: "Second persona",
              projectId: "proj1",
              index: 1,
              onRenamed: () => {},
              onRemoved: () => {},
              onBusyChange: (index: number, busy: boolean) => busyCalls.push([index, busy]),
            }),
          ),
        ),
      );

      fireEvent.click(document.querySelector(".persona-remove") as HTMLButtonElement);
      await waitForCondition(() => busyCalls.some(([index, busy]) => index === 1 && busy === true));

      resolveRemove(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.some(([index, busy]) => index === 1 && busy === false));

      busyCalls.length = 0;
      unmount();
      assert.deepEqual(busyCalls, [[1, false]], "unmounting must report this persona's own entry as no longer busy, so a removed persona never lingers in the parent's aggregate");
    } finally {
      resolveRemove!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

/** Round 1147: see RoleChip's own identical "the instant its rename editor opens" test -- same gap, same fix. */
test("PersonaItem reports its own busy state up via onBusyChange the instant its rename editor opens, with no save in flight", async () => {
  await withJsdom(async () => {
    const busyCalls: Array<[number, boolean]> = [];
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(PersonaItem, {
            persona: "Second persona",
            projectId: "proj1",
            index: 1,
            onRenamed: () => {},
            onRemoved: () => {},
            onBusyChange: (index: number, busy: boolean) => busyCalls.push([index, busy]),
          }),
        ),
      ),
    );

    fireEvent.click(document.querySelector(".persona-text") as HTMLElement);
    assert.equal(document.querySelector(".persona-rename-edit") !== null, true, "the rename editor must actually be open");
    assert.equal(
      busyCalls.some(([index, busy]) => index === 1 && busy === true),
      true,
      "opening the rename editor (not yet saving anything) must already report this persona's own index as busy",
    );

    busyCalls.length = 0;
    fireEvent.keyDown(document.querySelector(".persona-rename-edit input") as HTMLInputElement, { key: "Escape" });
    assert.equal(document.querySelector(".persona-rename-edit") === null, true, "Escape must cancel the editor without saving");
    assert.equal(
      busyCalls.some(([index, busy]) => index === 1 && busy === false),
      true,
      "cancelling the still-unsaved edit must report this persona's own index as no longer busy",
    );
  });
});

test("AddRoleForm's own input and submit button are disabled while its disabled prop is true, regardless of its own local busy state", async () => {
  await withJsdom(async () => {
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(AddRoleForm, { projectId: "proj1", onAdded: () => {}, disabled: true }),
        ),
      ),
    );
    fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Director" } });
    assert.equal((document.querySelector(".spec-add-item-form input") as HTMLInputElement).disabled, true, "the input must be disabled while the disabled prop is true");
    assert.equal((document.querySelector(".spec-add-item-form button") as HTMLButtonElement).disabled, true, "the submit button must be disabled while the disabled prop is true");
  });
});

test("AddRoleForm reports its own busy state up via onBusyChange while its own add request is in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveAdd!: (value: Response) => void;
    const addHeld = new Promise<Response>((resolve) => {
      resolveAdd = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/projects/proj1/roles") return addHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: boolean[] = [];
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AddRoleForm, { projectId: "proj1", onAdded: () => {}, onBusyChange: (busy: boolean) => busyCalls.push(busy) }),
          ),
        ),
      );

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Director" } });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => busyCalls.includes(true));
      resolveAdd(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.length >= 2 && busyCalls[busyCalls.length - 1] === false);
    } finally {
      resolveAdd!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

test("AddAssumptionForm's own input and submit button are disabled while its disabled prop is true, regardless of its own local busy state", async () => {
  await withJsdom(async () => {
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(AddAssumptionForm, { projectId: "proj1", onAdded: () => {}, disabled: true }),
        ),
      ),
    );
    fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Third assumption" } });
    assert.equal((document.querySelector(".spec-add-item-form input") as HTMLInputElement).disabled, true, "the input must be disabled while the disabled prop is true");
    assert.equal((document.querySelector(".spec-add-item-form button") as HTMLButtonElement).disabled, true, "the submit button must be disabled while the disabled prop is true");
  });
});

test("AddAssumptionForm reports its own busy state up via onBusyChange while its own add request is in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveAdd!: (value: Response) => void;
    const addHeld = new Promise<Response>((resolve) => {
      resolveAdd = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/projects/proj1/assumptions") return addHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: boolean[] = [];
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AddAssumptionForm, { projectId: "proj1", onAdded: () => {}, onBusyChange: (busy: boolean) => busyCalls.push(busy) }),
          ),
        ),
      );

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Third assumption" } });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => busyCalls.includes(true));
      resolveAdd(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.length >= 2 && busyCalls[busyCalls.length - 1] === false);
    } finally {
      resolveAdd!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});

test("AddPersonaForm's own input and submit button are disabled while its disabled prop is true, regardless of its own local busy state", async () => {
  await withJsdom(async () => {
    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(AddPersonaForm, { projectId: "proj1", onAdded: () => {}, disabled: true }),
        ),
      ),
    );
    fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Third persona" } });
    assert.equal((document.querySelector(".spec-add-item-form input") as HTMLInputElement).disabled, true, "the input must be disabled while the disabled prop is true");
    assert.equal((document.querySelector(".spec-add-item-form button") as HTMLButtonElement).disabled, true, "the submit button must be disabled while the disabled prop is true");
  });
});

test("AddPersonaForm reports its own busy state up via onBusyChange while its own add request is in flight", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveAdd!: (value: Response) => void;
    const addHeld = new Promise<Response>((resolve) => {
      resolveAdd = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && input === "/api/projects/proj1/personas") return addHeld;
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const busyCalls: boolean[] = [];
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AddPersonaForm, { projectId: "proj1", onAdded: () => {}, onBusyChange: (busy: boolean) => busyCalls.push(busy) }),
          ),
        ),
      );

      fireEvent.change(document.querySelector(".spec-add-item-form input") as HTMLInputElement, { target: { value: "Third persona" } });
      fireEvent.click(document.querySelector(".spec-add-item-form button") as HTMLButtonElement);

      await waitForCondition(() => busyCalls.includes(true));
      resolveAdd(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => busyCalls.length >= 2 && busyCalls[busyCalls.length - 1] === false);
    } finally {
      resolveAdd!(new Response(JSON.stringify({ project: baseProject }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = originalFetch;
    }
  });
});
