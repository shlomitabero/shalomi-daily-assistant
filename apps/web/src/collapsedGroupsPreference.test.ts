import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  getCollapsedGroups,
  migrateCollapsedGroupsFieldCase,
  migrateCollapsedGroupsForEntityRename,
  purgeCollapsedGroupsForEntity,
  purgeCollapsedGroupsForProject,
  removeCollapsedGroupsForUserProject,
  setCollapsedGroups,
} from "./collapsedGroupsPreference.js";

/** Same full-jsdom-swap technique used by sortKeysPreference.test.ts/groupByPreference.test.ts: real localStorage, not a mock. */
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

test("getCollapsedGroups returns [] when nothing has ever been collapsed", async () => {
  await withJsdom(() => {
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), []);
  });
});

test("setCollapsedGroups persists a real set, and a fresh getCollapsedGroups call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won", "Lost"]);
    assert.deepEqual(after, ["Won", "Lost"]);
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), ["Won", "Lost"], "must actually be written to storage, not just returned");
  });
});

test("setCollapsedGroups with [] clears the persisted entry instead of storing an empty array", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "Deal", "status", "userA", []);
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), []);
  });
});

test("collapsed groups are scoped per project+entity+groupField -- changing one never affects a different project, entity, or group field", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    assert.deepEqual(getCollapsedGroups("proj2", "Deal", "status", "userA"), [], "a different project must not see proj1's own collapsed groups");
    assert.deepEqual(getCollapsedGroups("proj1", "Customer", "status", "userA"), [], "a different entity must not see Deal's own collapsed groups");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "owner", "userA"), [], "a different group field on the SAME entity must not see 'status's own collapsed groups");
  });
});

/**
 * Round 1077: the whole point of this round's fix. Before it, the storage
 * key had no userId segment at all -- two different collaborator accounts
 * sharing the SAME project+entity+groupField on the SAME browser silently
 * saw, and could overwrite, each other's own collapsed-group choices.
 */
test("collapsed groups are also kept per-user -- two different accounts on the SAME project+entity+groupField never see each other's own collapsed set", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "Deal", "status", "userB", ["Lost"]);
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), ["Won"]);
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userB"), ["Lost"], "userB must never see userA's own collapsed groups");
  });
});

test("getCollapsedGroups falls back to [] for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.collapsedGroups", "not real json{{{");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), []);
  });
});

/**
 * Round 1008: migrateCollapsedGroupsFieldCase remaps a stale old-cased key
 * (a live refine renaming "status" -> "Status") to the new one, carrying
 * the real collapsed set forward instead of silently re-expanding it.
 * Round 1077: must resolve under the given userId, not anyone else's.
 */
test("migrateCollapsedGroupsFieldCase remaps a case-only field rename for the given user, leaving another user's own collapsed set untouched", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "Deal", "status", "userB", ["Lost"]);

    const migrated = migrateCollapsedGroupsFieldCase("proj1", "Deal", "Status", "userA");

    assert.deepEqual(migrated, ["Won"], "userA's own collapsed set must resolve under the new casing");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "Status", "userA"), ["Won"]);
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), [], "nothing must remain reachable under the old casing for userA");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userB"), ["Lost"], "userB's own entry, under a DIFFERENT userId, must survive completely untouched by userA's own rename");
  });
});

/**
 * Round 1077: purgeCollapsedGroupsForEntity sweeps every groupFieldName
 * AND every collaborator's own entry -- there's no single "current user"
 * or "current group field" at entity-drop time.
 */
test("purgeCollapsedGroupsForEntity removes the entity's own collapsed sets for EVERY group field and EVERY collaborator account, leaving a sibling entity untouched", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "Deal", "owner", "userB", ["Dana"]);
    setCollapsedGroups("proj1", "Customer", "status", "userA", ["Active"]);

    purgeCollapsedGroupsForEntity("proj1", "Deal");

    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), [], "userA's own set for one group field must be gone");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "owner", "userB"), [], "userB's own set for a DIFFERENT group field must be gone too");
    assert.deepEqual(getCollapsedGroups("proj1", "Customer", "status", "userA"), ["Active"], "a sibling entity's own collapsed set must survive untouched");
  });
});

test("purgeCollapsedGroupsForProject removes every entry for this project, across every entity, group field, and collaborator, leaving another project untouched", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "Customer", "owner", "userB", ["Dana"]);
    setCollapsedGroups("proj2", "Deal", "status", "userA", ["Open"]);

    purgeCollapsedGroupsForProject("proj1");

    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), []);
    assert.deepEqual(getCollapsedGroups("proj1", "Customer", "owner", "userB"), []);
    assert.deepEqual(getCollapsedGroups("proj2", "Deal", "status", "userA"), ["Open"], "an unrelated project must survive untouched");
  });
});

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename.
 * Round 1077: must remap every collaborator's own entry, not just one.
 */
test("migrateCollapsedGroupsForEntityRename remaps every collaborator's own collapsed set to the new entity casing, leaving a sibling entity untouched", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "deal", "status", "userB", ["Lost"]);
    setCollapsedGroups("proj1", "Customer", "owner", "userA", ["Active"]);

    migrateCollapsedGroupsForEntityRename("proj1", "deal", "Deal");

    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), ["Won"], "userA's set must resolve under the new entity casing");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userB"), ["Lost"], "userB's set must resolve under the new entity casing too");
    assert.deepEqual(getCollapsedGroups("proj1", "deal", "status", "userA"), [], "nothing must remain reachable under the old entity casing");
    assert.deepEqual(getCollapsedGroups("proj1", "Customer", "owner", "userA"), ["Active"], "a sibling entity's own collapsed set must survive the rename untouched");
  });
});

test("removeCollapsedGroupsForUserProject removes only this one user's own collapsed groups across every entity+groupField of one project, leaving every other collaborator's own set for the SAME project (and this user's own set for another project) untouched", async () => {
  await withJsdom(() => {
    setCollapsedGroups("proj1", "Deal", "status", "userA", ["Won"]);
    setCollapsedGroups("proj1", "Customer", "owner", "userA", ["Active"]);
    setCollapsedGroups("proj1", "Deal", "status", "userB", ["Lost"]);
    setCollapsedGroups("proj2", "Deal", "status", "userA", ["Won"]);

    removeCollapsedGroupsForUserProject("proj1", "userA");

    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), [], "userA's own Deal set for the left project must be cleared");
    assert.deepEqual(getCollapsedGroups("proj1", "Customer", "owner", "userA"), [], "userA's own Customer set for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userB"), ["Lost"], "userB's own set for the SAME still-shared project must survive");
    assert.deepEqual(getCollapsedGroups("proj2", "Deal", "status", "userA"), ["Won"], "userA's own set for an UNRELATED project must survive untouched");
  });
});

test("removeCollapsedGroupsForUserProject is a no-op, not an error, when this user never collapsed a group in this project", async () => {
  await withJsdom(() => {
    assert.doesNotThrow(() => removeCollapsedGroupsForUserProject("proj1", "userA"));
    assert.deepEqual(getCollapsedGroups("proj1", "Deal", "status", "userA"), []);
  });
});
