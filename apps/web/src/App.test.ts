import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformSync } from "esbuild";
import type { AgentStepEvent } from "@forge/shared";
import { summarizeRefineImpact } from "./App.js";

const t = (key: string) => key;

test("summarizeRefineImpact reads the newEntities/changedEntities detail off the successful Architect event", () => {
  const events: AgentStepEvent[] = [
    { agent: "Architect", status: "running", message: "…" },
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [{ name: "Invoice", label: "Invoices" }],
        changedEntities: [{ name: "Customer", label: "Customers", newFieldNames: ["loyaltyPoints"] }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /Invoices/);
  assert.match(summary, /Customers/);
  assert.match(summary, /loyaltyPoints/);
});

test("summarizeRefineImpact returns the no-summary key when no successful Architect event exists", () => {
  const events: AgentStepEvent[] = [{ agent: "Architect", status: "failed", message: "…" }];
  assert.equal(summarizeRefineImpact(events, t), "preview.refineHistory.noSummary");
});

test("summarizeRefineImpact prefers the LAST successful Architect event, not the first, so a Debug Agent recovery's corrected detail wins", () => {
  // Mirrors the real pipeline.ts behavior (architectEvent() called a
  // second time after a Debug Agent recovery, see the "Re-emit the
  // Architect summary after a Debug Agent recovery" commit): a
  // Database-step failure the Debug Agent fixes by renaming a field
  // yields a first, stale Architect success event (still describing the
  // broken name) followed by a second, corrected one. The refine-history
  // summary shown in chat must reflect the field that was actually built.
  const events: AgentStepEvent[] = [
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [{ name: "Customer", label: "Customers", newFieldNames: ["order; DROP TABLE x"] }],
      },
    },
    { agent: "Database", status: "failed", message: "…" },
    { agent: "Debug", status: "success", message: "…" },
    {
      agent: "Architect",
      status: "success",
      message: "…",
      detail: {
        newEntities: [],
        changedEntities: [{ name: "Customer", label: "Customers", newFieldNames: ["orderNote"] }],
      },
    },
  ];
  const summary = summarizeRefineImpact(events, t);
  assert.match(summary, /orderNote/);
  assert.doesNotMatch(summary, /DROP TABLE/);
});

/**
 * Regression test: each of the four overlay panels (History, Business
 * Twin, WhatsApp, Search) -- each a full-screen backdrop -- used to be
 * opened by setting only its own "show" boolean to true, with no regard
 * for whether another panel's boolean was already true. Clicking, say,
 * "Business Twin" while History was already open (from an earlier click,
 * or Ctrl+K for search) stacked two full-screen overlays instead of
 * replacing one with the other. Extracts the real openPanel function from
 * App.tsx, strips its TypeScript with esbuild, and runs it with mock
 * setShowX functions to confirm every open closes the other three.
 */
test("App's openPanel closes every other overlay panel when opening one, instead of letting them stack", () => {
  const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const handlerMatch = appSrc.match(
    / {2}function openPanel\(panel: "history" \| "twin" \| "whatsapp" \| "search"\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(handlerMatch, "expected to find openPanel in App.tsx");
  const { code } = transformSync(handlerMatch![0], { loader: "ts" });

  function run(panel: string) {
    const state = { history: false, twin: false, whatsapp: false, search: false };
    const fn = new Function(
      "setShowHistory",
      "setShowTwin",
      "setShowWhatsApp",
      "setShowSearch",
      `${code}\nreturn openPanel;`,
    )(
      (v: boolean) => (state.history = v),
      (v: boolean) => (state.twin = v),
      (v: boolean) => (state.whatsapp = v),
      (v: boolean) => (state.search = v),
    ) as (panel: string) => void;
    fn(panel);
    return state;
  }

  assert.deepEqual(run("history"), { history: true, twin: false, whatsapp: false, search: false });
  assert.deepEqual(run("twin"), { history: false, twin: true, whatsapp: false, search: false });
  assert.deepEqual(run("whatsapp"), { history: false, twin: false, whatsapp: true, search: false });
  assert.deepEqual(run("search"), { history: false, twin: false, whatsapp: false, search: true });
});
