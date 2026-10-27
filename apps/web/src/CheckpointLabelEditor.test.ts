import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Checkpoint } from "@forge/shared";
import { CheckpointLabelEditor } from "./CheckpointLabelEditor.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

const checkpointLabelEditorSrc = readFileSync(new URL("./CheckpointLabelEditor.tsx", import.meta.url), "utf8");

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

function renderEditor(onRenamed: (c: Checkpoint) => void, readOnly = false, disabled = false) {
  render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(CheckpointLabelEditor, { checkpoint, projectId: "proj1", onRenamed, readOnly, disabled }),
      ),
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
 * Regression test for a real bug found by round 1087's Explore survey: the
 * `cancelling` ref's design assumes the spurious post-cancel blur really
 * does re-invoke save() once, letting it reset the flag back to false
 * there. A direct Playwright probe against real Chromium found this
 * assumption wrong -- that blur never reaches an already-unmounted
 * fiber's onBlur -- so the flag set by cancelEditing() stays `true`
 * forever and silently swallows the very next real save, with no error.
 * Fixed by resetting the flag in startEditing() too.
 */
test("renaming a checkpoint label, cancelling with Escape, then renaming it again for real must not be silently swallowed", async () => {
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

      // First session: start, change the draft, then cancel with Escape.
      fireEvent.click(document.querySelector(".checkpoint-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
      let input = document.querySelector(".checkpoint-label-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Accidentally typed text" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await waitForCondition(() => document.querySelector(".checkpoint-label-edit") === null);
      assert.equal(renameCalls, 0, "Escape must not itself trigger a rename");

      // Second session on the SAME instance: a real rename, saved via blur.
      fireEvent.click(document.querySelector(".checkpoint-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
      input = document.querySelector(".checkpoint-label-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "before the pricing overhaul" } });
      fireEvent.blur(input);

      await waitForCondition(() => renamed.length === 1);
      assert.equal(renameCalls, 1, "the real rename after a prior cancel must not be swallowed");
      assert.equal(renamed[0].label, "before the pricing overhaul");
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

/**
 * Real role enforcement (RBAC) round: a "viewer" collaborator passes
 * readOnly=true into HistoryPanel, which was threaded into every other
 * mutating control in that panel (restore/delete), but this editor --
 * despite its own doc comment claiming to mirror EntityLabelEditor's
 * click-to-edit pattern exactly -- never got the matching readOnly
 * treatment, leaving a fully-interactive rename control (with its own
 * edit-pencil icon) that could only ever fail with a 403 from the
 * server. Confirms readOnly renders plain, non-interactive text instead.
 */
test("readOnly=true renders the checkpoint label as plain text, with no click target, role, or edit icon", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renameCheckpoint must never be reachable at all when readOnly");
    }) as typeof fetch;

    try {
      renderEditor(() => {}, true);

      const label = document.querySelector(".checkpoint-label") as HTMLElement;
      assert.ok(label, "expected the checkpoint label to still render its text");
      assert.match(label.textContent ?? "", /Initial build/);
      assert.equal(label.getAttribute("role"), null, "a read-only label must not look like a clickable control");
      assert.equal(label.getAttribute("tabIndex"), null);
      assert.equal(document.querySelector(".checkpoint-label-edit-icon"), null, "no edit-pencil icon for a viewer");

      fireEvent.click(label);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.querySelector(".checkpoint-label-edit"), null, "clicking a read-only label must never open the rename input");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1120: HistoryPanel's own Restore/Delete buttons are disabled for
 * EVERY row while ANY row's restore/delete is in flight (see their own
 * doc comment), but this editor's label had no equivalent -- clicking it
 * while a restore/delete was pending (even for this exact checkpoint)
 * could start a concurrent renameCheckpoint request. `disabled` mirrors
 * `readOnly`'s own already-tested rendering exactly: plain, non-
 * interactive text, never a click target that can only ever race.
 */
test("disabled=true renders the checkpoint label as plain text, with no click target, role, or edit icon", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("renameCheckpoint must never be reachable at all when disabled");
    }) as typeof fetch;

    try {
      renderEditor(() => {}, false, true);

      const label = document.querySelector(".checkpoint-label") as HTMLElement;
      assert.ok(label, "expected the checkpoint label to still render its text");
      assert.match(label.textContent ?? "", /Initial build/);
      assert.equal(label.getAttribute("role"), null, "a disabled label must not look like a clickable control");
      assert.equal(document.querySelector(".checkpoint-label-edit-icon"), null, "no edit-pencil icon while disabled");

      fireEvent.click(label);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.querySelector(".checkpoint-label-edit"), null, "clicking a disabled label must never open the rename input");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1120: the handler-level half of the same fix -- extracts the real
 * startEditing (not reimplemented) and calls it with disabled=true and
 * every other identifier deliberately undeclared, so that if the guard
 * were ever removed, the very next line (`cancelling.current = false`)
 * throws a ReferenceError instead of silently doing nothing. Mirrors the
 * hang-proof extraction convention rounds 1117-1119 already established,
 * rather than a full-DOM-render test with a held-open fetch gate.
 */
test("the real startEditing is a no-op while disabled is true", () => {
  const handlerMatch = checkpointLabelEditorSrc.match(/ {2}function startEditing\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find startEditing in CheckpointLabelEditor.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });
  const fn = new Function("disabled", `${code}\nreturn startEditing;`)(true) as () => void;
  fn();
});

/**
 * Round 1120: the other half -- extracts the real save (not reimplemented)
 * and confirms onBusyChange fires (true) before the real renameCheckpoint
 * call starts and (false) once it settles, on both the success and the
 * failure path. HistoryPanel folds this into its own renamingId state, the
 * signal its Restore/Delete buttons' disabled condition now also checks.
 */
test("the real save reports busy=true before renameCheckpoint starts and busy=false once it settles, on both success and failure", async () => {
  const handlerMatch = checkpointLabelEditorSrc.match(/ {2}async function save\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find save in CheckpointLabelEditor.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  async function runSave(renameCheckpointImpl: (...args: unknown[]) => Promise<unknown>) {
    const busyLog: boolean[] = [];
    const fn = new Function(
      "cancelling",
      "draft",
      "checkpoint",
      "setEditing",
      "setBusy",
      "onBusyChange",
      "setError",
      "renameCheckpoint",
      "onRenamed",
      `${code}\nreturn save;`,
    )(
      { current: false },
      "A new, real label",
      checkpoint,
      () => {},
      () => {},
      (busy: boolean) => busyLog.push(busy),
      () => {},
      renameCheckpointImpl,
      () => {},
    ) as () => Promise<void>;
    await fn();
    return busyLog;
  }

  assert.deepEqual(
    await runSave(async () => ({ checkpoint: { ...checkpoint, label: "A new, real label" } })),
    [true, false],
    "a successful rename must report busy=true, then busy=false, in that order",
  );
  assert.deepEqual(
    await runSave(async () => {
      throw new Error("network error");
    }),
    [true, false],
    "a failed rename must still report busy=false once it settles, not leave the caller thinking it's still in flight",
  );
});
