import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { AgentStepEvent } from "@forge/shared";
import { BuildProgress, formatElapsedTime } from "./BuildProgress.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

/** Same jsdom-swap technique as useDialogFocusTrap.test.ts. */
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

// BuildProgress's own effect calls `run(onEvent).then(...).catch(...)`
// directly -- act()'s own return value is a minimal thenable (only
// `.then()`, no `.catch()`/`.finally()`), so returning it as-is broke that
// chain with "Cannot read properties of undefined (reading 'catch')".
// Wrapping the whole thing in a real `async` arrow function guarantees a
// genuine native Promise here regardless of what act() itself returns,
// since an async function's return value is always a real Promise.
function runWithEvents(events: AgentStepEvent[]) {
  return async (onEvent: (event: AgentStepEvent) => void) => {
    await act(async () => {
      for (const event of events) onEvent(event);
    });
  };
}

// render() from @testing-library/react already wraps the mount (including
// firing effects, synchronously, before it returns) in its own act() call.
// BuildProgress's mount effect calls `run(onEvent)` -- our runWithEvents
// above, which itself awaits a *second*, nested act() call -- synchronously
// from inside that same act() flush. An earlier draft of this helper added
// a *third*, outer act() around this render() call to try to deterministically
// wait for that chain; nesting a third act() scope like that deadlocks
// React's internal act-scope bookkeeping and hangs the whole node:test
// process forever. Two levels of nesting (render()'s own + runWithEvents')
// work fine, so render() stays a plain, synchronous call with no extra
// act() wrapper here -- each test instead waits a plain tick afterward.
function renderBuildProgress(events: AgentStepEvent[], onComplete: (project: unknown) => void = () => {}) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(BuildProgress, {
          title: "Building",
          run: runWithEvents(events),
          onComplete,
          onBack: () => {},
        }),
      ),
    ),
  );
}

const RECOVERED_BUILD_EVENTS: AgentStepEvent[] = [
  { agent: "Architect", status: "running", message: "…" },
  { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
  { agent: "Database", status: "running", message: "…" },
  { agent: "Database", status: "failed", message: "a real migration error" },
  { agent: "Debug", status: "running", message: "…" },
  { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
  { agent: "Debug", status: "success", message: "…", detail: { correctedSpec: {} } },
  { agent: "Database", status: "success", message: "…", detail: [] },
  { agent: "Seed Data", status: "running", message: "…" },
  { agent: "Seed Data", status: "success", message: "…", detail: { seededCount: 0, entities: [] } },
  { agent: "QA", status: "running", message: "…" },
  { agent: "QA", status: "success", message: "…", detail: [] },
  { agent: "Security", status: "running", message: "…" },
  { agent: "Security", status: "success", message: "…", detail: [] },
  { agent: "Forge", status: "success", message: "…", detail: { project: { id: "p1", name: "Test" } } },
];

/**
 * Regression test: pipeline.ts's own comment says explicitly that "the UI
 * ... keeps only the latest event per agent" -- true for the per-row
 * status icons and captions (both driven by latestByAgent), but NOT true
 * for the "Build failed" banner, which scanned the raw `events` array for
 * the first failed status ever seen. A Database migration failure that
 * the Debug Agent successfully auto-recovers from (see pipeline.ts: the
 * try/catch always falls through to a fresh Database success event
 * afterward, whether or not it entered the catch) still leaves that
 * earlier failed event sitting in `events` forever -- so the banner (and
 * its Back button, replacing the normal step list) stayed up for the
 * entire rest of a build that was actually still running and about to
 * complete successfully. Runs the real component through a real,
 * pipeline-shaped event sequence: a failure that gets recovered, followed
 * by every remaining agent succeeding through to Forge.
 */
test("BuildProgress does not show the failed-build banner once a failed step is superseded by a later success for the same agent", async () => {
  await withJsdom(async () => {
    renderBuildProgress(RECOVERED_BUILD_EVENTS);
    // Waits (outside of any act() scope, to avoid the nested-act deadlock
    // described above) for runWithEvents' own act() call -- kicked off
    // asynchronously by the mount effect's `run(onEvent).then(...)` chain
    // -- to actually settle before asserting on the DOM it produces.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Comparing a raw jsdom Node as assert's "actual" value is its own
    // footgun: on failure, node:assert formats it with util.inspect(),
    // and a jsdom element's huge, circular property graph makes that
    // effectively hang. Reducing to a boolean first keeps a failure's
    // error message cheap to build.
    assert.equal(
      document.querySelector("p.error:not(.banner)") === null,
      true,
      "the 'Build failed' banner must not show once the failing agent's LATEST event succeeded",
    );
    assert.equal(
      document.querySelectorAll(".step-failed").length,
      0,
      "no row should show a failed status icon once every agent's latest event succeeded",
    );
    // Every one of the 7 agents in RECOVERED_BUILD_EVENTS (Debug included,
    // since it did run in this build) has a "success" LATEST event --
    // confirms the fix reads status from latestByAgent consistently, not
    // just for the banner but for what a real user actually sees per row.
    assert.equal(document.querySelectorAll(".step-success").length, 7);
  });
});

test("formatElapsedTime renders m:ss, zero-padding seconds under 10", () => {
  assert.equal(formatElapsedTime(0), "0:00");
  assert.equal(formatElapsedTime(5000), "0:05");
  assert.equal(formatElapsedTime(65000), "1:05");
  assert.equal(formatElapsedTime(600000), "10:00");
  assert.equal(formatElapsedTime(-500), "0:00", "a negative/clock-skew value must clamp to zero, not render a negative time");
});

/**
 * New in this round: a build can take a real, noticeable stretch of time
 * across several agent steps, and until now the screen gave no sense of
 * how long it had actually been running -- someone watching had no way to
 * tell "still working" from "stuck". Uses node:test's own fake timers
 * (mocking both setInterval and Date, since the ticker reads Date.now()
 * each tick) to deterministically advance time without a real multi-second
 * wait: confirms the displayed time actually advances tick by tick while
 * the build is running, and -- the regression this guards against -- that
 * it freezes at the exact moment the build finishes rather than continuing
 * to climb for the rest of the page's lifetime.
 */
test("BuildProgress's elapsed timer ticks once a second while running, and freezes at the exact final duration once the build finishes", async (t) => {
  await withJsdom(async () => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    try {
      let resolveRun!: () => void;
      const runPromise = new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      const run = (onEvent: (event: AgentStepEvent) => void) => {
        onEvent({ agent: "Architect", status: "running", message: "…" });
        return runPromise;
      };

      render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            LanguageProvider,
            null,
            React.createElement(BuildProgress, { title: "Building", run, onComplete: () => {}, onBack: () => {} }),
          ),
        ),
      );

      const elapsedText = () => document.querySelector(".build-elapsed")!.textContent ?? "";
      assert.match(elapsedText(), /0:00/, "must start at 0:00, not some stale/undefined value");

      act(() => {
        t.mock.timers.tick(3000);
      });
      assert.match(elapsedText(), /0:03/, "must tick to reflect 3 real (mocked) seconds having passed while still running");

      act(() => {
        t.mock.timers.tick(7000);
      });
      assert.match(elapsedText(), /0:10/, "must keep ticking -- 10 total seconds now");

      await act(async () => {
        resolveRun();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.match(elapsedText(), /0:10/, "must freeze at the real elapsed time the instant the build finishes");

      act(() => {
        t.mock.timers.tick(5000);
      });
      assert.match(
        elapsedText(),
        /0:10/,
        "must NOT keep climbing after the build has already finished -- the interval must actually stop, not just get ignored visually",
      );
    } finally {
      t.mock.timers.reset();
    }
  });
});

/**
 * Companion test: a real, unrecovered failure (Debug's own fix attempt
 * itself fails, per pipeline.ts's fixErr branch, which returns without
 * ever yielding another success) must still show the failed banner --
 * confirming the fix above didn't remove real failure detection along
 * with the false positive.
 */
test("BuildProgress still shows the failed-build banner for a genuine, unrecovered failure", async () => {
  await withJsdom(async () => {
    const events: AgentStepEvent[] = [
      { agent: "Architect", status: "running", message: "…" },
      { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
      { agent: "Database", status: "running", message: "…" },
      { agent: "Database", status: "failed", message: "a real migration error" },
      { agent: "Debug", status: "running", message: "…" },
      { agent: "Debug", status: "failed", message: "the automatic fix attempt also failed" },
    ];
    renderBuildProgress(events);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(
      document.querySelector("p.error:not(.banner)") !== null,
      true,
      "the 'Build failed' banner must still show for a real, never-recovered failure",
    );
  });
});
