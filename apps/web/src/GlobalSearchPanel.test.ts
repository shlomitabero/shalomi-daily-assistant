import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Entity, EntityRecord } from "@forge/shared";
import { GlobalSearchPanel } from "./GlobalSearchPanel.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

const globalSearchPanelSrc = readFileSync(new URL("./GlobalSearchPanel.tsx", import.meta.url), "utf8");

/**
 * Regression test: runSearch used to await a bare
 * Promise.all(entities.map(...)) -- one entity whose records failed to
 * load (a transient network blip, a cold-starting backend) rejected the
 * WHOLE search, blanking out results from every OTHER entity that
 * searched fine. A user with, say, 9 working entity tables and 1 flaky
 * one got a bare error message instead of the 9 entities' worth of
 * results they could otherwise see. Extracts the real runSearch from
 * GlobalSearchPanel.tsx, strips its TypeScript with esbuild, and runs it
 * with a mock listRecords that fails for exactly one of three entities.
 */
test("GlobalSearchPanel's runSearch shows results from every entity that succeeded, instead of Promise.all's all-or-nothing blanking everything on one entity's failure", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function runSearch\(q: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find runSearch in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [{ name: "name", label: "Name", type: "text" }] };
  const entityB = { name: "Beta", label: "Beta", fields: [{ name: "name", label: "Name", type: "text" }] };
  const entityC = { name: "Gamma", label: "Gamma", fields: [{ name: "name", label: "Name", type: "text" }] };
  const rejection = new Error("network error");

  function fakeSearchEntityRecords(entity: { name: string; label: string }, records: unknown[]) {
    return { entityName: entity.name, entityLabel: entity.label, totalMatches: records.length, sample: records };
  }

  let capturedResults: unknown[] | undefined;
  let capturedError: string | undefined;

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "t",
    "setLoading",
    "setError",
    "setResults",
    "setSearched",
    "setHighlightQuery",
    "setSelectedIndex",
    "searchRequestId",
    `${code}\nreturn runSearch;`,
  )(
    [entityA, entityB, entityC],
    "proj1",
    async (_projectId: string, entityName: string) => {
      if (entityName === "Beta") throw rejection;
      return { records: [{ id: 1, name: `match-${entityName}` }] };
    },
    fakeSearchEntityRecords,
    (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    () => {},
    (msg: string) => {
      capturedError = msg;
    },
    (results: unknown[]) => {
      capturedResults = results;
    },
    () => {},
    () => {},
    () => {},
    { current: 0 },
  ) as (q: string) => Promise<void>;

  await fn("match");

  assert.deepEqual(
    (capturedResults ?? []).map((r) => (r as { entityName: string }).entityName),
    ["Alpha", "Gamma"],
    "must still show results from the entities that searched successfully",
  );
  assert.match(
    capturedError!,
    /search\.partialFailure/,
    "a partial failure must use the translated partial-failure message, not the raw single-entity rejection",
  );
});

test("GlobalSearchPanel's runSearch still surfaces the raw error message when every entity fails", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function runSearch\(q: string\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [] };
  const rejection = new Error("network error");
  let capturedError: string | undefined;

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "t",
    "setLoading",
    "setError",
    "setResults",
    "setSearched",
    "setHighlightQuery",
    "setSelectedIndex",
    "searchRequestId",
    `${code}\nreturn runSearch;`,
  )(
    [entityA],
    "proj1",
    async () => {
      throw rejection;
    },
    () => null,
    (key: string) => key,
    () => {},
    (msg: string) => {
      capturedError = msg;
    },
    () => {},
    () => {},
    () => {},
    () => {},
    { current: 0 },
  ) as (q: string) => Promise<void>;

  await fn("match");

  assert.equal(capturedError, rejection.message);
});

/**
 * Regression test: runSearch had no guard against two overlapping calls --
 * submitting a search, then editing the query and submitting again before
 * the first search's network round trip finished (a realistic case: a slow
 * first search, or just an impatient double-Enter) started a second,
 * independent runSearch call while the first was still in flight. Nothing
 * stopped the FIRST (now stale) call's own setResults from running after
 * the second (newer, more recent) call's setResults already updated the
 * screen, silently replacing the correct, current results with stale ones
 * for a query the user had already moved past -- the same class of race
 * this session already found and fixed in HistoryPanel.tsx's concurrent
 * restore and App.tsx's stale activeEntity. Deterministic, not timing-based:
 * holds the FIRST search's listRecords call open past the SECOND search's
 * own completion, then only resolves it afterward, to prove the late
 * arrival can't clobber the newer result.
 */
test("GlobalSearchPanel's runSearch ignores a stale, still-in-flight search's results once a newer search has already completed", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function runSearch\(q: string\) \{[\s\S]*?\n {2}\}\n/);
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [] };

  function fakeSearchEntityRecords(entity: { name: string; label: string }, records: unknown[]) {
    return { entityName: entity.name, entityLabel: entity.label, totalMatches: records.length, sample: records };
  }

  let listRecordsCallCount = 0;
  let resolveFirstCall!: () => void;
  const firstCallHeld = new Promise<void>((resolve) => {
    resolveFirstCall = resolve;
  });

  const capturedResultsByCall: unknown[][] = [];
  const searchRequestId = { current: 0 };

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "t",
    "setLoading",
    "setError",
    "setResults",
    "setSearched",
    "setHighlightQuery",
    "setSelectedIndex",
    "searchRequestId",
    `${code}\nreturn runSearch;`,
  )(
    [entityA],
    "proj1",
    async () => {
      listRecordsCallCount += 1;
      if (listRecordsCallCount === 1) {
        await firstCallHeld; // the stale "first" search's own network call stays open
        return { records: [{ id: 1, name: "stale-result" }] };
      }
      return { records: [{ id: 2, name: "fresh-result" }] };
    },
    fakeSearchEntityRecords,
    (key: string) => key,
    () => {},
    () => {},
    (results: unknown[]) => {
      capturedResultsByCall.push(results);
    },
    () => {},
    () => {},
    () => {},
    searchRequestId,
  ) as (q: string) => Promise<void>;

  const stalePromise = fn("first query");
  await Promise.resolve(); // let the stale call actually start and reach its held-open listRecords call
  const freshPromise = fn("second query");
  await freshPromise;

  assert.equal(capturedResultsByCall.length, 1, "the fresh (second) search must have applied its own results");
  assert.deepEqual((capturedResultsByCall[0][0] as { sample: unknown[] }).sample, [{ id: 2, name: "fresh-result" }]);

  resolveFirstCall();
  await stalePromise;

  assert.equal(
    capturedResultsByCall.length,
    1,
    "the stale (first) search resolving afterward must never call setResults again and overwrite the fresh results",
  );
});

/** Same jsdom-swap technique as useDialogFocusTrap.test.ts/EntityPanel.test.ts. */
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

const SEARCH_CUSTOMER_ENTITY: Entity = {
  name: "Customer",
  label: "Customer",
  fields: [{ name: "name", label: "Name", type: "text", required: true }],
};

const SEARCH_ORDER_ENTITY: Entity = {
  name: "Order",
  label: "Order",
  fields: [{ name: "note", label: "Note", type: "text", required: false }],
};

function mockGlobalSearchFetch() {
  const customerRecords: EntityRecord[] = [{ id: 1, name: "Acme widget order" }];
  const orderRecords: EntityRecord[] = [{ id: 1, note: "Acme widget order" }];
  return async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/entities/Customer") {
      return new Response(JSON.stringify({ records: customerRecords }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (input === "/api/projects/proj1/entities/Order") {
      return new Response(JSON.stringify({ records: orderRecords }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockGlobalSearchFetch: unexpected request ${input}`);
  };
}

function renderGlobalSearchPanel(
  onJumpToEntity: (entityName: string) => void,
  onJumpToRecord: (entityName: string, recordId: number) => void = () => {},
) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(GlobalSearchPanel, {
          projectId: "proj1",
          entities: [SEARCH_CUSTOMER_ENTITY, SEARCH_ORDER_ENTITY],
          onClose: () => {},
          onJumpToEntity,
          onJumpToRecord,
        }),
      ),
    ),
  );
}

/**
 * Real-DOM coverage for the one piece of GlobalSearchPanel that was never
 * tested at all, not even via function extraction: handleInputKeyDown's
 * ArrowDown/ArrowUp/Enter keyboard navigation across result groups. A real
 * typed query, a real form submit, then real keydown events on the actual
 * input -- confirming the highlighted group's CSS class actually moves and
 * that Enter jumps to whichever group is currently highlighted, not just
 * that the underlying index arithmetic is correct in isolation.
 */
test("GlobalSearchPanel's arrow keys move the highlighted result group and Enter jumps to it", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    const jumps: string[] = [];
    try {
      renderGlobalSearchPanel((entityName) => jumps.push(entityName));

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      let groups = document.querySelectorAll(".global-search-group");
      assert.equal(
        [...groups].some((g) => g.classList.contains("global-search-group-selected")),
        false,
        "no group should be highlighted before any arrow key is pressed",
      );

      fireEvent.keyDown(input, { key: "ArrowDown" });
      groups = document.querySelectorAll(".global-search-group");
      assert.equal(groups[0].classList.contains("global-search-group-selected"), true, "the first ArrowDown must highlight the first group");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      groups = document.querySelectorAll(".global-search-group");
      assert.equal(groups[1].classList.contains("global-search-group-selected"), true, "a second ArrowDown must move the highlight to the second group");
      assert.equal(groups[0].classList.contains("global-search-group-selected"), false, "the first group must no longer be highlighted");

      fireEvent.keyDown(input, { key: "ArrowUp" });
      groups = document.querySelectorAll(".global-search-group");
      assert.equal(groups[0].classList.contains("global-search-group-selected"), true, "ArrowUp must move the highlight back to the first group");

      fireEvent.keyDown(input, { key: "Enter" });
      assert.deepEqual(
        jumps,
        [SEARCH_CUSTOMER_ENTITY.name],
        "Enter must jump to whichever entity's group is currently highlighted",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: each individual matched row is now its own clickable
 * button (onJumpToRecord), not just the group header's "jump to" button
 * (onJumpToEntity, which only ever switched tabs and threw away which
 * specific record the user actually clicked). Confirms clicking a matched
 * row fires onJumpToRecord with that exact record's own entity name and
 * id -- and that the group header's own "jump to" button still only fires
 * onJumpToEntity, unchanged, so the two levels of granularity coexist.
 */
test("GlobalSearchPanel's individual result rows call onJumpToRecord with that record's own entity name and id", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    const entityJumps: string[] = [];
    const recordJumps: [string, number][] = [];
    try {
      renderGlobalSearchPanel(
        (entityName) => entityJumps.push(entityName),
        (entityName, recordId) => recordJumps.push([entityName, recordId]),
      );

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      const hitButtons = document.querySelectorAll(".global-search-hit-button");
      assert.equal(hitButtons.length, 2, "expected one clickable row per matched record");
      fireEvent.click(hitButtons[0]);

      assert.deepEqual(
        recordJumps,
        [[SEARCH_CUSTOMER_ENTITY.name, 1]],
        "clicking the Customer row's own hit button must report that record's real entity name and id",
      );
      assert.deepEqual(entityJumps, [], "clicking an individual row must not also fire the group-level onJumpToEntity");

      const jumpToButton = document.querySelectorAll(".global-search-group-header button")[0];
      fireEvent.click(jumpToButton);
      assert.deepEqual(
        entityJumps,
        [SEARCH_CUSTOMER_ENTITY.name],
        "the group header's own 'jump to' button must still fire onJumpToEntity, unchanged",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: mirrors round 195's fix to the per-tab search box --
 * a result row already told you a record matched, but not where within
 * its own label the match actually was. Confirms a real submitted search
 * wraps the matched substring in a real <mark class="search-match">
 * within the result row's own label, and that typing ahead (without
 * resubmitting) does NOT retroactively highlight the new, not-yet-
 * searched text against the still-displayed old results -- the
 * highlighted query must track what was actually searched, not the live
 * input.
 */
test("GlobalSearchPanel highlights the matched text within each result row's own label, tracking the actually-submitted query", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 2);

      let marks = document.querySelectorAll(".global-search-hit-button mark.search-match");
      assert.equal(marks.length, 2, "both matching rows must have their own real highlighted substring");
      assert.equal(marks[0].textContent, "widget", "the highlighted text must be exactly the matched substring");

      // Typing ahead without resubmitting must not change what's highlighted.
      fireEvent.change(input, { target: { value: "something else entirely" } });
      marks = document.querySelectorAll(".global-search-hit-button mark.search-match");
      assert.equal(marks.length, 2, "the still-displayed old results must keep highlighting the query they were actually searched with");
      assert.equal(marks[0].textContent, "widget");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: a submitted search now survives closing and
 * reopening the panel, via recentSearches.ts's real localStorage
 * persistence (the same convention pinnedProjects.ts/ideaDraft.ts already
 * use elsewhere). Submits a real search (a genuine fetch + a real form
 * submit, not a direct call into recentSearches.ts), then unmounts and
 * remounts the whole panel component fresh -- a real persistence round
 * trip through the actual component, not just a check that the helper
 * module itself works in isolation.
 */
test("GlobalSearchPanel remembers a submitted search and shows it as a recent-search chip after the panel is closed and reopened", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    try {
      const view = renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      view.unmount();

      renderGlobalSearchPanel(() => {});
      const chip = Array.from(document.querySelectorAll(".global-search-recent .chip")).find(
        (el) => el.textContent === "widget",
      );
      assert.ok(chip, "expected the reopened panel to show 'widget' as a recent-search chip, from real persisted state");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Clicking a recent-search chip must both fill the input and actually
 * re-run the search (a real fetch, real results) -- not just cosmetically
 * populate the query box and leave the person to hit Enter themselves.
 */
test("GlobalSearchPanel's recent-search chip fills the query and genuinely re-runs the search", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    try {
      const view = renderGlobalSearchPanel(() => {});
      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);
      view.unmount();

      renderGlobalSearchPanel(() => {});
      const chip = Array.from(document.querySelectorAll(".global-search-recent .chip")).find(
        (el) => el.textContent === "widget",
      ) as HTMLButtonElement;
      assert.ok(chip, "expected a real 'widget' recent-search chip before clicking it");
      fireEvent.click(chip);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);
      const reopenedInput = document.querySelector(".global-search-input") as HTMLInputElement;
      assert.equal(reopenedInput.value, "widget", "clicking the chip must fill the query input with its own text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** The "Clear" link must wipe the recent-search list for real, not just hide it until the next reopen. */
test("GlobalSearchPanel's recent-search 'Clear' link genuinely empties the persisted list, surviving a remount", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    try {
      const firstView = renderGlobalSearchPanel(() => {});
      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);
      firstView.unmount();

      const secondView = renderGlobalSearchPanel(() => {});
      const clearButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Clear");
      assert.ok(clearButton, "expected a real 'Clear' link once a recent search exists");
      fireEvent.click(clearButton!);
      // A raw DOM node as assert.equal's "actual" argument is a real trap
      // (see round 171's own lesson): on failure, node:assert formats it
      // with util.inspect(), and jsdom's huge, circular element property
      // graph makes that effectively hang instead of failing fast --
      // exactly what happened here while writing this test, against a
      // deliberately-broken handleClearRecentSearches. Reducing to a
      // boolean first keeps a genuine failure's error message cheap.
      assert.equal(
        document.querySelector(".global-search-recent") === null,
        true,
        "the recent-searches section must disappear immediately once cleared",
      );
      secondView.unmount();

      renderGlobalSearchPanel(() => {});
      assert.equal(
        document.querySelector(".global-search-recent") === null,
        true,
        "a fresh mount after Clear must still show no recent searches -- proving it was really wiped from storage, not just hidden in memory",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
