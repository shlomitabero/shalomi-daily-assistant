import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Checkpoint, Project } from "@forge/shared";
import { HistoryPanel } from "./HistoryPanel.js";
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

function makeCheckpoint(id: string, label: string): Checkpoint {
  return {
    id,
    projectId: "proj1",
    label,
    spec: {
      summary: "s",
      personas: [],
      roles: ["Admin"],
      entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
      screens: [],
      assumptions: [],
      openQuestions: [],
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Regression test: handleRestore only disabled the ONE button whose own
 * checkpoint.id matched the in-flight busyId, leaving every other
 * checkpoint's restore button clickable while a restore request was still
 * pending. Clicking a second checkpoint's restore button in that window
 * fired a second, concurrent restoreCheckpoint request -- whichever
 * response landed last would silently overwrite the other's result via
 * onRestored, with no error and no visible sign anything had raced. Fixed
 * by disabling every restore button (not just the busy row's) whenever any
 * restore is in flight (`disabled={busyId !== null}`).
 */
test("HistoryPanel disables every restore button while one restore is in flight, so a second checkpoint can't be restored concurrently", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    const cp2 = makeCheckpoint("cp2", "Refine: add invoices");
    let restore1Resolved = false;
    let resolveRestore1!: (value: Response) => void;
    let restore2Calls = 0;
    const restoredProjects: string[] = [];

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        // Rendered in this exact order (the component doesn't re-sort), so
        // buttons[0] is cp1's own restore button (held open below) and
        // buttons[1] is cp2's (must never fire while cp1 is in flight).
        return new Response(JSON.stringify({ checkpoints: [cp1, cp2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/checkpoints/cp1/restore") {
        return new Promise<Response>((resolve) => {
          resolveRestore1 = (value) => {
            restore1Resolved = true;
            resolve(value);
          };
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/checkpoints/cp2/restore") {
        restore2Calls += 1;
        return new Response(JSON.stringify({ project: { id: "proj1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    const originalConfirm = globalThis.window?.confirm;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              // Deliberately NOT cp1.spec/cp2.spec -- this test's own
              // concern is the concurrency guard, not the "Current" chip
              // (covered separately below), and a currentSpec identical to
              // either checkpoint would disable its own restore button
              // before the test ever gets to click it.
              currentSpec: { ...cp1.spec, entities: [] },
              onRestored: (project: Project) => restoredProjects.push(project.id),
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);
      // This test's own concern is the concurrency guard, not the confirm
      // dialog (covered separately below) -- always confirm so restore
      // actually proceeds.
      globalThis.window.confirm = (() => true) as typeof window.confirm;

      const buttons = Array.from(document.querySelectorAll(".checkpoint-restore-btn")) as HTMLButtonElement[];
      assert.equal(buttons.length, 2, "expected one restore button per checkpoint");

      // Click the first checkpoint's restore button -- its request is held
      // open (resolveRestore1 not yet called) to simulate "still in flight".
      fireEvent.click(buttons[0]);
      await waitForCondition(() => buttons[0].disabled && buttons[1].disabled);

      // Attempting to restore the second checkpoint while the first is
      // still pending must be a no-op: the button is disabled, so the real
      // browser (and jsdom, confirmed empirically) never dispatches the
      // click to React's handler at all.
      fireEvent.click(buttons[1]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(restore2Calls, 0, "a disabled second restore button must never fire a second restore request");

      resolveRestore1(
        new Response(JSON.stringify({ project: { id: "proj1-restored" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await waitForCondition(() => restoredProjects.length === 1);
      assert.deepEqual(restoredProjects, ["proj1-restored"]);
    } finally {
      // Guards against leaking the real, un-mocked REQUEST_TIMEOUT_MS
      // (180s) timer api.ts's request() starts for cp1's restore -- if an
      // assertion above throws before the request is otherwise resolved,
      // that live timer would keep this test file's process alive well
      // past any reasonable shell-level timeout (the exact "permanently-
      // pending fetch mock" footgun this project's own tests avoid
      // elsewhere).
      if (!restore1Resolved) {
        resolveRestore1(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      globalThis.fetch = originalFetch;
      if (originalConfirm) globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: restoring a checkpoint (unlike every other real
 * destructive-feeling action in this app -- deleting a project, round 123;
 * removing a collaborator, round 136) had NO confirmation at all, even
 * though it changes which entities/fields the live screens currently show
 * (the "What would change?" toggle above already lets you preview that,
 * but nothing stopped you from clicking Restore without ever opening it).
 * Mirrors CollaboratorsPanel's own confirm gate exactly: declining must
 * leave both the checkpoint list and the server untouched.
 */
test("HistoryPanel's restore button asks for confirmation naming the checkpoint, and declining never calls the restore API", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const cp = makeCheckpoint("cp1", "Refine: add invoice tracking");
    let restoreCalls = 0;
    let confirmMessage: string | undefined;

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/checkpoints/cp1/restore") {
        restoreCalls += 1;
        return new Response(JSON.stringify({ project: { id: "proj1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = ((message: string) => {
      confirmMessage = message;
      return false;
    }) as typeof window.confirm;

    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              // Deliberately NOT cp.spec -- an identical currentSpec would
              // disable this checkpoint's own restore button (it'd be
              // marked Current), and this test's own concern is the
              // confirm-dialog gate, not that chip.
              currentSpec: { ...cp.spec, entities: [] },
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      const restoreBtn = document.querySelector(".checkpoint-restore-btn") as HTMLButtonElement;
      fireEvent.click(restoreBtn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.match(
        confirmMessage ?? "",
        /Refine: add invoice tracking/,
        "the confirm message must name the actual checkpoint being restored",
      );
      assert.equal(restoreCalls, 0, "declining the confirm must never call the restore API");
      assert.equal(document.querySelectorAll(".checkpoint-list li").length, 1, "the checkpoint must still be listed after declining");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: a "What would change?" toggle per checkpoint, showing
 * what restoring it would remove from the CURRENT spec -- restoring itself
 * never deletes data (migrations are additive-only), but it does hide
 * entities/fields the live screens currently show, which is exactly the
 * thing a real user would want to know before clicking Restore. Renders
 * with a currentSpec that has an entity (Invoice) and a field
 * (loyaltyPoints) the checkpoint doesn't have, expands the diff, and
 * confirms both real differences are named -- then checks a checkpoint
 * that's identical to the current spec reports "no changes" instead of an
 * empty, silent list.
 */
test("HistoryPanel's 'What would change?' toggle shows the real entities/fields restoring would remove, and 'no changes' when there are none", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const olderCheckpoint = makeCheckpoint("cp-older", "Initial build");
    // Same shape as currentSpec below, so restoring THIS one changes nothing.
    const identicalCheckpoint = makeCheckpoint("cp-identical", "Just before now");
    identicalCheckpoint.spec = {
      ...identicalCheckpoint.spec,
      entities: [
        {
          name: "Customer",
          fields: [
            { name: "name", type: "text", required: true },
            { name: "loyaltyPoints", type: "number", required: false },
          ],
        },
        { name: "Invoice", fields: [{ name: "total", type: "number", required: true }] },
      ],
    };

    const currentSpec = identicalCheckpoint.spec;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [olderCheckpoint, identicalCheckpoint] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              currentSpec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      const items = document.querySelectorAll(".checkpoint-list li");
      const olderToggle = items[0].querySelector(".detail-toggle") as HTMLButtonElement;
      fireEvent.click(olderToggle);
      await waitForCondition(() => items[0].querySelector(".detail-list") !== null);
      const olderDiffText = items[0].querySelector(".detail-list")!.textContent ?? "";
      assert.match(olderDiffText, /Invoice/, "expected the missing Invoice entity to be named");
      assert.match(olderDiffText, /loyaltyPoints/, "expected the missing loyaltyPoints field to be named");

      const identicalToggle = items[1].querySelector(".detail-toggle") as HTMLButtonElement;
      fireEvent.click(identicalToggle);
      await waitForCondition(() => /No changes/.test(items[1].textContent ?? ""));
      assert.equal(items[1].querySelector(".detail-list"), null, "an identical checkpoint must show the no-changes message, not an empty list");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: after restoring an OLDER checkpoint, the list's own
 * newest-first order no longer says which entry you're actually looking
 * at right now. Reuses the same "identical vs older" fixture shape as the
 * diff test above -- the identical checkpoint must show a real "Current"
 * chip and have its own restore button disabled (restoring it would be a
 * no-op), while the genuinely older checkpoint must show neither.
 */
test("HistoryPanel marks the checkpoint matching the current spec with a 'Current' chip and disables only that one's restore button", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const olderCheckpoint = makeCheckpoint("cp-older", "Initial build");
    const identicalCheckpoint = makeCheckpoint("cp-identical", "Just before now");
    identicalCheckpoint.spec = {
      ...identicalCheckpoint.spec,
      entities: [
        { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
        { name: "Invoice", fields: [{ name: "total", type: "number", required: true }] },
      ],
    };
    const currentSpec = identicalCheckpoint.spec;

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [olderCheckpoint, identicalCheckpoint] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              currentSpec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      const items = document.querySelectorAll(".checkpoint-list li");
      const olderItem = items[0];
      const identicalItem = items[1];

      assert.equal(olderItem.querySelector(".checkpoint-current-chip"), null, "the genuinely older checkpoint must not show a Current chip");
      assert.ok(identicalItem.querySelector(".checkpoint-current-chip"), "the checkpoint matching the current spec must show a real Current chip");

      const olderRestoreBtn = olderItem.querySelector(".checkpoint-restore-btn") as HTMLButtonElement;
      const identicalRestoreBtn = identicalItem.querySelector(".checkpoint-restore-btn") as HTMLButtonElement;
      assert.equal(olderRestoreBtn.disabled, false, "the older checkpoint's own restore button must stay enabled -- restoring it is a real action");
      assert.equal(identicalRestoreBtn.disabled, true, "restoring the checkpoint you're already on would be a no-op, so its own button must be disabled");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
