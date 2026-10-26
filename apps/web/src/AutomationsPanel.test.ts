import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Project } from "@forge/shared";
import { AutomationsPanel } from "./AutomationsPanel.js";
import { setColumnOrder } from "./columnOrder.js";
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
 * Round 1000: a "send_email" rule's own subject line (round 996,
 * emailSubject) is interpolated and sent completely independently of
 * messageTemplate (the email body) -- never shown anywhere in the rule
 * list at all before this, the one place meant to let a user see exactly
 * what a rule is actually configured to send.
 */
test("AutomationsPanel shows a send_email rule's own subject line in the rule list, not just its message body", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({
            rules: [
              makeRule({
                actionType: "send_email",
                toMode: "static",
                toNumber: null,
                toField: null,
                toEmail: "owner@example.com",
                emailSubject: "New order from {{customerName}}",
              }),
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
      const row = document.querySelector(".automations-rule-row")!;
      assert.match(row.textContent ?? "", /owner@example\.com/, "the real toEmail destination must be shown, not an empty one");
      assert.match(row.textContent ?? "", /Subject: New order from \{\{customerName\}\}/, "the subject line must be shown, not silently dropped");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 969: the new "record_deleted" trigger -- confirms the rule list
 * describes it with its own distinct wording (not falling through to the
 * field_equals description the way an unhandled trigger value silently
 * would), and that the create-form's trigger picker actually offers it as
 * a real, selectable option, submitting the exact trigger chosen.
 */
test("AutomationsPanel describes a record_deleted rule with its own distinct wording, and the create-form offers it as a real trigger option", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ trigger: "record_deleted", fieldName: null, fieldValue: null })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Order/automations") {
        createBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ rule: { id: "rule2", ...createBody } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);
      const row = document.querySelector(".automations-rule-row")!;
      assert.match(row.textContent ?? "", /deleted/i, "a record_deleted rule must describe itself as firing on deletion, not the field_equals fallback wording");
      assert.equal(row.textContent?.includes("Delivered"), false, "must not fall through to field_equals' own description text");

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "record_deleted"),
      ) as HTMLSelectElement;
      assert.ok(triggerSelect, "the trigger picker must offer record_deleted as a real option");
      fireEvent.change(triggerSelect, { target: { value: "record_deleted" } });

      // record_deleted doesn't force toMode to "static" the way "schedule"
      // does (a deleted record's own fields are still available to resolve
      // a toMode:"field" destination from) -- switch explicitly, same as
      // any other non-schedule trigger would need to.
      const toModeSelect = Array.from(document.querySelectorAll("select")).find(
        (s) => Array.from(s.options).map((o) => o.value).sort().join(",") === "field,static",
      ) as HTMLSelectElement;
      fireEvent.change(toModeSelect, { target: { value: "static" } });

      const toNumberInput = document.querySelector('input[placeholder="Phone number with country code (e.g. 972501234567)"]') as HTMLInputElement;
      fireEvent.change(toNumberInput, { target: { value: "972501234567" } });
      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Record removed." } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.trigger, "record_deleted");
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

/**
 * Round 959: hasTooManyConsecutiveFailuresToday's own cap (apps/api/src/
 * automations.ts, rounds 924/934/951) was always computed and acted on
 * server-side, but never surfaced -- the "Enabled" chip stayed green the
 * whole time the scheduler had actually stopped retrying a rule for the
 * rest of today, with nothing distinguishing that from a rule still
 * actively retrying every minute. Confirms a schedule rule the server
 * reports as pausedForToday gets a second, distinct chip naming that, and
 * that an otherwise-identical rule without it gets no such chip.
 */
test("AutomationsPanel shows a distinct 'paused for today' chip for a schedule rule the server reports as pausedForToday, but not for one that isn't", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({
            rules: [
              makeRule({
                id: "paused-rule",
                trigger: "schedule",
                scheduleTimeUtc: "09:00",
                scheduleDaysOfWeek: null,
                pausedForToday: true,
              }),
              makeRule({ id: "active-rule", trigger: "schedule", scheduleTimeUtc: "10:00", scheduleDaysOfWeek: null, pausedForToday: false }),
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 2);
      const [pausedRow, activeRow] = Array.from(document.querySelectorAll(".automations-rule-row"));
      assert.ok(pausedRow.querySelector(".automations-chip-paused"), "the paused rule must show the paused-for-today chip");
      assert.match(pausedRow.textContent ?? "", /Paused for today/);
      assert.ok(!activeRow.querySelector(".automations-chip-paused"), "an active, non-paused rule must not show the paused-for-today chip");
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

function renderPanelWith(project: Project, onClose: () => void = () => {}, entities?: Project["spec"]["entities"]) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(AutomationsPanel, { projectId: project.id, project, entities, onClose }),
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
 * Round 770 regression test: both the field_equals trigger's "Field"
 * dropdown and the "send to a field" toField dropdown rendered the
 * entity's raw declared field order, ignoring the user's own
 * drag-reordered column order (columnOrder.ts) that every other
 * field-order-sensitive picker in this app (EntityPanel.tsx's bulk-edit
 * and filter pickers, CSV export, both Print sheets) already respects.
 */
test("AutomationsPanel's Field and toField dropdowns follow the user's own drag-reordered column order, not the entity's raw declared field order", async () => {
  await withJsdom(async () => {
    setColumnOrder("proj2", "Shipment", ["isUrgent", "notes", "contactPhone", "priority"]);
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

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("label"))
        .find((l) => l.textContent?.startsWith("Field"))
        ?.querySelector("select") as HTMLSelectElement;
      assert.ok(fieldSelect, "the field_equals Field dropdown must be rendered");
      assert.deepEqual(
        Array.from(fieldSelect.options).map((o) => o.value),
        ["isUrgent", "notes", "contactPhone", "priority"],
        "the Field dropdown must follow the drag-reordered column order, not the entity's raw declared order",
      );

      const toFieldSelect = document.querySelector('select[aria-label="Choose a phone field"]') as HTMLSelectElement;
      assert.ok(toFieldSelect, "the toField select must be rendered since the entity has eligible text/longtext fields");
      assert.deepEqual(
        Array.from(toFieldSelect.options).map((o) => o.value),
        ["notes", "contactPhone"],
        "the toField dropdown must follow the drag-reordered column order too -- notes (longtext) now precedes contactPhone (text)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 770 regression test: the field_equals trigger's "Field" dropdown,
 * the "send to a field" toField dropdown, and the rule list's own field
 * label all rendered a field's bare `label ?? name`, with no
 * disambiguation for two fields on the same entity sharing a label --
 * unlike every other field-selection surface in this app (EntityPanel.tsx's
 * bulk-edit/filter pickers, both Print sheets, CSV export), which all call
 * fieldDisplayLabel to append the field's own unique name whenever its
 * label collides with another field's.
 */
const duplicateLabelProject: Project = {
  id: "proj5",
  ownerId: "owner1",
  name: "Invoicing",
  description: "An invoicing app",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "An invoicing app",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Order",
        label: "Order",
        fields: [
          { name: "subtotal", label: "Amount", type: "number", required: true },
          { name: "shipping", label: "Amount", type: "number", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

test("AutomationsPanel's field_equals Field dropdown disambiguates two fields that share the same label, instead of showing two indistinguishable options", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(duplicateLabelProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("label"))
        .find((l) => l.textContent?.startsWith("Field"))
        ?.querySelector("select") as HTMLSelectElement;
      assert.ok(fieldSelect, "the field_equals Field dropdown must be rendered");
      const optionTexts = Array.from(fieldSelect.options).map((o) => o.textContent);
      assert.deepEqual(
        optionTexts,
        ["Amount (subtotal)", "Amount (shipping)"],
        "two fields sharing the label \"Amount\" must be disambiguated by their own unique name, exactly like every other field picker in this app",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 864 regression test: the entity-level twin of round 770's own
 * field-label fix just above. The "Create automation rule" Entity
 * dropdown and the rule list's own describeRule text both rendered an
 * entity's bare `label ?? name`, with no disambiguation for two entities
 * sharing a label -- unlike checkpointDiff.ts's own HistoryPanel
 * rendering (and this exact file's own already-fixed field-label case),
 * which both call entityDisplayLabel/fieldDisplayLabel to append the
 * entity/field's own unique name whenever its label collides with a
 * sibling's.
 */
const duplicateEntityLabelProject: Project = {
  id: "proj6",
  ownerId: "owner1",
  name: "CRM",
  description: "A CRM",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "A CRM",
    personas: [],
    roles: ["Admin"],
    entities: [
      { name: "CustomerActive", label: "Customer", fields: [{ name: "name", label: "Name", type: "text", required: true }] },
      { name: "CustomerArchived", label: "Customer", fields: [{ name: "name", label: "Name", type: "text", required: true }] },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

test("AutomationsPanel's Entity dropdown disambiguates two entities that share the same label, and the rule list's own description uses the disambiguated label too", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj6/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ entityName: "CustomerArchived", trigger: "record_created", fieldName: null, fieldValue: null })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(duplicateEntityLabelProject);
      await waitForCondition(() => document.body.textContent?.includes("record is created") ?? false);

      const entitySelect = Array.from(document.querySelectorAll("label"))
        .find((l) => l.textContent?.startsWith("Entity"))
        ?.querySelector("select") as HTMLSelectElement;
      assert.ok(entitySelect, "the create-form Entity dropdown must be rendered");
      const optionTexts = Array.from(entitySelect.options).map((o) => o.textContent);
      assert.deepEqual(
        optionTexts,
        ["Customer (CustomerActive)", "Customer (CustomerArchived)"],
        "two entities sharing the label \"Customer\" must be disambiguated by their own unique name, exactly like every other entity picker in this app",
      );

      assert.ok(
        document.body.textContent?.includes("Customer (CustomerArchived)"),
        "the rule list's own description must name which of the two same-labeled entities this existing rule actually targets",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 748 regression test: the field_equals trigger's own "Field"
 * dropdown listed every field on the entity with no filter at all,
 * including a "file" field -- whose stored value (the raw upload JSON
 * descriptor) the server's own validateAutomationFieldValue now rejects
 * outright (apps/api/src/routes/projects.ts), the same kind of gap round
 * 666 closed for the "send to a field" dropdown just above.
 */
const fileFieldProject: Project = {
  id: "proj4",
  ownerId: "owner1",
  name: "Hiring",
  description: "A hiring app",
  status: "built",
  createdAt: new Date().toISOString(),
  spec: {
    summary: "A hiring app",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Applicant",
        label: "Applicant",
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "resume", label: "Resume", type: "file", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

test("AutomationsPanel's field_equals trigger 'Field' dropdown never offers a file field, since its stored value can never be typed in by hand", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj4/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(fileFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("label"))
        .find((l) => l.textContent?.startsWith("Field"))
        ?.querySelector("select") as HTMLSelectElement;
      assert.ok(fieldSelect, "the field_equals 'Field' dropdown must be rendered");
      const optionNames = Array.from(fieldSelect.options).map((o) => o.value);
      assert.deepEqual(optionNames, ["name"], "a file field must never appear as a trigger-condition field");
      assert.equal(fieldSelect.value, "name", "must default to the first non-file field, not the literal first field if it were excluded and empty");
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
      // Round 987: without this, the form's own submit handler can race
      // ahead of this change's React state commit under full-suite CPU
      // contention -- unlike the earlier valueSelect lookup above (which
      // explicitly awaits its own condition), nothing here confirmed the
      // <select>'s backing state had actually taken "2" before the two
      // fireEvent calls right below fired, so createBody?.fieldValue
      // intermittently (~25% of isolated runs, confirmed empirically)
      // still read "1" -- the picker's own stale default -- instead of
      // the value just chosen. Round 988: the default 40-tick budget
      // itself turned out to still be too tight under REAL full-suite
      // contention (confirmed: this exact wait timed out in a full
      // apps/web run even after the round-987 fix) -- bumped to 200 here
      // and on the identical wait just below.
      await waitForCondition(() => valueSelect.value === "2", 200);

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Courier changed" } });
      // Same reasoning as valueSelect's own wait just above -- confirms
      // this change's React state commit too before the immediately
      // following submit reads it.
      await waitForCondition(() => messageField.value === "Courier changed", 200);
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined, 200);
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
 * Round 764 regression test: AutomationsPanel used to derive its entity
 * list straight from project.spec.entities, ignoring any `entities` prop
 * -- so the "Create automation rule" form's entity dropdown (and its
 * default-selected entity) always listed entities in the spec's original
 * declared/build order, regardless of how a user had actually reordered
 * their own entity tabs. App.tsx now passes its own orderedEntities
 * (entityTabOrder.ts's persisted order) the same way it already does for
 * GlobalSearchPanel (round 713) -- this test exercises AutomationsPanel
 * directly with a reordered `entities` prop, confirming both the
 * dropdown's option order and the default pre-selected entity follow it,
 * not project.spec.entities' own declared order ([Order, Courier]).
 */
test("AutomationsPanel's entity dropdown and default-selected entity follow a reordered entities prop, not project.spec.entities' own declared order", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj6/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      const [orderField, courierField] = relationFieldProject.spec.entities;
      renderPanelWith(relationFieldProject, () => {}, [courierField!, orderField!]);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const entitySelect = document.querySelector(".automations-create-form select") as HTMLSelectElement;
      const optionNames = Array.from(entitySelect.options).map((o) => o.value);
      assert.deepEqual(optionNames, ["Courier", "Order"], "the dropdown's option order must follow the reordered entities prop, not the spec's own [Order, Courier] declared order");
      assert.equal(entitySelect.value, "Courier", "the default-selected entity must be the reordered array's first entity, not project.spec.entities[0]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const dateFieldProject: Project = {
  id: "proj7",
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
          { name: "label", label: "Label", type: "text", required: true },
          { name: "dueDate", label: "Due Date", type: "date", required: false },
          { name: "amount", label: "Amount", type: "number", required: false },
          { name: "isUrgent", label: "Is Urgent", type: "boolean", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  },
};

/**
 * Round 759 regression test: fieldValueLabel (in both AutomationsPanel.tsx
 * and automationsReport.ts) only had branches for enum/relation field
 * types -- a date or number field_equals rule's raw stored value
 * ("2024-01-15", "1500") fell through to the bare, unformatted string in
 * both the rule list and the Copy/Download report, even though the
 * function's own doc comment claims to mirror apps/api/src/automations.
 * ts's interpolateTemplate, which already locale-formats both types for
 * the real outgoing WhatsApp message.
 */
test("AutomationsPanel locale-formats a date/number field_equals rule's value in the rule list and the Copy report, instead of printing the raw stored string", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const dateRule = makeRule({
      id: "rule12",
      entityName: "Order",
      trigger: "field_equals",
      fieldName: "dueDate",
      fieldValue: "2024-01-15",
    });
    const numberRule = makeRule({
      id: "rule13",
      entityName: "Order",
      trigger: "field_equals",
      fieldName: "amount",
      fieldValue: "1500",
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj7/automations") {
        return new Response(JSON.stringify({ rules: [dateRule, numberRule] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderPanelWith(dateFieldProject);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-condition").length === 2);
      const conditionTexts = Array.from(document.querySelectorAll(".automations-rule-condition")).map((el) => el.textContent ?? "");

      assert.ok(
        conditionTexts.some((text) => text.includes("1/15/2024")),
        `expected a locale-formatted date ("1/15/2024"), got: ${JSON.stringify(conditionTexts)}`,
      );
      assert.ok(
        !conditionTexts.some((text) => text.includes("2024-01-15")),
        "the raw ISO date string must never be shown once the field's type is known to be \"date\"",
      );
      assert.ok(
        conditionTexts.some((text) => text.includes("1,500")),
        `expected a locale-formatted number ("1,500"), got: ${JSON.stringify(conditionTexts)}`,
      );

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Copy report")) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /1\/15\/2024/, "the Copy report text must also locale-format the date field's value");
      assert.match(writtenText!, /1,500/, "the Copy report text must also locale-format the number field's value");
    } finally {
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * Round 760 regression test: fieldValueLabel (in both AutomationsPanel.tsx
 * and automationsReport.ts) had no boolean branch either -- a boolean
 * field_equals rule's raw stored value ("true"/"false", lowercase, the
 * exact literal string the create-form's own checkbox submits) fell
 * through to the bare, unformatted string in both the rule list and the
 * Copy/Download report, inconsistent with the uppercase "TRUE"/"FALSE"
 * convention every other field-value display in this app already uses
 * (interpolateTemplate, entityFormatting.ts's fieldDisplayValue,
 * backup.ts's CSV export, calendarIcs.ts).
 */
test("AutomationsPanel shows uppercase TRUE/FALSE for a boolean field_equals rule's value in the rule list and the Copy report, instead of the raw lowercase stored string", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const boolRule = makeRule({
      id: "rule14",
      entityName: "Order",
      trigger: "field_equals",
      fieldName: "isUrgent",
      fieldValue: "true",
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj7/automations") {
        return new Response(JSON.stringify({ rules: [boolRule] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderPanelWith(dateFieldProject);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-condition").length === 1);
      const conditionText = document.querySelector(".automations-rule-condition")?.textContent ?? "";

      assert.ok(conditionText.includes("TRUE"), `expected uppercase "TRUE", got: ${JSON.stringify(conditionText)}`);
      assert.ok(!conditionText.includes('"true"'), "the raw lowercase stored string must never be shown once the field's type is known to be \"boolean\"");

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Copy report")) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /becomes "TRUE"/, "the Copy report text must also show uppercase TRUE, not the raw lowercase stored string");
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
  // Round 967: pins the viewer's own detected timezone for the duration
  // of this test (same technique as entityFormatting.test.ts's own
  // formatDateValue tests) so the assertion on createBody.scheduleTimezone
  // below -- and the hint text's own displayed zone name -- aren't
  // dependent on whatever zone this happens to run in.
  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
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
      // Round 967: a brand-new schedule rule must default to the viewer's
      // OWN detected zone, not silently mean UTC.
      assert.equal(createBody?.scheduleTimezone, "America/New_York");
      assert.ok(
        document.querySelector(".automations-create-form")?.textContent?.includes("America/New_York"),
        "the schedule form must disclose which real timezone it's scheduling in",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  } finally {
    process.env.TZ = originalTz;
  }
});

/**
 * Round 868's finding: the message-template textarea's own placeholder
 * example and hint text advertised {{fieldName}} interpolation
 * unconditionally, for every trigger -- but automations.ts's own
 * fireScheduledRule sends a schedule rule's messageTemplate completely raw
 * (its own doc comment: "a schedule rule has no triggering record at all
 * ... no {{field}} placeholder could ever resolve to anything"), for both
 * the WhatsApp and webhook action types this field is shared across. A
 * user who followed the UI's own advice and wrote "{{customerName}}" into
 * a schedule rule's message got that literal, unsubstituted text sent to a
 * real WhatsApp recipient or webhook consumer, with nothing in the product
 * warning this would happen. Confirms the hint/placeholder swap to a
 * schedule-specific pair the moment "schedule" is chosen, and swaps back
 * once a non-schedule trigger is chosen again -- proving this is a live,
 * reversible UI state, not a one-way mistake.
 */
test("AutomationsPanel swaps the message-template hint/placeholder for a schedule-specific pair that never mentions {{fieldName}}, since a schedule rule is never interpolated", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(triggerFieldProject);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      assert.match(messageField.placeholder, /\{\{customerName\}\}/, "the default (non-schedule) placeholder must still advertise {{fieldName}} interpolation");
      assert.match(
        document.body.textContent ?? "",
        /Use \{\{fieldName\}\}/,
        "the default (non-schedule) hint must still advertise {{fieldName}} interpolation",
      );

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "schedule"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "schedule" } });

      await waitForCondition(() => !messageField.placeholder.includes("{{"));
      assert.doesNotMatch(messageField.placeholder, /\{\{/, "a schedule rule's own placeholder example must never show {{fieldName}} syntax that will never be interpolated");
      assert.doesNotMatch(
        document.body.textContent ?? "",
        /Use \{\{fieldName\}\}/,
        "a schedule rule's own hint must not advertise interpolation that fireScheduledRule never performs",
      );
      assert.match(
        document.body.textContent ?? "",
        /sent exactly as written/,
        "a schedule rule's own hint must explain the message is sent verbatim instead",
      );

      // Switching back to a non-schedule trigger must restore the original pair.
      fireEvent.change(triggerSelect, { target: { value: "record_created" } });
      await waitForCondition(() => messageField.placeholder.includes("{{"));
      assert.match(messageField.placeholder, /\{\{customerName\}\}/, "switching away from 'schedule' must restore the field-interpolation placeholder");
      assert.match(document.body.textContent ?? "", /Use \{\{fieldName\}\}/, "switching away from 'schedule' must restore the field-interpolation hint");
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

/**
 * Round 974: webhookSecret is a plain optional input next to the URL --
 * confirms it's not sent at all when left blank (undefined, not an empty
 * string -- the server's own zod schema would otherwise reject
 * `.min(1)`), and is sent when filled in.
 */
test("AutomationsPanel's webhook form has an optional secret field that's omitted when blank and sent when filled in", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const createBodies: Record<string, unknown>[] = [];
    let nextRuleId = "rule12";
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj5/automations") {
        return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj5/entities/Ticket/automations") {
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        createBodies.push(body);
        return new Response(JSON.stringify({ rule: makeRule({ id: nextRuleId, ...body }) }), {
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

      const urlInput = document.querySelector('input[type="url"]') as HTMLInputElement;
      fireEvent.change(urlInput, { target: { value: "https://hooks.example.com/forge" } });
      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "New ticket!" } });

      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await waitForCondition(() => createBodies.length === 1);
      assert.equal(createBodies[0]!.webhookSecret, undefined, "an empty secret field must not be sent at all");

      const secretInput = document.querySelector('input[placeholder="Secret (optional)"]') as HTMLInputElement;
      assert.ok(secretInput, "expected a secret input next to the webhook URL input");
      // Re-fill the URL/message fields explicitly rather than relying on
      // whatever the first submit's own post-success reset left them at --
      // the form must accept a second genuine submission with a secret
      // regardless of that timing.
      fireEvent.change(urlInput, { target: { value: "https://hooks.example.com/forge" } });
      fireEvent.change(messageField, { target: { value: "New ticket!" } });
      fireEvent.change(secretInput, { target: { value: "s3cr3t-token" } });
      nextRuleId = "rule13";
      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await waitForCondition(() => createBodies.length === 2);
      assert.equal(createBodies[1]!.webhookSecret, "s3cr3t-token");
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

/**
 * Round 1047: automation rules were the one remaining per-row entity in
 * this app with Edit/Delete but no Duplicate -- record Duplicate
 * (EntityPanel.tsx) and project Duplicate (My Projects home screen,
 * rounds 1041/1043) already serve the identical need elsewhere. Confirms
 * the new Duplicate button seeds the create-form exactly like Edit does,
 * but -- unlike Edit -- leaves the form in CREATE mode (no "Edit rule"
 * heading, no Cancel button, Create-labelled submit), so submitting
 * fires a POST that creates a brand-new rule rather than a PATCH that
 * overwrites the source rule, and the original rule survives untouched
 * alongside the new one.
 */
test("AutomationsPanel's Duplicate button seeds the create-form from an existing rule but leaves it in create mode, so Submit creates a second rule instead of overwriting the first", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let createBody: Record<string, unknown> | undefined;
    let patchCalled = false;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH") {
        patchCalled = true;
        throw new Error("Duplicate must never PATCH the source rule");
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
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const duplicateButton = Array.from(document.querySelectorAll(".automations-rule-actions button")).find(
        (b) => b.textContent === "Duplicate",
      ) as HTMLButtonElement;
      assert.ok(duplicateButton, "expected a Duplicate button on the rule row");
      fireEvent.click(duplicateButton);

      // Seeded from the source rule, just like Edit would -- but the form
      // itself must stay in create mode.
      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      assert.equal(messageField.value, "Hi {{customerName}}, delivered!", "the message template must be seeded from the rule");

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/, "Duplicate must never switch the form into edit mode");

      const entitySelect = document.querySelector(".automations-create-form select") as HTMLSelectElement;
      assert.equal(entitySelect.value, "Order", "the entity must still be seeded from the rule");
      assert.equal(entitySelect.disabled, false, "the entity select must stay editable -- unlike Edit, this is a fresh create, not a PATCH that can never change it");

      const submitButton = document.querySelector('.automations-create-form button[type="submit"]') as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Create rule", "the submit button must still read as a create action, not 'Save changes'");

      assert.equal(
        Array.from(document.querySelectorAll(".automations-create-form button")).some((b) => b.textContent === "Cancel"),
        false,
        "no Cancel button should appear -- there is no in-progress edit to cancel",
      );

      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 2);

      assert.equal(patchCalled, false, "submitting after Duplicate must never PATCH the source rule");
      assert.equal(createBody?.entityName ?? "Order", "Order");
      assert.equal(createBody?.actionType, "send_whatsapp");
      assert.equal(createBody?.toField, "customerPhone");
      assert.equal(createBody?.messageTemplate, "Hi {{customerName}}, delivered!", "the duplicate must carry over the source rule's own message template");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Sibling of the test above: Duplicate must never leak across rows --
 * clicking it on rule1 while rule2's own in-progress EDIT is still open
 * must discard that edit (return to create mode) rather than silently
 * merging rule1's own values into rule2's half-finished PATCH. Covers
 * the one call-site difference from handleStartEdit (an explicit
 * setEditingRuleId(null)) that a naive refactor could easily drop.
 */
test("AutomationsPanel's Duplicate button discards another rule's in-progress edit instead of merging into it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const rule1 = makeRule({ id: "rule1", messageTemplate: "Hi {{customerName}}, rule1!" });
    const rule2 = makeRule({ id: "rule2", messageTemplate: "Hi {{customerName}}, rule2!" });
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [rule1, rule2] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 2);

      const rows = Array.from(document.querySelectorAll(".automations-rule-row"));
      const editRule2 = Array.from(rows[1].querySelectorAll("button")).find((b) => b.textContent === "Edit") as HTMLButtonElement;
      fireEvent.click(editRule2);
      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /Edit rule/, "expected to actually be editing rule2 before duplicating rule1");

      const duplicateRule1 = Array.from(rows[0].querySelectorAll("button")).find((b) => b.textContent === "Duplicate") as HTMLButtonElement;
      fireEvent.click(duplicateRule1);

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/, "duplicating rule1 must discard rule2's in-progress edit, not merge into its PATCH");
      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      assert.equal(messageField.value, "Hi {{customerName}}, rule1!", "the form must be seeded from rule1 (the one just duplicated), not a mix with rule2's edit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 967: editing an existing "schedule" rule must show (and, if saved
 * unchanged, keep) that rule's own stored scheduleTimezone -- never
 * silently re-default it to whatever zone the editing browser happens to
 * be in. A rule created by one collaborator and later edited by another
 * (in a different real-world timezone) must not have its actual firing
 * time quietly shifted just because someone opened the edit form.
 */
test("editing an existing schedule rule preserves its own stored scheduleTimezone, not the editing browser's own detected zone", async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let patchBody: Record<string, unknown> | undefined;
    const scheduleRule = makeRule({
      id: "rule1",
      trigger: "schedule",
      fieldName: null,
      fieldValue: null,
      scheduleTimeUtc: "08:00",
      scheduleDaysOfWeek: null,
      scheduleTimezone: "Asia/Jerusalem",
      toMode: "static",
      toNumber: "972501234567",
      toField: null,
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [scheduleRule] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/automations/rule1") {
        patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ rule: { ...scheduleRule, messageTemplate: patchBody.messageTemplate } }), {
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

      assert.ok(
        document.querySelector(".automations-create-form")?.textContent?.includes("Asia/Jerusalem"),
        "the form must disclose the rule's OWN stored zone while editing, even though the editing browser's own zone is America/New_York",
      );
      assert.equal(
        document.querySelector(".automations-create-form")?.textContent?.includes("America/New_York"),
        false,
        "must not silently show the editing browser's own zone instead of the rule's real stored one",
      );

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Updated reminder text" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => patchBody !== undefined);
      assert.equal(
        patchBody?.scheduleTimezone,
        "Asia/Jerusalem",
        "saving an edit that never touched the schedule must send the rule's own original zone back, not the editing browser's",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  } finally {
    process.env.TZ = originalTz;
  }
});

/**
 * Round 883: disableAutomationRulesForField (packages/db/src/automations.ts)
 * disables a rule when its field is removed by a live refine, but
 * deliberately leaves fieldName/toField as the now-stale string in
 * storage (for restore-safety, per its own doc comment) -- the rule LIST
 * already handles this gracefully (fieldLabel's own fallback to the raw
 * name), but handleStartEdit used to seed fieldName straight from the
 * stored rule with no validation at all. The one guard that normally
 * keeps fieldName pointed at a real field (the effect right above
 * handleStartEdit in AutomationsPanel.tsx) is keyed on
 * [entityName, fieldTypesKey], which never changes here: "Order" is this
 * fixture's only entity, so entityName already equals rule.entityName
 * before Edit is even clicked, and "Order"'s own current field set
 * (fieldTypesKey) doesn't change by clicking Edit either -- the effect
 * simply never reruns, so the stale "status" value lands in React's own
 * fieldName state with none of the select's real <option>s matching it.
 *
 * Deliberately asserts on the submitted PATCH body, not the <select>
 * element's own .value property: an HTML <select> whose controlled
 * value matches none of its <option>s silently falls back its OWN .value
 * to the first real option regardless of what React's state actually
 * holds, so inspecting the DOM property alone can never tell a stale
 * "status" apart from a correctly-reset "customerName" -- only
 * submitting (which sends whatever fieldName itself truly is) proves
 * which one actually happened, matching the real user-facing symptom:
 * a confusing 404 FIELD_NOT_FOUND naming a field the dropdown never
 * visibly showed as selected.
 */
test("AutomationsPanel's Edit button falls back to a real field instead of submitting a now-removed field", async () => {
  await withJsdom(async () => {
    const orderWithoutStatus = [
      {
        name: "Order",
        label: "Order",
        fields: [
          { name: "customerName", label: "Customer Name", type: "text" as const, required: true },
          { name: "customerPhone", label: "Customer Phone", type: "text" as const, required: false },
        ],
      },
    ];
    const originalFetch = globalThis.fetch;
    let patchBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ fieldName: "status", enabled: false })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "PATCH" && input === "/api/projects/proj1/automations/rule1") {
        patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ rule: makeRule({ fieldName: patchBody.fieldName as string }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanelWith(project, () => {}, orderWithoutStatus);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      fireEvent.click(
        Array.from(document.querySelectorAll(".automations-rule-actions button")).find((b) => b.textContent === "Edit") as HTMLButtonElement,
      );

      // Submits immediately, without touching the field dropdown -- the
      // whole point is that a person who doesn't happen to re-click it
      // (it visually shows a normal-looking field either way, per the
      // DOM-fallback behavior noted above) must still get a request for
      // a real, still-existing field.
      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await waitForCondition(() => patchBody !== undefined);

      assert.equal(
        patchBody!.fieldName,
        "customerName",
        "must submit a real, still-existing field, not the stale 'status' value seeded from the disabled rule",
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
        scheduleTimezone: null,
        actionType: "send_whatsapp",
        toMode: "field",
        toField: "customerPhone",
        toNumber: null,
        webhookUrl: null,
        webhookSecret: null,
        toEmail: null,
        emailSubject: null,
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
 * Round 803: the rule list's own Delete button stays clickable on every
 * row regardless of which one (if any) is currently open for editing
 * below -- deleting the exact rule the form is mid-edit on used to leave
 * editingRuleId pointing at an id that no longer exists on the server.
 * The form kept showing "Edit rule", pre-filled with the now-deleted
 * rule's stale data and a visible "Save changes" button, with nothing on
 * screen signalling that saving was already impossible. Mirrors
 * EntityPanel.tsx's own identical "delete the record currently being
 * edited" guard. Confirms deleting the rule currently being edited
 * returns the form to create mode (heading, unlocked entity select, no
 * Cancel button, blank fields) instead of leaving it stuck mid-edit on a
 * rule that's already gone.
 */
test("deleting the rule currently open for editing returns the form to create mode, instead of leaving it stuck mid-edit on a rule that no longer exists", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/automations/rule1") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input} -- the form must never PATCH a rule that was already deleted`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      fireEvent.click(
        Array.from(document.querySelectorAll(".automations-rule-actions button")).find((b) => b.textContent === "Edit") as HTMLButtonElement,
      );
      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /Edit rule/, "expected the form to actually be in edit mode before deleting");

      fireEvent.click(document.querySelector(".automations-rule-actions .danger") as HTMLButtonElement);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 0);

      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/, "the form must return to create mode once the rule it was editing is gone");
      const entitySelect = document.querySelector(".automations-create-form select") as HTMLSelectElement;
      assert.equal(entitySelect.disabled, false, "the entity select must unlock again -- it's no longer editing anything");
      assert.equal(
        Array.from(document.querySelectorAll(".automations-create-form button")).some((b) => b.textContent === "Cancel"),
        false,
        "the Cancel button must disappear -- there's nothing left to cancel",
      );
      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      assert.equal(messageField.value, "", "the deleted rule's own stale message template must not still be sitting in the form");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 831's finding: the rule list's own Edit/Toggle/Delete buttons were
 * only ever disabled by busyRuleId (toggle/delete's own in-flight state),
 * never by createBusy (the shared create-form's own in-flight Save/Create
 * submission). While a Save was still in flight for rule1, nothing stopped
 * clicking Edit on rule2 -- which immediately overwrote editingRuleId and
 * every form field with rule2's values. Once rule1's own PATCH resolved,
 * handleSubmit's unconditional resetToCreateMode() call wiped the form
 * back to "New rule", silently discarding whatever the user had already
 * typed into rule2's in-progress edit, with zero warning. Confirms the row
 * buttons now stay disabled for the whole window a Save/Create is in
 * flight, closing the race rather than letting it happen and trying to
 * detect it afterward.
 */
test("the rule list's Edit/Toggle/Delete buttons stay disabled while a Save/Create submission is in flight, not just during toggle/delete", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolvePatch!: (value: Response) => void;
    const patchHeld = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ id: "rule1" }), makeRule({ id: "rule2" })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "PATCH" && input === "/api/projects/proj1/automations/rule1") {
        return patchHeld; // the rule1 Save stays in flight until the test resolves it
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 2);

      const firstRow = document.querySelectorAll(".automations-rule-row")[0] as HTMLElement;
      fireEvent.click(Array.from(firstRow.querySelectorAll("button")).find((b) => b.textContent === "Edit") as HTMLButtonElement);
      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /Edit rule/, "expected to actually be editing rule1 before saving");

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "rule1's edited message" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the PATCH call actually start before checking

      const secondRow = document.querySelectorAll(".automations-rule-row")[1] as HTMLElement;
      const secondRowEditButton = Array.from(secondRow.querySelectorAll("button")).find((b) => b.textContent === "Edit") as HTMLButtonElement;
      assert.equal(secondRowEditButton.disabled, true, "rule2's own Edit button must stay disabled while rule1's Save is still in flight");

      // Even if something clicked it anyway, the form must still be
      // showing rule1's own in-progress edit, not rule2's.
      fireEvent.click(secondRowEditButton);
      assert.equal(messageField.value, "rule1's edited message", "rule1's own in-progress edit must survive an attempted click on a disabled Edit button");

      resolvePatch(new Response(JSON.stringify({ rule: makeRule({ id: "rule1", messageTemplate: "rule1's edited message" }) }), { status: 200, headers: { "content-type": "application/json" } }));
      await waitForCondition(() => !secondRowEditButton.disabled);
      assert.match(document.querySelector(".automations-new-heading")!.textContent ?? "", /New rule/, "the form must return to create mode once rule1's own Save actually resolves");
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

/**
 * Round 971: a failed run with a recordId (a record-triggered rule's own
 * run) gets a Retry button; a failed run with no recordId (a "schedule"
 * rule's own run, which already retries automatically on its own) and a
 * run that already succeeded must not. Clicking Retry calls the real
 * retry endpoint and refreshes the whole run list from the server
 * (showing the new run the retry itself created), not just flipping the
 * clicked row's own status in place.
 */
test("AutomationsPanel shows a Retry button only for a failed run with a recordId, and clicking it calls the retry endpoint and refreshes the run list", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let retryCalls = 0;
    let runsFetchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj1/automations/rule1/runs") {
        runsFetchCount += 1;
        const runs =
          runsFetchCount === 1
            ? [
                { id: "run-schedule", ruleId: "rule1", status: "failed", error: "WhatsApp not connected", recordId: null, triggeredAt: new Date("2026-03-15T09:00:00Z").toISOString() },
                { id: "run-record", ruleId: "rule1", status: "failed", error: "WhatsApp not connected", recordId: 7, triggeredAt: new Date("2026-03-15T08:00:00Z").toISOString() },
                { id: "run-sent", ruleId: "rule1", status: "sent", error: null, recordId: 7, triggeredAt: new Date("2026-03-15T07:00:00Z").toISOString() },
              ]
            : [
                { id: "run-retry", ruleId: "rule1", status: "sent", error: null, recordId: 7, triggeredAt: new Date("2026-03-15T10:00:00Z").toISOString() },
                { id: "run-schedule", ruleId: "rule1", status: "failed", error: "WhatsApp not connected", recordId: null, triggeredAt: new Date("2026-03-15T09:00:00Z").toISOString() },
                { id: "run-record", ruleId: "rule1", status: "failed", error: "WhatsApp not connected", recordId: 7, triggeredAt: new Date("2026-03-15T08:00:00Z").toISOString() },
                { id: "run-sent", ruleId: "rule1", status: "sent", error: null, recordId: 7, triggeredAt: new Date("2026-03-15T07:00:00Z").toISOString() },
              ];
        return new Response(JSON.stringify({ runs }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/automations/rule1/runs/run-record/retry") {
        retryCalls += 1;
        return new Response(JSON.stringify({ run: { id: "run-retry", ruleId: "rule1", status: "sent" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const historyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;
      fireEvent.click(historyButton);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 3);

      const items = Array.from(document.querySelectorAll(".automations-rule-history-list li"));
      const retryButtons = items.map((li) => Array.from(li.querySelectorAll("button")).find((b) => b.textContent === "Retry") ?? null);
      assert.equal(retryButtons[0], null, "a failed run with NO recordId (a schedule rule's own failure) must not offer Retry");
      assert.ok(retryButtons[1], "a failed run WITH a recordId must offer Retry");
      assert.equal(retryButtons[2], null, "an already-sent run must not offer Retry");

      fireEvent.click(retryButtons[1]!);
      await waitForCondition(() => retryCalls === 1);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 4);
      assert.equal(runsFetchCount, 2, "a successful retry must re-fetch the run list to show the new run it just created");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 997: the "Test" button fires a rule on demand, through the new
 * .../test route -- a successful test (while History is expanded)
 * re-fetches the run list the same way a successful Retry already does,
 * and a failed test (e.g. the entity has no records yet) shows an inline
 * error right on the rule row instead of silently doing nothing.
 */
test("AutomationsPanel's Test button fires the rule on demand, refreshes the run list when History is expanded, and shows an inline error on failure", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let testCalls = 0;
    let runsFetchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj1/automations/rule1/runs") {
        runsFetchCount += 1;
        const runs =
          runsFetchCount === 1
            ? []
            : [{ id: "run-test", ruleId: "rule1", status: "sent", error: null, recordId: 7, triggeredAt: new Date("2026-03-15T10:00:00Z").toISOString() }];
        return new Response(JSON.stringify({ runs }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/automations/rule1/test") {
        testCalls += 1;
        if (testCalls === 1) {
          return new Response(JSON.stringify({ error: "There are no Order records yet to test this rule against -- create one first, then try again" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ run: { id: "run-test", ruleId: "rule1", status: "sent" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const testButton = () => Array.from(document.querySelectorAll(".automations-rule-actions button")).find((b) => b.textContent === "Test" || b.textContent === "Send test") as HTMLButtonElement;

      // First attempt: the server rejects it (no records yet) -- shows
      // the real error inline, never silently doing nothing.
      fireEvent.click(testButton());
      await waitForCondition(() => testCalls === 1);
      await waitForCondition(() => document.querySelector(".automations-rule-row .error")?.textContent === "There are no Order records yet to test this rule against -- create one first, then try again");

      // Expand History, then try again -- this time the server succeeds,
      // and the newly-fired run must show up in the refreshed list.
      const historyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;
      fireEvent.click(historyButton);
      await waitForCondition(() => runsFetchCount === 1);

      fireEvent.click(testButton());
      await waitForCondition(() => testCalls === 2);
      await waitForCondition(() => runsFetchCount === 2);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 1);
      assert.equal(document.querySelector(".automations-rule-row .error"), null, "a successful test must clear the earlier error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 972: a "schedule" rule's own failed run always has recordId:
 * null (there's no triggering record at all) -- the round-971 test just
 * above correctly hides Retry for a null-recordId run on a NON-schedule
 * rule, but a schedule rule's own null-recordId run is now retryable too
 * (it's the only way to clear a "paused for today" state before the next
 * UTC day -- see the server-side route's own round-972 comment), so the
 * Retry button must show for it specifically.
 */
test("AutomationsPanel shows a Retry button for a schedule rule's own failed run too, even though it has no recordId", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(JSON.stringify({ rules: [makeRule({ trigger: "schedule", fieldName: null, fieldValue: null })] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (input === "/api/projects/proj1/automations/rule1/runs") {
        return new Response(
          JSON.stringify({
            runs: [
              { id: "run1", ruleId: "rule1", status: "failed", error: "recipient not found", recordId: null, triggeredAt: new Date("2026-03-15T09:00:00Z").toISOString() },
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

      const historyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;
      fireEvent.click(historyButton);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 1);

      const retryButton = Array.from(document.querySelectorAll(".automations-rule-history-list li button")).find((b) => b.textContent === "Retry");
      assert.ok(retryButton, "a schedule rule's own failed run must offer Retry despite having no recordId");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 935: apps/api/src/automations.ts stores a failed send_whatsapp
 * run's error as the exact stable snake_case code whatsappWeb.ts's
 * sendMessage returns ("missing_country_code" is the COMMON case for a
 * toMode:"field" rule reading a locally-formatted phone field, per its
 * own doc comment) -- the manual "Send WhatsApp" panel (api.ts's own
 * sendWhatsAppMessage) already translates these same three codes, but
 * this panel's rule-row summary and run-history list never did, leaking
 * the bare English code into this Hebrew-primary app's UI.
 */
test("AutomationsPanel translates a send_whatsapp rule's known raw error code (e.g. missing_country_code) in both its rule-row summary and its run-history list, instead of showing the bare code", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({
            rules: [makeRule({ lastTriggeredAt: new Date("2026-03-15T09:00:00Z").toISOString(), lastStatus: "failed", lastError: "missing_country_code" })],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (input === "/api/projects/proj1/automations/rule1/runs") {
        return new Response(
          JSON.stringify({
            runs: [{ id: "run1", ruleId: "rule1", status: "failed", error: "missing_country_code", triggeredAt: new Date("2026-03-15T09:00:00Z").toISOString() }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 1);

      const row = document.querySelector(".automations-rule-row") as HTMLElement;
      assert.match(row.textContent ?? "", /missing a country code/, "the rule row's own last-run summary must show the translated message");
      assert.equal(row.textContent?.includes("missing_country_code") ?? true, false, "the bare raw error code must never leak into the rule row");

      const historyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;
      fireEvent.click(historyButton);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 1);

      const historyText = document.querySelector(".automations-rule-history-list")?.textContent ?? "";
      assert.match(historyText, /missing a country code/, "the run-history list must also show the translated message");
      assert.equal(historyText.includes("missing_country_code"), false, "the bare raw error code must never leak into the run-history list either");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 948: editing a rule's actionType (switching it between
 * send_whatsapp and webhook) never clears/retroactively updates its own
 * already-stored lastError/run history -- a rule's CURRENT actionType is
 * therefore not necessarily what it was when a given error was actually
 * recorded. Without lastActionType/run.actionType (both snapshotted at the
 * moment they're written -- see packages/db/src/automations.ts's
 * recordAutomationRun), translateAutomationError would read the rule's
 * now-webhook actionType and stop translating a WhatsApp-specific code
 * that's still sitting in lastError/an older run from before the edit --
 * the exact round-935 regression, reopened purely by editing the rule.
 */
test("AutomationsPanel still translates a known WhatsApp error code after the rule's own actionType was edited away from send_whatsapp, using the snapshotted lastActionType/run actionType instead of the rule's current one", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({
            rules: [
              makeRule({
                actionType: "webhook",
                webhookUrl: "https://example.com/hook",
                lastTriggeredAt: new Date("2026-03-15T09:00:00Z").toISOString(),
                lastStatus: "failed",
                lastError: "missing_country_code",
                lastActionType: "send_whatsapp",
              }),
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (input === "/api/projects/proj1/automations/rule1/runs") {
        return new Response(
          JSON.stringify({
            runs: [
              {
                id: "run1",
                ruleId: "rule1",
                status: "failed",
                error: "missing_country_code",
                actionType: "send_whatsapp",
                triggeredAt: new Date("2026-03-15T09:00:00Z").toISOString(),
              },
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

      const row = document.querySelector(".automations-rule-row") as HTMLElement;
      assert.match(row.textContent ?? "", /missing a country code/, "lastActionType, not the rule's now-webhook actionType, must still be used to translate the stale lastError");
      assert.equal(row.textContent?.includes("missing_country_code") ?? true, false, "the bare raw error code must never leak into the rule row even after the rule was edited");

      const historyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;
      fireEvent.click(historyButton);
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 1);

      const historyText = document.querySelector(".automations-rule-history-list")?.textContent ?? "";
      assert.match(historyText, /missing a country code/, "a historical run's own actionType must still be used to translate its error, independent of the rule's current actionType");
      assert.equal(historyText.includes("missing_country_code"), false, "the bare raw error code must never leak into the run-history list after the rule was edited either");
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

/**
 * Round 922: expandedHistoryRuleId and runsByRuleId are correctly keyed
 * per rule, but the sibling historyError/historyLoading (now
 * historyErrorByRuleId/loadingHistoryRuleIds) used to be single,
 * panel-wide values shared across every rule's own history fetch.
 * Expanding rule A's history (its fetch left in flight), then switching
 * to rule B's before A's settles, used to let A's fetch's own .catch
 * write an error into the one shared slot B's row was now reading --
 * this confirms that no longer happens: B's panel must show B's own real
 * run list, never rule A's unrelated, later-arriving error.
 */
test("AutomationsPanel's History panel for one rule never shows a DIFFERENT rule's error from a late-arriving, stale fetch", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let resolveRule1: ((value: Response) => void) | undefined;
    const rule1Gate = new Promise<Response>((resolve) => {
      resolveRule1 = resolve;
    });
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/automations") {
        return new Response(
          JSON.stringify({ rules: [makeRule({ id: "rule1" }), makeRule({ id: "rule2", fieldName: "stage" })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (input === "/api/projects/proj1/automations/rule1/runs") {
        return rule1Gate; // left pending until the test resolves it below
      }
      if (input === "/api/projects/proj1/automations/rule2/runs") {
        return new Response(
          JSON.stringify({
            runs: [{ id: "run2", ruleId: "rule2", status: "sent", error: null, triggeredAt: new Date("2026-03-15T10:00:00Z").toISOString() }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    try {
      renderPanel();
      await waitForCondition(() => document.querySelectorAll(".automations-rule-row").length === 2);

      const rows = Array.from(document.querySelectorAll(".automations-rule-row"));
      const historyButtonFor = (row: Element) => Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "History") as HTMLButtonElement;

      // Expand rule1's history -- its own fetch is gated, still in flight.
      fireEvent.click(historyButtonFor(rows[0]));
      await waitForCondition(() => document.querySelector(".automations-rule-history") !== null);

      // Switch to rule2's history before rule1's fetch ever settles.
      fireEvent.click(historyButtonFor(rows[1]));
      await waitForCondition(() => document.querySelectorAll(".automations-rule-history-list li").length === 1);
      assert.match(document.querySelector(".automations-rule-history-list li")?.textContent ?? "", /sent/i, "sanity check: rule2's own real run must be showing");

      // NOW rule1's stale fetch finally rejects, well after rule2's own
      // history is already showing successfully.
      resolveRule1!(new Response(JSON.stringify({ error: "rule1 boom" }), { status: 500, headers: { "content-type": "application/json" } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(
        document.querySelector('.automations-rule-history p[role="alert"]') !== null,
        false,
        "rule2's still-open history panel must never show rule1's unrelated, later-arriving error",
      );
      assert.equal(
        document.querySelectorAll(".automations-rule-history-list li").length,
        1,
        "rule2's real run list must still be showing, undisturbed by rule1's stale fetch settling later",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 806: the fifth sibling of the "field TYPE changes while its NAME
 * survives a live refine" bug class -- distinct from the four already-fixed
 * EntityPanel.tsx siblings (groupFieldName, bulkEditField/bulkEditValue,
 * editingCell/cellDraft, the main form, rounds 780/781/800/805), since this
 * panel has its own inline boolean/enum/relation rendering rather than going
 * through FieldInput. AutomationsPanel is mounted once per showAutomations
 * toggle and keeps receiving the live `entities` prop straight from App.tsx's
 * `project` state (no remount on a background refine), but the effect that
 * resets fieldValue to a type-appropriate default was keyed only on
 * [fieldName] -- never re-firing when the SAME still-selected field's type
 * changes underneath it. Picks "priority" (enum) and sets its value to
 * "High", then simulates a refine retyping "priority" to boolean while
 * staying selected (same entityName, same fieldName, no remount). Before the
 * fix, fieldValue stayed the stale string "High": `fieldValue === "true"` is
 * false, so the checkbox rendered UNCHECKED -- a plausible-looking but
 * actually-invalid state, since submitting would send "High" for a boolean
 * field. Confirms the fix instead resets it to the field's own normal
 * boolean default (checked, "true", the same default a freshly-selected
 * boolean field already gets per the existing "defaults to true" test
 * above), and that submitting sends that valid "true" rather than the stale
 * "High".
 */
test("AutomationsPanel resets a stale field_equals value when a live refine changes the selected field's type, instead of submitting a stale value for the new type", async () => {
  await withJsdom(async () => {
    const entityWithEnumPriority: Project["spec"]["entities"][number] = {
      name: "Ticket",
      label: "Ticket",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        {
          name: "priority",
          label: "Priority",
          type: "enum",
          required: false,
          enumValues: ["Low", "High"],
          enumLabels: { Low: "Low", High: "High" },
        },
      ],
    };
    const entityWithBooleanPriority: Project["spec"]["entities"][number] = {
      name: "Ticket",
      label: "Ticket",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "priority", label: "Priority", type: "boolean", required: false },
      ],
    };
    const retypeProject: Project = {
      ...triggerFieldProject,
      spec: { ...triggerFieldProject.spec, entities: [entityWithEnumPriority] },
    };
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
      const view = renderPanelWith(retypeProject, () => {}, [entityWithEnumPriority]);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "priority"),
      ) as HTMLSelectElement;
      fireEvent.change(fieldSelect, { target: { value: "priority" } });

      await waitForCondition(() => document.querySelector(".automations-field-value-placeholder, select[aria-label]") !== null || true);
      const valueSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "High"),
      ) as HTMLSelectElement;
      fireEvent.change(valueSelect, { target: { value: "High" } });
      await waitForCondition(() => valueSelect.value === "High");

      // Simulate a refine that retypes "priority" from enum to boolean
      // while staying on the exact same entityName ("Ticket") and the
      // exact same fieldName ("priority"), with the create form still
      // open and "priority" still selected -- the panel stays mounted,
      // just like the already-fixed EntityPanel.tsx siblings' own tests.
      view.rerender(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AutomationsPanel, {
              projectId: retypeProject.id,
              project: { ...retypeProject, spec: { ...retypeProject.spec, entities: [entityWithBooleanPriority] } },
              entities: [entityWithBooleanPriority],
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".automations-field-value-checkbox input") !== null);

      const checkbox = document.querySelector(".automations-field-value-checkbox input") as HTMLInputElement;
      assert.equal(
        checkbox.checked,
        true,
        "the stale enum value \"High\" must be reset to the field's own normal boolean default (checked), not rendered as a plausible-looking but actually-invalid unchecked box",
      );

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Priority changed" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.fieldValue, "true", "the submitted value must be the reset boolean default, never the stale enum string \"High\"");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 887: a sibling gap to the retype test just above, but narrower --
 * a live refine that narrows the SAME still-selected enum field's own
 * options, without ever changing its name or its type ("enum" stays
 * "enum"). fieldTypesKey (name:type) doesn't change, so before this fix
 * the fieldValue-revalidation effect never re-ran at all: fieldValue
 * stayed the now-removed option "InProgress", the <select> itself fell
 * back to showing some other option (an HTML select's own .value quietly
 * ignores a controlled value with no matching option), and submitting
 * without touching the dropdown would send the stale, now-invalid
 * "InProgress" straight to the server, which validateAutomationFieldValue
 * (apps/api/src/routes/projects.ts) rejects with a 400 the user never
 * consciously chose and can't see reflected on screen.
 */
test("AutomationsPanel resets a stale field_equals value when a live refine narrows the selected enum field's own options, instead of submitting a now-removed option", async () => {
  await withJsdom(async () => {
    const entityWithThreeStatuses: Project["spec"]["entities"][number] = {
      name: "Ticket",
      label: "Ticket",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: false,
          enumValues: ["New", "InProgress", "Done"],
          enumLabels: { New: "New", InProgress: "In Progress", Done: "Done" },
        },
      ],
    };
    const entityWithStatusNarrowed: Project["spec"]["entities"][number] = {
      name: "Ticket",
      label: "Ticket",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: false,
          enumValues: ["New", "Done"],
          enumLabels: { New: "New", Done: "Done" },
        },
      ],
    };
    const narrowProject: Project = {
      ...triggerFieldProject,
      spec: { ...triggerFieldProject.spec, entities: [entityWithThreeStatuses] },
    };
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
      const view = renderPanelWith(narrowProject, () => {}, [entityWithThreeStatuses]);
      await waitForCondition(() => document.body.textContent?.includes("No automations yet") ?? false);

      const triggerSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "field_equals"),
      ) as HTMLSelectElement;
      fireEvent.change(triggerSelect, { target: { value: "field_equals" } });

      const fieldSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "status"),
      ) as HTMLSelectElement;
      fireEvent.change(fieldSelect, { target: { value: "status" } });

      const valueSelect = Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "InProgress"),
      ) as HTMLSelectElement;
      fireEvent.change(valueSelect, { target: { value: "InProgress" } });
      await waitForCondition(() => valueSelect.value === "InProgress");

      // Simulate a refine that narrows "status" from
      // [New, InProgress, Done] to [New, Done] -- same entityName, same
      // fieldName, same type ("enum"), just a changed option list, with
      // the create form still open and "status" still selected. The
      // panel stays mounted, just like the already-fixed retype test above.
      view.rerender(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(AutomationsPanel, {
              projectId: narrowProject.id,
              project: { ...narrowProject, spec: { ...narrowProject.spec, entities: [entityWithStatusNarrowed] } },
              entities: [entityWithStatusNarrowed],
              onClose: () => {},
            }),
          ),
        ),
      );

      const newValueSelect = () =>
        Array.from(document.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "New")) as
          | HTMLSelectElement
          | undefined;
      await waitForCondition(() => newValueSelect()?.value !== "InProgress");

      assert.equal(
        newValueSelect()?.value,
        "New",
        "the stale, now-removed option \"InProgress\" must be reset to the first remaining real option",
      );

      const messageField = document.querySelector(".automations-create-form textarea") as HTMLTextAreaElement;
      fireEvent.change(messageField, { target: { value: "Status narrowed" } });
      fireEvent.submit(document.querySelector(".automations-create-form")!);

      await waitForCondition(() => createBody !== undefined);
      assert.equal(createBody?.fieldValue, "New", "the submitted value must be the reset real option, never the stale, now-removed \"InProgress\"");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
