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
import { getGroupByField } from "./groupByPreference.js";
import { getCollapsedGroups } from "./collapsedGroupsPreference.js";
import { getViewMode } from "./viewModePreference.js";
import { getSortKeys } from "./sortKeysPreference.js";
import { getFieldFilters } from "./fieldFiltersPreference.js";
import { EntityPanel } from "./EntityPanel.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

const entityPanelSrc = readFileSync(new URL("./EntityPanel.tsx", import.meta.url), "utf8");

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

test("EntityPanel's handleBulkDuplicate still surfaces the raw error message when every duplicate in the batch fails", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDuplicate\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  const rejection = new Error("network error");
  const entity: Entity = { name: "Customer", fields: [{ name: "name", type: "text", required: true }] };
  const records: EntityRecord[] = [{ id: 1, createdAt: "x", name: "Alice" }];

  const fn = new Function(
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
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkUpdate in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  let capturedSelectedIds: Set<number> | undefined;
  let refreshCalled = 0;
  const attemptedUpdates: { id: number; patch: Record<string, unknown> }[] = [];

  const fn = new Function(
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
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "proj1",
    { name: "Order" },
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
});

test("EntityPanel's handleBulkUpdate does nothing when no field has been chosen yet", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkUpdate\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let updateCalled = false;
  let refreshCalled = false;
  const fn = new Function(
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

function renderAppointmentPanel() {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(EntityPanel, {
          projectId: "proj1",
          entity: APPOINTMENT_ENTITY,
          allEntities: [APPOINTMENT_ENTITY],
          onEntityRenamed: () => {},
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

      const nextBtn = document.querySelectorAll(".calendar-nav button")[2] as HTMLButtonElement;
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

      const nextBtn = document.querySelectorAll(".calendar-nav button")[2] as HTMLButtonElement;
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

      const submitButton = document.querySelector(".record-form button[type=submit]") as HTMLButtonElement;
      const addLabel = submitButton.textContent;
      const nameInput = document.querySelector(".record-form input[type=text]") as HTMLInputElement;

      // Open Globex (id 2) for editing via its row's own Edit button, so
      // the form is genuinely mid-edit -- not just coincidentally blank
      // already -- before "n" is pressed.
      const editButtons = Array.from(document.querySelectorAll("table tbody button")) as HTMLButtonElement[];
      const globexEdit = editButtons.find((b) => b.closest("tr")?.getAttribute("data-record-id") === "2" && /edit/i.test(b.textContent ?? ""));
      assert.ok(globexEdit, "expected an Edit button on the Globex row");
      fireEvent.click(globexEdit!);
      await waitForCondition(() => nameInput.value === "Globex");

      // "n" must abandon that edit: the form resets to blank, the submit
      // button reverts to its "add" label, and the first field (the name
      // text input) ends up focused -- all without any mouse click.
      for (let attempt = 0; nameInput.value !== "" && attempt < 40; attempt++) {
        fireEvent.keyDown(window, { key: "n" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(nameInput.value, "", "'n' must reset the form back to blank, discarding the in-progress edit");
      assert.equal(submitButton.textContent, addLabel, "'n' must flip the submit button back to its add-record label");
      assert.equal(document.activeElement, nameInput, "'n' must focus the form's first field");

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
        getCollapsedGroups("proj1", "Deal"),
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
 * New in this round: a real bug in FieldInput's number input, found by a
 * fresh Explore survey. `<input type="number">` with no `step` attribute
 * defaults to the HTML5 spec's `step="1"` -- typing a perfectly normal
 * decimal value into a price/amount field (this is a Hebrew CRM/ops tool;
 * "number" fields are overwhelmingly money) fails native browser
 * constraint validation on submit, silently blocking the form's own
 * `onSubmit` from ever firing, with zero error shown anywhere in the app.
 * jsdom (this test harness) doesn't actually implement stepMismatch
 * validation at all (confirmed empirically -- `validity.stepMismatch` is
 * always `false` here regardless of `step`), so this can only assert the
 * real rendered attribute, not the blocked-submit behavior itself; the
 * true behavioral proof is the live Playwright pass for this round. A
 * relation field's raw fallback number input (no related entity loaded)
 * must NOT get `step="any"` -- a foreign-key id is always an integer, and
 * the default step of 1 there is correct, not a bug.
 */
test("EntityPanel's number field input has step=\"any\" so a decimal value like a price won't fail native browser validation, but a relation field's fallback number input keeps the default integer step", async () => {
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
      // input path (the same one the "number" type itself uses).
      renderEntityPanel({ entity: invoiceEntity, allEntities: [invoiceEntity] });
      await waitForCondition(() => document.querySelectorAll(".record-form input").length > 0);

      const numberInputs = document.querySelectorAll('.record-form input[type="number"]');
      assert.equal(numberInputs.length, 2, "expected exactly one number input (amount) and one relation-fallback number input (courierId)");
      assert.equal(numberInputs[0].getAttribute("step"), "any", "the real 'number' field's input must carry step=\"any\" so a decimal like a price doesn't fail native validation");
      assert.equal(numberInputs[1].getAttribute("step"), null, "a relation field's fallback number input must NOT get step=\"any\" -- a foreign-key id is always an integer");
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

      const numberInput = document.querySelector('.record-form input[type="number"]') as HTMLInputElement;
      assert.equal(numberInput.required, true, "a required number field's real input must carry the required attribute");
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
