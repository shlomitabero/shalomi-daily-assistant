import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Checkpoint, ProductSpec, Project } from "@forge/shared";
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
              projectName: "Test Project",
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
      // timer api.ts's request() starts for cp1's restore -- if an
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
              projectName: "Test Project",
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
              projectName: "Test Project",
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
              projectName: "Test Project",
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

/**
 * New in this round: every build/refine adds one more checkpoint forever
 * (no cap, no delete), so a project with a long real history had no way to
 * find one specific checkpoint besides scrolling and reading every label.
 * Mirrors "Your projects" own search box convention (only shown once the
 * list is actually long enough to need it -- more than 5 entries). Renders
 * 6 real checkpoints (crossing that threshold), types a real search that
 * matches exactly 2 of them, and confirms the live DOM narrows to exactly
 * those 2 -- then clears the search and confirms all 6 come back.
 */
test("HistoryPanel's search box (shown once there are more than 5 checkpoints) narrows the real list by label, and clearing it restores the rest", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const checkpoints = [
      makeCheckpoint("cp1", "Initial build"),
      makeCheckpoint("cp2", "Refine: add invoice tracking"),
      makeCheckpoint("cp3", "Refine: add customer notes"),
      makeCheckpoint("cp4", "Refine: fix invoice totals"),
      makeCheckpoint("cp5", "Refine: add reminders"),
      makeCheckpoint("cp6", "Refine: add tags"),
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints }), { status: 200, headers: { "content-type": "application/json" } });
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
              projectName: "Test Project",
              currentSpec: checkpoints[0].spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 6);
      assert.equal(
        document.querySelector(".history-count")!.textContent,
        " — 6 checkpoints",
        "unfiltered must read as a plain count, not '6 of 6 checkpoints'",
      );

      const searchBox = document.querySelector(".history-search") as HTMLInputElement;
      assert.ok(searchBox, "expected a search box once there are more than 5 checkpoints");

      fireEvent.change(searchBox, { target: { value: "invoice" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);
      // .childNodes[0] is the label's own text node -- CheckpointLabelEditor's
      // non-editing view is <strong>{label}<span>✏️</span></strong>, and a
      // plain .textContent read would include that trailing pencil icon too.
      const narrowedLabels = Array.from(document.querySelectorAll(".checkpoint-list li strong")).map((el) => el.childNodes[0].textContent);
      assert.deepEqual(
        narrowedLabels.sort(),
        ["Refine: add invoice tracking", "Refine: fix invoice totals"].sort(),
        "must show exactly the checkpoints whose real label contains the search text, and no others",
      );
      assert.equal(
        document.querySelector(".history-count")!.textContent,
        " — 2 of 6 checkpoints",
        "once the search narrows the history, the count must show shown-of-total",
      );

      fireEvent.change(searchBox, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: every checkpoint's own label already says whether it
 * came from the initial build or a later refine (see
 * apps/api/src/routes/projects.ts's changeLabel), but with no cap and no
 * delete on this list, a project with a long real history had no way to
 * isolate "just the original build" from "everything I've refined since"
 * besides reading every label -- the same independent-filter gap the
 * WhatsApp log's own direction/status filter (round 181) already closed
 * for its own data. Drives the real `<select>` through a real 6-checkpoint
 * fixture (crossing the same >5 threshold the search box uses), confirms
 * each filter's real row count, and confirms it composes with the existing
 * text search (narrowing to exactly the refines whose label matches).
 */
test("HistoryPanel's type filter (shown once there are more than 5 checkpoints) narrows the real list to build/refine, and composes with the search box", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const checkpoints = [
      makeCheckpoint("cp1", "Initial build"),
      makeCheckpoint("cp2", "Refine: add invoice tracking"),
      makeCheckpoint("cp3", "Refine: add customer notes"),
      makeCheckpoint("cp4", "Refine: fix invoice totals"),
      makeCheckpoint("cp5", "Refine: add reminders"),
      makeCheckpoint("cp6", "Refine: add tags"),
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints }), { status: 200, headers: { "content-type": "application/json" } });
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
              projectName: "Test Project",
              currentSpec: checkpoints[0].spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 6);

      const typeFilter = document.querySelector(".history-type-filter") as HTMLSelectElement;
      assert.ok(typeFilter, "expected a type filter once there are more than 5 checkpoints");

      fireEvent.change(typeFilter, { target: { value: "build" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);
      // .childNodes[0] is the label's own text node, not the trailing pencil
      // icon CheckpointLabelEditor's non-editing view also renders -- see
      // the identical comment on the search-box test just above this one.
      assert.deepEqual(
        Array.from(document.querySelectorAll(".checkpoint-list li strong")).map((el) => el.childNodes[0].textContent),
        ["Initial build"],
        "'build' must keep only the initial build, dropping every refine",
      );

      fireEvent.change(typeFilter, { target: { value: "refine" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 5);

      const searchBox = document.querySelector(".history-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "invoice" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);
      assert.deepEqual(
        Array.from(document.querySelectorAll(".checkpoint-list li strong")).map((el) => el.childNodes[0].textContent).sort(),
        ["Refine: add invoice tracking", "Refine: fix invoice totals"].sort(),
        "the type filter and text search must compose: only refines whose label matches 'invoice'",
      );

      fireEvent.change(typeFilter, { target: { value: "all" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);
      fireEvent.change(searchBox, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a project's checkpoint history only ever grows (no
 * cap, no delete), so this closes the same "keep a permanent record
 * outside the app" gap Business Twin (round 129) and the WhatsApp log
 * (round 154) already have a download button for.
 */
test("HistoryPanel shows a download button only once there are checkpoints, and clicking it downloads the real history as a named file", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    // jsdom doesn't implement the real Blob-URL machinery -- stub just
    // enough of it to observe what the click handler actually does, the
    // same technique WhatsAppPanel.test.ts's own download test uses.
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
      const { container } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              projectName: "Flower Shop",
              currentSpec: cp1.spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      // Before any checkpoints load, an empty history must not offer to
      // download nothing (mirrors the WhatsApp log's own empty-log guard).
      assert.equal(
        Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Download timeline")),
        false,
        "no download button should render before the history has any checkpoints",
      );

      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download timeline"));
      assert.ok(downloadButton, "expected a Download timeline button once the history has real checkpoints");

      fireEvent.click(downloadButton!);

      assert.equal(clickCount, 1, "clicking the download button must trigger exactly one real anchor click");
      const downloadName: string = capturedDownloadName ?? "";
      assert.ok(
        downloadName.includes("Flower Shop"),
        `expected the downloaded filename to be derived from the real project name "Flower Shop", got "${downloadName}"`,
      );
      assert.ok(downloadName.endsWith("history.txt"), `expected a history.txt filename, got "${downloadName}"`);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      anchorProto.click = originalAnchorClick;
    }
  });
});

/**
 * New in this round: the diff toggle could only ever answer "what would
 * change if I restore THIS checkpoint, compared to the live app right
 * now" -- there was no way to compare two arbitrary past checkpoints
 * against each other. Uses three genuinely distinct specs (older has only
 * Customer, middle adds Order, current/newest adds Invoice on top of
 * that) so the default vs-current diff and the vs-older-checkpoint diff
 * produce two different, individually verifiable results from the same
 * expanded row.
 */
test("HistoryPanel's 'Compare with' dropdown lets you diff one checkpoint against another checkpoint, not just against the live current state", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const older = makeCheckpoint("cp-older", "Initial build");
    older.spec = { ...older.spec, entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] };
    const middle = makeCheckpoint("cp-middle", "Refine: add orders");
    middle.spec = {
      ...middle.spec,
      entities: [
        { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
        { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      ],
    };
    const currentSpec: ProductSpec = {
      ...middle.spec,
      entities: [...middle.spec.entities, { name: "Invoice", fields: [{ name: "amount", type: "number", required: true }] }],
    };

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [older, middle] }), {
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
              projectName: "Test Project",
              currentSpec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      const items = document.querySelectorAll(".checkpoint-list li");
      const middleItem = items[1]; // newest-first order: older, then middle
      assert.match(middleItem.textContent ?? "", /add orders/);

      fireEvent.click(middleItem.querySelector(".detail-toggle") as HTMLButtonElement);
      await waitForCondition(() => middleItem.querySelector(".checkpoint-compare-row select") !== null);

      // The dropdown defaults to comparing against the live current state.
      assert.match(middleItem.textContent ?? "", /Current app state/);

      // Now the real test: the OLDER checkpoint's own diff toggle, compared
      // first against the live current state (default), then against the
      // "middle" checkpoint instead of current.
      fireEvent.click(middleItem.querySelector(".detail-toggle") as HTMLButtonElement); // close it
      const olderItem = items[0];
      fireEvent.click(olderItem.querySelector(".detail-toggle") as HTMLButtonElement);
      await waitForCondition(() => olderItem.querySelector(".checkpoint-compare-row select") !== null);

      // Default (vs current): current has both Order and Invoice, older has
      // neither -- both must be reported as what restoring "older" removes.
      assert.match(olderItem.textContent ?? "", /Order/);
      assert.match(olderItem.textContent ?? "", /Invoice/);

      const select = olderItem.querySelector(".checkpoint-compare-row select") as HTMLSelectElement;
      const middleOption = Array.from(select.options).find((o) => /add orders/.test(o.textContent ?? ""));
      assert.ok(middleOption, "expected the 'middle' checkpoint to be a selectable compare target");
      fireEvent.change(select, { target: { value: middleOption!.value } });

      // Now comparing "older" (baseline: middle) instead of vs-current --
      // middle only adds Order (no Invoice at all), so only Order must be
      // named as what restoring "older" would remove, and Invoice must NOT
      // appear anymore (it was only relevant against the live current state).
      await waitForCondition(() => /add orders/.test(olderItem.textContent ?? ""));
      assert.match(olderItem.textContent ?? "", /Order/);
      assert.doesNotMatch(
        olderItem.textContent ?? "",
        /Invoice/,
        "comparing against the 'middle' checkpoint (which has no Invoice) must not still mention Invoice from the old vs-current diff",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: every build/refine adds a checkpoint forever with no
 * way to prune a single unwanted one (an experimental refine that went
 * nowhere, say) -- the same real gap round 208 closed for the WhatsApp
 * message log. Confirms a real click asks for confirmation naming the
 * checkpoint, then calls the real DELETE endpoint and removes exactly that
 * one from the live list (not the other checkpoint sharing the same
 * render).
 */
test("HistoryPanel's delete button asks for confirmation naming the checkpoint, then removes exactly that one via a real DELETE round trip", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    const cp2 = makeCheckpoint("cp2", "Refine: add invoices");
    let deleteCalls = 0;
    let confirmMessage: string | undefined;

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1, cp2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/checkpoints/cp2") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = ((message: string) => {
      confirmMessage = message;
      return true;
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
              projectName: "Test Project",
              currentSpec: { ...cp1.spec, entities: [] },
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      const deleteButtons = Array.from(document.querySelectorAll(".checkpoint-delete-btn")) as HTMLButtonElement[];
      assert.equal(deleteButtons.length, 2, "expected one delete button per checkpoint");
      fireEvent.click(deleteButtons[1]); // cp2's own button

      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);
      assert.equal(deleteCalls, 1);
      assert.match(confirmMessage ?? "", /Refine: add invoices/, "the confirm message must name the actual checkpoint being deleted");
      assert.match(
        document.querySelector(".checkpoint-list li")!.textContent ?? "",
        /Initial build/,
        "the OTHER checkpoint must still be listed, untouched",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/** Mirrors the identical decline test already established for restore above -- declining must leave both the list and the server untouched. */
test("HistoryPanel's delete button does nothing when the confirm is declined", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    let deleteCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/checkpoints/cp1") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => false) as typeof window.confirm;

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
              projectName: "Test Project",
              currentSpec: { ...cp1.spec, entities: [] },
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      fireEvent.click(document.querySelector(".checkpoint-delete-btn") as HTMLButtonElement);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(deleteCalls, 0, "declining the confirm must never call the DELETE endpoint");
      assert.equal(document.querySelectorAll(".checkpoint-list li").length, 1, "the checkpoint must still be listed after declining");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Mirrors the identical restore-vs-restore concurrency guard already
 * established above, extended to the new delete action: restore and
 * delete now share the risk of a second action firing while the first is
 * still in flight (e.g. clicking Delete on one row while a Restore on
 * another is still pending would, without this guard, let both requests
 * race). Confirms a delete in flight disables every restore button too,
 * not just every other delete button.
 */
test("HistoryPanel disables every restore button while a delete is in flight, and vice versa", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    const cp2 = makeCheckpoint("cp2", "Refine: add invoices");
    let resolveDelete!: (value: Response) => void;
    let restoreCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1, cp2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/checkpoints/cp1") {
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      }
      if (method === "POST" && input === "/api/projects/proj1/checkpoints/cp2/restore") {
        restoreCalls += 1;
        return new Response(JSON.stringify({ project: { id: "proj1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

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
              projectName: "Test Project",
              currentSpec: { ...cp1.spec, entities: [] },
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      const deleteButtons = Array.from(document.querySelectorAll(".checkpoint-delete-btn")) as HTMLButtonElement[];
      const restoreButtons = Array.from(document.querySelectorAll(".checkpoint-restore-btn")) as HTMLButtonElement[];
      fireEvent.click(deleteButtons[0]); // cp1's own delete, held open
      await waitForCondition(() => restoreButtons[1].disabled && deleteButtons[1].disabled);

      fireEvent.click(restoreButtons[1]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(restoreCalls, 0, "a disabled restore button must never fire while an unrelated delete is still in flight");

      resolveDelete(new Response(null, { status: 204 }));
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: CheckpointLabelEditor gets its own dedicated DOM test
 * (CheckpointLabelEditor.test.ts), but that test never renders it inside
 * the real HistoryPanel list -- this confirms the wiring itself: clicking
 * a real checkpoint's own label inside the real panel, renaming it, and
 * seeing the real updated label render back in the same list (not just
 * reported via a callback in isolation), via a real PATCH round trip.
 */
test("HistoryPanel's checkpoint label is a real click-to-rename control wired into the live list, not just tested in isolation", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    let renameCalls = 0;

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/checkpoints/cp1") {
        renameCalls += 1;
        const body = JSON.parse(init!.body as string) as { label: string };
        return new Response(JSON.stringify({ checkpoint: { ...cp1, label: body.label } }), { status: 200, headers: { "content-type": "application/json" } });
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
              projectName: "Test Project",
              currentSpec: cp1.spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      fireEvent.click(document.querySelector(".checkpoint-label") as HTMLElement);
      await waitForCondition(() => document.querySelector(".checkpoint-label-edit input") !== null);
      const input = document.querySelector(".checkpoint-label-edit input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "before the pricing overhaul" } });
      fireEvent.blur(input);

      await waitForCondition(() => /before the pricing overhaul/.test((document.querySelector(".checkpoint-label") as HTMLElement)?.textContent ?? ""));
      assert.equal(renameCalls, 1, "expected exactly one real PATCH request");
      assert.equal(document.querySelectorAll(".checkpoint-list li").length, 1, "renaming must not add or remove any checkpoint from the real list");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the same "Copy report" companion action rounds
 * 222/223 added to Business Twin's and the WhatsApp log's own Download
 * buttons, closing out that pattern's third and final candidate here --
 * the timeline is already formatted as the same plain, shareable text
 * (formatCheckpointHistory), but the only way to get it anywhere was a
 * real file download. Confirms the real navigator.clipboard.writeText
 * receives the exact formatted timeline text, the button shows a real
 * "Copied!" confirmation, and (via a real mocked setTimeout tick, not a
 * hardcoded wait) fades back to normal 2 seconds later.
 */
test("HistoryPanel's copy button writes the real formatted timeline to the clipboard, shows Copied, then reverts", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

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
              projectName: "Flower Shop",
              currentSpec: cp1.spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "📋 Copy timeline");
      assert.ok(copyButton, "expected a Copy timeline button once the history has real checkpoints");

      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Flower Shop/, "the copied text must be the real formatted timeline, not a placeholder");
      assert.match(writtenText!, /Initial build/, "the copied text must include the real checkpoint label");
      assert.equal(copyButton!.textContent, "✅ Copied!", "must show the real Copied confirmation, not silently do nothing");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy timeline", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/** The other half: a real rejection (denied permission, insecure context) must show a real failure label, not fail silently or crash. */
test("HistoryPanel's copy button shows a failure label when navigator.clipboard.writeText rejects", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp1 = makeCheckpoint("cp1", "Initial build");
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp1] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });

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
              projectName: "Flower Shop",
              currentSpec: cp1.spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "📋 Copy timeline");
      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(copyButton!.textContent, "Copy failed", "a real clipboard rejection must show a real failure label");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy timeline", "must revert to the normal label even after a failure");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * New in this round: the checkpoint search box (shown once there are more
 * than 5 checkpoints) had no memory at all -- reopening History to find
 * "before the pricing overhaul" again meant retyping the exact same search
 * from scratch every time, the same gap Global Search's own query box had
 * before recentSearches.ts (round 180) and WhatsApp's test-send number
 * field had before whatsappRecentNumbers.ts (round 240). Since this
 * search box is a live filter (no submit button), a search is "committed"
 * to the recent list on blur or Enter, not on every keystroke. Confirms a
 * committed search survives a real unmount+remount of the panel (its own
 * close/reopen lifecycle) via historyRecentSearches.ts's real localStorage,
 * and that clicking the resulting chip both fills the search box and
 * genuinely re-filters the checkpoint list.
 */
test("HistoryPanel remembers a committed checkpoint search as a recent-search chip, surviving a close/reopen, and the chip both fills and re-filters", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const checkpoints = [
      makeCheckpoint("cp1", "Initial build"),
      makeCheckpoint("cp2", "Refine: add invoice tracking"),
      makeCheckpoint("cp3", "Refine: add customer notes"),
      makeCheckpoint("cp4", "Refine: fix invoice totals"),
      makeCheckpoint("cp5", "Refine: add reminders"),
      makeCheckpoint("cp6", "Refine: add tags"),
    ];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    function renderPanel() {
      return render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(HistoryPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              currentSpec: checkpoints[0].spec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
    }

    try {
      const first = renderPanel();
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 6);

      assert.equal(document.querySelector(".history-recent-searches"), null, "no recent-searches section before any search is committed");

      const searchBox = document.querySelector(".history-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "invoice" } });
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);
      fireEvent.blur(searchBox);

      await waitForCondition(() => document.querySelector(".history-recent-searches .chip-text") !== null);
      const chipAfterCommit = document.querySelector(".history-recent-searches .chip-text");
      assert.equal(chipAfterCommit?.textContent, "invoice", "blurring the search box must commit it as a real recent search");

      first.unmount();

      const second = renderPanel();
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 6);
      await waitForCondition(() => document.querySelector(".history-recent-searches .chip-text") !== null);
      const chipAfterRemount = document.querySelector(".history-recent-searches .chip-text");
      assert.equal(chipAfterRemount?.textContent, "invoice", "reopening the panel must show the persisted recent search");

      const reopenedSearchBox = document.querySelector(".history-search") as HTMLInputElement;
      assert.equal(reopenedSearchBox.value, "", "sanity check: the search box itself starts empty on a fresh mount");

      fireEvent.click(document.querySelector(".history-recent-searches .chip-text")!);
      assert.equal(reopenedSearchBox.value, "invoice", "clicking the chip must fill the search box with that query");
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 2);

      second.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: computeCheckpointDiff (checkpointDiff.ts) previously
 * detected a field only by name -- a same-named field that changed TYPE
 * between the checkpoint and the live spec (e.g. a refine turning a
 * free-text "status" field into an enum) was invisible to the diff,
 * silently showing "no changes" even though restoring would genuinely
 * change what the field does. This confirms the real, rendered "What would
 * change?" panel actually surfaces that -- not just the pure function in
 * isolation (already covered by checkpointDiff.test.ts).
 */
test("HistoryPanel's diff panel shows a real, rendered message when a checkpoint field's type differs from the live spec, not 'no changes'", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const cp: Checkpoint = {
      id: "cp1",
      projectId: "proj1",
      label: "Initial build",
      spec: {
        summary: "s",
        personas: [],
        roles: ["Admin"],
        entities: [
          {
            name: "Order",
            label: "Orders",
            fields: [{ name: "status", label: "Status", type: "text", required: true }],
          },
        ],
        screens: [],
        assumptions: [],
        openQuestions: [],
      },
      createdAt: new Date().toISOString(),
    };
    const currentSpec: ProductSpec = {
      ...cp.spec,
      entities: [
        {
          name: "Order",
          label: "Orders",
          fields: [
            { name: "status", label: "Status", type: "enum", required: true, enumValues: ["Pending", "Shipped"] },
          ],
        },
      ],
    };

    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/checkpoints") {
        return new Response(JSON.stringify({ checkpoints: [cp] }), {
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
              projectName: "Test Project",
              currentSpec,
              onRestored: () => {},
              onClose: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll(".checkpoint-list li").length === 1);

      const toggle = document.querySelector(".detail-toggle") as HTMLButtonElement;
      fireEvent.click(toggle);
      await waitForCondition(() => document.querySelector(".detail-list") !== null);

      const detailText = document.querySelector(".detail-list")!.textContent ?? "";
      assert.match(
        detailText,
        /Orders.*would change the type of these fields.*Status/,
        "a same-named field that changed type must be reported as a real change, not silently as 'no changes'",
      );
      assert.doesNotMatch(document.body.textContent ?? "", /No changes -- restoring/, "must never show the no-changes message when a field's type genuinely differs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
