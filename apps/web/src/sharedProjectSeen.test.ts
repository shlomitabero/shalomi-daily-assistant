import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  getSeenSharedTimestamps,
  isNewShare,
  markSharedProjectSeen,
  purgeSeenSharedProjectsForProject,
  removeSeenSharedProject,
} from "./sharedProjectSeen.js";

/** Same real-localStorage-via-jsdom-swap technique as pinnedProjects.test.ts. */
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

test("getSeenSharedTimestamps returns an empty map when nothing has ever been acknowledged", async () => {
  await withJsdom(() => {
    assert.deepEqual(getSeenSharedTimestamps("userA"), new Map());
  });
});

test("markSharedProjectSeen records a project's sharedAt, and a fresh getSeenSharedTimestamps call sees it -- a real persistence round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    assert.deepEqual(after, new Map([["proj1", "2026-01-01T00:00:00.000Z"]]));
    assert.deepEqual(
      getSeenSharedTimestamps("userA"),
      new Map([["proj1", "2026-01-01T00:00:00.000Z"]]),
      "must actually be written to storage, not just returned",
    );
  });
});

test("markSharedProjectSeen is idempotent -- re-acknowledging the same sharedAt again doesn't change anything", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    const after = markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    assert.deepEqual(after, new Map([["proj1", "2026-01-01T00:00:00.000Z"]]));
  });
});

test("markSharedProjectSeen overwrites a project's prior sharedAt -- a later share grant (removed-then-re-invited collaborator) replaces the earlier one", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    const after = markSharedProjectSeen("userA", "proj1", "2026-02-01T00:00:00.000Z");
    assert.deepEqual(after, new Map([["proj1", "2026-02-01T00:00:00.000Z"]]));
    assert.deepEqual(getSeenSharedTimestamps("userA"), new Map([["proj1", "2026-02-01T00:00:00.000Z"]]));
  });
});

/**
 * Round 995: the whole point of this round's fix. Before it, the storage
 * key was projectId alone -- two different collaborator accounts invited
 * to the SAME shared project, on the SAME browser, shared one
 * acknowledgment: whichever one opened the project first silently
 * suppressed the "New share" chip for the other, who never actually
 * opened it themselves.
 */
test("acknowledgments are kept per-user -- one collaborator opening a shared project never silently acknowledges it for a different collaborator invited to the SAME project", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    assert.deepEqual(getSeenSharedTimestamps("userA"), new Map([["proj1", "2026-01-01T00:00:00.000Z"]]), "userA's own acknowledgment must be recorded");
    assert.deepEqual(getSeenSharedTimestamps("userB"), new Map(), "userB, a different collaborator on the SAME project, must still see it as unacknowledged -- userA opening it must never count as userB's own acknowledgment");
    assert.equal(isNewShare(getSeenSharedTimestamps("userB"), "proj1", "2026-01-01T00:00:00.000Z"), true, "the 'New share' chip must still show for userB");
  });
});

test("removeSeenSharedProject removes one project's entry for this one user, while leaving every other project's entry AND another user's own entry for the SAME project untouched", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    markSharedProjectSeen("userA", "proj2", "2026-01-02T00:00:00.000Z");
    markSharedProjectSeen("userB", "proj1", "2026-01-03T00:00:00.000Z");
    const after = removeSeenSharedProject("userA", "proj1");
    assert.deepEqual(after, new Map([["proj2", "2026-01-02T00:00:00.000Z"]]));
    assert.deepEqual(getSeenSharedTimestamps("userA"), new Map([["proj2", "2026-01-02T00:00:00.000Z"]]));
    assert.deepEqual(getSeenSharedTimestamps("userB"), new Map([["proj1", "2026-01-03T00:00:00.000Z"]]), "removing userA's own proj1 entry must never touch userB's own proj1 entry");
  });
});

test("removeSeenSharedProject is a no-op when the project was never marked seen", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("userA", "proj2", "2026-01-02T00:00:00.000Z");
    const after = removeSeenSharedProject("userA", "proj1");
    assert.deepEqual(after, new Map([["proj2", "2026-01-02T00:00:00.000Z"]]));
  });
});

test("getSeenSharedTimestamps tolerates corrupted/foreign localStorage content instead of throwing, including round 401's old flat-array shape", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.seenSharedProjects.userA", "not valid json{{{");
    assert.deepEqual(getSeenSharedTimestamps("userA"), new Map());

    localStorage.setItem("forge.seenSharedProjects.userA", JSON.stringify(["proj1", "proj2"]));
    assert.deepEqual(
      getSeenSharedTimestamps("userA"),
      new Map(),
      "round 401's old array-of-ids shape carries no sharedAt values to migrate -- treated as a clean slate",
    );

    localStorage.setItem("forge.seenSharedProjects.userA", JSON.stringify({ proj1: "2026-01-01T00:00:00.000Z", proj2: 42, proj3: null }));
    assert.deepEqual(
      getSeenSharedTimestamps("userA"),
      new Map([["proj1", "2026-01-01T00:00:00.000Z"]]),
      "non-string values must be dropped, not crash the whole read",
    );
  });
});

/**
 * Round 995: used by projectPreferenceCleanup.ts when a whole project is
 * deleted -- there's no single "current user" to scope a plain
 * removeSeenSharedProject call to at that point, since any number of
 * other collaborator accounts could have their own acknowledgment for
 * this project sitting in this same browser's localStorage, each under
 * their own per-user key.
 */
test("purgeSeenSharedProjectsForProject removes every collaborator account's own acknowledgment for that project, and never touches another project's entries", async () => {
  await withJsdom(() => {
    markSharedProjectSeen("userA", "proj1", "2026-01-01T00:00:00.000Z");
    markSharedProjectSeen("userB", "proj1", "2026-01-02T00:00:00.000Z");
    markSharedProjectSeen("userA", "proj2", "2026-01-03T00:00:00.000Z");
    purgeSeenSharedProjectsForProject("proj1");
    assert.deepEqual(getSeenSharedTimestamps("userA"), new Map([["proj2", "2026-01-03T00:00:00.000Z"]]), "userA's own proj1 entry must be gone, but proj2's own entry must survive");
    assert.deepEqual(getSeenSharedTimestamps("userB"), new Map(), "userB's own proj1 entry must be gone too, not just userA's");
  });
});

test("isNewShare is true only when sharedAt is defined and doesn't match what's already been acknowledged for that project id", () => {
  const seen = new Map([["proj1", "2026-01-01T00:00:00.000Z"]]);

  assert.equal(isNewShare(seen, "proj1", "2026-01-01T00:00:00.000Z"), false, "already-acknowledged sharedAt is not new");
  assert.equal(isNewShare(seen, "proj1", "2026-02-01T00:00:00.000Z"), true, "a later sharedAt than what was acknowledged is new again");
  assert.equal(isNewShare(seen, "proj2", "2026-01-01T00:00:00.000Z"), true, "a project never acknowledged at all is new");
  assert.equal(isNewShare(seen, "proj1", undefined), false, "an owned project (no sharedAt) is never 'new'");
});
