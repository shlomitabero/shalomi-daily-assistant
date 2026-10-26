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
    "errorFromShowAllRef",
    "lang",
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
    { current: false },
    "en",
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
    "errorFromShowAllRef",
    "lang",
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
    { current: false },
    "en",
  ) as (q: string) => Promise<void>;

  await fn("match");

  assert.equal(capturedError, rejection.message);
});

/**
 * Regression test: runSearch built its results array by mapping over
 * `entities` in whatever order the project's spec happens to declare them,
 * with zero regard to how many matches each entity actually had -- an
 * entity with one coincidental match could sit above one with fifty, just
 * because it comes first in the entities array. Declares entities in the
 * opposite order from their real match counts (Alpha first but fewest
 * matches, Gamma last but most) to prove the fix sorts by totalMatches,
 * not by array position.
 */
test("GlobalSearchPanel's runSearch orders entity groups by totalMatches descending, not by declaration order", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function runSearch\(q: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find runSearch in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [] };
  const entityB = { name: "Beta", label: "Beta", fields: [] };
  const entityC = { name: "Gamma", label: "Gamma", fields: [] };
  const matchCounts: Record<string, number> = { Alpha: 1, Beta: 5, Gamma: 50 };

  function fakeSearchEntityRecords(entity: { name: string; label: string }) {
    const totalMatches = matchCounts[entity.name];
    return { entityName: entity.name, entityLabel: entity.label, totalMatches, sample: [] };
  }

  let capturedResults: unknown[] | undefined;

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
    "errorFromShowAllRef",
    "lang",
    `${code}\nreturn runSearch;`,
  )(
    [entityA, entityB, entityC],
    "proj1",
    async () => ({ records: [{ id: 1 }] }),
    fakeSearchEntityRecords,
    (key: string) => key,
    () => {},
    () => {},
    (results: unknown[]) => {
      capturedResults = results;
    },
    () => {},
    () => {},
    () => {},
    { current: 0 },
    { current: {} },
    { current: false },
    "en",
  ) as (q: string) => Promise<void>;

  await fn("match");

  assert.deepEqual(
    (capturedResults ?? []).map((r) => (r as { entityName: string }).entityName),
    ["Gamma", "Beta", "Alpha"],
    "entity groups must be ordered by totalMatches descending, not by the entities array's own declaration order",
  );
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
    "errorFromShowAllRef",
    "lang",
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
    { current: false },
    "en",
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

/**
 * Regression test (round 412; flagged as a runner-up but not pursued back
 * in round 394): handleShowAll had no equivalent guard to runSearch's own
 * searchRequestId check, even though it makes the exact same kind of
 * async fetch into shared state (expandedSamples). Holds "Show all"'s own
 * listRecords call open past a newer search's own completion (bumping
 * searchRequestId), then only resolves it afterward, to prove the late
 * arrival can't merge a stale sample into results the user has already
 * moved past.
 */
test("GlobalSearchPanel's handleShowAll ignores a stale, still-in-flight fetch once a newer search has already completed", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function handleShowAll\(entityName: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleShowAll in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [] };

  function fakeSearchEntityRecords(entity: { name: string; label: string }, records: unknown[]) {
    return { entityName: entity.name, entityLabel: entity.label, totalMatches: records.length, sample: records };
  }

  let resolveShowAllCall!: () => void;
  const showAllCallHeld = new Promise<void>((resolve) => {
    resolveShowAllCall = resolve;
  });

  const expandedSamplesCalls: unknown[] = [];
  const searchRequestId = { current: 0 };

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "highlightQuery",
    "lastRecordsByEntityRef",
    "setShowAllLoading",
    "setExpandedSamples",
    "searchRequestId",
    "lang",
    "setError",
    `${code}\nreturn handleShowAll;`,
  )(
    [entityA],
    "proj1",
    async () => {
      await showAllCallHeld; // "Show all"'s own network call stays open
      return { records: [{ id: 1, name: "stale-shown-record" }] };
    },
    fakeSearchEntityRecords,
    "stale query",
    { current: {} },
    () => {},
    (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      expandedSamplesCalls.push(updater({}));
    },
    searchRequestId,
    "en",
    () => {},
  ) as (entityName: string) => Promise<void>;

  const showAllPromise = fn("Alpha");
  await Promise.resolve(); // let "Show all" actually start and reach its held-open listRecords call
  searchRequestId.current += 1; // a newer search completed while "Show all" was still in flight
  resolveShowAllCall();
  await showAllPromise;

  assert.equal(
    expandedSamplesCalls.length,
    0,
    "a Show all fetch superseded by a newer search must never write its stale sample into expandedSamples",
  );
});

/**
 * Round 923: the SUCCESS path above already discards a stale "Show all"
 * fetch via the searchRequestId check right after the await -- but the
 * catch block added later (round 663, to surface a failed fetch through
 * the shared `error` banner) never got the same guard. Mirrors the test
 * above exactly, except the held-open listRecords call REJECTS instead
 * of resolving, to prove a stale failure can't surface its own unrelated
 * error over whatever the user's current, superseding search already
 * put on screen.
 */
test("GlobalSearchPanel's handleShowAll never surfaces a stale, still-in-flight fetch's error once a newer search has already completed", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function handleShowAll\(entityName: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleShowAll in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [] };

  function fakeSearchEntityRecords(entity: { name: string; label: string }, records: unknown[]) {
    return { entityName: entity.name, entityLabel: entity.label, totalMatches: records.length, sample: records };
  }

  let rejectShowAllCall!: (err: Error) => void;
  const showAllCallHeld = new Promise<never>((_resolve, reject) => {
    rejectShowAllCall = reject;
  });

  const errorCalls: unknown[] = [];
  const searchRequestId = { current: 0 };

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "highlightQuery",
    "lastRecordsByEntityRef",
    "setShowAllLoading",
    "setExpandedSamples",
    "searchRequestId",
    "lang",
    "setError",
    "errorFromShowAllRef",
    `${code}\nreturn handleShowAll;`,
  )(
    [entityA],
    "proj1",
    async () => {
      await showAllCallHeld; // "Show all"'s own network call stays open, then rejects below
    },
    fakeSearchEntityRecords,
    "stale query",
    { current: {} },
    () => {},
    () => {},
    searchRequestId,
    "en",
    (message: unknown) => {
      errorCalls.push(message);
    },
    { current: false },
  ) as (entityName: string) => Promise<void>;

  const showAllPromise = fn("Alpha");
  await Promise.resolve(); // let "Show all" actually start and reach its held-open listRecords call
  searchRequestId.current += 1; // a newer search completed while "Show all" was still in flight
  rejectShowAllCall(new Error("stale show-all failure"));
  await showAllPromise;

  assert.equal(
    errorCalls.length,
    0,
    "a Show all fetch superseded by a newer search must never surface its own stale error over the current search's results",
  );
});

/**
 * Round 1020: runSearch's own sort (tested above) establishes the panel's
 * documented "descending totalMatches order" once, at the original
 * search -- but handleShowAll patches one group's own totalMatches to a
 * fresh count (round 983's own comment right above its success branch
 * already names why this count can change: a collaborator's edit, an
 * automation write, another tab, all while the panel stayed open) without
 * ever re-sorting. Starts with two groups already in the panel's
 * documented order (Order:20 above Customer:6), then "Show all" on
 * Customer discovers 36 real matches -- Customer must now sort back above
 * Order, not stay stuck below it just because its OWN position in the
 * array was set at the original, smaller count.
 */
test("GlobalSearchPanel's handleShowAll re-sorts results after a group's totalMatches changes, so it can't end up rendered below a group it now outnumbers", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function handleShowAll\(entityName: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleShowAll in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityOrder = { name: "Order", label: "Order", fields: [] };
  const entityCustomer = { name: "Customer", label: "Customer", fields: [] };

  function fakeSearchEntityRecords(entity: { name: string; label: string }, records: unknown[]) {
    return { entityName: entity.name, entityLabel: entity.label, totalMatches: records.length, sample: records };
  }

  // The panel's own documented order at the original search: Order (20)
  // above Customer (6).
  let results: { entityName: string; entityLabel: string; totalMatches: number; sample: unknown[] }[] = [
    { entityName: "Order", entityLabel: "Order", totalMatches: 20, sample: [] },
    { entityName: "Customer", entityLabel: "Customer", totalMatches: 6, sample: [] },
  ];
  const searchRequestId = { current: 0 };

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "highlightQuery",
    "lastRecordsByEntityRef",
    "setShowAllLoading",
    "setExpandedSamples",
    "searchRequestId",
    "lang",
    "setError",
    "errorFromShowAllRef",
    "setResults",
    "results",
    "selectedIndex",
    "setSelectedIndex",
    `${code}\nreturn handleShowAll;`,
  )(
    [entityOrder, entityCustomer],
    "proj1",
    async () => ({ records: new Array(36).fill(0).map((_, i) => ({ id: i, name: `customer-${i}` })) }),
    fakeSearchEntityRecords,
    "smith",
    { current: {} },
    () => {},
    () => {},
    searchRequestId,
    "en",
    () => {},
    { current: false },
    // Round 1033: the success branch below now calls setResults with a
    // plain array value (not an updater function) -- see its own doc
    // comment on why -- while the sibling zero-matches branch still uses
    // the updater form, so this fake setter supports both.
    (next: typeof results | ((prev: typeof results) => typeof results)) => {
      results = typeof next === "function" ? (next as (prev: typeof results) => typeof results)(results) : next;
    },
    // Round 1033: the success branch now reads `results` directly (a new
    // free variable, since it no longer derives the sorted array from the
    // setResults updater's own `prev`) -- see its own doc comment on why.
    results,
    // Round 1033: this test doesn't exercise keyboard selection -- a
    // harmless no-op, same as every other newly-required parameter this
    // routine's own "signature-migration causes expected test breakage"
    // pattern adds to an existing extraction test.
    null,
    () => {},
  ) as (entityName: string) => Promise<void>;

  await fn("Customer");

  assert.deepEqual(
    results.map((r) => r.entityName),
    ["Customer", "Order"],
    "Customer now genuinely has more matches (36) than Order (20) and must sort back above it, not stay stuck below just because of its original array position",
  );
  assert.equal(results[0].totalMatches, 36);
});

/**
 * Round 1033: selectedIndex is a plain array SLOT number, not an entity
 * identity -- the round-1020 resort above moves entities between slots
 * without ever touching it, so a keyboard-highlighted entity could be
 * left identified by whatever ends up at its OLD slot instead of
 * following it to its new one. Starts with three groups (Order:20,
 * Customer:6, Deal:3) with "Customer" keyboard-highlighted at index 1,
 * then "Show all" on Deal discovers 10 real matches -- enough to move
 * Deal above Customer (new order: Order, Deal, Customer) but still below
 * Order. selectedIndex must end up at Customer's NEW slot (2), not stay
 * at 1, which the resort has since handed to Deal -- Enter would
 * otherwise jump to the wrong entity, and the highlight/scroll-into-view
 * effect would sit on whatever landed there instead.
 */
test("GlobalSearchPanel's handleShowAll keeps a keyboard-highlighted group identified by its entity, not its old array slot, after a resort", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function handleShowAll\(entityName: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleShowAll in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityOrder = { name: "Order", label: "Order", fields: [] };
  const entityCustomer = { name: "Customer", label: "Customer", fields: [] };
  const entityDeal = { name: "Deal", label: "Deal", fields: [] };

  function fakeSearchEntityRecords(entity: { name: string; label: string }, records: unknown[]) {
    return { entityName: entity.name, entityLabel: entity.label, totalMatches: records.length, sample: records };
  }

  let results: { entityName: string; entityLabel: string; totalMatches: number; sample: unknown[] }[] = [
    { entityName: "Order", entityLabel: "Order", totalMatches: 20, sample: [] },
    { entityName: "Customer", entityLabel: "Customer", totalMatches: 6, sample: [] },
    { entityName: "Deal", entityLabel: "Deal", totalMatches: 3, sample: [] },
  ];
  // "Customer" is keyboard-highlighted at its current slot, index 1.
  let selectedIndex: number | null = 1;
  const searchRequestId = { current: 0 };

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "highlightQuery",
    "lastRecordsByEntityRef",
    "setShowAllLoading",
    "setExpandedSamples",
    "searchRequestId",
    "lang",
    "setError",
    "errorFromShowAllRef",
    "setResults",
    "results",
    "selectedIndex",
    "setSelectedIndex",
    `${code}\nreturn handleShowAll;`,
  )(
    [entityOrder, entityCustomer, entityDeal],
    "proj1",
    async () => ({ records: new Array(10).fill(0).map((_, i) => ({ id: i, name: `deal-${i}` })) }),
    fakeSearchEntityRecords,
    "smith",
    { current: {} },
    () => {},
    () => {},
    searchRequestId,
    "en",
    () => {},
    { current: false },
    // Round 1033: the success branch below now calls setResults with a
    // plain array value (not an updater function) -- see its own doc
    // comment on why -- while the sibling zero-matches branch still uses
    // the updater form, so this fake setter supports both.
    (next: typeof results | ((prev: typeof results) => typeof results)) => {
      results = typeof next === "function" ? (next as (prev: typeof results) => typeof results)(results) : next;
    },
    // Round 1033: the success branch now reads `results` directly (a new
    // free variable, since it no longer derives the sorted array from the
    // setResults updater's own `prev`) -- see its own doc comment on why.
    results,
    selectedIndex,
    (next: number | null) => {
      selectedIndex = next;
    },
  ) as (entityName: string) => Promise<void>;

  await fn("Deal");

  assert.deepEqual(
    results.map((r) => r.entityName),
    ["Order", "Deal", "Customer"],
    "sanity check: Deal's fresh count (10) must move it above Customer (6) but still below Order (20)",
  );
  assert.equal(
    selectedIndex,
    2,
    "the highlight must follow Customer to its new slot (2), not stay at its old slot (1), which the resort has since handed to Deal",
  );
});

/**
 * Regression test for round 663: handleShowAll had no catch clause at all,
 * unlike runSearch's own identical listRecords call above it in this same
 * file -- a rejected fetch (a timeout, a cold-starting backend, an entity
 * a collaborator removed since the original search) was an unhandled
 * promise rejection with zero visible feedback: showAllLoading still
 * cleared via the existing finally, but setError was never called, so the
 * button silently reverted from "Loading…" back to "Show N more" as if
 * nothing had happened at all.
 */
test("GlobalSearchPanel's handleShowAll surfaces a failed fetch via setError, instead of silently swallowing it", async () => {
  const handlerMatch = globalSearchPanelSrc.match(/ {2}async function handleShowAll\(entityName: string\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(handlerMatch, "expected to find handleShowAll in GlobalSearchPanel.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  const entityA = { name: "Alpha", label: "Alpha", fields: [] };
  const rejection = new Error("network error");
  let capturedError: string | undefined;
  const loadingUpdaterCalls: unknown[] = [];

  const fn = new Function(
    "entities",
    "projectId",
    "listRecords",
    "searchEntityRecords",
    "highlightQuery",
    "lastRecordsByEntityRef",
    "setShowAllLoading",
    "setExpandedSamples",
    "searchRequestId",
    "lang",
    "setError",
    "errorFromShowAllRef",
    `${code}\nreturn handleShowAll;`,
  )(
    [entityA],
    "proj1",
    async () => {
      throw rejection;
    },
    () => null,
    "query",
    { current: {} },
    (updater: (prev: Set<string>) => Set<string>) => {
      loadingUpdaterCalls.push(updater(new Set()));
    },
    () => {},
    { current: 0 },
    "en",
    (msg: string) => {
      capturedError = msg;
    },
    { current: false },
  ) as (entityName: string) => Promise<void>;

  await fn("Alpha");

  assert.equal(capturedError, rejection.message, "a rejected listRecords call must surface its error via setError");
  assert.equal(
    loadingUpdaterCalls.length,
    2,
    "setShowAllLoading must still be called to add then clear the loading state, even on failure",
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
          userId: "user1",
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
 * Round 875's finding: selectedIndex was only ever reset to null inside
 * runSearch itself (both the empty-query early-return and the real-results
 * branch) -- never the moment the query TEXT changed, before that new
 * search ever runs. Arrow-key selecting a result group, then editing the
 * query to something unrelated, left selectedIndex pointing at a group
 * from the OLD search. handleInputKeyDown's Enter branch only checked
 * `selectedIndex !== null`, never that it still corresponded to the text
 * now in the box, so Enter called preventDefault() and jumped to the
 * stale entity instead of letting the form's own onSubmit run the new
 * search the user just typed -- the user's edited query was silently
 * discarded. Confirms editing the query after an arrow-key selection, then
 * pressing Enter, submits a genuinely new search (reaching the "No
 * results" state for a query that matches nothing) instead of jumping to
 * the stale, previously-highlighted entity.
 */
test("GlobalSearchPanel submits a newly-edited query on Enter instead of jumping to a stale arrow-selected result from before the edit", async () => {
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

      fireEvent.keyDown(input, { key: "ArrowDown" });
      let groups = document.querySelectorAll(".global-search-group");
      assert.equal(groups[0].classList.contains("global-search-group-selected"), true, "the first ArrowDown must highlight the first group");

      // Edit the query to something that matches nothing, without
      // submitting yet -- the stale highlight must not survive this.
      fireEvent.change(input, { target: { value: "zzz-totally-unrelated-query" } });

      fireEvent.keyDown(input, { key: "Enter" });
      assert.deepEqual(jumps, [], "Enter must not jump to the stale, pre-edit highlighted entity");

      // handleInputKeyDown's Enter branch no longer intercepts this
      // keydown (selectedIndex was reset the moment the query changed),
      // so the browser's own native "Enter submits the enclosing form"
      // behavior is what would actually run the new search -- jsdom
      // doesn't implement that implicit submission, so it's simulated
      // explicitly here, the same way a real browser's default action
      // would once handleInputKeyDown stops calling preventDefault().
      fireEvent.submit(form);
      await waitForCondition(() => document.body.textContent?.includes("No matching results") ?? false);
      assert.equal(
        document.querySelectorAll(".global-search-group").length,
        0,
        "the new, edited query must reach a real search with no stale groups left over",
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
 * New in this round: the arrow-key scroll above (and every other
 * scrollIntoView call in this app) passed behavior: "smooth"
 * unconditionally, regardless of whether the person has their OS/browser
 * set to "prefers-reduced-motion: reduce" -- the exact WCAG 2.3.3 case
 * this app already treats as real for its one CSS keyframe animation.
 * jsdom itself doesn't implement matchMedia at all, so this test installs
 * a minimal stub (same technique ThemeContext.test.ts uses) reporting
 * reduced motion is requested, then confirms the real scrollIntoView
 * call -- triggered through an actual ArrowDown keypress, not a direct
 * function call -- receives behavior: "auto" instead of "smooth".
 */
test("GlobalSearchPanel's arrow-key scroll uses behavior: \"auto\" instead of \"smooth\" when prefers-reduced-motion is set", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    const calls: unknown[] = [];
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void };
    proto.scrollIntoView = function (_options?: unknown) {
      calls.push(_options);
    };
    // renderGlobalSearchPanel wraps in ThemeProvider too, which calls
    // matchMedia("(prefers-color-scheme: dark)") on its own and expects a
    // real add/removeEventListener -- this stub must satisfy both callers,
    // not just the reduced-motion one this test cares about.
    (window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = (query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);
      fireEvent.keyDown(input, { key: "ArrowDown" });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], { behavior: "auto", block: "nearest" }, "must substitute behavior: \"auto\" when the person asked for reduced motion");
    } finally {
      globalThis.fetch = originalFetch;
      delete proto.scrollIntoView;
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
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
 * Round 1050: closes round 1049's own deferred sibling gap -- a record's
 * display label (recordPreview) can fall back to a `text`/`longtext`
 * field (pickDisplayField, entityFormatting.ts) when the entity has no
 * name/title field, e.g. a `Lead` entity whose only usable display field
 * is `website`. Before this round, a URL or email embedded there rendered
 * as inert text here, the same gap round 1049 already fixed for the
 * WhatsApp message log -- blocked there by each row being a native
 * `<button>` (nesting a real `<a>` inside a `<button>` is invalid HTML).
 * This round restructures the row to a role="button" div specifically to
 * remove that blocker. Confirms the link renders as a real `<a>` AND that
 * clicking it does NOT also fire onJumpToRecord (the link's own onClick
 * stops propagation), while clicking anywhere else on the row still does.
 */
test("GlobalSearchPanel renders a URL or email embedded in a record's own display-label field as a real clickable link, without also triggering onJumpToRecord", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    const leadEntity: Entity = {
      name: "Lead",
      label: "Lead",
      fields: [{ name: "website", label: "Website", type: "text", required: false }],
    };
    const leadRecords: EntityRecord[] = [{ id: 1, website: "https://example.com/widget-page" }];
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Lead") {
        return new Response(JSON.stringify({ records: leadRecords }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const recordJumps: [string, number][] = [];
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
              userId: "user1",
              projectName: "Test Project",
              entities: [leadEntity],
              onClose: () => {},
              onJumpToEntity: () => {},
              onJumpToRecord: (entityName: string, recordId: number) => recordJumps.push([entityName, recordId]),
            }),
          ),
        ),
      );

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      const form = document.querySelector("form.global-search-form")!;
      fireEvent.submit(form);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 1);

      const row = document.querySelector(".global-search-hit-button")!;
      const link = row.querySelector("a.cell-link") as HTMLAnchorElement;
      assert.ok(link, "expected a real <a> link for the URL embedded in the record's own display-label field");
      assert.equal(link.getAttribute("href"), "https://example.com/widget-page");
      assert.equal(link.target, "_blank");

      fireEvent.click(link);
      assert.deepEqual(recordJumps, [], "clicking the link itself must open it, not also fire onJumpToRecord");

      fireEvent.click(row);
      assert.deepEqual(recordJumps, [["Lead", 1]], "clicking the row (not the link) must still fire onJumpToRecord, unchanged");
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

/**
 * Round 1033: a real, full-render regression test for the exact bug the
 * lightweight extraction test above (and its own fake, synchronously-
 * applied setResults) could not actually catch -- confirmed empirically
 * while building this fix: React does not guarantee a setState updater
 * function runs synchronously at the point it's passed to the setter, so
 * a value written inside one setResults updater and read on the very
 * next line was still unset. Only a real render against the genuine
 * useState setter exercises that timing. Arrow-key-highlights Order
 * (ranked first, more matches) then Customer (the second group), then
 * triggers "Show all" on Customer with a fresh count large enough to move
 * it above Order -- the keyboard highlight must follow Customer to its
 * new (now-first) slot, and Enter afterward must still jump to Customer.
 */
test("GlobalSearchPanel's real (non-mocked) setResults correctly carries a keyboard-highlighted group's selection through a 'Show all' resort", async () => {
  await withJsdom(async () => {
    let customerFetchCount = 0;
    const orderRecords: EntityRecord[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, note: `widget order ${i + 1}` }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: orderRecords }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Customer") {
        customerFetchCount += 1;
        // The original search sees only 6 matches (more than the 5-item
        // sample cap, so a real "Show all" button renders, but still
        // fewer than Order's 20); "Show all" (the second fetch) discovers
        // 36 -- enough to move Customer above Order.
        const count = customerFetchCount === 1 ? 6 : 36;
        const records: EntityRecord[] = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `widget customer ${i + 1}` }));
        return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;

    let jumpedTo: string | null = null;
    try {
      renderGlobalSearchPanel((entityName) => {
        jumpedTo = entityName;
      });

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      const labelsBefore = Array.from(document.querySelectorAll(".global-search-entity-label")).map((el) => el.textContent);
      assert.deepEqual(labelsBefore, ["Order", "Customer"], "sanity check: Order (20 matches) must rank above Customer (6) at the original search");

      // Arrow down twice to keyboard-highlight Customer, the second (index 1) group.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      assert.equal(
        document.querySelector(".global-search-group-selected .global-search-entity-label")?.textContent,
        "Customer",
        "sanity check: Customer must be keyboard-highlighted before 'Show all' triggers a resort",
      );

      const customerGroup = Array.from(document.querySelectorAll(".global-search-group")).find(
        (g) => g.querySelector(".global-search-entity-label")?.textContent === "Customer",
      ) as HTMLElement;
      const showAllButton = customerGroup.querySelector(".global-search-show-all") as HTMLButtonElement;
      fireEvent.click(showAllButton);
      await waitForCondition(() => {
        const labels = Array.from(document.querySelectorAll(".global-search-entity-label")).map((el) => el.textContent);
        return labels[0] === "Customer";
      });

      assert.equal(
        document.querySelector(".global-search-group-selected .global-search-entity-label")?.textContent,
        "Customer",
        "the keyboard highlight must still follow Customer to its new (now-first) slot, not whatever landed at its old slot",
      );

      fireEvent.keyDown(input, { key: "Enter" });
      assert.equal(jumpedTo, "Customer", "Enter must still jump to Customer, the entity the user actually highlighted, not whatever ended up at its old slot");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 556's finding: handleShowAll's own fresh re-fetch (with no sample
 * cap) always produced a correct, up-to-date `displayed` list, but never
 * patched `result.totalMatches` itself -- so when a record disappeared
 * between the original search and the "Show all" click (another tab, a
 * collaborator, a WhatsApp-triggered write), the header kept showing the
 * ORIGINAL (too-high) count, and the "Show all" button stayed visible
 * promising more matches that no longer exist -- clicking it again just
 * re-fetches the exact same, already-complete list forever.
 */
test("GlobalSearchPanel's 'Show all' button disappears once the fresh fetch reveals fewer real matches than the original search counted", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let customerCallCount = 0;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Customer") {
        customerCallCount += 1;
        // Call 1 is the initial search: 7 matches, capped to a 5-row
        // sample with a "Show all" button for the other 2. Call 2 is
        // "Show all"'s own re-fetch -- by then, 2 records have been
        // deleted elsewhere, so only 5 real matches remain.
        const count = customerCallCount === 1 ? 7 : 5;
        const records: EntityRecord[] = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Widget item ${i + 1}` }));
        return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 5);

      const showAllButton = document.querySelector(".global-search-show-all") as HTMLButtonElement;
      assert.ok(showAllButton, "expected a 'Show all' button for the original 7-match count");
      fireEvent.click(showAllButton);

      // The fresh fetch only has 5 real matches left -- every one of them
      // must now be shown, with nothing stale left over from the original 7.
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 5);

      // Checked as a boolean (not a bare assert.equal(node, null)) so a
      // genuine failure here reports cleanly instead of node:test trying to
      // serialize the still-attached React Fiber tree on the live button
      // element for its diff message.
      let showAllButtonGone = false;
      try {
        await waitForCondition(() => document.querySelector(".global-search-show-all") === null, 10);
        showAllButtonGone = true;
      } catch {
        showAllButtonGone = false;
      }
      assert.equal(
        showAllButtonGone,
        true,
        "the 'Show all' button must disappear once the fresh fetch shows every real match actually exists -- it must not keep promising 2 more matches that no longer exist, based on the original search's now-stale totalMatches",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 983's finding: round 556's own fix just above only ever considered
 * a fresh re-fetch count that shrinks but stays positive (e.g. 7 -> 5).
 * When EVERY one of this entity's previously-matching records has since
 * been deleted or edited away (another tab, a collaborator, a WhatsApp-
 * triggered automation write), handleShowAll's own fresh search returns
 * null (searchEntityRecords's documented "nothing matched" contract) --
 * the old code patched totalMatches to a literal 0 instead of removing the
 * group, leaving it permanently stuck on screen: the header still reads
 * "0 results", the hit list is empty, and `remaining` (0 - 0) is never > 0
 * either, so the one button that reaches this code path never reappears --
 * no control anywhere lets the user dismiss it short of typing a whole new
 * query. This also breaks runSearch's own invariant (a 0-match entity is
 * filtered out of `results` and never shown at all).
 */
test("GlobalSearchPanel's entity group disappears entirely, not stuck showing '0 results', once every real match is gone by the time 'Show all' re-fetches", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let customerCallCount = 0;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Customer") {
        customerCallCount += 1;
        // Call 1 is the initial search: 7 matches, capped to a 5-row
        // sample with a "Show all" button for the other 2. Call 2 is
        // "Show all"'s own re-fetch -- by then every matching record has
        // been edited/deleted elsewhere, so none of the 7 still match.
        const records: EntityRecord[] =
          customerCallCount === 1
            ? Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Widget item ${i + 1}` }))
            : Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Renamed away ${i + 1}` }));
        return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 5);

      const showAllButton = document.querySelector(".global-search-show-all") as HTMLButtonElement;
      assert.ok(showAllButton, "expected a 'Show all' button for the original 7-match count");
      fireEvent.click(showAllButton);

      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 0);

      assert.equal(
        document.querySelectorAll(".global-search-group").length,
        0,
        "the Customer group must be removed entirely, not left stuck showing '0 results' with an empty list and no 'Show all' button to dismiss it",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 904: unlike runSearch (which clears `error` at its own start,
 * line 124), handleShowAll only ever SET `error` (in its round-663 catch
 * block) and never cleared it on success -- a failed "Show all" attempt
 * left its error banner showing forever, even after the user retried the
 * exact same "Show all" button and it succeeded, since nothing short of
 * starting a whole new top-level search (runSearch's own unrelated clear)
 * could ever remove it.
 */
test("GlobalSearchPanel's 'Show all' button clears a stale error banner from an earlier failed 'Show all' attempt, once retried successfully", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let customerCallCount = 0;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Customer") {
        customerCallCount += 1;
        if (customerCallCount === 2) {
          // The initial search (call 1) succeeds; this entity's own first
          // "Show all" attempt (call 2) fails.
          return new Response(JSON.stringify({ error: "Show all failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        const records: EntityRecord[] = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Widget item ${i + 1}` }));
        return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Order") {
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 5);

      const showAllButton = document.querySelector(".global-search-show-all") as HTMLButtonElement;
      assert.ok(showAllButton, "expected a 'Show all' button for the original 7-match count");
      fireEvent.click(showAllButton);
      await waitForCondition(() => document.querySelector(".error") !== null);
      assert.match(document.body.textContent ?? "", /Show all failed/, "expected the failed 'Show all' attempt's error banner to render");

      // Click the SAME "Show all" button again (the natural retry action),
      // which this time succeeds.
      fireEvent.click(document.querySelector(".global-search-show-all") as HTMLButtonElement);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 7);

      // Checked as a boolean, not a bare assert.equal(node, null) -- see
      // the round-556 test above for why.
      assert.equal(document.querySelector(".error") === null, true, "the stale error banner must not survive a later, successful retry of the exact same 'Show all' action");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 519's finding: unlike handleSubmit and handleRecentSearchClick (both
 * of which call setExpandedSamples({}) before runSearch), the error banner's
 * Retry button called runSearch directly -- so a "Show all" expansion made
 * before a partial-failure Retry survived the retry's own fresh fetch,
 * leaving a stale sample on screen (with a "jump to record" target that may
 * no longer even exist) instead of the newly re-fetched data.
 */
test("GlobalSearchPanel's Retry button clears a stale 'Show all' expansion instead of keeping outdated samples", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let customerCallCount = 0;
    let orderCallCount = 0;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/entities/Customer") {
        customerCallCount += 1;
        // Call 1 is the initial search, call 2 is "Show all"'s own
        // re-fetch -- both still see the original 7 matches. Call 3 is
        // the Retry's fresh fetch, where real-world data has since
        // changed to only 2 matches.
        if (customerCallCount <= 2) {
          const records: EntityRecord[] = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Widget item ${i + 1}` }));
          return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const records: EntityRecord[] = [{ id: 101, name: "Widget item FRESH-A" }, { id: 102, name: "Widget item FRESH-B" }];
        return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/api/projects/proj1/entities/Order") {
        orderCallCount += 1;
        if (orderCallCount === 1) {
          return new Response(JSON.stringify({ error: "Server exploded" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderGlobalSearchPanel(() => {});

      const input = document.querySelector(".global-search-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.submit(document.querySelector("form.global-search-form")!);

      // Partial failure: Customer's 7 matches show (capped at a 5-row
      // sample) alongside the error+Retry row from Order's failure.
      await waitForCondition(
        () => document.querySelector(".error-retry-row") !== null && document.querySelectorAll(".global-search-hit-button").length === 5,
      );

      const showAllButton = document.querySelector(".global-search-show-all") as HTMLButtonElement;
      assert.ok(showAllButton, "expected a 'Show all' button for Customer's 7 matches");
      fireEvent.click(showAllButton);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 7);
      assert.ok(
        Array.from(document.querySelectorAll(".global-search-hit-button")).some((el) => el.textContent?.includes("Widget item 7")),
        "expected the full 7-record 'Show all' sample before retrying",
      );

      const retryButton = document.querySelector(".error-retry-row button") as HTMLButtonElement;
      fireEvent.click(retryButton);

      // After Retry, both entities succeed with fresh data -- the error row disappears.
      await waitForCondition(() => document.querySelector(".error-retry-row") === null);
      await waitForCondition(() => document.querySelectorAll(".global-search-hit-button").length === 2);

      const hitTexts = Array.from(document.querySelectorAll(".global-search-hit-button")).map((el) => el.textContent ?? "");
      assert.ok(
        hitTexts.some((t) => t.includes("FRESH-A")) && hitTexts.some((t) => t.includes("FRESH-B")),
        "Retry must show the freshly re-fetched records",
      );
      assert.ok(
        !hitTexts.some((t) => t.includes("Widget item 7")),
        "Retry must drop the stale 'Show all' expansion from before the retry, not keep showing the old 7-record sample",
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
              userId: "user1",
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

/**
 * Round 790: handleShowAll's own fresh re-fetch (used both to display
 * this entity's full results and, per round 556, to patch its own
 * totalMatches) never wrote that fresh data back into
 * lastRecordsByEntityRef -- the shared cache every entity's relation-field
 * matching reads from (the identical mechanism the test above confirms).
 * So a DIFFERENT entity's own later "Show all" click kept resolving a
 * relation pointing at the just-refreshed entity from the ORIGINAL
 * search's now-stale snapshot, not the data "Show all" just fetched --
 * even though that data is already sitting in memory from the very
 * request that just completed.
 */
test("GlobalSearchPanel's 'Show all' on one entity refreshes the relation-label cache other entities' own 'Show all' then reads", async () => {
  const courierEntity: Entity = { name: "Courier", label: "Courier", fields: [{ name: "name", label: "Name", type: "text", required: true }] };
  const orderEntity: Entity = {
    name: "Order",
    label: "Order",
    fields: [
      { name: "item", label: "Item", type: "text", required: true },
      { name: "courierId", label: "Courier", type: "relation", relationTo: "Courier", required: false },
    ],
  };
  const makeCouriers = (firstName: string): EntityRecord[] =>
    Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: i === 0 ? firstName : `Dana ${i + 1}` }));
  const orders: EntityRecord[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, item: `Delivery ${i + 1}`, courierId: i + 1 }));

  const originalFetch = globalThis.fetch;
  let courierCallCount = 0;
  globalThis.fetch = (async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/entities/Courier") {
      courierCallCount += 1;
      // Call 1 is the initial search (courier #1 is still "Dana 1", so all
      // 6 couriers -- and, via relation, all 6 orders -- match "Dana").
      // Call 2 is "Show all" on Courier itself, by which point courier #1
      // has been renamed to "Bob Cohen" elsewhere (a collaborator, another
      // tab) -- it no longer matches "Dana" at all.
      const records = makeCouriers(courierCallCount === 1 ? "Dana 1" : "Bob Cohen");
      return new Response(JSON.stringify({ records }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (input === "/api/projects/proj1/entities/Order") {
      // Orders themselves never change between calls -- only the Courier
      // they relate to does.
      return new Response(JSON.stringify({ records: orders }), { status: 200, headers: { "content-type": "application/json" } });
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
              userId: "user1",
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
      await waitForCondition(() => document.querySelectorAll(".global-search-group").length === 2);

      // Both groups start with 6 real matches (the 5-row sample cap leaves
      // one "Show all" button per group).
      const showAllButtons = () => [...document.querySelectorAll(".global-search-show-all")] as HTMLButtonElement[];
      assert.equal(showAllButtons().length, 2, "both Courier and Order must initially have more than 5 matches each");

      // "Show all" on Courier: courier #1 is now "Bob Cohen" -- its own
      // count correctly drops to 5, and the fresh data must now be the
      // one Order's own "Show all" (clicked next) reads for its relation
      // matching too.
      const courierGroup = [...document.querySelectorAll(".global-search-group")].find((g) => g.textContent?.includes("Courier"))!;
      fireEvent.click(courierGroup.querySelector(".global-search-show-all") as HTMLButtonElement);
      await waitForCondition(() => courierCallCount === 2);
      await waitForCondition(() => courierGroup.querySelector(".global-search-show-all") === null);

      // "Show all" on Order: must now correctly report only 5 matches --
      // the order whose courier is now "Bob Cohen" no longer matches
      // "Dana" -- not the original, stale 6.
      const orderGroup = [...document.querySelectorAll(".global-search-group")].find((g) => g.textContent?.includes("Order"))!;
      const orderShowAll = orderGroup.querySelector(".global-search-show-all") as HTMLButtonElement;
      assert.ok(orderShowAll, "Order must still have its own 'Show all' button at this point");
      fireEvent.click(orderShowAll);

      // The button's own disappearance only proves the async update has
      // landed (it disappears either way, since handleShowAll always sets
      // totalMatches to whatever it just computed as the sample size,
      // making `remaining` 0 regardless of whether that computed size is
      // the correct 5 or the stale 6) -- the REAL discriminator is the
      // final hit-button count checked right after.
      let orderShowAllGone = false;
      try {
        await waitForCondition(() => orderGroup.querySelector(".global-search-show-all") === null, 10);
        orderShowAllGone = true;
      } catch {
        orderShowAllGone = false;
      }
      assert.equal(orderShowAllGone, true, "Order's own 'Show all' must complete and disappear once clicked");
      assert.equal(
        orderGroup.querySelectorAll(".global-search-hit-button").length,
        5,
        "Order's own 'Show all' must report 5 real matches using the courier data Courier's own 'Show all' just refreshed -- not the original search's stale 6, which would wrongly still include the order whose courier is now 'Bob Cohen'",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 361: the query box had zero Escape handling at all -- pressing
 * Escape while typing a query closed the WHOLE panel (useDialogFocusTrap's
 * own native keydown listener on the dialog container), exactly the bug
 * class fixed in HistoryPanel/WhatsAppPanel (rounds 358-360). Same fix:
 * a "Clear search" button + local Escape-to-clear, protected by the
 * data-escape-handled-locally marker so useDialogFocusTrap's own native
 * listener skips calling onClose() for this input and lets the event keep
 * bubbling normally. Uses a real onClose spy (not the shared helper's
 * no-op) so a false-positive "it works" can't hide a dialog that actually
 * closed underneath the test.
 *
 * Round 362 update: the marker was originally unconditional, which traded
 * one bug for another -- Escape on an already-EMPTY, focused query box did
 * nothing at all, instead of closing the dialog like every other focused
 * control. Now covers that case too: the marker is only present while
 * query.length > 0, so an empty box's Escape falls through to
 * useDialogFocusTrap's own close-the-dialog behavior normally.
 */
test("GlobalSearchPanel's query box has a 'Clear search' button and Escape-to-clear, and neither one closes the whole dialog", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockGlobalSearchFetch() as typeof fetch;
    let closeCalls = 0;
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
              userId: "user1",
              projectName: "Test Project",
              entities: [SEARCH_CUSTOMER_ENTITY, SEARCH_ORDER_ENTITY],
              onClose: () => {
                closeCalls += 1;
              },
              onJumpToEntity: () => {},
              onJumpToRecord: () => {},
            }),
          ),
        ),
      );

      const input = document.querySelector(".global-search-input") as HTMLInputElement;

      assert.equal(
        document.querySelector(".global-search-clear-query") == null,
        true,
        "no Clear button should exist before anything is typed",
      );

      fireEvent.change(input, { target: { value: "widget" } });
      assert.equal(
        document.querySelector(".global-search-clear-query") == null,
        false,
        "the Clear button must appear the moment the query box has text",
      );

      fireEvent.keyDown(input, { key: "Escape" });
      assert.equal(input.value, "", "Escape with text in the box must clear the query");
      assert.equal(closeCalls, 0, "clearing the query via Escape must never also close the whole dialog");
      assert.equal(
        document.querySelector('[role="dialog"]') == null,
        false,
        "the dialog must still be in the DOM after Escape cleared the query",
      );

      // Round 362 regression fix: this used to assert Escape on an
      // already-empty box was a harmless no-op, but it actually did
      // nothing at all -- data-escape-handled-locally sat on this input
      // unconditionally, so useDialogFocusTrap's own Escape listener
      // always skipped closing regardless of whether there was anything
      // left to clear locally. The marker is now conditional on
      // query.length > 0, so Escape on an empty, focused box closes the
      // dialog normally, matching every other focused control in it.
      fireEvent.keyDown(input, { key: "Escape" });
      assert.equal(closeCalls, 1, "Escape on an already-empty query box must close the dialog normally, not get silently swallowed");

      fireEvent.change(input, { target: { value: "acme" } });
      const clearButton = document.querySelector(".global-search-clear-query") as HTMLButtonElement;
      fireEvent.click(clearButton);
      assert.equal(input.value, "", "clicking the Clear button must empty the query");
      assert.equal(
        document.querySelector(".global-search-clear-query") == null,
        true,
        "the Clear button must disappear once the query is empty again",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
