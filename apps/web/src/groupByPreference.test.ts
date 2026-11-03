import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  getGroupByField,
  getGroupByFieldType,
  migrateGroupByFieldForEntityRename,
  removeGroupByFieldForUserProject,
  setGroupByField,
  setGroupByFieldType,
} from "./groupByPreference.js";

/** Same full-jsdom-swap technique used by columnOrder.test.ts/columnWidths.test.ts: real localStorage, not a mock. */
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

test("getGroupByField returns '' when no group-by choice has ever been made", async () => {
  await withJsdom(() => {
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "");
  });
});

test("setGroupByField persists a real choice, and a fresh getGroupByField call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setGroupByField("proj1", "Deal", "userA", "status");
    assert.equal(after, "status");
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "status", "must actually be written to storage, not just returned");
  });
});

test("setGroupByField with '' clears a previously persisted choice back to 'no grouping'", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "Deal", "userA", "status");
    setGroupByField("proj1", "Deal", "userA", "");
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "", "clearing must actually remove the stored entry, not just return ''");
  });
});

test("group-by field is scoped per project+entity -- setting one project's entity never affects a same-named entity in a different project or a different entity in the same project", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "Deal", "userA", "status");
    assert.equal(getGroupByField("proj2", "Deal", "userA"), "", "a different project must not see proj1's group-by choice");
    assert.equal(getGroupByField("proj1", "Customer", "userA"), "", "a different entity in the same project must not see Deal's group-by choice");
  });
});

/**
 * Round 1075: the whole point of this round's fix. Before it, the storage
 * key was projectId+entityName alone -- two different collaborator
 * accounts sharing the SAME project+entity on the SAME browser silently
 * saw, and could overwrite, each other's own "Group by" choice.
 */
test("group-by field is also kept per-user -- two different accounts on the SAME project+entity never see each other's own group-by choice", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "Deal", "userA", "status");
    setGroupByField("proj1", "Deal", "userB", "owner");
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "status");
    assert.equal(getGroupByField("proj1", "Deal", "userB"), "owner", "userB must never see userA's own group-by choice");
  });
});

test("getGroupByField falls back to '' for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.groupByField", "not real json{{{");
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "");
  });
});

test("getGroupByField ignores a non-string value under its key (foreign data written by something else) instead of returning it", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.groupByField", JSON.stringify({ "proj1:Deal:userA": 42 }));
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "");
  });
});

test("removeGroupByFieldForUserProject removes only this one user's own group-by choice (and its paired field-type entry) across every entity of one project, leaving every other collaborator's own choice for the SAME project (and this user's own choice for another project) untouched", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "Deal", "userA", "status");
    setGroupByFieldType("proj1", "Deal", "userA", "enum");
    setGroupByField("proj1", "Contact", "userA", "owner");
    setGroupByFieldType("proj1", "Contact", "userA", "string");
    setGroupByField("proj1", "Deal", "userB", "priority");
    setGroupByFieldType("proj1", "Deal", "userB", "enum");
    setGroupByField("proj2", "Deal", "userA", "stage");
    setGroupByFieldType("proj2", "Deal", "userA", "enum");

    removeGroupByFieldForUserProject("proj1", "userA");

    assert.equal(getGroupByField("proj1", "Deal", "userA"), "", "userA's own Deal choice for the left project must be cleared");
    assert.equal(getGroupByFieldType("proj1", "Deal", "userA"), "", "userA's own Deal field-type entry for the left project must also be cleared");
    assert.equal(getGroupByField("proj1", "Contact", "userA"), "", "userA's own Contact choice for the SAME left project must also be cleared, not just one entity");
    assert.equal(getGroupByField("proj1", "Deal", "userB"), "priority", "userB's own choice for the SAME still-shared project must survive");
    assert.equal(getGroupByFieldType("proj1", "Deal", "userB"), "enum", "userB's own field-type entry must survive too");
    assert.equal(getGroupByField("proj2", "Deal", "userA"), "stage", "userA's own choice for an UNRELATED project must survive untouched");
    assert.equal(getGroupByFieldType("proj2", "Deal", "userA"), "enum", "userA's own field-type entry for an UNRELATED project must survive untouched");
  });
});

test("removeGroupByFieldForUserProject is a no-op, not an error, when this user never chose a group-by field in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeGroupByFieldForUserProject("proj1", "userA"));
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "");
  });
});

/**
 * Round 1547: migrateGroupByFieldForEntityRename only ever runs in the
 * single browser tab that triggered the rename (see getGroupByField's own
 * doc comment) -- so a different collaborator's own localStorage, which
 * never saw that migration run, must still resolve its real group-by
 * choice (and paired field type) via getGroupByField's/
 * getGroupByFieldType's new case-insensitive fallback, mirroring
 * fieldFiltersPreference.test.ts's identical round-1545 coverage.
 */
test("getGroupByField and getGroupByFieldType resolve a collaborator's own choice stored under the OLD casing, even though no migration ever ran in this browser", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "customer", "userB", "status");
    setGroupByFieldType("proj1", "customer", "userB", "enum");

    assert.equal(getGroupByField("proj1", "Customer", "userB"), "status", "must resolve userB's own group-by choice under the new casing via the case-insensitive fallback, with no migration ever having run");
    assert.equal(getGroupByFieldType("proj1", "Customer", "userB"), "enum", "the paired field-type entry must resolve the same way");
  });
});

test("getGroupByField's and getGroupByFieldType's case-insensitive fallback never leak a different user's or different project's own choice for the same entity name", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "customer", "userA", "status");
    setGroupByFieldType("proj1", "customer", "userA", "enum");
    setGroupByField("proj2", "customer", "userB", "owner");

    assert.equal(getGroupByField("proj1", "Customer", "userB"), "", "userB has no choice of their own in proj1 -- userA's own choice for the same entity must not leak across users");
    assert.equal(getGroupByField("proj1", "Customer", "userA"), "status", "userA's own choice must still resolve via the fallback");
    assert.equal(getGroupByFieldType("proj1", "Customer", "userA"), "enum", "the paired field-type entry must resolve via the fallback too");
    assert.equal(getGroupByField("proj2", "Customer", "userA"), "", "a different project's own choice for the same entity+user combination must not leak across projects");
  });
});

test("migrateGroupByFieldForEntityRename remaps every collaborator's own choice (and paired type) to the new casing, leaving a sibling entity untouched -- and a lookup under the old casing still resolves via the new case-insensitive fallback", async () => {
  await withJsdom(() => {
    setGroupByField("proj1", "customer", "userA", "status");
    setGroupByFieldType("proj1", "customer", "userA", "enum");
    setGroupByField("proj1", "customer", "userB", "owner");
    setGroupByField("proj1", "Deal", "userA", "stage");

    migrateGroupByFieldForEntityRename("proj1", "customer", "Customer");

    assert.equal(getGroupByField("proj1", "Customer", "userA"), "status", "userA's choice must resolve under the new casing");
    assert.equal(getGroupByFieldType("proj1", "Customer", "userA"), "enum", "the paired type must resolve under the new casing too");
    assert.equal(getGroupByField("proj1", "Customer", "userB"), "owner", "userB's choice must resolve under the new casing too");
    assert.equal(getGroupByField("proj1", "customer", "userA"), "status", "a lookup under the old casing must still resolve via getGroupByField's own case-insensitive fallback -- the intended new behavior, not a regression");
    assert.equal(getGroupByField("proj1", "Deal", "userA"), "stage", "a sibling entity's own choice must survive the rename untouched");
  });
});
