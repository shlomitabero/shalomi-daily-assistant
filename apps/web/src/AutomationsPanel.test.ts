import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Project } from "@forge/shared";
import { AutomationsPanel } from "./AutomationsPanel.js";
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
  ownerId: "owner1",
  name: "Orders",
  description: "An order-tracking app",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "An order-tracking app",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Order",
        label: "Order",
        fields: [
          { name: "customerName", label: "Customer Name", type: "text", required: true },
          { name: "customerPhone", label: "Customer Phone", type: "text", required: false },
          { name: "status", label: "Status", type: "text", required: true },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

function renderPanel(onClose: () => void = () => {}) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AutomationsPanel, { projectId: "proj1", project, onClose }),
      ),
    ),
  );
}

function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rule1",
    entityName: "Order",
    trigger: "field_equals",
    fieldName: "status",
    fieldValue: "Delivered",
    toMode: "field",
    toNumber: null,
    toField: "customerPhone",
    messageTemplate: "Hi {{customerName}}, delivered!",
    enabled: true,
    lastTriggeredAt: null,
    lastStatus: null,
    lastError: null,
    ...overrides,
  };
}

test("AutomationsPanel lists existing rules once loaded, describing the trigger condition and destination", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);
      const row = document.querySelector(".automations-rule-row")!;
      assert.match(row.textContent ?? "", /status/);
      assert.match(row.textContent ?? "", /Delivered/);
      assert.match(row.textContent ?? "", /customerPhone/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel shows the empty state when no rules exist yet", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);
      assert.equal(document.querySelectorAll(".automations-rule-row").length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel shows a real error with a Retry button when the initial load fails", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Server exploded" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelector(".error-retry-row") !== null);
      assert.match(document.querySelector(".error-retry-row p.error")!.textContent ?? "", /Server exploded/);

      fireEvent.click(document.querySelector(".error-retry-row button")!);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);
      assert.equal(document.querySelector(".error-retry-row"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel creates a new rule from the form and adds it to the list without a reload", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Order/automations") {
        createBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: makeRule({ id: "rule2", ...createBody }) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Hi {{customerName}}, delivered!" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);
      assert.equal(createBody?.trigger, "record_created", "default trigger is record_created when the form is submitted untouched");
      assert.equal(createBody?.actionType, "send_whatsapp");
      assert.equal(createBody?.messageTemplate, "Hi {{customerName}}, delivered!");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel's enable/disable button toggles the rule and reflects the server's own updated state", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule({ enabled: true })] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/automations/rule1") {
        patchBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: makeRule({ enabled: false }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);
      assert.match(document.querySelector(".automations-rule-actions")!.textContent ?? "", /Enabled/i);

      fireEvent.click(document.querySelector(".automations-rule-actions button") as HTMLButtonElement);
      await waitForCondition(() => /Disabled/i.test(document.querySelector(".automations-rule-actions")!.textContent ?? ""));
      assert.equal(patchBody?.enabled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel's delete button asks for confirmation, and declining leaves the rule untouched", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/automations/rule1") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => false) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const deleteBtn = document.querySelector(".automations-rule-actions .danger") as HTMLButtonElement;
      fireEvent.click(deleteBtn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(deleteCalls, 0, "declining the confirm must never call the delete API");
      assert.equal(document.querySelectorAll(".automations-rule-row").length, 1, "the rule must still be listed after declining");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

test("AutomationsPanel actually removes the rule once the delete confirmation is accepted", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    let deleteCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/automations/rule1") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const deleteBtn = document.querySelector(".automations-rule-actions .danger") as HTMLButtonElement;
      fireEvent.click(deleteBtn);
      await waitForCondition(() => deleteCalls === 1);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 0);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

test("AutomationsPanel's Close button calls onClose", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    let closed = 0;
    try {
      renderPanel(() => (closed += 1));
      await waitForCondition(() => document.querySelector(".history-header button") !== null);
      fireEvent.click(document.querySelector(".history-header button") as HTMLButtonElement);
      assert.equal(closed, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
