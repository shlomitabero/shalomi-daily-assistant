import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Field, Project } from "@forge/shared";
import {
  AddAssumptionForm,
  AddEntityForm,
  AddFieldForm,
  AddRoleForm,
  AssumptionItem,
  EntitySummaryItem,
  FieldChip,
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
    personas: [],
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
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(RoleChip, { role: "Manager", projectId: "proj1", index: 1, canRemove, onRenamed, onRemoved }),
      ),
    ),
  );
}

function renderAssumptionItem(onRemoved: (p: Project) => void, onRenamed: (p: Project) => void = () => {}) {
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
        }),
      ),
    ),
  );
}

function renderEntitySummaryItem(
  onRemoved: (p: Project) => void,
  canRemove = true,
  onRenamed: (p: Project) => void = () => {},
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
          fieldsSummary: "name *",
          projectId: "proj1",
          canRemove,
          onRenamed,
          onRemoved,
        }),
      ),
    ),
  );
}

function renderFieldChip(
  onChanged: (p: Project) => void,
  canRemove = true,
  field: Field = { name: "email", type: "text", required: true },
) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(FieldChip, { field, projectId: "proj1", entityName: "Customer", canRemove, onChanged }),
      ),
    ),
  );
}

function renderAddFieldForm(onAdded: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AddFieldForm, { projectId: "proj1", entityName: "Customer", onAdded }),
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

function renderAddEntityForm(onAdded: (p: Project) => void) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(LanguageProvider, null, React.createElement(AddEntityForm, { projectId: "proj1", onAdded })),
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
