import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
    "lastRecordsByEntityRef",
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
    { current: {} },
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
    "lastRecordsByEntityRef",
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
    { current: {} },
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
    "lastRecordsByEntityRef",
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
    { current: {} },
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
          projectName: "Test Project",
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
 * New in this round: a failed search left only a bare error line with no
 * way to retry the exact same query short of retyping it and hitting
 * submit again. Unlike the other 3 panels touched this round, error here
 * was already single-purpose (search failures only), so no new state was
 * needed -- just a Retry button wired to re-run runSearch(highlightQuery),
 * the actually-submitted query, not whatever may since have been typed
 * into the box.
 */
test("GlobalSearchPanel shows a real error with a Retry button when a search fails, and Retry re-runs the exact same query", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Customer" || input === "/api/projects/proj1/entities/Order") {
        callCount += 1;
        if (callCount <= 2) {
          return new Response(JSON.stringify({ error: "Server exploded" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        const records: EntityRecord[] = input.endsWith("/Customer") ? [{ id: 1, name: "Acme widget order" }] : [{ id: 1, note: "Acme widget order" }];
        return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);

      await waitForCondition(() => document.querySelector(".error-retry-row") !== null);
      assert.match(document.querySelector(".error-retry-row p.error")!.textContent ?? "", /Server exploded/);
      assert.equal(
        document.querySelector(".error-retry-row p.error")!.getAttribute("role"),
        "status",
        "the error must be announced to screen readers, not just shown visually",
      );

      const retryButton = document.querySelector(".error-retry-row button") as HTMLButtonElement;
      assert.ok(retryButton, "expected a real Retry button");

      fireEvent.click(retryButton);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      assert.equal(document.querySelector(".error-retry-row"), null, "the error+Retry row must disappear once the retry succeeds");
      assert.match(input.value, /widget/, "Retry must re-run the originally-submitted query, not clear it");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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
 * jsdom's own HTMLElement doesn't implement scrollIntoView at all (confirmed
 * empirically: `typeof el.scrollIntoView === "undefined"` under this jsdom
 * version), so this test installs a minimal stub -- mirroring the
 * WhatsAppPanel Notification-API stub pattern -- to prove arrow-key
 * navigation actually scrolls the newly-highlighted group into view, not
 * just toggles its CSS class. Before this fix, a result list taller than
 * the panel's own scrollable height could move the highlight below the
 * fold with zero visual cue, so Enter would jump to a group the user
 * couldn't see was even selected.
 */
test("GlobalSearchPanel's arrow keys scroll the newly-highlighted result group into view", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    const calls: Element[] = [];
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void };
    proto.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);
      assert.equal(calls.length, 0, "no scroll should happen before any arrow key is pressed");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      let groups = document.querySelectorAll(".global-search-group");
      assert.equal(calls.length, 1, "the first ArrowDown must trigger exactly one scroll");
      assert.equal(calls[0], groups[0], "the first ArrowDown must scroll the first (now-highlighted) group into view");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      groups = document.querySelectorAll(".global-search-group");
      assert.equal(calls.length, 2, "a second ArrowDown must trigger a second scroll");
      assert.equal(calls[1], groups[1], "a second ArrowDown must scroll the second (now-highlighted) group into view, not the first");
    } finally {
      globalThis.fetch = originalFetch;
      delete proto.scrollIntoView;
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
      // The chip's own textContent now also includes its trailing remove
      // button's "×" (round 230's own click-to-rename-style .chip-remove
      // wiring, same lesson round 225 already hit for a pencil icon) --
      // match the inner .chip-text span's own text, not the whole chip's.
      const chip = Array.from(document.querySelectorAll(".global-search-recent .chip .chip-text")).find(
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
      const chip = Array.from(document.querySelectorAll(".global-search-recent .chip .chip-text")).find(
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

function mockManyMatchesFetch() {
  const customerRecords: EntityRecord[] = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Widget item ${i + 1}` }));
  return async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/entities/Customer") {
      return new Response(JSON.stringify({ records: customerRecords }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (input === "/api/projects/proj1/entities/Order") {
      return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`mockManyMatchesFetch: unexpected request ${input}`);
  };
}

/**
 * New in this round: a group used to cap its rows at 5 (searchEntityRecords'
 * own default sample limit) and show dead "+N more" text for the rest --
 * real matches the panel already knew the count of but gave no way to
 * reach. Confirms a real "Show all" button appears exactly when more
 * matches exist, that clicking it genuinely reveals every one of them (not
 * just relabels the same 5), and that the button itself disappears once
 * nothing is left to expand.
 */
test("GlobalSearchPanel's 'Show all' button reveals every match beyond the default 5-row sample, and disappears once everything is shown", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockManyMatchesFetch() as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 5);

      const showAllButton = document.querySelector(".global-search-show-all") as HTMLButtonElement | null;
      assert.ok(showAllButton, "expected a real 'Show all' button when more matches exist than the sample shows");

      fireEvent.click(showAllButton!);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 7);

      assert.equal(
        document.querySelector(".global-search-show-all"),
        null,
        "the 'Show all' button must disappear once every match is already shown",
      );
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

/**
 * New in this round: previously the only way to trim the recent-searches
 * list was "Clear" (wiping all of it) -- the same gap the WhatsApp log
 * (round 208), Time Machine (round 216) and refine-history (round 228)
 * lists each had before their own single-item delete. Each chip now has
 * its own 🗑️-style remove button (reusing the existing .chip-removable/
 * .chip-remove pattern from spec review's roles/assumptions, round 225)
 * alongside the existing click-to-search button. Submits two real
 * searches to build a real two-item recent list, removes only one, and
 * confirms: the other survives a remount (a real persisted removal, not
 * just hidden in memory), and clicking the remove button never itself
 * ran a search (the input stays empty, no new result group appears).
 */
test("GlobalSearchPanel's per-chip remove button deletes only that one recent search, persists across a remount, and never triggers a search of its own", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    try {
      const firstView = renderGlobalSearchPanel(() => {});
      const input = document.querySelector(".global-search-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      fireEvent.change(input, { target: { value: "gadget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => {
        const groups = document.querySelectorAll(".global-search-group");
        return groups.length === 0 || Array.from(groups).every((g) => !/widget/i.test(g.textContent ?? ""));
      });
      firstView.unmount();

      renderGlobalSearchPanel(() => {});
      const chipTextOf = (q: string) =>
        Array.from(document.querySelectorAll(".global-search-recent .chip .chip-text")).find((el) => el.textContent === q);
      assert.ok(chipTextOf("widget"), "expected both 'widget' and 'gadget' as real persisted recent-search chips");
      assert.ok(chipTextOf("gadget"));

      const widgetChip = chipTextOf("widget")!.closest(".chip")!;
      const removeButton = widgetChip.querySelector(".chip-remove") as HTMLButtonElement;
      assert.ok(removeButton, "expected a real remove button on the 'widget' chip");

      const reopenedInput = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.click(removeButton);

      assert.equal(reopenedInput.value, "", "clicking the remove button must never fill the query input or run a search");
      assert.equal(document.querySelectorAll(".global-search-group").length, 0, "clicking remove must not trigger any search of its own");
      assert.equal(chipTextOf("widget"), undefined, "the removed chip must disappear from the DOM immediately");
      assert.ok(chipTextOf("gadget"), "the OTHER recent search must survive untouched");

      renderGlobalSearchPanel(() => {});
      assert.equal(
        chipTextOf("widget"),
        undefined,
        "a fresh mount must still not show 'widget' -- proving the removal was really persisted, not just hidden in memory",
      );
      assert.ok(chipTextOf("gadget"), "a fresh mount must still show the untouched 'gadget' entry");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: Global Search was the one read-heavy panel in this
 * app with no Copy/Download companions at all (Business Twin round 222,
 * WhatsApp log round 223, Time Machine round 224 all already have both) --
 * a cross-entity result set only ever existed on screen until the panel
 * closed. Confirms neither button renders before a real search has run,
 * both appear once real results exist, and clicking Copy writes the real
 * formatted results (not a placeholder) to the clipboard.
 */
test("GlobalSearchPanel shows Copy/Download buttons only once real results exist, and Copy writes the real formatted results to the clipboard", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;

    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });

    try {
      renderGlobalSearchPanel(() => {});

      assert.equal(
        Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("Copy results")),
        false,
        "no Copy button should render before any search has run",
      );
      assert.equal(
        Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("Download results")),
        false,
        "no Download button should render before any search has run",
      );

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Copy results"));
      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download results"));
      assert.ok(copyButton, "expected a Copy results button once real results exist");
      assert.ok(downloadButton, "expected a Download results button once real results exist");
      assert.equal(
        copyButton!.getAttribute("aria-live"),
        "polite",
        "the copy button's own changing label must be announced to screen readers, not just silently change visually",
      );
      assert.equal(copyButton!.getAttribute("aria-atomic"), "true", "the whole button's text must be re-announced, not just the changed part");

      t.mock.timers.enable({ apis: ["setTimeout"] });

      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Test Project/, "the copied text must be the real formatted results, not a placeholder");
      assert.match(writtenText!, /widget/, "the copied text must include the real search query");
      assert.equal(copyButton!.textContent, "✅ Copied!", "must show the real Copied confirmation");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy results", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

test("GlobalSearchPanel's Download button downloads the real results as a named file", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;

    // jsdom doesn't implement the real Blob-URL machinery -- stub just
    // enough of it to observe what the click handler actually does, the
    // same technique HistoryPanel.test.ts's own download test uses.
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
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      const downloadButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download results"));
      assert.ok(downloadButton, "expected a Download results button once real results exist");

      fireEvent.click(downloadButton!);

      assert.equal(clickCount, 1, "clicking the download button must trigger exactly one real anchor click");
      const downloadName: string = capturedDownloadName ?? "";
      assert.ok(
        downloadName.includes("Test Project"),
        `expected the downloaded filename to be derived from the real project name "Test Project", got "${downloadName}"`,
      );
      assert.ok(downloadName.endsWith("search-results.txt"), `expected a search-results.txt filename, got "${downloadName}"`);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      anchorProto.click = originalAnchorClick;
    }
  });
});

/**
 * New in this round: real-DOM proof that Global Search now matches a
 * relation field's resolved display label (e.g. a Courier's own "Dana"),
 * the same gap fixed in EntityPanel's own per-tab search box -- both share
 * the exact same matchesSearch rule via searchEntityRecords, so leaving
 * this one behind would have made "found here" and "found everywhere"
 * genuinely disagree for the first time. Every entity's records are
 * already being fetched to search them, so this also confirms that
 * shared fetch doubles as the relation lookup with no separate request.
 */
test("GlobalSearchPanel matches a relation field's resolved display label, not the raw foreign-key id it's stored as", async () => {
  const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
  const orderEntity: Entity = {
    name: "Order",
    label: "Order",
    fields: [
      { name: "item", label: "Item", type: "text", required: true },
      { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/entities/Courier") {
      return new Response(JSON.stringify({ records: [{ id: 9, name: "Dana" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (input === "/api/projects/proj1/entities/Order") {
      return new Response(JSON.stringify({ records: [{ id: 1, item: "Pizza", courierId: 9 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request ${input}`);
  }) as typeof fetch;

  await withJsdom(async () => {
    try {
      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(GlobalSearchPanel, {
              projectId: "proj1",
              projectName: "Test Project",
              entities: [courierEntity, orderEntity],
              onClose: () => {},
              onJumpToEntity: () => {},
              onJumpToRecord: () => {},
            }),
          ),
        ),
      );

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Dana" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length > 0);

      const groupLabels = [...document.querySelectorAll(".global-search-entity-label")].map((el) => el.textContent);
      assert.deepEqual(
        groupLabels,
        ["Courier", "Order"],
        "searching the courier's own name must match Courier directly AND Order via its resolved relation label",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
