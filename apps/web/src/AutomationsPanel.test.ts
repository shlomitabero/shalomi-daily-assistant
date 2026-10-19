import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
    actionType: "send_whatsapp",
    toMode: "field",
    toNumber: null,
    toField: "customerPhone",
    webhookUrl: null,
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
      // The fixture entity's fields each have their own label ("Status",
      // "Customer Phone") distinct from their raw name -- round 667's fix
      // made describeRule/describeDestination show that label, same as
      // this panel's own create-form selects already did.
      assert.match(row.textContent ?? "", /Status/);
      assert.match(row.textContent ?? "", /Delivered/);
      assert.match(row.textContent ?? "", /Customer Phone/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 667 regression test: describeRule/describeDestination used to
 * interpolate a rule's raw entityName/fieldName/toField/fieldValue
 * directly, instead of looking up the same entity.label/field.label/
 * enumLabels this panel's own create-form selects already show -- a
 * Hebrew-labeled entity/field came back from the server and rendered
 * under its raw, English/camelCase internal name.
 */
const labeledProject: Project = {
  id: "proj4",
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
        label: "הזמנה",
        fields: [
          {
            name: "status",
            label: "סטטוס",
            type: "enum",
            required: true,
            enumValues: ["Delivered", "Pending"],
            enumLabels: { Delivered: "נמסר", Pending: "בהמתנה" },
          },
          { name: "customerPhone", label: "טלפון לקוח", type: "text", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

test("AutomationsPanel's rule list shows the entity/field/enum display labels, not their raw internal names", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj4/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(labeledProject);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);
      const row = document.querySelector(".automations-rule-row")!;
      assert.match(row.textContent ?? "", /הזמנה/, "the entity's own label must appear");
      assert.match(row.textContent ?? "", /סטטוס/, "the field's own label must appear");
      assert.match(row.textContent ?? "", /נמסר/, "the enum value's own label must appear");
      assert.match(row.textContent ?? "", /טלפון לקוח/, "the toField's own label must appear");
      assert.doesNotMatch(row.textContent ?? "", /(?<!\p{L})status(?!\p{L})/u, "the raw field name must not appear");
      assert.doesNotMatch(row.textContent ?? "", /Delivered/, "the raw enum value must not appear");
      assert.doesNotMatch(row.textContent ?? "", /customerPhone/, "the raw toField name must not appear");
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

/**
 * Round 705: the Create/Save button's `disabled` only ever checked
 * `!messageTemplate.trim()`, while handleSubmit's own early-return guard
 * also required fieldValue (for trigger "field_equals"), a schedule time/
 * day, a webhook URL, and a phone field or number -- each added for a
 * later trigger/action type without the button's disabled condition being
 * extended to match. The button stayed enabled, clickable, and simply did
 * nothing at all (no fetch, no error, no spinner) when clicked in any of
 * those states. Confirms the button is now genuinely disabled for the
 * field_equals/empty-Value case specifically, that submitting the form in
 * that state makes no request at all, and that filling in the missing
 * value both enables the button and lets the rule actually get created.
 */
test("AutomationsPanel's Create button is disabled (not just silently non-functional) when trigger is field_equals and Value is left blank", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createCalled = false;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Order/automations") {
        createCalled = true;
        const body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: makeRule({ id: "rule2", ...body }) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      // "status" is a plain text field on this fixture's own Order entity
      // (not boolean/enum), so the Value control stays the free-text input
      // this placeholder identifies, defaulting to empty.
      await waitForCondition(() => document.querySelector('input[placeholder="Value (e.g. Shipped)"]') !== null);

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Status changed" } });

      const submitButton = document.querySelector('.automations-create-form button[type="submit"]') as HTMLButtonElement;
      assert.equal(submitButton.disabled, true, "Create must be disabled while trigger is field_equals and Value is still blank");

      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(createCalled, false, "submitting the form in this state must make no request at all, matching the disabled button");

      const valueInput = document.querySelector('input[placeholder="Value (e.g. Shipped)"]') as HTMLInputElement;
      fireEvent.change(valueInput, { target: { value: "Shipped" } });
      assert.equal(submitButton.disabled, false, "Create must become enabled once a real Value is entered");

      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await waitForCondition(() => createCalled);
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

/**
 * handleDelete only ever reset busyRuleId to null on the catch branch, not
 * on success -- unlike handleToggle's own finally block just above. Since
 * every row's Enable/Disable and Delete buttons are disabled project-wide
 * by `busyRuleId !== null` (not scoped to the one row actually being
 * acted on), a successful delete left busyRuleId permanently pointing at
 * the now-gone rule's id, disabling every OTHER remaining rule's buttons
 * for the rest of this panel's lifetime.
 */
test("AutomationsPanel's other rules stay interactive after a successful delete, instead of their buttons staying disabled forever", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ id: "rule1" }), makeRule({ id: "rule2" })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/automations/rule1") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 2);

      const firstRow = document.querySelectorAll(".automations-rule-row")[0] as HTMLElement;
      fireEvent.click(firstRow.querySelector(".danger") as HTMLButtonElement);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const remainingRow = document.querySelector(".automations-rule-row") as HTMLElement;
      const buttons = remainingRow.querySelectorAll("button");
      for (const button of buttons) {
        assert.equal((button as HTMLButtonElement).disabled, false, "the surviving rule's own buttons must not stay disabled after a successful delete elsewhere");
      }
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

/**
 * The server (apps/api/src/routes/projects.ts's validateAutomationToField)
 * rejects any toField that isn't "text" or "longtext" -- a round 666
 * regression test: the "send to a field" dropdown used to list every field
 * on the entity regardless of type, contradicting its own "Choose a phone
 * field" label and guaranteeing a predictable 400 for any non-text pick.
 */
const mixedFieldsProject: Project = {
  id: "proj2",
  ownerId: "owner1",
  name: "Shipments",
  description: "A shipment-tracking app",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "A shipment-tracking app",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Shipment",
        label: "Shipment",
        fields: [
          { name: "priority", label: "Priority", type: "number", required: true },
          { name: "contactPhone", label: "Contact Phone", type: "text", required: false },
          { name: "notes", label: "Notes", type: "longtext", required: false },
          { name: "isUrgent", label: "Is Urgent", type: "boolean", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

function renderPanelWith(project: Project, onClose: () => void = () => {}) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AutomationsPanel, { projectId: project.id, project, onClose }),
      ),
    ),
  );
}

test("AutomationsPanel's 'send to a field' dropdown only offers text/longtext fields as a phone destination, and defaults to one instead of the entity's literal first field", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj2/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(mixedFieldsProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const toFieldSelect = document.querySelector('select[aria-label="Choose a phone field"]') as HTMLSelectElement;
      assert.ok(toFieldSelect, "the toField select must be rendered since the entity has eligible text fields");
      const optionNames = Array.from(toFieldSelect.options).map((o) => o.value);
      assert.deepEqual(
        optionNames,
        ["contactPhone", "notes"],
        "only text/longtext fields may appear as a phone destination -- priority (number) and isUrgent (boolean) must be excluded",
      );
      assert.equal(toFieldSelect.value, "contactPhone", "the default must be the first ELIGIBLE field, not the entity's literal first field (priority)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel shows a message instead of an invalid dropdown when the entity has no text field at all", async () => {
  await withJsdom(async () => {
    const noTextProject: Project = {
      ...mixedFieldsProject,
      id: "proj3",
      spec: {
        ...mixedFieldsProject.spec,
        entities: [
          {
            name: "Metric",
            label: "Metric",
            fields: [
              { name: "count", label: "Count", type: "number", required: true },
              { name: "enabled", label: "Enabled", type: "boolean", required: false },
            ],
          },
        ],
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj3/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(noTextProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      assert.equal(
        document.querySelector('select[aria-label="Choose a phone field"]') === null,
        true,
        "no toField select must render when the entity has no eligible text field",
      );
      assert.match(
        document.body.textContent ?? "",
        /no text field that could hold a phone number/i,
        "a real message must explain why, instead of silently rendering an empty or invalid dropdown",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 668 regression test: the field_equals trigger's "Value" input was
 * a plain, type-blind <input type="text"> regardless of the selected
 * field's type -- rounds 595/607/613 only ever closed this gap
 * server-side (validateAutomationFieldValue rejects a non-matching value
 * at creation/update time), never by making the client control itself
 * type-aware the way FieldInput (EntityPanel.tsx) already is for a real
 * record's own boolean/enum fields.
 */
const triggerFieldProject: Project = {
  id: "proj5",
  ownerId: "owner1",
  name: "Tickets",
  description: "A support-ticket app",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "A support-ticket app",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Ticket",
        label: "Ticket",
        fields: [
          { name: "title", label: "Title", type: "text", required: true },
          { name: "resolved", label: "Resolved", type: "boolean", required: false },
          {
            name: "priority",
            label: "Priority",
            type: "enum",
            required: true,
            enumValues: ["Low", "High"],
            enumLabels: { Low: "נמוכה", High: "גבוהה" },
          },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

test("AutomationsPanel's field_equals Value control renders a checkbox for a boolean field, defaulting to \"true\", and submits that exact string", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj5/entities/Ticket/automations") {
        createBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: { id: "rule9", ...createBody } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(triggerFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "resolved"),
      ) as HTMLSelectElement;
      fireEvent.change(fieldSelect, { target: { value: "resolved" } });

      await waitForCondition(() => document.querySelector(".automations-field-value-checkbox input") !== null);
      const checkbox = document.querySelector(".automations-field-value-checkbox input") as HTMLInputElement;
      assert.equal(checkbox.checked, true, "must default to true, not an empty/unset value");
      assert.equal(
        document.querySelector('input[placeholder="Value (e.g. Shipped)"]') === null,
        true,
        "the plain free-text input must not render for a boolean field",
      );

      fireEvent.click(checkbox);
      assert.equal(checkbox.checked, false);

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Ticket resolution changed" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.fieldValue, "false", "unchecking the box must submit the literal string \"false\", not a JS boolean or \"no\"");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel's field_equals Value control renders a <select> of the field's own enumValues (showing enumLabels) for an enum field, and submits the raw enum value", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj5/entities/Ticket/automations") {
        createBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: { id: "rule9", ...createBody } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(triggerFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "priority"),
      ) as HTMLSelectElement;
      fireEvent.change(fieldSelect, { target: { value: "priority" } });

      const valueSelect = await (async () => {
        await waitForCondition(() =>
          Array.from(document.querySelectorAll("select")).some((s) => Array.from(s.options).some((o) => o.value === "Low")),
        );
        return Array.from(document.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "Low")) as HTMLSelectElement;
      })();
      const optionTexts = Array.from(valueSelect.options).map((o) => ({ value: o.value, text: o.textContent }));
      assert.deepEqual(
        optionTexts,
        [
          { value: "Low", text: "נמוכה" },
          { value: "High", text: "גבוהה" },
        ],
        "options must be exactly the field's enumValues, showing their enumLabels as text",
      );
      assert.equal(valueSelect.value, "Low", "must default to the first enum value, not an empty/unset value");

      fireEvent.change(valueSelect, { target: { value: "High" } });

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Priority changed" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.fieldValue, "High", "must submit the raw enum value, not its enumLabels display text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 714: the field_equals trigger's "Value" control had a type-aware
 * branch for boolean/enum fields (round 668) but fell through to a plain
 * free-text input for a relation field -- the server's own
 * validateAutomationFieldValue (apps/api/src/routes/projects.ts) only ever
 * accepts the related record's raw, internal id there, a value no other UI
 * surface in this app ever shows a user (every other relation render uses
 * relationDisplayLabel instead). Confirms the Value control now renders a
 * real <select> of the target entity's own records (fetched via
 * listRecords, the same call EntityPanel.tsx's own relation picker uses),
 * defaults to the first one, and submits its raw id -- plus that an
 * existing rule's own stored id resolves back to the related record's
 * display label in both the rule list and the Copy/Download report,
 * instead of printing the bare id.
 */
const relationFieldProject: Project = {
  id: "proj6",
  ownerId: "owner1",
  name: "Deliveries",
  description: "A delivery-tracking app",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "A delivery-tracking app",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Order",
        label: "Order",
        fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "courierId", label: "Courier", type: "relation", required: false, relationTo: "Courier" },
        ],
      },
      {
        name: "Courier",
        label: "Courier",
        fields: [{ name: "name", label: "Name", type: "text", required: true }],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

test("AutomationsPanel's field_equals Value control renders a real picker of the target entity's own records for a relation field, defaulting to the first one, and submits its raw id", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj6/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj6/entities/Courier") {
        return new Response(
          JSON.stringify({ records: [{ id: 1, name: "Yossi Cohen" }, { id: 2, name: "Dana Levi" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "POST" && input === "/api/projects/proj6/entities/Order/automations") {
        createBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: { id: "rule10", ...createBody } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(relationFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "courierId"),
      ) as HTMLSelectElement;
      fireEvent.change(fieldSelect, { target: { value: "courierId" } });

      const valueSelect = await (async () => {
        await waitForCondition(() =>
          Array.from(document.querySelectorAll("select")).some((s) => Array.from(s.options).some((o) => o.value === "1")),
        );
        return Array.from(document.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "1")) as HTMLSelectElement;
      })();
      const optionTexts = Array.from(valueSelect.options).map((o) => ({ value: o.value, text: o.textContent }));
      assert.deepEqual(
        optionTexts,
        [
          { value: "1", text: "Yossi Cohen" },
          { value: "2", text: "Dana Levi" },
        ],
        "options must be the related entity's own records, shown by their real display label, not a raw id",
      );
      assert.equal(valueSelect.value, "1", "must default to the first related record's id, not an empty/unset value");

      fireEvent.change(valueSelect, { target: { value: "2" } });

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Courier changed" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.fieldValue, "2", "must submit the chosen record's raw id, not its display label");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel resolves an existing rule's stored relation id back to the related record's display label in the rule list and the Copy/Download report, instead of printing the bare id", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const rule = makeRule({
      id: "rule11",
      entityName: "Order",
      trigger: "field_equals",
      fieldName: "courierId",
      fieldValue: "2",
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj6/automations") {
        return new Response(JSON.stringify({ rules: [rule] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj6/entities/Courier") {
        return new Response(
          JSON.stringify({ records: [{ id: 1, name: "Yossi Cohen" }, { id: 2, name: "Dana Levi" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderPanelWith(relationFieldProject);
      await waitForCondition(() => document.querySelector(".automations-rule-condition") !== null);
      await waitForCondition(() => (document.querySelector(".automations-rule-condition")?.textContent ?? "").includes("Dana Levi"));
      assert.doesNotMatch(
        document.querySelector(".automations-rule-condition")?.textContent ?? "",
        /"2"/,
        "the raw stored id must never be shown once the related record's label is resolvable",
      );

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Copy report")) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Dana Levi/, "the Copy report text must also resolve the relation id to its display label");
    } finally {
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * New: the "schedule" trigger -- a recurring, time-of-day rule with no
 * triggering record at all, unlike record_created/field_equals. Choosing
 * it must reveal a time input and a day-of-week picker, force toMode to
 * "static" (there's no record to read a toMode:"field" destination
 * from), and submit scheduleTimeUtc/scheduleDaysOfWeek alongside the rest
 * of the rule exactly as typed/toggled.
 */
test("AutomationsPanel's 'schedule' trigger shows a time + day-of-week picker, forces toMode to static, and submits the exact schedule chosen", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj5/entities/Ticket/automations") {
        createBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: { id: "rule10", ...createBody } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(triggerFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "schedule"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "schedule" } });

      const timeInput = document.querySelector('.automations-create-form input[type="time"]') as HTMLInputElement;
      assert.ok(timeInput, "choosing the schedule trigger must reveal a time input");
      fireEvent.change(timeInput, { target: { value: "17:45" } });

      const dayCheckboxes = Array.from(document.querySelectorAll(".automations-schedule-day input")) as HTMLInputElement[];
      assert.equal(dayCheckboxes.length, 7, "exactly seven day-of-week checkboxes");
      assert.ok(dayCheckboxes.every((cb) => cb.checked), "every day must be checked by default");
      fireEvent.click(dayCheckboxes[0]!); // uncheck Sunday (day 0)

      // toMode is forced to "static" the moment "schedule" is chosen, so
      // the toMode selector itself (the <select> offering "field"/"static")
      // must no longer render at all -- only the static phone-number input.
      const toModeSelectStillShown = Array.from(document.querySelectorAll("select")).some(
        (s) => Array.from(s.options).map((o) => o.value).sort().join(",") === "field,static",
      );
      assert.equal(toModeSelectStillShown, false, "the toMode selector must be hidden once trigger is 'schedule'");
      const toNumberInput = document.querySelector('input[placeholder="Phone number with country code (e.g. 972501234567)"]') as HTMLInputElement;
      assert.ok(toNumberInput, "the static phone-number input must render since toMode is forced to static");
      fireEvent.change(toNumberInput, { target: { value: "972501234567" } });

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Weekly reminder" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.trigger, "schedule");
      assert.equal(createBody?.scheduleTimeUtc, "17:45");
      assert.equal(createBody?.scheduleDaysOfWeek, "1,2,3,4,5,6", "Sunday (0) was unchecked, so it must be excluded from the submitted day list");
      assert.equal(createBody?.toMode, "static");
      assert.equal(createBody?.toNumber, "972501234567");
      assert.equal(createBody?.fieldName, undefined, "a schedule rule has no triggering field at all");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New: the "webhook" action type -- choosing it must swap out the
 * WhatsApp-specific toMode/destination controls for a plain URL input,
 * and the submitted request must carry actionType/webhookUrl with no
 * toNumber/toField at all.
 */
test("AutomationsPanel's 'webhook' action shows a URL input instead of the WhatsApp destination controls, and submits actionType/webhookUrl with no toNumber/toField", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj5/entities/Ticket/automations") {
        createBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ rule: makeRule({ id: "rule11", ...createBody }) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(triggerFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const actionSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "webhook"),
      ) as HTMLSelectElement;
      fireEvent.change(actionSelect, { target: { value: "webhook" } });

      assert.equal(
        document.querySelector('input[placeholder="Phone number with country code (e.g. 972501234567)"]'),
        null,
        "the WhatsApp static-number input must not render for a webhook action",
      );
      const urlInput = document.querySelector('input[type="url"]') as HTMLInputElement;
      assert.ok(urlInput, "expected a real URL input for the webhook action");
      fireEvent.change(urlInput, { target: { value: "https://hooks.example.com/forge" } });

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "New ticket!" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.actionType, "webhook");
      assert.equal(createBody?.webhookUrl, "https://hooks.example.com/forge");
      assert.equal(createBody?.toNumber, undefined, "a webhook action has no WhatsApp destination at all");
      assert.equal(createBody?.toField, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel's rule list describes a webhook rule by its URL, not a WhatsApp destination", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj2/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ id: "rule1", actionType: "webhook", webhookUrl: "https://hooks.example.com/forge", toMode: "static", toField: null })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderPanelWith(mixedFieldsProject);
      await waitForCondition(() => document.querySelector(".automations-rule-row") !== null);

      assert.match(document.body.textContent ?? "", /calls webhook: https:\/\/hooks\.example\.com\/forge/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 677: previously the only fix path for a wrong field/time/number/
 * template on an existing rule was delete-and-recreate (losing its
 * lastTriggeredAt/lastStatus history), even though the server's PATCH
 * route (UpdateAutomationRuleSchema + findAutomationRuleInvariantViolation,
 * apps/api/src/routes/projects.ts) already accepted a full edit of every
 * rule field. These three tests cover the new Edit button: it must seed
 * the create-form from the chosen rule and switch it into edit mode
 * (entity locked, heading/submit label changed, a Cancel button appears);
 * submitting must PATCH (not POST) and update the rule in place; and
 * Cancel must discard the in-progress edit without calling the API at all.
 */
test("AutomationsPanel's Edit button seeds the create-form from the chosen rule and switches it into edit mode", async () => {
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

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/);

      const editButton = Array.from(document.querySelectorAll(".automations-rule-actions button")).find(
        (b) => b.textContent === "Edit",
      ) as HTMLButtonElement;
      assert.ok(editButton, "expected an Edit button on the rule row");
      fireEvent.click(editButton);

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /Edit rule/);

      const entitySelect = document.querySelector(".automations-create-form select") as HTMLSelectElement;
      assert.equal(entitySelect.value, "Order");
      assert.equal(entitySelect.disabled, true, "the entity select must be locked while editing -- a PATCH can never change it");

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      assert.equal(messageField.value, "Hi {{customerName}}, delivered!", "the message template must be seeded from the rule");

      const submitButton = document.querySelector('.automations-create-form button[type="submit"]') as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Save changes");

      assert.ok(
        Array.from(document.querySelectorAll(".automations-create-form button")).some((b) => b.textContent === "Cancel"),
        "a Cancel button must appear while editing",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("submitting an edited rule calls the real PATCH endpoint and updates the rule in place, then returns the form to create mode", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/automations/rule1") {
        patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ rule: makeRule({ messageTemplate: patchBody.messageTemplate }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      fireEvent.click(
        Array.from(document.querySelectorAll(".automations-rule-actions button")).find((b) => b.textContent === "Edit") as HTMLButtonElement,
      );

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Hi {{customerName}}, your order shipped!" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      // patchBody is assigned synchronously the moment the mocked fetch
      // starts running, well before the component's own await chain
      // parses the response and commits the updated rule to state --
      // waiting on the DOM itself (not just patchBody) avoids a race
      // against that still-pending re-render.
      await waitForCondition(() =>
        /Hi \{\{customerName\}\}, your order shipped!/.test(document.querySelector(".automations-rule-row")?.textContent ?? ""),
      );
      assert.deepEqual(patchBody, {
        trigger: "field_equals",
        fieldName: "status",
        fieldValue: "Delivered",
        scheduleTimeUtc: null,
        scheduleDaysOfWeek: null,
        actionType: "send_whatsapp",
        toMode: "field",
        toField: "customerPhone",
        toNumber: null,
        webhookUrl: null,
        messageTemplate: "Hi {{customerName}}, your order shipped!",
      });

      // Still exactly one row -- a successful edit must update the
      // existing rule in place, never append a second one.
      assert.equal(document.querySelectorAll(".automations-rule-row").length, 1);

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/, "must return to create mode after a successful save");
      assert.equal(
        Array.from(document.querySelectorAll(".automations-create-form button")).some((b) => b.textContent === "Cancel"),
        false,
        "the Cancel button must disappear once no longer editing",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("clicking Cancel while editing discards the in-progress edit and never calls the API", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input} -- Cancel must never call the API`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      fireEvent.click(
        Array.from(document.querySelectorAll(".automations-rule-actions button")).find((b) => b.textContent === "Edit") as HTMLButtonElement,
      );
      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "this edit should be discarded" } });

      fireEvent.click(
        Array.from(document.querySelectorAll(".automations-create-form button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement,
      );

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/);
      const entitySelect = document.querySelector(".automations-create-form select") as HTMLSelectElement;
      assert.equal(entitySelect.disabled, false, "the entity select must unlock again once editing is cancelled");
      assert.equal(messageField.value, "", "the form must reset, not keep the discarded draft");
      assert.match(document.querySelector(".automations-rule-row")!.textContent ?? "", /Hi \{\{customerName\}\}, delivered!/, "the original rule must be untouched");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 679: Automations was the one read-heavy diagnostic panel in this
 * app with no Copy/Download companions at all (Business Twin, WhatsApp
 * log, Time Machine, Global Search all already have both) -- a user
 * debugging why an automation isn't firing had no way to hand over the
 * rule list and its last-run outcomes without a screenshot. Confirms
 * neither button renders before rules have loaded, both appear once real
 * rules exist, and clicking Copy writes the real formatted report (not a
 * placeholder) to the clipboard.
 */
test("AutomationsPanel shows Copy/Download buttons only once real rules exist, and Copy writes the real formatted report to the clipboard", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderPanel();

      assert.equal(
        Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("Copy report")),
        false,
        "no Copy button should render while loading, before any rules have arrived",
      );

      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Copy report"));
      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download report"));
      assert.ok(copyButton, "expected a Copy report button once real rules exist");
      assert.ok(downloadButton, "expected a Download report button once real rules exist");
      assert.equal(copyButton!.getAttribute("aria-live"), "polite");
      assert.equal(copyButton!.getAttribute("aria-atomic"), "true");

      t.mock.timers.enable({ apis: ["setTimeout"] });

      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Orders/, "the copied text must include the real project name");
      assert.match(writtenText!, /Hi \{\{customerName\}\}, delivered!/, "the copied text must include the real rule's message template");
      assert.equal(copyButton!.textContent, "✅ Copied!");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy report", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

test("AutomationsPanel's Download button downloads the real report as a named file", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    // jsdom doesn't implement the real Blob-URL machinery -- stub just
    // enough of it to observe what the click handler actually does, the
    // same technique GlobalSearchPanel.test.ts's own download test uses.
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    const anchorProto = (globalThis as unknown as { window: { HTMLAnchorElement: { prototype: HTMLAnchorElement } } }).window
      .HTMLAnchorElement.prototype;
    const originalAnchorClick = anchorProto.click;
    let capturedDownloadName: string | null = null;
    let clickCount = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:mock-url";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    anchorProto.click = function (this: HTMLAnchorElement) {
      capturedDownloadName = this.download;
      clickCount += 1;
    };

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download report"));
      assert.ok(downloadButton, "expected a Download report button once real rules exist");

      fireEvent.click(downloadButton!);

      assert.equal(clickCount, 1, "clicking the download button must trigger exactly one real anchor click");
      const downloadName: string = capturedDownloadName ?? "";
      assert.ok(downloadName.includes("Orders"), `expected the downloaded filename to be derived from the real project name "Orders", got "${downloadName}"`);
      assert.ok(downloadName.endsWith("automations.txt"), `expected an automations.txt filename, got "${downloadName}"`);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      anchorProto.click = originalAnchorClick;
    }
  });
});

/**
 * Round 682: a rule's own lastTriggeredAt/lastStatus/lastError (already
 * shown in the rule row) only ever reflects the single most recent
 * firing -- a rule that failed repeatedly and then happened to succeed on
 * its latest attempt looked perfectly healthy. The new "History" button
 * fetches and shows the real run-by-run log instead. Confirms it doesn't
 * fetch until actually clicked, shows a loading state, renders every
 * returned run (not just one), and collapses back on a second click
 * without re-fetching.
 */
test("AutomationsPanel's History button fetches and shows every real run for that rule, only when clicked, and toggles closed on a second click", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let runsRequests = 0;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/automations/rule1/runs") {
        runsRequests += 1;
        return new Response(
          JSON.stringify({
            runs: [
              { id: "run2", ruleId: "rule1", status: "sent", error: null, triggeredAt: new Date("2026-03-15T10:00:00Z").toISOString() },
              { id: "run1", ruleId: "rule1", status: "failed", error: "WhatsApp not connected", triggeredAt: new Date("2026-03-15T09:00:00Z").toISOString() },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      assert.equal(document.querySelector(".automations-rule-history"), null, "no history list before History is clicked");
      assert.equal(runsRequests, 0, "must never fetch run history before the user actually asks for it");

      const historyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;
      assert.ok(historyButton, "expected a History button on the rule row");
      fireEvent.click(historyButton);

      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 2);
      assert.equal(runsRequests, 1);
      const entries = Array.from(document.querySelectorAll(".automations-rule-history-list li")).map((li) => li.textContent);
      assert.match(entries[0] ?? "", /sent/i, "the newer, successful run must be listed first");
      assert.match(entries[1] ?? "", /WhatsApp not connected/, "the older, failed run's real error must be shown");

      fireEvent.click(historyButton);
      assert.equal(document.querySelector(".automations-rule-history"), null, "a second click must collapse the history list");

      fireEvent.click(historyButton);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 2);
      assert.equal(runsRequests, 1, "re-expanding the same rule must reuse the cached runs, not re-fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("AutomationsPanel's History button shows a real empty state for a rule that has never fired", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/automations/rule1/runs") {
        return new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement);
      await waitForCondition(() =>
        /hasn't fired yet/i.test(document.querySelector(".automations-rule-history")?.textContent ?? ""),
      );

      assert.equal(document.querySelectorAll(".automations-rule-history-list li").length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
