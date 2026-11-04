import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getTwinView, purgeTwinViewForProject, removeTwinView, setTwinView } from "./twinViewPreference.js";

/** Same real-localStorage-via-jsdom-swap technique as sharedProjectSeen.test.ts. */
async function withJsdom(fn: () => void | Promise<void>): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const originals: Record<string, unknown> = {};
  const keys = ["window", "document", "navigator", "localStorage"];
  for (const key of keys) {
    originals[key] = (globalThis as Record<string, unknown>)[key];
  }
  try {
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] !== undefined) Object.defineProperty(globalThis, key, { value: originals[key], configurable: true });
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("getTwinView defaults to report when nothing has ever been chosen", async () => {
  await withJsdom(() => {
    assert.equal(getTwinView("userA", "proj1"), "report");
  });
});

test("setTwinView records a choice, and a fresh getTwinView call sees it -- a real persistence round trip, not just in-memory state", async () => {
  await withJsdom(() => {
    setTwinView("userA", "proj1", "dashboard");
    assert.equal(getTwinView("userA", "proj1"), "dashboard", "must actually be written to storage");
  });
});

test("setTwinView overwrites a prior choice for the same user+project", async () => {
  await withJsdom(() => {
    setTwinView("userA", "proj1", "dashboard");
    setTwinView("userA", "proj1", "report");
    assert.equal(getTwinView("userA", "proj1"), "report");
  });
});

test("choices are kept per-user and per-project -- one collaborator's choice never leaks to a different user, or a different project for the same user", async () => {
  await withJsdom(() => {
    setTwinView("userA", "proj1", "dashboard");
    assert.equal(getTwinView("userA", "proj2"), "report", "a different project for the SAME user must not inherit its choice");
    assert.equal(getTwinView("userB", "proj1"), "report", "a different user on the SAME project must not inherit userA's choice");
  });
});

test("removeTwinView removes one project's entry for this one user, while leaving every other project's entry AND another user's own entry for the SAME project untouched", async () => {
  await withJsdom(() => {
    setTwinView("userA", "proj1", "dashboard");
    setTwinView("userA", "proj2", "dashboard");
    setTwinView("userB", "proj1", "dashboard");
    removeTwinView("userA", "proj1");
    assert.equal(getTwinView("userA", "proj1"), "report", "userA's own proj1 entry must be gone");
    assert.equal(getTwinView("userA", "proj2"), "dashboard", "userA's own proj2 entry must survive");
    assert.equal(getTwinView("userB", "proj1"), "dashboard", "removing userA's own proj1 entry must never touch userB's own proj1 entry");
  });
});

test("removeTwinView is a no-op when the project was never chosen", async () => {
  await withJsdom(() => {
    setTwinView("userA", "proj2", "dashboard");
    removeTwinView("userA", "proj1");
    assert.equal(getTwinView("userA", "proj2"), "dashboard");
  });
});

/**
 * Round 1596: used by projectPreferenceCleanup.ts when a whole project is
 * deleted -- there's no single "current user" to scope a plain
 * removeTwinView call to at that point, since any number of other
 * collaborator accounts could have their own choice for this project
 * sitting in this same browser's localStorage, each under their own
 * per-user key.
 */
test("purgeTwinViewForProject removes every collaborator account's own choice for that project, and never touches another project's entries", async () => {
  await withJsdom(() => {
    setTwinView("userA", "proj1", "dashboard");
    setTwinView("userB", "proj1", "dashboard");
    setTwinView("userA", "proj2", "dashboard");
    purgeTwinViewForProject("proj1");
    assert.equal(getTwinView("userA", "proj1"), "report", "userA's own proj1 entry must be gone");
    assert.equal(getTwinView("userB", "proj1"), "report", "userB's own proj1 entry must be gone too, not just userA's");
    assert.equal(getTwinView("userA", "proj2"), "dashboard", "proj2's own entry must survive untouched");
  });
});

test("getTwinView tolerates corrupted/foreign localStorage content instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.twinView.userA", "not valid json{{{");
    assert.equal(getTwinView("userA", "proj1"), "report");

    localStorage.setItem("forge.twinView.userA", JSON.stringify(["proj1", "proj2"]));
    assert.equal(getTwinView("userA", "proj1"), "report", "an array isn't a valid map shape");

    localStorage.setItem("forge.twinView.userA", JSON.stringify({ proj1: "dashboard", proj2: "nonsense", proj3: 42 }));
    assert.equal(getTwinView("userA", "proj1"), "dashboard");
    assert.equal(getTwinView("userA", "proj2"), "report", "an invalid view value must be dropped, not crash the whole read");
    assert.equal(getTwinView("userA", "proj3"), "report");
  });
});
