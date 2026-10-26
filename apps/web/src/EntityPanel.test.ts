import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Entity, EntityRecord } from "@forge/shared";
import { getColumnWidths, setColumnWidth } from "./columnWidths.js";
import { getHiddenFields } from "./columnVisibility.js";
import { getGroupByField } from "./groupByPreference.js";
import { getCollapsedGroups } from "./collapsedGroupsPreference.js";
import { getCollapsedBoardColumns } from "./collapsedBoardColumnsPreference.js";
import { getViewMode } from "./viewModePreference.js";
import { getSortKeys } from "./sortKeysPreference.js";
import { getFieldFilters } from "./fieldFiltersPreference.js";
import { EntityPanel } from "./EntityPanel.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

/**
 * Stands in for any real overlay dialog (History, WhatsApp, Shortcuts, ...)
 * for the round-365 isAnyDialogOpen() regression test below -- a plain
 * button, deliberately no text input at all, mirroring ShortcutsPanel.tsx's
 * own shape exactly (the real dialog the round-365 bug report used as its
 * concrete repro, since its Close button is where useDialogFocusTrap's own
 * focus-move-in logic lands focus when a dialog has nothing else focusable).
 */
function TestOverlayDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);
  return React.createElement(
    "div",
    { ref: dialogRef, role: "dialog", "aria-modal": "true" },
    React.createElement("button", { type: "button", onClick: onClose }, "Close"),
  );
}

const entityPanelSrc = readFileSync(new URL("./EntityPanel.tsx", import.meta.url), "utf8");

/**
 * Regression test (round 693): a "file" field's stored value is just the
 * uploaded file's own descriptor (url/name/size/mimeType) -- before this
 * fix, handleDuplicate copied it verbatim, so the new record pointed at
 * the exact same file on disk as the original. routes/projects.ts's own
 * deleteReplacedFileFields has no way to know a second record now shares
 * that reference, so deleting either copy deleted the file out from under
 * the other, leaving the survivor's own file field pointing at a 404.
 */
test("EntityPanel's handleDuplicate never copies a 'file' field's value -- duplicating a record with an uploaded file must not make two records share the same file on disk", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleDuplicate\(id: number\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entity: Entity = {
    name: "Applicant",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "resume", type: "file", required: false },
    ],
  };
  const fileValue = JSON.stringify({ url: "/api/uploads/p1/Applicant/abc.pdf", name: "resume.pdf", size: 123, mimeType: "application/pdf" });
  const records: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Dana", resume: fileValue }];

  let capturedCopy: Record<string, unknown> | undefined;
  let refreshCalled = 0;

  const fn = new Function(
    "records",
    "setError",
    "entity",
    "createRecord",
    "projectId",
    "refresh",
    `${code}\nreturn handleDuplicate;`,
  )(
    records,
    () => {},
    entity,
    async (_projectId: string, _entityName: string, copy: Record<string, unknown>) => {
      capturedCopy = copy;
    },
    "proj1",
    async () => {
      refreshCalled += 1;
    },
  ) as (id: number) => Promise<void>;

  await fn(1);

  assert.equal(capturedCopy?.name, "Dana", "every non-file field must still be copied as before");
  assert.equal(capturedCopy?.resume, null, "a 'file' field's value must never be copied -- it would make the new record share the original's file on disk");
  assert.equal(refreshCalled, 1);
});

/**
 * Regression test: handleBulkDelete used to await `Promise.all(ids.map(...))`
 * inside a try/catch. A single rejected delete (a dropped connection, a
 * record another browser tab already removed) rejected the whole
 * `Promise.all` immediately, skipping both `refresh()` and the
 * `setSelectedIds` cleanup that followed it -- any records that DID delete
 * successfully stayed listed, and selected, in a now-stale table until the
 * user manually reloaded the page. This extracts the real handleBulkDelete
 * function straight from EntityPanel.tsx (not reimplemented), strips its
 * TypeScript syntax with esbuild (it's a plain async function, no JSX, so
 * the "ts" loader alone is enough), and runs it with a mock deleteRecord
 * that fails for exactly one of several selected ids.
 */
/**
 * Same Promise.allSettled resilience test as handleBulkDelete's own below,
 * applied to the new handleBulkDuplicate: a single rejected createRecord
 * call must not hide the duplicates that DID succeed, and must not stop
 * the loop from even attempting the remaining ids.
 */
test("EntityPanel's handleBulkDuplicate refreshes and keeps only the ids that actually failed selected, instead of one rejection hiding the duplicates that succeeded", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  let capturedSelectedIds: Set<number> | undefined;
  let refreshCalled = 0;
  const attemptedCopies: Record<string, unknown>[] = [];

  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const records: EntityRecord[] = [
    { id: 1, createdAt: "x", name: "Alice" },
    { id: 2, createdAt: "x", name: "Bob" },
    { id: 3, createdAt: "x", name: "Carol" },
  ];

  const fn = new Function(
    "bulkActionBusy",
    "setBulkActionBusy",
    "t",
    "projectId",
    "entity",
    "records",
    "selectedIds",
    "setError",
    "createRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDuplicate;`,
  )(
    false,
    () => {},
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "proj1",
    entity,
    records,
    new Set([1, 2, 3]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async (_projectId: string, _entityName: string, copy: Record<string, unknown>) => {
      attemptedCopies.push(copy);
      if (copy.name === "Bob") throw new Error("record 2 network error");
    },
    (next: Set<number>) => {
      capturedSelectedIds = next;
    },
    async () => {
      refreshCalled += 1;
    },
  ) as () => Promise<void>;

  await fn();

  assert.deepEqual(
    attemptedCopies.map((c) => c.name).sort(),
    ["Alice", "Bob", "Carol"],
    "must attempt every selected id, not stop at the first failure",
  );
  assert.deepEqual(
    [...capturedSelectedIds!].sort(),
    [2],
    "only the id that actually failed to duplicate should remain selected -- the two that succeeded must be cleared",
  );
  assert.match(
    capturedError!,
    /entity\.bulk\.duplicatePartialFailure/,
    "a partial failure must surface the translated duplicate-partial-failure message, not the raw single-record rejection",
  );
  assert.equal(refreshCalled, 1, "refresh() must still run so the table shows the records that WERE successfully duplicated");
});

test("EntityPanel's handleBulkDuplicate never copies a 'file' field's value either, for the same reason handleDuplicate doesn't", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entity: Entity = {
    name: "Applicant",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "resume", type: "file", required: false },
    ],
  };
  const fileValue = JSON.stringify({ url: "/api/uploads/p1/Applicant/abc.pdf", name: "resume.pdf", size: 123, mimeType: "application/pdf" });
  const records: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Dana", resume: fileValue }];

  const attemptedCopies: Record<string, unknown>[] = [];

  const fn = new Function(
    "bulkActionBusy",
    "setBulkActionBusy",
    "t",
    "projectId",
    "entity",
    "records",
    "selectedIds",
    "setError",
    "createRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDuplicate;`,
  )(
    false,
    () => {},
    (key: string) => key,
    "proj1",
    entity,
    records,
    new Set([1]),
    () => {},
    async (_projectId: string, _entityName: string, copy: Record<string, unknown>) => {
      attemptedCopies.push(copy);
    },
    () => {},
    async () => {},
  ) as () => Promise<void>;

  await fn();

  assert.equal(attemptedCopies.length, 1);
  assert.equal(attemptedCopies[0]!.name, "Dana");
  assert.equal(attemptedCopies[0]!.resume, null, "a 'file' field's value must never be copied in a bulk duplicate either");
});

/**
 * New in this round: a REQUIRED "file" field makes Duplicate doomed every
 * single time -- round 693's own fix above nulls the field out (correctly,
 * to avoid two records sharing one file on disk), but coerceValue
 * (repository.ts) then rejects that null for a required field, so the
 * request always failed with a generic "field is required" error for an
 * action the user never filled a form in for. Confirms the real
 * handleDuplicate now refuses upfront -- with the translated, specific
 * message naming the actual field -- and never even calls createRecord.
 */
test("EntityPanel's handleDuplicate refuses upfront for an entity with a required 'file' field, instead of always failing with a generic server error", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleDuplicate\(id: number\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entity: Entity = {
    name: "Applicant",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "resume", label: "Resume", type: "file", required: true },
    ],
  };
  const fileValue = JSON.stringify({ url: "/api/uploads/p1/Applicant/abc.pdf", name: "resume.pdf", size: 123, mimeType: "application/pdf" });
  const records: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Dana", resume: fileValue }];

  let capturedError: string | undefined;
  let createRecordCalled = 0;

  const fn = new Function(
    "records",
    "setError",
    "entity",
    "createRecord",
    "projectId",
    "refresh",
    "t",
    `${code}\nreturn handleDuplicate;`,
  )(
    records,
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    entity,
    async () => {
      createRecordCalled += 1;
    },
    "proj1",
    async () => {},
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  ) as (id: number) => Promise<void>;

  await fn(1);

  assert.equal(createRecordCalled, 0, "the doomed request must never even be attempted");
  assert.match(capturedError!, /entity\.duplicate\.requiredFileField/, "expected the translated, specific refusal message");
  assert.match(capturedError!, /"field":"Resume"/, "the refusal must name the real field's own label, not a generic field name");
});

test("EntityPanel's handleBulkDuplicate refuses the whole batch upfront for an entity with a required 'file' field, instead of every single duplicate failing the same way", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entity: Entity = {
    name: "Applicant",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "resume", label: "Resume", type: "file", required: true },
    ],
  };
  const fileValue = JSON.stringify({ url: "/api/uploads/p1/Applicant/abc.pdf", name: "resume.pdf", size: 123, mimeType: "application/pdf" });
  const records: EntityRecord[] = [
    { id: 1, createdAt: "x", name: "Dana", resume: fileValue },
    { id: 2, createdAt: "x", name: "Noa", resume: fileValue },
  ];

  let capturedError: string | undefined;
  let capturedBulkActionBusy: boolean | undefined;
  let createRecordCalled = 0;

  const fn = new Function(
    "bulkActionBusy",
    "setBulkActionBusy",
    "t",
    "projectId",
    "entity",
    "records",
    "selectedIds",
    "setError",
    "createRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDuplicate;`,
  )(
    false,
    (busy: boolean) => {
      capturedBulkActionBusy = busy;
    },
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "proj1",
    entity,
    records,
    new Set([1, 2]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async () => {
      createRecordCalled += 1;
    },
    () => {},
    async () => {},
  ) as () => Promise<void>;

  await fn();

  assert.equal(createRecordCalled, 0, "none of the doomed per-record requests must ever be attempted");
  assert.match(capturedError!, /entity\.duplicate\.requiredFileField/, "expected the translated, specific refusal message");
  assert.match(capturedError!, /"field":"Resume"/, "the refusal must name the real field's own label");
  assert.equal(capturedBulkActionBusy, undefined, "the busy flag must never even be set, since the batch is refused before that point");
});

test("EntityPanel's handleBulkDuplicate still surfaces the raw error message when every duplicate in the batch fails", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  const rejection = new Error("network error");
  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const records: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Alice" }];

  const fn = new Function(
    "bulkActionBusy",
    "setBulkActionBusy",
    "t",
    "projectId",
    "entity",
    "records",
    "selectedIds",
    "setError",
    "createRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDuplicate;`,
  )(
    false,
    () => {},
    (key: string) => key,
    "proj1",
    entity,
    records,
    new Set([1]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async () => {
      throw rejection;
    },
    () => {},
    async () => {},
  ) as () => Promise<void>;

  await fn();

  assert.equal(capturedError, rejection.message);
});

/**
 * Regression test (round 624): handleBulkDuplicate's "if (record)" guard
 * only wrapped the field-copying loop, not the createRecord(...) call
 * itself -- so a selected id whose record had already vanished from local
 * state (deleted by a collaborator, or in another tab, between selecting it
 * and clicking "Duplicate selected") still called createRecord with an
 * empty {} payload. For an entity with a required field this threw a
 * misleading validation error attributed to the wrong cause; for an entity
 * with no required fields at all (a valid spec shape) it would silently
 * insert a genuine blank garbage record. Mirrors handleDuplicate's own
 * `if (!record) return` guard, which already skips createRecord entirely
 * for a gone id.
 */
test("EntityPanel's handleBulkDuplicate never calls createRecord for a selected id whose record is no longer in local state", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedSelectedIds: Set<number> | undefined;
  let capturedError: string | undefined;
  const attemptedCopies: Record<string, unknown>[] = [];

  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  // id 2 is selected but no longer present in records -- simulates a
  // collaborator (or another tab) deleting it after it was selected but
  // before this batch ran.
  const records: EntityRecord[] = [
    { id: 1, createdAt: "x", name: "Alice" },
    { id: 3, createdAt: "x", name: "Carol" },
  ];

  const fn = new Function(
    "bulkActionBusy",
    "setBulkActionBusy",
    "t",
    "projectId",
    "entity",
    "records",
    "selectedIds",
    "setError",
    "createRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDuplicate;`,
  )(
    false,
    () => {},
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "proj1",
    entity,
    records,
    new Set([1, 2, 3]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async (_projectId: string, _entityName: string, copy: Record<string, unknown>) => {
      attemptedCopies.push(copy);
    },
    (next: Set<number>) => {
      capturedSelectedIds = next;
    },
    async () => {},
  ) as () => Promise<void>;

  await fn();

  assert.deepEqual(
    attemptedCopies.map((c) => c.name).sort(),
    ["Alice", "Carol"],
    "createRecord must never be called for id 2 -- its record is gone, so there is nothing real to duplicate",
  );
  assert.deepEqual(
    [...capturedSelectedIds!].sort(),
    [2],
    "the vanished id must be reported as a failure, not silently dropped or duplicated as a blank record",
  );
  assert.match(capturedError!, /entity\.bulk\.duplicatePartialFailure/);
});

/**
 * Regression test (round 544): handleBulkDuplicate used to touch
 * selectedIds only AFTER its own Promise.allSettled resolved, with no busy
 * flag and no disabled attribute on its own button -- a second click while
 * the first batch was still in flight started a fully independent second
 * batch of createRecord calls for the same ids, duplicating every selected
 * record twice instead of once. Mirrors round 543's analogous
 * handleBulkDeleteProjects test in App.test.ts: a fresh handler closure is
 * built per simulated "click" (as a real re-render would bind one), and the
 * first call's own createRecord calls are held open so a second click can
 * land while bulkActionBusy is still true.
 */
test("EntityPanel's handleBulkDuplicate refuses to start a second batch while a previous one is still in flight, and resumes normally once it finishes", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDuplicate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const records: EntityRecord[] = [
    { id: 1, createdAt: "x", name: "Alice" },
    { id: 2, createdAt: "x", name: "Bob" },
  ];

  const state = {
    bulkActionBusy: false,
    selectedIds: new Set([1, 2]),
    error: null as string | null,
  };
  const createCalls: string[] = [];
  let refreshCalled = 0;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });

  function makeHandler() {
    return new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "records",
      "selectedIds",
      "setError",
      "createRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkDuplicate;`,
    )(
      state.bulkActionBusy,
      (v: boolean) => (state.bulkActionBusy = v),
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      entity,
      records,
      state.selectedIds,
      (msg: string | null) => (state.error = msg),
      async (_projectId: string, _entityName: string, copy: Record<string, unknown>) => {
        createCalls.push(copy.name as string);
        await createGate;
      },
      (next: Set<number>) => (state.selectedIds = next),
      async () => {
        refreshCalled += 1;
      },
    ) as () => Promise<void>;
  }

  // First "click": starts the real batch, which marks itself busy
  // synchronously (before its own await) and begins both creates.
  const firstCall = makeHandler()();
  await Promise.resolve();
  assert.equal(state.bulkActionBusy, true, "the first invocation must mark itself busy before awaiting the real createRecord calls");
  assert.deepEqual(createCalls.sort(), ["Alice", "Bob"], "the first invocation's own duplicate calls must have started");

  // Second "click", landing while the first batch is still held open -- a
  // real re-render would bind a fresh handler against the now-true
  // bulkActionBusy, exactly like makeHandler() does here.
  await makeHandler()();
  assert.deepEqual(
    createCalls.sort(),
    ["Alice", "Bob"],
    "a second invocation while the first batch is still in flight must never call createRecord again for the same ids",
  );

  releaseCreate();
  await firstCall;
  assert.equal(state.bulkActionBusy, false, "the busy flag must be cleared once the first (real) batch finishes");
  assert.equal(refreshCalled, 1, "the first batch's own refresh must still run exactly once");
  assert.equal(state.error, null, "a duplicate batch that genuinely succeeded must never report an error");
});

/**
 * New in this round: bulk delete used to call the real DELETE endpoint for
 * every selected record the instant window.confirm closed, with zero
 * recovery -- the single highest-stakes action in the app (deleting many
 * records at once) had less of a safety net than single-record delete's
 * own undo window (round 184). Now reuses that exact same pendingDelete
 * machinery for the whole batch: all selected rows disappear immediately,
 * but every real DELETE call is delayed behind the same undo window, with
 * one shared toast for the batch. Confirms every selected row vanishes at
 * once, the real DELETE requests never fire while the window is open, the
 * toast names the real count, and clicking Undo restores every row (in
 * its original order) while genuinely cancelling every pending DELETE.
 */
test("EntityPanel's bulk delete removes every selected row immediately and shows one Undo toast for the batch, and clicking Undo restores all of them without ever calling the real delete API", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
      { id: 3, name: "Initech", status: "lost" },
    ];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      fireEvent.click(document.querySelector(".bulk-actions-bar .danger") as HTMLButtonElement);

      assert.equal(document.querySelectorAll("table tbody tr").length, 0, "all 3 selected rows must disappear immediately");
      assert.equal(deletedIds.length, 0, "no real DELETE request must have fired yet -- still inside the undo window");

      const toast = document.querySelector(".entity-undo-toast");
      assert.ok(toast, "expected one Undo toast for the whole batch");
      assert.match(toast!.textContent ?? "", /3/, "the toast must name the real number of deleted records");

      fireEvent.click(toast!.querySelector("button") as HTMLButtonElement);

      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal(document.querySelector(".entity-undo-toast"), null, "the toast must disappear once undone");
      const namesAfterUndo = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
      assert.ok(
        /Acme/.test(namesAfterUndo[0]) && /Globex/.test(namesAfterUndo[1]) && /Initech/.test(namesAfterUndo[2]),
        "all 3 rows must come back in their original order, not just restored in some arbitrary order",
      );

      act(() => {
        t.mock.timers.tick(10_000);
      });
      assert.equal(deletedIds.length, 0, "even long after the undo window would have elapsed, undoing must have cancelled every pending delete");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * The other half: NOT clicking Undo must commit every real delete in the
 * batch once the undo window actually elapses, mirroring single-delete's
 * own equivalent test -- the whole point is a temporary reprieve for the
 * whole selection, not silently keeping deleted records around forever.
 */
test("EntityPanel's pending bulk delete actually calls the real delete API for every selected record once the undo window elapses without Undo being clicked", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);

      t.mock.timers.enable({ apis: ["setTimeout"] });
      fireEvent.click(document.querySelector(".bulk-actions-bar .danger") as HTMLButtonElement);
      assert.equal(deletedIds.length, 0, "must not have deleted for real yet");

      act(() => {
        t.mock.timers.tick(5000);
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(deletedIds.slice().sort(), [1, 2], "once the undo window elapses with no Undo click, every real delete must actually fire");
      assert.equal(document.querySelector(".entity-undo-toast"), null, "the toast must clear itself once the batch delete actually commits");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * A partial failure within a committed bulk delete (one record another
 * tab already deleted, a real foreign-key constraint) must restore only
 * the record(s) that actually failed -- not the whole batch, and not
 * silently swallow the failure -- mirroring the exact Promise.allSettled
 * resilience handleBulkDelete already had before this round, now living
 * inside the shared commitPendingDelete instead.
 */
test("EntityPanel restores only the records whose real delete actually failed once a pending bulk delete's undo window elapses, and surfaces the partial-failure message", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Deal/1") {
        deletedIds.push(1);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Deal/2") {
        return new Response(
          JSON.stringify({ error: "another record still refers to it", code: "RECORD_HAS_DEPENDENT_RECORDS" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);

      t.mock.timers.enable({ apis: ["setTimeout"] });
      fireEvent.click(document.querySelector(".bulk-actions-bar .danger") as HTMLButtonElement);

      act(() => {
        t.mock.timers.tick(5000);
      });
      t.mock.timers.reset();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.deepEqual(deletedIds, [1], "the record that succeeded must have been deleted for real");
      const remainingRow = document.querySelector("table tbody tr");
      assert.match(remainingRow!.textContent ?? "", /Globex/, "only the record whose real delete failed must be restored");
      assert.match(
        document.querySelector(".error")?.textContent ?? "",
        /1 of 2 records could not be deleted/,
        "a partial failure must surface the translated partial-failure message naming the real counts",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: once rows are selected, the only ways to leave
 * selection mode were to actually commit a bulk delete/duplicate/update
 * (mutating data just to escape the mode) or manually uncheck every row
 * one at a time -- the header "select all" checkbox only clears when
 * every visible row is ALREADY selected; with some-but-not-all selected it
 * instead selects the rest, growing the selection rather than clearing it.
 * Confirms a dedicated "Clear selection" button empties selectedIds (the
 * bulk-actions-bar disappears and every row's checkbox is unchecked again)
 * without ever calling the API -- not even a GET refresh, let alone a
 * mutation.
 */
test("EntityPanel's 'Clear selection' button empties the current selection without touching the API", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    let getCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        getCount += 1;
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      const getCountAfterLoad = getCount;

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);
      assert.equal(
        Array.from(document.querySelectorAll('td.select-col input[type="checkbox"]')).filter((c) => (c as HTMLInputElement).checked).length,
        2,
        "both rows must be checked before clearing",
      );

      const clearButton = Array.from(document.querySelectorAll(".bulk-actions-bar button")).find(
        (b) => b.textContent === "Clear selection",
      ) as HTMLButtonElement | undefined;
      assert.ok(clearButton, "expected a 'Clear selection' button inside the bulk-actions-bar");
      fireEvent.click(clearButton!);

      assert.equal(document.querySelector(".bulk-actions-bar"), null, "the bulk-actions-bar must disappear once the selection is cleared");
      assert.equal(
        Array.from(document.querySelectorAll('td.select-col input[type="checkbox"]')).filter((c) => (c as HTMLInputElement).checked).length,
        0,
        "every row's own checkbox must be unchecked again",
      );
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "clearing the selection must not delete or hide any record");
      assert.equal(getCount, getCountAfterLoad, "clearing the selection must be purely local state -- it must never call the API, not even a refetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: bulk delete/duplicate already existed, but there was
 * no way to change a single shared field's value across several selected
 * records at once (e.g. marking 15 selected orders "Shipped") without
 * editing each row individually. Same Promise.allSettled resilience test
 * as handleBulkDelete/handleBulkDuplicate's own above: a single rejected
 * updateRecord call (a validation failure on one record's current state,
 * say) must not hide the updates that DID succeed, and must not stop the
 * loop from even attempting the remaining ids.
 */
test("EntityPanel's handleBulkUpdate refreshes and keeps only the ids that actually failed selected, instead of one rejection hiding the updates that succeeded", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const displayMatch = entityPanelSrc.match(/ {2}function bulkEditValueDisplay\(field: Field \| undefined, value: unknown\): string \{[\s\S]*?\n {2}\}\n/);
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch && displayMatch && handlerMatch, "expected to find invalidNumberField, bulkEditValueDisplay and handleBulkUpdate in EntityPanel.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${displayMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  let capturedError: string | undefined;
  let capturedSelectedIds: Set<number> | undefined;
  let refreshCalled = 0;
  const attemptedUpdates: { id: number; patch: Record<string, unknown> }[] = [];

  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = (() => true) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      { name: "Order", fields: [{ name: "status", required: false }] },
      new Set([1, 2, 3]),
      "status",
      "Shipped",
      (msg: string | null) => {
        capturedError = msg ?? undefined;
      },
      async (_projectId: string, _entityName: string, id: number, patch: Record<string, unknown>) => {
        attemptedUpdates.push({ id, patch });
        if (id === 2) throw new Error("record 2 network error");
      },
      (next: Set<number>) => {
        capturedSelectedIds = next;
      },
      async () => {
        refreshCalled += 1;
      },
    ) as () => Promise<void>;

    await fn();

    assert.deepEqual(
      attemptedUpdates.map((u) => u.id).sort(),
      [1, 2, 3],
      "must attempt every selected id, not stop at the first failure",
    );
    assert.deepEqual(
      attemptedUpdates.map((u) => u.patch),
      [{ status: "Shipped" }, { status: "Shipped" }, { status: "Shipped" }],
      "every update must send the same chosen field/value patch",
    );
    assert.deepEqual(
      [...capturedSelectedIds!].sort(),
      [2],
      "only the id that actually failed to update should remain selected -- the two that succeeded must be cleared",
    );
    assert.match(
      capturedError!,
      /entity\.bulk\.updatePartialFailure/,
      "a partial failure must surface the translated update-partial-failure message, not the raw single-record rejection",
    );
    assert.equal(refreshCalled, 1, "refresh() must still run so the table shows the records that WERE successfully updated");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

/**
 * Regression test (round 625): handleBulkUpdate had NEITHER a confirmation
 * dialog NOR any undo window, unlike its sibling handleBulkDelete (which has
 * both -- window.confirm, then the same pendingDelete undo-toast mechanism
 * single-record delete uses -- precisely because "zero recovery once
 * confirmed" meant real, permanent data loss). A bulk field update is just
 * as destructive and just as irreversible: it overwrites a real field's
 * value across every selected record in one stroke, with nothing to revert
 * to. Worse, handleBulkEditFieldChange resets bulkEditValue to "" the
 * instant a field is picked, and the "Apply" button was enabled the instant
 * bulkEditField was non-empty -- so an accidental/premature click applied a
 * blank value to every selected record's field, which coerceValue silently
 * accepts (stores null) for any non-required field. Mirrors handleBulkDelete's
 * own window.confirm guard, which already protects the sibling action.
 *
 * Round 1023: this exact scenario (bulkEditValue left at its default "")
 * is precisely the dangerous, easy-to-miss case -- so the confirm dialog
 * now uses the dedicated entity.bulk.confirmClearField key instead of the
 * generic confirmUpdate one, naming the field being blanked.
 */
test("EntityPanel's handleBulkUpdate asks for confirmation before applying, and does nothing at all if the user cancels", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch && handlerMatch, "expected to find invalidNumberField and handleBulkUpdate in EntityPanel.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  const originalConfirm = globalThis.window.confirm;
  let confirmMessage: string | undefined;
  let updateCalled = false;
  let refreshCalled = false;
  globalThis.window.confirm = ((msg: string) => {
    confirmMessage = msg;
    return false;
  }) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      { name: "Order", fields: [{ name: "status", required: false }] },
      new Set([1, 2, 3]),
      "status",
      "",
      () => {},
      async () => {
        updateCalled = true;
      },
      () => {},
      async () => {
        refreshCalled = true;
      },
    ) as () => Promise<void>;

    await fn();

    assert.match(
      confirmMessage!,
      /entity\.bulk\.confirmClearField/,
      "a blank value must ask for confirmation naming the dedicated clear-field key, not the generic confirm-update key, before touching any record",
    );
    assert.match(confirmMessage!, /"status"/, "must name the specific field being cleared");
    assert.equal(updateCalled, false, "must not call updateRecord at all when the user cancels the confirmation");
    assert.equal(refreshCalled, false, "must not refresh when nothing was updated");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

test("EntityPanel's handleBulkUpdate does nothing when no field has been chosen yet", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let updateCalled = false;
  let refreshCalled = false;
  const fn = new Function(
    "bulkActionBusy",
    "setBulkActionBusy",
    "t",
    "projectId",
    "entity",
    "selectedIds",
    "bulkEditField",
    "bulkEditValue",
    "setError",
    "updateRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkUpdate;`,
  )(
    false,
    () => {},
    (key: string) => key,
    "proj1",
    { name: "Order" },
    new Set([1]),
    "",
    "",
    () => {},
    async () => {
      updateCalled = true;
    },
    () => {},
    async () => {
      refreshCalled = true;
    },
  ) as () => Promise<void>;

  await fn();

  assert.equal(updateCalled, false, "must not call updateRecord when bulkEditField is empty");
  assert.equal(refreshCalled, false, "must not refresh when nothing was updated");
});

/**
 * Round 702: the single-record add/edit form has had its own pre-submit
 * required-field guard for a long time (missingField, above in this same
 * file) -- but handleBulkUpdate let a required field through at its default
 * blank value with no equivalent check, firing one doomed PATCH per
 * selected record, every one rejected server-side, surfaced only as a
 * generic error with no field name at all. Confirms the bulk path now
 * refuses before even asking for confirmation, let alone calling
 * updateRecord, and names the field the same way the single-record form's
 * own message does.
 */
test("EntityPanel's handleBulkUpdate refuses a blank value for a required field before even asking for confirmation", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkUpdate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  let confirmCalled = false;
  let updateCalled = false;
  let refreshCalled = false;
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = (() => {
    confirmCalled = true;
    return true;
  }) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      { name: "Order", fields: [{ name: "status", label: "Status", required: true }] },
      new Set([1, 2, 3]),
      "status",
      "",
      (msg: string | null) => {
        capturedError = msg ?? undefined;
      },
      async () => {
        updateCalled = true;
      },
      () => {},
      async () => {
        refreshCalled = true;
      },
    ) as () => Promise<void>;

    await fn();

    assert.match(
      capturedError!,
      /entity\.form\.requiredField/,
      "must surface the same translated required-field message the single-record form uses, naming the field",
    );
    assert.equal(confirmCalled, false, "must refuse before even asking for confirmation");
    assert.equal(updateCalled, false, "must not call updateRecord at all when the chosen field is required and blank");
    assert.equal(refreshCalled, false, "must not refresh when nothing was updated");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

/**
 * Sibling of the guard test above: a required field is only a problem when
 * actually left blank. Confirms picking a real value for that same required
 * field proceeds normally (asks for confirmation, calls updateRecord) --
 * guards against an overbroad fix that blocks every required field
 * regardless of its chosen value.
 */
test("EntityPanel's handleBulkUpdate still proceeds when a required field is given a real value", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const displayMatch = entityPanelSrc.match(/ {2}function bulkEditValueDisplay\(field: Field \| undefined, value: unknown\): string \{[\s\S]*?\n {2}\}\n/);
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(`${helperMatch![0]}\n${displayMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  let capturedError: string | undefined;
  let updateCalled = false;
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = (() => true) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string) => key,
      "proj1",
      { name: "Order", fields: [{ name: "status", label: "Status", required: true }] },
      new Set([1]),
      "status",
      "Shipped",
      (msg: string | null) => {
        capturedError = msg ?? undefined;
      },
      async () => {
        updateCalled = true;
      },
      () => {},
      async () => {},
    ) as () => Promise<void>;

    await fn();

    assert.equal(capturedError, undefined, "must not report any error when a real value was chosen for the required field");
    assert.equal(updateCalled, true, "must still call updateRecord when the required field has a real value");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

/**
 * Round 1023: before this, entity.bulk.confirmUpdate's own message named
 * neither the field nor the value about to be applied -- just "Set this
 * field on {count} records?" -- so confirming after accidentally picking
 * the wrong value (or the right field but wrong row's value) was
 * indistinguishable from confirming the intended update. Confirms a
 * non-blank bulk edit now names both the field's label and a
 * human-readable form of the chosen value in the confirm message, and
 * still uses the generic confirmUpdate key (not the dedicated
 * clear-field one, which is reserved for the blank-value case).
 */
test("EntityPanel's handleBulkUpdate names the field and value in the confirm message for a real, non-blank value", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const displayMatch = entityPanelSrc.match(/ {2}function bulkEditValueDisplay\(field: Field \| undefined, value: unknown\): string \{[\s\S]*?\n {2}\}\n/);
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch && displayMatch && handlerMatch, "expected to find invalidNumberField, bulkEditValueDisplay and handleBulkUpdate in EntityPanel.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${displayMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  const originalConfirm = globalThis.window.confirm;
  let confirmMessage: string | undefined;
  globalThis.window.confirm = ((msg: string) => {
    confirmMessage = msg;
    return false;
  }) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      { name: "Order", fields: [{ name: "status", label: "Status", required: false }] },
      new Set([1, 2, 3]),
      "status",
      "Shipped",
      () => {},
      async () => {},
      () => {},
      async () => {},
    ) as () => Promise<void>;

    await fn();

    assert.match(confirmMessage!, /entity\.bulk\.confirmUpdate/, "a real value must use the generic confirmUpdate key, not confirmClearField");
    assert.match(confirmMessage!, /"field":"Status"/, "must name the field's own label");
    assert.match(confirmMessage!, /"value":"Shipped"/, "must show the actual value about to be applied");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

/**
 * Round 1023: a boolean field's "false" is a deliberate, meaningful value
 * (unlike every other field type's default "" placeholder before the
 * value picker is ever touched) -- so it must never be treated as the
 * dangerous "forgot to pick a value" case, even though it's falsy.
 */
test("EntityPanel's handleBulkUpdate treats a boolean field's false as a real chosen value, not as an accidental blank-clear", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const displayMatch = entityPanelSrc.match(/ {2}function bulkEditValueDisplay\(field: Field \| undefined, value: unknown\): string \{[\s\S]*?\n {2}\}\n/);
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(`${helperMatch![0]}\n${displayMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  const originalConfirm = globalThis.window.confirm;
  let confirmMessage: string | undefined;
  globalThis.window.confirm = ((msg: string) => {
    confirmMessage = msg;
    return false;
  }) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      { name: "Order", fields: [{ name: "confirmed", label: "Confirmed", type: "boolean", required: false }] },
      new Set([1]),
      "confirmed",
      false,
      () => {},
      async () => {},
      () => {},
      async () => {},
    ) as () => Promise<void>;

    await fn();

    assert.match(confirmMessage!, /entity\.bulk\.confirmUpdate/, "a deliberately chosen boolean false must use the generic confirmUpdate key, not confirmClearField");
    assert.match(confirmMessage!, /"value":"FALSE"/, "must show the boolean value using this app's own TRUE\\/FALSE display convention");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

/**
 * Round 984: a real bug introduced by round 980's own fix (not a
 * pre-existing gap), found by a fresh Explore survey. Round 980 switched
 * a real "number" field's input from a native `<input type="number">`
 * (whose own browser-level keystroke sanitization made a non-numeric
 * string physically impossible to produce) to a plain text input with no
 * such guard. handleBulkUpdate only ever pre-checked required-ness, never
 * that a "number" field's value is actually numeric, so ordinary typo
 * text (e.g. "abc") now reaches the server as-is, where it's rejected
 * with the server's own bare, unlabeled message -- surfaced to the user
 * only as the generic VALIDATION_ERROR banner (resolveErrorMessage always
 * overrides a real server message for that error code), the exact
 * failure shape this file's own required-field checks already exist to
 * avoid. Confirms the bulk path now refuses before even asking for
 * confirmation, naming the field, mirroring the required-field guard
 * immediately above.
 */
test("EntityPanel's handleBulkUpdate refuses a non-numeric value for a 'number' field before even asking for confirmation", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(helperMatch && handlerMatch, "expected to find invalidNumberField and handleBulkUpdate in EntityPanel.tsx");
  const { code } = transformSync(`${helperMatch![0]}\n${handlerMatch![0]}`, { loader: "ts" });

  let capturedError: string | undefined;
  let confirmCalled = false;
  let updateCalled = false;
  const originalConfirm = globalThis.window.confirm;
  globalThis.window.confirm = (() => {
    confirmCalled = true;
    return true;
  }) as typeof window.confirm;
  try {
    const fn = new Function(
      "bulkActionBusy",
      "setBulkActionBusy",
      "t",
      "projectId",
      "entity",
      "selectedIds",
      "bulkEditField",
      "bulkEditValue",
      "setError",
      "updateRecord",
      "setSelectedIds",
      "refresh",
      `${code}\nreturn handleBulkUpdate;`,
    )(
      false,
      () => {},
      (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
      "proj1",
      { name: "Order", fields: [{ name: "amount", label: "Amount", type: "number", required: false }] },
      new Set([1, 2, 3]),
      "amount",
      "abc",
      (msg: string | null) => {
        capturedError = msg ?? undefined;
      },
      async () => {
        updateCalled = true;
      },
      () => {},
      async () => {},
    ) as () => Promise<void>;

    await fn();

    assert.match(
      capturedError!,
      /entity\.form\.invalidNumber/,
      "must surface a translated, field-named 'must be a number' message, not let the bad string reach the server",
    );
    assert.equal(confirmCalled, false, "must refuse before even asking for confirmation");
    assert.equal(updateCalled, false, "must not call updateRecord at all when the chosen value isn't actually numeric");
  } finally {
    globalThis.window.confirm = originalConfirm;
  }
});

/**
 * Regression test: refresh() is called from many independent places
 * (handleSubmit, handleDelete, handleDuplicate, handleBulkDelete,
 * handleImportFile, handleMove, and the mount/entity-change effect) with
 * no guard against two calls overlapping. handleDuplicate in particular
 * has no confirmation dialog, so a user double-clicking "duplicate" on
 * two different rows in quick succession starts two overlapping
 * refresh() calls -- if the first (now stale) call's own listRecords
 * round trip happens to resolve after the second (newer) call's, its
 * setRecords silently clobbered the newer, correct table with stale
 * data, the same race this session already found and fixed in
 * HistoryPanel.tsx/App.tsx/GlobalSearchPanel.tsx/WhatsAppPanel.tsx/
 * codegen.ts's GlobalSearch.jsx. Deterministic, not timing-based: holds
 * the FIRST refresh's listRecords call open past the SECOND refresh's
 * own completion. Runs the real generated refresh function.
 */
test("EntityPanel's refresh ignores a stale, still-in-flight refresh's records once a newer refresh has already completed", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function refresh\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find refresh in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let listRecordsCallCount = 0;
  let resolveFirstCall!: () => void;
  const firstCallHeld = new Promise<void>((resolve) => {
    resolveFirstCall = resolve;
  });
  const capturedRecordsByCall: unknown[][] = [];
  const refreshRequestId = { current: 0 };

  const fn = new Function(
    "refreshRequestId",
    "setLoading",
    "listRecords",
    "projectId",
    "entity",
    "setRecords",
    "setLoadError",
    "pendingDeleteRef",
    `${code}\nreturn refresh;`,
  )(
    refreshRequestId,
    () => {},
    async () => {
      listRecordsCallCount += 1;
      if (listRecordsCallCount === 1) {
        await firstCallHeld; // the stale "first" refresh's own network call stays open
        return { records: [{ id: 1, name: "stale" }] };
      }
      return { records: [{ id: 2, name: "fresh" }] };
    },
    "proj1",
    { name: "Customer" },
    (records: unknown[]) => {
      capturedRecordsByCall.push(records);
    },
    () => {},
    { current: null },
  ) as () => Promise<void>;

  const stalePromise = fn();
  await Promise.resolve(); // let the stale call actually start and reach its held-open listRecords call
  const freshPromise = fn();
  await freshPromise;

  assert.equal(capturedRecordsByCall.length, 1, "the fresh (second) refresh must have applied its own records");
  assert.deepEqual(capturedRecordsByCall[0], [{ id: 2, name: "fresh" }]);

  resolveFirstCall();
  await stalePromise;

  assert.equal(
    capturedRecordsByCall.length,
    1,
    "the stale (first) refresh resolving afterward must never call setRecords again and overwrite the fresh records",
  );
});

/**
 * New in this round: a failed initial load (a transient network blip, a
 * cold-starting backend) left the table permanently stuck on the generic
 * "No records yet" empty-state text -- indistinguishable from a genuinely
 * empty table, and with no way to recover short of closing and reopening
 * the entity tab. BusinessTwinPanel already had this exact "Retry" pattern
 * (its own loadTwin); this closes the identical, previously-missing gap
 * here. Confirms the real error+Retry row appears instead of the
 * misleading empty-state message, and clicking Retry genuinely re-fetches
 * (not a reimplementation) and shows the real data once it succeeds.
 */
test("EntityPanel shows a real error with a Retry button when the initial load fails, instead of the misleading 'No records yet' message", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && input === "/api/projects/proj1/entities/Deal") {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Server exploded" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ records: [{ id: 1, name: "Acme Corp", status: "new" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".error-retry-row") !== null);

      assert.match(document.querySelector(".error-retry-row p.error")!.textContent ?? "", /Server exploded/);
      assert.equal(
        document.querySelector(".empty-state"),
        null,
        "a real load failure must not also show the misleading 'No records yet' empty-state text",
      );

      const retryButton = document.querySelector(".error-retry-row button") as HTMLButtonElement;
      assert.ok(retryButton, "expected a real Retry button");

      fireEvent.click(retryButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(document.querySelector(".error-retry-row"), null, "the error+Retry row must disappear once the retry succeeds");
      assert.match(document.querySelector("table tbody tr")!.textContent ?? "", /Acme Corp/, "the real record from the successful retry must now render");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Same jsdom-swap technique as useDialogFocusTrap.test.ts/BuildProgress.test.ts. */
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

/** Polls a real-DOM condition with plain ticks (deliberately NOT wrapped in
 * act(), per this session's own hard-won lesson in BuildProgress.test.ts: a
 * third, outer act() nested around a render() that already fires effects
 * inside testing-library's own act() -- plus a second, inner one from
 * whatever async work those effects kick off -- deadlocks React's act-scope
 * bookkeeping and hangs the whole node:test process). Bounded, not infinite,
 * so a genuine regression fails the test instead of hanging the suite. */
async function waitForCondition(check: () => boolean, maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitForCondition: condition never became true");
}

const DEAL_ENTITY: Entity = {
  name: "Deal",
  label: "Deal",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      enumValues: ["new", "won", "lost"],
      enumLabels: { new: "New", won: "Won", lost: "Lost" },
    },
  ],
};

/**
 * Builds a fetch mock backing listRecords/updateRecord (the only two
 * EntityPanel calls this scenario needs -- Deal has no relation fields, so
 * the loadRelated effect never hits the network) against a real, mutable
 * in-memory record store, so a PATCH genuinely changes what the next GET
 * returns -- the same round trip the real API gives the component.
 */
function mockRecordsFetch(store: EntityRecord[], onDelete?: (id: number) => void) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
      return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const patchMatch = /^\/api\/projects\/proj1\/entities\/Deal\/(\d+)$/.exec(input);
    if (method === "PATCH" && patchMatch) {
      const id = Number(patchMatch[1]);
      const record = store.find((r) => r.id === id);
      assert.ok(record, `mock PATCH target record ${id} must exist`);
      Object.assign(record!, JSON.parse(init!.body as string));
      return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const deleteMatch = /^\/api\/projects\/proj1\/entities\/Deal\/(\d+)$/.exec(input);
    if (method === "DELETE" && deleteMatch) {
      onDelete?.(Number(deleteMatch[1]));
      return new Response(null, { status: 204 });
    }
    throw new Error(`mockRecordsFetch: unexpected request ${method} ${input}`);
  };
}

function buildEntityPanelElement(extraProps: Record<string, unknown> = {}) {
  return React.createElement(
    ThemeProvider,
    null,
    React.createElement(
      LanguageProvider,
      null,
      React.createElement(EntityPanel, {
        projectId: "proj1",
        userId: "user1",
        entity: DEAL_ENTITY,
        allEntities: [DEAL_ENTITY],
        onEntityRenamed: () => {},
        ...extraProps,
      }),
    ),
  );
}

function renderEntityPanel(extraProps: Record<string, unknown> = {}) {
  return render(buildEntityPanelElement(extraProps));
}

/**
 * New in this round: a text field's value used to render as completely
 * inert text everywhere -- a "Website" or contact-email value on a
 * Customer/Vendor/Lead-shaped entity had to be manually selected and
 * copied to actually visit or email it. Confirms the table cell now
 * renders a real, clickable `<a>` for both a URL and an email address
 * embedded in the value, with the correct href (a plain URL as-is, an
 * email as `mailto:`), while the rest of the text stays plain -- not just
 * splitLinkSegments' own pure-function coverage in
 * entityFormatting.test.ts, but the actual wired-up rendering through a
 * real component tree and DOM.
 */
test("EntityPanel's table cell renders a real clickable link for a URL and an email address embedded in a text field's value", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "See https://acme.example.com or email dana@acme.example.com", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const links = Array.from(document.querySelectorAll("table tbody a.cell-link")) as HTMLAnchorElement[];
      assert.equal(links.length, 2, "expected exactly one link for the URL and one for the email address");
      assert.equal(links[0].getAttribute("href"), "https://acme.example.com");
      assert.equal(links[0].textContent, "https://acme.example.com");
      assert.equal(links[1].getAttribute("href"), "mailto:dana@acme.example.com");
      assert.equal(links[1].textContent, "dana@acme.example.com");
      assert.equal(links[0].getAttribute("target"), "_blank");

      const cell = links[0].closest("td")!;
      assert.match(cell.textContent ?? "", /^See .*or email/, "the plain text around the links must still render as ordinary text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression-style coverage for a real-DOM contract the existing
 * handleBulkDelete extraction tests above can't reach: groupByField's own
 * doc comment says an enum value with zero matching records "still shows as
 * a column rather than silently disappearing" -- true in isolation (see
 * entityFormatting.test.ts), but never actually exercised through the live
 * component tree with a real fetch round trip and a real re-render. Renders
 * EntityPanel with a single "Deal" record in the "new" stage, switches to
 * board view, and confirms all three declared statuses ("new"/"won"/"lost")
 * render as columns even though two of them have no cards.
 */
test("EntityPanel's board view renders an empty column for every declared status, not just the ones with records", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length > 0);

      assert.equal(
        document.querySelectorAll(".board-column").length,
        3,
        "all 3 declared enum values must render as columns, including the 2 with zero records",
      );
      assert.equal(document.querySelectorAll(".board-card").length, 1, "only the 1 real record should render as a card");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: selectedIds is view-mode-agnostic state, but the only
 * UI that can ever set it (the row checkboxes, select-all, and the "x"
 * shortcut) lives entirely in Table view -- Board's own card and the
 * calendar day cells have no selection checkbox at all. Before this fix,
 * selecting rows in Table and then switching to Board left that stale
 * selection invisible (no highlight on any card) and unreachable: the
 * toolbar's own Copy/Export-CSV buttons read selectedIds unconditionally in
 * every view (their label literally switches to "Export N selected"), but
 * the table-only bulk-actions-bar's "Clear selection" button and the
 * table-only Escape shortcut were both the only ways back to an empty
 * selection, and neither exists in Board view. Confirms the toolbar's own
 * label actually changes (not just that some internal state looks right),
 * and that switching back to Table shows a real, visibly-unchecked
 * checkbox -- not just a cleared Set that happens not to be rendered yet.
 */
test("EntityPanel clears a Table-view row selection the moment the user switches to Board view, so the toolbar never lies about a selection nothing can see or clear", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const rowCheckbox = document.querySelector('tr[data-record-id="1"] .select-col input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(rowCheckbox);
      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      assert.match(exportBtn.textContent ?? "", /1 selected/, "sanity check: selecting the row must flip the toolbar's own label");

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length > 0);

      assert.doesNotMatch(
        exportBtn.textContent ?? "",
        /selected/,
        "the toolbar must stop claiming a selection that Board view has no way to show or clear",
      );

      const tableToggle = document.querySelectorAll(".view-toggle-btn")[0] as HTMLButtonElement;
      fireEvent.click(tableToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      const rowCheckboxAgain = document.querySelector('tr[data-record-id="1"] .select-col input[type="checkbox"]') as HTMLInputElement;
      assert.equal(rowCheckboxAgain.checked, false, "the selection must still be genuinely empty after switching back, not just hidden while in Board view");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the board view's own sibling to the calendar view's
 * "click an empty day to create a record for that date" (startCreateForDate)
 * -- a "+" button in each column's header that opens the general create
 * form already pre-filled with that column's own status value, via the new
 * startCreateForColumn. Picks the "Won" column specifically (not the first
 * one) so a bug that left the value unset (falling through to the default
 * "new") can't slip past a same-as-default false pass.
 */
test("EntityPanel's board view '+' button opens the create form pre-filled with that column's own status value", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);

      const wonColumn = Array.from(document.querySelectorAll(".board-column")).find((col) =>
        col.querySelector(".board-column-header")?.textContent?.includes("Won"),
      );
      assert.ok(wonColumn, "expected a 'Won' column");

      const addButton = wonColumn!.querySelector(".board-add-card-btn") as HTMLButtonElement;
      assert.ok(addButton, "expected a real add-card button in the column header");

      fireEvent.click(addButton);

      const statusSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.equal(statusSelect.value, "won", "the create form must be pre-filled with this column's own status value");

      const submitButton = document.querySelector(".form-actions button[type=submit]") as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Add", "must be in create mode (not edit mode) after clicking a column's add button");
      assert.equal(document.querySelector(".form-actions button.secondary"), null, "no Cancel button -- confirms this isn't edit mode");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression coverage for a real bug: a record whose stored status isn't
 * one of the 3 declared enum values (e.g. a legacy "archived" value left
 * behind after a refine renamed the field's options -- migrations only
 * ever add columns, never rewrite existing row data) used to simply vanish
 * from the board with no trace, while still showing up fine in table view.
 * groupByField now collects it into a trailing "(other)" column instead.
 * This also confirms that synthetic column is display-only: it has no
 * "+" add-card button (there's no real status value to create against),
 * and dropping a card onto it is a no-op rather than writing a bogus value.
 */
test("EntityPanel's board view collects a record with an unrecognized status into an '(other)' column instead of dropping it", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "archived" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 4);

      const otherColumn = Array.from(document.querySelectorAll(".board-column")).find((col) =>
        col.querySelector(".board-column-header")?.textContent?.includes("Other"),
      );
      assert.ok(otherColumn, "expected a trailing '(other)' column");
      assert.equal(otherColumn!.classList.contains("board-column-other"), true);
      assert.equal(
        otherColumn!.querySelectorAll(".board-card").length,
        1,
        "the 1 record with the unrecognized status must render here, not vanish",
      );
      assert.equal(
        otherColumn!.querySelector(".board-add-card-btn"),
        null,
        "no add-card button -- there's no real status value to create a record against",
      );

      fireEvent.drop(otherColumn!, { dataTransfer: { getData: () => "1" } });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let any (wrongly) fired PATCH's promise chain settle
      assert.equal(
        store.find((r) => r.id === 1)!.status,
        "new",
        "dropping a card onto the synthetic '(other)' column must not PATCH anything -- record 1's status must be untouched",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression coverage for a real bug found alongside the "(other)" column
 * fix above: that fix stopped the record from vanishing from the board, but
 * never gave its own per-card "move" <select> an <option> for the stale
 * value itself -- only the field's current enumValues get <option>s. A
 * controlled <select> whose value matches no <option> is silently blanked
 * by the browser (selectedIndex -1), so the one place meant to show/change
 * a card's current stage showed nothing at all for exactly the records this
 * feature exists to handle, even though the same value renders correctly
 * everywhere else (the badge, CSV export, the column it's grouped into).
 */
test("EntityPanel's board card 'move' select shows the record's real stale status, not a blank selection", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "archived" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 4);

      const otherColumn = Array.from(document.querySelectorAll(".board-column")).find((col) =>
        col.querySelector(".board-column-header")?.textContent?.includes("Other"),
      );
      const moveSelect = otherColumn!.querySelector(".board-card-move") as HTMLSelectElement;
      assert.ok(moveSelect, "expected the card's own move select to render");
      assert.equal(moveSelect.value, "archived", "the select must reflect the record's real stored status, not blank out");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 752: the fix just above only ever adds a non-empty stale value
 * (e.g. "archived") to the move select's own option list -- it never
 * adds "" itself. A record whose board field is simply null/unset (an
 * optional board field left blank at creation, or any pre-existing row
 * after a refine added this field as a brand-new column -- migrate.ts's
 * additive-only ALTER TABLE always leaves existing rows NULL) also lands
 * in the "(other)" column, with the exact same "controlled value matches
 * no <option>" blanking the browser silently applies -- but with no
 * visible placeholder at all, unlike FieldInput's own enum branch, which
 * always renders one.
 */
test("EntityPanel's board card 'move' select shows a real placeholder, not a blank selection, for a record whose status is null/unset", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: null },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 4);

      const otherColumn = Array.from(document.querySelectorAll(".board-column")).find((col) =>
        col.querySelector(".board-column-header")?.textContent?.includes("Other"),
      );
      const moveSelect = otherColumn!.querySelector(".board-card-move") as HTMLSelectElement;
      assert.ok(moveSelect, "expected the card's own move select to render");
      assert.equal(moveSelect.value, "", "the select's controlled value must stay empty, matching the record's real unset status");
      assert.equal(
        moveSelect.selectedIndex === -1,
        false,
        "the select must have a real matching <option> (the disabled placeholder), not blank out with selectedIndex -1",
      );
      assert.equal((moveSelect.options[moveSelect.selectedIndex] as HTMLOptionElement).disabled, true, "the matched placeholder option must be disabled, not a real selectable status");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 509's finding: hiddenFields' own persisted-load
 * effect is one of 4 siblings (alongside recentSearches, columnOrderState,
 * columnWidths, groupFieldName) that never got the fieldNamesKey
 * re-validation fix given to viewMode/fieldFilters/sortKeys (rounds 490,
 * 493, 500) -- but unlike those three, hiddenFields has a *second*, simpler
 * way to end up holding a name for a field that no longer exists: a stale
 * localStorage entry left over from a field that was since removed (e.g. a
 * previous refine, or in the exported standalone app, a user re-running a
 * newer export of the same project in a browser that still has an older
 * export's localStorage). handleToggleColumn's own "keep at least one
 * column visible" guard computed visibleCount as
 * `entity.fields.length - hiddenFields.size`, which counts that phantom
 * entry as if it were hiding a real column -- undercounting how many
 * columns are actually visible and wrongly refusing to hide a column that
 * was never blanked out in the first place. Seeds localStorage with a
 * hidden-fields entry naming a field ("stage") that isn't one of this
 * entity's real fields, confirms both real columns (Name, Status) still
 * render as visible and checked, then confirms the Status checkbox can
 * still be unchecked -- hiding it -- instead of silently refusing because
 * the phantom "stage" entry made the guard think only one column was
 * really visible already.
 */
test("EntityPanel's Columns menu can still hide a real column when hiddenFields holds a stale name for a field that no longer exists", async () => {
  await withJsdom(async () => {
    localStorage.setItem("forge.hiddenColumns", JSON.stringify({ "proj1:Deal": ["stage"] }));
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.equal(
        document.querySelectorAll("thead th").length,
        5,
        "a stale 'stage' entry naming no real field must not hide anything -- both Name and Status must still render",
      );

      const columnsBtn = document.querySelector(".columns-menu-btn") as HTMLButtonElement;
      fireEvent.click(columnsBtn);
      const checkboxes = Array.from(document.querySelectorAll(".columns-menu-item input[type=checkbox]")) as HTMLInputElement[];
      assert.equal(checkboxes.length, 2, "expected one checkbox per real field (Name, Status) -- never one for the phantom 'stage' entry");
      assert.ok(
        checkboxes.every((c) => c.checked),
        "both real columns must start checked (visible), since the stale entry doesn't name either of them",
      );

      const statusCheckbox = Array.from(document.querySelectorAll(".columns-menu-item")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      )!.querySelector("input") as HTMLInputElement;
      fireEvent.click(statusCheckbox);

      await waitForCondition(() => document.querySelectorAll("thead th").length === 4);
      assert.doesNotMatch(
        document.querySelector("thead")!.textContent ?? "",
        /Status/,
        "Status must actually hide -- the phantom 'stage' entry must not make the guard think Status is the last visible column",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a "Filter by <field>" dropdown next to the search box,
 * scoped to whichever enum field the board view already uses (findBoardField
 * -- usually "status"/"stage"), so a long table can be narrowed to one
 * status without leaving table view. Renders with 3 records across 2
 * statuses, picks "won" from the new filter select, and confirms the table
 * narrows to exactly the matching row -- then confirms clearing the filter
 * (back to "All") restores every row, proving it's a live, reversible
 * filter and not a one-way destructive narrowing.
 */
test("EntityPanel's status filter dropdown narrows the table to matching records, and clearing it restores the rest", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
      { id: 3, name: "Initech", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const filterSelect = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      assert.ok(filterSelect, "expected a status filter dropdown in the toolbar");

      fireEvent.change(filterSelect, { target: { value: "won" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.match(document.querySelector("table tbody tr")!.textContent ?? "", /Globex/);

      fireEvent.change(filterSelect, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a relation field is just as fixed-value-space as an
 * enum -- its options are exactly the related entity's current records --
 * but had no filter dropdown at all, only the free-text search box
 * (which matches a relation by its resolved display label as a
 * substring, not an exact pick). Renders an Order entity with a
 * "courierId" relation field, 3 orders across 2 couriers plus one with no
 * courier assigned, and confirms a real filter dropdown appears with the
 * two couriers' real display labels (not raw ids), picking one narrows
 * the table to exactly that courier's orders, and clearing it restores
 * the rest -- the same reversible-filter contract the enum/boolean
 * filter above already has.
 */
test("EntityPanel's per-field filter offers a relation field too, with the related records' real display labels as options", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRecords: EntityRecord[] = [
      { id: 9, createdAt: "x", name: "Dana" },
      { id: 10, createdAt: "x", name: "Omer" },
    ];
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", item: "Pizza", courierId: 9 },
      { id: 2, createdAt: "x", item: "Sushi", courierId: 10 },
      { id: 3, createdAt: "x", item: "Burger", courierId: null },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRecords }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      await waitForCondition(() => document.querySelector(".entity-status-filter") !== null);
      const filterSelect = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      assert.ok(filterSelect, "expected a filter dropdown for the relation field once related records load");
      const optionLabels = Array.from(filterSelect.options).map((o) => o.textContent);
      assert.deepEqual(optionLabels.slice(1), ["Dana", "Omer"], "options must show the related records' real display labels, not raw ids");

      fireEvent.change(filterSelect, { target: { value: String(courierRecords[1].id) } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.match(document.querySelector("table tbody tr")!.textContent ?? "", /Sushi/, "picking a courier must narrow the table to exactly that courier's orders");

      fireEvent.change(filterSelect, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (738): isGroupableField/groupRecordsByField widened to
 * include a relation field too, mirroring the sibling "per-field filter"
 * fix directly above (round 721) -- same Order/Courier fixture. Confirms
 * the live "Group by" dropdown now offers "Courier" as an option, and that
 * grouping by it actually clusters the table by the related record's real
 * display label (not a raw id), with the order that has no courier
 * assigned landing in its own "(other)" bucket rather than being dropped.
 */
test("EntityPanel's 'Group by' dropdown also offers a relation field, clustering the table by the related record's real display label", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRecords: EntityRecord[] = [
      { id: 9, createdAt: "x", name: "Dana" },
      { id: 10, createdAt: "x", name: "Omer" },
    ];
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", item: "Pizza", courierId: 9 },
      { id: 2, createdAt: "x", item: "Sushi", courierId: 10 },
      { id: 3, createdAt: "x", item: "Burger", courierId: null },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRecords }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      await waitForCondition(() => document.querySelector(".entity-group-by") !== null);
      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      const optionLabels = Array.from(groupBySelect.options).map((o) => o.textContent);
      assert.ok(optionLabels.includes("Courier"), "the relation field must now appear as a 'Group by' option, not just enum/boolean fields");

      fireEvent.change(groupBySelect, { target: { value: "courierId" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 3);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      assert.deepEqual(
        headerRows.map((r) => r.textContent?.trim()),
        ["▾ Dana (1)", "▾ Omer (1)", "▾ Other (1)"],
        "must show one header per related record's real display label (not a raw id), in the related entity's own record order, plus a trailing 'other' bucket for the order with no courier assigned",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 779: the bulk-edit "Set field" picker used to exclude relation
 * fields entirely (it reused isInlineEditableField, written for the
 * single table cell's own space constraint, not this toolbar's full-width
 * FieldInput). Bulk-reassigning the SAME target record across many
 * selected rows (e.g. moving a batch of orders to a different courier) is
 * exactly as sensible as this feature's existing bulk-set of an
 * enum/boolean/date value. Confirms: the relation field now appears in
 * the picker, choosing it renders a REAL populated relation `<select>`
 * (not the old missing-props blank state), and clicking Apply sends the
 * chosen related record's own id to every selected record.
 */
test("EntityPanel's bulk-edit 'Set field' picker now offers a relation field, with a real picker, and applies the chosen related record's id to every selected record", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRecords: EntityRecord[] = [
      { id: 9, createdAt: "x", name: "Dana" },
      { id: 10, createdAt: "x", name: "Omer" },
    ];
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", item: "Pizza", courierId: null },
      { id: 2, createdAt: "x", item: "Sushi", courierId: null },
    ];
    const patchedBodies: Record<number, unknown> = {};
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRecords }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const patchMatch = /^\/api\/projects\/proj1\/entities\/Order\/(\d+)$/.exec(input);
      if (method === "PATCH" && patchMatch) {
        const id = Number(patchMatch[1]);
        const body = JSON.parse(init!.body as string);
        patchedBodies[id] = body;
        const record = store.find((r) => r.id === id)!;
        Object.assign(record, body);
        return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);

      const fieldPicker = document.querySelector(".bulk-edit-field-label select") as HTMLSelectElement;
      const pickerOptions = Array.from(fieldPicker.options).map((o) => o.textContent);
      assert.ok(pickerOptions.includes("Courier"), "the relation field must now appear in the bulk-edit 'Set field' picker");

      fireEvent.change(fieldPicker, { target: { value: "courierId" } });
      await waitForCondition(() => document.querySelector(".bulk-actions-bar .relation-field-input select") !== null);
      const relationSelect = document.querySelector(".bulk-actions-bar .relation-field-input select") as HTMLSelectElement;
      const relationOptionLabels = Array.from(relationSelect.options).map((o) => o.textContent);
      assert.deepEqual(
        relationOptionLabels.slice(1),
        ["Dana", "Omer"],
        "the bulk-edit relation picker must show the related records' real display labels, not raw ids or a blank/disabled select",
      );

      fireEvent.change(relationSelect, { target: { value: String(courierRecords[1].id) } });
      await waitForCondition(
        () => (document.querySelector(".bulk-actions-bar .relation-field-input select") as HTMLSelectElement | null)?.value === String(courierRecords[1].id),
      );
      const applyButton = Array.from(document.querySelectorAll(".bulk-actions-bar button")).find((b) => /Apply|החל/.test(b.textContent ?? ""))!;
      fireEvent.click(applyButton);

      await waitForCondition(() => Object.keys(patchedBodies).length === 2);
      assert.deepEqual(patchedBodies[1], { courierId: courierRecords[1].id }, "must PATCH the chosen courier's own id onto the first selected record");
      assert.deepEqual(patchedBodies[2], { courierId: courierRecords[1].id }, "must PATCH the exact same courier's id onto every other selected record too");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

const TASK_ENTITY: Entity = {
  name: "Task",
  label: "Task",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      enumValues: ["todo", "done"],
      enumLabels: { todo: "To do", done: "Done" },
    },
    {
      name: "priority",
      label: "Priority",
      type: "enum",
      required: true,
      enumValues: ["low", "high"],
      enumLabels: { low: "Low", high: "High" },
    },
  ],
};

function mockTaskRecordsFetch(store: EntityRecord[]) {
  return async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/entities/Task") {
      return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockTaskRecordsFetch: unexpected request ${input}`);
  };
}

/**
 * Regression test for a real bug found by round 286's Explore survey:
 * findBoardField (and, before this round, the toolbar's status filter that
 * reused it) only ever picks ONE enum field per entity -- so an entity with
 * two or more enum fields (here, both "Status" and "Priority") only ever
 * got a filter dropdown for whichever one field findBoardField happened to
 * pick, with no way to narrow the table by the other. The free-text search
 * box can't substitute: it matches every field as a substring (including
 * relations), so it can't target one specific field's exact value.
 * Confirms two independent filter dropdowns now render (one per qualifying
 * enum field), that each narrows the table on its own, and that both
 * active at once combine with AND (not just replace each other).
 */
test("EntityPanel renders one filter dropdown per qualifying enum field, not just one, and multiple active filters combine with AND", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Write report", status: "todo", priority: "low" },
      { id: 2, name: "Fix outage", status: "todo", priority: "high" },
      { id: 3, name: "Ship release", status: "done", priority: "high" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTaskRecordsFetch(store) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(EntityPanel, {
              projectId: "proj1",
              userId: "user1",
              entity: TASK_ENTITY,
              allEntities: [TASK_ENTITY],
              onEntityRenamed: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const filterSelects = document.querySelectorAll(".entity-status-filter") as NodeListOf<HTMLSelectElement>;
      assert.equal(filterSelects.length, 2, "expected one filter dropdown for each of Status and Priority, not just one");
      const [statusSelect, prioritySelect] = filterSelects;

      fireEvent.change(prioritySelect, { target: { value: "high" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.match(document.querySelector("table tbody")!.textContent ?? "", /Fix outage/);
      assert.match(document.querySelector("table tbody")!.textContent ?? "", /Ship release/);

      fireEvent.change(statusSelect, { target: { value: "done" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.match(
        document.querySelector("table tbody")!.textContent ?? "",
        /Ship release/,
        "with both filters active, only the row matching BOTH priority=high AND status=done must remain",
      );

      fireEvent.change(statusSelect, { target: { value: "" } });
      fireEvent.change(prioritySelect, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const TASK_WITH_BOOLEAN_ENTITY: Entity = {
  name: "Task",
  label: "Task",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      enumValues: ["todo", "done"],
      enumLabels: { todo: "To do", done: "Done" },
    },
    { name: "isUrgent", label: "Is Urgent", type: "boolean", required: false },
  ],
};

/**
 * Regression test for a real bug found by a round-400 Explore survey:
 * isGroupableField (entityFormatting.ts) already treats enum and boolean
 * fields as the same "small fixed value space" category for table
 * grouping, but the toolbar's own per-field filter dropdown (round 286)
 * grew out of findBoardField's enum-only scope and never widened to match
 * -- a boolean field like "Is Urgent" could be grouped by, but never used
 * to filter the table down to just the true (or false) rows. Confirms a
 * filter dropdown now renders for the boolean field too, offering Yes/No
 * options (not raw true/false), that it actually narrows the table, and
 * that it combines with the enum filter via AND just like round 286's own
 * two-enum-field test already proves for two enum fields.
 */
test("EntityPanel renders a filter dropdown for a boolean field too, offering Yes/No, and it combines with an enum filter via AND", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Write report", status: "todo", isUrgent: false },
      { id: 2, name: "Fix outage", status: "todo", isUrgent: true },
      { id: 3, name: "Ship release", status: "done", isUrgent: true },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTaskRecordsFetch(store) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(EntityPanel, {
              projectId: "proj1",
              userId: "user1",
              entity: TASK_WITH_BOOLEAN_ENTITY,
              allEntities: [TASK_WITH_BOOLEAN_ENTITY],
              onEntityRenamed: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const filterSelects = document.querySelectorAll(".entity-status-filter") as NodeListOf<HTMLSelectElement>;
      assert.equal(filterSelects.length, 2, "expected one filter dropdown for Status and one for the boolean Is Urgent field");
      const [statusSelect, urgentSelect] = filterSelects;
      assert.match(urgentSelect.textContent ?? "", /Yes/, "boolean filter options must read Yes/No, not raw true/false");
      assert.match(urgentSelect.textContent ?? "", /No/);
      assert.doesNotMatch(urgentSelect.textContent ?? "", /\btrue\b|\bfalse\b/i, "must never show the raw boolean value as an option label");

      fireEvent.change(urgentSelect, { target: { value: "true" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.match(document.querySelector("table tbody")!.textContent ?? "", /Fix outage/);
      assert.match(document.querySelector("table tbody")!.textContent ?? "", /Ship release/);

      fireEvent.change(statusSelect, { target: { value: "done" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.match(
        document.querySelector("table tbody")!.textContent ?? "",
        /Ship release/,
        "with both filters active, only the row matching BOTH isUrgent=true AND status=done must remain",
      );

      fireEvent.change(urgentSelect, { target: { value: "false" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 0);

      fireEvent.change(statusSelect, { target: { value: "" } });
      fireEvent.change(urgentSelect, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a boolean field's table cell rendered as a bare ✓ or
 * – glyph with no aria-label -- unlike every other field type Cell renders
 * (an enum's real label text, a formatted date/number, a relation's
 * resolved label), this glyph IS the cell's only content, so a screen
 * reader got nothing from it at all. Confirms both the true and false
 * cells now carry a real, translated aria-label (reusing the same
 * "Yes"/"No" strings the filter dropdown and group-by header already use),
 * not just that the glyph itself still renders.
 */
test("EntityPanel's boolean table cells carry a real aria-label, not just a bare glyph with no accessible text", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Write report", status: "todo", isUrgent: false },
      { id: 2, name: "Fix outage", status: "todo", isUrgent: true },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTaskRecordsFetch(store) as typeof fetch;
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(EntityPanel, {
              projectId: "proj1",
              userId: "user1",
              entity: TASK_WITH_BOOLEAN_ENTITY,
              allEntities: [TASK_WITH_BOOLEAN_ENTITY],
              onEntityRenamed: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const rows = document.querySelectorAll("table tbody tr");
      const falseRow = Array.from(rows).find((r) => /Write report/.test(r.textContent ?? ""))!;
      const trueRow = Array.from(rows).find((r) => /Fix outage/.test(r.textContent ?? ""))!;

      const trueCell = trueRow.querySelector(".bool-yes");
      assert.ok(trueCell, "expected the true cell's own ✓ glyph span to render");
      assert.equal(trueCell!.getAttribute("aria-label"), "Yes", "a true boolean cell must carry a real 'Yes' aria-label, not just the bare glyph");

      const falseCell = falseRow.querySelector('span[aria-label="No"]');
      assert.ok(falseCell, "expected the false cell's own – glyph span to carry a real 'No' aria-label, not just the bare glyph");
      assert.equal(falseCell!.textContent, "–", "the labeled span must still be the real – glyph, not some other element");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the toolbar's real record count (visibleRecords.length
 * vs records.length -- both already computed, neither ever shown) had no
 * way to tell a user how many records actually matched a search versus how
 * many exist in total. Confirms the real count renders, updates live once
 * the search box actually narrows the results, and switches phrasing back
 * to the plain "N records" form once the search is cleared again -- not
 * just that formatEntityRecordCount itself is correct in isolation (see
 * entityFormatting.test.ts), but that it's actually wired into the live
 * toolbar and reacts to a real user typing.
 */
test("EntityPanel's toolbar shows a live 'shown of total' record count that updates as the search narrows the table", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
      { id: 3, name: "Initech", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const countEl = document.querySelector(".entity-record-count");
      assert.ok(countEl, "expected a record count element in the toolbar");
      assert.equal(countEl!.textContent, "3 records", "unfiltered must read as a plain count, not '3 of 3 records'");

      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "Globex" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.equal(
        document.querySelector(".entity-record-count")!.textContent,
        "1 of 3 records",
        "once search narrows the table, the count must show shown-of-total, not just the unfiltered total",
      );

      fireEvent.change(searchBox, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal(document.querySelector(".entity-record-count")!.textContent, "3 records");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the search box already narrowed the table down to
 * matching rows, but gave no clue *where* within a row's own text the
 * match actually was -- a real everyday annoyance the moment a search
 * term is short/common. Confirms typing into the real search box wraps
 * the real matched substring in a real `<mark class="search-match">`
 * inside the table (both for a plain text field and for an enum's own
 * translated label), that non-matching rows are simply filtered out as
 * before, and that clearing the search removes the highlight along with
 * restoring the rest of the rows.
 */
test("EntityPanel's search box highlights the matched text within each visible cell, for both text and enum fields", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Dana Levi", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "dana" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const row = document.querySelector("table tbody tr")!;
      const mark = row.querySelector("mark.search-match");
      assert.ok(mark, "the matched substring must be wrapped in a real <mark class=\"search-match\">");
      assert.equal(mark!.textContent, "Dana", "the highlighted text must preserve the record's own original casing");
      assert.equal(row.textContent?.includes("Dana Levi"), true, "the rest of the cell's own text must still render around the highlight");

      fireEvent.change(searchBox, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.equal(document.querySelector("mark.search-match"), null, "clearing the search must remove the highlight");

      // An enum field's own translated label gets highlighted too, not
      // just plain text fields.
      fireEvent.change(searchBox, { target: { value: "Won" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      const enumMark = document.querySelector(".badge mark.search-match");
      assert.ok(enumMark, "an enum field's own translated label must be highlighted too");
      assert.equal(enumMark!.textContent, "Won");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: every record has always carried a real, server-
 * assigned `createdAt` (repository.ts's insertRecord always stamps one),
 * but the table never showed it anywhere. Confirms the built-in "Created"
 * column renders each record's own real timestamp (not blank, not the
 * same value for every row), and that clicking its header genuinely
 * re-sorts the table by that real data -- the same sortRecords/toggleSort
 * machinery the entity's own field columns already use, just pointed at
 * "createdAt" instead of a spec field.
 */
test("EntityPanel's table view shows each record's own real 'Created' timestamp, and its header sorts the table by it", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new", createdAt: "2026-01-01T09:00:00.000Z" },
      { id: 2, name: "Globex", status: "won", createdAt: "2026-03-01T09:00:00.000Z" },
      { id: 3, name: "Initech", status: "lost", createdAt: "2026-02-01T09:00:00.000Z" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const createdCells = Array.from(document.querySelectorAll("table tbody tr")).map(
        (row) => row.querySelector(".created-at-cell")!.textContent,
      );
      assert.ok(
        createdCells.every((c) => c && c.length > 0),
        "every row must show a real, non-blank Created value",
      );
      assert.equal(new Set(createdCells).size, 3, "each row's real distinct createdAt must render as a distinct value");

      const createdHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Created/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      assert.ok(createdHeader, "expected a sortable 'Created' column header");
      fireEvent.click(createdHeader);

      await waitForCondition(() => {
        const names = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
        return /Acme Corp/.test(names[0]) && /Initech/.test(names[1]) && /Globex/.test(names[2]);
      });
      const namesAfterAscSort = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
      assert.ok(
        /Acme Corp/.test(namesAfterAscSort[0]) && /Initech/.test(namesAfterAscSort[1]) && /Globex/.test(namesAfterAscSort[2]),
        "ascending Created sort must order Acme (Jan) before Initech (Feb) before Globex (Mar), by real createdAt, not declaration order",
      );

      fireEvent.click(createdHeader);
      await waitForCondition(() => {
        const names = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
        return /Globex/.test(names[0]) && /Initech/.test(names[1]) && /Acme Corp/.test(names[2]);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Confirms the board view's move-between-columns interaction is wired
 * correctly end to end: changing a card's own status <select> calls
 * handleMove -> updateRecord (a real PATCH against the mock store) ->
 * refresh() (a real re-fetch), and the record then renders under its NEW
 * column, not its old one, once that round trip settles. A function-
 * extraction test can check handleMove's arguments, but can't observe this
 * two-phase state transition (PATCH, then a re-render driven by a second
 * fetch) actually reflected back in the live DOM the way a real user would
 * see it.
 */
test("EntityPanel's board view moves a card to its new column once the status change round-trips through the API", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);

      const columnsBefore = document.querySelectorAll(".board-column");
      assert.equal(columnsBefore[0].querySelectorAll(".board-card").length, 1, "the card must start in the 'new' column (index 0)");
      assert.equal(columnsBefore[1].querySelectorAll(".board-card").length, 0, "the 'won' column (index 1) must start empty");

      const moveSelect = document.querySelector(".board-card-move") as HTMLSelectElement;
      fireEvent.change(moveSelect, { target: { value: "won" } });

      await waitForCondition(() => store[0].status === "won");
      await waitForCondition(() => {
        const columns = document.querySelectorAll(".board-column");
        return columns[0].querySelectorAll(".board-card").length === 0 && columns[1].querySelectorAll(".board-card").length === 1;
      });

      const columnsAfter = document.querySelectorAll(".board-column");
      assert.equal(columnsAfter[0].querySelectorAll(".board-card").length, 0, "the 'new' column must be empty after the move");
      assert.equal(columnsAfter[1].querySelectorAll(".board-card").length, 1, "the 'won' column must now hold the moved card");
      assert.equal(
        document.querySelector("p.error") === null,
        true,
        "a successful move must not leave an error banner showing",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a failed inline-cell-edit PATCH used to show only a
 * generic error banner near the top of the panel (far from the actual
 * table row, possibly scrolled out of view entirely), with zero in-place
 * indication of which specific record the failure was even about -- the
 * cell itself just silently reverted to its old value. Confirms the
 * failing row now carries its own real "record-row-move-error" marker
 * class, in addition to (not instead of) the existing top banner.
 */
test("EntityPanel marks the specific table row with a move-error indicator when an inline-cell-edit PATCH fails", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "Server exploded" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const row = document.querySelector("table tbody tr") as HTMLTableRowElement;
      assert.equal(row.classList.contains("record-row-move-error"), false, "the row must start with no error marker");

      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement;
      fireEvent.doubleClick(nameCell);
      const input = nameCell.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Acme Corporation" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitForCondition(() => document.querySelector("p.error") !== null);
      assert.ok(document.querySelector("p.error"), "the existing top error banner must still appear, unchanged");
      assert.equal(
        row.classList.contains("record-row-move-error"),
        true,
        "the specific row whose edit failed must now carry its own move-error marker, not just the far-away banner",
      );
      assert.equal(
        document.querySelectorAll("table tbody td")[1]?.textContent,
        "Acme Corp",
        "a failed edit must leave the cell showing its original, untouched value",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The board-view sibling of the inline-edit test above: a failed
 * column-move PATCH used to leave the dragged/moved card with zero visual
 * cue of its own -- the card just silently stayed where it was, with only
 * the same far-away banner as any other failure. Confirms the specific
 * card now carries its own "board-card-move-error" marker class.
 */
test("EntityPanel marks the specific board card with a move-error indicator when a column-move PATCH fails", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "Server exploded" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);

      const card = document.querySelector(".board-card") as HTMLElement;
      assert.equal(card.classList.contains("board-card-move-error"), false, "the card must start with no error marker");

      const moveSelect = document.querySelector(".board-card-move") as HTMLSelectElement;
      fireEvent.change(moveSelect, { target: { value: "won" } });

      await waitForCondition(() => document.querySelector("p.error") !== null);
      assert.equal(
        document.querySelector(".board-card")!.classList.contains("board-card-move-error"),
        true,
        "the specific card whose move failed must now carry its own move-error marker",
      );
      assert.equal(store[0].status, "new", "a failed move must leave the mock server's own record genuinely unchanged");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: onRecordCountChange exists so the entity-tabs strip
 * (App.tsx) can show a live record-count badge without threading a
 * callback through every individual mutation handler -- it's driven by a
 * single effect keyed on `records.length`, so it should fire once for the
 * initial empty state, once more once the real records load, and again
 * whenever a mutation (here, a delete) actually changes that count.
 */
test("EntityPanel's onRecordCountChange reports the real record count on load and again after a delete changes it", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    const calls: [string, number][] = [];
    try {
      renderEntityPanel({ onRecordCountChange: (entityName: string, count: number) => calls.push([entityName, count]) });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      // The passive effect driving this callback runs on the next tick after
      // the records-loaded render commits (it fires outside any user-event
      // act() wrapper, unlike the click below) -- wait on the callback's own
      // output, not just the DOM, so this isn't racing that one extra tick.
      await waitForCondition(() => calls.at(-1)?.[1] === 2);

      assert.deepEqual(
        calls.at(-1),
        ["Deal", 2],
        "once the real records have loaded, the callback must report the actual count -- not the initial empty state",
      );

      fireEvent.click(document.querySelectorAll(".danger")[0] as HTMLButtonElement);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.deepEqual(
        calls.at(-1),
        ["Deal", 1],
        "deleting a record must report the new, decremented count -- this is the same `records` state every mutation already funnels through",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

const APPOINTMENT_ENTITY: Entity = {
  name: "Appointment",
  label: "Appointment",
  fields: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "date", label: "Date", type: "date", required: true },
  ],
};

function isoDateToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function mockListRecordsFetch(store: EntityRecord[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/projects/proj1/entities/Appointment") {
      return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockListRecordsFetch: unexpected request ${method} ${input}`);
  };
}

function renderAppointmentPanel(extraProps: Record<string, unknown> = {}) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(EntityPanel, {
          projectId: "proj1",
          userId: "user1",
          entity: APPOINTMENT_ENTITY,
          allEntities: [APPOINTMENT_ENTITY],
          onEntityRenamed: () => {},
          ...extraProps,
        }),
      ),
    ),
  );
}

/**
 * Real-DOM coverage for the calendar view's own "+N more" overflow -- the
 * other half of the "table/board/calendar views" candidate this round
 * follows up on after the board-view tests above. CalendarView's own doc
 * comment promises "a '+N more' overflow instead of an ever-growing cell";
 * this renders a real day with 4 records on it (Appointment has a "date"
 * field, so findDateField picks it and the calendar toggle appears) and
 * confirms exactly 3 chips render plus the overflow count for the 4th,
 * rather than either silently dropping the 4th record or growing the cell
 * without bound.
 */
test("EntityPanel's calendar view shows at most 3 record chips per day, with a '+N more' overflow for the rest", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [
      { id: 1, title: "A", date: today },
      { id: 2, title: "B", date: today },
      { id: 3, title: "C", date: today },
      { id: 4, title: "D", date: today },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length > 0);

      const todayDayNumber = String(new Date().getDate());
      const dayCell = [...document.querySelectorAll(".calendar-day:not(.calendar-day-outside)")].find(
        (cell) => cell.querySelector(".calendar-day-number")?.textContent === todayDayNumber,
      );
      assert.ok(dayCell, "today's cell must render in the current month's grid");
      assert.equal(
        dayCell!.querySelectorAll(".calendar-record-chip").length,
        3,
        "at most 3 chips must render even though 4 records land on this day",
      );
      const more = dayCell!.querySelector(".calendar-record-more");
      assert.ok(more, "a '+N more' overflow indicator must render for the 4th record");
      assert.match(more!.textContent ?? "", /1/, "the overflow count must reflect exactly the 1 record not shown as a chip");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 778: for an entity with no name/title/text field (e.g. a
 * "CheckIn"/"Attendance"-shaped log entity with just a date and a
 * boolean), the calendar day-chip used to render the raw stored value
 * with zero type awareness -- "true"/"false" lowercase instead of this
 * codebase's own uniform "TRUE"/"FALSE" convention. Confirms the real,
 * wired-up render (not just calendarChipLabelValue's own pure-function
 * coverage in entityFormatting.test.ts) shows the correct uppercase form.
 */
test("EntityPanel's calendar day-chip renders a boolean label field as TRUE/FALSE, for an entity with no name/title/text field", async () => {
  await withJsdom(async () => {
    const checkInEntity: Entity = {
      name: "CheckIn",
      label: "CheckIn",
      fields: [
        { name: "date", label: "Date", type: "date", required: true },
        { name: "confirmed", label: "Confirmed", type: "boolean", required: false },
      ],
    };
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, date: today, confirmed: false }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/CheckIn") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: checkInEntity, allEntities: [checkInEntity] });
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      const chip = document.querySelector(".calendar-record-chip")!;
      assert.equal(chip.textContent, "FALSE", "a boolean false value must render as uppercase FALSE, not lowercase false");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the calendar view's day cells never distinguished
 * "today" from any other day in the currently-viewed month -- a user
 * scanning the grid had to mentally compute which cell was "now". Confirms
 * exactly one day cell in the current month's grid carries the
 * calendar-day-today class (real today's date, by day number), and that no
 * other in-month cell carries it.
 */
test("EntityPanel's calendar view marks exactly today's day cell with calendar-day-today, and no other day in the current month", async () => {
  await withJsdom(async () => {
    // The toolbar (and with it the view-mode toggle) only renders once
    // records.length > 0 -- an entirely empty store falls into EntityPanel's
    // own "no records yet" empty-state branch instead, per
    // EntityPanel.tsx:1763. One unrelated record (on an arbitrary date) is
    // enough to reach the real calendar grid without affecting which cell
    // this test cares about, which is driven purely by the real system date.
    const store: EntityRecord[] = [{ id: 1, title: "Unrelated", date: "2020-01-01" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-day").length > 0);

      const todayDayNumber = String(new Date().getDate());
      const inMonthCells = [...document.querySelectorAll(".calendar-day:not(.calendar-day-outside)")];
      const todayCells = inMonthCells.filter((cell) => cell.classList.contains("calendar-day-today"));
      assert.equal(todayCells.length, 1, "exactly one in-month cell must be marked as today");
      assert.equal(
        todayCells[0].querySelector(".calendar-day-number")?.textContent,
        todayDayNumber,
        "the marked cell must be the one showing today's real day-of-month number",
      );

      const otherMarked = inMonthCells.filter(
        (cell) => cell !== todayCells[0] && cell.classList.contains("calendar-day-today"),
      );
      assert.equal(otherMarked.length, 0, "no other day cell may carry calendar-day-today");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for a real bug found by this round's Explore survey: the
 * "+N more" overflow label above was rendered as an inert <span> with no
 * click handler of its own. Since the day cell it sits inside is itself
 * wired to onDayClick (open a blank create-record form for that date),
 * clicking the "+N more" text did NOT reveal the hidden records it names --
 * it silently opened an unrelated blank form instead. The only way to reach
 * record #4+ on a busy day was to abandon Calendar view for Table view.
 * Fixed by turning "+N more" into a real button that toggles showing every
 * record for that day (with a "Show less" button to collapse back), while
 * stopping propagation so the day cell's own onDayClick never also fires.
 * This test proves both halves: clicking reveals the previously-hidden 4th
 * chip WITHOUT opening the create-record form, and clicking "Show less"
 * collapses back to 3 chips + the overflow button.
 */
test("EntityPanel's calendar view '+N more' button reveals every hidden record on that day, without opening a blank create-record form", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [
      { id: 1, title: "A", date: today },
      { id: 2, title: "B", date: today },
      { id: 3, title: "C", date: today },
      { id: 4, title: "D", date: today },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length > 0);

      const todayDayNumber = String(new Date().getDate());
      const dayCell = [...document.querySelectorAll(".calendar-day:not(.calendar-day-outside)")].find(
        (cell) => cell.querySelector(".calendar-day-number")?.textContent === todayDayNumber,
      );
      assert.ok(dayCell, "today's cell must render in the current month's grid");

      // First open one record for editing, the same way the existing
      // chip-click test above does -- this leaves the persistent
      // .record-form's title input holding that record's real title ("A").
      // The form is ALWAYS rendered on screen (there is no separate blank
      // vs. edit form), so the only way to prove the overflow click did NOT
      // also fire the day cell's own onClick underneath it (which would
      // reset the form to a genuinely blank one, per startCreateForDate) is
      // to check that this title survives the "+N more" click unchanged.
      const firstChip = dayCell!.querySelector(".calendar-record-chip") as HTMLButtonElement;
      fireEvent.click(firstChip);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "A");

      const more = dayCell!.querySelector(".calendar-record-more") as HTMLButtonElement;
      assert.equal(more.tagName, "BUTTON", "the overflow label must be a real, clickable button, not an inert span");

      fireEvent.click(more);
      assert.equal(
        dayCell!.querySelectorAll(".calendar-record-chip").length,
        4,
        "clicking '+N more' must reveal all 4 records as chips, not just the original 3",
      );
      assert.equal(
        (document.querySelector('.record-form input[type="text"]') as HTMLInputElement).value,
        "A",
        "clicking the overflow button must NOT also fire the day cell's own onClick and reset the form to a blank create form",
      );

      const showLess = dayCell!.querySelector(".calendar-record-more") as HTMLButtonElement;
      fireEvent.click(showLess);
      assert.equal(
        dayCell!.querySelectorAll(".calendar-record-chip").length,
        3,
        "clicking 'Show less' must collapse back down to 3 chips",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Confirms clicking a calendar day's record chip actually opens that
 * record for editing (CalendarView's onEdit prop is wired to EntityPanel's
 * own startEdit) -- the same real-DOM/real-click contract this session's
 * AuthScreen/BuildProgress/board-view tests already established for other
 * components, applied to the one interactive element the calendar view has
 * that the table/board views don't.
 */
test("EntityPanel's calendar view opens the clicked record for editing, with the form pre-filled", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      const chip = document.querySelector(".calendar-record-chip") as HTMLButtonElement;
      assert.equal(chip.textContent, "Dana's appointment");
      fireEvent.click(chip);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Dana's appointment");

      const titleInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const dateInput = document.querySelector('.record-form input[type="date"]') as HTMLInputElement;
      assert.equal(titleInput.value, "Dana's appointment", "clicking the chip must pre-fill the form with that record's own title");
      assert.equal(dateInput.value, today, "clicking the chip must pre-fill the form with that record's own date");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 697: CalendarView's caller already no-ops onEdit/onDayClick/
 * onReschedule for a read-only viewer, but every affordance inside the
 * calendar itself (day-cell click/keyboard/drag-drop, chip drag/click)
 * stayed fully "live" regardless -- the exact same affordance-vs-callback
 * mismatch round 695 fixed for the table view's inline-edit cells and
 * round 696 fixed for the pre-build spec review screen, just never ported
 * to this third component. Confirms a read-only render has no clickable/
 * draggable day cells and a disabled, non-draggable record chip, and that
 * clicking or dropping on either does nothing at all.
 */
test("EntityPanel's calendar view offers no clickable or draggable affordance at all when readOnly=true", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel({ readOnly: true });
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      assert.equal(
        document.querySelectorAll(".calendar-day-clickable").length === 0,
        true,
        "a read-only calendar must have no clickable day cells at all",
      );

      const chip = document.querySelector(".calendar-record-chip") as HTMLButtonElement;
      assert.equal(chip.disabled, true, "a read-only calendar's record chip must be disabled");
      assert.equal(chip.draggable, false, "a read-only calendar's record chip must not be draggable");

      fireEvent.click(chip);
      assert.equal(
        document.querySelector(".record-form") === null,
        true,
        "clicking a disabled record chip in a read-only calendar must never open the edit form",
      );

      const anyDayCell = document.querySelector(".calendar-day:not(.calendar-day-outside)") as HTMLElement;
      fireEvent.click(anyDayCell);
      assert.equal(
        document.querySelector(".record-form") === null,
        true,
        "clicking a day cell in a read-only calendar must never open the create form",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: clicking an EMPTY day cell (not a record chip) now
 * pre-fills the create form's own date field with that day, so adding an
 * appointment for a specific date doesn't require scrolling up and typing
 * the date in by hand. Confirms it fills the date field with the real
 * clicked day (not today's date, not the record's own date) and leaves the
 * title field genuinely blank (a real new record, not an edit), and that
 * clicking a record chip still only edits that record without ALSO
 * triggering the day cell's own click handler underneath it.
 */
test("EntityPanel's calendar view pre-fills the create form's date field when an empty day is clicked, without also firing when a record chip is clicked", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      // Clicking the record chip must only open that record for editing --
      // must NOT also trigger the day cell's own onClick underneath it.
      const chip = document.querySelector(".calendar-record-chip") as HTMLButtonElement;
      fireEvent.click(chip);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Dana's appointment");
      const titleAfterChipClick = (document.querySelector('.record-form input[type="text"]') as HTMLInputElement).value;
      assert.equal(titleAfterChipClick, "Dana's appointment", "clicking the chip must still only edit that record");

      // Now click an empty day (a real day cell with no records on it, in
      // the current month) and confirm the form switches to a genuinely
      // blank create form pre-filled with THAT day's own date.
      const emptyDayCells = Array.from(document.querySelectorAll(".calendar-day-clickable")).filter(
        (el) => el.querySelectorAll(".calendar-record-chip").length === 0,
      );
      assert.ok(emptyDayCells.length > 0, "expected at least one clickable empty day cell in the current month");
      const emptyDay = emptyDayCells[0] as HTMLElement;
      const clickedDayNumber = emptyDay.querySelector(".calendar-day-number")!.textContent;

      fireEvent.click(emptyDay);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "");

      const titleInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const dateInput = document.querySelector('.record-form input[type="date"]') as HTMLInputElement;
      assert.equal(titleInput.value, "", "clicking an empty day must start a genuinely NEW record, not leave the previous edit's title behind");
      assert.ok(dateInput.value.length > 0, "the date field must be pre-filled, not left blank");
      const clickedDayFromDate = String(Number(dateInput.value.split("-")[2]));
      assert.equal(clickedDayFromDate, clickedDayNumber, "the pre-filled date must match the actual day cell that was clicked");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the calendar day cell was a plain, non-focusable
 * `<div onClick=...>` -- the ONLY way to reach "create a record on this
 * day" (onDayClick) for a keyboard-only user, unlike every other
 * interactive element in this app (table rows, board columns, record
 * chips) which already has real keyboard support. Added tabIndex,
 * role="button", a real aria-label, and an Enter/Space onKeyDown that
 * calls the same onDayClick the mouse click already does. Confirms both
 * halves: (1) focusing an empty day cell and pressing Enter opens the
 * blank create form pre-filled with that day's date, exactly like a
 * real click would, and (2) pressing Enter on a focused record CHIP
 * inside a day cell must only fire that chip's own click (via real
 * keyboard activation), never ALSO bubble up and fire the day cell's
 * own onDayClick underneath it -- the same bubbling hazard the chip's
 * mouse-click handler already guards against with stopPropagation.
 */
test("EntityPanel's calendar day cell is keyboard-focusable and Enter/Space opens the create form, without a focused chip's own Enter also firing the day's onClick", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      const emptyDayCells = Array.from(document.querySelectorAll(".calendar-day-clickable")).filter(
        (el) => el.querySelectorAll(".calendar-record-chip").length === 0,
      );
      assert.ok(emptyDayCells.length > 0, "expected at least one clickable empty day cell in the current month");
      const emptyDay = emptyDayCells[0] as HTMLElement;
      assert.equal(emptyDay.getAttribute("tabindex"), "0", "a clickable day cell must be keyboard-focusable");
      assert.equal(emptyDay.getAttribute("role"), "button", "a clickable day cell must expose role=button to assistive tech");
      assert.ok(emptyDay.getAttribute("aria-label"), "a clickable day cell must have a real aria-label");
      const clickedDayNumber = emptyDay.querySelector(".calendar-day-number")!.textContent;

      fireEvent.keyDown(emptyDay, { key: "Enter" });
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "");

      const dateInput = document.querySelector('.record-form input[type="date"]') as HTMLInputElement;
      assert.ok(dateInput.value.length > 0, "Enter on the day cell must pre-fill the date field, exactly like a real click");
      assert.equal(
        String(Number(dateInput.value.split("-")[2])),
        clickedDayNumber,
        "the pre-filled date must match the actual day cell Enter was pressed on",
      );

      // Now open the existing record for editing, then focus its chip and
      // press Enter there -- the keydown must never bubble up and fire the
      // day cell's own onDayClick, which would silently reset the form to
      // a blank one for this day instead of leaving the chip's own edit.
      const chip = document.querySelector(".calendar-record-chip") as HTMLButtonElement;
      fireEvent.click(chip);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Dana's appointment");

      fireEvent.keyDown(chip, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector('.record-form input[type="text"]') as HTMLInputElement).value,
        "Dana's appointment",
        "Enter on a focused record chip must never bubble up and reset the form via the day cell's own onDayClick",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the calendar view's own record chips were previously
 * only editable by opening the full form -- moving an appointment to a
 * different day meant clicking the chip, changing the date field by hand,
 * and saving. A real calendar is expected to let you drag a card straight
 * onto the day you want, the same real HTML5 drag-and-drop the board
 * view's own card-to-column move already uses (handleCardDrop), just
 * addressed by a day's own formatted date instead of a board enum value.
 * Drives real dragstart/dragover/drop events (the same minimal DataTransfer
 * mock the board-view drag test above uses) to prove: dragging a chip onto
 * a genuinely different day calls the real PATCH exactly once with that
 * day's own "YYYY-MM-DD" value and moves the chip in the live DOM, while
 * dropping it back onto the SAME day it's already on is a real no-op --
 * never an extra PATCH.
 */
test("EntityPanel's calendar view reschedules a record via a real drag-and-drop onto a different day, and dropping it back on its own day is a no-op", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    let patchCount = 0;
    let lastPatchBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Appointment") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const patchMatch = /^\/api\/projects\/proj1\/entities\/Appointment\/(\d+)$/.exec(input);
      if (method === "PATCH" && patchMatch) {
        patchCount += 1;
        const id = Number(patchMatch[1]);
        const record = store.find((r) => r.id === id)!;
        lastPatchBody = JSON.parse(init!.body as string);
        Object.assign(record, lastPatchBody);
        return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }

      const todaysDayCell = document.querySelector(".calendar-record-chip")!.closest(".calendar-day") as HTMLElement;
      const chip = document.querySelector(".calendar-record-chip") as HTMLButtonElement;

      // Dropping the chip back onto the day it's already on must be a real no-op.
      const sameDayDataTransfer = makeDataTransfer();
      fireEvent.dragStart(chip, { dataTransfer: sameDayDataTransfer });
      fireEvent.dragOver(todaysDayCell, { dataTransfer: sameDayDataTransfer });
      fireEvent.drop(todaysDayCell, { dataTransfer: sameDayDataTransfer });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(patchCount, 0, "dropping a chip back on the day it's already on must never call the real PATCH endpoint");

      // Now a real move: drag onto a genuinely different, empty day in the current month.
      const emptyDayCells = Array.from(document.querySelectorAll(".calendar-day-clickable")).filter(
        (el) => el.querySelectorAll(".calendar-record-chip").length === 0,
      );
      assert.ok(emptyDayCells.length > 0, "expected at least one empty day cell to drop onto");
      const targetDay = emptyDayCells[0] as HTMLElement;

      const moveDataTransfer = makeDataTransfer();
      fireEvent.dragStart(chip, { dataTransfer: moveDataTransfer });
      fireEvent.dragOver(targetDay, { dataTransfer: moveDataTransfer });
      assert.ok(
        targetDay.classList.contains("calendar-day-drag-over"),
        "dragging over a day must show real drag-over feedback",
      );
      fireEvent.drop(targetDay, { dataTransfer: moveDataTransfer });

      await waitForCondition(() => patchCount === 1);
      assert.equal(
        targetDay.classList.contains("calendar-day-drag-over"),
        false,
        "drag-over feedback must clear once the drop completes",
      );
      const targetDayNumber = targetDay.querySelector(".calendar-day-number")!.textContent;
      const patchedDay = String(Number((lastPatchBody as unknown as { date: string }).date.split("-")[2]));
      assert.equal(patchedDay, targetDayNumber, "the real PATCH must carry the actual dropped-on day's own date");

      await waitForCondition(() => targetDay.querySelectorAll(".calendar-record-chip").length === 1);
      assert.equal(
        todaysDayCell.querySelectorAll(".calendar-record-chip").length,
        0,
        "the chip must be gone from its original day once it's been rescheduled",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The calendar-view sibling of the inline-edit/board-move tests above: a
 * failed reschedule-drag PATCH used to leave the dragged chip with zero
 * visual cue -- it just silently stayed on its original day. Confirms the
 * specific chip now carries its own "calendar-record-chip-move-error"
 * marker class.
 */
test("EntityPanel marks the specific calendar chip with a move-error indicator when a reschedule-drag PATCH fails", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Appointment") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify({ error: "Server exploded" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 1);

      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }

      const chip = document.querySelector(".calendar-record-chip") as HTMLButtonElement;
      assert.equal(chip.classList.contains("calendar-record-chip-move-error"), false, "the chip must start with no error marker");

      const emptyDayCells = Array.from(document.querySelectorAll(".calendar-day-clickable")).filter(
        (el) => el.querySelectorAll(".calendar-record-chip").length === 0,
      );
      const targetDay = emptyDayCells[0] as HTMLElement;
      const dataTransfer = makeDataTransfer();
      fireEvent.dragStart(chip, { dataTransfer });
      fireEvent.dragOver(targetDay, { dataTransfer });
      fireEvent.drop(targetDay, { dataTransfer });

      await waitForCondition(() => document.querySelector("p.error") !== null);
      assert.equal(
        document.querySelector(".calendar-record-chip")!.classList.contains("calendar-record-chip-move-error"),
        true,
        "the specific chip whose reschedule failed must now carry its own move-error marker",
      );
      assert.equal(
        document.querySelectorAll(".calendar-record-chip").length,
        1,
        "a failed reschedule must leave the chip on its original day, not move it or duplicate it",
      );
      assert.equal(store[0].date, today, "a failed reschedule must leave the mock server's own record genuinely unchanged");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Real-DOM coverage for the calendar view's new "Today" button: before this
 * round there was no quick way back to the current month once you'd
 * navigated away with prev/next -- you had to click "prev" or "next"
 * however many times it took, one month at a time. Confirms the button
 * starts disabled (already on the current month), becomes enabled and
 * actually navigates the grid back to the current month's label after
 * clicking "next" twice, and returns to disabled once there.
 */
test("EntityPanel's calendar view 'Today' button is disabled on the current month, and navigates back to it after paging away", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelector(".calendar-month-label") !== null);

      const todayBtn = document.querySelector(".calendar-today-btn") as HTMLButtonElement;
      const monthLabel = () => document.querySelector(".calendar-month-label")!.textContent;
      const currentMonthLabel = monthLabel();
      assert.equal(todayBtn.disabled, true, "the Today button must start disabled -- the calendar already shows the current month");

      // Selected by aria-label rather than a positional button index --
      // the month label became its own clickable button in a later round
      // (to open the month/year jump picker), which shifted what used to
      // be the 3rd <button> in .calendar-nav from "next" to the label.
      const nextBtn = document.querySelector('[aria-label="Next month"]') as HTMLButtonElement;
      fireEvent.click(nextBtn);
      fireEvent.click(nextBtn);
      await waitForCondition(() => monthLabel() !== currentMonthLabel);
      assert.equal(todayBtn.disabled, false, "paging away from the current month must enable the Today button");

      fireEvent.click(todayBtn);
      await waitForCondition(() => monthLabel() === currentMonthLabel);
      assert.equal(todayBtn.disabled, true, "clicking Today must return to the current month and disable itself again");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: reaching a date more than a couple of months away (a
 * rental due in 11 months, a historical record from 2 years back) meant
 * clicking the prev/next chevron that many times -- the month label was
 * static, inert text with no way to jump directly to an arbitrary month/
 * year. Confirms clicking the label reveals a native month input seeded
 * with the currently-shown month, and that picking a far-future value
 * jumps the whole calendar there directly (not one month at a time) and
 * closes the picker back to a plain label afterward.
 */
test("EntityPanel's calendar month label opens a month/year picker that jumps the calendar directly to the chosen month", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelector(".calendar-month-label") !== null);

      const monthLabel = () => document.querySelector(".calendar-month-label")?.textContent ?? null;
      const currentMonthLabel = monthLabel();
      assert.equal(document.querySelector(".calendar-month-input"), null, "the month input must not render until the label is clicked");

      const labelBtn = document.querySelector(".calendar-month-label") as HTMLButtonElement;
      fireEvent.click(labelBtn);
      const monthInput = document.querySelector(".calendar-month-input") as HTMLInputElement;
      assert.ok(monthInput, "clicking the label must reveal the month input");
      assert.equal(document.querySelector(".calendar-month-label"), null, "the label button itself must be replaced by the input while open, not shown alongside it");

      const now = new Date();
      const expectedInputValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      assert.equal(monthInput.value, expectedInputValue, "the input must be seeded with the currently-shown month, not blank");

      const farFuture = new Date(now.getFullYear() + 1, now.getMonth(), 1);
      const farFutureValue = `${farFuture.getFullYear()}-${String(farFuture.getMonth() + 1).padStart(2, "0")}`;
      fireEvent.change(monthInput, { target: { value: farFutureValue } });

      await waitForCondition(() => monthLabel() !== null && monthLabel() !== currentMonthLabel);
      const expectedLabel = farFuture.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      assert.equal(monthLabel(), expectedLabel, "picking a year-ahead value must jump the calendar directly there, not one month at a time");
      assert.equal(document.querySelector(".calendar-month-input"), null, "the picker must close itself once a value is chosen");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the calendar view's only "take it with you" action was
 * CSV export of the raw table -- nothing turned a month of appointments
 * into a file a real business owner could drop into their phone's actual
 * calendar app. Confirms the new "Export to Calendar (ICS)" button only
 * renders in calendar view (never table/board), starts disabled when the
 * currently-shown month has zero records, and enables itself once paging
 * lands on a month that actually has one -- proving it tracks the visible
 * month, not just "does this entity have any records at all" (see
 * icsMonthRecords in EntityPanel.tsx).
 */
test("EntityPanel's ICS export button only appears in calendar view, and is disabled/enabled based on whether the currently-shown month has records", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      assert.equal(
        document.querySelector(".ics-export-btn"),
        null,
        "the ICS export button must not render at all in table view -- CSV already covers that",
      );

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelector(".calendar-month-label") !== null);

      const icsBtn = document.querySelector(".ics-export-btn") as HTMLButtonElement;
      assert.ok(icsBtn, "the ICS export button must render once in calendar view");
      assert.equal(icsBtn.disabled, false, "this month genuinely has one record, so the button must be enabled");

      const nextBtn = document.querySelector('[aria-label="Next month"]') as HTMLButtonElement;
      const monthLabel = () => document.querySelector(".calendar-month-label")!.textContent;
      const currentMonthLabel = monthLabel();
      fireEvent.click(nextBtn);
      await waitForCondition(() => monthLabel() !== currentMonthLabel);
      assert.equal(
        (document.querySelector(".ics-export-btn") as HTMLButtonElement).disabled,
        true,
        "next month has no records of its own, so the export button must disable itself -- not stay enabled just because the entity has records somewhere",
      );

      const todayBtn = document.querySelector(".calendar-today-btn") as HTMLButtonElement;
      fireEvent.click(todayBtn);
      await waitForCondition(() => monthLabel() === currentMonthLabel);
      assert.equal(
        (document.querySelector(".ics-export-btn") as HTMLButtonElement).disabled,
        false,
        "returning to the current month must re-enable the button",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1006: the live counterpart of the one-shot ICS export above -- a
 * "Subscribe" button that copies a feed URL a real calendar app re-fetches
 * on its own schedule forever, instead of a static month-scoped download.
 * Confirms it only renders in calendar view, fetches the real token from
 * the server (not a client-invented value), builds the URL with the real
 * project id/entity name/token, and copies it to the clipboard with a
 * "Copied!" confirmation that reverts after a delay -- mirroring the
 * existing Copy button's own round-tripped test shape exactly.
 */
test("EntityPanel's calendar Subscribe button only appears in calendar view, fetches the real feed token, and copies the real subscription URL to the clipboard", async (t) => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Appointment") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && input === "/api/projects/proj1/calendar-feed-token") {
        return new Response(JSON.stringify({ token: "real-feed-token-abc" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      assert.equal(document.querySelector(".ics-subscribe-btn"), null, "the Subscribe button must not render in table view");

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelector(".calendar-month-label") !== null);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const subscribeBtn = document.querySelector(".ics-subscribe-btn") as HTMLButtonElement;
      assert.ok(subscribeBtn, "expected a real Subscribe button once in calendar view");
      assert.equal(subscribeBtn.textContent, "🔗 Subscribe to live calendar");

      await act(async () => {
        fireEvent.click(subscribeBtn);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Subscribe must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /\/api\/public\/calendar\/proj1\/Appointment\.ics\?token=real-feed-token-abc/, "the copied URL must carry the real project id, entity name, and the real token the server returned");
      assert.equal(subscribeBtn.textContent, "✅ Subscription link copied!");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(subscribeBtn.textContent, "🔗 Subscribe to live calendar", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * Round 937: this button's own text used to be a flat "Export to
 * Calendar (ICS)" with zero indication that it only ever exports the
 * calendar grid's CURRENTLY-SHOWN month -- unlike its sibling Export CSV
 * button right next to it, which already says "Export N selected" when
 * its own scope narrows. Confirms the button's text names the real
 * visible month (the exact same label the calendar grid's own nav
 * header shows), and that it updates when the user pages to a different
 * month -- so the label never silently disagrees with what a click
 * would actually export.
 */
test("EntityPanel's ICS export button names the real month it will export, matching the calendar grid's own month label, and updates when paging months", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's appointment", date: today }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockListRecordsFetch(store) as typeof fetch;
    try {
      renderAppointmentPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelector(".calendar-month-label") !== null);

      const monthLabel = () => document.querySelector(".calendar-month-label")!.textContent ?? "";
      const icsBtnText = () => (document.querySelector(".ics-export-btn") as HTMLElement).textContent ?? "";

      const currentMonthLabel = monthLabel();
      assert.ok(currentMonthLabel, "expected a real month label from the calendar grid's own nav header");
      assert.ok(
        icsBtnText().includes(currentMonthLabel),
        "the export button's own text must name the exact same month the calendar grid is showing",
      );

      const nextBtn = document.querySelector('[aria-label="Next month"]') as HTMLButtonElement;
      fireEvent.click(nextBtn);
      await waitForCondition(() => monthLabel() !== currentMonthLabel);

      const nextMonthLabel = monthLabel();
      assert.ok(
        icsBtnText().includes(nextMonthLabel),
        "paging to a different month must update the button's own text to name the new month, not keep showing the old one",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const RENTAL_ENTITY: Entity = {
  name: "Rental",
  label: "Rental",
  fields: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "startDate", label: "Start Date", type: "date", required: true },
    { name: "endDate", label: "End Date", type: "date", required: true },
  ],
};

function mockRentalListFetch(store: EntityRecord[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/projects/proj1/entities/Rental") {
      return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockRentalListFetch: unexpected request ${method} ${input}`);
  };
}

function renderRentalPanel() {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(EntityPanel, {
          projectId: "proj1",
          userId: "user1",
          entity: RENTAL_ENTITY,
          allEntities: [RENTAL_ENTITY],
          onEntityRenamed: () => {},
        }),
      ),
    ),
  );
}

/**
 * New in this round: buildCalendarMonth deliberately puts the SAME ranged
 * record into every day cell it spans (startDate/endDate), so a multi-night
 * Rental's chip shows up on every night of the stay in the on-screen grid --
 * that's correct and already covered elsewhere. But icsMonthRecords reused
 * that exact per-day grouping to build the flat list handed to
 * buildCalendarIcs, which emits one VEVENT per entry -- so a single 3-day
 * stay was exported as 3 byte-identical VEVENT blocks (same UID, same
 * DTSTART/DTEND) instead of the one event a "take it with you" export
 * should produce. Confirms a single ranged record whose stay is fully
 * inside the exported month downloads exactly one VEVENT, not one per
 * night.
 */
test("EntityPanel's ICS export emits exactly one VEVENT per ranged record, not one per day it spans", async () => {
  await withJsdom(async () => {
    const today = isoDateToday();
    const twoDaysLater = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();
    const store: EntityRecord[] = [{ id: 1, title: "Dana's stay", startDate: today, endDate: twoDaysLater }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRentalListFetch(store) as typeof fetch;
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    try {
      renderRentalPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelector(".ics-export-btn") !== null);

      const icsBtn = document.querySelector(".ics-export-btn") as HTMLButtonElement;
      assert.equal(icsBtn.disabled, false, "the ranged record is in the current month, so the export button must be enabled");
      fireEvent.click(icsBtn);

      await waitForCondition(() => capturedBlob !== null);
      const icsText = await (capturedBlob as unknown as Blob).text();
      const veventCount = (icsText.match(/BEGIN:VEVENT/g) ?? []).length;
      assert.equal(veventCount, 1, "a single 3-day stay must export as exactly one VEVENT, not one per night it spans");
      const uidLines = icsText.match(/UID:Rental-1@proj1\.forge-ai/g) ?? [];
      assert.equal(uidLines.length, 1, "the record's UID must appear exactly once, confirming it wasn't duplicated");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

/**
 * New in round 599: buildCalendarMonth deliberately renders a ranged
 * record's SAME chip on every day it spans (confirmed by the ICS test
 * above), and every one of those chip instances is equally draggable --
 * but handleCalendarDrop used to always anchor the record's start field to
 * whatever day the chip was dropped on, regardless of which day of the
 * span was actually grabbed. Dragging the LAST night's own chip forward by
 * one day silently relocated the entire booking's start by however many
 * days separated the drop target from the record's stored start -- a
 * result with no relationship to the one-day drag the user actually made.
 * Confirms dragging the specific chip instance shown on the stay's last
 * night shifts BOTH start and end by the real number of days dragged,
 * matching what dragging a multi-day event on a real calendar app does.
 */
test("EntityPanel's calendar view shifts a ranged record by the days actually dragged, even when the dragged chip is NOT the record's start day", async () => {
  await withJsdom(async () => {
    const addDays = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      const pad = (v: number) => String(v).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const dayNumber = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return String(d.getDate());
    };
    // A 3-night stay: today (start) through today+2 (end/last night).
    const store: EntityRecord[] = [{ id: 1, title: "Dana's stay", startDate: addDays(0), endDate: addDays(2) }];
    let lastPatchBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Rental") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const patchMatch = /^\/api\/projects\/proj1\/entities\/Rental\/(\d+)$/.exec(input);
      if (method === "PATCH" && patchMatch) {
        const id = Number(patchMatch[1]);
        const record = store.find((r) => r.id === id)!;
        lastPatchBody = JSON.parse(init!.body as string);
        Object.assign(record, lastPatchBody);
        return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderRentalPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const calendarToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(calendarToggle);
      await waitForCondition(() => document.querySelectorAll(".calendar-record-chip").length === 3);

      function dayCellFor(n: number): HTMLElement {
        const target = dayNumber(n);
        return Array.from(document.querySelectorAll(".calendar-day")).find(
          (el) => el.querySelector(".calendar-day-number")?.textContent === target && el.querySelector(".calendar-record-chip"),
        ) as HTMLElement;
      }
      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }

      // Drag the LAST night's own chip instance (today+2, the stay's end
      // day) forward by exactly one day, onto today+3 (empty, outside the stay).
      const lastNightCell = dayCellFor(2);
      const lastNightChip = lastNightCell.querySelector(".calendar-record-chip") as HTMLButtonElement;
      const dropTargetDay = Array.from(document.querySelectorAll(".calendar-day-clickable")).find(
        (el) => el.querySelector(".calendar-day-number")?.textContent === dayNumber(3),
      ) as HTMLElement;
      assert.ok(dropTargetDay, "expected to find today+3's day cell to drop onto");

      const dataTransfer = makeDataTransfer();
      fireEvent.dragStart(lastNightChip, { dataTransfer });
      fireEvent.dragOver(dropTargetDay, { dataTransfer });
      fireEvent.drop(dropTargetDay, { dataTransfer });

      await waitForCondition(() => lastPatchBody !== null);
      assert.deepEqual(
        lastPatchBody,
        { startDate: addDays(1), endDate: addDays(3) },
        "dragging the LAST night's chip forward by one day must shift the whole range by one day (start and end both +1), not jump the start to the drop target",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const CUSTOMER_ENTITY: Entity = {
  name: "Customer",
  label: "Customer",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "text", required: false },
  ],
};

function mockCustomerListFetch(store: EntityRecord[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET" && input === "/api/projects/proj1/entities/Customer") {
      return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockCustomerListFetch: unexpected request ${method} ${input}`);
  };
}

function renderCustomerPanel() {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(EntityPanel, {
          projectId: "proj1",
          userId: "user1",
          entity: CUSTOMER_ENTITY,
          allEntities: [CUSTOMER_ENTITY],
          onEntityRenamed: () => {},
        }),
      ),
    ),
  );
}

/**
 * Real-DOM coverage for the table view's "select all" checkbox, the one
 * interactive element in EntityPanel that a function-extraction test
 * structurally cannot verify: `indeterminate` is a live DOM property (set
 * imperatively via a ref, per the HTML spec -- there is no `indeterminate`
 * HTML attribute), not something that shows up in rendered markup or a
 * component's return value. Exercises the full selection lifecycle a real
 * user drives through actual checkbox clicks: none selected (unchecked,
 * not indeterminate) -> some selected (indeterminate) -> all selected
 * (checked, not indeterminate) -> clicking the header checkbox while all
 * are selected deselects everything, rather than the increasingly-common
 * mistake of always selecting-all regardless of current state.
 */
test("EntityPanel's table view header checkbox reflects none/some/all selected via the real indeterminate DOM property", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Dana", email: "dana@example.com" },
      { id: 2, name: "Noa", email: "noa@example.com" },
      { id: 3, name: "Omer", email: "omer@example.com" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCustomerListFetch(store) as typeof fetch;
    try {
      renderCustomerPanel();
      await waitForCondition(() => document.querySelectorAll("tbody .select-col input").length === 3);

      const headerCheckbox = document.querySelector("thead .select-col input") as HTMLInputElement;
      const rowCheckboxes = [...document.querySelectorAll("tbody .select-col input")] as HTMLInputElement[];

      assert.equal(headerCheckbox.checked, false, "header checkbox must start unchecked with nothing selected");
      assert.equal(headerCheckbox.indeterminate, false, "header checkbox must not be indeterminate with nothing selected");

      fireEvent.click(rowCheckboxes[0]);
      assert.equal(headerCheckbox.checked, false, "header checkbox must stay unchecked with only 1 of 3 rows selected");
      assert.equal(headerCheckbox.indeterminate, true, "header checkbox must show indeterminate with a partial selection");

      fireEvent.click(rowCheckboxes[1]);
      fireEvent.click(rowCheckboxes[2]);
      assert.equal(headerCheckbox.checked, true, "header checkbox must become checked once every row is selected");
      assert.equal(headerCheckbox.indeterminate, false, "header checkbox must not be indeterminate once every row is selected");

      fireEvent.click(headerCheckbox);
      assert.equal(headerCheckbox.checked, false, "clicking the header checkbox while fully selected must deselect everything, not re-select");
      assert.equal(headerCheckbox.indeterminate, false, "header checkbox must not be indeterminate after deselecting everything");
      assert.equal(
        document.querySelector(".bulk-actions-bar") === null,
        true,
        "the bulk-actions bar must disappear once nothing is selected",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 486's finding: "select all" (and its header
 * checkbox's own checked/indeterminate state) used to read the flat
 * visibleRecords array directly, oblivious to table grouping -- exactly
 * the same staleness round 485 fixed for j/k keyboard navigation, but in
 * the bulk-selection code path instead. Clicking "select all" while a
 * group is collapsed used to silently add that hidden group's own record
 * ids to selectedIds too, which the bulk-actions bar, bulk delete/
 * duplicate/edit, CSV-export-selected, and print-selected all act on
 * directly. Confirms selecting all while "Won" is collapsed only selects
 * the one visible record (Acme), and that the hidden "Won" records stay
 * unselected even once that group is re-expanded.
 */
test("EntityPanel's 'select all' only selects records actually visible, not ones hidden inside a collapsed group", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
      { id: 3, name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.ok(
        !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Beta Inc")),
        "the 'Won' group must actually be collapsed before testing select-all",
      );

      const headerCheckbox = document.querySelector("thead .select-col input") as HTMLInputElement;
      fireEvent.click(headerCheckbox);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(headerCheckbox.checked, true, "the header checkbox must report fully-checked once the one visible record is selected");
      assert.equal(headerCheckbox.indeterminate, false, "the header checkbox must not be indeterminate once every visible record is selected");

      const acmeCheckbox = Array.from(document.querySelectorAll("tbody tr")).find((r) => r.textContent?.includes("Acme Corp"))?.querySelector(
        ".select-col input",
      ) as HTMLInputElement;
      assert.equal(acmeCheckbox.checked, true, "the one visible record (Acme) must actually be selected");

      // Re-expand 'Won' -- its two records must NOT have been silently
      // swept into the selection while they were hidden.
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 5);
      const wonCheckboxes = Array.from(document.querySelectorAll("tbody tr"))
        .filter((r) => r.textContent?.includes("Beta Inc") || r.textContent?.includes("Gamma LLC"))
        .map((r) => r.querySelector(".select-col input") as HTMLInputElement);
      assert.equal(wonCheckboxes.length, 2, "expected to find both of 'Won''s own row checkboxes after re-expanding");
      assert.ok(
        wonCheckboxes.every((cb) => !cb.checked),
        "records hidden inside a collapsed group during 'select all' must stay unselected even after the group is re-expanded",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Real-DOM coverage for the search box's interaction with the board view --
 * `visibleRecords` (the search+sort-filtered array) is what actually feeds
 * groupByField/CalendarView, not the raw `records` state, but that wiring
 * had never been exercised through a real render with a real typed query.
 * Confirms typing a search query that matches only 1 of 3 records narrows
 * the board down to that 1 card while staying in board view (not resetting
 * to table, and not losing the "declared columns always render" behavior
 * round 83's tests already cover), and that switching view modes doesn't
 * clear whatever the user already typed into the search box.
 *
 * Writing this test surfaced a real, previously-latent bug in this
 * project's own test infrastructure, not in EntityPanel.tsx itself: see
 * jsdomWarmup.ts's own comment for the full root cause (react-dom's
 * `isInputEventSupported` gets permanently cached `false` the moment
 * react-dom is first imported against plain Node.js, before any test's
 * own per-test JSDOM window exists, silently breaking onChange for every
 * controlled text <input>/<textarea> in every jsdom test file afterward).
 * This is the first test in the project that actually depends on a typed
 * value reaching React state (earlier tests typing into text fields, like
 * AuthScreen.test.ts's email/password, only ever read back the input's own
 * DOM `.value`, which reflects fireEvent's direct DOM write regardless of
 * whether React's onChange ever fired) -- which is exactly why this bug
 * went unnoticed until now.
 */
test("EntityPanel's search box filters the board view's cards without losing the search text or the view mode", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Omega LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 3);

      const searchInput = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchInput, { target: { value: "Acme" } });
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);

      assert.equal(document.querySelectorAll(".board-card").length, 1, "only the 1 record matching the search query must render as a card");
      assert.equal(
        document.querySelectorAll(".view-toggle-btn")[1].classList.contains("view-toggle-btn-active"),
        true,
        "typing into the search box must not reset the view mode back to table",
      );
      assert.equal(
        (document.querySelector(".entity-search") as HTMLInputElement).value,
        "Acme",
        "the typed search text itself must still be there after the board re-rendered around it",
      );
      assert.equal(
        document.querySelectorAll(".board-column").length,
        3,
        "every declared status must still render as a column while searching, same as with no search active",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Companion test: a search query matching nothing at all must show the
 * dedicated "no results" empty state instead of a board with 3 columns
 * that are all empty -- the `visibleRecords.length === 0` branch in
 * EntityPanel's JSX sits *above* the board/calendar/table branching, so
 * this is a real, if easy to get backwards, ordering to get right.
 */
test("EntityPanel's board view shows the 'no results' empty state (not an all-empty board) when the search query matches nothing", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Omega LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 2);

      const searchInput = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchInput, { target: { value: "no such company" } });
      await waitForCondition(() => document.querySelector(".empty-state") !== null);

      assert.equal(document.querySelectorAll(".board-column").length, 0, "no board columns must render once the search matches nothing");
      assert.equal(document.querySelectorAll(".board-card").length, 0, "no board cards must render once the search matches nothing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const CUSTOMER_IMPORT_ENTITY: Entity = {
  name: "Customer",
  label: "Customer",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "text", required: false },
  ],
};

/**
 * Real-DOM coverage for CSV import (handleImportFile), the one EntityPanel
 * interaction never yet exercised through a real file upload + POST +
 * table re-render round trip -- entityFormatting.test.ts already covers
 * parseCsv/buildImportRecords in isolation, but nothing before this
 * confirmed the actual wiring: a real uploaded File genuinely reaches
 * `file.text()`, the parsed row genuinely gets POSTed via createRecord,
 * and the table genuinely reflects it afterward. Builds a real
 * `File`/CSV via the standard jsdom-file-input technique (`.files` is
 * read-only on a real `<input type="file">`, so it's set via
 * Object.defineProperty, the same way a browser's own file picker would
 * populate it) and fires a real "change" event on it.
 */
test("EntityPanel's CSV import creates a real record from an uploaded file and shows it in the table", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [];
    let nextId = 1;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Customer") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Customer") {
        const data = JSON.parse(init!.body as string);
        const record = { id: nextId++, ...data };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
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
            React.createElement(EntityPanel, {
              projectId: "proj1",
              userId: "user1",
              entity: CUSTOMER_IMPORT_ENTITY,
              allEntities: [CUSTOMER_IMPORT_ENTITY],
              onEntityRenamed: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".csv-import-row") !== null);

      const csvText = "name,email\nDana,dana@example.com\n";
      const file = new File([csvText], "customers.csv", { type: "text/csv" });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fireEvent.change(fileInput);

      await waitForCondition(() => document.querySelectorAll("tbody tr").length === 1);

      assert.equal(document.querySelectorAll("tbody tr").length, 1, "the imported record must appear as a real row in the table");
      assert.match(
        document.querySelector("tbody tr")!.textContent ?? "",
        /Dana/,
        "the row must show the name actually parsed from the uploaded CSV, not a placeholder",
      );
      assert.equal(store.length, 1, "the import must have actually POSTed the parsed row to the server, not just updated local state");
      assert.equal(store[0].name, "Dana");
      assert.equal(store[0].email, "dana@example.com");
      assert.equal(document.querySelector("p.error") === null, true, "a successful import must not leave an error banner showing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 643: CSV import POSTs every parsed row through the exact same
 * createRecord call (and server route) a single "Add" form submission
 * uses -- without a way to tell the two apart, every "record_created"
 * WhatsApp automation rule fired for each imported row, sending a real
 * message to everyone in the file even though none of them were actually
 * just created through the app (they're pre-existing data a user is
 * migrating off another system). The fix wires an X-Suppress-Automations
 * header onto every createRecord call inside handleImportFile alone --
 * confirmed here by capturing the real request headers the import path
 * actually sends, not just the parsed body.
 */
test("EntityPanel's CSV import sends X-Suppress-Automations on the real POST request, so importing pre-existing data never fires a 'welcome new customer' automation", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [];
    let nextId = 1;
    const seenHeaders: Headers[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Customer") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Customer") {
        seenHeaders.push(new Headers(init!.headers));
        const data = JSON.parse(init!.body as string);
        const record = { id: nextId++, ...data };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
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
            React.createElement(EntityPanel, {
              projectId: "proj1",
              userId: "user1",
              entity: CUSTOMER_IMPORT_ENTITY,
              allEntities: [CUSTOMER_IMPORT_ENTITY],
              onEntityRenamed: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".csv-import-row") !== null);

      const csvText = "name,email\nDana,dana@example.com\nAmit,amit@example.com\n";
      const file = new File([csvText], "customers.csv", { type: "text/csv" });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fireEvent.change(fileInput);

      await waitForCondition(() => store.length === 2);

      assert.equal(seenHeaders.length, 2, "both imported rows must have reached the server");
      for (const headers of seenHeaders) {
        assert.equal(
          headers.get("x-suppress-automations"),
          "true",
          "every record created by CSV import must suppress automations, not just some of them",
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 683: a real bug found by the survey -- re-importing a CSV this app
 * had itself just exported always created a brand-new duplicate record,
 * even for a row whose data was completely unchanged, because nothing in
 * the export/import round trip carried a record's own id. Fixed by having
 * recordsToCsv's real "Export CSV" download include a leading "id" column
 * and buildImportRecords recognize it; this test exercises the real DOM
 * wiring end to end: a CSV with an "id" column, one row matching an
 * existing record (must PATCH, not POST) and one row with a blank id (must
 * still POST, exactly like before) -- confirming both requests actually
 * reach the server with the right method/body, the table reflects both
 * outcomes (the existing record updated in place, the new one appended),
 * and both the PATCH and the POST carry X-Suppress-Automations, same as
 * every other CSV-import write.
 */
test("EntityPanel's CSV import updates an existing record by its id column instead of duplicating it, while still creating a row with no id", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Dana", email: "dana@old.example.com" }];
    let nextId = 2;
    const seenRequests: { method: string; input: string; headers: Headers }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Customer") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      seenRequests.push({ method, input, headers: new Headers(init!.headers) });
      if (method === "POST" && input === "/api/projects/proj1/entities/Customer") {
        const data = JSON.parse(init!.body as string);
        const record = { id: nextId++, ...data };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      const patchMatch = /^\/api\/projects\/proj1\/entities\/Customer\/(\d+)$/.exec(input);
      if (method === "PATCH" && patchMatch) {
        const id = Number(patchMatch[1]);
        const record = store.find((r) => r.id === id);
        assert.ok(record, `mock PATCH target record ${id} must exist`);
        Object.assign(record!, JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
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
            React.createElement(EntityPanel, {
              projectId: "proj1",
              userId: "user1",
              entity: CUSTOMER_IMPORT_ENTITY,
              allEntities: [CUSTOMER_IMPORT_ENTITY],
              onEntityRenamed: () => {},
            }),
          ),
        ),
      );
      await waitForCondition(() => document.querySelector(".csv-import-row") !== null);

      const csvText = "id,name,email\n1,Dana,dana@new.example.com\n,Amit,amit@example.com\n";
      const file = new File([csvText], "customers.csv", { type: "text/csv" });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fireEvent.change(fileInput);

      await waitForCondition(() => store.length === 2);

      assert.equal(store[0].id, 1, "the id=1 row must have UPDATED the existing record, not appended a new one");
      assert.equal(store[0].email, "dana@new.example.com", "the existing record's own field must reflect the imported row's new value");
      assert.equal(store[1].name, "Amit", "the blank-id row must still have been created as a genuinely new record");

      const patchReq = seenRequests.find((r) => r.method === "PATCH");
      const postReq = seenRequests.find((r) => r.method === "POST");
      assert.ok(patchReq, "the id=1 row must have actually PATCHed the server, not POSTed a duplicate");
      assert.ok(postReq, "the blank-id row must have actually POSTed a new record");
      assert.equal(patchReq!.headers.get("x-suppress-automations"), "true", "an imported update must also suppress automations");
      assert.equal(postReq!.headers.get("x-suppress-automations"), "true", "an imported create must still suppress automations");

      await waitForCondition(() => /updated 1 existing/i.test(document.body.textContent ?? ""));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a per-row "Print" action fills the always-mounted
 * (but on-screen-hidden, via styles.css) `.print-record-sheet` with that
 * ONE record's fields and calls `window.print()` -- the sheet's own
 * visibility switch (screen: none; @media print: visible while everything
 * else is hidden) is pure CSS and can't be exercised by jsdom, but the
 * DOM/data wiring this test actually owns -- clicking row 2's "Print"
 * button populates the sheet with row 2's fields, not row 1's or an empty
 * one, and genuinely calls the browser print API -- is real and worth
 * pinning.
 */
test("EntityPanel's Print action fills the print sheet with that record's own fields and calls window.print", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(
        document.querySelector(".print-record-sheet")!.textContent,
        "",
        "the print sheet must be empty until a row's Print action is actually clicked",
      );

      const rows = document.querySelectorAll("table tbody tr");
      const globexRow = Array.from(rows).find((r) => /Globex/.test(r.textContent ?? ""))!;
      const printBtn = Array.from(globexRow.querySelectorAll("button")).find((b) => b.textContent?.includes("Print"))!;
      fireEvent.click(printBtn);

      await waitForCondition(() => printCalls === 1);

      const sheetText = document.querySelector(".print-record-sheet")!.textContent ?? "";
      assert.match(sheetText, /Globex/, "the print sheet must show the clicked row's own name, not another row's");
      assert.match(sheetText, /Won/, "the print sheet must show the clicked row's own status label");
      assert.doesNotMatch(sheetText, /Acme Corp/, "the print sheet must not include the OTHER record's data");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * The list-view sibling of the per-row Print action above: a "Print list"
 * toolbar button fills the always-mounted `.print-list-sheet` with every
 * currently VISIBLE record as one table, and genuinely calls
 * window.print() -- same convention as the per-record sheet (CSS-driven
 * visibility can't be exercised in jsdom, but the DOM/data wiring can).
 * Narrows the table to one record via the search box first, to prove the
 * printed list respects the same search filter the on-screen table and
 * CSV export already do, not just "every record ever fetched".
 */
test("EntityPanel's Print list action fills the print sheet with only the currently-VISIBLE (search-filtered) records and calls window.print", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(
        document.querySelector(".print-list-sheet")!.textContent,
        "",
        "the print-list sheet must be empty until Print list is actually clicked",
      );

      fireEvent.change(document.querySelector(".entity-search")!, { target: { value: "Globex" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print list"))!;
      fireEvent.click(printListBtn);

      await waitForCondition(() => printCalls === 1);

      const sheetText = document.querySelector(".print-list-sheet")!.textContent ?? "";
      assert.match(sheetText, /Globex/, "the printed list must include the search-matched record");
      assert.doesNotMatch(sheetText, /Acme Corp/, "the printed list must NOT include a record the search filtered out");
      assert.match(sheetText, /1 records/, "the footer must report the count of records actually printed (1), not the full store (2)");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Round 884: the on-screen table's own grand-total row (numericFieldTotals/
 * <tfoot>, round 297) was never ported to RecordListPrintSheet, even
 * though this print sheet was extended several times afterward (field-
 * label disambiguation, boolean/enum/relation/file cell rendering,
 * orderedFields column order) in parallel with the on-screen table's own
 * evolution. A printed list showed every record's own number column but
 * never the one number a person printing a list of amounts is very
 * plausibly printing it FOR -- the total. Confirms the printed sheet now
 * carries its own totals row, computed from the records actually being
 * printed (not the on-screen numericFieldTotals, which is always over the
 * full visible set and would be wrong when printing just a selection).
 */
test("EntityPanel's Print list sheet includes a grand-total row for a numeric field, matching the on-screen table's own total", async () => {
  const dealWithAmount: Entity = {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "amount", label: "Amount", type: "number", required: true },
    ],
  };
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", amount: 800 },
      { id: 2, name: "Globex", amount: 1000 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel({ entity: dealWithAmount, allEntities: [dealWithAmount] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.match(
        document.querySelector(".entity-totals-row")?.textContent ?? "",
        /1,800/,
        "sanity check: the on-screen table's own total must show 1,800 (800 + 1000)",
      );

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print list"))!;
      fireEvent.click(printListBtn);
      await waitForCondition(() => printCalls === 1);

      assert.match(
        document.querySelector(".print-list-totals-row")?.textContent ?? "",
        /1,800/,
        "the printed list must carry its own total row showing the same grand total (800 + 1000) as the on-screen table",
      );
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Round 885: a feature round 884 (just above) didn't reach -- grouping a
 * table by an enum/boolean field (Table view's "Group by") gives the
 * on-screen table its own per-group heading and numeric subtotal row
 * (recordGroups/groupNumericTotals), specifically so a person can compare
 * e.g. "New" vs "Won" revenue at a glance. Previously "Print list" lost
 * all of that structure the moment it was printed: one continuous table
 * with zero group headings or subtotals, only round 884's own flat grand
 * total at the very bottom. Confirms the printed sheet now carries its
 * own group heading + per-group subtotal rows, matching the on-screen
 * table's own grouped structure, while the flat grand total still appears
 * once at the very end.
 */
test("EntityPanel's Print list sheet mirrors the on-screen table's own group headings and per-group subtotals when grouped", async () => {
  const dealWithAmount: Entity = {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["new", "won"],
        enumLabels: { new: "New", won: "Won" },
      },
      { name: "amount", label: "Amount", type: "number", required: true },
    ],
  };
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new", amount: 500 },
      { id: 2, name: "Beta Inc", status: "won", amount: 800 },
      { id: 3, name: "Gamma LLC", status: "won", amount: 1000 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel({ entity: dealWithAmount, allEntities: [dealWithAmount] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print list"))!;
      fireEvent.click(printListBtn);
      await waitForCondition(() => printCalls === 1);

      const groupHeaders = Array.from(document.querySelectorAll(".print-list-group-header-row"));
      assert.equal(groupHeaders.length, 2, "the printed list must have one group heading per group, matching the on-screen table");
      assert.match(groupHeaders[0].textContent ?? "", /New/, "the first printed group heading must name the 'New' group");
      assert.match(groupHeaders[1].textContent ?? "", /Won/, "the second printed group heading must name the 'Won' group");

      const groupTotalsRows = Array.from(document.querySelectorAll(".print-list-group-totals-row"));
      assert.equal(groupTotalsRows.length, 2, "the printed list must have one subtotal row per group");
      assert.match(groupTotalsRows[0].textContent ?? "", /500/, "'New' group's own printed subtotal must be 500 (just Acme Corp)");
      assert.match(
        groupTotalsRows[1].textContent ?? "",
        /1,800/,
        "'Won' group's own printed subtotal must be 1,800 (800 + 1000), not the flat grand total",
      );

      assert.match(
        document.querySelector(".print-list-totals-row")?.textContent ?? "",
        /2,300/,
        "the flat grand total at the very end must still be the full 2,300 (500 + 800 + 1000) across every group",
      );
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Round 885's sibling case: Board view's own columns (groupByField,
 * boardColumnNumericTotals) give the exact same "compare totals across
 * groups" value Table view's grouping does -- Copy/Export-CSV/Print list
 * are the same view-mode-agnostic toolbar in every view, so this must
 * have the identical print-grouping gap.
 */
test("EntityPanel's Print list sheet mirrors the Board view's own column headings and per-column subtotals", async () => {
  const dealWithAmount: Entity = {
    name: "Deal",
    label: "Deal",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["new", "won"],
        enumLabels: { new: "New", won: "Won" },
      },
      { name: "amount", label: "Amount", type: "number", required: true },
    ],
  };
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new", amount: 500 },
      { id: 2, name: "Beta Inc", status: "won", amount: 800 },
      { id: 3, name: "Gamma LLC", status: "won", amount: 1000 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel({ entity: dealWithAmount, allEntities: [dealWithAmount] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 3);

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print list"))!;
      fireEvent.click(printListBtn);
      await waitForCondition(() => printCalls === 1);

      const groupHeaders = Array.from(document.querySelectorAll(".print-list-group-header-row"));
      assert.equal(groupHeaders.length, 2, "the printed list must have one column heading per Board column");
      assert.match(groupHeaders[0].textContent ?? "", /New/, "the first printed column heading must name the 'New' column");
      assert.match(groupHeaders[1].textContent ?? "", /Won/, "the second printed column heading must name the 'Won' column");

      const groupTotalsRows = Array.from(document.querySelectorAll(".print-list-group-totals-row"));
      assert.match(groupTotalsRows[0].textContent ?? "", /500/, "'New' column's own printed subtotal must be 500");
      assert.match(groupTotalsRows[1].textContent ?? "", /1,800/, "'Won' column's own printed subtotal must be 1,800 (800 + 1000)");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Regression test for a real bug found by round 638's Explore survey: the
 * same label-collision gap already fixed in Business Twin (635), the
 * calendar export (636), and CSV export (637), confirmed to reach three
 * more render paths -- RecordPrintSheet's per-row Print sheet,
 * RecordListPrintSheet's Print-list sheet, and BoardCard's board-view
 * cards -- which all rendered a bare `field.label ?? field.name` with no
 * disambiguation. Only field.name is unique on an entity (FieldSchema/
 * EntitySchema never enforce label uniqueness), so two fields on the same
 * entity can legally share a label via the Field Label editor -- here, two
 * number fields both renamed to "Amount". Before this fix, a printed
 * sheet or a board card would show two identical-looking "Amount" labels
 * with no way to tell which field either one actually was.
 */
test("EntityPanel's print-row sheet, print-list sheet, and board cards all disambiguate two fields that share a label", async () => {
  const orderEntity: Entity = {
    name: "Order",
    label: "Order",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      {
        name: "status",
        label: "Status",
        type: "enum",
        required: true,
        enumValues: ["new", "won"],
        enumLabels: { new: "New", won: "Won" },
      },
      { name: "subtotal", label: "Amount", type: "number", required: true },
      { name: "shipping", label: "Amount", type: "number", required: true },
    ],
  };
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new", subtotal: 800, shipping: 30 }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      // Per-row Print sheet (RecordPrintSheet).
      const printBtn = Array.from(document.querySelectorAll("table tbody button")).find((b) => b.textContent?.includes("Print"))!;
      fireEvent.click(printBtn);
      await waitForCondition(() => printCalls === 1);
      const dts = Array.from(document.querySelectorAll(".print-record-sheet dt")).map((d) => d.textContent);
      assert.ok(dts.includes("Amount (subtotal)"), `expected the subtotal field disambiguated in the print sheet, got: ${JSON.stringify(dts)}`);
      assert.ok(dts.includes("Amount (shipping)"), `expected the shipping field disambiguated in the print sheet, got: ${JSON.stringify(dts)}`);

      // Print-list sheet (RecordListPrintSheet).
      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print list"))!;
      fireEvent.click(printListBtn);
      await waitForCondition(() => printCalls === 2);
      const ths = Array.from(document.querySelectorAll(".print-list-sheet th")).map((th) => th.textContent);
      assert.ok(ths.includes("Amount (subtotal)"), `expected the subtotal field disambiguated in the print-list header, got: ${JSON.stringify(ths)}`);
      assert.ok(ths.includes("Amount (shipping)"), `expected the shipping field disambiguated in the print-list header, got: ${JSON.stringify(ths)}`);

      // Board view (BoardCard).
      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);
      const boardLabels = Array.from(document.querySelectorAll(".board-card-field .muted.small")).map((s) => s.textContent);
      assert.ok(
        boardLabels.includes("Amount (subtotal)"),
        `expected the subtotal field disambiguated on the board card, got: ${JSON.stringify(boardLabels)}`,
      );
      assert.ok(
        boardLabels.includes("Amount (shipping)"),
        `expected the shipping field disambiguated on the board card, got: ${JSON.stringify(boardLabels)}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Regression test for a real bug found by round 649's Explore survey: the
 * same label-collision gap round 638 fixed for print sheets and board
 * cards (and rounds 635-637 fixed for Business Twin, calendar export, and
 * CSV export) never reached the app's own default, every-day table
 * view -- its main column headers, the bulk-edit "set field" picker, the
 * columns show/hide checklist, the per-field filter dropdowns, or the
 * group-by dropdown. Two fields on the same entity can legally share a
 * label (only field.name is unique), so before this fix, renaming two
 * number fields to "Amount" made both table columns read "Amount" with no
 * way to tell them apart, and a person mass-editing 50 selected records
 * via the bulk-edit field picker had a 50/50 chance of silently writing
 * to the wrong underlying field.
 */
test("EntityPanel's main table header, bulk-edit field picker, columns menu, filter dropdowns, and group-by dropdown all disambiguate fields that share a label", async () => {
  const orderEntity: Entity = {
    name: "Order",
    label: "Order",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "subtotal", label: "Amount", type: "number", required: true },
      { name: "shipping", label: "Amount", type: "number", required: true },
      { name: "isPriority", label: "Flag", type: "boolean", required: false },
      { name: "isFlagged", label: "Flag", type: "boolean", required: false },
    ],
  };
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", subtotal: 800, shipping: 30, isPriority: true, isFlagged: false },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      // Main table column headers (sort-header button) and their
      // move-earlier/move-later/resize-handle aria-labels.
      const headerTexts = Array.from(document.querySelectorAll("thead .sort-header")).map((b) => b.textContent);
      assert.ok(headerTexts.includes("Amount (subtotal)"), `expected a disambiguated subtotal column header, got: ${JSON.stringify(headerTexts)}`);
      assert.ok(headerTexts.includes("Amount (shipping)"), `expected a disambiguated shipping column header, got: ${JSON.stringify(headerTexts)}`);
      const resizeLabels = Array.from(document.querySelectorAll(".column-resize-handle")).map((s) => s.getAttribute("aria-label"));
      assert.ok(
        resizeLabels.some((l) => l?.includes("Amount (subtotal)")),
        `expected the subtotal column's resize handle aria-label disambiguated, got: ${JSON.stringify(resizeLabels)}`,
      );
      assert.ok(
        resizeLabels.some((l) => l?.includes("Amount (shipping)")),
        `expected the shipping column's resize handle aria-label disambiguated, got: ${JSON.stringify(resizeLabels)}`,
      );

      // Per-field filter dropdowns and the group-by dropdown (both only
      // offer enum/boolean fields, hence isPriority/isFlagged here).
      const filterLabels = Array.from(document.querySelectorAll(".entity-status-filter")).map((s) => s.getAttribute("aria-label"));
      assert.ok(
        filterLabels.some((l) => l?.includes("Flag (isPriority)")),
        `expected the isPriority filter dropdown disambiguated, got: ${JSON.stringify(filterLabels)}`,
      );
      assert.ok(
        filterLabels.some((l) => l?.includes("Flag (isFlagged)")),
        `expected the isFlagged filter dropdown disambiguated, got: ${JSON.stringify(filterLabels)}`,
      );
      const groupByOptions = Array.from(document.querySelectorAll(".entity-group-by option")).map((o) => o.textContent);
      assert.ok(groupByOptions.includes("Flag (isPriority)"), `expected the isPriority group-by option disambiguated, got: ${JSON.stringify(groupByOptions)}`);
      assert.ok(groupByOptions.includes("Flag (isFlagged)"), `expected the isFlagged group-by option disambiguated, got: ${JSON.stringify(groupByOptions)}`);

      // Columns show/hide checklist.
      fireEvent.click(document.querySelector(".columns-menu-btn") as HTMLElement);
      const columnsMenuLabels = Array.from(document.querySelectorAll(".columns-menu-item")).map((l) => l.textContent);
      assert.ok(
        columnsMenuLabels.some((l) => l?.includes("Amount (subtotal)")),
        `expected the subtotal column entry disambiguated in the columns menu, got: ${JSON.stringify(columnsMenuLabels)}`,
      );
      assert.ok(
        columnsMenuLabels.some((l) => l?.includes("Amount (shipping)")),
        `expected the shipping column entry disambiguated in the columns menu, got: ${JSON.stringify(columnsMenuLabels)}`,
      );

      // Bulk-edit "set field" picker, after selecting the one row.
      const rowCheckbox = document.querySelector('td.select-col input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(rowCheckbox);
      await waitForCondition(() => document.querySelector(".bulk-edit-field-label select") !== null);
      const bulkEditOptions = Array.from(document.querySelectorAll(".bulk-edit-field-label option")).map((o) => o.textContent);
      assert.ok(
        bulkEditOptions.includes("Amount (subtotal)"),
        `expected the subtotal option disambiguated in the bulk-edit field picker, got: ${JSON.stringify(bulkEditOptions)}`,
      );
      assert.ok(
        bulkEditOptions.includes("Amount (shipping)"),
        `expected the shipping option disambiguated in the bulk-edit field picker, got: ${JSON.stringify(bulkEditOptions)}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: "Print list" and "Export CSV" used to always operate
 * on whatever the table's current search/filter was showing, silently
 * discarding a real bulk-select checkbox selection the user had already
 * made -- the exact gap bulk delete/duplicate/update don't have. Selects
 * two of three rows, then narrows the search box to a term that hides BOTH
 * selected rows (matching only the third, unselected one) -- proving the
 * selected rows still print even though they're no longer visible in the
 * current filtered view, the same "selection survives a changed search box"
 * behavior handleBulkDelete/handleBulkDuplicate already have.
 */
test("EntityPanel's Print list button prints exactly the selected rows when a selection exists, even ones hidden by the current search filter", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Dana", email: "dana@example.com" },
      { id: 2, name: "Noa", email: "noa@example.com" },
      { id: 3, name: "Omer", email: "omer@example.com" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCustomerListFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderCustomerPanel();
      await waitForCondition(() => document.querySelectorAll("tbody .select-col input").length === 3);

      const rowCheckboxes = [...document.querySelectorAll("tbody .select-col input")] as HTMLInputElement[];
      fireEvent.click(rowCheckboxes[0]); // Dana
      fireEvent.click(rowCheckboxes[2]); // Omer

      fireEvent.change(document.querySelector(".entity-search")!, { target: { value: "Noa" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print"))!;
      assert.match(printListBtn.textContent ?? "", /2/, "the button label must reflect the real selected count (2), not the filtered visible count (1)");
      fireEvent.click(printListBtn);

      await waitForCondition(() => printCalls === 1);

      const sheetText = document.querySelector(".print-list-sheet")!.textContent ?? "";
      assert.match(sheetText, /Dana/, "a selected record must print even though the current search hides it");
      assert.match(sheetText, /Omer/, "a selected record must print even though the current search hides it");
      assert.doesNotMatch(sheetText, /Noa/, "the one unselected (but search-visible) record must NOT print");
      assert.match(sheetText, /2 records/, "the footer must report the real selected count (2), not the search-filtered count (1)");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Regression test for round 487's finding: with nothing selected,
 * selectedOrAllRecords's own contract is "export what the table is
 * currently showing" -- but every call site passed the flat visibleRecords
 * instead of the grouping/collapse-aware effectivelyVisibleRecords (the
 * same value round 486 already introduced for "select all"), so Export
 * CSV silently included a collapsed group's hidden records too. Confirms
 * Export CSV with nothing selected, while "Won" is collapsed, excludes
 * Won's own records. Copy uses the exact same recordsToCsv(...,
 * selectedOrAllRecords(...)) call as Export CSV, so this one test covers
 * both code paths.
 */
test("EntityPanel's Export CSV button (nothing selected) excludes records hidden inside a collapsed group", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
      { id: 3, name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.ok(
        !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Beta Inc")),
        "the 'Won' group must actually be collapsed before testing export",
      );

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      fireEvent.click(exportBtn);

      await waitForCondition(() => capturedBlob !== null);
      const csvText = await (capturedBlob as unknown as Blob).text();
      assert.match(csvText, /Acme Corp/, "the one visible record must still be exported");
      assert.doesNotMatch(csvText, /Beta Inc/, "a record hidden inside a collapsed group must not be exported");
      assert.doesNotMatch(csvText, /Gamma LLC/, "a record hidden inside a collapsed group must not be exported");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

/**
 * Print-list sibling of the Export CSV regression test above -- same
 * round-487 finding, same underlying selectedOrAllRecords call.
 */
test("EntityPanel's Print list button (nothing selected) excludes records hidden inside a collapsed group", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
      { id: 3, name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.ok(
        !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Beta Inc")),
        "the 'Won' group must actually be collapsed before testing print",
      );

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print"))!;
      fireEvent.click(printListBtn);
      await waitForCondition(() => printCalls === 1);

      const sheetText = document.querySelector(".print-list-sheet")!.textContent ?? "";
      assert.match(sheetText, /Acme Corp/, "the one visible record must still print");
      assert.doesNotMatch(sheetText, /Beta Inc/, "a record hidden inside a collapsed group must not print");
      assert.doesNotMatch(sheetText, /Gamma LLC/, "a record hidden inside a collapsed group must not print");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Round 804's finding: the two tests above confirm effectivelyVisibleRecords
 * correctly excludes a collapsed group's records -- but only while still in
 * Table view, the only place grouping/collapsing can be set from. Board and
 * Calendar views render every record straight from visibleRecords, with no
 * "collapsed" concept of their own, yet groupFieldName/collapsedGroups are
 * view-mode-agnostic state that survives switching views, and the toolbar's
 * Copy/Export-CSV/Print-list buttons read effectivelyVisibleRecords
 * unconditionally in every view. Before this fix, grouping by "status" in
 * Table, collapsing the "won" group, then switching to Board view (which
 * visibly shows every record, including "won" ones, with no indication
 * anything is collapsed) still silently excluded those same records from
 * the exported CSV -- a mismatch between what the screen shows and what
 * gets exported. effectivelyVisibleRecords now only applies the collapse
 * filter when viewMode === "table".
 */
test("EntityPanel's Export CSV button includes every record once the user leaves Table view, even with a group still collapsed from before", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
      { id: 3, name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.ok(
        !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Beta Inc")),
        "the 'Won' group must actually be collapsed before switching views",
      );

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 3);
      assert.ok(
        document.querySelectorAll(".board-card").length === 3,
        "Board view must show all 3 records -- it has no 'collapsed group' concept of its own",
      );

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      fireEvent.click(exportBtn);

      await waitForCondition(() => capturedBlob !== null);
      const csvText = await (capturedBlob as unknown as Blob).text();
      assert.match(csvText, /Acme Corp/, "the never-collapsed record must still be exported");
      assert.match(csvText, /Beta Inc/, "a record from a group collapsed back in Table view must export once in Board view");
      assert.match(csvText, /Gamma LLC/, "a record from a group collapsed back in Table view must export once in Board view");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

/**
 * Round 821's finding: effectivelyVisibleRecords' viewMode === "table" gate
 * assumed Board/Calendar views have "no 'collapsed' concept of their own" --
 * true for Calendar, but false for Board: collapsedBoardColumns hides that
 * column's cards from the screen the exact same way a collapsed Table group
 * hides its rows ("!collapsed && column.records.map" in the Board render).
 * Collapsing a Board column still silently exported/copied/printed its
 * hidden cards -- the mirror image of round 804's own finding (stale Table
 * collapse leaking into a Board/Calendar export), for the one collapse
 * mechanism Board view actually does have.
 */
test("EntityPanel's Export CSV button (nothing selected) excludes records hidden inside a collapsed Board column", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
      { id: 3, name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 3);

      // status's enumValues are ["new", "won", "lost"] -- columns render in
      // that declared order, so index 1 is "won" (Beta Inc, Gamma LLC).
      const columnToggles = Array.from(document.querySelectorAll(".board-column-toggle")) as HTMLButtonElement[];
      fireEvent.click(columnToggles[1]);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);
      assert.ok(
        !Array.from(document.querySelectorAll(".board-card")).some((c) => c.textContent?.includes("Beta Inc")),
        "the 'won' column must actually be collapsed before testing export",
      );

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      fireEvent.click(exportBtn);

      await waitForCondition(() => capturedBlob !== null);
      const csvText = await (capturedBlob as unknown as Blob).text();
      assert.match(csvText, /Acme Corp/, "the never-collapsed record must still be exported");
      assert.doesNotMatch(csvText, /Beta Inc/, "a record hidden inside a collapsed Board column must not be exported");
      assert.doesNotMatch(csvText, /Gamma LLC/, "a record hidden inside a collapsed Board column must not be exported");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

/**
 * Regression test for round 499's finding: round 487 (above) fixed Export
 * CSV/Copy/Print's own actions to use the grouping/collapse-aware
 * effectivelyVisibleRecords instead of the flat visibleRecords, but never
 * touched the three buttons' own `disabled` props, which still gated on
 * visibleRecords.length -- so with every group collapsed (visibleRecords
 * still > 0, effectivelyVisibleRecords === 0) and nothing selected, the
 * buttons stayed enabled even though clicking them now produces an
 * effectively-empty CSV/copy/print with no visible records at all.
 */
test("EntityPanel's Export CSV/Copy/Print buttons disable once every group is collapsed, leaving nothing visible", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      const copyBtn = document.querySelector(".copy-records-btn") as HTMLButtonElement;
      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print"))!;
      assert.strictEqual(exportBtn.disabled, false, "with records visible and grouping off, Export CSV must start enabled");

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      // Collapse BOTH groups -- visibleRecords (the flat, pre-collapse list)
      // still has 2 records, but effectivelyVisibleRecords is now empty.
      // Note: "table tbody tr" includes the group *header* rows themselves
      // (confirmed by the sibling collapsed-group tests above, which count
      // headers + remaining data rows together), so with 2 groups the count
      // never reaches 0 -- it's the data rows specifically that must vanish.
      for (const headerRow of Array.from(document.querySelectorAll(".entity-group-header-row"))) {
        fireEvent.click(headerRow.querySelector(".entity-group-toggle") as HTMLButtonElement);
      }
      await waitForCondition(
        () => !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Acme Corp") || r.textContent?.includes("Beta Inc")),
      );

      assert.strictEqual(exportBtn.disabled, true, "Export CSV must disable once every group is collapsed and nothing is visible");
      assert.strictEqual(copyBtn.disabled, true, "Copy must disable once every group is collapsed and nothing is visible");
      assert.strictEqual(printListBtn.disabled, true, "Print list must disable once every group is collapsed and nothing is visible");

      // Re-expanding one group restores a real visible record, so the
      // buttons must re-enable rather than staying stuck disabled.
      const firstToggle = document.querySelector(".entity-group-header-row .entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(firstToggle);
      await waitForCondition(() => Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Acme Corp") || r.textContent?.includes("Beta Inc")));
      assert.strictEqual(exportBtn.disabled, false, "Export CSV must re-enable once a group is re-expanded");
      assert.strictEqual(copyBtn.disabled, false, "Copy must re-enable once a group is re-expanded");
      assert.strictEqual(printListBtn.disabled, false, "Print list must re-enable once a group is re-expanded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (441): a long-standing, known-but-deprioritized small
 * candidate from round 377's own notes -- confirmed still present in the
 * current stylesheet. `.print-field` is `display: flex` with `dd` at
 * `flex: 1`; a flex item's default `min-width` resolves to its *min-content*
 * size, which for plain text is the width of its single longest unbreakable
 * token (a URL, a long SKU/reference number, a long Hebrew word with no
 * spaces). With no `min-width: 0` on the flex item and no `overflow-wrap`
 * on the text, that one long token forces `dd` (and the whole print sheet)
 * wider than the printed page's content box -- and since `@media print`
 * positions the sheet as `position: absolute; inset: 0` with no horizontal
 * scroll possible on a physical page, the overflow is simply clipped off
 * with no error or indication. `.print-list-sheet td` has the identical
 * gap (no `overflow-wrap`, so one long cell value can force the table
 * wider than the page). This exact CSS shape has already been fixed four
 * other times in this same stylesheet (`.checkpoint-list li strong`,
 * `.collab-list li strong`, `.whatsapp-log-body`, `.my-project-open
 * strong`), always with the same `min-width: 0` + `overflow-wrap: anywhere`
 * pairing -- `.print-field`/`.print-list-sheet` simply never received it.
 * jsdom has no layout engine and can't detect real overflow/clipping (see
 * the print tests just above, which only ever assert on textContent), so
 * this reads styles.css's own source directly -- the same discipline this
 * routine already uses for codegen.ts's generated-app template checks.
 */
test("the print sheet's CSS lets a long, unbreakable field value wrap instead of overflowing/clipping off the printed page", () => {
  const stylesCss = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  const printFieldDd = stylesCss.match(/\.print-field dd \{[\s\S]*?\}/)?.[0];
  assert.ok(printFieldDd, "expected a .print-field dd rule in styles.css");
  assert.match(printFieldDd!, /min-width:\s*0/, ".print-field dd must have min-width: 0 so its flex item can actually shrink below its text's min-content width");
  assert.match(printFieldDd!, /overflow-wrap:\s*anywhere/, ".print-field dd must allow a long unbreakable value to wrap instead of overflowing the printed page");

  const printListCell = stylesCss.match(/\.print-list-sheet th,\s*\n\.print-list-sheet td \{[\s\S]*?\}/)?.[0];
  assert.ok(printListCell, "expected a .print-list-sheet th/td rule in styles.css");
  assert.match(printListCell!, /overflow-wrap:\s*anywhere/, ".print-list-sheet td must allow a long unbreakable cell value to wrap instead of forcing the table wider than the printed page");
});

/**
 * CSV sibling of the print-list test above: stubs URL.createObjectURL the
 * same way BuildProgress.test.ts's own download test does (jsdom has no
 * real Blob-URL machinery) to read back the actual generated CSV content,
 * not just assume the click did something.
 */
test("EntityPanel's Export CSV button downloads exactly the selected rows' CSV when a selection exists", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Dana", email: "dana@example.com" },
      { id: 2, name: "Noa", email: "noa@example.com" },
      { id: 3, name: "Omer", email: "omer@example.com" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCustomerListFetch(store) as typeof fetch;
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    try {
      renderCustomerPanel();
      await waitForCondition(() => document.querySelectorAll("tbody .select-col input").length === 3);

      const rowCheckboxes = [...document.querySelectorAll("tbody .select-col input")] as HTMLInputElement[];
      fireEvent.click(rowCheckboxes[0]); // Dana
      fireEvent.click(rowCheckboxes[2]); // Omer

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      assert.match(exportBtn.textContent ?? "", /2/, "the button label must reflect the real selected count (2)");
      fireEvent.click(exportBtn);

      await waitForCondition(() => capturedBlob !== null);
      const csvText = await (capturedBlob as unknown as Blob).text();
      assert.match(csvText, /Dana/, "the exported CSV must include the selected record Dana");
      assert.match(csvText, /Omer/, "the exported CSV must include the selected record Omer");
      assert.doesNotMatch(csvText, /Noa/, "the exported CSV must NOT include the unselected record Noa");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

/**
 * Round 846's finding: every other filename-bearing download in this
 * codebase (project export/backup in api.ts, the calendar ICS export just
 * below in this same file via downloadCalendarIcs) routes the name
 * through safeDownloadName first -- stripping path separators and
 * Windows-reserved characters a raw entity name could otherwise carry
 * straight into a saved file's own name (EntitySchema's own `name` has no
 * character-set restriction, per round 844/845's own finding). CSV export
 * was the one download site built with an inline Blob+anchor that skipped
 * it, handing entity.name straight to `a.download`. Confirms a "/" in the
 * entity's own name never reaches the saved file's name unescaped.
 */
test("EntityPanel's Export CSV button sanitizes the entity name before using it as the downloaded file's own name", async () => {
  await withJsdom(async () => {
    const unsafeNamedEntity: Entity = {
      name: "Foo/Bar",
      label: "Foo/Bar",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    };
    const store: EntityRecord[] = [{ id: 1, name: "Dana" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Foo%2FBar") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:mock-url";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    const originalCreateElement = document.createElement.bind(document) as typeof document.createElement;
    let capturedDownload: string | undefined;
    (document as unknown as { createElement: typeof document.createElement }).createElement = ((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === "a") {
        const originalClick = (el as HTMLAnchorElement).click.bind(el);
        (el as HTMLAnchorElement).click = () => {
          capturedDownload = (el as HTMLAnchorElement).download;
          originalClick();
        };
      }
      return el;
    }) as typeof document.createElement;
    try {
      renderEntityPanel({ entity: unsafeNamedEntity, allEntities: [unsafeNamedEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 1);

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      fireEvent.click(exportBtn);

      await waitForCondition(() => capturedDownload !== undefined);
      assert.ok(capturedDownload, "expected the anchor's own click() to have been called with a real download name set");
      assert.ok(!capturedDownload!.includes("/"), "the downloaded file's own name must not contain the raw '/' from the entity's own name");
      assert.equal(capturedDownload, "FooBar.csv", "safeDownloadName must have stripped the unsafe character, matching downloadCalendarIcs' own sibling behavior");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      (document as unknown as { createElement: typeof document.createElement }).createElement = originalCreateElement;
    }
  });
});

/**
 * New in this round: EntityPanel -- the single most-used screen in the
 * app -- was the one data-bearing panel left with no "Copy" action next
 * to its Download/Export button, unlike BusinessTwinPanel/HistoryPanel/
 * GlobalSearchPanel/WhatsAppPanel, all of which already let you copy a
 * shareable report straight to the clipboard instead of downloading a
 * file first. Mirrors HistoryPanel.test.ts's own copy-button test exactly:
 * confirms the real navigator.clipboard.writeText receives the exact same
 * CSV text handleExportCsv would have downloaded, the button shows a real
 * "Copied!" confirmation, and (via a real mocked setTimeout tick, not a
 * hardcoded wait) fades back to normal 2 seconds later.
 */
test("EntityPanel's copy button writes the real CSV text to the clipboard, shows Copied, then reverts", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Dana", email: "dana@example.com" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCustomerListFetch(store) as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderCustomerPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = document.querySelector(".copy-records-btn") as HTMLButtonElement;
      assert.ok(copyButton, "expected a real Copy button in the toolbar");
      assert.equal(copyButton.textContent, "📋 Copy");
      assert.equal(
        copyButton.getAttribute("aria-live"),
        "polite",
        "the copy button's own changing label must be announced to screen readers, not just silently change visually",
      );
      assert.equal(copyButton.getAttribute("aria-atomic"), "true", "the whole button's text must be re-announced, not just the changed part");

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Dana/, "the copied text must be the real CSV, not a placeholder");
      assert.match(writtenText!, /dana@example\.com/, "the copied text must include every real field, not just the name");
      assert.equal(copyButton.textContent, "✅ Copied!", "must show the real Copied confirmation, not silently do nothing");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton.textContent, "📋 Copy", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/** The other half: a real rejection (denied permission, insecure context) must show a real failure label, not fail silently or crash. */
test("EntityPanel's copy button shows a failure label when navigator.clipboard.writeText rejects", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Dana", email: "dana@example.com" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockCustomerListFetch(store) as typeof fetch;

    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });

    try {
      renderCustomerPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = document.querySelector(".copy-records-btn") as HTMLButtonElement;

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(copyButton.textContent, "Copy failed", "a real clipboard rejection must show a real failure label");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton.textContent, "📋 Copy", "must revert to the normal label even after a failure");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * New in this round: a "Columns" menu in the toolbar lets a wide entity's
 * table drop columns you don't need on screen right now. Hides the
 * "Status" column via its checkbox, confirms the header and every row's
 * cell for it actually disappear from the real table (not just some
 * in-memory flag), confirms the guard against hiding the LAST remaining
 * visible column (unchecking "Name" while "Status" is already hidden must
 * be a no-op, so the table can never end up with zero columns), then
 * unmounts and re-renders EntityPanel from scratch -- simulating a page
 * reload -- to prove the hidden-columns choice actually persisted via
 * columnVisibility's real localStorage-backed store, not just component
 * state that a fresh mount would lose.
 */
test("EntityPanel's Columns menu hides/shows table columns, guards against hiding the last visible one, and persists the choice across a remount", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(document.querySelectorAll("thead th").length, 5, "expected select-col + Name + Status + the built-in Created column + the trailing actions column to start");

      const columnsBtn = document.querySelector(".columns-menu-btn") as HTMLButtonElement;
      assert.ok(columnsBtn, "expected a Columns menu button in the toolbar");
      fireEvent.click(columnsBtn);

      const checkboxes = Array.from(document.querySelectorAll(".columns-menu-item input[type=checkbox]")) as HTMLInputElement[];
      assert.equal(checkboxes.length, 2, "expected one checkbox per field (Name, Status)");
      assert.ok(
        checkboxes.every((c) => c.checked),
        "both columns must start checked (visible), matching the table's actual starting state",
      );

      const statusCheckbox = Array.from(document.querySelectorAll(".columns-menu-item")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      )!.querySelector("input") as HTMLInputElement;
      fireEvent.click(statusCheckbox);

      await waitForCondition(() => document.querySelectorAll("thead th").length === 4);
      assert.doesNotMatch(
        document.querySelector("thead")!.textContent ?? "",
        /Status/,
        "the Status header must actually be gone from the real table, not just visually hidden",
      );
      for (const row of document.querySelectorAll("table tbody tr")) {
        assert.equal(row.querySelectorAll("td").length, 4, "each row must have dropped its Status cell too (select-col + Name + Created + actions)");
      }

      const nameCheckbox = Array.from(document.querySelectorAll(".columns-menu-item")).find((el) =>
        /Name/.test(el.textContent ?? ""),
      )!.querySelector("input") as HTMLInputElement;
      fireEvent.click(nameCheckbox);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        document.querySelectorAll("thead th").length,
        4,
        "unchecking the LAST visible column must be a no-op -- the table must never end up with zero data columns",
      );

      cleanup();
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.equal(
        document.querySelectorAll("thead th").length,
        4,
        "a fresh mount (simulating a page reload) must still see Status hidden -- a real persisted choice, not just in-memory state",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: EntityPanel.tsx's own doc comment above visibleFields
 * says CSV export and the print sheets are "whole-record actions" that
 * deliberately ignore a hidden column, same as RecordPrintSheet (per-row
 * Print) and handleExportCsv already do -- but RecordListPrintSheet's call
 * site was passing visibleFields (the hidden-filtered list) instead of
 * orderedFields, dropping a hidden column's data from "Print list" alone.
 * Hides the Status column via the Columns menu first (as the test above
 * does), confirming it's genuinely gone from the on-screen table, then
 * opens Print list and confirms the SAME hidden field's data is still
 * present there -- matching Export CSV and per-row Print's behavior on the
 * identical hidden column, not the on-screen table's.
 */
test("EntityPanel's Print list action includes a column the user has hidden from the on-screen table, since it's a whole-record action like CSV export and per-record Print", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const columnsBtn = document.querySelector(".columns-menu-btn") as HTMLButtonElement;
      fireEvent.click(columnsBtn);
      const statusCheckbox = Array.from(document.querySelectorAll(".columns-menu-item")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      )!.querySelector("input") as HTMLInputElement;
      fireEvent.click(statusCheckbox);

      await waitForCondition(() => document.querySelectorAll("thead th").length === 4);
      assert.doesNotMatch(
        document.querySelector("thead")!.textContent ?? "",
        /Status/,
        "the on-screen table must have genuinely dropped the Status column",
      );

      const printListBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Print list"))!;
      fireEvent.click(printListBtn);
      await waitForCondition(() => printCalls === 1);

      const sheetText = document.querySelector(".print-list-sheet")!.textContent ?? "";
      assert.match(
        sheetText,
        /Status/,
        "Print list must still include the Status column header even though it's hidden from the on-screen table -- it's a whole-record action, same as CSV export",
      );
      assert.match(sheetText, /Won/, "Print list must still include the hidden column's actual data (Globex's status)");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Round 615: round 597 fixed RecordListPrintSheet ("Print list") to use
 * orderedFields instead of visibleFields, so it both includes hidden columns
 * AND respects the user's drag-reordered column sequence. The other three
 * whole-record actions -- Export CSV, Copy, and the per-record Print
 * (RecordPrintSheet) -- already got the "include hidden columns" half of
 * that (they always used entity.fields), but never the "respect the drag
 * order" half, since entity.fields is the entity's own natural order, not
 * orderedFields. Persists a real reordered columnOrder via localStorage
 * (the same round-trip the drag-and-drop reorder test above exercises) and
 * confirms all three siblings now emit Status before Name, matching the
 * on-screen table and Print list.
 */
test("EntityPanel's Export CSV, Copy, and per-record Print all honor the user's drag-reordered column order, not just the on-screen table and Print list", async () => {
  await withJsdom(async () => {
    localStorage.setItem("forge.columnOrder", JSON.stringify({ "proj1:Deal": ["status", "name"] }));
    const store: EntityRecord[] = [{ id: 1, name: "Globex", status: "won" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    let capturedBlob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.deepEqual(
        [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent),
        ["Status", "Name"],
        "the persisted reorder must already be in effect on the on-screen table",
      );

      const exportBtn = document.querySelector(".csv-export-btn") as HTMLButtonElement;
      fireEvent.click(exportBtn);
      await waitForCondition(() => capturedBlob !== null);
      const csvText = await (capturedBlob as unknown as Blob).text();
      assert.ok(
        csvText.indexOf("Status") < csvText.indexOf("Name"),
        "Export CSV's header row must list Status before Name, matching the reordered table",
      );

      await act(async () => {
        fireEvent.click(document.querySelector(".copy-records-btn") as HTMLButtonElement);
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(typeof writtenText, "string", "Copy must have written real CSV text to the clipboard");
      assert.ok(
        writtenText!.indexOf("Status") < writtenText!.indexOf("Name"),
        "Copy's CSV text must also list Status before Name, matching Export CSV and the reordered table",
      );

      const printBtn = Array.from(document.querySelectorAll("table tbody tr")[0].querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Print"),
      )!;
      fireEvent.click(printBtn);
      await waitForCondition(() => printCalls === 1);
      const dtLabels = [...document.querySelectorAll(".print-record-sheet dt")].map((dt) => dt.textContent);
      assert.deepEqual(
        dtLabels,
        ["Status", "Name"],
        "the per-record Print sheet must list Status before Name too, not the entity's original declared order",
      );
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      localStorage.removeItem("forge.columnOrder");
    }
  });
});

/**
 * Round 670: round 615 ported the "respect the user's drag-reordered
 * columns" fix to Export CSV, Copy, and per-record Print -- but Board
 * view's own BoardCard, a fifth whole-record render path in this same
 * file, was never included in that audit and still mapped over the
 * entity's raw declared field order (entity.fields) instead of
 * orderedFields. After a real column reorder, the on-screen table shows
 * Phone before Name, but a board card still showed Name before Phone.
 */
test("EntityPanel's board cards list their fields in the user's drag-reordered column order, not the entity's original declared order", async () => {
  await withJsdom(async () => {
    const dealWithPhone: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: false },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["new", "won", "lost"],
          enumLabels: { new: "New", won: "Won", lost: "Lost" },
        },
      ],
    };
    localStorage.setItem("forge.columnOrder", JSON.stringify({ "proj1:Deal": ["phone", "name", "status"] }));
    const store: EntityRecord[] = [{ id: 1, name: "Globex", phone: "555-1234", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ entity: dealWithPhone, allEntities: [dealWithPhone] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.deepEqual(
        [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent),
        ["Phone", "Name", "Status"],
        "the persisted reorder must already be in effect on the on-screen table",
      );

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);
      const boardLabels = Array.from(document.querySelectorAll(".board-card-field .muted.small")).map((s) => s.textContent);
      assert.deepEqual(
        boardLabels,
        ["Phone", "Name"],
        "the board card must list Phone before Name, matching the reordered table, not the entity's original declared order",
      );
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem("forge.columnOrder");
    }
  });
});

/**
 * Round 678: the same audit round 670 ran for board cards turned up one
 * more surface still following the old pattern -- the add/edit record
 * form itself, the primary data-entry surface in this whole panel. It
 * mapped over entity.fields (the entity's raw declared order) instead of
 * orderedFields, so after a real column reorder the on-screen table
 * showed Phone before Name, but the form a user actually types into
 * still asked for Name before Phone. The bulk-edit field picker
 * (bulkEditableFields, a sibling whole-record field list) had the exact
 * same gap, fixed in the same pass.
 */
test("EntityPanel's add/edit record form lists fields in the user's drag-reordered column order, not the entity's original declared order", async () => {
  await withJsdom(async () => {
    const dealWithPhone: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: false },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["new", "won", "lost"],
          enumLabels: { new: "New", won: "Won", lost: "Lost" },
        },
      ],
    };
    localStorage.setItem("forge.columnOrder", JSON.stringify({ "proj1:Deal": ["phone", "name", "status"] }));
    const store: EntityRecord[] = [{ id: 1, name: "Globex", phone: "555-1234", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ entity: dealWithPhone, allEntities: [dealWithPhone] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.deepEqual(
        [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent),
        ["Phone", "Name", "Status"],
        "the persisted reorder must already be in effect on the on-screen table",
      );

      const formFieldLabels = Array.from(document.querySelectorAll(".record-form .field-row .field-label")).map((el) =>
        (el.textContent ?? "").replace("✏️", "").replace(" *", "").trim(),
      );
      assert.deepEqual(
        formFieldLabels,
        ["Phone", "Name", "Status"],
        "the add/edit form must list Phone before Name, matching the reordered table, not the entity's original declared order",
      );

      // The bulk-edit "set field" picker is the same sibling gap
      // round 670's own audit found for board cards -- it reads from
      // bulkEditableFields, which used to filter the entity's raw
      // declared order rather than orderedFields.
      const rowCheckbox = document.querySelector('td.select-col input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(rowCheckbox);
      await waitForCondition(() => document.querySelector(".bulk-edit-field-label select") !== null);
      const bulkEditOptions = Array.from(document.querySelectorAll(".bulk-edit-field-label option"))
        .filter((o) => (o as HTMLOptionElement).value !== "")
        .map((o) => o.textContent);
      assert.deepEqual(
        bulkEditOptions,
        ["Phone", "Name", "Status"],
        "the bulk-edit field picker must also list Phone before Name, matching the reordered table",
      );
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem("forge.columnOrder");
    }
  });
});

/**
 * Round 621: round 615 made Export CSV, Copy, and per-record Print all
 * honor the user's drag-reordered column order (orderedFields), but the
 * "Columns" visibility menu's own checkbox list -- the one UI a person
 * actually uses to find "the 3rd column from the left" and hide/show it --
 * was never included in that audit and still mapped over the entity's raw
 * declared field order. After a real reorder, the on-screen table shows
 * Status before Name, but the Columns menu still lists Name before Status,
 * making it genuinely hard to match a checkbox to its visible column.
 */
test("EntityPanel's Columns menu lists checkboxes in the user's drag-reordered column order, not the entity's original declared order", async () => {
  await withJsdom(async () => {
    localStorage.setItem("forge.columnOrder", JSON.stringify({ "proj1:Deal": ["status", "name"] }));
    const store: EntityRecord[] = [{ id: 1, name: "Globex", status: "won" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.deepEqual(
        [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent),
        ["Status", "Name"],
        "the persisted reorder must already be in effect on the on-screen table",
      );

      const columnsBtn = document.querySelector(".columns-menu-btn") as HTMLButtonElement;
      fireEvent.click(columnsBtn);
      const labels = [...document.querySelectorAll(".columns-menu-item")].map((el) => el.textContent?.trim());
      assert.deepEqual(
        labels,
        ["Status", "Name"],
        "the Columns menu's own checkbox list must match the reordered table, not the entity's original declared order",
      );
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem("forge.columnOrder");
    }
  });
});

/**
 * Round 684: rounds 615/621/670/678 turned "respect orderedFields, not the
 * entity's raw declared order" into a repeated audit across every
 * whole-record render path -- CSV export/Copy/Print, the Columns menu,
 * board cards, the add/edit form, and the bulk-edit field picker. The
 * per-field filter dropdowns and the "Group by" dropdown's own option list
 * were never swept into that audit: both read straight from `entity.fields`
 * (`filterableFields`/`groupableFields`), sitting textually before
 * `orderedFields` even existed -- the identical positioning hazard round
 * 678's own fix comment called out for `bulkEditableFields`.
 */
test("EntityPanel's per-field filter dropdowns and 'Group by' option list both honor the user's drag-reordered column order, not the entity's original declared order", async () => {
  await withJsdom(async () => {
    const dealWithPriority: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["new", "won", "lost"],
          enumLabels: { new: "New", won: "Won", lost: "Lost" },
        },
        {
          name: "priority",
          label: "Priority",
          type: "enum",
          required: false,
          enumValues: ["low", "high"],
          enumLabels: { low: "Low", high: "High" },
        },
        { name: "name", label: "Name", type: "text", required: true },
      ],
    };
    localStorage.setItem("forge.columnOrder", JSON.stringify({ "proj1:Deal": ["priority", "status", "name"] }));
    const store: EntityRecord[] = [{ id: 1, name: "Globex", status: "new", priority: "high" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ entity: dealWithPriority, allEntities: [dealWithPriority] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.deepEqual(
        [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent),
        ["Priority", "Status", "Name"],
        "the persisted reorder must already be in effect on the on-screen table",
      );

      const filterLabels = Array.from(document.querySelectorAll(".entity-status-filter")).map((s) => s.getAttribute("aria-label"));
      assert.deepEqual(
        filterLabels,
        [`Filter by Priority`, `Filter by Status`],
        "the per-field filter dropdowns must appear Priority before Status, matching the reordered table, not the entity's original declared order",
      );

      const groupByOptions = Array.from(document.querySelectorAll(".entity-group-by option"))
        .filter((o) => (o as HTMLOptionElement).value !== "")
        .map((o) => o.textContent);
      assert.deepEqual(
        groupByOptions,
        ["Priority", "Status"],
        "the 'Group by' dropdown's own option list must also list Priority before Status, matching the reordered table",
      );
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem("forge.columnOrder");
    }
  });
});

/**
 * New in this round: GlobalSearchPanel's per-row "jump to record" click
 * (see GlobalSearchPanel.test.ts) carries a specific record id down through
 * App.tsx into a new highlightRecordId prop, so the person lands on the
 * exact row they searched for instead of having to re-scan the whole table
 * they just came from. Simulates the real scenario -- this same entity tab
 * already open, with a leftover search from an earlier visit still narrowing
 * the table -- by rendering first, typing a search, THEN rerendering with a
 * real highlightRecordId (exactly what happens when App.tsx passes a new
 * prop into an EntityPanel that was already mounted, since jumping to a
 * record on the tab you're already viewing doesn't remount it). Confirms
 * the leftover search gets cleared (it would otherwise hide the very row
 * this was supposed to reveal), the real target row gets highlighted, and
 * onHighlightHandled fires so the caller can clear its own copy.
 */
test("EntityPanel highlights the record named by highlightRecordId once loaded, clearing any leftover search filter that would hide it", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
      { id: 3, name: "Initech", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    let handledCount = 0;
    const onHighlightHandled = () => {
      handledCount++;
    };
    try {
      const view = render(buildEntityPanelElement({ onHighlightHandled }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "Initech" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      // Jumping to Globex's own record (id 2) while this same tab is still
      // narrowed to "Initech" -- Globex isn't even in the filtered set yet.
      view.rerender(buildEntityPanelElement({ highlightRecordId: 2, onHighlightHandled }));

      await waitForCondition(() => handledCount === 1);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal(searchBox.value, "", "the leftover search must be cleared so the highlighted row is actually visible");

      const highlighted = document.querySelectorAll(".record-row-highlighted");
      assert.equal(highlighted.length, 1, "exactly one row must be highlighted");
      assert.equal(
        (highlighted[0] as HTMLElement).getAttribute("data-record-id"),
        "2",
        "the highlighted row must be the real record named by highlightRecordId, not just the first one",
      );
      assert.match(highlighted[0].textContent ?? "", /Globex/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for a real bug found by a round 461 Explore survey: the
 * highlightRecordId effect above cleared fieldFilters/viewMode with bare
 * setFieldFilters({})/setViewMode("table") calls that only touched in-memory
 * state, never fieldFiltersPreference.ts/viewModePreference.ts's persisted
 * storage -- unlike every other mutator of these two pieces of state in this
 * file (the Clear-filters button, the view-mode buttons), which always write
 * through. Since switching entity tabs remounts EntityPanel (App.tsx renders
 * it with key={entity.name}), the persisted-load effects above re-read the
 * stale filter/view-mode the moment the user switches tabs away and back,
 * silently re-hiding the very record the jump was supposed to reveal, with
 * no reload needed. Confirms both that the persisted storage is actually
 * cleared (not just the in-memory state) and that a real unmount+remount
 * (simulating the tab switch) doesn't resurrect the stale values.
 */
test("EntityPanel's 'jump to record' clears the persisted field-filter/view-mode storage too, so a later tab switch doesn't resurrect them and re-hide the record", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
      { id: 3, createdAt: "x", name: "Initech", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    let handledCount = 0;
    const onHighlightHandled = () => {
      handledCount++;
    };
    try {
      const firstView = render(buildEntityPanelElement({ onHighlightHandled }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      // Set up exactly the state a real visit would leave behind: a status
      // filter and Board view, both persisted via their own real controls.
      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "new" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);
      assert.deepEqual(getFieldFilters("proj1", "Deal"), { status: "new" }, "sanity check: the filter must actually be persisted before the jump");
      assert.equal(getViewMode("proj1", "Deal"), "board", "sanity check: the view mode must actually be persisted before the jump");

      // Jump to Initech (id 3, status "lost") -- hidden by both the "new"
      // filter and (as a status column collapsed out of view) irrelevant in
      // Board mode too, so this only works if both get cleared for real.
      firstView.rerender(buildEntityPanelElement({ highlightRecordId: 3, onHighlightHandled }));
      await waitForCondition(() => handledCount === 1);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      assert.deepEqual(getFieldFilters("proj1", "Deal"), {}, "the persisted filter storage must be cleared too, not just the in-memory state");
      assert.equal(getViewMode("proj1", "Deal"), "table", "the persisted view-mode storage must be cleared too, not just the in-memory state");

      // Simulate the real-world trigger: switching to another tab and back
      // remounts EntityPanel (key={entity.name} in App.tsx) -- confirm the
      // stale values don't get reloaded from storage on that fresh mount.
      firstView.unmount();
      render(buildEntityPanelElement());
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal((document.querySelector(".entity-status-filter") as HTMLSelectElement).value, "", "a fresh mount must not resurrect the cleared filter");
      assert.equal(document.querySelectorAll("table").length, 1, "a fresh mount must not resurrect the cleared Board view");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for a real bug found by a round 462 Explore survey: the
 * highlightRecordId effect above (round 461) cleared fieldFilters/viewMode
 * but never groupFieldName -- a third, independently-persisted piece of
 * state that hides rows exactly as effectively. When a record lives inside
 * a COLLAPSED group, that group's rows are never rendered into the DOM at
 * all (see the table body's `{!collapsed && group.records.map(...)}`), so
 * the scroll-into-view effect finds no matching row and silently no-ops --
 * "jump to record" visibly does nothing, with no error. Confirms jumping to
 * a record inside a collapsed group actually reveals it (clears grouping
 * entirely, same as the existing filter/view-mode clears), and that the
 * persisted groupFieldName storage is cleared too, not just in-memory state.
 */
test("EntityPanel's 'jump to record' clears grouping too, so a record hidden inside a collapsed group is actually revealed", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
      { id: 3, createdAt: "x", name: "Initech", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    let handledCount = 0;
    const onHighlightHandled = () => {
      handledCount++;
    };
    try {
      const firstView = render(buildEntityPanelElement({ onHighlightHandled }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      // Group by status, then collapse the "Lost" group -- exactly where
      // Initech (id 3) lives.
      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 3);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const lostHeader = headerRows.find((r) => r.textContent?.includes("Lost"))!;
      const lostToggle = lostHeader.querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(lostToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 5); // 3 headers + 2 visible records (New's Acme, Won's Globex) -- Lost's own row is now hidden
      assert.equal(document.querySelector('tr[data-record-id="3"]'), null, "sanity check: Initech's row must genuinely be absent from the DOM while its group is collapsed");
      assert.equal(getGroupByField("proj1", "Deal"), "status", "sanity check: grouping must actually be persisted before the jump");

      // Jump to Initech (id 3) while its group is still collapsed.
      firstView.rerender(buildEntityPanelElement({ highlightRecordId: 3, onHighlightHandled }));
      await waitForCondition(() => handledCount === 1);

      assert.equal(getGroupByField("proj1", "Deal"), "", "the persisted group-by storage must be cleared too, not just the in-memory state");
      await waitForCondition(() => document.querySelector('tr[data-record-id="3"]') !== null);
      assert.equal(document.querySelectorAll(".entity-group-header-row").length, 0, "grouping must actually be turned off, not just re-expand the one group");
      assert.ok(
        (document.querySelector('tr[data-record-id="3"]') as HTMLElement).classList.contains("record-row-highlighted"),
        "Initech's row must be highlighted once it's actually revealed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 921: createPrefill is WhatsAppPanel's own "create new record from
 * this message" button's path into this panel -- carried down from App.tsx
 * the same way highlightRecordId is, for the opposite case (no existing
 * record to jump to, so a NEW one must be started instead, pre-filled with
 * the message's own phone number). Reuses startCreateForColumn's own body
 * (see its own doc comment), so this confirms the wiring end to end: the
 * create form opens (not edit mode), the named field holds the given value,
 * and onCreatePrefillHandled fires so the caller can clear its own copy.
 */
test("EntityPanel applies an incoming createPrefill by opening the create form pre-filled with that field's value", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    let handledCount = 0;
    const onCreatePrefillHandled = () => {
      handledCount++;
    };
    try {
      const view = render(buildEntityPanelElement({ onCreatePrefillHandled }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      view.rerender(buildEntityPanelElement({ createPrefill: { fieldName: "name", value: "972521112233" }, onCreatePrefillHandled }));

      await waitForCondition(() => handledCount === 1);
      const nameInput = document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      assert.equal(nameInput.value, "972521112233", "the named field must hold the prefilled value");

      const submitButton = document.querySelector(".form-actions button[type=submit]") as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Add", "must be in create mode, not edit mode");
      // Compared as a boolean, not the raw DOM node itself -- an
      // assert.equal(domNode, null) that unexpectedly fails tries to format
      // the real (circular) DOM node for its diff message and can hang for
      // minutes instead of failing fast (see round 666's own documented
      // lesson in docs/roadmap.md).
      assert.equal(document.querySelector(".form-actions button.secondary") !== null, false, "no Cancel button -- confirms this isn't edit mode");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the table's own sort was always single-column --
 * clicking a second header threw away the first one entirely, so there
 * was no way to sort by, say, status and THEN by name within each status.
 * Uses a real tie on the primary key (two "new" deals) so the secondary
 * key's own effect is unambiguous, and deliberately stores them in an
 * order ("Zeta" before "Acme") that would look identical to a broken
 * secondary sort AND to no secondary sort at all if the two happened to
 * already be alphabetical -- only a real working secondary key reorders
 * them to Acme-before-Zeta.
 */
test("EntityPanel's column headers support a real secondary sort key via shift+click, breaking ties left by the primary column", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Acme Corp", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const statusHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      const nameHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Name/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      assert.ok(statusHeader && nameHeader, "expected sortable Status and Name column headers");

      fireEvent.click(statusHeader);
      await waitForCondition(() => {
        const names = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
        return /Zeta/.test(names[0]) && /Acme/.test(names[1]) && /Globex/.test(names[2]);
      });
      assert.equal(
        document.querySelectorAll(".sort-priority").length,
        0,
        "with only one active sort key, no priority badge should show at all",
      );

      fireEvent.click(nameHeader, { shiftKey: true });
      await waitForCondition(() => {
        const names = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
        return /Acme/.test(names[0]) && /Zeta/.test(names[1]) && /Globex/.test(names[2]);
      });
      const rowsAfterSecondarySort = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
      assert.ok(
        /Acme/.test(rowsAfterSecondarySort[0]) && /Zeta/.test(rowsAfterSecondarySort[1]) && /Globex/.test(rowsAfterSecondarySort[2]),
        "shift+click on Name must add it as a tiebreaker, reordering the tied 'new' group to Acme-before-Zeta without moving Globex out of last place",
      );

      // Column order in the table is Name then Status (DEAL_ENTITY's own
      // declared field order), so the Name header's badge ("2", the
      // secondary key) appears before the Status header's badge ("1", the
      // primary key) -- DOM order, not sort priority order.
      const priorityBadges = Array.from(document.querySelectorAll(".sort-priority")).map((el) => el.textContent);
      assert.deepEqual(
        priorityBadges,
        ["2", "1"],
        "once there are 2 active sort keys, each active header must show its own real priority number",
      );

      // A plain (non-shift) click on Name must collapse back to a single key.
      fireEvent.click(nameHeader);
      await waitForCondition(() => document.querySelectorAll(".sort-priority").length === 0);
      const rowsAfterPlainClick = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
      assert.ok(
        /Acme/.test(rowsAfterPlainClick[0]) && /Globex/.test(rowsAfterPlainClick[1]) && /Zeta/.test(rowsAfterPlainClick[2]),
        "a plain click must replace the whole sort with just this one column (Name asc: Acme, Globex, Zeta), dropping Status entirely",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: deleting a record used to call the real DELETE
 * endpoint the instant the confirm dialog closed, with no way back except
 * the confirm dialog itself (round 73). Now the row disappears from view
 * immediately, but the actual API call is delayed behind an undo window --
 * clicking the new Undo button in that window must restore the row and
 * genuinely skip the DELETE call entirely, not just visually.
 */
test("EntityPanel's delete removes the row immediately and shows an Undo toast, and clicking Undo restores it without ever calling the real delete API", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      // Enabled only now, AFTER the initial render/fetch has already
      // settled -- React's own jsdom-fallback scheduler uses setTimeout
      // internally, so mocking it any earlier stalls the very first
      // render before this test gets anywhere near its own delete flow.
      t.mock.timers.enable({ apis: ["setTimeout"] });

      fireEvent.click(document.querySelector(".danger") as HTMLButtonElement);

      assert.equal(document.querySelectorAll("table tbody tr").length, 0, "the row must disappear from view immediately");
      assert.equal(deletedIds.length, 0, "the real DELETE request must NOT have fired yet -- it's still inside the undo window");

      const toast = document.querySelector(".entity-undo-toast");
      assert.ok(toast, "expected an Undo toast to appear once a delete is pending");
      assert.match(toast!.textContent ?? "", /Acme Corp/, "the toast must name the actual record that was deleted");

      fireEvent.click(toast!.querySelector("button") as HTMLButtonElement);

      assert.equal(document.querySelectorAll("table tbody tr").length, 1, "clicking Undo must restore the row");
      assert.equal(document.querySelector(".entity-undo-toast"), null, "the toast must disappear once undone");

      act(() => {
        t.mock.timers.tick(10_000);
      });
      assert.equal(deletedIds.length, 0, "even long after the undo window would have elapsed, undoing must have genuinely cancelled the real delete");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 739: Calendar view's only interaction with a record was clicking
 * its chip to open the shared record-form for editing -- unlike Table
 * (its own row Delete button) and Board (BoardCard's own Delete button),
 * Calendar had no delete affordance anywhere, since the shared record-form
 * itself only ever rendered Save/Cancel. This gives the form a real
 * Delete button too, so every view that opens it (including Calendar) can
 * now delete the record actually being edited, going through the exact
 * same confirm + undo-toast flow the table row's own Delete button
 * already uses (handleDelete is the one shared function). Deliberately
 * gated on editingId != null -- there's nothing to delete while creating
 * a brand-new, not-yet-saved record.
 */
test("EntityPanel's record-form gains a real Delete button once editing an existing record, which deletes it via the same undo-toast flow as the table row's own Delete button", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        document.querySelector(".form-actions button.danger"),
        null,
        "a brand-new, not-yet-saved record has nothing to delete -- no Delete button while editingId is null",
      );

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Acme Corp");

      const formDeleteButton = document.querySelector(".form-actions button.danger") as HTMLButtonElement;
      assert.ok(formDeleteButton, "expected a real Delete button in the form once editing an existing record");

      fireEvent.click(formDeleteButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 0);
      assert.equal(deletedIds.length, 0, "the real DELETE request must not have fired yet -- still inside the undo window, same as every other Delete button");

      const toast = document.querySelector(".entity-undo-toast");
      assert.ok(toast, "expected the same real Undo toast the table row's own Delete button produces");
      assert.match(toast!.textContent ?? "", /Acme Corp/, "the toast must name the actual record that was deleted");

      assert.equal(document.querySelector(".form-actions button.secondary"), null, "deleting from the form must also close it -- the Cancel button must disappear");
      const submitButton = document.querySelector(".form-actions button[type=submit]") as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Add", "the submit button must revert to create-mode wording once the form closes itself after deleting");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

test("EntityPanel's record-form Delete button leaves the in-progress edit open and completely untouched when the confirm dialog is cancelled", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => false) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Acme Corp");

      fireEvent.click(document.querySelector(".form-actions button.danger") as HTMLButtonElement);

      assert.equal(document.querySelectorAll("table tbody tr").length, 1, "cancelling the confirm dialog must leave the row untouched");
      assert.equal(deletedIds.length, 0, "cancelling must never call the real delete API");
      assert.equal(document.querySelector(".entity-undo-toast"), null, "cancelling must never produce an Undo toast -- nothing was actually deleted");
      assert.equal(
        (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value,
        "Acme Corp",
        "the in-progress edit must still be open with its real value, not reset by the cancelled delete attempt",
      );
      assert.ok(
        document.querySelector(".form-actions button.secondary"),
        "the Cancel button must still be present -- editingId must not have been cleared by the cancelled delete",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 740: the same asymmetry round 739 fixed for Delete also applied to
 * Duplicate -- the table row and BoardCard each already have their own
 * dedicated Duplicate button/shortcut calling the shared `handleDuplicate`,
 * but the record-form (Calendar's only reachable action surface for an
 * existing record) never had one. Confirms the form now offers a real
 * Duplicate button while editing an existing record, that it calls the
 * real API via the same `handleDuplicate` the table row already uses, and
 * -- unlike Delete -- that duplicating leaves the original record's own
 * in-progress edit session completely open and untouched (duplicating
 * creates a new record; it has no reason to discard what's being edited).
 */
test("EntityPanel's record-form gains a real Duplicate button once editing an existing record, which duplicates it via the real API while leaving the original edit session open", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const postedBodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        const body = JSON.parse(init!.body as string);
        postedBodies.push(body);
        const record = { id: 2, ...body };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        Array.from(document.querySelectorAll(".form-actions button")).find((b) => b.textContent === "Duplicate"),
        undefined,
        "a brand-new, not-yet-saved record has nothing to duplicate -- no Duplicate button while editingId is null",
      );

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Acme Corp");

      const formDuplicateButton = Array.from(document.querySelectorAll(".form-actions button")).find((b) => b.textContent === "Duplicate") as HTMLButtonElement;
      assert.ok(formDuplicateButton, "expected a real Duplicate button in the form once editing an existing record");

      fireEvent.click(formDuplicateButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(postedBodies.length, 1, "the real duplicate request must fire exactly once");
      assert.equal(postedBodies[0]?.name, "Acme Corp", "the duplicate must copy the record actually being edited");
      assert.equal(postedBodies[0]?.status, "new");

      assert.equal(
        (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value,
        "Acme Corp",
        "duplicating must leave the original record's own in-progress edit session open and untouched",
      );
      assert.ok(
        document.querySelector(".form-actions button.secondary"),
        "the Cancel button must still be present -- duplicating must never close the form the way a successful delete does",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The other half of the same feature: NOT clicking Undo must commit the
 * real delete once the undo window actually elapses -- the whole point is
 * a temporary reprieve, not silently keeping deleted records around
 * forever if nobody happens to click Undo.
 */
test("EntityPanel's pending delete actually calls the real delete API once the undo window elapses without Undo being clicked", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      fireEvent.click(document.querySelector(".danger") as HTMLButtonElement);
      assert.equal(deletedIds.length, 0, "must not have deleted for real yet");

      act(() => {
        t.mock.timers.tick(5000);
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(deletedIds, [1], "once the undo window elapses with no Undo click, the real delete must actually fire");
      assert.equal(document.querySelector(".entity-undo-toast"), null, "the toast must clear itself once the delete actually commits");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round (422): a deleted-but-still-pending row (inside the
 * undo window above) genuinely still exists server-side -- only the real
 * DELETE is deferred. refresh() is shared by several unrelated handlers
 * (create/edit, duplicate, bulk-update, CSV import, board-move, inline
 * cell edit) that have no idea a delete is pending, so any one of them
 * running during that same window used to silently resurrect the
 * "deleted" row the instant its own refresh() re-fetched from the server.
 * Commits a real inline cell edit on an unrelated row (the same real
 * PATCH + refresh() path exercised above) while record 1's own delete is
 * still inside its undo window, and confirms record 1 does NOT reappear.
 */
test("EntityPanel's refresh() triggered by an unrelated action (inline cell edit) during a pending delete's undo window must not resurrect the deleted row", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "new" },
    ];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      // Deliberately real timers (no t.mock.timers.enable here): the test
      // only needs to stay inside the 5s undo window, never advance past
      // it, so the real UNDO_WINDOW_MS setTimeout simply never fires
      // during this test's own fast, synchronous-ish execution.
      const deleteButtons = Array.from(document.querySelectorAll(".danger")) as HTMLButtonElement[];
      fireEvent.click(deleteButtons[0]);
      assert.equal(document.querySelectorAll("table tbody tr").length, 1, "Acme Corp must disappear from view immediately");
      assert.equal(deletedIds.length, 0, "the real DELETE must not have fired yet -- still inside the undo window");

      // Globex's own name cell -- the only remaining row's first data column.
      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement;
      assert.equal(nameCell.textContent, "Globex");
      fireEvent.doubleClick(nameCell);
      const input = nameCell.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Globex Corp" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitForCondition(() => document.querySelectorAll("table tbody td")[1]?.textContent === "Globex Corp");

      assert.equal(
        document.querySelectorAll("table tbody tr").length,
        1,
        "the inline edit's own refresh() must not have resurrected Acme Corp, which is still only inside its undo window",
      );
      assert.ok(document.querySelector(".entity-undo-toast"), "the Undo toast for Acme Corp must still be showing");
      assert.equal(deletedIds.length, 0, "Acme Corp's real DELETE still must not have fired");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * The other half: if a refresh() happened to run during the undo window
 * (as above) and the user THEN clicks Undo, restoreRecordAt (which has no
 * de-duplication of its own) must not end up splicing in a second copy of
 * the row that refresh() already correctly left untouched/excluded --
 * there must be exactly one row for the deleted-then-undone record, not
 * two.
 */
test("EntityPanel's Undo after an unrelated refresh() happened during the undo window restores exactly one row, never a duplicate", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "new" },
    ];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      // Deliberately real timers here too -- see the sibling test above.
      const deleteButtons = Array.from(document.querySelectorAll(".danger")) as HTMLButtonElement[];
      fireEvent.click(deleteButtons[0]);

      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement;
      fireEvent.doubleClick(nameCell);
      const input = nameCell.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Globex Corp" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitForCondition(() => document.querySelectorAll("table tbody td")[1]?.textContent === "Globex Corp");

      const toast = document.querySelector(".entity-undo-toast");
      assert.ok(toast, "the Undo toast for Acme Corp must still be showing after the unrelated refresh");
      fireEvent.click(toast!.querySelector("button") as HTMLButtonElement);

      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      assert.equal(rows.length, 2, "Undo must restore exactly one Acme Corp row alongside Globex -- never a duplicate");
      const acmeRows = rows.filter((r) => /Acme Corp/.test(r.textContent ?? ""));
      assert.equal(acmeRows.length, 1, "there must be exactly one Acme Corp row, not two");
      assert.equal(deletedIds.length, 0, "undoing must have genuinely cancelled the real delete");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Regression test for a real gap found by round 292's Explore survey: the
 * deferred delete's real DELETE call used to be a bare `.catch(() => {})`,
 * silently discarding ANY failure -- concretely, deleting a record another
 * record still references via a relation field fails a real foreign-key
 * constraint (connection.ts's `PRAGMA foreign_keys = ON`) on the server,
 * which the API now reports as a 409 (round 292). The row had already
 * disappeared from view the instant Delete was confirmed, so a silently
 * swallowed failure meant it stayed invisibly "deleted" in the UI while
 * still existing on the server -- only reappearing, unexplained, on the
 * next refetch. Confirms the row is restored and a real error is shown
 * once the undo window elapses and the real DELETE call actually fails,
 * exactly the sibling handleBulkDelete already does via Promise.allSettled
 * (this is the single-delete path's own equivalent fix).
 */
test("EntityPanel restores the row and shows an error when the deferred real delete actually fails once the undo window elapses", async (t) => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Deal/1") {
        return new Response(JSON.stringify({ error: "Cannot delete this record -- another record still references it through a relation field", code: "RECORD_HAS_DEPENDENT_RECORDS" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      fireEvent.click(document.querySelector(".danger") as HTMLButtonElement);
      assert.equal(document.querySelectorAll("table tbody tr").length, 0, "the row must disappear from view immediately, as before");

      act(() => {
        t.mock.timers.tick(5000);
      });
      // The undo timer firing only *starts* the real (async) DELETE request
      // -- its eventual failure and the setRecords/setError it triggers land
      // several real microtask hops later (fetch, res.json(), the thrown
      // Error), and React's own jsdom-fallback scheduler needs a real
      // setTimeout to flush that update. Reset back to real timers right
      // here (rather than only in `finally`, as the sibling tests above do)
      // so both of those can actually happen, then poll normally.
      t.mock.timers.reset();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.match(
        document.querySelector(".error")?.textContent ?? "",
        /another record still refers to it/,
        "the real failure must be surfaced as a visible error, not silently swallowed",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Switching entity tabs remounts EntityPanel fresh (App.tsx keys it by
 * entity.name), so leaving one open with a delete still inside its undo
 * window and then navigating away must not silently keep the "deleted"
 * record alive forever on the server -- the pending delete must commit for
 * real the moment the component unmounts, exactly as if the undo window
 * had simply run out early.
 */
test("EntityPanel commits a still-pending delete for real when the component unmounts before the undo window elapses", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      const view = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".danger") as HTMLButtonElement);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(deletedIds.length, 0, "must still be inside the undo window, not yet deleted for real");

      view.unmount();
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(deletedIds, [1], "unmounting mid-undo-window must commit the pending delete for real, not silently drop it");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: a column's width was fixed forever (whatever the
 * browser's own auto-layout happened to pick), with no way to make a long
 * field's own column wider or a short one's narrower. Drives a real
 * mousedown-on-the-handle, mousemove, mouseup sequence -- not calling
 * computeResizedWidth directly -- to prove the whole wire-up: dragging the
 * "Name" column's handle 60px must widen it by exactly 60px starting from
 * its pre-seeded 200px width, apply that width as a real inline style on
 * both its header and every one of its own cells (not just the header),
 * and persist it so a fresh getColumnWidths call for this exact
 * project+entity sees it too.
 */
test("EntityPanel's column resize handle drags a column to a new width, applies it to both the header and its own cells, and persists it", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    setColumnWidth("proj1", "Deal", "name", 200);
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameHeader = document.querySelectorAll("th.resizable-col")[0] as HTMLTableCellElement;
      assert.equal(nameHeader.style.width, "200px", "the pre-seeded width must already apply to the header on first render");

      const handle = nameHeader.querySelector(".column-resize-handle") as HTMLSpanElement;
      assert.ok(handle, "expected a resize handle inside the Name column's header");

      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(window, { clientX: 160 });
      fireEvent.mouseUp(window, { clientX: 160 });

      assert.equal(nameHeader.style.width, "260px", "dragging 60px right must widen the column by exactly 60px (200 + 60)");
      const nameCell = document.querySelector("table tbody tr td:nth-child(2)") as HTMLTableCellElement;
      assert.equal(nameCell.style.width, "260px", "the same resized width must apply to the column's own data cells, not just its header");

      assert.deepEqual(
        getColumnWidths("proj1", "Deal"),
        { name: 260 },
        "the new width must be genuinely persisted, not just reflected in the live DOM",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 658 regression: startResize is the app's only mousedown-based
 * drag -- every other drag interaction uses native HTML5 draggable/
 * onDragStart, which the browser itself already gates to the left mouse
 * button -- but startResize never checked e.button, so a right-click-drag
 * or middle-click-drag on the handle resized the column exactly like a
 * left-click-drag, since the width math only reads e.clientX delta, never
 * which button is held. Confirms a mousedown with a non-left button is a
 * silent no-op: no resize starts, and a later mousemove (as if the user
 * then dragged) has no effect either, since resizingField was never set.
 */
test("EntityPanel's column resize handle ignores a mousedown from a non-left mouse button, instead of resizing on a right- or middle-click-drag", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    setColumnWidth("proj1", "Deal", "name", 200);
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameHeader = document.querySelectorAll("th.resizable-col")[0] as HTMLTableCellElement;
      const handle = nameHeader.querySelector(".column-resize-handle") as HTMLSpanElement;
      assert.ok(handle, "expected a resize handle inside the Name column's header");

      fireEvent.mouseDown(handle, { clientX: 100, button: 2 });
      fireEvent.mouseMove(window, { clientX: 160 });
      fireEvent.mouseUp(window, { clientX: 160 });
      assert.equal(nameHeader.style.width, "200px", "a right-click-drag must leave the column's width completely untouched");

      fireEvent.mouseDown(handle, { clientX: 100, button: 1 });
      fireEvent.mouseMove(window, { clientX: 160 });
      fireEvent.mouseUp(window, { clientX: 160 });
      assert.equal(nameHeader.style.width, "200px", "a middle-click-drag must leave the column's width completely untouched");

      assert.deepEqual(
        getColumnWidths("proj1", "Deal"),
        { name: 200 },
        "neither non-left-click drag must have persisted any width change",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 645 regression: the resize handle was a bare `<span>` with only
 * `onMouseDown` and `aria-hidden="true"` -- a keyboard-only user had no
 * way to resize a column at all (the only other width control, "Reset
 * column widths", undoes every resize at once rather than setting one),
 * and a screen-reader user wasn't even told the control existed. The
 * column-move buttons sitting right next to this same handle already had
 * a real keyboard fallback; resize never did. Confirms the handle is now
 * a real, labeled, keyboard-operable slider: ArrowRight/ArrowLeft resize
 * it by a fixed step through the exact same computeResizedWidth/
 * setColumnWidth path the mouse drag already used.
 */
test("EntityPanel's column resize handle is keyboard-operable via ArrowRight/ArrowLeft, not mouse-drag-only, and is exposed to assistive tech as a real slider", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    setColumnWidth("proj1", "Deal", "name", 200);
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameHeader = document.querySelectorAll("th.resizable-col")[0] as HTMLTableCellElement;
      const handle = nameHeader.querySelector(".column-resize-handle") as HTMLSpanElement;
      assert.ok(handle, "expected a resize handle inside the Name column's header");

      assert.equal(handle.getAttribute("role"), "slider", "the handle must announce itself as a real slider control");
      assert.equal(handle.getAttribute("tabindex"), "0", "the handle must be reachable by Tab, not skipped");
      assert.equal(handle.getAttribute("aria-hidden"), null, "the handle must no longer be hidden from assistive tech");
      assert.match(
        handle.getAttribute("aria-label") ?? "",
        /Name/,
        "the handle's label must name the actual column, not a generic placeholder",
      );

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      assert.equal(nameHeader.style.width, "220px", "ArrowRight must widen the column by the fixed keyboard step (200 + 20)");

      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      assert.equal(nameHeader.style.width, "180px", "ArrowLeft must narrow the column by the same step, below the original width");

      assert.deepEqual(
        getColumnWidths("proj1", "Deal"),
        { name: 180 },
        "a keyboard resize must persist exactly like a mouse-drag resize does, not just update in-memory state",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: once a column was manually resized, the only way
 * back to the table's normal automatic sizing was dragging each resized
 * column back by hand -- no one-click way to reset, unlike fieldFilters'
 * own "Clear all filters" (round 341). Confirms the button is absent
 * when no column has ever been resized, appears once one has, clicking
 * it drops BOTH the live inline widths and the persisted storage, and it
 * then disappears again (nothing left to reset).
 */
test("EntityPanel's 'Reset column widths' button only appears once a column has been resized, and clears both the live widths and persisted storage", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(document.querySelector(".entity-reset-column-widths"), null, "no reset button before any column has been resized");

      const nameHeader = document.querySelectorAll("th.resizable-col")[0] as HTMLTableCellElement;
      const handle = nameHeader.querySelector(".column-resize-handle") as HTMLSpanElement;
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(window, { clientX: 160 });
      fireEvent.mouseUp(window, { clientX: 160 });
      assert.equal(nameHeader.style.width, "60px", "sanity check: the drag itself must have actually resized the column");

      const resetButton = document.querySelector(".entity-reset-column-widths") as HTMLButtonElement;
      assert.ok(resetButton, "expected the reset button to appear once a column has been resized");

      fireEvent.click(resetButton);
      assert.equal(nameHeader.style.width, "", "clicking reset must clear the live inline width back to automatic sizing");
      assert.deepEqual(getColumnWidths("proj1", "Deal"), {}, "clicking reset must also clear the persisted storage, not just the live DOM");
      assert.equal(document.querySelector(".entity-reset-column-widths"), null, "the reset button itself must disappear once there's nothing left to reset");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 897: the identical "drop a persisted key referencing a field this
 * entity no longer has" gap sortKeys' own effect already closes (round
 * 509) was never applied to columnWidths -- unlike every sibling
 * preference module, its load effect was keyed only on
 * [projectId, entity.name], never on fieldNamesKey. Resize a column, then
 * have a live refine remove that exact field (same no-remount precondition
 * rounds 780/882/892 already rely on): before the fix, the dead key stayed
 * in both state and storage, so Object.keys(columnWidths).length > 0 kept
 * reading true purely from a field nothing on screen can still reference --
 * wrongly locking the table into entity-table-resized's fixed-layout mode
 * and leaving the "Reset column widths" button visible with nothing real
 * left to reset.
 */
test("EntityPanel drops a persisted column width when a live refine REMOVES that field outright, instead of wrongly locking the table into fixed-layout mode forever", async () => {
  await withJsdom(async () => {
    const entityWithStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["new", "won", "lost"],
          enumLabels: { new: "New", won: "Won", lost: "Lost" },
        },
      ],
    };
    const entityWithoutStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    };
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithStatus, allEntities: [entityWithStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const statusHeader = document.querySelectorAll("th.resizable-col")[1] as HTMLTableCellElement;
      const handle = statusHeader.querySelector(".column-resize-handle") as HTMLSpanElement;
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(window, { clientX: 160 });
      fireEvent.mouseUp(window, { clientX: 160 });
      assert.deepEqual(getColumnWidths("proj1", "Deal"), { status: 60 }, "sanity check: the drag itself must have actually persisted a resized width");
      assert.ok(document.querySelector(".entity-table-resized"), "sanity check: the table must be in fixed-layout mode right after resizing");

      // Simulate a refine that REMOVES "status" entirely -- not a retype --
      // while staying on the exact same entity.name ("Deal"), with the
      // resized width still held in both the live columnWidths state and
      // persisted storage.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutStatus, allEntities: [entityWithoutStatus] }));
      await waitForCondition(() => document.querySelector(".entity-table-resized") === null);

      // Asserts on the table's own rendered class and the reset button's
      // presence -- the actual observable symptoms the bug describes --
      // rather than persisted storage, which this fix (mirroring sortKeys'
      // own established pattern just above: filter the loaded state
      // against the surviving field set, without rewriting storage) never
      // touches; the dead key can keep sitting in storage harmlessly,
      // exactly as sortKeys' own analogous fix already does.
      assert.equal(document.querySelector(".entity-table-resized"), null, "the table must return to normal automatic sizing, not stay locked into fixed-layout mode for a field that no longer exists");
      assert.equal(document.querySelector(".entity-reset-column-widths"), null, "the 'Reset column widths' button must disappear too, since there is nothing real left to reset");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 985: a fresh Explore survey traced an established bug class this
 * routine already closed for a field genuinely REMOVED by a live refine
 * (sortKeys round 509, columnWidths round 897, fieldFilters round 751,
 * groupFieldName round 780/892) to a sibling hazard none of those fixes
 * actually covers -- a field whose NAME survives a live refine with only
 * its letter CASING changed (e.g. "status" -> "Status"), which migrate.ts/
 * pipeline.ts/checkpointDiff.ts already treat, at the spec-diffing layer,
 * as the exact same field (SQLite itself resolves a column name
 * case-insensitively -- see migrate.ts's own doc comments -- so nothing
 * about the real data changes at all). Every one of those four
 * revalidation effects used an EXACT name match, which can't tell a
 * case-only rename apart from the field being a totally different one, so
 * a resized column snapped back to auto width, a chosen sort order
 * reverted to none, and an active filter silently vanished (unhiding
 * whatever it was filtering out) -- even though, from the user's
 * perspective, nothing about that field actually changed. Seeds the
 * column width and sort key directly via their own persistence setters
 * (matching columnWidths' own round-897 test's convention), rather than
 * simulating a real drag/click, since the DRAG mechanics themselves are
 * already covered elsewhere and aren't the point of this test. Status
 * stays visible throughout (a hidden column's own header never renders at
 * all, so there's nothing to check its width/sort state against) --
 * hiddenFields' own identical hazard is covered by the dedicated test
 * just below instead.
 */
test("EntityPanel carries a resized column width and a chosen sort order forward under their new spelling when a live refine renames a field's letter casing", async () => {
  await withJsdom(async () => {
    const statusFieldV1 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV1],
    };
    const statusFieldV2 = { ...statusFieldV1, name: "Status" };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    setColumnWidth("proj1", "Deal", "status", 220);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.ok(document.querySelector(".entity-table-resized"), "sanity check: the seeded width must already put the table into fixed-layout mode");

      // Sort by "status".
      const statusColumnHeaderButton = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      fireEvent.click(statusColumnHeaderButton);
      assert.deepEqual(getSortKeys("proj1", "Deal").map((k) => k.field), ["status"], "sanity check: sorting must have actually persisted");

      // Simulate a live refine that renames "status" -> "Status" ONLY --
      // same field, same type, same enum values, same entity.name ("Deal"),
      // the same no-remount precondition every sibling test above relies
      // on. sortKeys' own revalidation effect (like its sibling
      // columnWidths' own just below) only ever updates REACT STATE, never
      // writes the remap back to persisted storage (matching this file's
      // own established convention -- see that effect's own doc comment
      // in EntityPanel.tsx) -- so the DOM's own aria-sort attribute (not
      // sortKeysPreference.ts's getSortKeys, which would still show the
      // stale "status" key forever) is the only way to observe whether the
      // remap actually happened.
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.ok(document.querySelector(".entity-table-resized"), "the table must stay in fixed-layout mode -- the resized width must not have been dropped as if the field were removed");
      const statusHeaderCellAfterRename = Array.from(document.querySelectorAll("thead th")).find((th) => /Status/.test(th.textContent ?? ""))!;
      assert.notEqual(
        statusHeaderCellAfterRename.getAttribute("aria-sort"),
        "none",
        "the Status column must still show as the active sort column under its new spelling, not revert to no sort",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 985: the same case-only-rename hazard as the two tests above, for
 * fieldFilters specifically -- checked via the filter's own persisted
 * value and its <select>'s own displayed value, deliberately NOT via the
 * table's resulting row count: this isolated-component test never
 * triggers a fresh GET on a rerender that only changes entity.fields
 * (same precondition every sibling test above relies on), so the
 * already-fetched mock records keep their OLD "status" key forever within
 * this one test run, unlike the real server's own rowToRecord
 * (packages/db/src/repository.ts), which always serializes a record keyed
 * by the CURRENT schema's field.name. Checking row counts here would
 * therefore show 0 matches post-rename regardless of whether the
 * underlying fix works, which is a limitation of this test's own static
 * mock data, not a real symptom.
 */
test("EntityPanel carries an active field filter forward under its new spelling when a live refine renames a field's letter casing", async () => {
  await withJsdom(async () => {
    const statusFieldV1 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV1],
    };
    const statusFieldV2 = { ...statusFieldV1, name: "Status" };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "new" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.deepEqual(getFieldFilters("proj1", "Deal"), { status: "new" }, "sanity check: the filter must have actually persisted");

      // Simulate a live refine that renames "status" -> "Status" ONLY --
      // same field, same type, same enum values, same entity.name ("Deal"),
      // the same no-remount precondition every sibling test above relies
      // on. fieldFilters' own revalidation effect, like sortKeys'/
      // columnWidths' own just above, only ever updates REACT STATE, never
      // writes the remap back to persisted storage -- so the filter
      // <select>'s own displayed value (not fieldFiltersPreference.ts's
      // getFieldFilters, which would still show the stale "status" key
      // forever) is the only way to observe whether the remap happened.
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => (document.querySelector(".entity-status-filter") as HTMLSelectElement | null)?.value === "new");

      assert.equal(
        (document.querySelector(".entity-status-filter") as HTMLSelectElement).value,
        "new",
        "the filter <select>'s own displayed value must still reflect the active filter under the new spelling, not blank out",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 985: the same case-only-rename hazard as the test just above, for
 * hiddenFields and the "Group by" choice specifically -- both need the
 * field to be HIDDEN/grouped rather than visible, which the test above
 * deliberately avoids (a hidden column's own header never renders, so it
 * can't also be checked for a resized width/sort state in the same pass).
 */
test("EntityPanel keeps a column hidden and a 'Group by' choice set under their new spelling when a live refine renames a field's letter casing", async () => {
  await withJsdom(async () => {
    const statusFieldV1 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV1],
    };
    const statusFieldV2 = { ...statusFieldV1, name: "Status" };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      // Hide the "status" column.
      const columnsBtn = document.querySelector(".columns-menu-btn") as HTMLButtonElement;
      fireEvent.click(columnsBtn);
      const statusCheckbox = Array.from(document.querySelectorAll(".columns-menu-item")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      )!.querySelector("input") as HTMLInputElement;
      fireEvent.click(statusCheckbox);
      await waitForCondition(() => document.querySelectorAll("thead th").length === 4);
      fireEvent.click(columnsBtn);
      assert.deepEqual(getHiddenFields("proj1", "Deal"), new Set(["status"]), "sanity check: hiding must have actually persisted");

      // Group by "status".
      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => getGroupByField("proj1", "Deal") === "status");

      // Simulate a live refine that renames "status" -> "Status" ONLY --
      // same field, same type, same enum values, same entity.name ("Deal"),
      // the same no-remount precondition every sibling test above relies on.
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelector(".entity-group-by") !== null);

      assert.deepEqual(
        getHiddenFields("proj1", "Deal"),
        new Set(["Status"]),
        "the hidden column must stay hidden under its new spelling, not silently reappear",
      );
      fireEvent.click(document.querySelector(".columns-menu-btn") as HTMLButtonElement);
      const columnsMenuItems = Array.from(document.querySelectorAll(".columns-menu-item"));
      assert.equal(columnsMenuItems.length, 2, "expected one checkbox per real field (Name, Status)");
      const statusMenuCheckbox = columnsMenuItems.find((el) => /Status/.test(el.textContent ?? ""))!.querySelector("input") as HTMLInputElement;
      assert.equal(statusMenuCheckbox.checked, false, "the Status column must still show as hidden in the Columns menu under its new spelling");
      assert.equal(getGroupByField("proj1", "Deal"), "Status", "the 'Group by' choice must carry forward under the new spelling, not be cleared to 'no grouping'");
      assert.equal(
        (document.querySelector(".entity-group-by") as HTMLSelectElement).value,
        "Status",
        "the 'Group by' <select>'s own displayed value must still reflect the chosen field, not blank out",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1008: a fresh Explore survey found that round 985's own fix above
 * never actually exercised the one hazard that matters most for a
 * collapsed state -- collapsedGroupsPreference.ts and
 * collapsedBoardColumnsPreference.ts are each keyed by groupFieldName/
 * boardFieldName directly (unlike hiddenFields/columnOrder/sortKeys, none
 * of which are keyed by a dynamic field name), so groupFieldName's own
 * round-985 remap-to-the-new-casing effect updating that state is exactly
 * what makes the load effect's OWN exact-match lookup miss under the new
 * key -- a hazard round 985's own test (just above) never triggered, since
 * it only set "Group by" without ever actually collapsing a group.
 * Confirms a group collapsed under the field's OLD casing stays collapsed
 * (not silently re-expanded) once a live refine renames the field's
 * letters only, and that the real stored set migrates to the new key
 * rather than being orphaned under the old one.
 */
test("EntityPanel keeps a collapsed table group collapsed under its new spelling when a live refine renames the grouped field's letter casing", async () => {
  await withJsdom(async () => {
    const statusFieldV1 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV1],
    };
    const statusFieldV2 = { ...statusFieldV1, name: "Status" };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      function findGroupToggle(label: string) {
        const row = Array.from(document.querySelectorAll(".entity-group-header-row")).find((el) =>
          el.textContent?.includes(label),
        )!;
        return row.querySelector(".entity-group-toggle") as HTMLButtonElement;
      }

      fireEvent.click(findGroupToggle("New"));
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 1);
      assert.deepEqual(
        getCollapsedGroups("proj1", "Deal", "status"),
        ["new"],
        "sanity check: collapsing the 'New' group must have actually persisted under the field's current casing",
      );

      // Simulate a live refine that renames "status" -> "Status" ONLY --
      // same field, same type, same enum values, same entity.name ("Deal"),
      // with NO unmount (view.rerender, not a fresh renderEntityPanel) --
      // the bug only reproduces on a live refine, same as round 985's test.
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelector(".entity-group-by") !== null);

      assert.deepEqual(
        getCollapsedGroups("proj1", "Deal", "Status"),
        ["new"],
        "the collapsed group's real stored set must migrate to the new field-name casing",
      );
      // Not checked here: the post-rename table's own row count. Like
      // fieldFilters' own sibling test above, this isolated-component test
      // never triggers a fresh GET on a rerender that only changes
      // entity.fields, so the already-fetched mock records keep their OLD
      // "status" key forever within this one test run -- grouping by the
      // NEW "Status" key would find no match on either mock record and
      // collapse them into one degenerate group, unlike the real server's
      // own rowToRecord (packages/db/src/repository.ts), which always
      // serializes a record keyed by the CURRENT schema's field.name.
      // getCollapsedGroups's own migration above is therefore the real
      // proof here, exactly as it is for fieldFilters.
      assert.deepEqual(
        getCollapsedGroups("proj1", "Deal", "status"),
        [],
        "the old field-name casing's key must be cleaned up, not left orphaned alongside the migrated one",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1008: the identical hazard as the test just above, for
 * collapsedBoardColumnsPreference.ts's own boardFieldName dimension --
 * boardFieldName isn't React state (findBoardField recomputes it fresh
 * from entity.fields every render), but it still resolves to the new
 * casing the instant a case-only rename completes, so the load effect's
 * own exact-match lookup is just as exposed as collapsedGroups' above.
 */
test("EntityPanel keeps a collapsed board column collapsed under its new spelling when a live refine renames the board field's letter casing", async () => {
  await withJsdom(async () => {
    const statusFieldV1 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV1],
    };
    const statusFieldV2 = { ...statusFieldV1, name: "Status" };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 2);

      function findColumn(label: string) {
        return Array.from(document.querySelectorAll(".board-column")).find((col) =>
          col.querySelector(".board-column-header-info")?.textContent?.includes(label),
        ) as HTMLDivElement;
      }

      fireEvent.click(findColumn("New").querySelector(".board-column-toggle") as HTMLButtonElement);
      await waitForCondition(() => findColumn("New").querySelectorAll(".board-card").length === 0);
      assert.deepEqual(
        getCollapsedBoardColumns("proj1", "Deal", "status"),
        ["new"],
        "sanity check: collapsing the 'New' column must have actually persisted under the field's current casing",
      );

      // Simulate a live refine that renames "status" -> "Status" ONLY, with
      // NO unmount (view.rerender, not a fresh renderEntityPanel).
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelector(".board-column-toggle") !== null);

      // Not checked here: the post-rename board's own column/card layout.
      // Same mock-data limitation as collapsedGroups' own sibling test
      // above -- this isolated-component test never triggers a fresh GET
      // on a rerender that only changes entity.fields, so the already-
      // fetched mock records keep their OLD "status" key forever within
      // this one test run, unlike the real server's own rowToRecord, which
      // always serializes a record keyed by the CURRENT schema's
      // field.name. getCollapsedBoardColumns's own migration below is
      // therefore the real proof here.
      assert.deepEqual(
        getCollapsedBoardColumns("proj1", "Deal", "Status"),
        ["new"],
        "the collapsed column's real stored set must migrate to the new field-name casing",
      );
      assert.deepEqual(
        getCollapsedBoardColumns("proj1", "Deal", "status"),
        [],
        "the old field-name casing's key must be cleaned up, not left orphaned alongside the migrated one",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the board view's card <select> (still there, and
 * still the accessible/keyboard-reachable way to move a card) was the only
 * way to move a card between columns -- a real Kanban board is expected to
 * let you drag a card straight onto the column you want. Drives real
 * dragstart/dragover/drop events (with a minimal DataTransfer mock, since
 * jsdom doesn't implement the real one) to prove the whole wire-up: dragging
 * a card from the "new" column and dropping it on "won" must call the real
 * PATCH (via the same handleMove the dropdown already used) and land the
 * card in its new column once the round trip settles -- and dropping onto
 * the SAME column the card is already in must be a genuine no-op, not an
 * extra PATCH.
 */
test("EntityPanel's board view moves a card via a real drag-and-drop, and dropping it back on its own column is a no-op", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    let patchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") patchCount += 1;
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);

      const columns = document.querySelectorAll(".board-column");
      const card = columns[0].querySelector(".board-card") as HTMLDivElement;

      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }
      const dataTransfer = makeDataTransfer();

      // Dropping on its OWN column ("new", index 0) must be a real no-op.
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.dragOver(columns[0], { dataTransfer });
      assert.ok(
        columns[0].classList.contains("board-column-drag-over"),
        "dragging over a column must show real drag-over feedback",
      );
      fireEvent.drop(columns[0], { dataTransfer });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(patchCount, 0, "dropping a card back on the column it's already in must never call the real PATCH endpoint");
      assert.equal(
        columns[0].classList.contains("board-column-drag-over"),
        false,
        "drag-over feedback must clear once the drop completes",
      );

      // Now a real move: drag from "new" (index 0) and drop on "won" (index 1).
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.dragOver(columns[1], { dataTransfer });
      fireEvent.drop(columns[1], { dataTransfer });

      await waitForCondition(() => store[0].status === "won");
      await waitForCondition(() => {
        const columnsNow = document.querySelectorAll(".board-column");
        return columnsNow[0].querySelectorAll(".board-card").length === 0 && columnsNow[1].querySelectorAll(".board-card").length === 1;
      });

      assert.equal(patchCount, 1, "the real drag-and-drop move must call the real PATCH exactly once");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 656: a board column's own onDragOver accepts
 * ANY drag, not just one of its own cards -- so an entity tab (App.tsx's
 * own onDragStart never calls setData, leaving its text/plain payload "")
 * or a file dragged in from the desktop both land in handleCardDrop too.
 * Number("") is 0, not NaN, so the existing Number.isNaN guard alone lets
 * it straight through to a `records.find` that returns undefined --
 * before this round's fix, the old `record && ...` same-column check
 * short-circuited false for a missing record and fell through to the real
 * handleMove/PATCH call for a record id (0) that was never actually
 * dragged, surfacing a real "Record 0 not found" error banner over a
 * board where nothing was moved. The calendar view's own sibling drop
 * handler already guards the identical case with `if (record) ...`.
 * Confirms a drop with an empty text/plain payload is a true no-op: no
 * PATCH fires and no error banner appears.
 */
test("EntityPanel's board column drop with no real record id (an entity tab or a dragged-in file) is a silent no-op, not a PATCH to a nonexistent record", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    let patchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") patchCount += 1;
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);

      const columns = document.querySelectorAll(".board-column");
      // An entity tab's own onDragStart never calls setData -- simulate the
      // exact same empty payload a real such drag (or a file from the
      // desktop) would leave behind.
      const emptyDataTransfer = { getData: () => "" };

      fireEvent.drop(columns[1], { dataTransfer: emptyDataTransfer });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(patchCount, 0, "a drop with no real record id must never call the real PATCH endpoint");
      assert.equal(document.querySelector(".error"), null, "no error banner must appear for a drop that was never a real card");
      assert.equal(store[0].status, "new", "the only real record's status must be completely untouched");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a huge "Done"/"Won" column with dozens of cards always
 * rendered every single one, with no way to collapse it out of the way.
 * Each column header now has its own toggle button. Confirms: (1) toggling
 * one column hides only that column's own cards, leaving the other column's
 * cards untouched (2) the collapsed state survives a full unmount+remount
 * (scoped per project+entity via collapsedBoardColumnsPreference.ts, a
 * deliberately separate store from the table-group collapse feature's own,
 * since both are keyed only by project+entity and could otherwise cross-
 * contaminate if the board's grouping field and the table's grouping field
 * ever shared a value) (3) a collapsed column's outer drop target stays
 * fully wired -- dragging over it still shows real drag-over feedback --
 * since only the inner card list is hidden, not the whole column.
 */
test("EntityPanel's board column toggle hides only that column's cards, persists across remount, and keeps a collapsed column's drop target live", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);

      function findColumn(label: string) {
        return Array.from(document.querySelectorAll(".board-column")).find((col) =>
          col.querySelector(".board-column-header-info")?.textContent?.includes(label),
        ) as HTMLDivElement;
      }

      const newColumn = findColumn("New");
      const wonColumn = findColumn("Won");
      assert.equal(newColumn.querySelectorAll(".board-card").length, 1, "the 'New' column must start expanded with its 1 card visible");
      assert.equal(wonColumn.querySelectorAll(".board-card").length, 1, "the 'Won' column must start expanded with its 1 card visible");

      const newToggle = newColumn.querySelector(".board-column-toggle") as HTMLButtonElement;
      assert.equal(newToggle.getAttribute("aria-expanded"), "true", "an expanded column's toggle must report aria-expanded=true");

      fireEvent.click(newToggle);
      await waitForCondition(() => findColumn("New").querySelectorAll(".board-card").length === 0);

      assert.equal(
        findColumn("Won").querySelectorAll(".board-card").length,
        1,
        "collapsing the 'New' column must not affect the unrelated 'Won' column's own cards",
      );
      assert.equal(
        findColumn("New").querySelector(".board-column-toggle")!.getAttribute("aria-expanded"),
        "false",
        "a collapsed column's toggle must report aria-expanded=false",
      );

      // A collapsed column's own drop target must still be fully live.
      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }
      fireEvent.dragOver(findColumn("New"), { dataTransfer: makeDataTransfer() });
      assert.ok(
        findColumn("New").classList.contains("board-column-drag-over"),
        "a collapsed column must still show real drag-over feedback -- only its card list should be hidden, not its drop wiring",
      );

      // The collapsed state must survive a full unmount+remount (persisted per project+entity).
      view.unmount();
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);
      assert.equal(
        findColumn("New").querySelectorAll(".board-card").length,
        0,
        "the 'New' column must still be collapsed after a full remount",
      );

      // Clicking it again must restore the hidden card.
      fireEvent.click(findColumn("New").querySelector(".board-column-toggle") as HTMLButtonElement);
      await waitForCondition(() => findColumn("New").querySelectorAll(".board-card").length === 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 435's finding: collapsedBoardColumnsPreference.ts
 * had the exact same missing-dimension defect round 434 fixed for
 * collapsedGroupsPreference.ts, just left open in this sibling file --
 * its persisted key was scoped by project+entity only, not by which field
 * findBoardField (entityFormatting.ts) currently resolves to for this
 * entity. findBoardField recomputes on every render from entity.fields
 * (preferring a field literally named "status"/"stage", else the first
 * qualifying enum field), so an entity whose fields are edited (e.g. a
 * refine adds a "status" field) can have its board silently driven by a
 * DIFFERENT field afterward, while entity.name stays the same. Without
 * boardFieldName in the key, the new field's columns inherited whichever
 * columns were collapsed under the field that used to hold that role --
 * exactly round 434's "group keys are field-independent" defect, applied
 * to the Kanban board's own collapse state instead of the table's.
 */
test("EntityPanel's board-column collapse state does not leak from one board field to a different field after a schema edit changes which field drives the board", async () => {
  await withJsdom(async () => {
    const priorityField = {
      name: "priority",
      label: "Priority",
      type: "enum" as const,
      required: true,
      enumValues: ["low", "high"],
      enumLabels: { low: "Low", high: "High" },
    };
    const statusField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["low", "done"],
      enumLabels: { low: "Low", done: "Done" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityField],
    };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityField, statusField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", priority: "low", status: "low" },
      { id: 2, createdAt: "x", name: "Beta Inc", priority: "high", status: "done" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 2);

      function findColumn(label: string) {
        return Array.from(document.querySelectorAll(".board-column")).find((col) =>
          col.querySelector(".board-column-header-info")?.textContent?.includes(label),
        ) as HTMLDivElement;
      }

      // No "status"/"stage" field exists yet, so the board is driven by
      // "priority" (the only qualifying enum field). Collapse its "Low" column.
      const priorityLowColumn = findColumn("Low");
      assert.ok(priorityLowColumn, "expected a 'Low' column grouped by 'priority'");
      fireEvent.click(priorityLowColumn.querySelector(".board-column-toggle") as HTMLButtonElement);
      await waitForCondition(() => findColumn("Low").querySelectorAll(".board-card").length === 0);

      // Simulate a schema edit (e.g. a refine) that adds a "status" field --
      // findBoardField now prefers it (name-hint match) over "priority",
      // even though entity.name ("Deal") never changed.
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 2);

      const statusLowColumn = findColumn("Low");
      assert.ok(statusLowColumn, "expected a 'Low' column, now grouped by the newly-preferred 'status' field");
      assert.equal(
        statusLowColumn.querySelectorAll(".board-card").length,
        1,
        "'status' field's own 'Low' column must not inherit 'priority' field's collapsed state just because they share the same column value",
      );
      assert.equal(
        statusLowColumn.querySelector(".board-column-toggle")!.getAttribute("aria-expanded"),
        "true",
        "the 'status' field's 'Low' column must start expanded -- the user never touched it",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 842's finding: a collapsed group's own persisted key is the
 * field's raw stored value (an enum value) -- but nothing previously
 * re-validated that value against the field's CURRENT enumValues. A
 * refine renaming/removing an enum value (e.g. "won" -> "done") doesn't
 * touch existing records' own stored "won" strings (migrations are
 * additive-only), so those records move to the "(other)" bucket instead
 * -- a different key the stale "won" entry in collapsedGroups never
 * matches again, leaving it to sit in storage forever with no UI path to
 * ever remove it (and a latent collision risk if some future refine ever
 * reintroduces the literal string "won" as a genuinely different value's
 * own name). Confirms the stale entry is pruned from real persisted
 * storage the moment the entity's own enumValues change, without needing
 * a remount -- EntityPanel doesn't remount when a refine mutates the
 * currently-active entity's own fields in place.
 */
test("EntityPanel prunes a collapsed-group entry naming an enum value a refine renamed away, instead of leaving it in storage forever", async () => {
  await withJsdom(async () => {
    const statusFieldV1 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const statusFieldV2 = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "done"],
      enumLabels: { new: "New", done: "Done" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV1],
    };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 2);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows.find((r) => r.textContent?.includes("Won"))!.querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 1);
      assert.deepEqual(
        getCollapsedGroups("proj1", "Deal", "status"),
        ["won"],
        "sanity check: collapsing 'Won' must have actually persisted it",
      );

      // Simulate a refine renaming "won" -> "done" while this entity's tab
      // stays open (EntityPanel doesn't remount for an in-place field edit).
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 2);

      assert.deepEqual(
        getCollapsedGroups("proj1", "Deal", "status"),
        [],
        "the dead 'won' entry must be pruned from storage once 'status' no longer has that value, not left to sit there forever",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 842's finding, applied to the Kanban board's own collapse state
 * instead of the table's -- same reasoning as the collapsedGroups test
 * just above. findBoardField only ever resolves to an enum field, so this
 * exercises the exact same staleness guard on collapsedBoardColumnsPreference.ts's
 * own side.
 */
test("EntityPanel prunes a collapsed-board-column entry naming an enum value a refine renamed away, instead of leaving it in storage forever", async () => {
  await withJsdom(async () => {
    const priorityFieldV1 = {
      name: "priority",
      label: "Priority",
      type: "enum" as const,
      required: true,
      enumValues: ["low", "high"],
      enumLabels: { low: "Low", high: "High" },
    };
    const priorityFieldV2 = {
      name: "priority",
      label: "Priority",
      type: "enum" as const,
      required: true,
      enumValues: ["low", "urgent"],
      enumLabels: { low: "Low", urgent: "Urgent" },
    };
    const entityV1: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityFieldV1],
    };
    const entityV2: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityFieldV2],
    };
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", priority: "low" },
      { id: 2, name: "Beta Inc", priority: "high" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityV1, allEntities: [entityV1] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 2);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 2);

      function findColumn(label: string) {
        return Array.from(document.querySelectorAll(".board-column")).find((col) =>
          col.querySelector(".board-column-header-info")?.textContent?.includes(label),
        ) as HTMLDivElement;
      }
      fireEvent.click(findColumn("High").querySelector(".board-column-toggle") as HTMLButtonElement);
      await waitForCondition(() => findColumn("High").querySelectorAll(".board-card").length === 0);
      assert.deepEqual(
        getCollapsedBoardColumns("proj1", "Deal", "priority"),
        ["high"],
        "sanity check: collapsing 'High' must have actually persisted it",
      );

      // Simulate a refine renaming "high" -> "urgent" while this entity's
      // tab stays open (EntityPanel doesn't remount for an in-place field edit).
      // Beta Inc's own stored "high" value no longer matches either
      // declared enumValue, so it lands in a 3rd, synthetic "(other)"
      // column alongside "Low" and the now-empty "Urgent" column.
      view.rerender(buildEntityPanelElement({ entity: entityV2, allEntities: [entityV2] }));
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);

      assert.deepEqual(
        getCollapsedBoardColumns("proj1", "Deal", "priority"),
        [],
        "the dead 'high' entry must be pruned from storage once 'priority' no longer has that value, not left to sit there forever",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 490's finding: the viewMode-revalidation effect's own doc comment
 * claims it falls back to "table" when the persisted view needs a
 * board/date field the entity no longer has, but its dependency array was
 * only [projectId, entity.name] -- missing boardFieldName/dateFieldName,
 * unlike the sibling collapsedBoardColumns effect right above it in the
 * real file (confirmed by round 486's own regression test above, which
 * already exercises that effect's correct dependency list). EntityPanel
 * doesn't remount when a refine mutates the currently-active entity's own
 * fields in place (App.tsx keys it by entity.name alone), so switching to
 * Board view and then having a refine remove the board-eligible field left
 * viewMode stuck on "board" even though the board itself correctly fell
 * back to rendering the table: the group-by select stayed hidden (its own
 * gate checks viewMode === "table") and no view-toggle button showed as
 * active.
 */
test("EntityPanel falls back viewMode to 'table' when a schema edit removes the field the current Board view depends on, without remounting", async () => {
  await withJsdom(async () => {
    const statusField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const isPriorityField = { name: "isPriority", label: "Priority", type: "boolean" as const, required: false };
    const dueDateField = { name: "dueDate", label: "Due date", type: "date" as const, required: false };
    const entityWithBoard: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusField, isPriorityField, dueDateField],
    };
    const entityWithoutBoard: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, isPriorityField, dueDateField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new", isPriority: true, dueDate: "2026-01-01" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithBoard, allEntities: [entityWithBoard] });
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length > 0);

      // Simulate a refine that removes "status" -- the only board-eligible
      // field -- while staying on the exact same entity.name ("Deal"), the
      // same way App.tsx's real key={entity.name} never remounts for this.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutBoard, allEntities: [entityWithoutBoard] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(document.querySelectorAll(".board-column").length, 0, "the board itself must no longer render");
      assert.ok(
        document.querySelector(".entity-group-by"),
        "the group-by select (gated on viewMode === 'table') must reappear once viewMode genuinely falls back to 'table', even though 'isPriority' (a groupable boolean field) is still present",
      );
      const toggleButtons = Array.from(document.querySelectorAll(".view-toggle-btn"));
      assert.equal(toggleButtons.length, 2, "with 'status' gone but 'dueDate' still present, only the Board button must disappear -- Table and Calendar stay");
      assert.ok(
        toggleButtons[0].classList.contains("view-toggle-btn-active"),
        "the remaining Table button must show as active -- not stuck reflecting a stale 'board' viewMode with no button showing active at all",
      );
      assert.ok(
        !toggleButtons[1].classList.contains("view-toggle-btn-active"),
        "the Calendar button must not show as active either",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 493's finding: fieldFilters' own re-validation
 * effect (sibling to viewMode's, fixed in round 490) was never given the
 * same fix -- it only dropped a filter referencing a removed field on
 * [projectId, entity.name] (an actual tab switch), never while the tab
 * stays mounted through a live Refine. Since visibleRecords's own filter
 * check compares a record's (now-undefined) field value against the
 * stale filter's stored value, a refine that removed the exact field the
 * user was filtering on left the table showing zero records -- with no
 * visible filter chip or error to explain why -- until the user happened
 * to notice and click "Clear filters". Confirms the filtered-down table
 * (1 of 2 records) reverts to showing both records once a refine removes
 * the "status" field being filtered on, without remounting.
 */
test("EntityPanel drops a field filter when a live refine removes the exact field it filters on, instead of silently showing zero records", async () => {
  await withJsdom(async () => {
    const statusField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const entityWithStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusField],
    };
    const entityWithoutStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithStatus, allEntities: [entityWithStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "new" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Acme Corp"),
        "filtering to status=new must leave only Acme Corp visible",
      );

      // Simulate a refine that removes "status" -- the exact field being
      // filtered on -- while staying on the exact same entity.name
      // ("Deal"), the same way App.tsx's real key={entity.name} never
      // remounts for this.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutStatus, allEntities: [entityWithoutStatus] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Globex"),
        "both records must be visible again once the stale 'status' filter is dropped, not stuck hiding Globex forever",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 751: the field-removed case just above was already fixed, but a
 * live refine that changes a field's TYPE while keeping its exact name
 * (e.g. "status" going from enum to boolean) left the stored filter
 * value untouched -- fieldNamesKey alone doesn't even change for this,
 * since the set of field names is identical. "won" (a real enum value a
 * moment ago) is not "true"/"false", so every record's own real boolean
 * value fails visibleRecords' own string-equality check, exactly the
 * same "entire table silently empties" failure the field-removed case
 * has, but without even a working Clear-filters button pointing at an
 * obviously-wrong value -- the toolbar <select> just renders with
 * nothing selected.
 */
test("EntityPanel drops a field filter when a live refine changes that field's type, instead of silently showing zero records", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const statusBooleanField = { name: "status", label: "Status", type: "boolean" as const, required: true };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithBooleanStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusBooleanField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "won" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Globex"),
        "filtering to status=won must leave only Globex visible",
      );

      // Simulate a refine that retypes "status" from enum to boolean
      // while staying on the exact same entity.name ("Deal") and the
      // exact same field name ("status") -- the same live-refine,
      // no-remount scenario the field-removed test above exercises.
      view.rerender(buildEntityPanelElement({ entity: entityWithBooleanStatus, allEntities: [entityWithBooleanStatus] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Acme Corp") &&
          document.querySelector("table tbody")?.textContent?.includes("Globex"),
        "both records must be visible again once the now-type-mismatched 'status' filter (\"won\") is dropped, not stuck hiding everything forever",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 882: round 751's own two shape checks (boolean value must be
 * "true"/"false", relation value must be a plain non-negative integer id)
 * only cover a field retyped INTO boolean/relation -- they miss a field
 * that drops out of findFilterableFields's own qualifying set a different
 * way: an enum field whose enumValues count grows past
 * findFilterableEnumFields's own 2-8 "workable" range. The field's own
 * TYPE never changes (still "enum"), so this isn't even a type-shape
 * mismatch the way enum->boolean is -- it's the toolbar's own filter
 * dropdown for "status" disappearing entirely once there are too many
 * values to offer a workable dropdown for, while visibleRecords' filter
 * predicate keeps applying the stale value regardless, with the
 * "status" <select> no longer rendered at all to reveal or clear it.
 */
test("EntityPanel drops a field filter when a live refine widens that enum field past the filterable value-count range, instead of silently showing zero records", async () => {
  await withJsdom(async () => {
    const statusFieldFewValues = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const manyValues = Array.from({ length: 9 }, (_, i) => `v${i}`);
    const statusFieldManyValues = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: manyValues,
      enumLabels: Object.fromEntries(manyValues.map((v) => [v, v])),
    };
    const entityWithFewValues: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldFewValues],
    };
    const entityWithManyValues: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusFieldManyValues],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithFewValues, allEntities: [entityWithFewValues] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "won" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Globex"),
        "filtering to status=won must leave only Globex visible",
      );

      // Simulate a refine that widens "status" to 9 enum values -- past
      // findFilterableEnumFields's own 2-8 range -- while staying on the
      // exact same entity.name ("Deal") and the exact same field name
      // ("status"). The field's own type stays "enum" throughout.
      view.rerender(buildEntityPanelElement({ entity: entityWithManyValues, allEntities: [entityWithManyValues] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(
        document.querySelector(".entity-status-filter"),
        null,
        "the toolbar's own filter dropdown for 'status' must no longer render once it has too many values to be filterable",
      );
      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Acme Corp") &&
          document.querySelector("table tbody")?.textContent?.includes("Globex"),
        "both records must be visible again once the now-unfilterable 'status' field's stale filter (\"won\") is dropped, not stuck hiding everything forever",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 882, the sibling direction: a field retyped away from enum/
 * boolean/relation into something findFilterableFields never offers a
 * filter for at all (number/text/longtext/date) was equally missed by
 * round 751's own two shape checks, since neither checks for "boolean"
 * nor "relation" -- the new type is neither -- so the stale enum-shaped
 * value fell through unchanged.
 */
test("EntityPanel drops a field filter when a live refine retypes that field to a non-filterable type, instead of silently showing zero records", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["new", "won"],
      enumLabels: { new: "New", won: "Won" },
    };
    const statusNumberField = { name: "status", label: "Status", type: "number" as const, required: true };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithNumberStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusNumberField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "won" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      // Simulate a refine that retypes "status" from enum to number --
      // neither boolean nor relation, so round 751's own two checks never
      // fire -- while staying on the exact same entity.name ("Deal") and
      // field name ("status").
      view.rerender(buildEntityPanelElement({ entity: entityWithNumberStatus, allEntities: [entityWithNumberStatus] }));
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(
        document.querySelector(".entity-status-filter"),
        null,
        "the toolbar's own filter dropdown for 'status' must no longer render once it's a number field",
      );
      assert.ok(
        document.querySelector("table tbody")?.textContent?.includes("Acme Corp") &&
          document.querySelector("table tbody")?.textContent?.includes("Globex"),
        "both records must be visible again once the now-unfilterable 'status' field's stale filter (\"won\") is dropped, not stuck hiding everything forever",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 780: the same "field TYPE changes while its NAME survives a live
 * refine" bug class round 751 fixed for fieldFilters above, never fixed
 * for groupFieldName. Before the fix, grouping by "status" (an enum with
 * real values "Pending"/"Shipped") through a refine that retypes it to
 * boolean kept the SAME grouping selection -- groupRecordsByField's
 * boolean branch then ran `Boolean(r.status)` against the still-stale
 * enum strings, and since both "Pending" and "Shipped" are non-empty
 * (hence truthy), EVERY record landed in a single, confidently-labeled
 * "Yes" group, misrepresenting real business data with no error or
 * visible sign anything was wrong. Confirms the fix: the stale grouping
 * is dropped entirely (back to a flat, ungrouped table) the moment the
 * field's type changes out from under it, rather than silently
 * mislabeling every record.
 */
test("EntityPanel drops the 'Group by' selection when a live refine changes that field's type, instead of silently mislabeling every record", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["Pending", "Shipped"],
      enumLabels: { Pending: "Pending", Shipped: "Shipped" },
    };
    const statusBooleanField = { name: "status", label: "Status", type: "boolean" as const, required: true };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithBooleanStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusBooleanField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "Pending" },
      { id: 2, createdAt: "x", name: "Globex", status: "Shipped" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      // Simulate a refine that retypes "status" from enum to boolean
      // while staying on the exact same entity.name ("Deal") and the
      // exact same field name ("status") -- the same live-refine,
      // no-remount scenario the fieldFilters test above exercises.
      view.rerender(buildEntityPanelElement({ entity: entityWithBooleanStatus, allEntities: [entityWithBooleanStatus] }));
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 0);

      assert.equal(
        (document.querySelector(".entity-group-by") as HTMLSelectElement).value,
        "",
        "the 'Group by' dropdown must reset to 'no grouping', not keep pointing at the now-retyped field",
      );
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "both records must render as a normal, ungrouped table");
      assert.doesNotMatch(
        document.querySelector("table tbody")?.textContent ?? "",
        /Yes/,
        "must never show a fabricated 'Yes' group mislabeling both records from their stale enum values",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 838: the same hazard round 780 fixed above, reached a different
 * way -- round 780's own fix is an in-memory ref with nothing to compare
 * against the instant a FRESH EntityPanel mounts (switching to a
 * different entity tab and back genuinely unmounts and remounts this
 * component, per App.tsx's own `.filter((e) => e.name === activeEntity)`,
 * not just a rerender with the same instance the way round 780's own test
 * above simulates). A refine that retypes the grouped field while its tab
 * is NOT the active one left the persisted "Group by" selection pointing
 * at the field under its new, incompatible type the instant the tab
 * reopened -- confirms the fix: a fresh mount drops the stale selection
 * instead of grouping real records under the same kind of fabricated
 * "Yes" bucket round 780's own fix prevents for the still-mounted case.
 */
test("EntityPanel drops a persisted 'Group by' selection on a fresh mount when the field was retyped while its tab was closed, instead of silently mislabeling every record", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["Pending", "Shipped"],
      enumLabels: { Pending: "Pending", Shipped: "Shipped" },
    };
    const statusBooleanField = { name: "status", label: "Status", type: "boolean" as const, required: true };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithBooleanStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusBooleanField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "Pending" },
      { id: 2, createdAt: "x", name: "Globex", status: "Shipped" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const firstMount = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const groupBySelect = () => document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect(), { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      // Simulates switching away to another entity tab -- a real
      // unmount, not a rerender of the same instance (App.tsx's own
      // EntityPanel genuinely unmounts when its tab isn't the active
      // one). The persisted "Group by" choice survives this, same as
      // every other per-entity preference.
      firstMount.unmount();

      // Simulates a refine retyping "status" from enum to boolean while
      // the Deal tab was closed -- a fresh render() call (not .rerender()
      // on the old instance), so this is a genuinely new EntityPanel
      // mount with no memory of the previous one's own ref.
      renderEntityPanel({ entity: entityWithBooleanStatus, allEntities: [entityWithBooleanStatus] });
      // data-record-id, not a bare tr count -- if the stale grouping is
      // still active (the bug this test exists to catch), the table also
      // renders extra group-header <tr> elements with no such attribute,
      // which would make a bare "=== 2" condition never become true.
      await waitForCondition(() => document.querySelectorAll("table tbody tr[data-record-id]").length === 2);

      assert.equal(
        groupBySelect().value,
        "",
        "a fresh mount must drop the stale 'Group by' selection, not keep pointing at the now-retyped field",
      );
      assert.equal(document.querySelectorAll(".entity-group-header-row").length, 0, "the table must render flat, not grouped");
      assert.doesNotMatch(
        document.querySelector("table tbody")?.textContent ?? "",
        /Yes/,
        "must never show a fabricated 'Yes' group mislabeling both records from their stale enum values",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 781: the identical "field TYPE changes while its NAME survives a
 * live refine" bug class round 780 just fixed for groupFieldName, now
 * fixed for its sibling bulkEditField/bulkEditValue. Before the fix,
 * picking an enum value ("Shipped") for the bulk-edit "status" field,
 * then a live refine retyping "status" to boolean while the panel stays
 * open, left bulkEditValue as the stale string "Shipped" -- FieldInput's
 * boolean branch (`checked={Boolean(value)}`) then rendered the checkbox
 * pre-checked, even though the user never touched it, actively
 * misrepresenting an unmade choice as "on". Confirms the fix: the stale
 * value is reset to a type-appropriate empty value (false for boolean)
 * the moment the type changes out from under it.
 */
test("EntityPanel resets a stale bulk-edit value when a live refine changes that field's type, instead of rendering a misleadingly pre-checked checkbox", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: false,
      enumValues: ["Pending", "Shipped"],
      enumLabels: { Pending: "Pending", Shipped: "Shipped" },
    };
    const statusBooleanField = { name: "status", label: "Status", type: "boolean" as const, required: false };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithBooleanStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusBooleanField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "Pending" },
      { id: 2, createdAt: "x", name: "Globex", status: "Shipped" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);

      const fieldPicker = document.querySelector(".bulk-edit-field-label select") as HTMLSelectElement;
      fireEvent.change(fieldPicker, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".bulk-actions-bar select").length === 2);
      const valueSelect = document.querySelectorAll(".bulk-actions-bar select")[1] as HTMLSelectElement;
      fireEvent.change(valueSelect, { target: { value: "Shipped" } });
      await waitForCondition(() => valueSelect.value === "Shipped");

      // Simulate a refine that retypes "status" from enum to boolean
      // while staying on the exact same entity.name ("Deal") and the
      // exact same field name ("status"), with the bulk-edit panel still
      // open and "status" still selected -- the same live-refine,
      // no-remount scenario the groupFieldName test above exercises.
      view.rerender(buildEntityPanelElement({ entity: entityWithBooleanStatus, allEntities: [entityWithBooleanStatus] }));
      await waitForCondition(() => document.querySelector(".bulk-actions-bar input[type='checkbox']") !== null);

      const checkbox = document.querySelector(".bulk-actions-bar input[type='checkbox']") as HTMLInputElement;
      assert.equal(
        checkbox.checked,
        false,
        "the stale enum value \"Shipped\" must never be coerced into a pre-checked checkbox the user never actually chose",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 800: the identical "field TYPE changes while its NAME survives a
 * live refine" bug class rounds 780/781 already fixed for groupFieldName
 * and bulkEditField/bulkEditValue, missed for a third sibling that goes
 * through the exact same FieldInput type-branch dispatch -- editingCell/
 * cellDraft, the in-progress inline table-cell editor. Before the fix,
 * double-clicking a cell to inline-edit an enum field left cellDraft
 * holding the stored string value ("Shipped"); a live refine retyping
 * that same field to boolean while the panel stayed open (no remount,
 * same entity.name) would re-render that still-open cell through
 * FieldInput's boolean branch (`checked={Boolean(value)}`) with the
 * stale string still in cellDraft -- a pre-checked checkbox the user
 * never touched, and blurring normally would PATCH the unchanged string
 * against the now-boolean field. Confirms the fix: the in-progress edit
 * is cancelled outright the moment the field's type changes underneath
 * it, instead of rendering a misleading control for a stale draft.
 */
test("EntityPanel cancels an in-progress inline cell edit when a live refine changes that field's type, instead of rendering a misleadingly pre-checked checkbox", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: false,
      enumValues: ["Pending", "Shipped"],
      enumLabels: { Pending: "Pending", Shipped: "Shipped" },
    };
    const statusBooleanField = { name: "status", label: "Status", type: "boolean" as const, required: false };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithBooleanStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusBooleanField],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "Shipped" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const statusCell = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      fireEvent.doubleClick(statusCell);
      await waitForCondition(() => document.querySelector("td.cell-editing select") !== null);
      assert.equal((document.querySelector("td.cell-editing select") as HTMLSelectElement).value, "Shipped", "the draft must start pre-filled with the record's own current enum value");

      // Simulate a refine that retypes "status" from enum to boolean while
      // staying on the exact same entity.name ("Deal") and the exact same
      // field name ("status"), with the cell still open for editing --
      // the same live-refine, no-remount scenario the bulk-edit test above
      // exercises.
      view.rerender(buildEntityPanelElement({ entity: entityWithBooleanStatus, allEntities: [entityWithBooleanStatus] }));

      assert.equal(document.querySelector("td.cell-editing") === null, true, "the in-progress edit must be cancelled outright, not left open with a stale draft fed into the field's new type");
      // Compared as a boolean, not assert.equal(element, null, ...) directly
      // -- that form's default diff formatter hangs on jsdom's circular DOM
      // structure when the assertion actually fails (round 799's own lesson).
      // Excludes td.select-col's own unrelated row-select checkbox, which
      // is always present regardless of any inline edit.
      const statusCellAfterRetype = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      assert.equal(statusCellAfterRetype.querySelector("input[type='checkbox']") === null, true, "no checkbox must render in the status cell at all -- it must revert to its normal, non-editing display");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 892: rounds 780/781/800's own guards (`currentType && ... &&
 * currentType !== ref.current`) only ever fire when the selected field
 * RETYPES while its name survives a live refine -- not when the field is
 * REMOVED from the entity outright. A removal leaves `currentType`
 * undefined, which makes `currentType &&` false, so the guard silently
 * no-opped.
 *
 * Confirmed with an independently observable, single-action symptom for
 * two of the three siblings: groupFieldName's persisted storage stayed
 * pointed at the deleted field name (the test just below), and
 * bulkEditField's "Apply" button -- gated only on `bulkEditField` being
 * truthy, not on the field still existing -- stayed clickable with a
 * stale, now-nonexistent field name even after its own value control
 * (FieldInput) had already vanished (the test after that). The third
 * sibling, editingCell, shares the identical buggy guard shape, but was
 * checked and found to have NO independently observable single-action
 * symptom: the editing `<td>` itself is only ever rendered by iterating
 * the CURRENT entity.fields, so it (and cellDraft) disappear from the DOM
 * the instant the field is removed regardless of whether editingCell's
 * own React state was actually reset -- there is no live user
 * interaction left that can reach the stale reference. Its matching code
 * fix (removing the same `currentType &&` guard) is kept anyway as a
 * harmless, correct consistency fix mirroring its two confirmed
 * siblings -- cancelling a dangling edit is never wrong -- but is
 * deliberately NOT claimed as fixing an observed bug, and has no test of
 * its own here, to avoid a dishonest regression test that would pass
 * before and after a "fix" with no real behavioral difference to prove.
 */
test("EntityPanel drops the 'Group by' selection when a live refine REMOVES that field outright, not just retypes it", async () => {
  await withJsdom(async () => {
    // "active" (boolean, also groupable) stays present on BOTH versions
    // of the entity below, so groupableFields never empties out and the
    // "Group by" <select> itself keeps rendering after "status" is
    // removed -- isolating this test to the actual claim (groupFieldName
    // resets to "", not that the control disappears because nothing else
    // is groupable).
    const activeBooleanField = { name: "active", label: "Active", type: "boolean" as const, required: false };
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: true,
      enumValues: ["Pending", "Shipped"],
      enumLabels: { Pending: "Pending", Shipped: "Shipped" },
    };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField, activeBooleanField],
    };
    const entityWithoutStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, activeBooleanField],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "Pending", active: true },
      { id: 2, createdAt: "x", name: "Globex", status: "Shipped", active: false },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);
      assert.equal(getGroupByField("proj1", "Deal"), "status", "sanity check: grouping must actually be persisted before the removal");

      // Simulate a refine that REMOVES "status" entirely -- not a retype,
      // a genuine deletion -- while staying on the exact same
      // entity.name ("Deal"), with "Group by: status" still selected.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutStatus, allEntities: [entityWithoutStatus] }));
      await waitForCondition(() => getGroupByField("proj1", "Deal") === "");

      // Asserts on the PERSISTED storage, not the <select> element's own
      // .value -- an HTML select whose controlled value matches no
      // rendered <option> silently falls back its own DOM .value to the
      // first real option regardless of what groupFieldName's actual
      // React state holds (the exact round-883 test-design pitfall: a
      // bare DOM-value assertion can pass even against genuinely buggy
      // code, since "status" disappearing from groupableFields already
      // makes groupField resolve to null and the table render ungrouped
      // either way -- that part was never broken). The real bug is
      // whether groupFieldName/storage itself actually got reset, which
      // only a check independent of the select's own display can catch.
      assert.equal(
        getGroupByField("proj1", "Deal"),
        "",
        "the persisted 'Group by' selection must be cleared, not keep pointing at a field name that no longer exists",
      );
      assert.equal(document.querySelectorAll(".entity-group-header-row").length, 0, "the table must render flat, not grouped");
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "both records must render as a normal, ungrouped table");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("EntityPanel clears a stale bulk-edit field selection when a live refine REMOVES that field outright, not just retypes it", async () => {
  await withJsdom(async () => {
    const statusEnumField = {
      name: "status",
      label: "Status",
      type: "enum" as const,
      required: false,
      enumValues: ["Pending", "Shipped"],
      enumLabels: { Pending: "Pending", Shipped: "Shipped" },
    };
    const entityWithEnumStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, statusEnumField],
    };
    const entityWithoutStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "Pending" },
      { id: 2, createdAt: "x", name: "Globex", status: "Shipped" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumStatus, allEntities: [entityWithEnumStatus] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);

      const fieldPicker = document.querySelector(".bulk-edit-field-label select") as HTMLSelectElement;
      fireEvent.change(fieldPicker, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".bulk-actions-bar select").length === 2);
      const valueSelect = document.querySelectorAll(".bulk-actions-bar select")[1] as HTMLSelectElement;
      fireEvent.change(valueSelect, { target: { value: "Shipped" } });
      await waitForCondition(() => valueSelect.value === "Shipped");

      // Simulate a refine that REMOVES "status" entirely -- not a
      // retype -- while staying on the exact same entity.name ("Deal"),
      // with the bulk-edit panel still open and "status" still selected.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutStatus, allEntities: [entityWithoutStatus] }));

      const applyButton = () => Array.from(document.querySelectorAll(".bulk-actions-bar button")).find((b) => b.textContent?.includes("Apply"));
      await waitForCondition(() => applyButton() === undefined);

      // Asserts on the Apply button's own presence, not the field
      // <select>'s DOM .value -- that value falls back to the select's
      // first real <option> (the empty placeholder here) the instant
      // "status" disappears from bulkEditableFields' own option list,
      // regardless of whether bulkEditField's actual React state was
      // ever reset (the exact round-883 test-design pitfall: a bare
      // DOM-value assertion can pass even against genuinely buggy code).
      // The Apply button's own render guard is `{bulkEditField && (...)}`
      // -- truthy string "status" alone is enough to keep it rendered,
      // with nothing stopping a user from clicking it and sending a PATCH
      // for a field name the server no longer recognizes on this entity
      // at all, even though the value control (FieldInput) right next to
      // it already vanished (its own guard also requires the now-missing
      // field definition).
      assert.equal(
        applyButton(),
        undefined,
        "the 'Apply' button must disappear once bulkEditField is actually cleared, not stay clickable with a stale, now-nonexistent field name",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 805: the fourth sibling of the same "field TYPE changes while its
 * NAME survives a live refine" bug class rounds 780/781/800 already fixed
 * for groupFieldName, bulkEditField/bulkEditValue, and editingCell/
 * cellDraft -- the main add/edit record form's own `form` state. Fills in
 * the enum field with "High" in the (always-visible) create form, then
 * simulates a refine retyping that same field to boolean while the panel
 * stays mounted (same entity.name, no remount) -- the identical live-
 * refine scenario the three sibling tests above exercise. Before the fix,
 * FieldInput's boolean branch would render `checked={Boolean("High")}` --
 * true, a pre-checked checkbox the user never touched. Also confirms the
 * fix resets only the retyped field, not the user's already-typed "name"
 * value, matching the sibling fixes' own "preserve everything else"
 * behavior (bulkEditValue/groupFieldName recompute just their one field;
 * this is the multi-field analog).
 */
test("EntityPanel resets a stale create-form value when a live refine changes that field's type, instead of rendering a misleadingly pre-checked checkbox", async () => {
  await withJsdom(async () => {
    const priorityEnumField = {
      name: "priority",
      label: "Priority",
      type: "enum" as const,
      required: false,
      enumValues: ["Low", "Medium", "High"],
      enumLabels: { Low: "Low", Medium: "Medium", High: "High" },
    };
    const priorityBooleanField = { name: "priority", label: "Priority", type: "boolean" as const, required: false };
    const entityWithEnumPriority: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityEnumField],
    };
    const entityWithBooleanPriority: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityBooleanField],
    };
    const store: EntityRecord[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumPriority, allEntities: [entityWithEnumPriority] });
      await waitForCondition(() => document.querySelector(".record-form select") !== null);

      const nameInput = document.querySelector(".record-form input[type='text']") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Acme Corp" } });
      const prioritySelect = document.querySelector(".record-form select") as HTMLSelectElement;
      fireEvent.change(prioritySelect, { target: { value: "High" } });
      await waitForCondition(() => prioritySelect.value === "High");

      // Simulate a refine that retypes "priority" from enum to boolean
      // while staying on the exact same entity.name ("Deal") and the exact
      // same field name ("priority"), with the create form still open and
      // "priority" still holding the stale enum value -- the same live-
      // refine, no-remount scenario the three sibling tests above exercise.
      view.rerender(buildEntityPanelElement({ entity: entityWithBooleanPriority, allEntities: [entityWithBooleanPriority] }));
      await waitForCondition(() => document.querySelector(".record-form input[type='checkbox']") !== null);

      const checkbox = document.querySelector(".record-form input[type='checkbox']") as HTMLInputElement;
      assert.equal(
        checkbox.checked,
        false,
        "the stale enum value \"High\" must never be coerced into a pre-checked checkbox the user never actually chose",
      );
      const nameInputAfterRetype = document.querySelector(".record-form input[type='text']") as HTMLInputElement;
      assert.equal(nameInputAfterRetype.value, "Acme Corp", "a field unaffected by the retype must keep whatever the user already typed into it");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 898: the identical "field TYPE changes while its NAME survives a
 * live refine" bug class round 805's own fix just above closes, but
 * reached through a path that fix's own `formFieldTypesRef` cannot see --
 * removing a field via one refine, then a SECOND, separate refine adding
 * back a field with the exact same name but a different type. The round
 * 805 effect unconditionally rebuilds formFieldTypesRef.current from only
 * the CURRENT entity.fields on every run (line ~1931), so a field's entry
 * is silently dropped from the ref the instant it's removed -- when it
 * later reappears under the same name, prevTypes[f.name] is undefined,
 * the `retypedFields` filter's `prevTypes[f.name] && ...` is falsy, and
 * the field is never flagged as retyped. The stale pre-removal value sits
 * in `form` the whole time (removal itself doesn't render anything that
 * needs resetting), then leaks straight through once the field returns.
 */
test("EntityPanel resets a stale create-form value when a field is removed by one live refine and a differently-typed field reappears under the same name in a later one", async () => {
  await withJsdom(async () => {
    const priorityEnumField = {
      name: "priority",
      label: "Priority",
      type: "enum" as const,
      required: false,
      enumValues: ["Low", "Medium", "High"],
      enumLabels: { Low: "Low", Medium: "Medium", High: "High" },
    };
    const priorityBooleanField = { name: "priority", label: "Priority", type: "boolean" as const, required: false };
    const entityWithEnumPriority: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityEnumField],
    };
    const entityWithoutPriority: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    };
    const entityWithBooleanPriority: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }, priorityBooleanField],
    };
    const store: EntityRecord[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel({ entity: entityWithEnumPriority, allEntities: [entityWithEnumPriority] });
      await waitForCondition(() => document.querySelector(".record-form select") !== null);

      const prioritySelect = document.querySelector(".record-form select") as HTMLSelectElement;
      fireEvent.change(prioritySelect, { target: { value: "High" } });
      await waitForCondition(() => prioritySelect.value === "High");

      // First refine: removes "priority" entirely, with the create form
      // still open and "priority" still holding the stale enum value.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutPriority, allEntities: [entityWithoutPriority] }));
      await waitForCondition(() => document.querySelector(".record-form select") === null);

      // Second, separate refine: adds back a field named "priority", but
      // as a boolean this time -- the exact same entity.name ("Deal"),
      // still no remount, create form still open.
      view.rerender(buildEntityPanelElement({ entity: entityWithBooleanPriority, allEntities: [entityWithBooleanPriority] }));
      await waitForCondition(() => document.querySelector(".record-form input[type='checkbox']") !== null);

      const checkbox = document.querySelector(".record-form input[type='checkbox']") as HTMLInputElement;
      assert.equal(
        checkbox.checked,
        false,
        "the stale enum value \"High\" (from before the field was removed) must never be coerced into a pre-checked checkbox the user never actually chose",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 500's finding: sortKeys' own re-validation
 * effect (sibling to viewMode's and fieldFilters', fixed in rounds 490 and
 * 493 respectively) was never given the same fix -- it only dropped a sort
 * key referencing a removed field on [projectId, entity.name] (an actual
 * tab switch), never while the tab stays mounted through a live Refine.
 * With a dead key still occupying an earlier array index than a surviving
 * one, the surviving key's own priority badge stayed misnumbered (showing
 * "2" with no "1" anywhere) and its <th> reported the wrong aria-sort
 * (keyIndex !== 0, so "none" instead of the real sort direction) --
 * visually and for assistive tech it looked like sorting had silently
 * broken, even though the surviving key was still the only one doing
 * anything. Confirms a two-key sort (status, then name) collapses to a
 * single, properly-numbered/aria-reported key once a refine removes
 * "status" without remounting.
 */
test("EntityPanel drops a dead sort key when a live refine removes its field, instead of misnumbering the surviving key's priority badge", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Globex", status: "won" },
    ];
    const entityWithoutStatus: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const statusHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      const nameHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Name/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      fireEvent.click(statusHeader);
      fireEvent.click(nameHeader, { shiftKey: true });
      await waitForCondition(() => document.querySelectorAll(".sort-priority").length === 2);
      assert.equal(nameHeader.closest("th")!.getAttribute("aria-sort"), "none", "name starts as the second, non-primary sort key");

      // Simulate a refine that removes "status" -- the primary sort key's
      // own field -- while staying on the exact same entity.name ("Deal"),
      // the same way App.tsx's real key={entity.name} never remounts for
      // this.
      view.rerender(buildEntityPanelElement({ entity: entityWithoutStatus, allEntities: [entityWithoutStatus] }));

      await waitForCondition(() => document.querySelectorAll(".sort-priority").length === 0);
      const nameHeaderAfter = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Name/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      assert.equal(
        nameHeaderAfter.closest("th")!.getAttribute("aria-sort"),
        "ascending",
        "the surviving 'name' key must become the sole, primary sort key -- reported via aria-sort -- not stuck at a stale secondary index",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the table view had no way to move between rows
 * without reaching for the mouse. j/k (and ArrowDown/ArrowUp) move a
 * keyboard focus between visible rows, and Enter opens the focused row for
 * editing -- reusing the exact same startEdit the row's own Edit button
 * already calls. Also confirms the isTypingTarget guard: pressing "j"
 * while the search box itself has focus must type a literal "j" into the
 * search box, not hijack the keystroke to move the table's row focus.
 */
test("EntityPanel's table rows support j/k row navigation and Enter-to-edit, without hijacking keystrokes typed into the search box", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
      { id: 3, name: "Initech", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      const addLabel = submitButton.textContent;

      // The keydown listener attaches from a useEffect, one tick after the
      // rows themselves first render -- redispatching "j" until it lands
      // (rather than firing it exactly once right after the row-count wait)
      // avoids a real race against that one-tick gap, instead of guessing
      // a fixed number of extra ticks to sleep first.
      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const focused = document.querySelector(".record-row-focused") as HTMLElement;
      assert.ok(focused, "the first 'j' must eventually focus a row once the keydown listener attaches");
      assert.equal(focused.getAttribute("data-record-id"), "1", "the first 'j' must focus the first visible row");

      // A second "j" (and an ArrowDown) each move one row further.
      fireEvent.keyDown(window, { key: "j" });
      await waitForCondition(() => (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id") === "2");
      fireEvent.keyDown(window, { key: "ArrowDown" });
      await waitForCondition(() => (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id") === "3");

      // Already on the last row -- one more "j" must NOT wrap back to the first.
      fireEvent.keyDown(window, { key: "j" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id"),
        "3",
        "j must clamp at the last row instead of wrapping around to the first",
      );

      // "k" (and ArrowUp) move focus back up.
      fireEvent.keyDown(window, { key: "k" });
      await waitForCondition(() => (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id") === "2");

      // Enter on the focused row (Globex, id 2) opens it for editing --
      // the exact same effect as clicking that row's own Edit button.
      fireEvent.keyDown(window, { key: "Enter" });
      await waitForCondition(() => submitButton.textContent !== addLabel);
      const nameInput = document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      assert.equal(nameInput.value, "Globex", "Enter must open the focused row (Globex), not some other record");

      // Pressing "j" while the search box itself has focus (as it does the
      // instant the user starts typing a real search) must never hijack
      // the keystroke to move the table's row focus -- isTypingTarget's job.
      // If the guard were broken, this "j" would move focus from row 2 to
      // row 3, so checking it's *unchanged* is a real, precise assertion.
      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.keyDown(searchBox, { key: "j" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id"),
        "2",
        "a 'j' keydown targeting the search box must not move the keyboard-focused row",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 485's finding: j/k's own visibleIds used to be
 * built from the flat visibleRecords array, oblivious to table grouping --
 * when a group is collapsed, its records are skipped from the <tbody>
 * entirely (see the table body render), yet the old visibleIds still
 * contained them, so "j" could silently focus a row the user can't see,
 * and Enter/x/Delete/d would then act on that invisible record. Confirms
 * j/k now skips entirely over a collapsed group's records instead of
 * landing on them.
 */
test("EntityPanel's j/k row navigation skips over records hidden inside a collapsed group", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "won" },
      { id: 3, name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3, 100);
      assert.ok(
        !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Beta Inc")),
        "the 'Won' group must actually be collapsed before testing navigation",
      );

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(
        (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id"),
        "1",
        "the first 'j' must focus the only visible record (Acme Corp, id 1)",
      );

      // Both Beta Inc (2) and Gamma LLC (3) are hidden inside the collapsed
      // 'Won' group -- further "j" presses must NOT move the focus onto
      // either of them, since neither row exists in the rendered table.
      fireEvent.keyDown(window, { key: "j" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id"),
        "1",
        "'j' must clamp at the one visible row instead of landing on a record hidden inside a collapsed group",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: j/k/Enter above let a keyboard-only user navigate to
 * and open any record, but there was no way to actually SELECT a row (the
 * checkbox toggleSelected already wires to onClick) without reaching for
 * the mouse -- a fully keyboard-driven user could never build a multi-row
 * selection to bulk-delete/duplicate/edit. "x" toggles the focused row's
 * own selection, confirmed via the real checkbox's checked state (not
 * just a CSS class), and confirms the isTypingTarget guard: pressing "x"
 * while the search box has focus must type a literal "x", not toggle
 * selection.
 */
test("EntityPanel's 'x' shortcut toggles the focused row's own selection checkbox, without hijacking keystrokes typed into the search box", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const focused = document.querySelector(".record-row-focused") as HTMLElement;
      assert.equal(focused.getAttribute("data-record-id"), "1", "sanity check: 'j' must have focused the first row");
      const checkbox = focused.querySelector('input[type="checkbox"]') as HTMLInputElement;
      assert.ok(checkbox, "expected a real selection checkbox in the focused row");
      assert.equal(checkbox.checked, false, "the row must start unselected");

      fireEvent.keyDown(window, { key: "x" });
      await waitForCondition(() => checkbox.checked === true);
      assert.equal(
        document.querySelectorAll('tr[data-record-id="2"] input[type="checkbox"]:checked').length,
        0,
        "'x' must select only the focused row, not the other one",
      );

      // Pressing "x" again on the same focused row must deselect it.
      fireEvent.keyDown(window, { key: "x" });
      await waitForCondition(() => checkbox.checked === false);

      // Pressing "x" while the search box itself has focus must type a
      // literal "x" there instead of toggling the focused row's selection.
      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.keyDown(searchBox, { key: "x" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(checkbox.checked, false, "a 'x' keydown targeting the search box must not toggle the focused row's selection");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: j/k/Enter/x above let a keyboard-only user navigate,
 * open, and select rows, but deleting one still required reaching for the
 * mouse (the row's own Delete button). Delete/Backspace now delete the
 * focused row, reusing handleDelete's own confirm dialog and undo-toast
 * verbatim (the exact same function the mouse-driven button already
 * calls) -- so this confirms window.confirm is actually invoked (not
 * bypassed), the row disappears once confirmed, and the isTypingTarget
 * guard still applies: pressing Delete/Backspace while the search box has
 * focus must edit its own text (deleting a character), not delete a
 * record.
 */
test("EntityPanel's Delete/Backspace shortcut deletes the focused row via the real confirm dialog, without hijacking keystrokes typed into the search box", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    let confirmCalls = 0;
    globalThis.window.confirm = (() => {
      confirmCalls += 1;
      return true;
    }) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const focused = document.querySelector(".record-row-focused") as HTMLElement;
      assert.equal(focused.getAttribute("data-record-id"), "1", "sanity check: 'j' must have focused the first row");

      // Pressing Delete/Backspace while the search box has focus must never
      // trigger the delete confirm dialog or remove a row (isTypingTarget's
      // job) -- fired at the search box itself, same as the "j"/"x" guard
      // tests above, without changing its value (a real Backspace there
      // would edit its own text, not delete a record either way).
      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.keyDown(searchBox, { key: "Backspace" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(confirmCalls, 0, "a Backspace keydown targeting the search box must never trigger the delete confirm dialog");
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "no row must be deleted while the search box had focus");

      fireEvent.keyDown(window, { key: "Delete" });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.equal(confirmCalls, 1, "the real confirm dialog must actually be invoked, not bypassed");
      assert.equal(
        document.querySelector('tr[data-record-id="1"]'),
        null,
        "the focused row (Acme Corp, id 1) must be the one deleted, not the other row",
      );
      assert.ok(document.querySelector('tr[data-record-id="2"]'), "the untouched row must still render");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: Ctrl/Cmd+Z now triggers the delete-undo toast's own
 * "Undo" action -- Delete/Backspace above was already a real keyboard
 * shortcut, but undoing that exact delete had none, a small but real
 * inconsistency in an otherwise keyboard-first flow: a keyboard-only user
 * who deleted a row with the bound key still had to reach for the mouse to
 * click the toast's "Undo" link. Confirms the row actually comes back and
 * the real DELETE request never fires, that Ctrl+Shift+Z (the conventional
 * Redo chord) does NOT also trigger it, and that pressing it again once
 * nothing is pending is a safe no-op.
 */
test("EntityPanel's Ctrl/Cmd+Z shortcut undoes a pending delete without ever calling the real delete API", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const deletedIds: number[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store, (id) => deletedIds.push(id)) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      fireEvent.keyDown(window, { key: "Delete" });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.equal(document.querySelector('tr[data-record-id="1"]'), null, "sanity check: Acme Corp (id 1) must be the one deleted");

      // The conventional Redo chord must not be hijacked into firing Undo.
      fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.querySelectorAll("table tbody tr").length, 1, "Ctrl+Shift+Z (Redo) must not undo the delete");

      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      assert.deepEqual(
        rows.map((r) => r.getAttribute("data-record-id")),
        ["1", "2"],
        "the restored row must land back at its original index, not get appended to the end",
      );
      assert.equal(deletedIds.length, 0, "undoing before the window elapsed must cancel the pending delete, never calling the real delete API");

      // Pressing it again with nothing pending must be a safe no-op.
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "Ctrl+Z with nothing pending must not throw or change anything");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * New in this round: j/k/Enter/x/Delete above let a keyboard-only user
 * navigate, open, select, and delete rows, but duplicating one still
 * required reaching for the mouse (the row's own Duplicate button). "d"
 * now duplicates the focused row, reusing handleDuplicate verbatim (the
 * exact same function the mouse-driven button already calls) -- no
 * confirm dialog, since duplicating only creates data, never destroys
 * it. Confirms the real POST fires exactly once with the focused row's
 * own field values (not the other row's), the new record actually
 * appears in the table, and the isTypingTarget guard still applies:
 * pressing "d" while the search box has focus must type a literal "d",
 * never duplicate a record.
 */
test("EntityPanel's 'd' shortcut duplicates the focused row via the real API, without hijacking keystrokes typed into the search box", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    const postedBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        postCount += 1;
        const body = JSON.parse(init!.body as string);
        postedBodies.push(body);
        const record = { id: 3, ...body };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const focused = document.querySelector(".record-row-focused") as HTMLElement;
      assert.equal(focused.getAttribute("data-record-id"), "1", "sanity check: 'j' must have focused the first row");

      // Pressing "d" while the search box has focus must type a literal "d"
      // there, never duplicate the focused row -- isTypingTarget's job.
      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.keyDown(searchBox, { key: "d" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(postCount, 0, "a 'd' keydown targeting the search box must never trigger a duplicate");
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "no row must be duplicated while the search box had focus");

      fireEvent.keyDown(window, { key: "d" });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal(postCount, 1, "the real duplicate request must fire exactly once");
      assert.equal(postedBodies[0]?.name, "Acme Corp", "the duplicate must copy the focused row's own values, not the other row's");
      assert.equal(postedBodies[0]?.status, "new");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 653: e.key is the same bare letter whether or
 * not a modifier is held, so j/k/x/Delete/d/Enter never checked
 * e.ctrlKey/metaKey/altKey before this round -- a focused row meant that
 * Ctrl/Cmd+D (the browser's own "bookmark this page" shortcut) silently
 * fired the exact same real duplicate POST as a bare "d", with no confirm
 * dialog (duplicating is designed to skip one), and Ctrl/Cmd+K, Ctrl+J,
 * Ctrl/Cmd+Enter, and Cmd+Backspace each hijacked a different browser/OS
 * shortcut the same way. Confirms Ctrl+D, Cmd+D, Ctrl+K, and Ctrl+Enter
 * (representative of the whole family, since they all go through the same
 * early-return guard) are now left alone -- no POST, no row-focus change,
 * no row opened for editing -- while a bare "d"/"k"/"Enter" still works.
 */
test("EntityPanel's table-row shortcuts ignore Ctrl/Cmd/Alt-held keys, so a browser shortcut like Ctrl/Cmd+D never fires the real duplicate request", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        postCount += 1;
        const body = JSON.parse(init!.body as string);
        const record = { id: 3, ...body };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const focused = document.querySelector(".record-row-focused") as HTMLElement;
      assert.equal(focused.getAttribute("data-record-id"), "1", "sanity check: 'j' must have focused the first row");

      fireEvent.keyDown(window, { key: "d", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(postCount, 0, "Ctrl+D must never trigger a duplicate -- it's the browser's own bookmark shortcut");
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "no row must be duplicated by Ctrl+D");

      fireEvent.keyDown(window, { key: "d", metaKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(postCount, 0, "Cmd+D must never trigger a duplicate either");
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "no row must be duplicated by Cmd+D");

      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id"),
        "1",
        "Ctrl+K must never move the focused row -- it's the app's own search shortcut",
      );

      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      const addLabel = submitButton.textContent;
      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(submitButton.textContent, addLabel, "Ctrl+Enter must never open the focused row for editing");

      // A bare "d" (no modifier) must still work -- the guard must not
      // have swallowed the ordinary shortcut along with the browser ones.
      fireEvent.keyDown(window, { key: "d" });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal(postCount, 1, "a bare 'd' with no modifier must still duplicate the focused row");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 654: j/k's own setFocusedRowId only ever moves
 * a VISUAL "focused row" highlight -- it never calls .focus() on anything,
 * so the real DOM focus (and therefore e.target on this window-level
 * listener) can be sitting on a completely unrelated button while an
 * earlier j/k press still has some row visually focused. Before this
 * round, pressing Enter while the record form's own Save button had real
 * focus got hijacked into opening the visually-focused row for editing
 * instead of submitting the form -- silently discarding an in-progress
 * edit with no confirmation. Confirms: focus row 1 with "j", start
 * editing row 2 and change its name, move real focus to the Save button,
 * press Enter there -- the edit of row 2 must survive untouched (not
 * reset to row 1's values), and no PATCH must fire for row 1.
 */
test("EntityPanel's Enter shortcut does not hijack Enter from a focused Save/Edit/Delete button elsewhere on the page", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    const patchedIds: number[] = [];
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const patchMatch = /^\/api\/projects\/proj1\/entities\/Deal\/(\d+)$/.exec(input);
      if (method === "PATCH" && patchMatch) {
        patchedIds.push(Number(patchMatch[1]));
        return new Response(JSON.stringify({ record: store[0] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(
        (document.querySelector(".record-row-focused") as HTMLElement)?.getAttribute("data-record-id"),
        "1",
        "sanity check: 'j' must have focused row 1 first",
      );

      const editButtons = Array.from(document.querySelectorAll("table tbody button")) as HTMLButtonElement[];
      const globexEdit = editButtons.find((b) => b.closest("tr")?.getAttribute("data-record-id") === "2" && /edit/i.test(b.textContent ?? ""));
      assert.ok(globexEdit, "expected an Edit button on the Globex (row 2) row");
      fireEvent.click(globexEdit!);
      const nameInput = document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      await waitForCondition(() => nameInput.value === "Globex");

      fireEvent.change(nameInput, { target: { value: "Globex Renamed" } });
      assert.equal(nameInput.value, "Globex Renamed", "sanity check: the in-progress edit draft was actually typed");

      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      submitButton.focus();
      assert.equal(document.activeElement, submitButton, "sanity check: real DOM focus is now on the Save button, not row 1");

      fireEvent.keyDown(submitButton, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(
        nameInput.value,
        "Globex Renamed",
        "Enter on the focused Save button must never be hijacked into opening row 1 for editing, discarding this in-progress edit",
      );
      assert.equal(patchedIds.length, 0, "no PATCH must fire -- this Enter is not a real form submission in jsdom, only a sanity check that nothing else fired instead");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: "x" above lets a keyboard-only user build a
 * multi-row selection, but the only way to back OUT of it was reaching
 * for the mouse -- either the round-354 "Clear selection" button, or
 * committing an actual bulk delete/duplicate/update just to escape the
 * mode. Escape now clears the selection the same way that button does
 * (setSelectedIds(new Set())), with zero API calls. Confirms the
 * isTypingTarget guard still applies: pressing Escape while the search
 * box has focus must leave an active selection untouched (it's reserved
 * for that input's own native behavior, not a shortcut to hijack).
 */
test("EntityPanel's Escape shortcut clears the table's multi-row selection, without hijacking Escape typed into the search box", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    let mutationCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      mutationCount += 1;
      throw new Error(`unexpected mutation ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      fireEvent.keyDown(window, { key: "x" });
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);
      assert.equal(
        Array.from(document.querySelectorAll('td.select-col input[type="checkbox"]')).filter((c) => (c as HTMLInputElement).checked).length,
        1,
        "the focused row must be selected before testing Escape",
      );

      // Escape targeting the search box must leave the selection untouched.
      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.keyDown(searchBox, { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(document.querySelector(".bulk-actions-bar"), "Escape at the search box must never clear the selection -- isTypingTarget's job");

      fireEvent.keyDown(window, { key: "Escape" });
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") === null);
      assert.equal(
        Array.from(document.querySelectorAll('td.select-col input[type="checkbox"]')).filter((c) => (c as HTMLInputElement).checked).length,
        0,
        "every row's own checkbox must be unchecked again",
      );
      assert.equal(document.querySelectorAll("table tbody tr").length, 2, "clearing the selection must not delete or hide any record");
      assert.equal(mutationCount, 0, "clearing the selection via Escape must never call the API");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: there was no keyboard-only way to start adding a new
 * record -- j/k/Enter above only navigate EXISTING rows. "n" jumps to a
 * blank add form and focuses its first field, discarding any in-progress
 * edit, and (unlike j/k/Enter) must keep working outside table view too,
 * since the record-form itself renders above the table/board/calendar
 * switch. Also confirms the isTypingTarget guard: pressing "n" while the
 * search box has focus must type a literal "n", not reset the form.
 */
test("EntityPanel's 'n' shortcut jumps to a blank add-record form and focuses its first field, without hijacking keystrokes typed into the search box", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const addLabel = (document.querySelector(".record-form button[type=submit]") as HTMLButtonElement).textContent;

      // Open Globex (id 2) for editing via its row's own Edit button, so
      // the form is genuinely mid-edit -- not just coincidentally blank
      // already -- before "n" is pressed.
      const editButtons = Array.from(document.querySelectorAll("table tbody button")) as HTMLButtonElement[];
      const globexEdit = editButtons.find((b) => b.closest("tr")?.getAttribute("data-record-id") === "2" && /edit/i.test(b.textContent ?? ""));
      assert.ok(globexEdit, "expected an Edit button on the Globex row");
      fireEvent.click(globexEdit!);
      await waitForCondition(() => (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value === "Globex");

      // "n" must abandon that edit: the form resets to blank, the submit
      // button reverts to its "add" label, and the first field (the name
      // text input) ends up focused -- all without any mouse click. Each
      // field now remounts on this transition (round 737's
      // formInstanceKey fix, guarding against FieldInput's own local
      // state -- e.g. a file field's upload error -- surviving into an
      // unrelated record/field), so the real "name" input is re-queried
      // fresh after "n" rather than reusing a reference captured before
      // the remount, which would be a detached node frozen at "Globex".
      for (
        let attempt = 0;
        (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value !== "" && attempt < 40;
        attempt++
      ) {
        fireEvent.keyDown(window, { key: "n" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const nameInputAfterN = document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      assert.equal(nameInputAfterN.value, "", "'n' must reset the form back to blank, discarding the in-progress edit");
      assert.equal(
        (document.querySelector(".record-form button[type=submit]") as HTMLButtonElement).textContent,
        addLabel,
        "'n' must flip the submit button back to its add-record label",
      );
      assert.equal(document.activeElement, nameInputAfterN, "'n' must focus the form's first field");

      // Regression test for round 653: e.key is "n" whether or not a
      // modifier is held, so Ctrl+N/Alt+N (browser/OS shortcuts in some
      // environments) must never be hijacked into resetting the form --
      // re-open the Globex edit and confirm a modified "n" leaves it alone.
      fireEvent.click(globexEdit!);
      await waitForCondition(() => (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value === "Globex");
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value,
        "Globex",
        "Ctrl+N must never reset the in-progress edit",
      );
      fireEvent.keyDown(window, { key: "n", altKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value,
        "Globex",
        "Alt+N must never reset the in-progress edit either",
      );

      // Pressing "n" while the search box itself has focus must type a
      // literal "n" there instead of being hijacked by the shortcut.
      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      searchBox.focus();
      searchBox.value = "";
      fireEvent.keyDown(searchBox, { key: "n" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.activeElement, searchBox, "a 'n' keydown targeting the search box must not steal focus to the add form");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 644: startEdit snapshots EVERY field of the record into `form`,
 * and the old handleSubmit sent that whole snapshot back on save -- not
 * just the field(s) the user actually edited. If another tab (or a
 * Kanban drag, or an automation) legitimately changed a DIFFERENT field
 * on this same record while the edit dialog was still open, saving used
 * to silently revert that real change back to its stale, pre-dialog
 * value, since the untouched field rode along in the PATCH body
 * unchanged. Every sibling mutation path in this file (inline-cell-edit,
 * bulk-update, drag handlers) already sends only the field(s) it means
 * to change; this proves the main Edit form now does too, by actually
 * mutating the record store out from under an open dialog (standing in
 * for the other tab/automation) before saving an edit to a different
 * field, and confirming the concurrent change survives.
 */
test("EntityPanel's main Edit form saves only the field the user actually touched, instead of reviving every other field's stale pre-dialog value", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    const patchBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const patchMatch = /^\/api\/projects\/proj1\/entities\/Deal\/(\d+)$/.exec(input);
      if (method === "PATCH" && patchMatch) {
        const data = JSON.parse(init!.body as string);
        patchBodies.push(data);
        const record = store.find((r) => r.id === Number(patchMatch[1]));
        Object.assign(record!, data);
        return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const editButtons = Array.from(document.querySelectorAll("table tbody button")) as HTMLButtonElement[];
      const editButton = editButtons.find((b) => /edit/i.test(b.textContent ?? ""));
      assert.ok(editButton, "expected an Edit button on Acme Corp's row");
      fireEvent.click(editButton!);
      const nameInput = document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      await waitForCondition(() => nameInput.value === "Acme Corp");

      // Stands in for another tab, a Kanban drag, or an automation legitimately
      // changing "status" on this exact record while the dialog is still open
      // -- bypassing this component entirely, the same way a real concurrent
      // actor would.
      Object.assign(store[0], { status: "won" });

      // The user only ever touches "name" -- never re-opens or re-reads
      // "status" through this dialog.
      fireEvent.change(nameInput, { target: { value: "Acme Corporation" } });
      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      fireEvent.click(submitButton);

      await waitForCondition(() => patchBodies.length === 1);

      assert.deepEqual(
        patchBodies[0],
        { name: "Acme Corporation" },
        "the PATCH must carry only the field the user actually edited, not every field the form happened to hold",
      );
      assert.equal(
        store[0].status,
        "won",
        "the concurrent change to 'status' must survive this save -- the stale pre-dialog value must never be sent back",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 832's finding: nothing disabled startEdit/the table's own Edit
 * buttons while an earlier handleSubmit's own PATCH/POST was still in
 * flight -- a slow save for record A resolving after the user had already
 * clicked Edit on a different record B let handleSubmit's unconditional
 * success-path reset (setForm(emptyForm)/setEditingId(null)) silently wipe
 * out B's own in-progress edit, snapping the form back to "New record"
 * with zero warning. Exactly the same "two independent in-flight states,
 * only one checked" shape round 831 just fixed for AutomationsPanel.tsx's
 * own create/edit form vs. its row actions -- here within EntityPanel's
 * single form/editingId state instead of a separate busy flag. Confirms
 * record A's slow save still genuinely completes (the table row reflects
 * its new name) while record B's own in-progress edit in the form
 * survives completely untouched.
 */
test("EntityPanel's record-form survives a different record's in-progress edit when an earlier record's slow save resolves afterward", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Beta Inc", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    let resolvePatch!: (value: Response) => void;
    const patchHeld = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Deal/1") {
        return patchHeld; // record 1's own Save stays in flight until the test resolves it
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const findEditButton = (rowText: string) => {
        const row = Array.from(document.querySelectorAll("table tbody tr")).find((r) => r.textContent?.includes(rowText))!;
        return Array.from(row.querySelectorAll("button")).find((b) => /edit/i.test(b.textContent ?? "")) as HTMLButtonElement;
      };

      const getNameInput = () => document.querySelector(".record-form input[type=text]") as HTMLInputElement;

      fireEvent.click(findEditButton("Acme Corp"));
      await waitForCondition(() => getNameInput().value === "Acme Corp");

      fireEvent.change(getNameInput(), { target: { value: "Acme Corp EDITED" } });
      fireEvent.submit(document.querySelector(".record-form")!);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let record 1's PATCH actually start before switching

      // startEdit bumps formInstanceKey, remounting the form's own fields
      // under a new key -- the name input clicked-into above is a now-
      // detached DOM node, so every reference after this point must be
      // re-queried fresh rather than reused.
      fireEvent.click(findEditButton("Beta Inc"));
      await waitForCondition(() => getNameInput().value === "Beta Inc");
      fireEvent.change(getNameInput(), { target: { value: "Beta Inc TYPING" } });

      // Stands in for the real server actually having applied record 1's
      // PATCH -- the mock's own GET handler (hit by refresh() right after
      // this resolves) must reflect that real update.
      store[0].name = "Acme Corp EDITED";
      resolvePatch(
        new Response(JSON.stringify({ record: { id: 1, name: "Acme Corp EDITED", status: "new" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await waitForCondition(() => document.querySelector("table tbody tr")!.textContent?.includes("Acme Corp EDITED") ?? false);

      assert.equal(getNameInput().value, "Beta Inc TYPING", "record B's own in-progress edit must survive record A's slow save resolving afterward");
      assert.match(
        document.querySelector(".record-form button[type=submit]")!.textContent ?? "",
        /save/i,
        "the form must still be showing an active edit (Save), not have snapped back to a blank create form (Add)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 833 regression: round 832 added formInstanceKeyRef/bumpFormInstanceKey
 * so handleSubmit's success-path reset only fires if nothing has "moved on"
 * since that submit began -- but it only converted startEdit/startCreateNew/
 * startCreateForDate/startCreateForColumn/the in-form Delete button's reset
 * to call bumpFormInstanceKey(). The Escape-to-cancel handler and the Cancel
 * button (two more places that abandon the current editing session) were
 * missed, so abandoning a slow save via Escape and then typing a fresh draft
 * used to get that draft silently wiped out once the abandoned save resolved
 * -- the exact same bug round 832 fixed, just reached a different way.
 */
test("EntityPanel's fresh draft started after Escape abandons a slow edit survives that edit's save resolving afterward", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    let resolvePatch!: (value: Response) => void;
    const patchHeld = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Deal/1") {
        return patchHeld; // the abandoned record's own Save stays in flight until the test resolves it
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const editButton = () =>
        Array.from(document.querySelectorAll("table tbody button")).find((b) => /edit/i.test(b.textContent ?? "")) as HTMLButtonElement;
      const getNameInput = () => document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      const getForm = () => document.querySelector(".record-form") as HTMLFormElement;

      fireEvent.click(editButton());
      await waitForCondition(() => getNameInput().value === "Acme Corp");

      fireEvent.change(getNameInput(), { target: { value: "Acme Corp EDITED" } });
      fireEvent.submit(getForm());
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the PATCH actually start before abandoning it

      // Escape discards the in-progress edit while that save is still in
      // flight -- this must remount the form (bumpFormInstanceKey), so any
      // reference captured before it must be re-queried fresh afterward.
      fireEvent.keyDown(getForm(), { key: "Escape" });
      await waitForCondition(() => getNameInput().value === "");

      fireEvent.change(getNameInput(), { target: { value: "Brand New Draft" } });

      store[0].name = "Acme Corp EDITED";
      resolvePatch(
        new Response(JSON.stringify({ record: { id: 1, name: "Acme Corp EDITED", status: "new" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await waitForCondition(() => document.querySelector("table tbody tr")!.textContent?.includes("Acme Corp EDITED") ?? false);

      assert.equal(
        getNameInput().value,
        "Brand New Draft",
        "the fresh draft started after Escape must survive the abandoned edit's slow save resolving afterward",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("EntityPanel's fresh draft started after the Cancel button abandons a slow edit survives that edit's save resolving afterward", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    let resolvePatch!: (value: Response) => void;
    const patchHeld = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Deal/1") {
        return patchHeld; // the abandoned record's own Save stays in flight until the test resolves it
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const editButton = () =>
        Array.from(document.querySelectorAll("table tbody button")).find((b) => /edit/i.test(b.textContent ?? "")) as HTMLButtonElement;
      const getNameInput = () => document.querySelector(".record-form input[type=text]") as HTMLInputElement;
      const getCancelButton = () =>
        Array.from(document.querySelectorAll(".record-form button[type=button]")).find((b) => /cancel/i.test(b.textContent ?? "")) as HTMLButtonElement;

      fireEvent.click(editButton());
      await waitForCondition(() => getNameInput().value === "Acme Corp");

      fireEvent.change(getNameInput(), { target: { value: "Acme Corp EDITED" } });
      fireEvent.submit(document.querySelector(".record-form")!);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the PATCH actually start before abandoning it

      // Cancel discards the in-progress edit while that save is still in
      // flight -- this must remount the form (bumpFormInstanceKey), so any
      // reference captured before it must be re-queried fresh afterward.
      fireEvent.click(getCancelButton());
      await waitForCondition(() => getNameInput().value === "");

      fireEvent.change(getNameInput(), { target: { value: "Brand New Draft" } });

      store[0].name = "Acme Corp EDITED";
      resolvePatch(
        new Response(JSON.stringify({ record: { id: 1, name: "Acme Corp EDITED", status: "new" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await waitForCondition(() => document.querySelector("table tbody tr")!.textContent?.includes("Acme Corp EDITED") ?? false);

      assert.equal(
        getNameInput().value,
        "Brand New Draft",
        "the fresh draft started after Cancel must survive the abandoned edit's slow save resolving afterward",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 365 regression: EntityPanel never unmounts while an overlay dialog
 * (History, WhatsApp, Shortcuts, ...) is open on top of it (see App.tsx --
 * they render as siblings), so its own window-level "n"/j/k/x/Delete/d
 * shortcuts used to keep firing underneath an open dialog whenever focus
 * landed on something other than a text input inside it -- isTypingTarget
 * alone can't catch a focused plain <button>, exactly where focus sits in
 * a dialog with no text input (ShortcutsPanel.tsx's own Close button, the
 * real repro this fix was built from). Renders a real dialog built on the
 * same useDialogFocusTrap hook alongside EntityPanel to prove "n" and "j"
 * are both silently swallowed while it's open -- not abandoning the
 * in-progress edit, not moving the row focus -- and that the exact same
 * keys work normally again the instant that dialog closes.
 */
test("EntityPanel's window-level keyboard shortcuts ('n', j/k) are suppressed while a real overlay dialog is open, and work again once it closes", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const editButtons = Array.from(document.querySelectorAll("table tbody button")) as HTMLButtonElement[];
      const globexEdit = editButtons.find((b) => b.closest("tr")?.getAttribute("data-record-id") === "2" && /edit/i.test(b.textContent ?? ""));
      fireEvent.click(globexEdit!);
      // Re-queried after every remount-triggering action below (round
      // 737's formInstanceKey fix remounts the record form's own fields
      // on startEdit/"n", so a reference captured before either would be
      // a stale, detached node) rather than reused from one capture.
      await waitForCondition(() => (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value === "Globex");

      let closeCalls = 0;
      const dialog = render(React.createElement(TestOverlayDialog, { onClose: () => (closeCalls += 1) }));
      const closeButton = dialog.container.querySelector("button")!;
      assert.equal(document.activeElement, closeButton, "sanity check: focus must land on the dialog's own button, not a text input");

      fireEvent.keyDown(window, { key: "n" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value,
        "Globex",
        "'n' must NOT abandon the in-progress edit while a real dialog is open",
      );

      fireEvent.keyDown(window, { key: "j" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(document.activeElement, closeButton, "'j' must NOT move the background table's row focus while a real dialog is open");

      dialog.unmount();
      assert.equal(closeCalls, 0, "sanity check: the dialog must close via the test's own unmount, not an accidental Escape/onClose");

      for (
        let attempt = 0;
        (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value !== "" && attempt < 40;
        attempt++
      ) {
        fireEvent.keyDown(window, { key: "n" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(
        (document.querySelector(".record-form input[type=text]") as HTMLInputElement)?.value,
        "",
        "'n' must work normally again once the dialog has closed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: table columns could only be resized (round 185) or
 * hidden (round 138) -- never actually REORDERED. Dragging a column
 * header's own label to another header now reorders the real columns,
 * persisted per project+entity via columnOrder.ts, mirroring the exact
 * draggable/onDragStart/onDragOver/onDragLeave/onDrop contract the Kanban
 * board's own cards (round 186) and drag-over CSS pattern already use.
 */
test("EntityPanel's table columns are drag-and-drop reorderable, persisting per project+entity via a real localStorage round trip", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector("table") !== null);

      const headerText = () => [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent);
      assert.deepEqual(headerText(), ["Name", "Status"], "columns must start in the entity's own natural field order");

      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }

      const headersBefore = document.querySelectorAll("thead th.resizable-col");
      const nameHeader = headersBefore[0] as HTMLElement;
      const statusHeader = headersBefore[1] as HTMLElement;

      // Drag "Status" onto "Name" -- must reorder to [Status, Name] and show
      // real drag-over feedback on the drop target while dragging over it.
      const dataTransfer = makeDataTransfer();
      fireEvent.dragStart(statusHeader, { dataTransfer });
      fireEvent.dragOver(nameHeader, { dataTransfer });
      assert.ok(nameHeader.classList.contains("resizable-col-drag-over"), "dragging a column over another must show real drag-over feedback");
      fireEvent.drop(nameHeader, { dataTransfer });
      await waitForCondition(() => headerText()[0] === "Status");
      assert.deepEqual(headerText(), ["Status", "Name"], "dropping Status onto Name must move Status to just before Name");
      assert.equal(
        (document.querySelectorAll("thead th.resizable-col")[0] as HTMLElement).classList.contains("resizable-col-drag-over"),
        false,
        "drag-over feedback must clear once the drop completes",
      );

      const store2 = JSON.parse(localStorage.getItem("forge.columnOrder") ?? "{}");
      assert.deepEqual(store2["proj1:Deal"], ["status", "name"], "the real reordered field-name order must be persisted to real localStorage");

      // Dropping a column back onto itself must be a real no-op.
      const headersAfter = document.querySelectorAll("thead th.resizable-col");
      const dataTransfer2 = makeDataTransfer();
      fireEvent.dragStart(headersAfter[0], { dataTransfer: dataTransfer2 });
      fireEvent.dragOver(headersAfter[0], { dataTransfer: dataTransfer2 });
      fireEvent.drop(headersAfter[0], { dataTransfer: dataTransfer2 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(headerText(), ["Status", "Name"], "dropping a column back onto itself must not change the order");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 478: column reorder (round 203, test above) was
 * drag-and-drop ONLY -- no keyboard path existed at all, the same gap the
 * Kanban board's own card drag (round 186) avoided by keeping its status
 * <select> as an accessible fallback. Each header now also has "move
 * earlier"/"move later" buttons that call the exact same reorderColumns
 * path a drag would, reachable and operable with a plain click (and
 * therefore with a keyboard, since a <button> is natively focusable and
 * Enter/Space-activatable -- this suite's jsdom environment doesn't
 * simulate real Tab-focus movement, so this test proves the buttons exist,
 * are correctly enabled/disabled at the ends of the order, and perform the
 * real reorder, which is what actually matters for keyboard reachability).
 */
test("EntityPanel's column headers have keyboard-operable 'move earlier'/'move later' buttons as a real fallback to drag-and-drop reorder", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector("table") !== null);

      const headerText = () => [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent);
      const moveButtons = (th: Element) => th.querySelectorAll(".column-move-btn") as NodeListOf<HTMLButtonElement>;
      assert.deepEqual(headerText(), ["Name", "Status"], "columns must start in the entity's own natural field order");

      const headers = () => document.querySelectorAll("thead th.resizable-col");
      const [nameEarlier, nameLater] = moveButtons(headers()[0]);
      const [statusEarlier, statusLater] = moveButtons(headers()[1]);

      assert.equal(nameEarlier.disabled, true, "the first column's 'move earlier' button must be disabled -- there's nothing before it");
      assert.equal(nameLater.disabled, false, "the first column's 'move later' button must be enabled");
      assert.equal(statusEarlier.disabled, false, "the last column's 'move earlier' button must be enabled");
      assert.equal(statusLater.disabled, true, "the last column's 'move later' button must be disabled -- there's nothing after it");

      fireEvent.click(nameLater);
      await waitForCondition(() => headerText()[0] === "Status");
      assert.deepEqual(headerText(), ["Status", "Name"], "clicking 'move later' on Name must move it past Status, the same result dragging it there would give");

      const store2 = JSON.parse(localStorage.getItem("forge.columnOrder") ?? "{}");
      assert.deepEqual(store2["proj1:Deal"], ["status", "name"], "the keyboard-driven reorder must persist to real localStorage exactly like the drag-and-drop one does");

      // Disabled state must have flipped along with the order: Status is now
      // first (its own "earlier" must disable), Name is now last (its own
      // "later" must disable).
      const [statusEarlierAfter] = moveButtons(document.querySelectorAll("thead th.resizable-col")[0]);
      const [, nameLaterAfter] = moveButtons(document.querySelectorAll("thead th.resizable-col")[1]);
      assert.equal(statusEarlierAfter.disabled, true, "Status, now first, must have its 'move earlier' button disabled");
      assert.equal(nameLaterAfter.disabled, true, "Name, now last, must have its 'move later' button disabled");

      // Clicking "move earlier" on the now-last Name column must undo it,
      // landing back at the original order -- the same operation expressed
      // from the other column, proving both directions actually work.
      const [nameEarlierAfter] = moveButtons(document.querySelectorAll("thead th.resizable-col")[1]);
      fireEvent.click(nameEarlierAfter);
      await waitForCondition(() => headerText()[0] === "Name");
      assert.deepEqual(headerText(), ["Name", "Status"], "clicking 'move earlier' on Name must move it back before Status");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Deliberately shares a field NAME ("name") with DEAL_ENTITY, in a different
// position -- if Deal's leftover in-memory column order ["status", "name"]
// ever leaked into Courier's own render (the reset effect not reloading
// per-entity), applyColumnOrder would still recognize "name" and reorder
// Courier to [Name, Vehicle], which is silently indistinguishable from a
// correct fresh load if Courier's own natural order happened to be the
// same. Ordering the fields [Vehicle, Name] here means a leak and a correct
// fresh load produce two different, distinguishable results.
const COURIER_ENTITY: Entity = {
  name: "Courier",
  label: "Courier",
  fields: [
    { name: "vehicle", label: "Vehicle", type: "text", required: false },
    { name: "name", label: "Courier Name", type: "text", required: true },
  ],
};

/**
 * The exact reset-on-entity-switch bug class rounds 198/201/202 each
 * shipped and deliberately re-caught in their own round: a piece of
 * per-entity state whose reload gets forgotten in the big
 * `useEffect(() => {...}, [entity.name])` reset effect when a new state
 * variable is added, is invisible to any test that never actually switches
 * entities. This one does: reorders Deal's own columns, switches (via a
 * real rerender with a new `entity` prop, not a remount) to a second,
 * unrelated Courier entity that has never been reordered, confirms Courier
 * starts in its own natural order (not Deal's persisted one leaking across),
 * then switches back to Deal and confirms Deal's own persisted order is
 * actually reloaded rather than staying stuck on whatever Courier last had.
 */
test("EntityPanel reloads each entity's own persisted column order when switching between entities, instead of leaking one entity's order into another's", async () => {
  await withJsdom(async () => {
    const dealStore: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const courierStore: EntityRecord[] = [{ id: 2, createdAt: "x", name: "Dana", vehicle: "Van" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (input === "/api/projects/proj1/entities/Deal") return mockRecordsFetch(dealStore)(input, init);
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierStore }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    try {
      const view = renderEntityPanel({ allEntities: [DEAL_ENTITY, COURIER_ENTITY] });
      await waitForCondition(() => document.querySelector("table") !== null);

      const headerText = () => [...document.querySelectorAll("thead th.resizable-col")].map((th) => th.querySelector(".sort-header")!.textContent);
      function makeDataTransfer() {
        let payload = "";
        return { setData: (_type: string, value: string) => (payload = value), getData: () => payload };
      }

      // Reorder Deal to [Status, Name].
      let headers = document.querySelectorAll("thead th.resizable-col");
      const dt1 = makeDataTransfer();
      fireEvent.dragStart(headers[1], { dataTransfer: dt1 });
      fireEvent.dragOver(headers[0], { dataTransfer: dt1 });
      fireEvent.drop(headers[0], { dataTransfer: dt1 });
      await waitForCondition(() => headerText()[0] === "Status");

      // Switch to Courier -- a real prop change, not a remount. Courier's
      // own natural field order is [Vehicle, Courier Name]; if Deal's
      // leftover order ["status", "name"] ever leaked across, Courier's
      // shared "name" field would get pulled to the front instead --
      // [Courier Name, Vehicle], a different and clearly wrong result.
      view.rerender(buildEntityPanelElement({ entity: COURIER_ENTITY, allEntities: [DEAL_ENTITY, COURIER_ENTITY] }));
      await waitForCondition(() => headerText().length === 2 && headerText()[0] === "Vehicle");
      assert.deepEqual(
        headerText(),
        ["Vehicle", "Courier Name"],
        "Courier must start in its own natural field order -- Deal's persisted [Status, Name] order leaking across would instead pull Courier's shared 'name' field to the front",
      );

      // Switch back to Deal -- must reload Deal's own persisted order.
      view.rerender(buildEntityPanelElement({ entity: DEAL_ENTITY, allEntities: [DEAL_ENTITY, COURIER_ENTITY] }));
      await waitForCondition(() => headerText().length === 2 && headerText()[0] === "Status");
      assert.deepEqual(
        headerText(),
        ["Status", "Name"],
        "switching back to Deal must reload its own persisted [Status, Name] order, not stay stuck on Courier's natural order",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: double-clicking a table cell opens a real inline
 * editor right in that cell (isInlineEditableField, entityFormatting.ts),
 * instead of always requiring the full add/edit form below the table for a
 * single-value change. Pressing Enter must send exactly one real PATCH
 * request and leave the mock server's own record store genuinely updated
 * -- not just a client-side illusion that a later refresh() would reveal
 * was never actually saved.
 */
test("EntityPanel's inline cell editor commits a real PATCH on Enter and updates the visible cell", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    let patchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") patchCount += 1;
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement; // [0] is the select-col checkbox
      assert.equal(nameCell.textContent, "Acme Corp");

      fireEvent.doubleClick(nameCell);
      const input = nameCell.querySelector('input[type="text"]') as HTMLInputElement;
      assert.ok(input, "expected a real text input to open in place inside the cell");
      assert.equal(input.value, "Acme Corp");

      fireEvent.change(input, { target: { value: "Acme Corporation" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitForCondition(() => document.querySelectorAll("table tbody td")[1]?.textContent === "Acme Corporation");
      assert.equal(patchCount, 1, "committing the inline edit must send exactly one real PATCH request");
      assert.equal(store[0].name, "Acme Corporation", "the mock server's own record store must have actually been updated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test (round 545): commitInlineEdit (the Enter-commit path)
 * used to clear editingCell without first setting suppressCellBlurCommitRef,
 * unlike cancelInlineEdit (Escape) right below it. Removing the input from
 * the DOM after a commit can still fire a real native blur event using a
 * stale pre-commit closure, whose own editingCell/cellDraft are still the
 * OLD non-null values -- so that stale blur went on to fire a SECOND real
 * commitInlineEdit() for the exact value Enter had just saved, sending a
 * redundant PATCH that could clobber a concurrent edit to the same field
 * landing in the gap between the two requests. Modeled on the same
 * extraction idiom this file's bulk-action busy-guard tests use: builds a
 * fresh set of handler closures per simulated "render" (bound to the
 * CURRENT editingCell/cellDraft/suppressCellBlurCommitRef state, exactly as
 * a real re-render would rebind them), starts a real commit via the
 * render's own commitInlineEdit() (as Enter's onKeyDown does), then invokes
 * that SAME render's own handleCellBlur() -- the stale closure a real
 * native blur-after-unmount would call -- and confirms it does not send a
 * second updateRecord call.
 */
test("EntityPanel's inline cell editor suppresses a stale post-commit blur instead of sending a second real PATCH for the same value", async () => {
  const helperMatch = entityPanelSrc.match(/function invalidNumberField\(field: Field, value: unknown\): boolean \{[\s\S]*?\n\}\n/);
  const commitSrc = entityPanelSrc.match(/ {2}async function commitInlineEdit\(\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  const cancelSrc = entityPanelSrc.match(/ {2}function cancelInlineEdit\(\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  const blurSrc = entityPanelSrc.match(/ {2}function handleCellBlur\(\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(
    helperMatch && commitSrc && cancelSrc && blurSrc,
    "expected to find invalidNumberField/commitInlineEdit/cancelInlineEdit/handleCellBlur in EntityPanel.tsx",
  );
  const { code } = transformSync(`${helperMatch![0]}\n${commitSrc}\n${cancelSrc}\n${blurSrc}`, { loader: "ts" });

  const state = {
    editingCell: { recordId: 1, field: "name" } as { recordId: number; field: string } | null,
    cellDraft: "New Value" as unknown,
  };
  const suppressCellBlurCommitRef = { current: false };
  const updateCalls: unknown[] = [];
  let refreshCalled = 0;

  function makeHandlers() {
    return new Function(
      "editingCell",
      "cellDraft",
      "suppressCellBlurCommitRef",
      "projectId",
      "entity",
      "setEditingCell",
      "updateRecord",
      "refresh",
      "setError",
      "setMoveErrorId",
      `${code}\nreturn { commitInlineEdit, handleCellBlur };`,
    )(
      state.editingCell,
      state.cellDraft,
      suppressCellBlurCommitRef,
      "proj1",
      { name: "Customer", fields: [{ name: "name", required: false }] },
      (next: unknown) => (state.editingCell = next as typeof state.editingCell),
      async (_projectId: string, _entityName: string, _id: number, patch: Record<string, unknown>) => {
        updateCalls.push(patch);
      },
      async () => {
        refreshCalled += 1;
      },
      () => {},
      () => {},
    ) as { commitInlineEdit: () => Promise<void>; handleCellBlur: () => void };
  }

  // Enter's onKeyDown calls this render's own commitInlineEdit() directly.
  const handlersAtCommit = makeHandlers();
  const commitPromise = handlersAtCommit.commitInlineEdit();

  // The real native blur-after-unmount fires using the SAME stale closure
  // that started the commit -- its own editingCell/cellDraft are still the
  // pre-commit non-null values, exactly like the real browser race.
  handlersAtCommit.handleCellBlur();

  await commitPromise;

  assert.deepEqual(updateCalls, [{ name: "New Value" }], "the stale post-commit blur must not send a second updateRecord call for the same value");
  assert.equal(refreshCalled, 1, "the real commit's own refresh must still run exactly once");
  assert.equal(suppressCellBlurCommitRef.current, false, "the flag must be consumed (reset to false) by the stale blur it suppressed");
});

/**
 * The complement to the commit test above: Escape must discard the
 * in-progress draft and never touch the server at all. This is also the
 * regression test for the suppressCellBlurCommitRef race described in
 * EntityPanel.tsx's own cancelInlineEdit -- removing the input from the DOM
 * (React's re-render after setEditingCell(null)) can still fire a real
 * native blur event, and without the suppress flag that blur would read a
 * stale closure's still-non-null editingCell/cellDraft and silently save
 * the very value Escape just told it to discard.
 */
test("EntityPanel's inline cell editor discards the draft on Escape without sending any PATCH request", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    let patchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") patchCount += 1;
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement;
      fireEvent.doubleClick(nameCell);
      const input = nameCell.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Should Not Save" } });
      fireEvent.keyDown(input, { key: "Escape" });

      await waitForCondition(() => nameCell.querySelector("input") === null);
      // Give any real (but suppressed) native blur event a full tick to land,
      // so this test would actually catch the stale-closure race described
      // above rather than asserting before it could ever fire.
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(nameCell.textContent, "Acme Corp", "Escape must discard the in-progress draft, leaving the original value visible");
      assert.equal(patchCount, 0, "Escape must never send a PATCH request");
      assert.equal(store[0].name, "Acme Corp", "the mock server's own record must be untouched after a cancelled edit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 707: the single-record add/edit form's own missingField guard, and
 * handleBulkUpdate's identical check (round 702), both refuse to submit a
 * blank required field with a real, specific, translated message -- but
 * commitInlineEdit (the inline table-cell editor, the third mutation path
 * through this same FieldInput/isInlineEditableField set of types) had no
 * such check at all. Clearing a required text cell and committing with
 * Enter used to fire a doomed PATCH, rejected server-side, surfaced only as
 * the generic VALIDATION_ERROR string -- actively misleading here, since it
 * tells the user to "check the form" while inline cell editing never shows
 * a form, just one table cell. Confirms the real, specific message now
 * shows instead, no PATCH is sent, and the cell stays open (not silently
 * closed) so the user can fix the value without double-clicking again.
 */
test("EntityPanel's inline cell editor refuses to commit a required field left blank, instead of sending a doomed PATCH", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    let patchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") patchCount += 1;
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement;
      fireEvent.doubleClick(nameCell);
      const input = nameCell.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(patchCount, 0, "must never send a PATCH for a blank required field");
      assert.equal(store[0].name, "Acme Corp", "the mock server's own record must be untouched");
      assert.match(
        document.querySelector("p.error")?.textContent ?? "",
        /Name.*required field|required field.*Name/,
        "must show the real, specific required-field message naming the field, not a generic one",
      );
      assert.ok(
        nameCell.querySelector("input") !== null,
        "the cell must stay open for editing (not silently closed) so the user can fix the value without double-clicking again",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 984: a real bug introduced by round 980's own fix (not a
 * pre-existing gap), found by a fresh Explore survey. Round 980 switched
 * a real "number" field's input from a native `<input type="number">`
 * (whose own browser-level keystroke sanitization made a non-numeric
 * string physically impossible to produce) to a plain text input with no
 * such guard. commitInlineEdit only ever pre-checked required-ness, never
 * that a "number" field's value is actually numeric, so ordinary typo
 * text (e.g. "abc") typed into a number cell and committed with Enter
 * used to reach the server as-is -- rejected there, surfaced only as the
 * generic VALIDATION_ERROR banner. Mirrors the required-field test just
 * above, for a present-but-non-numeric value instead of an empty one.
 */
test("EntityPanel's inline cell editor refuses to commit a non-numeric value for a 'number' field, instead of sending a doomed PATCH", async () => {
  await withJsdom(async () => {
    const invoiceEntity: Entity = {
      name: "Invoice",
      label: "Invoice",
      fields: [
        { name: "client", label: "Client", type: "text", required: true },
        { name: "amount", label: "Amount", type: "number", required: false },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", client: "Acme Corp", amount: 500 }];
    const originalFetch = globalThis.fetch;
    let patchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Invoice") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Invoice/1") {
        patchCount += 1;
        Object.assign(store[0], JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ record: store[0] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: invoiceEntity, allEntities: [invoiceEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const amountCell = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      fireEvent.doubleClick(amountCell);
      const input = amountCell.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
      assert.ok(input, "expected the number field's own decimal-keyboard-hint input to be editable inline");
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(patchCount, 0, "must never send a PATCH for a non-numeric 'number' field value");
      assert.equal(store[0].amount, 500, "the mock server's own record must be untouched");
      assert.match(
        document.querySelector("p.error")?.textContent ?? "",
        /Amount.*must be a number|must be a number.*Amount/,
        "must show a real, specific 'must be a number' message naming the field, not a generic one",
      );
      assert.ok(
        amountCell.querySelector("input") !== null,
        "the cell must stay open for editing (not silently closed) so the user can fix the value without double-clicking again",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the SAME Escape-to-cancel convention as the inline
 * cell editor just above, extended to the main add/edit form -- which had
 * no keyboard way at all to back out of an in-progress edit; only the
 * mouse-driven Cancel button could. Pressing Escape on a focused field now
 * calls the exact same reset the Cancel button's own onClick already does.
 * Also confirms the flip side: outside edit mode this same form IS the
 * blank create form, so Escape there must never wipe a user's in-progress
 * NEW-record draft -- only an actual edit (editingId != null) is Escape's
 * to discard.
 */
test("EntityPanel's record form discards an in-progress EDIT on Escape (same as the Cancel button), but never clears an in-progress NEW-record draft", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      // Not editing yet -- type a draft for a brand-new record and confirm
      // Escape leaves it completely untouched.
      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Draft not yet saved" } });
      fireEvent.keyDown(nameInput, { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(nameInput.value, "Draft not yet saved", "Escape must never clear an in-progress NEW-record draft (editingId is null here)");

      // Now actually open the real record for editing.
      const editButton = document.querySelector(".row-actions button") as HTMLButtonElement;
      fireEvent.click(editButton);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Acme Corp");
      assert.ok(document.querySelector(".form-actions button.secondary"), "expected a real Cancel button once editing an existing record");

      fireEvent.keyDown(document.querySelector('.record-form input[type="text"]') as HTMLInputElement, { key: "Escape" });
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "");

      assert.equal(
        document.querySelector(".form-actions button.secondary"),
        null,
        "Escape must discard edit mode exactly like Cancel -- the Cancel button must disappear",
      );
      const submitButton = document.querySelector(".form-actions button[type=submit]") as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Add", "the submit button must revert to create-mode wording once Escape discards the edit");
      assert.equal(store[0].name, "Acme Corp", "the mock server's own record must be untouched -- Escape never saves");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 364 regression: FieldLabelEditor's own rename input lives inside
 * this same record-form (one per field), and that form's own onKeyDown
 * (tested just above) discards the WHOLE in-progress edit on Escape
 * whenever editingId != null, with no awareness that FieldLabelEditor's own
 * Escape handler already fired first and handled it locally. Before this
 * round's fix, pressing Escape to back out of a two-second field-label
 * rename wiped every other field's unsaved value too, since the keystroke
 * kept bubbling from the label's own input up to the record form -- unlike
 * useDialogFocusTrap.ts's native listener (rounds 359-362), both handlers
 * here are plain React onKeyDown, so a real e.stopPropagation() is the
 * correct and sufficient fix, confirmed by this test actually passing.
 */
test("Escape while renaming a field's label cancels only that rename, never the surrounding in-progress record edit", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    let renameCalls = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "PATCH" && /\/fields\/.+\/label$/.test(input)) {
        renameCalls += 1;
        throw new Error("renameFieldLabel must never be called -- Escape must cancel before any request");
      }
      return mockRecordsFetch(store)(input, init);
    }) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Acme Corp");
      assert.ok(document.querySelector(".form-actions button.secondary"), "sanity check: a real in-progress edit must be open");

      fireEvent.click(document.querySelector(".field-label-edit-btn") as HTMLElement);
      await waitForCondition(() => document.querySelector(".field-label-edit input") !== null);
      const renameInput = document.querySelector(".field-label-edit input") as HTMLInputElement;
      fireEvent.change(renameInput, { target: { value: "Company Name" } });

      fireEvent.keyDown(renameInput, { key: "Escape" });
      await waitForCondition(() => document.querySelector(".field-label-edit") === null);

      assert.equal(renameCalls, 0, "cancelling the label rename must never send a request");
      assert.equal(
        (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value,
        "Acme Corp",
        "the record edit itself must still be open with its real value, not wiped by the same Escape keystroke",
      );
      assert.ok(
        document.querySelector(".form-actions button.secondary"),
        "the Cancel button must still be present -- editingId must not have been cleared",
      );
      assert.equal(store[0].name, "Acme Corp", "the mock server's own record must be untouched");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (440): a long-standing, known-but-deprioritized gap
 * from round 375's own notes, confirmed still present in the current code.
 * relatedRecords is only ever populated by loadRelated's own useEffect --
 * which, by React's contract, never runs synchronously on the first render
 * -- but the add/edit form is rendered completely unconditionally, with no
 * gate of its own on either `loading` or relatedRecords having arrived.
 * FieldInput's relation branch used to require `relatedEntityRecords` to
 * already be truthy, so on every single mount of an entity with a relation
 * field, the window before that fetch resolves fell through to the
 * generic `field.type === "number" || "relation"` branch: a plain, raw,
 * fully-editable `<input type="number">` with no real options and no
 * validation against an actual related record -- not just a rare race,
 * but the deterministic first-paint state every time. A fast user (or
 * keyboard/autofill) could submit an arbitrary foreign-key id during that
 * window. Confirms the field now renders as a disabled, clearly-labeled
 * loading placeholder instead, and only becomes the real, option-backed
 * `<select>` once relatedRecords genuinely resolves.
 */
test("EntityPanel's relation field never falls back to a raw, unvalidated number input while related records are still loading", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [{ id: 9, createdAt: "x", name: "Dana" }];
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", item: "Pizza", courierId: null }];
    let releaseCourierFetch: (() => void) | undefined;
    const courierFetchHeld = new Promise<void>((resolve) => {
      releaseCourierFetch = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        await courierFetchHeld; // held open to simulate the real pre-resolve window
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        document.querySelector('.record-form input[type="number"]') === null,
        true,
        "the relation field must never fall back to a raw, unvalidated number input while related records are still loading",
      );
      const loadingSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.ok(loadingSelect, "expected a real <select> for the relation field even before related records have loaded");
      assert.equal(loadingSelect.disabled, true, "the relation field's placeholder select must be disabled while loading, not freely submittable");

      releaseCourierFetch!();
      await courierFetchHeld;
      await waitForCondition(() => {
        const select = document.querySelector(".record-form select") as HTMLSelectElement | null;
        return select !== null && !select.disabled && select.querySelectorAll("option").length === 2;
      });

      const realSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      const optionLabels = Array.from(realSelect.options).map((o) => o.textContent);
      assert.ok(optionLabels.includes("Dana"), "once related records load, the field must become the real, option-backed select");
    } finally {
      // Released unconditionally -- if an earlier assertion throws before
      // the normal release point above, the mock Courier fetch would
      // otherwise stay suspended on its held promise forever, leaving the
      // component's own loadRelated effect (and React's pending update
      // machinery) dangling even after this test has already failed.
      releaseCourierFetch!();
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 515's finding: FieldInput's relation branch had no fallback for a
 * stored id missing from relatedEntityRecords -- unlike the enum branch a
 * few lines below it (round 508's own fix), which re-injects a synthetic
 * <option> for a stale value no longer in field.enumValues. The relation
 * branch's own loadRelated effect (above) deliberately swallows ANY
 * related-entity fetch failure into an empty array (`catch { return
 * [name, []] }`), not undefined -- so a single transient fetch error wipes
 * out every real option, and a record whose relation field already holds
 * a real, valid value renders that field as blank/unselected, exactly the
 * "real value doesn't match any <option>" bug class round 508 already
 * fixed for enum. Confirms the select now keeps the record's real stored
 * courier id selectable (via a synthetic "#9" option) even when the
 * related-entity fetch outright fails.
 */
test("EntityPanel's relation field keeps the record's real stored value selectable even when the related-entity fetch fails", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: true },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", item: "Pizza", courierId: 9 }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        // An HTTP error response, not a thrown/rejected fetch -- the latter
        // is what fetchWithWakeRetry (wakeRetry.ts) treats as a cold-start
        // connection failure and retries for up to ~101s+, which this test
        // has no interest in exercising. A real 4xx/5xx is returned
        // immediately per that file's own contract, and loadRelated's catch
        // swallows the resulting thrown Error into [] just as fast.
        return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const editButton = document.querySelector(".row-actions button") as HTMLButtonElement;
      fireEvent.click(editButton);

      await waitForCondition(() => {
        const select = document.querySelector(".record-form select") as HTMLSelectElement | null;
        return select !== null && !select.disabled;
      });

      const courierSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.equal(
        courierSelect.value,
        "9",
        "the select must reflect the record's real stored courier id even though the related-entity fetch failed and returned no options",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1037: a self-referencing relation field (field.relationTo pointing
 * back at this same entity -- e.g. Employee.managerId -> Employee, a
 * completely ordinary, schema-legal pattern) had no guard anywhere: the
 * record currently being edited appeared in its own relation field's
 * option list, letting a user pick a record as its own manager/parent with
 * no warning. Confirms the record being edited is excluded from its own
 * relation field's options, while every other record (and the field's own
 * "choose one" placeholder) stays selectable as normal.
 */
test("EntityPanel excludes the record currently being edited from its own self-referencing relation field's options", async () => {
  await withJsdom(async () => {
    const employeeEntity: Entity = {
      name: "Employee",
      label: "Employee",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "managerId", label: "Manager", type: "relation", relationTo: "Employee", required: false },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Dana", managerId: null },
      { id: 2, createdAt: "x", name: "Yossi", managerId: null },
    ];
    const originalFetch = globalThis.fetch;
    // A self-referencing relation field's own loadRelated fetch hits this
    // SAME entity's own GET endpoint (relatedEntity === this entity) --
    // unlike mockRecordsFetch's own fixed "Deal"-only route, this test's
    // entity needs that one URL to serve both the main record list and
    // the relation field's own related-records fetch.
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Employee") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: employeeEntity, allEntities: [employeeEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const editButtons = document.querySelectorAll(".row-actions button");
      fireEvent.click(editButtons[0] as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const managerSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      await waitForCondition(() => !managerSelect.disabled);
      const optionLabels = Array.from(managerSelect.options).map((o) => o.textContent);
      assert.ok(optionLabels.includes("Yossi"), "a genuinely different record must still be selectable as this record's manager");
      assert.ok(!optionLabels.includes("Dana"), "the record currently being edited must never appear as an option in its own self-referencing relation field");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 698: a relation field's plain <select> had no way to narrow a
 * long list of related records -- a browser's own type-ahead inside an
 * open <select> only jumps to an option whose label *starts with* what's
 * typed, can't match a substring, and is especially unreliable for this
 * app's Hebrew-labeled records. Confirms the filter input only appears
 * once there are enough related records to matter (not for a trivial
 * 2-3-option list), narrows the real <select>'s own <option>s by a
 * case-insensitive substring match against each record's resolved display
 * label, and never hides the already-selected record's own option even
 * when the filter text doesn't match it (the same "stale value has no
 * <option>" hazard this branch's own fallback for a missing id already
 * guards against, here for a different cause).
 */
test("EntityPanel's relation field offers no filter input at all for a short list of related records", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Dana Levi" },
      { id: 2, createdAt: "x", name: "Yossi Cohen" },
    ];
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", item: "Pizza", courierId: 1 }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const editButton = document.querySelector(".row-actions button") as HTMLButtonElement;
      fireEvent.click(editButton);
      await waitForCondition(() => {
        const select = document.querySelector(".record-form select") as HTMLSelectElement | null;
        return select !== null && !select.disabled;
      });

      assert.equal(
        document.querySelector(".relation-filter-input") === null,
        true,
        "a short related-record list must never show the filter input -- it would just be clutter over 2 options",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("EntityPanel's relation field offers a filter input once there are enough related records, and it narrows the real select's options by display label", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Dana Levi" },
      { id: 2, createdAt: "x", name: "Yossi Cohen" },
      { id: 3, createdAt: "x", name: "Maya Golan" },
      { id: 4, createdAt: "x", name: "Avi Mizrahi" },
      { id: 5, createdAt: "x", name: "Noa Peretz" },
      { id: 6, createdAt: "x", name: "Ron Shapira" },
    ];
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", item: "Pizza", courierId: 1 }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const editButton = document.querySelector(".row-actions button") as HTMLButtonElement;
      fireEvent.click(editButton);
      await waitForCondition(() => {
        const select = document.querySelector(".record-form select") as HTMLSelectElement | null;
        return select !== null && !select.disabled;
      });

      const filterInput = document.querySelector(".relation-filter-input") as HTMLInputElement;
      assert.ok(filterInput, "expected a filter input once there are more than a handful of related records");

      const select = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.equal(select.querySelectorAll("option").length, 7, "every related record (plus the blank placeholder) must be offered before any filtering");

      fireEvent.change(filterInput, { target: { value: "yossi" } });
      // 3, not 2: the blank placeholder, "Yossi Cohen" (matches the filter
      // text), and "Dana Levi" -- the already-selected record, which the
      // filter text does NOT match, but must stay in the list regardless
      // (see the fix's own comment on currentRelationId) so the controlled
      // select never loses its real current value.
      await waitForCondition(() => select.querySelectorAll("option").length === 3);
      const filteredLabels = Array.from(select.options).map((o) => o.textContent);
      assert.ok(filteredLabels.includes("Yossi Cohen"), "the filter must keep the one matching record's option");
      assert.ok(filteredLabels.includes("Dana Levi"), "the currently-selected record's option must stay visible even though the filter text doesn't match it");
      assert.ok(!filteredLabels.includes("Maya Golan"), "a non-matching, non-selected record's option must be filtered out");
      assert.equal(select.value, "1", "the currently-selected record must remain selected while filtered");

      fireEvent.change(filterInput, { target: { value: "" } });
      await waitForCondition(() => select.querySelectorAll("option").length === 7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the search box's own matchesSearch fell through to
 * the raw stored foreign-key id for a relation field, so typing the exact
 * name a relation cell visibly shows (e.g. "Dana", resolved via
 * relationDisplayLabel) found nothing at all -- a real, everyday gap the
 * moment someone tries to search an Order table by its courier's name.
 * This confirms the live search box now matches the resolved label, and
 * that a query matching only the raw id no longer matches (the id was
 * never shown on screen to begin with, so there's nothing to preserve).
 */
test("EntityPanel's search box matches a relation field's resolved display label, not its raw stored id", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [{ id: 9, createdAt: "x", name: "Dana" }];
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", item: "Pizza", courierId: 9 },
      { id: 2, createdAt: "x", item: "Burger", courierId: null },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const searchInput = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchInput, { target: { value: "Dana" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(document.querySelectorAll("table tbody tr").length, 1, "searching the courier's resolved name must find the one matching order");
      assert.equal(document.querySelector("table tbody td:nth-child(2)")?.textContent, "Pizza");

      fireEvent.change(searchInput, { target: { value: "9" } });
      await waitForCondition(() => document.querySelector(".empty-state") !== null);
      assert.equal(
        document.querySelectorAll("table tbody tr").length,
        0,
        "the raw foreign-key id was never shown on screen, so searching for it must no longer match",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: clicking a relation column's header sorted the table
 * by the raw stored foreign-key id, not the resolved display label the
 * cell actually shows (e.g. "Abe"/"Mona"/"Zed") -- the same root cause
 * round 271 already fixed for the search box, now fixed for sort.
 * Courier ids are deliberately named in REVERSE alphabetical order (id 1
 * = "Zed", id 3 = "Abe") -- if the courier names had instead happened to
 * be alphabetical in id order, ascending-by-raw-id and ascending-by-
 * resolved-name would produce the exact same row order, and this test
 * would pass even against the old, unfixed code (a real mistake this
 * round's first draft of this test made before catching it during
 * deliberate-break-and-restore -- see round 272's roadmap entry). With
 * the reversal, the two sort orders are opposite, so only a real fix
 * produces the expected result.
 */
test("EntityPanel's relation column header sorts by the related record's resolved display label, not its raw stored id", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Zed" },
      { id: 2, createdAt: "x", name: "Mona" },
      { id: 3, createdAt: "x", name: "Abe" },
    ];
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", item: "Pizza", courierId: 1 }, // Zed
      { id: 2, createdAt: "x", item: "Burger", courierId: 2 }, // Mona
      { id: 3, createdAt: "x", item: "Salad", courierId: 3 }, // Abe
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      await waitForCondition(() => document.querySelector("table tbody td:nth-child(3)")?.textContent !== "#1");

      const courierHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Courier/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      assert.ok(courierHeader, "expected a sortable 'Courier' column header");
      fireEvent.click(courierHeader);

      await waitForCondition(() => {
        const items = Array.from(document.querySelectorAll("table tbody tr")).map(
          (r) => r.querySelector("td:nth-child(2)")?.textContent,
        );
        return items[0] === "Salad" && items[1] === "Burger" && items[2] === "Pizza";
      });

      const items = Array.from(document.querySelectorAll("table tbody tr")).map(
        (r) => r.querySelector("td:nth-child(2)")?.textContent,
      );
      assert.deepEqual(
        items,
        ["Salad", "Burger", "Pizza"],
        "alphabetical by resolved courier name (Abe, Mona, Zed), not by the raw stored id order (1, 2, 3)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * A relation field's cell shows a label resolved from a *different*
 * record (relationDisplayLabel), not the field's own raw stored value --
 * isInlineEditableField excludes it for exactly that reason (see
 * entityFormatting.test.ts for the pure-function coverage). This confirms
 * the exclusion actually reaches the live table: double-clicking a relation
 * cell must never open an inline editor.
 */
test("EntityPanel never opens an inline editor for a relation field's cell", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    // loadRelated's own relationTargets only fetches a relation field's
    // target entity if it's actually present in allEntities -- omitting it
    // here (as an earlier draft of this test did) left relatedRecords empty
    // and the cell showing the raw "#9" fallback instead of "Dana", which
    // wasn't what this test meant to exercise.
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [{ id: 9, createdAt: "x", name: "Dana" }];
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", item: "Pizza", courierId: 9 }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (input === "/api/projects/proj1/entities/Order") {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      await waitForCondition(() => document.querySelectorAll("table tbody td")[2]?.textContent === "Dana");

      const relationCell = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      fireEvent.doubleClick(relationCell);

      assert.equal(relationCell.querySelector("select, input"), null, "a relation cell must never open an inline editor on double-click");
      assert.equal(relationCell.textContent, "Dana", "the relation cell must keep showing its resolved label");
      assert.equal(
        relationCell.querySelector("button"),
        null,
        "without an onJumpToRecord callback, a relation cell must render as plain text, not a clickable button",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a *self-referencing* relation field (e.g. a Category's
 * own "parent category", an Employee's own "manager") is schema-legal --
 * FieldSchema only requires relationTo to be declared, never that it differ
 * from the field's own entity -- but relatedRecords (the snapshot every
 * relation-field <select> and display label is rendered from) is loaded
 * once by its own effect, keyed on [projectId, relationTargets], and never
 * refreshed by refresh() itself (the function every create/edit/duplicate/
 * bulk-update/CSV-import/board-move/inline-edit handler calls). For a
 * relation pointing at a *different* entity this is invisible in practice,
 * since creating a record there means switching to that entity's own tab,
 * which remounts this component (key={entity.name} in App.tsx) and
 * refetches everything fresh. A self-relation has no such tab switch --
 * creating a new same-entity record leaves relatedRecords[entity.name]
 * stale, so the new record is silently missing from every relation picker
 * (and would render as a bare "#<id>" fallback once picked) until a full
 * remount. Confirms creating a new Category and then opening another
 * Category's edit form offers the freshly created one in its "Parent
 * Category" dropdown.
 */
test("EntityPanel's self-referencing relation field picker includes a record created after the panel first loaded", async () => {
  await withJsdom(async () => {
    const categoryEntity: Entity = {
      name: "Category",
      label: "Category",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "parentCategoryId", label: "Parent Category", type: "relation", relationTo: "Category", required: false },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Electronics", parentCategoryId: null }];
    let nextId = 2;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/projects/proj1/entities/Category") {
        if (method === "GET") {
          return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (method === "POST") {
          const record = { id: nextId++, createdAt: "x", ...JSON.parse(init!.body as string) };
          store.push(record);
          return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
        }
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: categoryEntity, allEntities: [categoryEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      fireEvent.change(nameInput, { target: { value: "Office Supplies" } });
      fireEvent.click(submitButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const electronicsRow = Array.from(document.querySelectorAll("table tbody tr")).find((r) =>
        /Electronics/.test(r.textContent ?? ""),
      ) as HTMLElement;
      const editButton = electronicsRow.querySelector(".row-actions button") as HTMLButtonElement;
      fireEvent.click(editButton);

      const parentSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.ok(parentSelect, "expected the self-relation field to render as a <select>");
      await waitForCondition(() => Array.from(parentSelect.options).some((o) => o.textContent === "Office Supplies"));

      const optionLabels = Array.from(parentSelect.options).map((o) => o.textContent);
      assert.ok(
        optionLabels.includes("Office Supplies"),
        `expected the just-created "Office Supplies" category to be a selectable parent, got options: ${optionLabels.join(", ")}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for a real bug (round 540): the mount-time loadRelated
 * effect and refresh() (round 438's own fix above) are two independent
 * writers of relatedRecords[entity.name] for a self-referencing relation
 * field. refresh() merges a newly-created record in immediately, but if
 * loadRelated's own mount-time fetch for that same entity happens to
 * resolve LATER (a slower initial page-load fetch racing a fast create),
 * its stale, pre-creation snapshot wholesale-replaces relatedRecords,
 * silently undoing round 438's fix and making the just-created record
 * vanish from the relation picker again -- with no further user action.
 */
test("EntityPanel's self-referencing relation field picker keeps a just-created record visible even when the initial relation-data fetch resolves after the create", async () => {
  await withJsdom(async () => {
    const categoryEntity: Entity = {
      name: "Category",
      label: "Category",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "parentCategoryId", label: "Parent Category", type: "relation", relationTo: "Category", required: false },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Electronics", parentCategoryId: null }];
    let nextId = 2;
    const originalFetch = globalThis.fetch;
    let heldGetResolve: (() => void) | null = null;
    let sawFirstGet = false;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/projects/proj1/entities/Category") {
        if (method === "GET") {
          const snapshot = [...store];
          // Only the very first GET (whichever of loadRelated's own effect
          // or refresh()'s own mount-time call happens to fire first) is
          // held open -- every later GET (refresh()'s own mount call if it
          // runs second, and any later refresh() call) resolves immediately,
          // modeling a realistic race: one slow initial fetch, one fast one.
          if (!sawFirstGet) {
            sawFirstGet = true;
            await new Promise<void>((resolve) => {
              heldGetResolve = resolve;
            });
          }
          return new Response(JSON.stringify({ records: snapshot }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (method === "POST") {
          const record = { id: nextId++, createdAt: "x", ...JSON.parse(init!.body as string) };
          store.push(record);
          return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
        }
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: categoryEntity, allEntities: [categoryEntity] });
      await waitForCondition(() => heldGetResolve !== null);

      // Create "Office Supplies" while the held GET is still pending --
      // this goes through refresh(), whose own mount-time GET already
      // resolved (it wasn't the first one held).
      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      fireEvent.change(nameInput, { target: { value: "Office Supplies" } });
      fireEvent.click(submitButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const electronicsRow = Array.from(document.querySelectorAll("table tbody tr")).find((r) =>
        /Electronics/.test(r.textContent ?? ""),
      ) as HTMLElement;
      const editButton = electronicsRow.querySelector(".row-actions button") as HTMLButtonElement;
      fireEvent.click(editButton);

      const parentSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      await waitForCondition(() => Array.from(parentSelect.options).some((o) => o.textContent === "Office Supplies"));
      assert.ok(
        Array.from(parentSelect.options).some((o) => o.textContent === "Office Supplies"),
        "sanity check: the newly-created category must be selectable right after creation (round 438's own fix)",
      );

      // Now release the held-open GET -- loadRelated's own fetch (whichever
      // request it actually was) finally resolves with its stale,
      // pre-creation snapshot.
      heldGetResolve!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const optionLabelsAfter = Array.from(parentSelect.options).map((o) => o.textContent);
      assert.ok(
        optionLabelsAfter.includes("Office Supplies"),
        `expected "Office Supplies" to still be selectable after the delayed initial relation-fetch resolved, got options: ${optionLabelsAfter.join(", ")}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: clicking a relation cell's resolved label now jumps
 * straight to the related record on its own entity's tab, via the same
 * onJumpToRecord callback App.tsx already wires up for Global Search,
 * WhatsApp log, and Business Twin jumps (see App.tsx). Before this, seeing
 * a related record's own fields meant manually switching tabs and
 * searching/scrolling to find it by name -- this confirms the live
 * component actually renders the cell as a real button and fires the
 * callback with the target entity name and record id, not just that
 * onJumpToRecord exists as a prop.
 */
test("EntityPanel's relation cell jumps to the related record when onJumpToRecord is given", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const courierRelated: EntityRecord[] = [{ id: 9, createdAt: "x", name: "Dana" }];
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", item: "Pizza", courierId: 9 }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (input === "/api/projects/proj1/entities/Order") {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRelated }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    let jumped: [string, number] | null = null;
    try {
      renderEntityPanel({
        entity: orderEntity,
        allEntities: [orderEntity, courierEntity],
        onJumpToRecord: (targetEntity: string, recordId: number) => {
          jumped = [targetEntity, recordId];
        },
      });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      await waitForCondition(() => document.querySelectorAll("table tbody td")[2]?.textContent === "Dana");

      const relationCell = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      const relationButton = relationCell.querySelector("button");
      assert.ok(relationButton, "with an onJumpToRecord callback, the relation cell must render as a real clickable button");
      assert.equal(relationButton!.textContent, "Dana", "the button must still show the resolved related-record label");

      fireEvent.click(relationButton!);

      assert.deepEqual(jumped, ["Courier", 9], "clicking must call onJumpToRecord with the relation's own target entity name and the related record's real id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a "Send WhatsApp" row action on any entity with a
 * recognized phone-like field (findPhoneField), wired to onSendWhatsApp --
 * the reverse direction of onJumpToRecord above. Before this, messaging a
 * Customer/Lead from their record meant copying the phone number out of
 * the table and pasting it into the separate WhatsApp panel's test-send
 * box by hand. Confirms: the button renders and fires the callback with
 * the record's real phone value for a phone-bearing entity; it does NOT
 * render at all for an entity with no phone-like field, nor for a record
 * whose phone field happens to be empty, even when onSendWhatsApp is
 * given in both cases.
 */
test("EntityPanel's row-level 'Send WhatsApp' action appears only for a phone-bearing record and fires onSendWhatsApp with its real number", async () => {
  await withJsdom(async () => {
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "mobile", label: "Mobile", type: "text", required: false },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Dana", mobile: "0501234567" },
      { id: 2, createdAt: "x", name: "Noa", mobile: "" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    let sentTo: string | null = null;
    try {
      renderEntityPanel({
        entity: leadEntity,
        allEntities: [leadEntity],
        onSendWhatsApp: (phoneNumber: string) => {
          sentTo = phoneNumber;
        },
      });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const rows = document.querySelectorAll("table tbody tr");
      const danaWhatsAppBtn = Array.from(rows[0].querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.ok(danaWhatsAppBtn, "expected a Send WhatsApp button on the row for a record with a real phone value");
      fireEvent.click(danaWhatsAppBtn!);
      assert.equal(sentTo, "0501234567", "clicking must call onSendWhatsApp with the record's own real phone value");

      const noaWhatsAppBtn = Array.from(rows[1].querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.equal(noaWhatsAppBtn, undefined, "a record whose phone field is empty must not get a Send WhatsApp button at all");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("EntityPanel's row-level 'Send WhatsApp' action does not render at all for an entity with no phone-like field", async () => {
  await withJsdom(async () => {
    const noteEntity: Entity = { name: "Note", label: "Note", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Reminder" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Note") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: noteEntity, allEntities: [noteEntity], onSendWhatsApp: () => {} });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      const row = document.querySelectorAll("table tbody tr")[0];
      const whatsAppBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.equal(whatsAppBtn, undefined, "an entity with no phone-like field must never show a Send WhatsApp row action");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: BoardCard was missing two of the table row's five
 * actions -- Print and Send WhatsApp -- even though both are reachable
 * from Table view for the exact same record. Confirmed via grep that
 * BoardCard's own props never even accepted onPrint/phoneField/
 * onSendWhatsApp before this round, so there was no way to reach either
 * action once switched to Board view. Mirrors the table row's own
 * conditional gating exactly: WhatsApp only for a record whose phone
 * field actually has a value, Print unconditionally.
 */
test("EntityPanel's board view cards get the same Print and Send WhatsApp row actions the table row already has", async () => {
  await withJsdom(async () => {
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "mobile", label: "Mobile", type: "text", required: false },
        {
          name: "stage",
          label: "Stage",
          type: "enum",
          required: true,
          enumValues: ["new", "won"],
          enumLabels: { new: "New", won: "Won" },
        },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Dana", mobile: "0501234567", stage: "new" },
      { id: 2, createdAt: "x", name: "Noa", mobile: "", stage: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const originalPrint = window.print;
    let printCalls = 0;
    window.print = () => {
      printCalls += 1;
    };
    let sentTo: string | null = null;
    try {
      renderEntityPanel({
        entity: leadEntity,
        allEntities: [leadEntity],
        onSendWhatsApp: (phoneNumber: string) => {
          sentTo = phoneNumber;
        },
      });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 2);

      const danaCard = Array.from(document.querySelectorAll(".board-card")).find((c) => /Dana/.test(c.textContent ?? ""))!;
      const danaWhatsAppBtn = Array.from(danaCard.querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.ok(danaWhatsAppBtn, "expected a Send WhatsApp button on the board card for a record with a real phone value");
      fireEvent.click(danaWhatsAppBtn!);
      assert.equal(sentTo, "0501234567", "clicking the board card's WhatsApp button must call onSendWhatsApp with the record's own real phone value");

      const noaCard = Array.from(document.querySelectorAll(".board-card")).find((c) => /Noa/.test(c.textContent ?? ""))!;
      const noaWhatsAppBtn = Array.from(noaCard.querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.equal(noaWhatsAppBtn, undefined, "a board card for a record whose phone field is empty must not get a Send WhatsApp button at all");

      const danaPrintBtn = Array.from(danaCard.querySelectorAll("button")).find((b) => b.textContent?.includes("Print"));
      assert.ok(danaPrintBtn, "expected a Print button on the board card, same as the table row");
      fireEvent.click(danaPrintBtn!);
      await waitForCondition(() => printCalls === 1);
      const sheetText = document.querySelector(".print-record-sheet")!.textContent ?? "";
      assert.match(sheetText, /Dana/, "the print sheet must show the clicked board card's own record, not another one");
    } finally {
      globalThis.fetch = originalFetch;
      window.print = originalPrint;
    }
  });
});

/**
 * Round 777: the "Send WhatsApp" row action used to read only the single
 * phone-like field findPhoneField picked for the WHOLE entity (the first
 * one by declaration order) -- so an entity with two phone-like fields
 * (e.g. "phone", an office line, declared before "mobile", the number
 * that actually receives WhatsApp messages) hid the button entirely for
 * any record whose "phone" happened to be blank, even when that exact
 * record's own "mobile" held a real number. Confirms the fix: the button
 * now falls through to a sibling phone-like field on the SAME record.
 */
test("EntityPanel's row-level 'Send WhatsApp' action falls through to a sibling phone-like field when the first one is blank on this record", async () => {
  await withJsdom(async () => {
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: false },
        { name: "mobile", label: "Mobile", type: "text", required: false },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Dana", phone: "", mobile: "0501234567" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    let sentTo: string | null = null;
    try {
      renderEntityPanel({
        entity: leadEntity,
        allEntities: [leadEntity],
        onSendWhatsApp: (phoneNumber: string) => {
          sentTo = phoneNumber;
        },
      });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const row = document.querySelectorAll("table tbody tr")[0];
      const whatsAppBtn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.ok(whatsAppBtn, "a blank 'phone' must not hide the button when this record's own 'mobile' has a real value");
      fireEvent.click(whatsAppBtn!);
      assert.equal(sentTo, "0501234567", "clicking must use this record's own 'mobile' value, since 'phone' is blank on it");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("EntityPanel's board view card's Send WhatsApp action also falls through to a sibling phone-like field when the first one is blank on this record", async () => {
  await withJsdom(async () => {
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: false },
        { name: "mobile", label: "Mobile", type: "text", required: false },
        {
          name: "stage",
          label: "Stage",
          type: "enum",
          required: true,
          enumValues: ["new", "won"],
          enumLabels: { new: "New", won: "Won" },
        },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Dana", phone: "", mobile: "0501234567", stage: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    let sentTo: string | null = null;
    try {
      renderEntityPanel({
        entity: leadEntity,
        allEntities: [leadEntity],
        onSendWhatsApp: (phoneNumber: string) => {
          sentTo = phoneNumber;
        },
      });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-card").length === 1);

      const danaCard = document.querySelector(".board-card")!;
      const whatsAppBtn = Array.from(danaCard.querySelectorAll("button")).find((b) => b.textContent?.includes("WhatsApp"));
      assert.ok(whatsAppBtn, "a blank 'phone' must not hide the board card's button when this record's own 'mobile' has a real value");
      fireEvent.click(whatsAppBtn!);
      assert.equal(sentTo, "0501234567", "clicking must use this record's own 'mobile' value, since 'phone' is blank on it");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a longtext cell (a "Notes"/"Description" field) now
 * carries its full, untruncated value in a native `title` attribute --
 * before this, the only way to read a longtext value once the column was
 * narrow (or the table was manually resized, see the `.entity-table-resized`
 * ellipsis rule in styles.css) was double-clicking into the real edit
 * textarea, which feels like committing to a change just to read the rest.
 * A short text field must NOT get this treatment, since it's rarely long
 * enough to truncate and every other cell type already renders fine without
 * a tooltip.
 */
test("EntityPanel's longtext cell carries its full value in a title attribute, but a plain text cell does not", async () => {
  await withJsdom(async () => {
    const noteEntity: Entity = {
      name: "Customer",
      label: "Customer",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "notes", label: "Notes", type: "longtext", required: false },
      ],
    };
    const longNote =
      "Called on Tuesday about the delayed shipment, promised a refund by Friday, followed up again on Thursday when nothing arrived, escalated to the warehouse team.";
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", notes: longNote }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (input === "/api/projects/proj1/entities/Customer" && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: noteEntity, allEntities: [noteEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameCell = document.querySelectorAll("table tbody td")[1] as HTMLTableCellElement;
      const notesCell = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      await waitForCondition(() => notesCell.textContent === longNote);

      assert.equal(
        nameCell.querySelector(".longtext-cell"),
        null,
        "a plain text cell must not get the longtext tooltip wrapper (its <td> already carries an unrelated inline-edit hint title)",
      );
      assert.equal(
        notesCell.querySelector(".longtext-cell")?.getAttribute("title"),
        longNote,
        "the longtext cell's title attribute must carry the complete, untruncated value",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: grouping the plain table by an enum/boolean field
 * (isGroupableField/groupRecordsByField, see entityFormatting.test.ts for
 * the pure-function coverage) -- distinct from the Kanban board view, which
 * only ever groups by one auto-picked field and only in its own separate
 * view. This confirms the live component actually wires the dropdown to
 * real group-header rows over the real table, and that switching back to
 * "no grouping" restores the flat row list.
 */
test("EntityPanel's 'Group by' dropdown clusters the table into real group-header rows, and 'no grouping' restores the flat list", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Beta Inc", status: "won" },
      { id: 3, createdAt: "x", name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      assert.ok(groupBySelect, "expected a real 'Group by' dropdown in the toolbar");

      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      assert.deepEqual(
        headerRows.map((r) => r.textContent?.trim()),
        ["▾ New (1)", "▾ Won (2)"],
        "must show one header per status that actually has records, in the enum's own declared order, with the real count (plus the collapse-toggle's own arrow glyph) -- and skip 'Lost' entirely since nothing matched it",
      );
      assert.equal(document.querySelectorAll("table tbody tr").length, 5, "3 record rows + 2 group-header rows");

      fireEvent.change(groupBySelect, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 0);
      assert.equal(document.querySelectorAll("table tbody tr").length, 3, "reverting to 'no grouping' must restore the flat row list");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the "Group by" choice itself is now persisted
 * (groupByPreference.ts, scoped per project+entity like columnOrder.ts) --
 * previously it was plain useState that reset to "no grouping" on every
 * entity switch and was never written to storage at all, so picking a
 * grouping didn't even survive navigating to another entity tab and back,
 * let alone a real page reload. Confirms the live component actually reads
 * and writes through groupByPreference.ts, not just that the pure functions
 * work in isolation (see groupByPreference.test.ts for that).
 */
test("EntityPanel's 'Group by' choice survives an unmount+remount of the same entity, and is scoped per entity", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Beta Inc", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const firstView = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);
      assert.equal(getGroupByField("proj1", "Deal"), "status", "must actually be persisted, not just held in memory");

      firstView.unmount();
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length > 0);

      assert.equal(
        (document.querySelector(".entity-group-by") as HTMLSelectElement).value,
        "status",
        "a fresh mount of the same project+entity must restore the persisted 'Group by' choice, not reset to 'no grouping'",
      );
      assert.equal(document.querySelectorAll(".entity-group-header-row").length, 2, "the table must actually render grouped on first paint, not just show the dropdown as if it were");

      const otherEntity: Entity = {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "tier", label: "Tier", type: "enum", required: true, enumValues: ["free", "paid"], enumLabels: { free: "Free", paid: "Paid" } },
        ],
      };
      cleanup();
      globalThis.fetch = (async (input: string) => {
        if (input === "/api/projects/proj1/entities/Customer") {
          // A groupable field alone doesn't render the "Group by" toolbar at
          // all when the table has zero visible records (see round 227's
          // lesson: an empty visibleRecords shows only the empty-state, not
          // the toolbar) -- so this needs at least one seeded record.
          return new Response(JSON.stringify({ records: [{ id: 1, createdAt: "x", name: "Dana", tier: "free" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${input}`);
      }) as typeof fetch;
      renderEntityPanel({ entity: otherEntity, allEntities: [otherEntity] });
      await waitForCondition(() => document.querySelector(".entity-group-by") !== null);

      assert.equal(
        (document.querySelector(".entity-group-by") as HTMLSelectElement).value,
        "",
        "a different entity in the same project must never inherit Deal's persisted 'status' group-by choice",
      );
      assert.equal(getGroupByField("proj1", "Customer"), "", "and must never have written anything to Customer's own storage slot either");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a grouped table always rendered every one of a
 * group's rows unconditionally -- grouping a large table by e.g. Status
 * only clustered the rows visually, it never let a person actually HIDE
 * a group they don't care about right now (confirmed via grep: no
 * "collapsed"/"Collapse" anywhere in apps/web/src before this round).
 * Confirms the toggle button actually hides/shows that one group's own
 * rows (and its totals row), leaves the other group untouched, and that
 * the collapsed set survives an unmount+remount (collapsedGroupsPreference.ts,
 * scoped per project+entity like fieldFiltersPreference.ts).
 */
test("EntityPanel's group-header toggle collapses and expands just that one group's rows, and the collapsed state survives an unmount+remount", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", status: "new" },
      { id: 2, createdAt: "x", name: "Beta Inc", status: "won" },
      { id: 3, createdAt: "x", name: "Gamma LLC", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const firstView = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);
      assert.equal(document.querySelectorAll("table tbody tr").length, 5, "3 record rows + 2 group-header rows before any toggle");

      const headerRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggle = headerRows[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      assert.ok(wonToggle, "expected a real toggle button in the group header");
      assert.equal(wonToggle.getAttribute("aria-expanded"), "true", "a freshly grouped table must start with every group expanded");

      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.equal(wonToggle.getAttribute("aria-expanded"), "false", "collapsing the 'Won' group must flip its own toggle's aria-expanded");
      // "New" (id 1) stays visible; both "Won" rows (ids 2, 3) are hidden.
      assert.ok(Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Acme Corp")), "the untouched 'New' group's own row must still render");
      assert.ok(!Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Beta Inc")), "the collapsed 'Won' group's rows must no longer render");

      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 5);
      assert.equal(wonToggle.getAttribute("aria-expanded"), "true", "clicking the same toggle again must re-expand the group");

      // Collapse it once more, then unmount+remount to confirm persistence.
      fireEvent.click(wonToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      assert.deepEqual(
        getCollapsedGroups("proj1", "Deal", "status"),
        ["won"],
        "the collapsed group key must actually be persisted, not just held in memory",
      );

      firstView.unmount();
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);
      const headerRowsAfterRemount = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const wonToggleAfterRemount = headerRowsAfterRemount[1].querySelector(".entity-group-toggle") as HTMLButtonElement;
      assert.equal(
        wonToggleAfterRemount.getAttribute("aria-expanded"),
        "false",
        "a fresh mount of the same project+entity must restore the persisted collapsed group, not reset to all-expanded",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 434's finding: collapsedGroupsPreference.ts
 * scoped its persisted collapsed-group keys by project+entity only, not by
 * which field the table was grouped by. groupRecordsByField's own group
 * keys are field-independent -- every boolean field's two groups are keyed
 * by the literal strings "true"/"false" -- so an entity with two or more
 * boolean fields (very plausible for an AI-generated spec) leaked its
 * collapsed state from one field onto another the moment "Group by"
 * switched between them, hiding records the person never chose to hide
 * under the newly-selected field at all.
 */
test("EntityPanel's collapsed-group state does not leak from one 'Group by' field to a different field with the same group keys", async () => {
  await withJsdom(async () => {
    const twoBooleanFieldsEntity: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "completed", label: "Completed", type: "boolean", required: true },
        { name: "urgent", label: "Urgent", type: "boolean", required: true },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", name: "Acme Corp", completed: true, urgent: false },
      { id: 2, createdAt: "x", name: "Beta Inc", completed: false, urgent: true },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ entity: twoBooleanFieldsEntity, allEntities: [twoBooleanFieldsEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "completed" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      // Collapse "completed"'s own "No" group (the literal key "false").
      const completedHeaderRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const completedNoToggle = completedHeaderRows
        .find((r) => r.textContent?.includes("No"))
        ?.querySelector(".entity-group-toggle") as HTMLButtonElement;
      assert.ok(completedNoToggle, "expected a 'No' group header under 'completed'");
      fireEvent.click(completedNoToggle);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      // Switch "Group by" to "urgent" -- a DIFFERENT field the person never
      // touched, but whose own "No" group shares the exact same key "false".
      fireEvent.change(groupBySelect, { target: { value: "urgent" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const urgentHeaderRows = Array.from(document.querySelectorAll(".entity-group-header-row"));
      const urgentNoToggle = urgentHeaderRows
        .find((r) => r.textContent?.includes("No"))
        ?.querySelector(".entity-group-toggle") as HTMLButtonElement;
      assert.ok(urgentNoToggle, "expected a 'No' group header under 'urgent'");
      assert.equal(
        urgentNoToggle.getAttribute("aria-expanded"),
        "true",
        "switching 'Group by' to a different field must not carry over the first field's collapsed-group state",
      );
      assert.equal(
        document.querySelectorAll("table tbody tr").length,
        4,
        "both of 'urgent''s groups (1 record each) plus their 2 headers must render fully expanded",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (243): the Table/Board/Calendar viewMode choice itself
 * is now persisted (viewModePreference.ts, scoped per project+entity like
 * groupByPreference.ts) -- previously it was plain useState that hard-reset
 * to "table" on every entity switch (and even on a plain unmount+remount of
 * the very same entity), so setting up a Kanban board for one entity meant
 * re-clicking "Board" by hand every time you switched tabs and came back.
 * Confirms the live component actually reads and writes through
 * viewModePreference.ts, not just that the pure functions work in isolation
 * (see viewModePreference.test.ts for that), and that a persisted choice
 * which no longer has a matching field (a boardless entity) falls back to
 * table instead of rendering broken.
 */
test("EntityPanel's Table/Board/Calendar view choice survives an unmount+remount of the same entity, and is scoped per entity", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const firstView = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);
      assert.equal(getViewMode("proj1", "Deal"), "board", "must actually be persisted, not just held in memory");

      firstView.unmount();
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 3);

      assert.ok(
        document.querySelectorAll(".view-toggle-btn")[1].classList.contains("view-toggle-btn-active"),
        "a fresh mount of the same project+entity must restore the persisted 'Board' view, not reset to Table",
      );
      assert.equal(document.querySelectorAll("table").length, 0, "must genuinely render the board, not just mark the button active while still showing the table");

      cleanup();
      const textOnlyEntity: Entity = {
        name: "Note",
        fields: [{ name: "name", type: "text", required: true }],
      };
      globalThis.fetch = (async (input: string) => {
        if (input === "/api/projects/proj1/entities/Note") {
          return new Response(JSON.stringify({ records: [{ id: 1, createdAt: "x", name: "Reminder" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${input}`);
      }) as typeof fetch;
      renderEntityPanel({ entity: textOnlyEntity, allEntities: [textOnlyEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        document.querySelector(".view-toggle"),
        null,
        "a different entity with no board/date field must never inherit Deal's persisted 'board' view -- it must fall back to plain Table with no view toggle at all",
      );
      assert.equal(getViewMode("proj1", "Note"), "table", "and must never have written anything to Note's own storage slot either");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 250: sortKeys previously reset to [] on every
 * single entity/tab switch (see the combined reset effect keyed on
 * entity.name), not just a reload, so a deliberately-set sort -- even a
 * plain single-column one -- never survived leaving and returning to the
 * same tab within the same session. Mirrors the Group-by/view-mode
 * persistence tests just above.
 */
test("EntityPanel's multi-column sort survives an unmount+remount of the same entity, and drops a key whose field no longer exists on a different entity", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Acme Corp", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const firstView = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const statusHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      const nameHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Name/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      fireEvent.click(statusHeader);
      fireEvent.click(nameHeader, { shiftKey: true });
      await waitForCondition(() => document.querySelectorAll(".sort-priority").length === 2);
      assert.deepEqual(
        getSortKeys("proj1", "Deal"),
        [
          { field: "status", direction: "asc" },
          { field: "name", direction: "asc" },
        ],
        "must actually be persisted, not just held in memory",
      );

      firstView.unmount();
      renderEntityPanel();
      await waitForCondition(() => {
        const names = Array.from(document.querySelectorAll("table tbody tr")).map((r) => r.textContent ?? "");
        return /Acme/.test(names[0]) && /Zeta/.test(names[1]) && /Globex/.test(names[2]);
      });
      assert.equal(
        document.querySelectorAll(".sort-priority").length,
        2,
        "a fresh mount of the same project+entity must restore both persisted sort keys, not reset to unsorted",
      );

      cleanup();
      const textOnlyEntity: Entity = {
        name: "Note",
        fields: [{ name: "name", type: "text", required: true }],
      };
      globalThis.fetch = (async (input: string) => {
        if (input === "/api/projects/proj1/entities/Note") {
          return new Response(JSON.stringify({ records: [{ id: 1, createdAt: "x", name: "Reminder" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${input}`);
      }) as typeof fetch;
      renderEntityPanel({ entity: textOnlyEntity, allEntities: [textOnlyEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        document.querySelectorAll(".sort-priority").length,
        0,
        "a different entity with no 'status' field must never inherit Deal's persisted sort keys",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 339: fieldFilters previously had no persistence
 * at all -- it was hard-reset to {} on every entity/tab switch (see the
 * combined reset effect keyed on entity.name), so a deliberately-set
 * per-field filter never survived leaving and returning to the same tab,
 * unlike this entity's sort order, grouping, hidden columns, and column
 * widths, all of which already survived the exact same switch (round 250
 * fixed this for sortKeys specifically). Mirrors that test almost exactly.
 */
test("EntityPanel's per-field enum filter survives an unmount+remount of the same entity, and drops a filter whose field no longer exists on a different entity", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Acme Corp", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const firstView = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "new" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.deepEqual(getFieldFilters("proj1", "Deal"), { status: "new" }, "must actually be persisted, not just held in memory");

      firstView.unmount();
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.equal(
        (document.querySelector(".entity-status-filter") as HTMLSelectElement).value,
        "new",
        "a fresh mount of the same project+entity must restore the persisted filter, not reset to 'All'",
      );

      cleanup();
      const textOnlyEntity: Entity = {
        name: "Note",
        fields: [{ name: "name", type: "text", required: true }],
      };
      globalThis.fetch = (async (input: string) => {
        if (input === "/api/projects/proj1/entities/Note") {
          return new Response(JSON.stringify({ records: [{ id: 1, createdAt: "x", name: "Reminder" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${input}`);
      }) as typeof fetch;
      renderEntityPanel({ entity: textOnlyEntity, allEntities: [textOnlyEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        document.querySelector(".entity-status-filter"),
        null,
        "a different entity with no enum field at all must never inherit Deal's persisted filter, nor render a filter select that has nothing to filter by",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the toolbar filter select is the one remaining
 * sibling in the "stale value has no <option>" family (round 508) that
 * never got the fix -- unlike FieldInput's own enum branch a few hundred
 * lines above, this select's options were built only from the field's
 * CURRENT enumValues, never including fieldFilters[f.name]'s own value if
 * that value has since become stale (an AI refine renaming/narrowing the
 * enum while the field itself survives under the same name -- migrate.ts
 * only ever adds columns, never rewrites existing row data). Without a
 * matching <option>, the browser silently blanks the controlled select
 * even though the filter is still actively applied.
 */
test("EntityPanel's enum filter select keeps a stale persisted value visibly selected via a synthetic option, instead of silently going blank, when a refine narrows field.enumValues", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Acme Corp", status: "lost" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      const view = renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "lost" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const narrowedDealEntity: Entity = {
        ...DEAL_ENTITY,
        fields: DEAL_ENTITY.fields.map((f) =>
          f.name === "status"
            ? { ...f, enumValues: ["new", "won", "archived"], enumLabels: { new: "New", won: "Won", archived: "Archived" } }
            : f,
        ),
      };
      view.rerender(buildEntityPanelElement({ entity: narrowedDealEntity, allEntities: [narrowedDealEntity] }));

      const filterAfterRefine = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      assert.equal(
        filterAfterRefine.value,
        "lost",
        "the select must still reflect the real, still-active stale filter value, not silently go blank",
      );
      assert.ok(
        Array.from(filterAfterRefine.options).some((o) => o.value === "lost"),
        "a synthetic option for the stale value must exist so the browser can actually display it as selected",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The relation half of the same gap: a filter set to a related record's
 * id, with that record since deleted while the relation field itself
 * survives, has no matching <option> either -- mirrors FieldInput's own
 * relation branch's synthetic "#id" fallback (round 515).
 */
test("EntityPanel's relation filter select keeps a stale persisted id visibly selected via a synthetic '#id' option, instead of silently going blank, when the filtered-to related record has been deleted", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "item", label: "Item", type: "text", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", item: "Pizza", courierId: 9 },
      { id: 2, createdAt: "x", item: "Sushi", courierId: 10 },
    ];
    let courierRecords: EntityRecord[] = [
      { id: 9, createdAt: "x", name: "Dana" },
      { id: 10, createdAt: "x", name: "Omer" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Courier") {
        return new Response(JSON.stringify({ records: courierRecords }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      const firstView = renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      await waitForCondition(() => document.querySelector(".entity-status-filter") !== null);

      const filterSelect = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(filterSelect, { target: { value: "10" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      firstView.unmount();
      // Simulate Omer having been deleted in the meantime -- the related
      // record disappears from Courier's own list, but the persisted
      // filter (fieldFiltersPreference, keyed by projectId+entity.name)
      // still holds the now-deleted id.
      courierRecords = [{ id: 9, createdAt: "x", name: "Dana" }];
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity, courierEntity] });
      await waitForCondition(() => document.querySelector(".entity-status-filter") !== null);
      const filterAfterDeletion = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      await waitForCondition(() => filterAfterDeletion.value === "10");

      assert.ok(
        Array.from(filterAfterDeletion.options).some((o) => o.value === "10"),
        "a synthetic '#10' option for the deleted-but-still-filtered courier must exist so the browser can actually display it as selected",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (341): with no way to reset multiple active per-field
 * filters except reopening each dropdown individually, a "Clear filters"
 * button now appears only once at least one filter is actually set, and
 * resets every filter (both in memory and in persisted storage) with one
 * click.
 */
test("EntityPanel shows a 'Clear filters' button only once a filter is active, and it resets both the select and the persisted storage", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Acme Corp", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      assert.equal(document.querySelector(".entity-clear-filters"), null, "no filter is active yet, so the button must not render at all");

      const statusFilter = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      fireEvent.change(statusFilter, { target: { value: "new" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const clearButton = document.querySelector(".entity-clear-filters") as HTMLButtonElement;
      assert.ok(clearButton, "the button must appear the moment a filter is set");

      fireEvent.click(clearButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      assert.equal((document.querySelector(".entity-status-filter") as HTMLSelectElement).value, "", "the select itself must reset back to 'All'");
      assert.deepEqual(getFieldFilters("proj1", "Deal"), {}, "the persisted storage must be cleared too, not just the in-memory state");
      assert.equal(document.querySelector(".entity-clear-filters"), null, "the button must disappear again once nothing is filtered");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: every other filtering control in the toolbar already
 * has a one-click way to reset it ("Clear filters" for the per-field enum
 * selects just above, "Clear sort" for column sort), but the free-text
 * search box itself still had none -- the only ways to empty it were
 * deleting every character by hand or switching entities (a side effect
 * of an unrelated reset, not a user-facing action). A small "x" button now
 * appears next to the search input only once it actually has text in it,
 * and clears it (and only it -- not the persisted recent-searches list,
 * which has its own separate "Clear" button and storage key) in one click.
 */
test("EntityPanel shows a 'Clear search' button only once the search box has text, and it empties only the live search value", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Acme Corp", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(document.querySelector(".entity-clear-search"), null, "the search box starts empty, so the button must not render at all");

      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "Globex" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const clearButton = document.querySelector(".entity-clear-search") as HTMLButtonElement;
      assert.ok(clearButton, "the button must appear the moment the search box has text");

      fireEvent.click(clearButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal((document.querySelector(".entity-search") as HTMLInputElement).value, "", "the search input itself must empty out");
      assert.equal(document.querySelector(".entity-clear-search"), null, "the button must disappear again once the search box is empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: toggleSort's own non-additive branch only ever
 * collapses a sort down to a single key -- it can never empty sortKeys
 * back to [], so once a multi-column sort was built (shift-click), there
 * was no way back to the table's natural/unsorted order except reversing
 * each column's direction twice by hand. Mirrors "Clear filters" (round
 * 341) and "Reset column widths" (round 345): a one-click reset button
 * that only renders once there's actually something to reset.
 */
test("EntityPanel shows a 'Clear sort' button only once a sort is active, and it resets both the headers and the persisted storage", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Globex", status: "won" },
      { id: 2, name: "Zeta Inc", status: "new" },
      { id: 3, name: "Acme Corp", status: "new" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      assert.equal(document.querySelector(".entity-clear-sort"), null, "no sort is active yet, so the button must not render at all");

      const statusHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Status/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      const nameHeader = Array.from(document.querySelectorAll("thead th button.sort-header")).find((el) =>
        /Name/.test(el.textContent ?? ""),
      ) as HTMLButtonElement;
      fireEvent.click(statusHeader);
      fireEvent.click(nameHeader, { shiftKey: true });
      await waitForCondition(() => document.querySelectorAll(".sort-priority").length === 2);

      const clearButton = document.querySelector(".entity-clear-sort") as HTMLButtonElement;
      assert.ok(clearButton, "the button must appear the moment a sort is active, including a multi-key one");

      fireEvent.click(clearButton);
      await waitForCondition(() => document.querySelectorAll(".sort-priority").length === 0);

      const sortedHeaders = Array.from(document.querySelectorAll("thead th[aria-sort]")).filter((th) => th.getAttribute("aria-sort") !== "none");
      assert.equal(sortedHeaders.length, 0, "no column header must still report itself as sorted");
      assert.deepEqual(getSortKeys("proj1", "Deal"), [], "the persisted storage must be cleared too, not just the in-memory state");
      assert.equal(document.querySelector(".entity-clear-sort"), null, "the button must disappear again once nothing is sorted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the table had no footer totals for a numeric column --
 * for an entity like Invoice, a business owner had to add up the amounts by
 * eye. Confirms the totals row sums only the currently-visible (searched)
 * records, matches the real formatNumberValue thousands-separator
 * formatting, leaves non-numeric columns blank, and disappears entirely for
 * an entity with no number field at all (a text-only table must not grow an
 * empty totals row for nothing).
 */
test("EntityPanel's table shows a totals row summing each numeric column over the currently-visible (searched) records, and omits it when there's no number field", async () => {
  await withJsdom(async () => {
    const invoiceEntity: Entity = {
      name: "Invoice",
      label: "Invoice",
      fields: [
        { name: "client", label: "Client", type: "text", required: true },
        { name: "amount", label: "Amount", type: "number", required: true },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", client: "Acme Corp", amount: 1500 },
      { id: 2, createdAt: "x", client: "Globex", amount: 2500 },
      { id: 3, createdAt: "x", client: "Acme Branch", amount: 700 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Invoice") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: invoiceEntity, allEntities: [invoiceEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const footerRow = document.querySelector("table tfoot tr")!;
      assert.ok(footerRow, "expected a tfoot totals row when the entity has a number field");
      assert.match(footerRow.textContent ?? "", /4,700/, "the unfiltered total (1500 + 2500 + 700 = 4700) must render with real locale thousands separators");
      assert.doesNotMatch(footerRow.textContent ?? "", /Acme|Globex/, "the totals row must not echo any client name text");

      fireEvent.change(document.querySelector(".entity-search")!, { target: { value: "Acme" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.match(
        document.querySelector("table tfoot tr")!.textContent ?? "",
        /2,200/,
        "narrowing the search to the two Acme rows (1500 + 700 = 2200) must update the total, not keep summing the full unfiltered store",
      );

      cleanup();
      const textOnlyEntity: Entity = { name: "Note", fields: [{ name: "name", type: "text", required: true }] };
      globalThis.fetch = (async (input: string) => {
        if (input === "/api/projects/proj1/entities/Note") {
          return new Response(JSON.stringify({ records: [{ id: 1, createdAt: "x", name: "Reminder" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${input}`);
      }) as typeof fetch;
      renderEntityPanel({ entity: textOnlyEntity, allEntities: [textOnlyEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.equal(
        document.querySelector("table tfoot"),
        null,
        "an entity with no number field at all must render no tfoot, not an empty totals row",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: grouping the table by an enum/boolean field (round
 * ~286-ish) and the numeric totals row (round 297) each shipped
 * independently and were never wired together -- grouping Orders by Status
 * specifically to compare revenue across "Paid" vs "Pending" still only
 * ever showed one grand total under the WHOLE table, forcing a business
 * owner to re-add each group's rows by eye, defeating the point of
 * grouping a numeric table at all. Confirms each group now gets its own
 * subtotal row (summing only that group's own records), the grand total in
 * the tfoot is unaffected, and reverting to "no grouping" removes the
 * per-group subtotal rows again.
 */
test("EntityPanel's grouped table shows a numeric subtotal row per group, summing only that group's own records", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "client", label: "Client", type: "text", required: true },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["paid", "pending"],
          enumLabels: { paid: "Paid", pending: "Pending" },
        },
        { name: "amount", label: "Amount", type: "number", required: true },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", client: "Acme Corp", status: "paid", amount: 1000 },
      { id: 2, createdAt: "x", client: "Globex", status: "paid", amount: 500 },
      { id: 3, createdAt: "x", client: "Initech", status: "pending", amount: 300 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const subtotalRows = Array.from(document.querySelectorAll(".entity-group-totals-row"));
      assert.equal(subtotalRows.length, 2, "expected one subtotal row per group");
      assert.match(
        subtotalRows[0].textContent ?? "",
        /1,500/,
        "the Paid group's subtotal (1000 + 500) must be 1,500, not the whole table's total",
      );
      assert.doesNotMatch(subtotalRows[0].textContent ?? "", /300/, "the Paid group's subtotal must not include Pending's amount");
      assert.match(
        subtotalRows[1].textContent ?? "",
        /(?<!,)300/,
        "the Pending group's subtotal must be its own single record's amount (300), not 1,500 or 1,800",
      );

      assert.match(
        document.querySelector("table tfoot tr")!.textContent ?? "",
        /1,800/,
        "the grand total in the tfoot must still sum all groups together (1000 + 500 + 300 = 1800), unaffected by per-group subtotals",
      );

      fireEvent.change(groupBySelect, { target: { value: "" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 0);
      assert.equal(
        document.querySelectorAll(".entity-group-totals-row").length,
        0,
        "reverting to 'no grouping' must remove the per-group subtotal rows",
      );
      assert.ok(document.querySelector("table tfoot tr"), "the grand-total tfoot must still be present with no grouping");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 837: Board view groups records by exactly the same kind of field
 * (enum/boolean) Table view's own "Group by" does -- the test just above
 * confirms Table view shows each group's own numeric subtotal for exactly
 * this reason (comparing revenue across "Paid" vs "Pending" without
 * re-adding each group's rows by eye), but Board view's own column header
 * showed only a bare card count, with no way to compare e.g. deal value
 * across pipeline-stage columns despite grouping by the identical field.
 */
test("EntityPanel's Board view shows a numeric subtotal per column, summing only that column's own records", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "client", label: "Client", type: "text", required: true },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["paid", "pending"],
          enumLabels: { paid: "Paid", pending: "Pending" },
        },
        { name: "amount", label: "Amount", type: "number", required: true },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", client: "Acme Corp", status: "paid", amount: 1000 },
      { id: 2, createdAt: "x", client: "Globex", status: "paid", amount: 500 },
      { id: 3, createdAt: "x", client: "Initech", status: "pending", amount: 300 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 2);

      // Each card's own move-select lists every declared status as an
      // <option> (so a card can be dragged OR moved via that dropdown),
      // meaning every column's full textContent contains both "Paid" and
      // "Pending" regardless of which column it is -- only the column's
      // own header badge is unique to its own column.
      const findColumnByBadge = (label: string) =>
        Array.from(document.querySelectorAll(".board-column")).find((col) => col.querySelector(".badge")?.textContent === label)!;
      const paidColumn = findColumnByBadge("Paid");
      const pendingColumn = findColumnByBadge("Pending");

      assert.match(
        paidColumn.querySelector(".board-column-header")!.textContent ?? "",
        /1,500/,
        "the Paid column's subtotal (1000 + 500) must be 1,500, not the whole board's total",
      );
      assert.doesNotMatch(
        paidColumn.querySelector(".board-column-header")!.textContent ?? "",
        /300/,
        "the Paid column's subtotal must not include Pending's amount",
      );
      assert.match(
        pendingColumn.querySelector(".board-column-header")!.textContent ?? "",
        /(?<!,)300/,
        "the Pending column's subtotal must be its own single record's amount (300), not 1,500 or 1,800",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for round 491's finding: numericFieldTotals (the grand
 * total shown in the table's tfoot) was computed from visibleRecords
 * rather than effectivelyVisibleRecords -- the same collapse-aware value
 * round 486 introduced for "select all" and round 487 for Export
 * CSV/Copy/Print. Collapsing a group hid that group's own per-group
 * subtotal row (correctly), but the grand total kept counting the
 * collapsed group's amounts anyway, so the one subtotal still on screen no
 * longer added up to the footer's number. Confirms collapsing "Paid"
 * leaves only Pending's subtotal (300) on screen, and the grand total now
 * matches it (300) instead of the full 1,800.
 */
test("EntityPanel's grand-total tfoot excludes a collapsed group's records, matching what's actually visible", async () => {
  await withJsdom(async () => {
    const orderEntity: Entity = {
      name: "Order",
      label: "Order",
      fields: [
        { name: "client", label: "Client", type: "text", required: true },
        {
          name: "status",
          label: "Status",
          type: "enum",
          required: true,
          enumValues: ["paid", "pending"],
          enumLabels: { paid: "Paid", pending: "Pending" },
        },
        { name: "amount", label: "Amount", type: "number", required: true },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, createdAt: "x", client: "Acme Corp", status: "paid", amount: 1000 },
      { id: 2, createdAt: "x", client: "Globex", status: "paid", amount: 500 },
      { id: 3, createdAt: "x", client: "Initech", status: "pending", amount: 300 },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: orderEntity, allEntities: [orderEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const groupBySelect = document.querySelector(".entity-group-by") as HTMLSelectElement;
      fireEvent.change(groupBySelect, { target: { value: "status" } });
      await waitForCondition(() => document.querySelectorAll(".entity-group-header-row").length === 2);

      const paidToggle = document.querySelectorAll(".entity-group-header-row")[0].querySelector(".entity-group-toggle") as HTMLButtonElement;
      fireEvent.click(paidToggle);
      await waitForCondition(
        () => !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Acme Corp")),
      );
      assert.ok(
        !Array.from(document.querySelectorAll("table tbody tr")).some((r) => r.textContent?.includes("Globex")),
        "the 'Paid' group must actually be collapsed before checking the grand total",
      );

      const subtotalRows = Array.from(document.querySelectorAll(".entity-group-totals-row"));
      assert.equal(subtotalRows.length, 1, "only the still-expanded Pending group should have a visible subtotal row");
      assert.match(subtotalRows[0].textContent ?? "", /(?<!,)300/, "the one visible subtotal must be Pending's own 300");

      assert.match(
        document.querySelector("table tfoot tr")!.textContent ?? "",
        /(?<!,)300/,
        "the grand total must match the one subtotal still visible (300), not the full 1,800 including the collapsed Paid group",
      );
      assert.doesNotMatch(
        document.querySelector("table tfoot tr")!.textContent ?? "",
        /1,800/,
        "the grand total must not still include the collapsed Paid group's 1,500",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Updated in round 980: this test used to confirm `<input type="number">`
 * carried `step="any"` so a decimal price wouldn't fail native HTML5
 * step-mismatch validation. Round 980's own fix (see EntityPanel.tsx)
 * replaced that native number input for a real "number" field with a
 * plain text input (inputMode="decimal") entirely, to fix a *different*,
 * more serious bug: the HTML spec's number-input value-sanitization
 * algorithm requires at least one digit before it reports anything
 * through `.value`, so a lone "-" -- the first character of any negative
 * number typed from an empty field -- was wiped by the native input
 * itself before this component's own code ever ran, making it impossible
 * to type a negative amount from empty. A plain text input has no such
 * sanitization and no step-mismatch validation to fail in the first
 * place, so the original step="any" concern no longer applies to a real
 * "number" field at all. A relation field's raw fallback input (no
 * related entity loaded) is unaffected by either fix -- a foreign-key id
 * is always a non-negative integer with no need to type "-", so it keeps
 * the native number input with its default integer step.
 */
test("EntityPanel's number field input is a plain text input with a decimal keyboard hint (not a native number input), while a relation field's fallback input keeps the native number input with its default integer step", async () => {
  await withJsdom(async () => {
    const invoiceEntity: Entity = {
      name: "Invoice",
      label: "Invoice",
      fields: [
        { name: "client", label: "Client", type: "text", required: true },
        { name: "amount", label: "Amount", type: "number", required: true },
        { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
      ],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Invoice") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      // allEntities intentionally omits "Courier" -- relatedEntity stays
      // undefined, so the relation field falls back to the raw number
      // input path.
      renderEntityPanel({ entity: invoiceEntity, allEntities: [invoiceEntity] });
      await waitForCondition(() => document.querySelectorAll(".record-form input").length > 0);

      const amountInput = document.querySelector('.record-form input[inputmode="decimal"]') as HTMLInputElement;
      assert.ok(amountInput, "expected the real 'number' field's input to carry inputMode=\"decimal\"");
      assert.equal(amountInput.type, "text", "a real 'number' field's input must be a plain text input, not a native number input");

      const relationFallbackInput = document.querySelector('.record-form input[type="number"]') as HTMLInputElement;
      assert.ok(relationFallbackInput, "expected the relation field's raw fallback input to still be a native number input");
      assert.equal(
        relationFallbackInput.getAttribute("step"),
        null,
        "a relation field's fallback number input must keep the default integer step -- a foreign-key id is always an integer",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in round 980: a real bug in FieldInput's number input, found by a
 * fresh Explore survey. A real "number" business field -- price, amount,
 * rating, a balance delta -- can legitimately be negative, but there was
 * no way to type one into an empty field: `<input type="number">`'s own
 * HTML5 value-sanitization algorithm requires at least one digit before
 * it reports anything through `.value`, so the native input reported
 * e.target.value as "" the instant a lone "-" was typed, before this
 * component's own (then-eager Number(value)) coercion even ran --
 * confirmed directly in jsdom to match real Chrome/Firefox, independent
 * of this component's own code. The fix (above) switches a real "number"
 * field to a plain text input, which never performs that sanitization.
 * Confirms typing "-" alone no longer wipes the field, that continuing to
 * type the rest of a negative number produces the full string, and that
 * submitting the form sends the real negative number through to the
 * server (which already accepted negative numbers fine -- only the UI
 * control was broken).
 */
test("EntityPanel's number field input lets a user type a negative value starting from empty, and submits it correctly", async () => {
  await withJsdom(async () => {
    const dealEntity: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "adjustment", label: "Adjustment", type: "number", required: true },
      ],
    };
    const postedBodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        const body = JSON.parse(init!.body as string);
        postedBodies.push(body);
        return new Response(JSON.stringify({ record: { id: 1, ...body } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: dealEntity, allEntities: [dealEntity] });
      await waitForCondition(() => document.querySelector(".record-form") !== null);

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Refund" } });

      const adjustmentInput = document.querySelector('.record-form input[inputmode="decimal"]') as HTMLInputElement;
      fireEvent.change(adjustmentInput, { target: { value: "-" } });
      assert.equal(adjustmentInput.value, "-", "typing a lone \"-\" into an empty number field must not wipe it back to empty");

      fireEvent.change(adjustmentInput, { target: { value: "-5" } });
      assert.equal(adjustmentInput.value, "-5", "continuing to type the rest of a negative number must produce the full string");

      const submitButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Add") as HTMLButtonElement;
      fireEvent.click(submitButton);
      await waitForCondition(() => postedBodies.length === 1);

      assert.equal(Number(postedBodies[0]?.adjustment), -5, "the real negative number must reach the server, not be lost or coerced to NaN/empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 984: a real bug introduced by round 980's own fix just above (not
 * a pre-existing gap), found by a fresh Explore survey. Switching a real
 * "number" field's input to a plain text input removed the one thing
 * that used to make a non-numeric string physically impossible to type
 * into it: the native number input's own keystroke sanitization. Without
 * a client-side check, ordinary typo text (e.g. "not-a-number") now
 * reached the server as-is -- rejected there, but surfaced to the user
 * only as the generic, field-agnostic VALIDATION_ERROR banner
 * (resolveErrorMessage always overrides a real server message for that
 * error code), the exact failure shape missingField already exists to
 * avoid for a required-but-empty field. Confirms the add/edit form now
 * refuses before even sending the request, naming the field.
 */
test("EntityPanel's add/edit form refuses a non-numeric value for a 'number' field, instead of sending a doomed POST", async () => {
  await withJsdom(async () => {
    const dealEntity: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "amount", label: "Amount", type: "number", required: false },
      ],
    };
    let postCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        postCalled = true;
        return new Response(JSON.stringify({ record: { id: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: dealEntity, allEntities: [dealEntity] });
      await waitForCondition(() => document.querySelector(".record-form") !== null);

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Widget" } });

      const amountInput = document.querySelector('.record-form input[inputmode="decimal"]') as HTMLInputElement;
      fireEvent.change(amountInput, { target: { value: "not-a-number" } });

      const submitButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Add") as HTMLButtonElement;
      fireEvent.click(submitButton);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(postCalled, false, "must never send a POST with a non-numeric 'number' field value");
      assert.match(
        document.querySelector("p.error")?.textContent ?? "",
        /Amount.*must be a number|must be a number.*Amount/,
        "must show a real, specific 'must be a number' message naming the field, not a generic one",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in round 981: a real bug in FieldInput's enum branch, found by a
 * fresh Explore survey. The enum `<select>`'s own "no value" placeholder
 * (`<option value="">`) carried `disabled`, while the relation branch's
 * identical "no value" placeholder just above it in the exact same
 * function never did. For a non-required enum field, the server already
 * stores `null` fine for an empty value (packages/db/src/repository.ts's
 * `coerceValue` short-circuits to `null` before the per-type switch, the
 * same path every other optional field type already reaches) -- but once
 * any real enum value had ever been chosen for a record, there was no
 * click sequence anywhere (the add/edit form, the inline cell editor, or
 * the bulk-edit picker, all three sharing this same branch) that could
 * select the disabled placeholder to clear it back to empty again. Every
 * other optional field type already supports this (text/number/date by
 * clearing the text, relation via its own non-disabled placeholder, file
 * via an explicit Remove link). Confirms the placeholder is now
 * selectable and that selecting it actually clears an already-set field.
 */
test("EntityPanel's enum field can be cleared back to no value once it has a real value, matching the relation field's own non-disabled placeholder", async () => {
  await withJsdom(async () => {
    const ticketEntity: Entity = {
      name: "Ticket",
      label: "Ticket",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        {
          name: "priority",
          label: "Priority",
          type: "enum",
          required: false,
          enumValues: ["Low", "Medium", "High"],
          enumLabels: { Low: "Low", Medium: "Medium", High: "High" },
        },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", title: "Fix login", priority: "High" }];
    const patchedBodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Ticket") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Ticket/1") {
        const body = JSON.parse(init!.body as string);
        patchedBodies.push(body);
        return new Response(JSON.stringify({ record: { ...store[0], ...body } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: ticketEntity, allEntities: [ticketEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form select") as HTMLSelectElement)?.value === "High");

      const prioritySelect = document.querySelector(".record-form select") as HTMLSelectElement;
      const placeholderOption = Array.from(prioritySelect.options).find((o) => o.value === "") as HTMLOptionElement;
      assert.ok(placeholderOption, "expected a real placeholder <option> for \"no value\"");
      assert.equal(placeholderOption.disabled, false, "the enum field's own \"no value\" placeholder must be selectable, matching the relation field's placeholder");

      fireEvent.change(prioritySelect, { target: { value: "" } });
      await waitForCondition(() => prioritySelect.value === "");

      const submitButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
      fireEvent.click(submitButton);
      await waitForCondition(() => patchedBodies.length === 1);

      assert.equal(patchedBodies[0]?.priority, "", "clearing the enum field back to no value must actually send the cleared value to the server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the manual add/edit record form's own inputs never
 * carried the native `required` attribute, even for a field the entity
 * itself declares required=true -- found by a fresh Explore survey. The
 * visual "*" next to a required field's label (FieldLabelEditor.tsx) was
 * always there, but it's decorative text only; nothing stopped a click on
 * Add/Save with a required field left empty from reaching the server,
 * which then only ever surfaces a generic, non-field-specific error
 * banner (the exact field name is discarded by resolveErrorMessage's
 * VALIDATION_ERROR handling, by design -- server messages are English-only
 * and can't be shown raw in a Hebrew UI). This wires `field.required`
 * straight into the real rendered `required` attribute on every FieldInput
 * branch except boolean (a checkbox's unchecked state is a real, complete
 * value -- there is no "empty" state to require away, unlike every other
 * field type). PasswordInput.tsx already established this exact
 * `required={required}` pattern elsewhere in the app; this closes the one
 * place it had never been applied.
 */
test("EntityPanel's add/edit form wires field.required into the real required attribute on every input type except boolean", async () => {
  await withJsdom(async () => {
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "notes", label: "Notes", type: "longtext", required: false },
        { name: "status", label: "Status", type: "enum", required: true, enumValues: ["New", "Won"] },
        { name: "followUpDate", label: "Follow-up", type: "date", required: false },
        { name: "isVip", label: "VIP", type: "boolean", required: true },
        { name: "score", label: "Score", type: "number", required: true },
      ],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: leadEntity, allEntities: [leadEntity] });
      await waitForCondition(() => document.querySelector(".record-form") !== null);

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      assert.equal(nameInput.required, true, "a required text field's real input must carry the required attribute");

      const notesTextarea = document.querySelector(".record-form textarea") as HTMLTextAreaElement;
      assert.equal(notesTextarea.required, false, "an optional longtext field's textarea must NOT be required");

      const statusSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.equal(statusSelect.required, true, "a required enum field's real <select> must carry the required attribute");

      const dateInput = document.querySelector('.record-form input[type="date"]') as HTMLInputElement;
      assert.equal(dateInput.required, false, "an optional date field's input must NOT be required");

      const checkbox = document.querySelector('.record-form input[type="checkbox"]') as HTMLInputElement;
      assert.equal(
        checkbox.required,
        false,
        "a boolean field must never get the required attribute even when field.required is true -- unchecked is already a complete, real value",
      );

      const numberInput = document.querySelector('.record-form input[inputmode="decimal"]') as HTMLInputElement;
      assert.equal(numberInput.required, true, "a required number field's real input must carry the required attribute");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 443: FieldSchema.enumValues has no uniqueness constraint (and
 * deliberately isn't given one -- tightening ProductSpecSchema would make
 * an already-stored project/checkpoint with this defect fail to parse from
 * now on, too high a cost for a cosmetic rendering bug). The one realistic
 * way a real project ends up with a duplicate is an AI-generated spec.
 * Before this fix, every enum <select> mapped enumValues directly to
 * <option> elements keyed by the raw value, so a duplicate rendered the
 * same choice twice. Covers all three enum <select> sites in one entity:
 * the add/edit form's FieldInput, the Kanban board card's move dropdown,
 * and the toolbar's filter-by-field dropdown.
 */
test("EntityPanel's enum <select> never renders the same option twice, even when the field's own enumValues contains a duplicate", async () => {
  await withJsdom(async () => {
    const dealEntity: Entity = {
      name: "Deal",
      label: "Deal",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "status", label: "Status", type: "enum", required: true, enumValues: ["new", "new", "won"] },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, name: "Acme Corp", status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ entity: dealEntity, allEntities: [dealEntity] });
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const filterSelect = document.querySelector(".entity-status-filter") as HTMLSelectElement;
      assert.ok(filterSelect, "expected the toolbar's filter-by-status dropdown to render");
      assert.deepEqual(
        Array.from(filterSelect.options)
          .map((o) => o.value)
          .filter((v) => v !== ""),
        ["new", "won"],
        "the filter-by-field dropdown must list each distinct enum value exactly once, not once per duplicate entry in enumValues",
      );

      const boardToggle = document.querySelectorAll(".view-toggle-btn")[1] as HTMLButtonElement;
      fireEvent.click(boardToggle);
      await waitForCondition(() => document.querySelectorAll(".board-column").length === 2);

      const boardSelect = document.querySelector(".board-card-move") as HTMLSelectElement;
      assert.ok(boardSelect, "expected the Kanban board card's move dropdown to render");
      assert.deepEqual(
        Array.from(boardSelect.options).map((o) => o.value),
        ["new", "won"],
        "the board card's move dropdown must list each distinct enum value exactly once",
      );

      const addButton = document.querySelector(".board-add-card-btn") as HTMLButtonElement;
      assert.ok(addButton, "expected a real add-card button in the column header");
      fireEvent.click(addButton);

      const formSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      assert.deepEqual(
        Array.from(formSelect.options)
          .map((o) => o.value)
          .filter((v) => v !== ""),
        ["new", "won"],
        "the add/edit form's enum <select> must list each distinct enum value exactly once",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the per-entity table search box (the live filter-as-
 * you-type field in the toolbar) now remembers recent queries the same way
 * Global Search/Time Machine/WhatsApp/the home screen's own project search
 * already do -- it was the one search box in the app with zero memory.
 * Exercises the full real wiring (not just entityRecentSearches.ts's own
 * pure-function coverage): typing a query and pressing Enter persists it,
 * the recent-searches chip row only shows while the box is empty, clicking
 * a chip refills the search box, and the per-chip remove button drops just
 * that one entry.
 */
test("EntityPanel's search box remembers a query on Enter, shows it as a chip once the box is empty, and a chip click refills the search", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelector(".entity-toolbar") !== null);

      const searchInput = document.querySelector(".entity-search") as HTMLInputElement;
      assert.equal(document.querySelector(".entity-search-recent"), null, "no recent-searches row before anything's ever been searched");

      fireEvent.change(searchInput, { target: { value: "acme" } });
      assert.equal(
        document.querySelector(".entity-search-recent"),
        null,
        "the chip row must stay hidden while the box still has text in it",
      );

      fireEvent.keyDown(searchInput, { key: "Enter" });
      fireEvent.change(searchInput, { target: { value: "" } });
      await waitForCondition(() => document.querySelector(".entity-search-recent") !== null);

      let chips = Array.from(document.querySelectorAll(".entity-search-recent .chip-text")) as HTMLButtonElement[];
      assert.deepEqual(
        chips.map((c) => c.textContent),
        ["acme"],
        "the committed query must appear as a chip once the box is empty again",
      );

      fireEvent.click(chips[0]);
      assert.equal(searchInput.value, "acme", "clicking the chip must refill the search box with that query");

      fireEvent.change(searchInput, { target: { value: "" } });
      await waitForCondition(() => document.querySelector(".entity-search-recent .chip-remove") !== null);
      fireEvent.click(document.querySelector(".entity-search-recent .chip-remove") as HTMLButtonElement);
      await waitForCondition(() => document.querySelector(".entity-search-recent") === null);

      chips = Array.from(document.querySelectorAll(".entity-search-recent .chip-text")) as HTMLButtonElement[];
      assert.equal(chips.length, 0, "removing the only chip must clear the whole recent-searches row");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the window-level table keydown handler already
 * clears the multi-row selection on Escape (round 356), but it bails out
 * via isTypingTarget the instant the search box has focus -- so Escape
 * typed INTO the search box itself was a dead key, unlike every other
 * free-text input in this panel (the inline cell editor and the add/edit
 * form both already discard on Escape). Escape in the search box now
 * reuses the same setSearch("") the round-355 "Clear search" button
 * already calls -- confirms it empties the box and restores the
 * unfiltered table, and that an Escape with nothing typed is a harmless
 * no-op (never commits a recent search, since only Enter does that).
 */
test("EntityPanel's search box clears itself on Escape, restoring the unfiltered table", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const searchInput = document.querySelector(".entity-search") as HTMLInputElement;

      // Escape with nothing typed must be a harmless no-op.
      fireEvent.keyDown(searchInput, { key: "Escape" });
      assert.equal(searchInput.value, "", "Escape on an already-empty search box must not throw or do anything odd");

      fireEvent.change(searchInput, { target: { value: "Globex" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.keyDown(searchInput, { key: "Escape" });
      assert.equal(searchInput.value, "", "Escape must empty the search box");
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);
      assert.equal(document.querySelector(".entity-search-recent"), null, "Escape must never commit a recent search -- only Enter does that");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a deadline-like date field (name containing "due" or
 * "deadline") now gets a real visual overdue/due-soon indicator in the
 * records table -- the gap round 339's own Explore survey flagged and
 * confirmed absent (no date-field logic anywhere compared a stored date to
 * "today" at all). Uses real offsets from the actual current date (the
 * same style as this file's own isoDateToday helper above), since
 * getDateUrgency's default `today` argument is the real wall-clock date.
 */
test("a date field named like a deadline is visually flagged overdue/due-soon in the records table, but an ordinary date field never is", async () => {
  await withJsdom(async () => {
    function isoDateOffset(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const taskEntity: Entity = {
      name: "Task",
      label: "Task",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "dueDate", label: "Due", type: "date", required: false },
      ],
    };
    const store: EntityRecord[] = [
      { id: 1, title: "Overdue task", dueDate: isoDateOffset(-5) },
      { id: 2, title: "Due soon task", dueDate: isoDateOffset(1) },
      { id: 3, title: "Far future task", dueDate: isoDateOffset(30) },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Task") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: taskEntity, allEntities: [taskEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 3);

      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const overdueRow = rows.find((r) => /Overdue task/.test(r.textContent ?? ""))!;
      const dueSoonRow = rows.find((r) => /Due soon task/.test(r.textContent ?? ""))!;
      const farRow = rows.find((r) => /Far future task/.test(r.textContent ?? ""))!;

      assert.ok(overdueRow.querySelector(".date-overdue"), "a dueDate 5 days in the past must be flagged overdue");
      assert.ok(dueSoonRow.querySelector(".date-due-soon"), "a dueDate due tomorrow must be flagged due-soon");
      assert.equal(farRow.querySelector(".date-overdue"), null, "a dueDate a month out needs no overdue styling");
      assert.equal(farRow.querySelector(".date-due-soon"), null, "a dueDate a month out needs no due-soon styling either");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an ordinary (non-deadline-named) date field in the past is never flagged overdue, even decades back", async () => {
  await withJsdom(async () => {
    function isoDateOffset(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const personEntity: Entity = {
      name: "Person",
      label: "Person",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "dateOfBirth", label: "Born", type: "date", required: false },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, name: "Alice", dateOfBirth: isoDateOffset(-365 * 30) }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Person") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: personEntity, allEntities: [personEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.equal(document.querySelector(".date-overdue"), null, "a birth date decades in the past must never read as 'overdue'");
      assert.equal(document.querySelector(".date-due-soon"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round (342): submitting the add/edit form with a required
 * field left empty previously fell through to the browser's own native
 * HTML5 constraint-validation tooltip -- rendered by the OS/browser in
 * its own locale, not through t(), the one piece of user-facing text in
 * this entire Hebrew-translated form that would show up in English (or
 * whatever the OS language is) regardless of the app's own language
 * setting. The form now has noValidate, and handleSubmit checks required
 * fields itself before ever calling the API, showing a real translated
 * error through the exact same role="status" paragraph every other error
 * already uses.
 */
test("EntityPanel shows a translated required-field error instead of relying on the browser's own native validation tooltip, and never calls the API until it's fixed", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Globex", status: "won" }];
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        postCount += 1;
        const record = { id: 2, ...JSON.parse(init!.body as string) };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      fireEvent.click(submitButton);
      await waitForCondition(() => document.querySelector(".record-form + p.error") !== null);

      const errorEl = document.querySelector(".record-form + p.error") as HTMLElement;
      assert.match(errorEl.textContent ?? "", /Name/, "the error must name the actual missing field, not a generic message");
      assert.equal(errorEl.getAttribute("role"), "status", "must use the same role=status pattern as every other error in this panel");
      assert.equal(postCount, 0, "the API must never be called while a required field is still empty");

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const statusSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      fireEvent.change(nameInput, { target: { value: "Acme Corp" } });
      fireEvent.change(statusSelect, { target: { value: "new" } });
      fireEvent.click(submitButton);
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      assert.equal(postCount, 1, "once every required field is filled in, the real create request must actually fire");
      assert.equal(document.querySelector(".record-form + p.error"), null, "the error must clear once the record is created successfully");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 939: the missingField check above compared the raw value to `""`
 * directly, so a whitespace-only value (e.g. a single space, easy via a
 * stray keystroke or autocomplete) passed it as "filled in" and fell
 * through to the real submit -- rejected server-side with a much less
 * helpful message than this check's own field-specific one (the server's
 * own message either names the raw internal field name verbatim, in an
 * exported app with no translation layer, or gets masked into a generic
 * "check the form" string in the live preview -- either way, a real step
 * down from naming exactly which field is still effectively blank).
 */
test("EntityPanel's required-field check treats a whitespace-only value as blank, not as filled in", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Globex", status: "won" }];
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Deal") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Deal") {
        postCount += 1;
        const record = { id: 2, ...JSON.parse(init!.body as string) };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const statusSelect = document.querySelector(".record-form select") as HTMLSelectElement;
      fireEvent.change(nameInput, { target: { value: "   " } });
      fireEvent.change(statusSelect, { target: { value: "new" } });

      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      fireEvent.click(submitButton);
      await waitForCondition(() => document.querySelector(".record-form + p.error") !== null);

      const errorEl = document.querySelector(".record-form + p.error") as HTMLElement;
      assert.match(errorEl.textContent ?? "", /Name/, "a whitespace-only value must trigger this check's own field-specific message, not slip through to the real submit");
      assert.equal(postCount, 0, "the API must never be called while the required field is still effectively blank");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a longtext field's own <textarea> had no keyboard way
 * to submit the form at all -- a bare Enter there just inserts a newline
 * (unlike every single-line input, where Enter already submits the form
 * natively), and the form's own onKeyDown only handled Escape. Extended
 * that same handler to also call the real form submit (via
 * requestSubmit(), the exact same real submit event path the Save button's
 * own type="submit" click already goes through) on Ctrl+Enter or Cmd+Enter.
 * Confirms both halves: a bare Enter in the textarea must never submit
 * (postCount stays 0), while Ctrl+Enter AND Cmd+Enter each genuinely
 * create a real record through the real API.
 */
test("EntityPanel's record form submits on Ctrl+Enter or Cmd+Enter from a longtext textarea, but a bare Enter there never submits", async () => {
  await withJsdom(async () => {
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "notes", label: "Notes", type: "longtext", required: false },
      ],
    };
    const store: EntityRecord[] = [];
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Lead") {
        postCount += 1;
        const record = { id: postCount, ...JSON.parse(init!.body as string) };
        store.push(record);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: leadEntity, allEntities: [leadEntity] });
      await waitForCondition(() => document.querySelector(".record-form") !== null);

      const nameInput = document.querySelector('.record-form input[type="text"]') as HTMLInputElement;
      const notesTextarea = document.querySelector(".record-form textarea") as HTMLTextAreaElement;

      fireEvent.change(nameInput, { target: { value: "Dana" } });
      fireEvent.keyDown(notesTextarea, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(postCount, 0, "a bare Enter in the longtext textarea must never submit the form");

      fireEvent.keyDown(notesTextarea, { key: "Enter", ctrlKey: true });
      await waitForCondition(() => postCount === 1);
      assert.equal(store[0]?.name, "Dana", "Ctrl+Enter must create the real record through the real API");

      fireEvent.change(nameInput, { target: { value: "Lee" } });
      fireEvent.keyDown(notesTextarea, { key: "Enter", metaKey: true });
      await waitForCondition(() => postCount === 2);
      assert.equal(store[1]?.name, "Lee", "Cmd+Enter (metaKey) must also create a real record through the real API");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 646 regression: the inline table-cell editor's own onKeyDown
 * unconditionally captured every Enter press to commit-and-close, with no
 * exception for longtext -- unlike the full add/edit form just above,
 * which deliberately lets a bare Enter insert a newline in its own
 * longtext textarea and only submits on Ctrl/Cmd+Enter. Double-clicking a
 * Notes/Description cell to add a second line was therefore impossible
 * through the fast inline-edit path: any Enter immediately committed
 * whatever was typed so far and exited edit mode. Confirms both halves
 * for the inline editor specifically: a bare Enter must never commit
 * (and must leave the cell still in edit mode), while Ctrl+Enter commits
 * exactly like it always did.
 */
test("EntityPanel's inline cell editor lets a bare Enter insert a newline in a longtext cell, committing only on Ctrl/Cmd+Enter", async () => {
  await withJsdom(async () => {
    const noteEntity: Entity = {
      name: "Customer",
      label: "Customer",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "notes", label: "Notes", type: "longtext", required: false },
      ],
    };
    const store: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Acme Corp", notes: "Line one" }];
    const originalFetch = globalThis.fetch;
    let patchCount = 0;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Customer") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PATCH" && input === "/api/projects/proj1/entities/Customer/1") {
        patchCount += 1;
        Object.assign(store[0], JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ record: store[0] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: noteEntity, allEntities: [noteEntity] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const notesCell = document.querySelectorAll("table tbody td")[2] as HTMLTableCellElement;
      fireEvent.doubleClick(notesCell);
      const textarea = notesCell.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea, "expected a real textarea inside the inline-edited longtext cell");

      fireEvent.change(textarea, { target: { value: "Line one\nLine two" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(patchCount, 0, "a bare Enter in the inline longtext editor must never commit");
      assert.ok(notesCell.querySelector("textarea"), "the cell must still be in edit mode after a bare Enter");

      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
      await waitForCondition(() => patchCount === 1);
      assert.equal(store[0].notes, "Line one\nLine two", "Ctrl+Enter must commit the real multi-line value through the real API");
      assert.equal(notesCell.querySelector("textarea"), null, "the cell must exit edit mode once Ctrl+Enter commits");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const APPLICANT_ENTITY: Entity = {
  name: "Applicant",
  label: "Applicant",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "resume", label: "Resume", type: "file", required: false },
  ],
};

/**
 * New field type: a "file" field's own add/edit-form control uploads the
 * chosen file through the new upload endpoint (api.ts's uploadRecordFile)
 * the moment it's chosen -- before the form itself is ever submitted --
 * and stores the returned JSON descriptor as the field's value, which the
 * ordinary record-create POST then carries exactly like any other field.
 * Exercises the real wired-up component tree end to end: choosing a file,
 * the upload firing, the "current file" link appearing, and the real
 * create-record request finally carrying that same descriptor.
 */
test("EntityPanel's add form uploads a chosen file for a 'file' field and submits the real record with the returned descriptor", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [];
    let createdBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/abc123.pdf", name: "resume.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant") {
        createdBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        const record = { id: 1, ...createdBody };
        store.push(record as unknown as EntityRecord);
        return new Response(JSON.stringify({ record }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 0);

      const form = document.querySelector("form") as HTMLFormElement;
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      assert.ok(fileInput, "expected a real file input for the 'file' field in the add form");

      const chosenFile = new File(["résumé body"], "resume.pdf", { type: "application/pdf" });
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [chosenFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await waitForCondition(() => form.querySelector(".file-field-current") !== null);
      assert.equal(form.querySelector(".file-field-current a")!.textContent, "resume.pdf");

      const nameInput = form.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Dana" } });
      fireEvent.submit(form);
      await waitForCondition(() => createdBody !== null);

      assert.equal(createdBody!.name, "Dana");
      assert.deepEqual(
        JSON.parse(createdBody!.resume as string),
        { url: "/api/uploads/proj1/Applicant/abc123.pdf", name: "resume.pdf", size: 9, mimeType: "application/pdf" },
        "the record create request must carry the exact descriptor the upload endpoint returned, as a JSON string",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1002: a real bug found by the survey -- deleteReplacedFileFields
 * (round 685) only ever diffs a record write against its own already-
 * persisted DB row, so it can never reach a file uploaded through the
 * create form's own FieldInput before the record is ever saved. Replacing
 * the chosen file (upload #2 superseding upload #1), or removing it
 * outright, left upload #1 sitting on disk forever. Confirms both paths
 * now fire a real DELETE against the superseded file's own URL, and that a
 * genuinely new (not-yet-replaced) upload never does.
 */
test("EntityPanel's create form deletes a superseded file upload from disk when replaced or removed, but not on the very first upload", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [];
    const deleteCalls: Array<{ url: string }> = [];
    let uploadCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        uploadCalls += 1;
        const descriptor =
          uploadCalls === 1
            ? { url: "/api/uploads/proj1/Applicant/first.pdf", name: "first.pdf", size: 9, mimeType: "application/pdf" }
            : { url: "/api/uploads/proj1/Applicant/second.pdf", name: "second.pdf", size: 9, mimeType: "application/pdf" };
        return new Response(JSON.stringify({ file: descriptor }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls.push({ url: (JSON.parse(init!.body as string) as { url: string }).url });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 0);

      const form = document.querySelector("form") as HTMLFormElement;
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;

      const firstFile = new File(["one"], "first.pdf", { type: "application/pdf" });
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [firstFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "first.pdf");
      assert.equal(deleteCalls.length, 0, "the very first upload must never trigger a delete -- there is nothing to supersede yet");

      const secondFile = new File(["two"], "second.pdf", { type: "application/pdf" });
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [secondFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "second.pdf");
      await waitForCondition(() => deleteCalls.length === 1);
      assert.equal(deleteCalls[0]!.url, "/api/uploads/proj1/Applicant/first.pdf", "replacing a chosen file must delete the one it superseded");

      fireEvent.click(form.querySelector(".file-field-current .link-button") as HTMLButtonElement);
      await waitForCondition(() => deleteCalls.length === 2);
      assert.equal(deleteCalls[1]!.url, "/api/uploads/proj1/Applicant/second.pdf", "removing the chosen file must also delete it from disk");
      assert.equal(form.querySelector(".file-field-current"), null, "the Remove button must still clear the field's own value as before");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1002: the fix is deliberately scoped to the create form only --
 * once a record is persisted, its file field's value is the record's REAL
 * data, already owned by deleteReplacedFieldFields (round 685) once the
 * edit is actually saved. Confirms replacing or removing a file mid-edit,
 * before ever submitting, does NOT eagerly delete the record's still-live
 * file out from under it.
 */
test("EntityPanel's edit form never deletes a file upload from disk just from replacing or removing the picker's selection, before the edit is even saved", async () => {
  await withJsdom(async () => {
    const existingDescriptor = { url: "/api/uploads/proj1/Applicant/original.pdf", name: "original.pdf", size: 9, mimeType: "application/pdf" };
    const store: EntityRecord[] = [{ id: 1, name: "Dana", resume: JSON.stringify(existingDescriptor) }];
    let deleteCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/replacement.pdf", name: "replacement.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const form = document.querySelector(".record-form") as HTMLFormElement;
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "original.pdf");

      const replacementFile = new File(["two"], "replacement.pdf", { type: "application/pdf" });
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [replacementFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "replacement.pdf");

      fireEvent.click(form.querySelector(".file-field-current .link-button") as HTMLButtonElement);
      await waitForCondition(() => form.querySelector(".file-field-current") === null);

      assert.equal(deleteCalls, 0, "an edit-form replace/remove, before the edit is ever saved, must never delete a file from disk");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1004: the follow-on round 1002's own closing entry explicitly
 * left open -- "the riskier edit-form replacement case ... is left for a
 * future round." Replacing a file mid-edit (confirmed a no-op above,
 * correctly, while the edit is still in progress) but then ABANDONING the
 * edit instead of saving it -- via Cancel, Escape, or jumping straight to
 * a different record/create -- left the replacement upload sitting on
 * disk forever: deleteReplacedFileFields (server side) only ever runs on
 * an actual save, and an abandoned edit never sends one. Confirms Cancel
 * deletes the abandoned replacement, while the record's own ORIGINAL file
 * (never touched by this edit) is never deleted.
 */
test("EntityPanel's edit form deletes an abandoned file replacement from disk when the edit is cancelled, without ever touching the record's own original file", async () => {
  await withJsdom(async () => {
    const existingDescriptor = { url: "/api/uploads/proj1/Applicant/original.pdf", name: "original.pdf", size: 9, mimeType: "application/pdf" };
    const store: EntityRecord[] = [{ id: 1, name: "Dana", resume: JSON.stringify(existingDescriptor) }];
    const deleteCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/replacement.pdf", name: "replacement.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls.push((JSON.parse(init!.body as string) as { url: string }).url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const form = document.querySelector(".record-form") as HTMLFormElement;
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "original.pdf");

      const replacementFile = new File(["two"], "replacement.pdf", { type: "application/pdf" });
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [replacementFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "replacement.pdf");
      assert.equal(deleteCalls.length, 0, "picking the replacement must not delete anything yet -- the edit is still in progress");

      const cancelButton = Array.from(form.querySelectorAll("button[type=button]")).find((b) => /cancel/i.test(b.textContent ?? "")) as HTMLButtonElement;
      fireEvent.click(cancelButton);

      await waitForCondition(() => deleteCalls.length === 1);
      assert.equal(deleteCalls[0], "/api/uploads/proj1/Applicant/replacement.pdf", "cancelling must delete the abandoned, never-saved replacement");
      assert.ok(!deleteCalls.includes("/api/uploads/proj1/Applicant/original.pdf"), "cancelling must never delete the record's own real, still-live original file");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Round 1004: the Escape-key counterpart of the Cancel test just above -- EntityPanel's own Escape handler explicitly mirrors the Cancel button's own reset logic. */
test("EntityPanel's edit form deletes an abandoned file replacement from disk when the edit is discarded via Escape", async () => {
  await withJsdom(async () => {
    const existingDescriptor = { url: "/api/uploads/proj1/Applicant/original.pdf", name: "original.pdf", size: 9, mimeType: "application/pdf" };
    const store: EntityRecord[] = [{ id: 1, name: "Dana", resume: JSON.stringify(existingDescriptor) }];
    const deleteCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/replacement.pdf", name: "replacement.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls.push((JSON.parse(init!.body as string) as { url: string }).url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const form = document.querySelector(".record-form") as HTMLFormElement;
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "original.pdf");

      const replacementFile = new File(["two"], "replacement.pdf", { type: "application/pdf" });
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [replacementFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "replacement.pdf");

      fireEvent.keyDown(form, { key: "Escape" });

      await waitForCondition(() => deleteCalls.length === 1);
      assert.equal(deleteCalls[0], "/api/uploads/proj1/Applicant/replacement.pdf", "Escape must delete the abandoned, never-saved replacement");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1016: the in-form Delete button resets the exact same state as
 * Cancel/Escape above (setForm(emptyForm), setEditingId(null),
 * editingOriginalRef.current = null) through an almost identical onClick --
 * but, unlike those two, never called discardAbandonedFileUploads() first.
 * Deleting the record outright is just as much an abandonment of this
 * edit's own unsaved replacement upload as Cancel/Escape are: the server's
 * DELETE route only ever cleans up files off the record's last PERSISTED
 * snapshot (deleteReplacedFileFields in routes/projects.ts), with no idea
 * a newer file was uploaded but never saved. Confirms clicking Delete also
 * cleans up the abandoned replacement, on top of the record itself being
 * removed.
 */
test("EntityPanel's edit form deletes an abandoned file replacement from disk when the record itself is deleted mid-edit via the form's own Delete button", async (t) => {
  await withJsdom(async () => {
    const existingDescriptor = { url: "/api/uploads/proj1/Applicant/original.pdf", name: "original.pdf", size: 9, mimeType: "application/pdf" };
    const store: EntityRecord[] = [{ id: 1, name: "Dana", resume: JSON.stringify(existingDescriptor) }];
    const deleteCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/replacement.pdf", name: "replacement.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls.push((JSON.parse(init!.body as string) as { url: string }).url);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/1") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const form = document.querySelector(".record-form") as HTMLFormElement;
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "original.pdf");

      const replacementFile = new File(["two"], "replacement.pdf", { type: "application/pdf" });
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [replacementFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "replacement.pdf");
      assert.equal(deleteCalls.length, 0, "picking the replacement must not delete anything yet -- the edit is still in progress");

      // The record-delete's own undo window (5s of real time) has nothing
      // to do with this test's own assertion -- discardAbandonedFileUploads
      // fires synchronously inside the button's onClick, before any timer
      // -- but faking it, only now (never before a `waitForCondition` that
      // still needs real timers to resolve, per this file's own established
      // convention), keeps a real 5-second timer from ever being scheduled
      // against this test's own jsdom teardown.
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const deleteButton = Array.from(form.querySelectorAll("button[type=button]")).find((b) => /^delete$/i.test(b.textContent ?? "")) as HTMLButtonElement;
      fireEvent.click(deleteButton);

      assert.equal(deleteCalls.length, 1, "deleting the record itself must also delete its own abandoned, never-saved replacement upload");
      assert.equal(deleteCalls[0], "/api/uploads/proj1/Applicant/replacement.pdf");
      assert.ok(!deleteCalls.includes("/api/uploads/proj1/Applicant/original.pdf"), "deleting must never try to clean up the record's own real original file on the client side -- that's the server's own job");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 1036: switching to a different entity tab, or navigating Home,
 * fully unmounts EntityPanel (App.tsx keys it by entity.name -- the same
 * fact the round-1004 pendingDelete-flush unmount effect already relies
 * on). Cancel/Escape/starting a different edit/the in-form Delete button
 * all already call discardAbandonedFileUploads() before this round, but
 * none of them fire on a plain unmount -- so picking a replacement file
 * mid-edit and then simply navigating away (the single most ordinary way
 * to abandon an edit) left it orphaned on disk forever. Confirms unmount
 * now cleans it up too.
 */
test("EntityPanel deletes an abandoned file replacement from disk when the component unmounts mid-edit (switching entity tabs or navigating Home)", async () => {
  await withJsdom(async () => {
    const existingDescriptor = { url: "/api/uploads/proj1/Applicant/original.pdf", name: "original.pdf", size: 9, mimeType: "application/pdf" };
    const store: EntityRecord[] = [{ id: 1, name: "Dana", resume: JSON.stringify(existingDescriptor) }];
    const deleteCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/replacement.pdf", name: "replacement.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls.push((JSON.parse(init!.body as string) as { url: string }).url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      const view = renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const form = document.querySelector(".record-form") as HTMLFormElement;
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "original.pdf");

      const replacementFile = new File(["two"], "replacement.pdf", { type: "application/pdf" });
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [replacementFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "replacement.pdf");
      assert.equal(deleteCalls.length, 0, "picking the replacement must not delete anything yet -- the edit is still in progress");

      view.unmount();

      assert.deepEqual(deleteCalls, ["/api/uploads/proj1/Applicant/replacement.pdf"], "unmounting mid-edit must delete the abandoned, never-saved replacement, the same as Cancel/Escape/Delete already do");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1017: round 1016's own fix (just above) only closed the edit form
 * when the record is deleted through the form's OWN "Delete" button --
 * handleDelete is a single shared function also called by the table row's
 * own Delete button, the Delete/Backspace keyboard shortcut, and board-card
 * delete, none of which the in-form button's own close-on-success handling
 * ever runs for. Before this round, deleting the record currently open in
 * the edit form via any of THOSE entry points left the form fully open and
 * editable on a row that had just visually vanished from the table -- a
 * later Save would PATCH a record that's either already gone server-side
 * (once the undo window elapses) or, worse, would succeed invisibly during
 * the still-open undo window (refresh() filters out a pending-delete id)
 * only to be silently discarded the moment the undo window elapses or the
 * user clicks the delete toast's own Undo (which splices back the PRE-
 * delete snapshot, not the save). Confirms the keyboard-shortcut delete
 * path (handleDelete, the exact same function the table row's own button
 * calls) now closes the edit form the instant it deletes the record
 * currently open in it -- the submit button reverts from "Save" back to
 * "Add", proving editingId was reset, not just that the row disappeared.
 */
test("EntityPanel closes the edit form when the record it has open is deleted via the table row's own delete path (not the in-form button). ", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Acme Corp");
      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      assert.equal(submitButton.textContent, "Save", "sanity check: the form must actually be in edit mode for record 1 before deleting it");

      // Focus the SAME row (id 1) the form is editing, then delete it via
      // the keyboard shortcut -- handleDelete, not the in-form button.
      for (let attempt = 0; document.querySelectorAll(".record-row-focused").length === 0 && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "j" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal((document.querySelector(".record-row-focused") as HTMLElement).getAttribute("data-record-id"), "1");
      fireEvent.keyDown(window, { key: "Delete" });

      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);
      assert.equal(
        (document.querySelector(".record-form button[type=submit]") as HTMLButtonElement).textContent,
        "Add",
        "deleting the record this form has open must close the form (editingId reset), not leave it open on a vanished row",
      );
      assert.equal((document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement).value, "", "the form must also reset to blank, not keep showing the deleted record's stale values");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/** Round 1017: the handleBulkDelete counterpart of the test just above -- a bulk selection can just as easily include the record the edit form currently has open as a single delete can. */
test("EntityPanel closes the edit form when the record it has open is included in a bulk delete", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Acme Corp", status: "new" },
      { id: 2, name: "Globex", status: "won" },
    ];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.window.confirm;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    globalThis.window.confirm = (() => true) as typeof window.confirm;
    try {
      renderEntityPanel();
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Acme Corp");

      for (const checkbox of document.querySelectorAll('td.select-col input[type="checkbox"]')) {
        fireEvent.click(checkbox);
      }
      await waitForCondition(() => document.querySelector(".bulk-actions-bar") !== null);
      fireEvent.click(document.querySelector(".bulk-actions-bar .danger") as HTMLButtonElement);

      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 0);
      assert.equal(
        (document.querySelector(".record-form button[type=submit]") as HTMLButtonElement).textContent,
        "Add",
        "bulk-deleting a selection that includes the record this form has open must close the form",
      );
      assert.equal((document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement).value, "", "the form must also reset to blank");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window.confirm = originalConfirm;
    }
  });
});

/**
 * Round 1004: the "jump straight to a different record without saving or
 * cancelling first" abandonment path -- startEdit's own new cleanup call,
 * distinct from both the explicit Cancel button and Escape.
 */
test("EntityPanel's edit form deletes an abandoned file replacement from disk when the user clicks Edit on a DIFFERENT record instead of saving or cancelling", async () => {
  await withJsdom(async () => {
    const dana = { url: "/api/uploads/proj1/Applicant/original.pdf", name: "original.pdf", size: 9, mimeType: "application/pdf" };
    const store: EntityRecord[] = [
      { id: 1, name: "Dana", resume: JSON.stringify(dana) },
      { id: 2, name: "Yossi", resume: null },
    ];
    const deleteCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/replacement.pdf", name: "replacement.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        deleteCalls.push((JSON.parse(init!.body as string) as { url: string }).url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      // .row-actions holds several buttons per row (Edit, Duplicate,
      // Print, Delete) -- find each row's own "Edit" button by text,
      // rather than assuming one button per row.
      function editButtonForRow(rowIndex: number): HTMLButtonElement {
        const row = document.querySelectorAll("table tbody tr")[rowIndex] as HTMLElement;
        return Array.from(row.querySelectorAll(".row-actions button")).find((b) => /^edit$/i.test(b.textContent ?? "")) as HTMLButtonElement;
      }

      fireEvent.click(editButtonForRow(0));
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Dana");

      const form = document.querySelector(".record-form") as HTMLFormElement;
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "original.pdf");

      const replacementFile = new File(["two"], "replacement.pdf", { type: "application/pdf" });
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [replacementFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector(".file-field-current a")?.textContent === "replacement.pdf");

      // Click Edit on Yossi (the SECOND row) instead of saving or
      // cancelling Dana's own in-progress edit.
      fireEvent.click(editButtonForRow(1));
      await waitForCondition(() => (document.querySelector(".record-form input[type=\"text\"]") as HTMLInputElement)?.value === "Yossi");

      await waitForCondition(() => deleteCalls.length === 1);
      assert.equal(deleteCalls[0], "/api/uploads/proj1/Applicant/replacement.pdf", "switching to a different record must delete the abandoned replacement from the one left behind");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 688: a real bug found by the survey -- every other field type's
 * own FieldInput control validates before ever reaching the network
 * (required, a number's own native constraint), but "file" always fired
 * a real upload POST immediately on selection with zero size check, only
 * learning a file was too large from the server's own 10 MB rejection
 * after the whole multipart body had already been sent. Confirms an
 * oversized file is rejected with NO fetch call at all (the exact
 * regression this fix exists to prevent), while a within-budget file
 * still uploads normally right after -- not just "the error shows", but
 * that the happy path survives the new check too.
 */
test("EntityPanel's file field rejects an oversized file before ever uploading it, but still uploads a file within the 10MB limit", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [];
    let uploadCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && input === "/api/projects/proj1/entities/Applicant/fields/resume/upload") {
        uploadCalls += 1;
        return new Response(
          JSON.stringify({ file: { url: "/api/uploads/proj1/Applicant/abc123.pdf", name: "resume.pdf", size: 9, mimeType: "application/pdf" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 0);

      const form = document.querySelector("form") as HTMLFormElement;
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;

      // jsdom's real File doesn't compute .size from its content array for
      // a huge buffer efficiently, but File's own "size" property can be
      // overridden directly -- this is the exact property the fix reads,
      // so overriding it is a real test of that check, not a shortcut
      // around it.
      const oversizedFile = new File(["small body"], "huge.pdf", { type: "application/pdf" });
      Object.defineProperty(oversizedFile, "size", { value: 11 * 1024 * 1024 });

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [oversizedFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await waitForCondition(() => form.querySelector('[role="alert"]') !== null);
      assert.match(form.querySelector('[role="alert"]')!.textContent ?? "", /too large/i);
      assert.equal(uploadCalls, 0, "an oversized file must never fire a real upload request at all");
      assert.equal(form.querySelector(".file-field-current"), null, "no file must have been accepted");

      const withinBudgetFile = new File(["résumé body"], "resume.pdf", { type: "application/pdf" });
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [withinBudgetFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await waitForCondition(() => form.querySelector(".file-field-current") !== null);
      assert.equal(uploadCalls, 1, "a file within the limit must still upload normally right after a rejected one");
      assert.equal(form.querySelector('[role="alert"]'), null, "the earlier error must clear once a valid file is chosen");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: FieldInput's fileUploadError is its own component-
 * local state, never reset by startEdit/startCreateNew/handleSubmit's
 * success path -- those only ever touch EntityPanel's own form/editingId
 * state, not whatever's inside the FieldInput instance already mounted
 * for a field. Since the record form keys FieldInput only by field.name
 * (unchanged across edit targets), the exact same instance -- and its
 * stale error -- used to survive switching from the blank create form
 * (where this error was triggered) to editing a completely unrelated
 * record. Confirms the error no longer bleeds across that switch.
 */
test("EntityPanel's file field upload error from the create form does not bleed into the edit form for an unrelated record", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Dana", resume: null }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET" && input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${method} ${input}`);
    }) as typeof fetch;

    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const form = document.querySelector("form") as HTMLFormElement;
      const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
      const oversizedFile = new File(["small body"], "huge.pdf", { type: "application/pdf" });
      Object.defineProperty(oversizedFile, "size", { value: 11 * 1024 * 1024 });

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [oversizedFile], configurable: true });
        fireEvent.change(fileInput);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitForCondition(() => form.querySelector('[role="alert"]') !== null);

      fireEvent.click(document.querySelector(".row-actions button") as HTMLButtonElement);
      await waitForCondition(() => (document.querySelector('.record-form input[type="text"]') as HTMLInputElement)?.value === "Dana");

      assert.equal(
        document.querySelector('.record-form [role="alert"]'),
        null,
        "a file-too-large error from the create form must never show up for an unrelated record's own edit form",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The table-cell side of the same field type: an existing record's file
 * value (the JSON descriptor the upload endpoint produces) renders as a
 * real clickable link to that file's URL, showing the file's own name as
 * its text -- not the raw JSON blob, which is what String(value) would
 * otherwise show for any field type with no dedicated Cell branch.
 */
test("EntityPanel's table cell renders a 'file' field's stored descriptor as a real link to the file, not the raw JSON", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Dana", resume: JSON.stringify({ url: "/api/uploads/proj1/Applicant/abc123.pdf", name: "resume.pdf", size: 9, mimeType: "application/pdf" }) },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const link = document.querySelector("table tbody a.file-cell-link") as HTMLAnchorElement;
      assert.ok(link, "expected a real link for the file field's cell");
      assert.equal(link.getAttribute("href"), "/api/uploads/proj1/Applicant/abc123.pdf");
      assert.equal(link.textContent, "resume.pdf");
      assert.equal(link.getAttribute("target"), "_blank");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 699: matchesSearch's own "file" branch (just added the prior
 * round) matches a record into the filtered table by its attachment's
 * filename -- but the Cell branch that renders that exact filename never
 * wrapped it in Highlighted, unlike every other field type whose
 * displayed text is also what matchesSearch matched (enum/longtext/the
 * generic text fallback, confirmed via the test right above this one's
 * own sibling coverage). A record could show up in a filtered table
 * precisely because its file's name matched the search, with no visual
 * indication anywhere of why.
 */
test("EntityPanel's search box highlights the matched substring within a 'file' field's own filename, not just text/enum fields", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [
      { id: 1, name: "Dana", resume: JSON.stringify({ url: "/api/uploads/proj1/Applicant/abc123.pdf", name: "resume_march.pdf", size: 9, mimeType: "application/pdf" }) },
      { id: 2, name: "Yossi", resume: JSON.stringify({ url: "/api/uploads/proj1/Applicant/def456.pdf", name: "cv_final.pdf", size: 9, mimeType: "application/pdf" }) },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/entities/Applicant") {
        return new Response(JSON.stringify({ records: store }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderEntityPanel({ entity: APPLICANT_ENTITY, allEntities: [APPLICANT_ENTITY] });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 2);

      const searchBox = document.querySelector(".entity-search") as HTMLInputElement;
      fireEvent.change(searchBox, { target: { value: "march" } });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      const mark = document.querySelector(".file-cell-name mark.search-match");
      assert.ok(mark, "the matched substring within the filename must be wrapped in a real <mark class=\"search-match\">");
      assert.equal(mark!.textContent, "march", "the highlighted text must be exactly the matched substring");
      assert.equal(document.querySelector("a.file-cell-link")!.textContent, "resume_march.pdf", "the rest of the filename must still render around the highlight");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Real role enforcement (RBAC), the UI-layer reflection of it: a "viewer"
 * collaborator passes readOnly=true into EntityPanel. The server already
 * rejects every write with 403 VIEWER_READ_ONLY (see app.test.ts); this
 * confirms the UI never offers a control that can only ever fail --
 * the add/edit record form, the per-row edit/delete buttons, and the
 * bulk-selection checkboxes (which would otherwise surface a bulk-actions
 * bar made entirely of writes) are all gone, while the table itself (a
 * pure read) still renders normally.
 */
test("EntityPanel with readOnly=true hides the record form and row edit/delete buttons, and disables bulk selection, while still rendering the table", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Deal", amount: 100, status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ readOnly: true });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(document.querySelector("form.record-form"), null, "a viewer must never see the add/edit record form");
      // Print is a pure read (and deliberately still offered), so the
      // row-actions cell isn't empty -- it just has exactly that one
      // button left, instead of also Edit/Duplicate/Delete.
      const rowActionButtons = document.querySelectorAll("table tbody td.row-actions button");
      assert.equal(rowActionButtons.length, 1, "a viewer's row-actions cell must keep only the read-only Print button");

      const selectAll = document.querySelector("th.select-col input") as HTMLInputElement | null;
      const rowCheckbox = document.querySelector("td.select-col input") as HTMLInputElement | null;
      assert.ok(rowCheckbox?.disabled, "a viewer's row-selection checkbox must be disabled, since there is nothing a bulk action could do");
      assert.ok(selectAll?.disabled, "a viewer's select-all checkbox must be disabled too");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 695: startInlineEdit itself already refuses to start an edit for a
 * read-only viewer (readOnly || !isInlineEditableField(field)), but the
 * cell's own rendering computed `editable` from isInlineEditableField alone
 * -- so a viewer still got the "cell-inline-editable" hover/cursor styling
 * and the "Double-click to edit quickly" tooltip on every ordinary cell,
 * and double-clicking one silently did nothing, with zero feedback as to
 * why. Every other read-only affordance in this file (the row checkbox
 * above, BoardCard's drag/Edit/Delete, the bulk-actions bar) gates the
 * control's own look, not just its callback -- this was the one place that
 * only gated the callback.
 */
test("EntityPanel never shows the inline-edit hover styling or tooltip on a table cell when readOnly=true, even for a field type that's normally inline-editable", async () => {
  await withJsdom(async () => {
    const store: EntityRecord[] = [{ id: 1, name: "Acme Deal", amount: 100, status: "new" }];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockRecordsFetch(store) as typeof fetch;
    try {
      renderEntityPanel({ readOnly: true });
      await waitForCondition(() => document.querySelectorAll("table tbody tr").length === 1);

      assert.equal(
        document.querySelectorAll("table tbody td.cell-inline-editable").length,
        0,
        "a read-only viewer must never see the inline-editable cursor/hover styling on any cell",
      );
      const nameCell = Array.from(document.querySelectorAll("table tbody td")).find((td) => td.textContent === "Acme Deal")!;
      assert.equal(nameCell.getAttribute("title"), null, "a read-only viewer must never see the 'Double-click to edit quickly' tooltip");
      assert.equal(document.querySelector(".cell-editing"), null, "double-clicking must never actually enter edit mode for a read-only viewer");
      fireEvent.doubleClick(nameCell);
      assert.equal(document.querySelector(".cell-editing"), null, "double-clicking a read-only cell must still do nothing after the click");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
