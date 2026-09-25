import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { AgentStepEvent } from "@forge/shared";
import { BuildProgress, computeBuildProgressPercent, formatBuildSummary, formatElapsedTime } from "./BuildProgress.js";
import { LanguageProvider } from "./i18n/LanguageContext.js";
import { translate } from "./i18n/language.js";
import { ThemeProvider } from "./theme/ThemeContext.js";

const englishT = (key: string, params?: Record<string, string | number>) => translate("en", key, params);

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
          projectName: "Test Project",
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

/**
 * New in this round: a successful step's caption used to always show a
 * generic canned phrase (e.g. "All checks passed.") regardless of what the
 * build actually did. The server (pipeline.ts) computes a genuinely
 * specific message per step -- real entity/table counts, a real security
 * score -- and this now must be what renders, matching the failed case's
 * own existing convention of showing the real message verbatim. Uses two
 * agents with distinguishing, realistic messages (not the fixture's usual
 * "…" placeholder) to prove it's really THAT agent's own real message
 * landing in THAT row, not just any string appearing anywhere on the page.
 */
test("BuildProgress shows each agent's own real success message, not a generic canned phrase", async () => {
  await withJsdom(async () => {
    const events: AgentStepEvent[] = [
      { agent: "Architect", status: "running", message: "…" },
      { agent: "Architect", status: "success", message: "Designed 4 tables for 2 roles.", detail: { newEntities: [], changedEntities: [] } },
      { agent: "Database", status: "running", message: "…" },
      { agent: "Database", status: "success", message: "3 schema change(s) applied (2 new tables, 1 new columns). Nothing was dropped.", detail: [] },
      { agent: "Seed Data", status: "running", message: "…" },
      { agent: "Seed Data", status: "success", message: "…", detail: { seededCount: 0, entities: [] } },
      { agent: "QA", status: "running", message: "…" },
      { agent: "QA", status: "success", message: "3/3 entity checks passed.", detail: [] },
      { agent: "Security", status: "running", message: "…" },
      { agent: "Security", status: "success", message: "Security score 100/100.", detail: [] },
      { agent: "Forge", status: "success", message: "…", detail: { project: { id: "p1", name: "Test" } } },
    ];
    renderBuildProgress(events);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const steps = [...document.querySelectorAll(".agent-step")];
    const architectStep = steps.find((s) => s.textContent?.includes("Product Planner"));
    const databaseStep = steps.find((s) => s.textContent?.includes("Database Engineer"));
    const qaStep = steps.find((s) => s.textContent?.includes("Quality Checker"));
    const securityStep = steps.find((s) => s.textContent?.includes("Security Expert"));

    assert.equal(
      architectStep?.querySelector(".agent-step-body > p")?.textContent,
      "Designed 4 tables for 2 roles.",
      "the Architect row must show its own real, specific success message",
    );
    assert.equal(
      databaseStep?.querySelector(".agent-step-body > p")?.textContent,
      "3 schema change(s) applied (2 new tables, 1 new columns). Nothing was dropped.",
      "the Database row must show its own real, specific success message, not the Architect's",
    );
    assert.equal(
      qaStep?.querySelector(".agent-step-body > p")?.textContent,
      "3/3 entity checks passed.",
      "the QA row must show its own real, specific success message, not a generic 'All checks passed.' phrase",
    );
    assert.equal(
      securityStep?.querySelector(".agent-step-body > p")?.textContent,
      "Security score 100/100.",
      "the Security row must show its own real, specific success message, not a generic 'Scanned and approved.' phrase",
    );
  });
});

/**
 * New in this round: the subtitle's "step N of M" text already carried
 * this same fraction, but only as text a reader had to do the division on
 * themselves. Confirms a real filled progress bar renders in the DOM with
 * the correct aria attributes and width, tracking real agent completions
 * as they land -- not just that computeBuildProgressPercent's own math is
 * right in isolation (already covered above), but that BuildProgress
 * actually wires it up.
 */
test("BuildProgress renders a real progress bar that fills as agents complete, with correct aria attributes", async () => {
  await withJsdom(async () => {
    const events: AgentStepEvent[] = [
      { agent: "Architect", status: "running", message: "…" },
      { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
      { agent: "Database", status: "running", message: "…" },
    ];
    renderBuildProgress(events);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const bar = document.querySelector(".build-progress-bar");
    assert.ok(bar, "expected a progress bar element");
    assert.equal(bar!.getAttribute("role"), "progressbar");
    assert.equal(bar!.getAttribute("aria-valuemin"), "0");
    assert.equal(bar!.getAttribute("aria-valuemax"), "100");
    // 1 of 6 VISIBLE agents done (Architect only; Debug never ran in this
    // fixture, so it's excluded from the visible list the same way the
    // subtitle's own "step N of M" text excludes it) = 16.67% -> rounds to 17.
    assert.equal(bar!.getAttribute("aria-valuenow"), "17");

    const fill = bar!.querySelector(".build-progress-bar-fill") as HTMLElement;
    assert.ok(fill, "expected a fill element inside the progress bar");
    assert.equal(fill.style.width, "17%");
  });
});

test("formatElapsedTime renders m:ss, zero-padding seconds under 10", () => {
  assert.equal(formatElapsedTime(0), "0:00");
  assert.equal(formatElapsedTime(5000), "0:05");
  assert.equal(formatElapsedTime(65000), "1:05");
  assert.equal(formatElapsedTime(600000), "10:00");
  assert.equal(formatElapsedTime(-500), "0:00", "a negative/clock-skew value must clamp to zero, not render a negative time");
});

test("computeBuildProgressPercent rounds doneCount/totalAgents to a whole-number percentage", () => {
  assert.equal(computeBuildProgressPercent(0, 7), 0);
  assert.equal(computeBuildProgressPercent(7, 7), 100);
  assert.equal(computeBuildProgressPercent(3, 7), 43, "3/7 = 42.857...% must round to 43, not truncate to 42");
  assert.equal(computeBuildProgressPercent(1, 3), 33);
});

test("computeBuildProgressPercent guards against a zero (or negative) total instead of dividing by zero", () => {
  assert.equal(computeBuildProgressPercent(0, 0), 0);
  assert.equal(computeBuildProgressPercent(2, 0), 0);
});

test("computeBuildProgressPercent clamps doneCount above totalAgents to 100%, rather than exceeding it", () => {
  assert.equal(computeBuildProgressPercent(9, 7), 100);
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
            React.createElement(BuildProgress, {
              title: "Building",
              projectName: "Test Project",
              run,
              onComplete: () => {},
              onBack: () => {},
            }),
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

/**
 * New in this round: once a build finishes (success or failure) there was no
 * way to keep a record of what the AI Team actually did -- the live screen
 * is gone the moment you navigate away. formatBuildSummary renders the same
 * per-agent LATEST status the step list itself shows (see the
 * "does not show the failed-build banner" test above for why "latest, not
 * first-ever" matters), as plain text.
 */
test("formatBuildSummary lists each agent's own latest status and real message, skipping Debug when it never ran", () => {
  const events: AgentStepEvent[] = [
    { agent: "Architect", status: "success", message: "Designed 4 tables for 2 roles.", detail: { newEntities: [], changedEntities: [] } },
    { agent: "Database", status: "success", message: "2 schema change(s) applied.", detail: [] },
    { agent: "Seed Data", status: "success", message: "Seeded 12 records.", detail: { seededCount: 12, entities: [] } },
    { agent: "QA", status: "success", message: "3/3 entity checks passed.", detail: [] },
    { agent: "Security", status: "success", message: "Security score 100/100.", detail: [] },
    { agent: "Forge", status: "success", message: "Published.", detail: { project: { id: "p1", name: "Test" } } },
  ];
  const text = formatBuildSummary(events, 65000, "Flower Shop", "en", englishT);

  assert.ok(text.includes("Flower Shop"), "must include the real project name");
  assert.ok(text.includes("1:05"), "must include the real formatted elapsed duration (65000ms == 1:05)");
  assert.ok(text.includes("Designed 4 tables for 2 roles."), "must include the Architect's own real message");
  assert.ok(text.includes("Security score 100/100."), "must include the Security agent's own real message");
  assert.ok(
    !text.includes("Debug"),
    "Debug never ran in this build (no event for it), so it must not appear as a permanent pending placeholder",
  );
});

test("formatBuildSummary shows a recovered agent's LATEST (success) status, not its earlier failed attempt, and includes Debug since it DID run", () => {
  const text = formatBuildSummary(RECOVERED_BUILD_EVENTS, 30000, "Test", "en", englishT);
  const lines = text.split("\n");
  const databaseLine = lines.find((l) => l.includes("Database Engineer"));
  assert.ok(databaseLine, "expected a Database Engineer line in the summary");
  assert.ok(
    databaseLine!.startsWith("[✓ Succeeded]"),
    `Database's LATEST event succeeded (the Debug Agent recovered it), so its summary line must show success -- got "${databaseLine}"`,
  );
  assert.ok(
    lines.some((l) => l.includes("Debug Agent")),
    "Debug DID actually run in this build, so it must appear (unlike the never-ran case above)",
  );
});

test("formatBuildSummary shows a genuinely failed, unrecovered agent as failed with its own real error message", () => {
  const events: AgentStepEvent[] = [
    { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
    { agent: "Database", status: "failed", message: "a real migration error" },
    { agent: "Debug", status: "failed", message: "the automatic fix attempt also failed" },
  ];
  const text = formatBuildSummary(events, 12000, "Test", "en", englishT);
  const lines = text.split("\n");
  const databaseLine = lines.find((l) => l.includes("Database Engineer"));
  assert.ok(databaseLine, "expected a Database Engineer line in the summary");
  assert.equal(
    databaseLine,
    "[✕ Failed] Database Engineer — a real migration error",
    "an unrecovered failure must show as failed with its own real error message",
  );
});

/**
 * A real Playwright run against the live dev server (not just this jsdom
 * suite) caught something this file's own DOM tests alone would have
 * missed: for a SUCCESSFUL build, the `finished` state set inside
 * BuildProgress is never actually visible on screen at all -- the very
 * effect that sets `finished` also calls `onComplete` in the same tick,
 * and App.tsx's handleBuildComplete immediately swaps the parent's `view`
 * to "preview", unmounting BuildProgress before a real browser ever paints
 * (let alone a person or script could click) anything in the finished
 * state. A `onComplete: () => {}` no-op in a jsdom test can't see this,
 * since nothing unmounts the component -- only exercising it through the
 * real App.tsx wiring exposed it. The button is therefore placed ONLY next
 * to the failed-build banner (see BuildProgress.tsx), the one state that
 * genuinely stays on screen indefinitely (onComplete only ever fires on a
 * Forge success), so it's only tested for that reachable case here.
 */
test("BuildProgress shows a real 'Download build summary' button once a build genuinely fails (and stays reachable), and clicking it downloads the actual failure content under the real project name", async () => {
  await withJsdom(async () => {
    // jsdom doesn't implement the real Blob-URL machinery -- stub just
    // enough of it to observe what the click handler actually does, the
    // same technique WhatsAppPanel.test.ts's own download test uses.
    const originalCreateObjectURL = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
    const anchorProto = (globalThis as unknown as { window: { HTMLAnchorElement: { prototype: HTMLAnchorElement } } }).window
      .HTMLAnchorElement.prototype;
    const originalAnchorClick = anchorProto.click;
    let capturedDownloadName: string | null = null;
    let capturedBlob: Blob | null = null;
    let clickCount = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      capturedBlob = b;
      return "blob:mock-url";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    anchorProto.click = function (this: HTMLAnchorElement) {
      capturedDownloadName = this.download;
      clickCount += 1;
    };

    try {
      const events: AgentStepEvent[] = [
        { agent: "Architect", status: "success", message: "Designed 3 tables.", detail: { newEntities: [], changedEntities: [] } },
        { agent: "Database", status: "failed", message: "a real migration error" },
        { agent: "Debug", status: "failed", message: "the automatic fix attempt also failed" },
      ];

      renderBuildProgress(events);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const findDownloadButton = () =>
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Download build summary"));

      const downloadButton = findDownloadButton();
      assert.ok(downloadButton, "expected a 'Download build summary' button once the build has genuinely failed");

      act(() => {
        downloadButton!.click();
      });

      assert.equal(clickCount, 1, "clicking the download button must trigger exactly one real anchor click");
      const downloadName: string = capturedDownloadName ?? "";
      assert.ok(
        downloadName.includes("Test"),
        `expected the downloaded filename to be derived from the real project name "Test", got "${downloadName}"`,
      );
      assert.ok(downloadName.endsWith("build-summary.txt"), `expected a build-summary.txt filename, got "${downloadName}"`);

      const blobText = await (capturedBlob as unknown as Blob).text();
      assert.ok(blobText.includes("Designed 3 tables."), "the downloaded file must contain the Architect's real message");
      assert.ok(blobText.includes("a real migration error"), "the downloaded file must contain the real failure that actually happened");
    } finally {
      if (originalCreateObjectURL) (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = originalRevokeObjectURL;
      anchorProto.click = originalAnchorClick;
    }
  });
});

test("BuildProgress does not show a 'Download build summary' button for a successful build, since that state is never actually reachable on screen", async () => {
  await withJsdom(async () => {
    renderBuildProgress(RECOVERED_BUILD_EVENTS);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const downloadButton = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Download build summary"),
    );
    assert.equal(
      downloadButton === undefined,
      true,
      "a successful build must not show the download button -- it would be unreachable/decorative dead code, since onComplete unmounts this component in the same tick `finished` becomes true",
    );
  });
});

/**
 * New in this round: a failed build/refine previously had no recovery but
 * navigating all the way back to spec review (or the refine box) and
 * resubmitting from scratch -- even though the server itself is perfectly
 * safe to retry (a failed build never calls markProjectBuilt, and a failed
 * refine never touched project.status either, per pipeline.ts). "Retry"
 * re-invokes the exact same `run` prop, and must both genuinely call it
 * again (not just redraw stale state) and fully reset the visible step
 * list -- a naive reset that cleared state but never re-ran, or that
 * re-ran but left the FIRST attempt's failed events mixed in with the
 * second attempt's, would both defeat the point.
 */
test("BuildProgress's Retry button re-invokes run for a genuine second attempt, and clears the first attempt's events instead of mixing them with the second's", async () => {
  await withJsdom(async () => {
    // The second attempt deliberately fails EARLIER (right at Architect)
    // than the first attempt got (which reached Database and Seed Data
    // before failing) -- this is what actually makes stale-event leakage
    // observable. latestByAgent already renders each row by its own
    // latest event regardless of array order, so if the second attempt
    // instead re-failed at the SAME or a LATER agent, its own fresh
    // events would naturally overwrite the first attempt's for every row
    // that matters and a broken (non-clearing) Retry would look
    // identical to a working one. With the second attempt stopping at
    // Architect, Database/Seed Data get NO new events at all -- a
    // real bug that fails to clear the first attempt's events would
    // leave those two rows showing attempt one's stale success/failed
    // statuses instead of the pending state a genuinely fresh attempt
    // that hasn't reached them yet must show.
    const attempts: AgentStepEvent[][] = [
      [
        { agent: "Architect", status: "success", message: "…", detail: { newEntities: [], changedEntities: [] } },
        { agent: "Database", status: "success", message: "…", detail: [] },
        { agent: "Seed Data", status: "failed", message: "a real seed error from attempt one" },
      ],
      [{ agent: "Architect", status: "failed", message: "a real architect error from attempt two" }],
    ];
    let runCallCount = 0;
    const run = async (onEvent: (event: AgentStepEvent) => void) => {
      const events = attempts[runCallCount];
      runCallCount += 1;
      await act(async () => {
        for (const event of events) onEvent(event);
      });
    };
    const completedProjects: unknown[] = [];

    render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          LanguageProvider,
          null,
          React.createElement(BuildProgress, {
            title: "Building",
            projectName: "Test Project",
            run,
            onComplete: (p: unknown) => completedProjects.push(p),
            onBack: () => {},
          }),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(runCallCount, 1, "expected exactly one call to run on mount, before any retry");
    assert.equal(
      document.querySelector("p.error:not(.banner)") !== null,
      true,
      "expected the failed-build banner after the first attempt's real failure",
    );

    const retryButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"));
    assert.ok(retryButton, "expected a real Retry button once the build has genuinely failed");

    act(() => {
      retryButton!.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(runCallCount, 2, "clicking Retry must call the real run function a second time, not just redraw stale state");
    assert.equal(
      document.querySelector("p.error:not(.banner)") !== null,
      true,
      "the second attempt's own real Architect failure must still show its own failed-build banner",
    );
    assert.equal(
      document.querySelectorAll(".step-failed").length,
      1,
      "exactly one failed step (the second attempt's own Architect failure) -- attempt one's Seed Data failure must not linger",
    );
    // Debug never appears in either attempt, so the visible row order is
    // exactly AGENT_ORDER minus Debug: Architect, Database, Seed Data
    // ("Sample Data Filler" in English -- its own translated title, not
    // its internal agent name), QA, Security, Forge.
    const agentRows = document.querySelectorAll(".agent-step");
    const databaseRow = agentRows[1];
    const seedRow = agentRows[2];
    assert.equal(
      databaseRow?.className.includes("agent-step-pending"),
      true,
      "Database got no event at all in the second attempt -- it must show pending, not attempt one's stale success",
    );
    assert.equal(
      seedRow?.className.includes("agent-step-pending"),
      true,
      "Seed Data (Sample Data Filler) got no event at all in the second attempt -- it must show pending, not attempt one's stale failure",
    );
    assert.equal(completedProjects.length, 0, "onComplete must not fire for a second attempt that itself failed");
  });
});
