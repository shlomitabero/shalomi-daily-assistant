import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
  mostLinkedRecord: null,
  mostActiveObservation: null,
  jumpableObservations: [],
  distributions: [],
  numericStats: [],
  overdueStats: [],
  dueSoonStats: [],
};

function mockTwinFetch() {
  return async (input: string): Promise<Response> => {
    if (input === "/api/projects/proj1/twin") {
      return new Response(JSON.stringify({ twin: TWIN }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${input}`);
  };
}

function renderTwinPanel(
  onJumpToEntity: (entityName: string, dateFilter?: { fieldName: string; value: string }) => void,
  onJumpToRecord: (entityName: string, recordId: number) => void = () => {},
) {
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
          onJumpToRecord,
        }),
      ),
    ),
  );
}

/**
 * Round 1135: a fresh survey found this toggle (and two siblings elsewhere
 * in the app -- LanguageSwitcher.tsx's language toggle, EntityPanel.tsx's
 * table/board/calendar view toggle, plus codegen.ts's own copy of the
 * EntityPanel one) marked its selected option with nothing but a CSS class
 * (`view-toggle-btn-active`), invisible to a screen reader -- the exact
 * WCAG 4.1.2 gap PasswordInput.tsx's own show/hide toggle already avoids
 * via `aria-pressed`.
 */
test("BusinessTwinPanel's Dashboard/Report toggle reports its selected state via aria-pressed, not just a CSS class", async () => {
  await withJsdom(async () => {
    const twinWithObservation: BusinessTwin = { ...TWIN, observations: ["Something worth noting"] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithObservation }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelectorAll(".view-toggle-btn").length === 2);

      const [dashboardBtn, reportBtn] = document.querySelectorAll(".view-toggle-btn") as NodeListOf<HTMLButtonElement>;
      // Defaults to "report", not "dashboard" -- see this panel's own doc comment.
      assert.equal(reportBtn.getAttribute("aria-pressed"), "true", "the view this panel opens into (Report) must report aria-pressed=true");
      assert.equal(dashboardBtn.getAttribute("aria-pressed"), "false");

      fireEvent.click(dashboardBtn);
      assert.equal(dashboardBtn.getAttribute("aria-pressed"), "true", "clicking Dashboard must flip its own aria-pressed to true");
      assert.equal(reportBtn.getAttribute("aria-pressed"), "false", "switching views must flip the previously-selected button's aria-pressed back to false");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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

/**
 * New in this round: computeRelationHubObservation (twin.ts) already
 * resolves the "most-linked record" insight down to a real, specific
 * entityName+id -- but until now that fact was thrown away and the
 * insight rendered as plain, inert text in the observations list, the
 * same "jump to entity, not the record" gap round 174/175 already closed
 * for Global Search and WhatsApp. Confirms the insight now renders as a
 * real clickable button (not a plain <li>) and calls onJumpToRecord with
 * the exact real entityName+id the server resolved, not onJumpToEntity.
 */
test("BusinessTwinPanel's most-linked-record insight is a real clickable button that calls onJumpToRecord with the real entity+record id", async () => {
  await withJsdom(async () => {
    const twinWithHub: BusinessTwin = {
      ...TWIN,
      observations: ["No records yet in: Orders."],
      mostLinkedRecord: { text: '"Dana Levi" (Customers) is the most-linked record: 3 links total.', entityName: "Customer", recordId: 7 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithHub }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const entityJumps: string[] = [];
    const recordJumps: [string, number][] = [];
    try {
      renderTwinPanel(
        (entityName) => entityJumps.push(entityName),
        (entityName, recordId) => recordJumps.push([entityName, recordId]),
      );
      await waitForCondition(() => document.querySelector(".twin-observation-link") !== null);

      const hubButton = document.querySelector(".twin-observation-link") as HTMLButtonElement;
      assert.equal(hubButton.tagName, "BUTTON", "the most-linked-record insight must be a real clickable button, not inert text");
      assert.match(hubButton.textContent ?? "", /Dana Levi/);

      const plainObservations = document.querySelectorAll(".twin-observations li:not(:has(button))");
      assert.equal(plainObservations.length, 1, "the OTHER plain-text observation must still render as inert text, unaffected");

      fireEvent.click(hubButton);
      assert.deepEqual(recordJumps, [["Customer", 7]], "must call onJumpToRecord with the real entityName and recordId the server resolved");
      assert.deepEqual(entityJumps, [], "clicking the most-linked-record insight must not also fire the entity-only onJumpToEntity");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the "most active entity" fact was previously only
 * ever pushed into the plain-text `observations` array as inert prose --
 * the exact same "can't jump to it" gap the test above already closed for
 * mostLinkedRecord. Confirms it now renders as a real clickable button
 * (not a plain <li>) and calls onJumpToEntity with the real entity name
 * the server resolved, not onJumpToRecord (there's no specific record here,
 * just an entity-level stat).
 */
test("BusinessTwinPanel's most-active-entity insight is a real clickable button that calls onJumpToEntity with the real entity name", async () => {
  await withJsdom(async () => {
    const twinWithMostActive: BusinessTwin = {
      ...TWIN,
      observations: ["No records yet in: Orders."],
      mostActiveObservation: { text: 'Most activity is in "Customers" — 12 records.', entityName: "Customer" },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithMostActive }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const entityJumps: string[] = [];
    const recordJumps: [string, number][] = [];
    try {
      renderTwinPanel(
        (entityName) => entityJumps.push(entityName),
        (entityName, recordId) => recordJumps.push([entityName, recordId]),
      );
      await waitForCondition(() => document.querySelector(".twin-observation-link") !== null);

      const mostActiveButton = document.querySelector(".twin-observation-link") as HTMLButtonElement;
      assert.equal(mostActiveButton.tagName, "BUTTON", "the most-active-entity insight must be a real clickable button, not inert text");
      assert.match(mostActiveButton.textContent ?? "", /Customers/);

      const plainObservations = document.querySelectorAll(".twin-observations li:not(:has(button))");
      assert.equal(plainObservations.length, 1, "the OTHER plain-text observation must still render as inert text, unaffected");

      fireEvent.click(mostActiveButton);
      assert.deepEqual(entityJumps, ["Customer"], "must call onJumpToEntity with the real entity name the server resolved");
      assert.deepEqual(recordJumps, [], "clicking the most-active-entity insight must not also fire the record-specific onJumpToRecord");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: relation-coverage and duplicate-detection facts
 * (twin.jumpableObservations) each name one specific real entity, the same
 * "can't jump to it" gap already closed above for mostLinkedRecord and
 * mostActiveObservation. Confirms each renders as a real clickable button
 * (not a plain <li>) and calls onJumpToEntity with the real entity name,
 * and that a genuinely plain observation in the same list is unaffected.
 */
test("BusinessTwinPanel's jumpable observations (relation-coverage, duplicates) render as real clickable buttons that call onJumpToEntity", async () => {
  await withJsdom(async () => {
    const twinWithJumpable: BusinessTwin = {
      ...TWIN,
      observations: ["No records yet in: Orders."],
      jumpableObservations: [
        { text: 'In "Tickets", 2 of 3 records have no "Customer" set.', entityName: "Ticket" },
        { text: 'In "Customers", 2 records share the name "Dana Levi" — possibly a duplicate.', entityName: "Customer" },
      ],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithJumpable }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const entityJumps: string[] = [];
    const recordJumps: [string, number][] = [];
    try {
      renderTwinPanel(
        (entityName) => entityJumps.push(entityName),
        (entityName, recordId) => recordJumps.push([entityName, recordId]),
      );
      await waitForCondition(() => document.querySelectorAll(".twin-observation-link").length === 2);

      const jumpableButtons = document.querySelectorAll(".twin-observation-link") as NodeListOf<HTMLButtonElement>;
      assert.equal(jumpableButtons.length, 2, "both jumpable observations must render as real clickable buttons");
      assert.match(jumpableButtons[0].textContent ?? "", /Tickets/);
      assert.match(jumpableButtons[1].textContent ?? "", /Dana Levi/);

      const plainObservations = document.querySelectorAll(".twin-observations li:not(:has(button))");
      assert.equal(plainObservations.length, 1, "the OTHER plain-text observation must still render as inert text, unaffected");

      fireEvent.click(jumpableButtons[1]);
      assert.deepEqual(entityJumps, ["Customer"], "must call onJumpToEntity with the real entity name from the clicked observation");
      assert.deepEqual(recordJumps, [], "jumpable observations must never fire the record-specific onJumpToRecord");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: computeBusinessTwin has always computed a real
 * totalRecords figure -- it was already included in the downloadable text
 * report (round 129's twinReport.ts) -- but the live panel itself never
 * showed it; you'd have to download a file just to see a number already
 * sitting in memory. Confirms the real count from the fetched twin renders
 * on screen, not a hardcoded placeholder or the wrong field (e.g. entity
 * count instead of record count).
 */
test("BusinessTwinPanel shows the real total-records count from the fetched twin, not a placeholder", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-total") !== null);

      const totalEl = document.querySelector(".twin-total");
      assert.match(totalEl!.textContent ?? "", /16/, "must show the real totalRecords value (16) from the fetched twin, not a placeholder or the entity count (2)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1138: a fresh survey found that `twin.summary` -- the one-line
 * description of the project's own business/app domain (the same text
 * shown on the Home screen's project card, `App.tsx`) -- is pushed as the
 * very first content line of `formatTwinReport`'s Copy/Download output,
 * but was never rendered in the live panel at all: a person opening
 * Business Twin to get oriented on "what is this" could only see that one
 * sentence by exporting the report and reading the text file.
 */
test("BusinessTwinPanel shows the project's own twin.summary text, the same content its Copy/Download report leads with", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-summary") !== null);

      assert.match(document.querySelector(".twin-summary")!.textContent ?? "", /A CRM/, "must show the real twin.summary text from the fetched twin");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Mirrors formatTwinReport's own `.trim().length > 0` guard -- a blank summary must render nothing, not an empty paragraph. */
test("BusinessTwinPanel renders no summary element at all when twin.summary is blank", async () => {
  await withJsdom(async () => {
    const blankSummaryTwin: BusinessTwin = { ...TWIN, summary: "   " };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: blankSummaryTwin }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-total") !== null);

      assert.equal(document.querySelector(".twin-summary"), null, "a blank summary must not render an empty paragraph");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the fixture below deliberately lists the busiest
 * entity LAST and a zero-count entity in the middle, mirroring the exact
 * "declaration order, not activity order" shape the server actually
 * returns -- if the panel just rendered `twin.entities` as-is, this test
 * would see the wrong tile first. Also confirms the visual "empty" marker
 * only ever applies to the genuinely empty tile, never to a real one.
 */
test("BusinessTwinPanel renders stat tiles sorted by real record count (busiest first), and visually marks the empty one", async () => {
  await withJsdom(async () => {
    const outOfOrderTwin: BusinessTwin = {
      summary: "A CRM",
      roles: ["Owner"],
      entities: [
        { name: "Ticket", label: "Tickets", count: 3 },
        { name: "Order", label: "Orders", count: 0 },
        { name: "Customer", label: "Customers", count: 12 },
      ],
      totalRecords: 15,
      mostActive: { name: "Customer", label: "Customers", count: 12 },
      unused: [{ name: "Order", label: "Orders", count: 0 }],
      observations: [],
      mostLinkedRecord: null,
      mostActiveObservation: null,
      jumpableObservations: [],
      distributions: [],
      numericStats: [],
      overdueStats: [],
      dueSoonStats: [],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: outOfOrderTwin }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelectorAll(".twin-stat-tile").length === 3);

      const tiles = Array.from(document.querySelectorAll(".twin-stat-tile"));
      const labels = tiles.map((el) => el.querySelector(".twin-stat-label")!.textContent);
      assert.deepEqual(
        labels,
        ["Customers", "Tickets", "Orders"],
        "expected the real record-count order (12, 3, 0), not the server's own declaration order (Tickets, Orders, Customers)",
      );

      const ordersTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent === "Orders")!;
      assert.ok(
        ordersTile.classList.contains("twin-stat-tile-empty"),
        "the genuinely empty (0-record) tile must carry the visual empty marker",
      );
      const nonEmptyTiles = tiles.filter((el) => el !== ordersTile);
      for (const tile of nonEmptyTiles) {
        assert.equal(
          tile.classList.contains("twin-stat-tile-empty"),
          false,
          "a tile with real records must never carry the empty marker",
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


/**
 * New in this round: each tile already showed its own raw count and the
 * panel showed a separate grand total, but never how the two relate --
 * confirms the real per-entity share renders on the non-empty tiles (using
 * the exact fixture's own real numbers, 12/16=75% and 4/16=25%, not
 * hardcoded placeholders), and that the genuinely empty tile shows no
 * percent at all (0% of a real total is not a useful fact to state).
 */
test("BusinessTwinPanel shows each non-empty tile's real share of total records, and omits it for the empty tile", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelectorAll(".twin-stat-tile").length === 2);

      const tiles = Array.from(document.querySelectorAll(".twin-stat-tile"));
      const customersTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent === "Customers")!;
      const ordersTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent === "Orders")!;

      assert.match(customersTile.querySelector(".twin-stat-percent")!.textContent ?? "", /75/, "Customers (12 of 16) must show its real 75% share");
      assert.match(ordersTile.querySelector(".twin-stat-percent")!.textContent ?? "", /25/, "Orders (4 of 16) must show its real 25% share");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("BusinessTwinPanel omits the percent line for a genuinely empty (0-record) tile", async () => {
  await withJsdom(async () => {
    const outOfOrderTwin: BusinessTwin = {
      summary: "A CRM",
      roles: ["Owner"],
      entities: [
        { name: "Order", label: "Orders", count: 0 },
        { name: "Customer", label: "Customers", count: 12 },
      ],
      totalRecords: 12,
      mostActive: { name: "Customer", label: "Customers", count: 12 },
      unused: [{ name: "Order", label: "Orders", count: 0 }],
      observations: [],
      mostLinkedRecord: null,
      mostActiveObservation: null,
      jumpableObservations: [],
      distributions: [],
      numericStats: [],
      overdueStats: [],
      dueSoonStats: [],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: outOfOrderTwin }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelectorAll(".twin-stat-tile").length === 2);

      const tiles = Array.from(document.querySelectorAll(".twin-stat-tile"));
      const ordersTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent === "Orders")!;
      assert.equal(
        ordersTile.querySelector(".twin-stat-percent") === null,
        true,
        "a 0-record tile must not show a '0% of records' line -- it's not a useful fact",
      );
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

/**
 * New in this round: a failed initial fetch (a transient network blip, a
 * cold-starting backend) used to permanently strand the panel showing only
 * the error message, with no way to recover except closing and reopening
 * it. Mocks a fetch that rejects the FIRST call and succeeds the second, to
 * confirm the real Retry button actually re-triggers the same fetch (not
 * just clears the error text) and the panel recovers to show the real twin
 * data once that second call succeeds.
 */
test("BusinessTwinPanel's Retry button re-fetches after a failed load and recovers to show the real data", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: string): Promise<Response> => {
      if (input === "/api/projects/proj1/twin") {
        callCount += 1;
        // A real HTTP error response (not a thrown/rejected fetch) --
        // request()'s own fetchWithWakeRetry only retries a genuine
        // thrown network failure, never a resolved non-2xx response, so
        // this deterministically fails exactly once without tripping its
        // real retry-with-backoff loop (which sleeps for real time this
        // test's own tick-based waitForCondition can't fast-forward).
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Server error", code: "REQUEST_FAILED" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ twin: TWIN }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".error") !== null);

      const retryButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Try again");
      assert.ok(retryButton, "expected a Retry button once the initial load fails");
      assert.equal(callCount, 1, "must not have retried on its own yet");
      assert.equal(document.querySelector(".error")!.getAttribute("role"), "status", "the error must be announced to screen readers, not just shown visually");

      fireEvent.click(retryButton!);
      await waitForCondition(() => document.querySelector(".twin-total") !== null);

      assert.equal(callCount, 2, "clicking Retry must trigger a real second fetch call");
      assert.equal(document.querySelector(".error"), null, "the error must be cleared once the retry succeeds");
      assert.match(document.querySelector(".twin-total")!.textContent ?? "", /16/, "must show the real data once the retry succeeds");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * New in this round: the report was already plain, shareable text
 * (formatTwinReport's own comment -- WhatsApp, email, paste anywhere) but
 * the only way to actually get it anywhere was a real file download. This
 * new Copy button calls the real navigator.clipboard.writeText with that
 * exact same formatted text, shows a transient "Copied!" label, and fades
 * back to its normal label a couple seconds later -- mirroring
 * EntityPanel's own auto-fading highlight (round 174) via a real,
 * mocked setTimeout rather than a hardcoded wait.
 */
test("BusinessTwinPanel's copy button writes the real formatted report to the clipboard, shows Copied, then reverts", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    let writtenText: string | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void (writtenText = text) },
      configurable: true,
    });
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-total") !== null);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "📋 Copy report");
      assert.ok(copyButton, "expected a Copy report button once the twin has loaded");
      assert.equal(
        copyButton!.getAttribute("aria-live"),
        "polite",
        "the copy button's own changing label must be announced to screen readers, not just silently change visually",
      );
      assert.equal(copyButton!.getAttribute("aria-atomic"), "true", "the whole button's text must be re-announced, not just the changed part");

      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(typeof writtenText, "string", "clicking Copy must actually call navigator.clipboard.writeText");
      assert.match(writtenText!, /Test CRM/, "the copied text must be the real formatted report, not a placeholder");
      assert.equal(copyButton!.textContent, "✅ Copied!", "must show the real Copied confirmation, not silently do nothing");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy report", "must revert to the normal label once the delay elapses");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/** The other half: a real rejection (denied permission, insecure context) must show a real failure label, not fail silently or crash. */
test("BusinessTwinPanel's copy button shows a failure label when navigator.clipboard.writeText rejects", async (t) => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockTwinFetch() as typeof fetch;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-total") !== null);

      t.mock.timers.enable({ apis: ["setTimeout"] });

      const copyButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "📋 Copy report");
      await act(async () => {
        fireEvent.click(copyButton!);
        await Promise.resolve();
        await Promise.resolve();
      });

      assert.equal(copyButton!.textContent, "Copy failed", "a real clipboard rejection must show a real failure label");

      act(() => {
        t.mock.timers.tick(2000);
      });
      assert.equal(copyButton!.textContent, "📋 Copy report", "must revert to the normal label even after a failure");
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

/**
 * New: the Dashboard view -- a real bar chart per enum/boolean
 * distribution and a stat tile per numeric aggregate, both built from
 * twin.distributions/twin.numericStats directly (not re-parsed from
 * prose). Defaults to the Report view (see BusinessTwinPanel.tsx's own
 * comment on its `view` state) so every pre-existing test above keeps
 * working unchanged; this test explicitly switches to Dashboard.
 */
const TWIN_WITH_CHARTS: BusinessTwin = {
  ...TWIN,
  distributions: [
    {
      text: '"Status" breakdown in "Orders": 2 "Pending", 1 "Shipped".',
      entityName: "Order",
      entityLabel: "Orders",
      fieldName: "status",
      fieldLabel: "Status",
      breakdown: [
        { value: "Pending", label: "Pending", count: 2 },
        { value: "Shipped", label: "Shipped", count: 1 },
      ],
    },
  ],
  numericStats: [
    {
      text: 'Total "Total" in "Orders": 400 (average 200 across 2 records).',
      entityName: "Order",
      entityLabel: "Orders",
      fieldName: "total",
      fieldLabel: "Total",
      sum: 400,
      average: 200,
      recordCount: 2,
    },
  ],
};

test("BusinessTwinPanel's Dashboard view renders a real bar chart from twin.distributions and a stat tile from twin.numericStats", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: TWIN_WITH_CHARTS }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-view-toggle") !== null);

      // Defaults to Report -- the dashboard's own chart content must not
      // be in the DOM at all until the person switches to it.
      assert.equal(document.querySelector(".twin-chart"), null, "dashboard content must not render before the Dashboard view is chosen");

      const dashboardButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Dashboard"));
      fireEvent.click(dashboardButton!);

      await waitForCondition(() => document.querySelector(".twin-chart") !== null);
      const rows = Array.from(document.querySelectorAll(".twin-chart-row"));
      assert.equal(rows.length, 2, "one bar per breakdown value");
      assert.equal(rows[0]!.querySelector(".twin-chart-row-label")!.textContent, "Pending");
      assert.equal(rows[0]!.querySelector(".twin-chart-row-value")!.textContent, "2");
      assert.equal(rows[1]!.querySelector(".twin-chart-row-label")!.textContent, "Shipped");
      assert.equal(rows[1]!.querySelector(".twin-chart-row-value")!.textContent, "1");

      // The larger bucket's bar must actually be wider than the smaller
      // one -- the chart encodes magnitude via real bar length, not just
      // listing the numbers in a table.
      const pendingBarWidth = parseFloat((rows[0]!.querySelector(".twin-chart-bar") as HTMLElement).style.width);
      const shippedBarWidth = parseFloat((rows[1]!.querySelector(".twin-chart-bar") as HTMLElement).style.width);
      assert.ok(pendingBarWidth > shippedBarWidth, `expected Pending's bar (${pendingBarWidth}%) to be wider than Shipped's (${shippedBarWidth}%)`);

      const statTile = document.querySelector(".twin-dashboard-stats .twin-stat-tile") as HTMLElement;
      assert.ok(statTile, "expected a stat tile for the numeric aggregate");
      assert.equal(statTile.querySelector(".twin-stat-value")!.textContent, "400");

      // Switching back to Report must restore the original list, and hide the chart again.
      const reportButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Report"));
      fireEvent.click(reportButton!);
      assert.equal(document.querySelector(".twin-chart"), null, "the chart must be gone once switched back to Report");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1343: a fresh survey found the distribution bar chart was the one
 * remaining inert element in the Dashboard view -- every other tile
 * (numericStats, overdueStats, dueSoonStats, mostActiveObservation,
 * jumpableObservations) is already a real clickable button wired to
 * onJumpToEntity (rounds 1332/1337), but a bar row was still a plain,
 * non-interactive <div>. Each breakdown entry's own `value` (twin.ts's
 * computeEnumDistributionObservations builds exactly this -- the raw
 * stored enumValue, or "true"/"false" for a boolean field) is the exact
 * same value EntityPanel.tsx's own field-filter already compares against,
 * so clicking a bar now jumps to the entity with that value pre-applied
 * as the matching toolbar filter, the same mechanism round 1337 built for
 * the overdue/dueSoon stat tiles.
 */
test("BusinessTwinPanel's distribution bar rows are real clickable buttons that call onJumpToEntity with the field's raw breakdown value", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: TWIN_WITH_CHARTS }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const jumps: Array<{ entityName: string; dateFilter?: { fieldName: string; value: string } }> = [];
    try {
      renderTwinPanel((entityName, dateFilter) => {
        jumps.push({ entityName, dateFilter });
      });
      await waitForCondition(() => document.querySelector(".twin-view-toggle") !== null);

      const dashboardButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Dashboard"));
      fireEvent.click(dashboardButton!);
      await waitForCondition(() => document.querySelector(".twin-chart") !== null);

      const rows = Array.from(document.querySelectorAll(".twin-chart-row")) as HTMLButtonElement[];
      assert.equal(rows.length, 2, "one bar per breakdown value");
      for (const row of rows) {
        assert.equal(row.tagName, "BUTTON", "every distribution bar row must be a real clickable button, not an inert div");
      }

      fireEvent.click(rows[0]!);
      assert.deepEqual(
        jumps,
        [{ entityName: "Order", dateFilter: { fieldName: "status", value: "Pending" } }],
        "clicking the Pending bar must jump to Order with status=Pending pre-applied as the filter, using the breakdown's own raw value",
      );

      fireEvent.click(rows[1]!);
      assert.deepEqual(
        jumps[1],
        { entityName: "Order", dateFilter: { fieldName: "status", value: "Shipped" } },
        "clicking a different bar in the same chart must carry that bar's own raw value, not the first bar's",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 703: the Dashboard tab's bar-chart values and stat-tile sum/average
 * were the only numbers in the entire web app formatted with no explicit
 * locale at all (bare toLocaleString()), unlike every other number and date
 * in this codebase, which all pass the app's own LOCALE[lang] (confirmed via
 * entityFormatting.ts's formatNumberValue, now reused here). This app's
 * language is an explicit in-app toggle independent of the browser (see
 * detectInitialLang's own doc comment), so silently falling back to the
 * runtime's default locale means a user who switched the in-app language
 * still gets this one screen's numbers in whatever locale the browser
 * happens to carry. he-IL and en-US render plain digits identically, so this
 * spies on Number.prototype.toLocaleString itself to prove a real, explicit
 * locale string is actually being forwarded -- not just that SOME number
 * came back right.
 */
test("BusinessTwinPanel's Dashboard view formats its bar-chart and stat-tile numbers with the app's own locale, not the runtime default", async () => {
  await withJsdom(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: TWIN_WITH_CHARTS }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const originalToLocaleString = Number.prototype.toLocaleString;
    const capturedLocales: unknown[] = [];
    Number.prototype.toLocaleString = function (this: number, ...args: unknown[]) {
      capturedLocales.push(args[0]);
      return originalToLocaleString.apply(this, args as [string?, Intl.NumberFormatOptions?]);
    } as typeof Number.prototype.toLocaleString;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-view-toggle") !== null);
      const dashboardButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Dashboard"));
      fireEvent.click(dashboardButton!);
      await waitForCondition(() => document.querySelector(".twin-chart") !== null);

      // The test environment's own default language is English (no stored
      // choice, jsdom's own navigator.language) -- so every one of these
      // calls must carry the real "en-US" locale string, never undefined
      // (bare toLocaleString()) and never some other hardcoded value.
      assert.ok(capturedLocales.length > 0, "expected at least one toLocaleString call while rendering the dashboard");
      assert.ok(
        capturedLocales.every((l) => l === "en-US"),
        `expected every toLocaleString call to carry the app's own "en-US" locale, got: ${JSON.stringify(capturedLocales)}`,
      );
    } finally {
      Number.prototype.toLocaleString = originalToLocaleString;
      globalThis.fetch = originalFetch;
    }
  });
});

test("BusinessTwinPanel's Dashboard view shows an empty-state message when there are no distributions or numeric stats to chart", async () => {
  await withJsdom(async () => {
    const twinWithOnlyObservations: BusinessTwin = { ...TWIN, observations: ["No real data has been entered yet."] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithOnlyObservations }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-view-toggle") !== null);

      const dashboardButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Dashboard"));
      fireEvent.click(dashboardButton!);

      await waitForCondition(() => document.body.textContent?.includes("Not enough data yet for the dashboard view") ?? false);
      assert.equal(document.querySelector(".twin-chart"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1329: before this round, a project whose only dashboard-worthy
 * facts were overdue/due-soon deadlines (no numeric aggregates, no enum
 * distributions) fell through to the empty-state message above even
 * though computeBusinessTwin already computed and reported those facts
 * in the Report view -- the data existed, it just had no Dashboard tile.
 * This confirms the Dashboard now renders a real stat tile for each of
 * twin.overdueStats/twin.dueSoonStats, and that the empty-state message
 * no longer wrongly shows when only this data is present.
 */
test("BusinessTwinPanel's Dashboard view renders stat tiles from twin.overdueStats and twin.dueSoonStats", async () => {
  await withJsdom(async () => {
    const overdueStat = {
      text: '"Due date" overdue in "Orders": 2 of 5.',
      entityName: "Order",
      entityLabel: "Orders",
      fieldName: "dueDate",
      fieldLabel: "Due date",
      overdueCount: 2,
      recordCount: 5,
    };
    const dueSoonStat = {
      text: '"Renewal" coming up soon in "Orders": 1 of 5.',
      entityName: "Order",
      entityLabel: "Orders",
      fieldName: "renewal",
      fieldLabel: "Renewal",
      dueSoonCount: 1,
      recordCount: 5,
    };
    // Mirrors computeBusinessTwin's own additive contract (see twin.ts): every
    // overdueStats/dueSoonStats entry also has a matching prose sentence in
    // jumpableObservations -- which is what the view-toggle's own visibility
    // gate (BusinessTwinPanel.tsx) actually checks, not overdueStats/dueSoonStats
    // directly. A fixture with only overdueStats/dueSoonStats populated (and
    // jumpableObservations left empty) could never occur from the real server.
    const twinWithOnlyDeadlines: BusinessTwin = {
      ...TWIN,
      jumpableObservations: [
        { text: overdueStat.text, entityName: overdueStat.entityName },
        { text: dueSoonStat.text, entityName: dueSoonStat.entityName },
      ],
      overdueStats: [overdueStat],
      dueSoonStats: [dueSoonStat],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithOnlyDeadlines }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    try {
      renderTwinPanel(() => {});
      await waitForCondition(() => document.querySelector(".twin-view-toggle") !== null);

      const dashboardButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Dashboard"));
      fireEvent.click(dashboardButton!);

      await waitForCondition(() => document.querySelectorAll(".twin-dashboard-stats .twin-stat-tile").length === 2);
      assert.equal(
        document.body.textContent?.includes("Not enough data yet for the dashboard view"),
        false,
        "the empty-state message must not show when overdue/due-soon stats exist",
      );

      const tiles = Array.from(document.querySelectorAll(".twin-dashboard-stats .twin-stat-tile"));
      const overdueTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent?.includes("Due date"))!;
      assert.ok(overdueTile, "expected a stat tile for the overdue deadline fact");
      assert.equal(overdueTile.querySelector(".twin-stat-value")!.textContent, "2");
      assert.match(overdueTile.querySelector(".twin-stat-percent")!.textContent ?? "", /5/);

      const dueSoonTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent?.includes("Renewal"))!;
      assert.ok(dueSoonTile, "expected a stat tile for the due-soon deadline fact");
      assert.equal(dueSoonTile.querySelector(".twin-stat-value")!.textContent, "1");
      assert.match(dueSoonTile.querySelector(".twin-stat-percent")!.textContent ?? "", /5/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Round 1332: the Dashboard's numericStats/overdueStats/dueSoonStats tiles
 * were rendered as plain inert <div className="twin-stat-tile-static">,
 * unlike every sibling tile in this same panel (the per-entity record-count
 * tiles above, and mostActiveObservation/jumpableObservations below) which
 * are all real buttons wired to onJumpToEntity -- even though each of these
 * stats already carries its own entityName (see twin.ts). Confirms all
 * three families are now real clickable buttons that call onJumpToEntity
 * with their own entityName, mirroring the test above for the per-entity
 * record-count tiles.
 */
test("BusinessTwinPanel's numericStats/overdueStats/dueSoonStats dashboard tiles are clickable and call onJumpToEntity with their own entity name", async () => {
  await withJsdom(async () => {
    const numericStat = {
      text: 'Total "Amount" in "Orders": 400 (average 100 across 4 records).',
      entityName: "Order",
      entityLabel: "Orders",
      fieldName: "amount",
      fieldLabel: "Amount",
      sum: 400,
      average: 100,
      recordCount: 4,
    };
    const overdueStat = {
      text: '"Due date" overdue in "Orders": 2 of 5.',
      entityName: "Order",
      entityLabel: "Orders",
      fieldName: "dueDate",
      fieldLabel: "Due date",
      overdueCount: 2,
      recordCount: 5,
    };
    const dueSoonStat = {
      text: '"Renewal" coming up soon in "Customers": 1 of 5.',
      entityName: "Customer",
      entityLabel: "Customers",
      fieldName: "renewal",
      fieldLabel: "Renewal",
      dueSoonCount: 1,
      recordCount: 5,
    };
    const twinWithAllStats: BusinessTwin = {
      ...TWIN,
      jumpableObservations: [
        { text: overdueStat.text, entityName: overdueStat.entityName },
        { text: dueSoonStat.text, entityName: dueSoonStat.entityName },
      ],
      numericStats: [numericStat],
      overdueStats: [overdueStat],
      dueSoonStats: [dueSoonStat],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) => {
      if (input === "/api/projects/proj1/twin") {
        return new Response(JSON.stringify({ twin: twinWithAllStats }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request ${input}`);
    }) as typeof fetch;
    const jumps: string[] = [];
    const dateFilters: Array<{ fieldName: string; value: string } | undefined> = [];
    try {
      renderTwinPanel((entityName, dateFilter) => {
        jumps.push(entityName);
        dateFilters.push(dateFilter);
      });
      await waitForCondition(() => document.querySelector(".twin-view-toggle") !== null);

      const dashboardButton = Array.from(document.querySelectorAll(".twin-view-toggle button")).find((b) => b.textContent?.includes("Dashboard"));
      fireEvent.click(dashboardButton!);

      await waitForCondition(() => document.querySelectorAll(".twin-dashboard-stats .twin-stat-tile").length === 3);
      const tiles = Array.from(document.querySelectorAll(".twin-dashboard-stats .twin-stat-tile")) as HTMLButtonElement[];
      for (const tile of tiles) {
        assert.equal(tile.tagName, "BUTTON", "every dashboard stat tile must be a real clickable button, not an inert div");
      }

      const totalTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent?.includes("Amount"))!;
      assert.ok(totalTile, "expected a numericStats tile");
      fireEvent.click(totalTile);
      assert.deepEqual(jumps, ["Order"], "clicking the numericStats tile must call onJumpToEntity with its own entityName");
      assert.equal(dateFilters[0], undefined, "the numericStats tile has no overdue/dueSoon classification, so it must not pass a dateFilter");

      const overdueTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent?.includes("Due date"))!;
      assert.ok(overdueTile, "expected an overdueStats tile");
      fireEvent.click(overdueTile);
      assert.deepEqual(jumps, ["Order", "Order"], "clicking the overdueStats tile must call onJumpToEntity with its own entityName");
      assert.deepEqual(
        dateFilters[1],
        { fieldName: "dueDate", value: "overdue" },
        "clicking the overdueStats tile must also pass its own fieldName and 'overdue' so the target entity opens pre-filtered",
      );

      const dueSoonTile = tiles.find((el) => el.querySelector(".twin-stat-label")!.textContent?.includes("Renewal"))!;
      assert.ok(dueSoonTile, "expected a dueSoonStats tile");
      fireEvent.click(dueSoonTile);
      assert.deepEqual(
        jumps,
        ["Order", "Order", "Customer"],
        "clicking the dueSoonStats tile must call onJumpToEntity with ITS OWN entityName (Customer), not the previous tiles' Order",
      );
      assert.deepEqual(
        dateFilters[2],
        { fieldName: "renewal", value: "dueSoon" },
        "clicking the dueSoonStats tile must also pass its own fieldName and 'dueSoon' so the target entity opens pre-filtered",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
