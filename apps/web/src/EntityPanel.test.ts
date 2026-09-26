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

test("EntityPanel's handleBulkDelete refreshes and keeps only the ids that actually failed selected, instead of Promise.all's all-or-nothing hiding the deletes that succeeded", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDelete\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleBulkDelete in EntityPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  let capturedSelectedIds: Set<number> | undefined;
  let refreshCalled = 0;
  const attemptedIds: number[] = [];

  const fn = new Function(
    "window",
    "t",
    "projectId",
    "entity",
    "selectedIds",
    "setError",
    "deleteRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDelete;`,
  )(
    { confirm: () => true },
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    "proj1",
    { name: "Customer" },
    new Set([1, 2, 3]),
    (msg: string | null) => {
      capturedError = msg ?? undefined;
    },
    async (_projectId: string, _entityName: string, id: number) => {
      attemptedIds.push(id);
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
    attemptedIds.slice().sort(),
    [1, 2, 3],
    "must attempt every selected id, not stop at the first failure",
  );
  assert.deepEqual(
    [...capturedSelectedIds!].sort(),
    [2],
    "only the id that actually failed should remain selected -- the two that succeeded must be cleared",
  );
  assert.match(
    capturedError!,
    /entity\.bulk\.partialFailure/,
    "a partial failure must surface the translated partial-failure message, not the raw single-record rejection",
  );
  assert.equal(
    refreshCalled,
    1,
    "refresh() must still run so the table reflects the records that WERE successfully deleted, even on a partial failure",
  );
});

test("EntityPanel's handleBulkDelete still surfaces the raw error message when every delete in the batch fails", async () => {
  const handlerMatch = entityPanelSrc.match(/ {2}async function handleBulkDelete\(\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  let capturedError: string | undefined;
  const rejection = new Error("network error");
  const fn = new Function(
    "window",
    "t",
    "projectId",
    "entity",
    "selectedIds",
    "setError",
    "deleteRecord",
    "setSelectedIds",
    "refresh",
    `${code}\nreturn handleBulkDelete;`,
  )(
    { confirm: () => true },
    (key: string) => key,
    "proj1",
    { name: "Customer" },
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
    "setError",
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
