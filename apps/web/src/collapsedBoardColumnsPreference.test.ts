import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  getCollapsedBoardColumns,
  migrateCollapsedBoardColumnsFieldCase,
  migrateCollapsedBoardColumnsForEntityRename,
  purgeCollapsedBoardColumnsForEntity,
  purgeCollapsedBoardColumnsForProject,
  setCollapsedBoardColumns,
} from "./collapsedBoardColumnsPreference.js";

/** Same full-jsdom-swap technique used by collapsedGroupsPreference.test.ts: real localStorage, not a mock. */
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

test("getCollapsedBoardColumns returns [] when nothing has ever been collapsed", async () => {
  await withJsdom(() => {
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), []);
  });
});

test("setCollapsedBoardColumns persists a real set, and a fresh getCollapsedBoardColumns call sees it -- a real round trip, not just the return value", async () => {
  await withJsdom(() => {
    const after = setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won", "Lost"]);
    assert.deepEqual(after, ["Won", "Lost"]);
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), ["Won", "Lost"], "must actually be written to storage, not just returned");
  });
});

test("setCollapsedBoardColumns with [] clears the persisted entry instead of storing an empty array", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won"]);
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", []);
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), []);
  });
});

test("collapsed board columns are scoped per project+entity+boardField -- changing one never affects a different project, entity, or board field", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won"]);
    assert.deepEqual(getCollapsedBoardColumns("proj2", "Deal", "stage", "userA"), [], "a different project must not see proj1's own collapsed columns");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Customer", "stage", "userA"), [], "a different entity must not see Deal's own collapsed columns");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "owner", "userA"), [], "a different board field on the SAME entity must not see 'stage's own collapsed columns");
  });
});

/**
 * Round 1077: the whole point of this round's fix. Before it, the storage
 * key had no userId segment at all -- two different collaborator accounts
 * sharing the SAME project+entity+boardField on the SAME browser silently
 * saw, and could overwrite, each other's own collapsed-column choices.
 */
test("collapsed board columns are also kept per-user -- two different accounts on the SAME project+entity+boardField never see each other's own collapsed set", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won"]);
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userB", ["Lost"]);
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), ["Won"]);
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userB"), ["Lost"], "userB must never see userA's own collapsed columns");
  });
});

test("getCollapsedBoardColumns falls back to [] for corrupted/foreign localStorage content, instead of throwing", async () => {
  await withJsdom(() => {
    localStorage.setItem("forge.collapsedBoardColumns", "not real json{{{");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), []);
  });
});

/**
 * Round 1008: migrateCollapsedBoardColumnsFieldCase remaps a stale
 * old-cased key (findBoardField resolving to a renamed field) to the new
 * one, carrying the real collapsed set forward instead of silently
 * re-expanding it. Round 1077: must resolve under the given userId, not
 * anyone else's.
 */
test("migrateCollapsedBoardColumnsFieldCase remaps a case-only field rename for the given user, leaving another user's own collapsed set untouched", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won"]);
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userB", ["Lost"]);

    const migrated = migrateCollapsedBoardColumnsFieldCase("proj1", "Deal", "Stage", "userA");

    assert.deepEqual(migrated, ["Won"], "userA's own collapsed set must resolve under the new casing");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "Stage", "userA"), ["Won"]);
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), [], "nothing must remain reachable under the old casing for userA");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userB"), ["Lost"], "userB's own entry, under a DIFFERENT userId, must survive completely untouched by userA's own rename");
  });
});

/**
 * Round 1077: purgeCollapsedBoardColumnsForEntity sweeps every
 * boardFieldName AND every collaborator's own entry -- there's no single
 * "current user" or "current board field" at entity-drop time.
 */
test("purgeCollapsedBoardColumnsForEntity removes the entity's own collapsed sets for EVERY board field and EVERY collaborator account, leaving a sibling entity untouched", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won"]);
    setCollapsedBoardColumns("proj1", "Deal", "owner", "userB", ["Dana"]);
    setCollapsedBoardColumns("proj1", "Customer", "stage", "userA", ["Active"]);

    purgeCollapsedBoardColumnsForEntity("proj1", "Deal");

    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), [], "userA's own set for one board field must be gone");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "owner", "userB"), [], "userB's own set for a DIFFERENT board field must be gone too");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Customer", "stage", "userA"), ["Active"], "a sibling entity's own collapsed set must survive untouched");
  });
});

test("purgeCollapsedBoardColumnsForProject removes every entry for this project, across every entity, board field, and collaborator, leaving another project untouched", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Deal", "stage", "userA", ["Won"]);
    setCollapsedBoardColumns("proj1", "Customer", "owner", "userB", ["Dana"]);
    setCollapsedBoardColumns("proj2", "Deal", "stage", "userA", ["Open"]);

    purgeCollapsedBoardColumnsForProject("proj1");

    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), []);
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Customer", "owner", "userB"), []);
    assert.deepEqual(getCollapsedBoardColumns("proj2", "Deal", "stage", "userA"), ["Open"], "an unrelated project must survive untouched");
  });
});

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename.
 * Round 1077: must remap every collaborator's own entry, not just one.
 */
test("migrateCollapsedBoardColumnsForEntityRename remaps every collaborator's own collapsed set to the new entity casing, leaving a sibling entity untouched", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "deal", "stage", "userA", ["Won"]);
    setCollapsedBoardColumns("proj1", "deal", "stage", "userB", ["Lost"]);
    setCollapsedBoardColumns("proj1", "Customer", "owner", "userA", ["Active"]);

    migrateCollapsedBoardColumnsForEntityRename("proj1", "deal", "Deal");

    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userA"), ["Won"], "userA's set must resolve under the new entity casing");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Deal", "stage", "userB"), ["Lost"], "userB's set must resolve under the new entity casing too");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "deal", "stage", "userA"), [], "nothing must remain reachable under the old entity casing");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Customer", "owner", "userA"), ["Active"], "a sibling entity's own collapsed set must survive the rename untouched");
  });
});
