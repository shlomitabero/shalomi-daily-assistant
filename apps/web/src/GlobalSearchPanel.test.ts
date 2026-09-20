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
    "setSelectedIndex",
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
    "setSelectedIndex",
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
  ) as (q: string) => Promise<void>;

  await fn("match");

  assert.equal(capturedError, rejection.message);
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

function renderGlobalSearchPanel(onJumpToEntity: (entityName: string) => void) {
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
