import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { BusinessTwin } from "./api.js";
import { BusinessTwinPanel } from "./BusinessTwinPanel.js";
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

const TWIN: BusinessTwin = {
  summary: "A CRM",
  roles: ["Owner"],
  entities: [
    { name: "Customer", label: "Customers", count: 12 },
    { name: "Order", label: "Orders", count: 4 },
  ],
  totalRecords: 16,
  mostActive: { name: "Customer", label: "Customers", count: 12 },
  unused: [],
  observations: [],
};

function mockTwinFetch() {
  return async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/twin") {
      return new Response(JSON.stringify({ twin: TWIN }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${input}`);
  };
}

function renderTwinPanel(onJumpToEntity: (entityName: string) => void) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(BusinessTwinPanel, {
          projectId: "proj1",
          projectName: "Test CRM",
          onClose: () => {},
          onJumpToEntity,
        }),
      ),
    ),
  );
}

/**
 * New in this round: each stat tile in Business Twin ("Customers · 12") is
 * now a real clickable button, not inert display text -- clicking it should
 * take you straight to that entity's own records (closing the twin panel in
 * the process), the same "jump to X" pattern GlobalSearchPanel's own
 * onJumpToEntity already established, instead of making someone close the
 * panel and hunt for the right tab themselves.
 */
test("BusinessTwinPanel's stat tiles are clickable and call onJumpToEntity with that tile's own entity name", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    const jumps: string[] = [];
    try {
      renderTwinPanel((entityName) => jumps.push(entityName));
      await waitForCondition(() => document.querySelectorAll(".twin-stat-tile").length === 2);

      const tiles = Array.from(document.querySelectorAll(".twin-stat-tile")) as HTMLButtonElement[];
      assert.equal(tiles[0].tagName, "BUTTON", "a stat tile must be a real clickable button, not an inert div");

      const ordersTile = tiles.find((el) => /Orders/.test(el.textContent ?? ""))!;
      assert.ok(ordersTile, "expected to find the Orders tile by its own label text");
      fireEvent.click(ordersTile);

      assert.deepEqual(jumps, ["Order"], "must call onJumpToEntity with the CLICKED tile's own entity name (Order), not some other entity or the label text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("BusinessTwinPanel's stat tile has a real accessible label naming which entity it jumps to", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelectorAll(".twin-stat-tile").length === 2);

      const tiles = Array.from(document.querySelectorAll(".twin-stat-tile")) as HTMLButtonElement[];
      const customersTile = tiles.find((el) => /Customers/.test(el.textContent ?? ""))!;
      assert.match(
        customersTile.getAttribute("aria-label") ?? "",
        /Customers/,
        "the accessible label must name the real entity this tile jumps to, for anyone not reading the visual layout",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
