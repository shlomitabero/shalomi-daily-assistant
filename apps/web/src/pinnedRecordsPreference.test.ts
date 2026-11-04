import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  getPinnedRecordIds,
  toggleRecordPinned,
  removePinnedRecord,
  sortRecordsByPinned,
  purgePinnedRecordsForEntity,
  purgePinnedRecordsForProject,
  removePinnedRecordsForUserProject,
  migratePinnedRecordsForEntityRename,
} from "./pinnedRecordsPreference.js";

/** Same full-jsdom-swap technique used by viewModePreference.test.ts: real localStorage, not a mock. */
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

test("getPinnedRecordIds returns an empty set when nothing has ever been pinned", async () => {
  await withJsdom(() => {
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set());
  });
});

test("toggleRecordPinned pins a record, and a fresh getPinnedRecordIds call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = toggleRecordPinned("proj1", "Deal", "userA", 7);
    assert.deepEqual(after, new Set([7]));
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set([7]), "must actually be written to storage, not just returned");
  });
});

test("toggleRecordPinned a second time unpins it", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    const after = toggleRecordPinned("proj1", "Deal", "userA", 7);
    assert.deepEqual(after, new Set());
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set());
  });
});

test("unpinning the last record clears the storage entry instead of leaving an empty array behind", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    const raw = localStorage.getItem("forge.pinnedRecords");
    assert.equal(raw, "{}", "an entity+user with no pins left should not bloat storage with an explicit empty entry");
  });
});

/**
 * Round 1595: deleting a pinned record never forgot its id -- commitPendingDelete
 * (EntityPanel.tsx) only ever restored on failure, never removed it from this
 * store on success, so the id leaked in localStorage forever. Unconditional,
 * unlike toggleRecordPinned (which flips state either way): removing an id
 * that's genuinely gone must not resurrect it as pinned.
 */
test("removePinnedRecord forgets one pinned id for real, leaving a sibling pin for the same project+entity+user untouched", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    toggleRecordPinned("proj1", "Deal", "userA", 9);
    removePinnedRecord("proj1", "Deal", "userA", 7);
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set([9]), "only the removed id must be gone -- the sibling pin must survive");
  });
});

test("removePinnedRecord clears the storage entry instead of leaving an empty array, when it removes the last pinned id", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    removePinnedRecord("proj1", "Deal", "userA", 7);
    const raw = localStorage.getItem("forge.pinnedRecords");
    assert.equal(raw, "{}", "an entity+user with no pins left should not bloat storage with an explicit empty entry");
  });
});

test("removePinnedRecord on an id that was never pinned, or for a project+entity+user with no entry at all, is a harmless no-op", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    removePinnedRecord("proj1", "Deal", "userA", 99);
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set([7]), "removing an id that was never pinned must not touch the real pin");
    removePinnedRecord("proj2", "Customer", "userB", 1);
    assert.deepEqual(getPinnedRecordIds("proj2", "Customer", "userB"), new Set());
  });
});

test("pinned records are scoped per project+entity+user -- pinning one combination never affects a same-id record in a different project, a different entity, or a different user", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 7);
    assert.deepEqual(getPinnedRecordIds("proj2", "Deal", "userA"), new Set(), "a different project must not see proj1's pin");
    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userA"), new Set(), "a different entity in the same project must not see Deal's pin");
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userB"), new Set(), "a different user must not see userA's own pin");
  });
});

test("sortRecordsByPinned moves pinned records to the front, preserving each group's own relative order", () => {
  const records = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const sorted = sortRecordsByPinned(records, new Set([3, 1]));
  assert.deepEqual(sorted.map((r) => r.id), [1, 3, 2, 4]);
});

test("sortRecordsByPinned is a no-op (same array reference) when nothing is pinned", () => {
  const records = [{ id: 1 }, { id: 2 }];
  assert.equal(sortRecordsByPinned(records, new Set()), records);
});

test("getPinnedRecordIds ignores corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.pinnedRecords", "not real json{{{");
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set());
  });
});

test("purgePinnedRecordsForEntity removes every collaborator's own pins for one entity, leaving a sibling entity and a same-named entity in another project untouched", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 1);
    toggleRecordPinned("proj1", "Deal", "userB", 2);
    toggleRecordPinned("proj1", "Customer", "userA", 3);
    toggleRecordPinned("proj2", "Deal", "userA", 4);

    purgePinnedRecordsForEntity("proj1", "Deal");

    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set(), "userA's own pins for the dropped entity must be gone");
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userB"), new Set(), "userB's own pins for the dropped entity must be gone too");
    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userA"), new Set([3]), "a sibling entity in the same project must survive");
    assert.deepEqual(getPinnedRecordIds("proj2", "Deal", "userA"), new Set([4]), "a same-named entity in a different project must survive");
  });
});

test("purgePinnedRecordsForProject removes every collaborator's own pins across every entity of one project, leaving a different project untouched", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 1);
    toggleRecordPinned("proj1", "Customer", "userB", 2);
    toggleRecordPinned("proj2", "Deal", "userA", 3);

    purgePinnedRecordsForProject("proj1");

    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set());
    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userB"), new Set());
    assert.deepEqual(getPinnedRecordIds("proj2", "Deal", "userA"), new Set([3]), "a different project must survive untouched");
  });
});

test("removePinnedRecordsForUserProject removes only this one user's own pins across every entity of one project, leaving every other collaborator's own pins for the SAME project (and this user's own pins for another project) untouched", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "Deal", "userA", 1);
    toggleRecordPinned("proj1", "Customer", "userA", 2);
    toggleRecordPinned("proj1", "Deal", "userB", 3);
    toggleRecordPinned("proj2", "Deal", "userA", 4);

    removePinnedRecordsForUserProject("proj1", "userA");

    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set(), "userA's own Deal pins for the left project must be cleared");
    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userA"), new Set(), "userA's own Customer pins for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userB"), new Set([3]), "userB's own pins for the SAME still-shared project must survive");
    assert.deepEqual(getPinnedRecordIds("proj2", "Deal", "userA"), new Set([4]), "userA's own pins for an UNRELATED project must survive untouched");
  });
});

/**
 * Mirrors viewModePreference.test.ts's identical round-1549 coverage:
 * migratePinnedRecordsForEntityRename only ever runs in the single browser
 * tab that triggered a case-only entity rename -- a different
 * collaborator's own localStorage, which never saw that migration run,
 * must still resolve its real pins via getPinnedRecordIds's own
 * case-insensitive fallback, built in from this store's own creation.
 */
test("getPinnedRecordIds resolves a collaborator's own pins stored under the OLD casing, even though no migration ever ran in this browser", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "customer", "userB", 5);

    assert.deepEqual(
      getPinnedRecordIds("proj1", "Customer", "userB"),
      new Set([5]),
      "must resolve userB's own pins under the new casing via the case-insensitive fallback, with no migration ever having run",
    );
  });
});

test("getPinnedRecordIds's case-insensitive fallback never leaks a different user's or different project's own pins for the same entity name", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "customer", "userA", 1);
    toggleRecordPinned("proj2", "customer", "userB", 2);

    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userB"), new Set(), "userB has no pins of their own in proj1 -- userA's own pins for the same entity must not leak across users");
    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userA"), new Set([1]), "userA's own pins must still resolve via the fallback");
    assert.deepEqual(getPinnedRecordIds("proj2", "Customer", "userA"), new Set(), "a different project's own pins for the same entity+user combination must not leak across projects");
  });
});

test("migratePinnedRecordsForEntityRename remaps every collaborator's own pins to the new casing, merging with any pins already there, leaving a sibling entity untouched -- and a lookup under the old casing still resolves via the new case-insensitive fallback", async () => {
  await withJsdom(() => {
    toggleRecordPinned("proj1", "customer", "userA", 1);
    toggleRecordPinned("proj1", "customer", "userB", 2);
    toggleRecordPinned("proj1", "Customer", "userA", 3); // already pinned under the new casing, e.g. from a prior partial migration
    toggleRecordPinned("proj1", "Deal", "userA", 9);

    migratePinnedRecordsForEntityRename("proj1", "customer", "Customer");

    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userA"), new Set([1, 3]), "userA's pins under both casings must merge under the new casing");
    assert.deepEqual(getPinnedRecordIds("proj1", "Customer", "userB"), new Set([2]), "userB's pin must resolve under the new casing too");
    assert.deepEqual(getPinnedRecordIds("proj1", "customer", "userA"), new Set([1, 3]), "a lookup under the old casing must still resolve via getPinnedRecordIds's own case-insensitive fallback -- the intended new behavior, not a regression");
    assert.deepEqual(getPinnedRecordIds("proj1", "Deal", "userA"), new Set([9]), "a sibling entity's own pin must survive the rename untouched");
  });
});

test("migratePinnedRecordsForEntityRename is a no-op, not an error, when oldName equals newName or nothing was ever pinned", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => migratePinnedRecordsForEntityRename("proj1", "Deal", "Deal"));
    assert.doesNotThrow(() => migratePinnedRecordsForEntityRename("proj1", "Nonexistent", "Renamed"));
  });
});
