import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getColumnWidths, setColumnWidth } from "./columnWidths.js";
import { getColumnOrder, setColumnOrder } from "./columnOrder.js";
import { getHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";
import { getFieldFilters, setFieldFilters } from "./fieldFiltersPreference.js";
import { getGroupByField, setGroupByField, getGroupByFieldType, setGroupByFieldType } from "./groupByPreference.js";
import { getCollapsedBoardColumns, setCollapsedBoardColumns } from "./collapsedBoardColumnsPreference.js";
import { getCollapsedGroups, setCollapsedGroups } from "./collapsedGroupsPreference.js";
import { getSortKeys, setSortKeys } from "./sortKeysPreference.js";
import { getViewMode, setViewMode } from "./viewModePreference.js";
import { addEntityRecentSearch, getEntityRecentSearches } from "./entityRecentSearches.js";
import { getEntityTabOrder, setEntityTabOrder } from "./entityTabOrder.js";
import { purgeEntityPreferences, migrateEntityPreferencesForCaseRename } from "./entityPreferenceCleanup.js";

/** Same full-jsdom-swap technique used by projectPreferenceCleanup.test.ts/columnWidths.test.ts: real localStorage, not a mock. */
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

/**
 * Round 853: a refine that drops a single entity from an otherwise-
 * surviving project (App.tsx's handleBuildComplete) never purged that
 * entity's own per-entity-keyed localStorage preferences -- unlike whole-
 * project deletion, which projectPreferenceCleanup.ts already sweeps.
 * Mirrors that file's own test shape, but at entity granularity: seeds
 * every relevant store for the entity being dropped ("abc"/"Customer"),
 * a DIFFERENT entity in the SAME project ("abc"/"Deal", which must
 * survive since only one entity was dropped), and the SAME entity name
 * in a DIFFERENT project ("proj2"/"Customer", which must survive since
 * it's a wholly unrelated project) -- confirming the purge is scoped to
 * exactly the one project+entity pair, using the actual public read
 * functions every other part of the app uses, not a mock of each store.
 */
test("purgeEntityPreferences removes exactly one project+entity's entries from every per-entity preference store, leaving a sibling entity and an unrelated project's same-named entity fully intact", async () => {
  await withJsdom(() => {
    // Seed "abc"/"Customer" -- the entity being dropped by a refine.
    setColumnWidth("abc", "Customer", "name", 220);
    setColumnOrder("abc", "Customer", ["name", "email"]);
    toggleFieldVisibility("abc", "Customer", "userA", "email");
    // A DIFFERENT collaborator's own hidden-column choice for the SAME
    // project+entity -- purgeEntityPreferences must purge every user's
    // entry, the same round-1055 reasoning the fieldFilters userB seed
    // above tests.
    toggleFieldVisibility("abc", "Customer", "userB", "phone");
    setFieldFilters("abc", "Customer", "userA", { status: "active" });
    // A DIFFERENT collaborator's own filter for the SAME project+entity --
    // purgeEntityPreferences must purge every user's entry, the same
    // round-994 reasoning entityRecentSearches' own userB seed above tests.
    setFieldFilters("abc", "Customer", "userB", { status: "pending" });
    setGroupByField("abc", "Customer", "status");
    setGroupByFieldType("abc", "Customer", "enum");
    setCollapsedBoardColumns("abc", "Customer", "status", ["done"]);
    setCollapsedGroups("abc", "Customer", "status", ["pending"]);
    setSortKeys("abc", "Customer", [{ field: "name", direction: "asc" }]);
    setViewMode("abc", "Customer", "board");
    addEntityRecentSearch("abc", "Customer", "userA", "dana");
    // A DIFFERENT collaborator's own entry for the SAME project+entity --
    // purgeEntityPreferences must purge every user's entry, not just one
    // (round 994's own reasoning: there's no single "current user" at
    // purge time, since any collaborator could have searched this entity).
    addEntityRecentSearch("abc", "Customer", "userB", "other-user-query");
    // entityTabOrder is keyed by projectId alone (not projectId+entityName),
    // so it's seeded once per project below, after both of "abc"'s entities
    // are known, rather than per-entity like every other store here.

    // Seed "abc"/"Deal" -- a sibling entity in the SAME project that must
    // survive, since only "Customer" was dropped.
    setColumnWidth("abc", "Deal", "amount", 150);
    setColumnOrder("abc", "Deal", ["amount", "stage"]);
    toggleFieldVisibility("abc", "Deal", "userA", "stage");
    setFieldFilters("abc", "Deal", "userA", { stage: "won" });
    setGroupByField("abc", "Deal", "stage");
    setGroupByFieldType("abc", "Deal", "enum");
    setCollapsedBoardColumns("abc", "Deal", "stage", ["lost"]);
    setCollapsedGroups("abc", "Deal", "stage", ["open"]);
    setSortKeys("abc", "Deal", [{ field: "amount", direction: "desc" }]);
    setViewMode("abc", "Deal", "calendar");
    addEntityRecentSearch("abc", "Deal", "userA", "yossi");

    // "abc"'s own tab order, covering both of its entities.
    setEntityTabOrder("abc", ["Deal", "Customer"]);

    // Seed "proj2"/"Customer" -- the SAME entity name in a wholly
    // unrelated project, which must survive untouched.
    setColumnWidth("proj2", "Customer", "name", 300);
    setColumnOrder("proj2", "Customer", ["email", "name"]);
    toggleFieldVisibility("proj2", "Customer", "userA", "name");
    setFieldFilters("proj2", "Customer", "userA", { status: "closed" });
    setGroupByField("proj2", "Customer", "owner");
    setGroupByFieldType("proj2", "Customer", "text");
    setCollapsedBoardColumns("proj2", "Customer", "owner", ["archived"]);
    setCollapsedGroups("proj2", "Customer", "owner", ["active"]);
    setSortKeys("proj2", "Customer", [{ field: "email", direction: "desc" }]);
    setViewMode("proj2", "Customer", "calendar");
    addEntityRecentSearch("proj2", "Customer", "userA", "noa");
    // An unrelated project's own tab order, including a "Customer" entry of its own.
    setEntityTabOrder("proj2", ["Customer", "Deal"]);

    purgeEntityPreferences("abc", "Customer");

    // "abc"/"Customer" is gone from every single store.
    assert.deepEqual(getColumnWidths("abc", "Customer"), {}, "columnWidths must be purged");
    assert.deepEqual(getColumnOrder("abc", "Customer"), [], "columnOrder must be purged");
    assert.deepEqual(getHiddenFields("abc", "Customer", "userA"), new Set(), "columnVisibility must be purged");
    assert.deepEqual(getHiddenFields("abc", "Customer", "userB"), new Set(), "columnVisibility must be purged for EVERY collaborator account, not just one");
    assert.deepEqual(getFieldFilters("abc", "Customer", "userA"), {}, "fieldFilters must be purged");
    assert.deepEqual(getFieldFilters("abc", "Customer", "userB"), {}, "fieldFilters must be purged for EVERY collaborator account, not just one");
    assert.equal(getGroupByField("abc", "Customer"), "", "groupBy field must be purged");
    assert.equal(getGroupByFieldType("abc", "Customer"), "", "groupBy field type must be purged alongside it");
    assert.deepEqual(getCollapsedBoardColumns("abc", "Customer", "status"), [], "collapsedBoardColumns must be purged");
    assert.deepEqual(getCollapsedGroups("abc", "Customer", "status"), [], "collapsedGroups must be purged");
    assert.deepEqual(getSortKeys("abc", "Customer"), [], "sortKeys must be purged");
    assert.equal(getViewMode("abc", "Customer"), "table", "viewMode must be purged");
    assert.deepEqual(getEntityRecentSearches("abc", "Customer", "userA"), [], "entityRecentSearches must be purged");
    assert.deepEqual(getEntityRecentSearches("abc", "Customer", "userB"), [], "entityRecentSearches must be purged for EVERY collaborator account, not just the one who happened to search most recently");
    assert.deepEqual(getEntityTabOrder("abc"), ["Deal"], "entityTabOrder must have \"Customer\" removed, leaving the sibling entity's own position");

    // "abc"/"Deal" -- a sibling entity in the SAME project -- is completely untouched.
    assert.deepEqual(getColumnWidths("abc", "Deal"), { amount: 150 }, "columnWidths must survive for a sibling entity");
    assert.deepEqual(getColumnOrder("abc", "Deal"), ["amount", "stage"], "columnOrder must survive for a sibling entity");
    assert.deepEqual(getHiddenFields("abc", "Deal", "userA"), new Set(["stage"]), "columnVisibility must survive for a sibling entity");
    assert.deepEqual(getFieldFilters("abc", "Deal", "userA"), { stage: "won" }, "fieldFilters must survive for a sibling entity");
    assert.equal(getGroupByField("abc", "Deal"), "stage", "groupBy field must survive for a sibling entity");
    assert.equal(getGroupByFieldType("abc", "Deal"), "enum", "groupBy field type must survive for a sibling entity");
    assert.deepEqual(getCollapsedBoardColumns("abc", "Deal", "stage"), ["lost"], "collapsedBoardColumns must survive for a sibling entity");
    assert.deepEqual(getCollapsedGroups("abc", "Deal", "stage"), ["open"], "collapsedGroups must survive for a sibling entity");
    assert.deepEqual(getSortKeys("abc", "Deal"), [{ field: "amount", direction: "desc" }], "sortKeys must survive for a sibling entity");
    assert.equal(getViewMode("abc", "Deal"), "calendar", "viewMode must survive for a sibling entity");
    assert.deepEqual(getEntityRecentSearches("abc", "Deal", "userA"), ["yossi"], "entityRecentSearches must survive for a sibling entity");

    // "proj2"/"Customer" -- the same entity name in an unrelated project -- is also completely untouched.
    assert.deepEqual(getColumnWidths("proj2", "Customer"), { name: 300 }, "columnWidths must survive for an unrelated project's same-named entity");
    assert.deepEqual(getColumnOrder("proj2", "Customer"), ["email", "name"], "columnOrder must survive for an unrelated project's same-named entity");
    assert.deepEqual(getHiddenFields("proj2", "Customer", "userA"), new Set(["name"]), "columnVisibility must survive for an unrelated project's same-named entity");
    assert.deepEqual(getFieldFilters("proj2", "Customer", "userA"), { status: "closed" }, "fieldFilters must survive for an unrelated project's same-named entity");
    assert.equal(getGroupByField("proj2", "Customer"), "owner", "groupBy field must survive for an unrelated project's same-named entity");
    assert.equal(getGroupByFieldType("proj2", "Customer"), "text", "groupBy field type must survive for an unrelated project's same-named entity");
    assert.deepEqual(getCollapsedBoardColumns("proj2", "Customer", "owner"), ["archived"], "collapsedBoardColumns must survive for an unrelated project's same-named entity");
    assert.deepEqual(getCollapsedGroups("proj2", "Customer", "owner"), ["active"], "collapsedGroups must survive for an unrelated project's same-named entity");
    assert.deepEqual(getSortKeys("proj2", "Customer"), [{ field: "email", direction: "desc" }], "sortKeys must survive for an unrelated project's same-named entity");
    assert.equal(getViewMode("proj2", "Customer"), "calendar", "viewMode must survive for an unrelated project's same-named entity");
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer", "userA"), ["noa"], "entityRecentSearches must survive for an unrelated project's same-named entity");
    assert.deepEqual(getEntityTabOrder("proj2"), ["Customer", "Deal"], "an unrelated project's own tab order, including its own \"Customer\" entry, must survive fully untouched");
  });
});

/**
 * Round 877: EntitySchema/FieldSchema place no character restriction on
 * entity/field names (just a non-empty string, plus a case-insensitive
 * duplicate-name refine that "Foo" and "Foo:Bar" don't trip), so two
 * sibling entities named "Foo" and "Foo:Bar" can legally coexist in one
 * project. collapsedBoardColumnsPreference.ts and collapsedGroupsPreference.ts
 * are the only two per-entity preference stores with a third key segment
 * (boardFieldName/groupFieldName) unknown at purge time, which used to
 * force their *ForEntity purges to fall back to a colon-joined-string
 * `key.startsWith(\`${projectId}:${entityName}:\`)` scan -- and
 * `"proj:Foo:"` is a literal string-prefix of `"proj:Foo:Bar:stage"`, so
 * dropping "Foo" silently wiped the unrelated, still-live "Foo:Bar"
 * entity's own collapsed-board-column/collapsed-group preferences too.
 * Both stores now key on JSON.stringify([projectId, entityName, field])
 * instead, which makes segment boundaries unambiguous regardless of what
 * characters a segment contains.
 */
test("purgeEntityPreferences for an entity named \"Foo\" does not also wipe a sibling entity literally named \"Foo:Bar\"", async () => {
  await withJsdom(() => {
    setCollapsedBoardColumns("proj1", "Foo", "stage", ["done"]);
    setCollapsedGroups("proj1", "Foo", "stage", ["done"]);
    setCollapsedBoardColumns("proj1", "Foo:Bar", "stage", ["archived"]);
    setCollapsedGroups("proj1", "Foo:Bar", "stage", ["archived"]);

    purgeEntityPreferences("proj1", "Foo");

    assert.deepEqual(getCollapsedBoardColumns("proj1", "Foo", "stage"), [], "\"Foo\"'s own collapsedBoardColumns must be purged");
    assert.deepEqual(getCollapsedGroups("proj1", "Foo", "stage"), [], "\"Foo\"'s own collapsedGroups must be purged");
    assert.deepEqual(getCollapsedBoardColumns("proj1", "Foo:Bar", "stage"), ["archived"], "\"Foo:Bar\" must survive purging \"Foo\" -- its name merely starts with \"Foo:\", it is not a boardFieldName segment of \"Foo\"'s key");
    assert.deepEqual(getCollapsedGroups("proj1", "Foo:Bar", "stage"), ["archived"], "\"Foo:Bar\" must survive purging \"Foo\" -- its name merely starts with \"Foo:\", it is not a groupFieldName segment of \"Foo\"'s key");
  });
});

/**
 * Round 1029: a refine/restore can rename an entity by letter casing
 * alone (e.g. "customer" -> "Customer") -- round 988 (App.tsx) already
 * made sure purgeEntityPreferences above is never wrongly called against
 * this case, but nothing filled the resulting gap: every one of these 9
 * stores is keyed by the entity's CURRENT name, so the real data sat
 * unreachable under the old casing forever, indistinguishable from having
 * been silently reset. Mirrors this file's own established purge test's
 * seeding shape -- a sibling entity and an unrelated project's same-named
 * entity must both stay completely untouched by the rename.
 */
test("migrateEntityPreferencesForCaseRename moves exactly one project+entity's entries to its new casing in every per-entity preference store, leaving a sibling entity and an unrelated project's same-named entity fully intact", async () => {
  await withJsdom(() => {
    // Seed "abc"/"customer" (old casing) -- the entity a refine renamed to "Customer".
    setColumnWidth("abc", "customer", "name", 220);
    setColumnOrder("abc", "customer", ["name", "email"]);
    toggleFieldVisibility("abc", "customer", "userA", "email");
    setFieldFilters("abc", "customer", "userA", { status: "active" });
    setFieldFilters("abc", "customer", "userB", { status: "pending" });
    setGroupByField("abc", "customer", "status");
    setGroupByFieldType("abc", "customer", "enum");
    setCollapsedBoardColumns("abc", "customer", "status", ["done"]);
    setCollapsedGroups("abc", "customer", "status", ["pending"]);
    setSortKeys("abc", "customer", [{ field: "name", direction: "asc" }]);
    setViewMode("abc", "customer", "board");
    addEntityRecentSearch("abc", "customer", "userA", "dana");
    addEntityRecentSearch("abc", "customer", "userB", "other-user-query");

    // Seed "abc"/"Deal" -- a sibling entity in the SAME project that must survive untouched.
    setColumnWidth("abc", "Deal", "amount", 150);
    setGroupByField("abc", "Deal", "stage");
    addEntityRecentSearch("abc", "Deal", "userA", "yossi");

    // Seed "proj2"/"customer" -- the SAME old-cased name in an unrelated project, which must survive untouched.
    setColumnWidth("proj2", "customer", "name", 300);
    setGroupByField("proj2", "customer", "owner");
    addEntityRecentSearch("proj2", "customer", "userA", "noa");

    migrateEntityPreferencesForCaseRename("abc", "customer", "Customer");

    // Every store now resolves under the NEW casing.
    assert.deepEqual(getColumnWidths("abc", "Customer"), { name: 220 }, "columnWidths must resolve under the new casing");
    assert.deepEqual(getColumnOrder("abc", "Customer"), ["name", "email"], "columnOrder must resolve under the new casing");
    assert.deepEqual(getHiddenFields("abc", "Customer", "userA"), new Set(["email"]), "columnVisibility must resolve under the new casing");
    assert.deepEqual(getFieldFilters("abc", "Customer", "userA"), { status: "active" }, "fieldFilters must resolve under the new casing");
    assert.deepEqual(
      getFieldFilters("abc", "Customer", "userB"),
      { status: "pending" },
      "fieldFilters must resolve under the new casing for EVERY collaborator account, not just one",
    );
    assert.equal(getGroupByField("abc", "Customer"), "status", "groupBy field must resolve under the new casing");
    assert.equal(getGroupByFieldType("abc", "Customer"), "enum", "groupBy field type must resolve under the new casing, alongside its paired choice");
    assert.deepEqual(getCollapsedBoardColumns("abc", "Customer", "status"), ["done"], "collapsedBoardColumns must resolve under the new casing");
    assert.deepEqual(getCollapsedGroups("abc", "Customer", "status"), ["pending"], "collapsedGroups must resolve under the new casing");
    assert.deepEqual(getSortKeys("abc", "Customer"), [{ field: "name", direction: "asc" }], "sortKeys must resolve under the new casing");
    assert.equal(getViewMode("abc", "Customer"), "board", "viewMode must resolve under the new casing");
    assert.deepEqual(getEntityRecentSearches("abc", "Customer", "userA"), ["dana"], "entityRecentSearches must resolve under the new casing");
    assert.deepEqual(
      getEntityRecentSearches("abc", "Customer", "userB"),
      ["other-user-query"],
      "entityRecentSearches must resolve under the new casing for EVERY collaborator account, not just one",
    );

    // Nothing is left reachable under the OLD casing.
    assert.deepEqual(getColumnWidths("abc", "customer"), {}, "nothing must remain reachable under the old casing");
    assert.deepEqual(getFieldFilters("abc", "customer", "userA"), {}, "nothing must remain reachable under the old casing");
    assert.equal(getGroupByField("abc", "customer"), "", "nothing must remain reachable under the old casing");
    assert.deepEqual(getEntityRecentSearches("abc", "customer", "userA"), [], "nothing must remain reachable under the old casing");

    // "abc"/"Deal" -- a sibling entity in the SAME project -- is completely untouched.
    assert.deepEqual(getColumnWidths("abc", "Deal"), { amount: 150 }, "a sibling entity's own data must survive the rename untouched");
    assert.equal(getGroupByField("abc", "Deal"), "stage", "a sibling entity's own data must survive the rename untouched");
    assert.deepEqual(getEntityRecentSearches("abc", "Deal", "userA"), ["yossi"], "a sibling entity's own data must survive the rename untouched");

    // "proj2"/"customer" -- the same old-cased name in an unrelated project -- is also completely untouched.
    assert.deepEqual(getColumnWidths("proj2", "customer"), { name: 300 }, "an unrelated project's same-named entity must survive the rename untouched");
    assert.equal(getGroupByField("proj2", "customer"), "owner", "an unrelated project's same-named entity must survive the rename untouched");
    assert.deepEqual(getEntityRecentSearches("proj2", "customer", "userA"), ["noa"], "an unrelated project's same-named entity must survive the rename untouched");
  });
});

/**
 * Round 1029: calling the migration with the SAME name on both sides (no
 * actual rename happened) must be a true no-op -- and, more importantly,
 * must never let an already-correct NEW-cased entry get overwritten by a
 * stale OLD-cased one if this were ever called twice (e.g. a duplicate
 * refine/restore event). Confirms the "never overwrite the new key if it
 * already has its own data" guard every migrate* function shares.
 */
test("migrateEntityPreferencesForCaseRename never overwrites an entity's existing data under the new name with stale data from the old name", async () => {
  await withJsdom(() => {
    setColumnWidth("abc", "customer", "name", 100);
    setColumnWidth("abc", "Customer", "name", 999);

    migrateEntityPreferencesForCaseRename("abc", "customer", "Customer");

    assert.deepEqual(
      getColumnWidths("abc", "Customer"),
      { name: 999 },
      "an already-populated new-cased entry must never be clobbered by a stale old-cased one",
    );
  });
});
