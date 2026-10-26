import "./jsdomWarmup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getColumnWidths, setColumnWidth } from "./columnWidths.js";
import { getColumnOrder, setColumnOrder } from "./columnOrder.js";
import { getHiddenFields, toggleFieldVisibility } from "./columnVisibility.js";
import { getFieldFilters, setFieldFilters } from "./fieldFiltersPreference.js";
import { getGroupByField, setGroupByField } from "./groupByPreference.js";
import { getCollapsedBoardColumns, setCollapsedBoardColumns } from "./collapsedBoardColumnsPreference.js";
import { getCollapsedGroups, setCollapsedGroups } from "./collapsedGroupsPreference.js";
import { getSortKeys, setSortKeys } from "./sortKeysPreference.js";
import { addEntityRecentSearch, getEntityRecentSearches } from "./entityRecentSearches.js";
import { addRecentHistorySearch, getRecentHistorySearches } from "./historyRecentSearches.js";
import { getPinnedIds, togglePinned } from "./pinnedProjects.js";
import { getEntityTabOrder, setEntityTabOrder } from "./entityTabOrder.js";
import { getViewMode, setViewMode } from "./viewModePreference.js";
import { addRecentSearch, getRecentSearches } from "./recentSearches.js";
import { addRecentWhatsAppNumber, getRecentWhatsAppNumbers } from "./whatsappRecentNumbers.js";
import { addWhatsAppLogRecentSearch, getWhatsAppLogRecentSearches } from "./whatsappLogRecentSearches.js";
import { getWhatsAppLogFilter, setWhatsAppLogFilter } from "./whatsappLogFilter.js";
import { getWhatsAppLastSeen, setWhatsAppLastSeen } from "./whatsappUnread.js";
import { purgeProjectPreferences } from "./projectPreferenceCleanup.js";

/** Same full-jsdom-swap technique used by columnWidths.test.ts/columnVisibility.test.ts/pinnedProjects.test.ts: real localStorage, not a mock. */
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
 * Deleting a project never touched any of the seventeen separate
 * localStorage preference stores keyed by projectId -- each one grows
 * forever for any user who creates and deletes projects over time. This
 * seeds real data into every single one of them for TWO different
 * projects (plus a third whose id, "abc-other", shares a prefix with
 * "abc" to prove the `${projectId}:` colon separator really does prevent
 * a false-positive match), calls the real purgeProjectPreferences once,
 * and confirms every store lost exactly "abc"'s own entries and nothing
 * else -- not a mock of each store's purge function, the actual public
 * read functions every other part of the app uses.
 */
test("purgeProjectPreferences removes exactly one project's entries from every preference store, leaving other projects (including one sharing an id prefix) fully intact", async () => {
  await withJsdom(() => {
    const entity = "Customer";

    // Seed "abc" -- the project being deleted.
    setColumnWidth("abc", entity, "name", 220);
    setColumnOrder("abc", entity, ["name", "email"]);
    toggleFieldVisibility("abc", entity, "email");
    setFieldFilters("abc", entity, { status: "active" });
    setGroupByField("abc", entity, "status");
    setCollapsedBoardColumns("abc", entity, "status", ["done"]);
    setCollapsedGroups("abc", entity, "status", ["pending"]);
    setSortKeys("abc", entity, [{ field: "name", direction: "asc" }]);
    setViewMode("abc", entity, "board");
    addEntityRecentSearch("abc", entity, "userA", "dana");
    addRecentHistorySearch("abc", "userA", "pricing overhaul");
    addRecentSearch("abc", "userA", "global query abc");
    addRecentWhatsAppNumber("abc", "972500000001");
    addWhatsAppLogRecentSearch("abc", "userA", "log query abc");
    setWhatsAppLogFilter("abc", "failed");
    setWhatsAppLastSeen("abc", { id: "msg-abc", createdAt: "2024-01-01T00:00:00.000Z" });
    togglePinned("userA", "abc");
    // A second collaborator account's own pin for the SAME project --
    // round 1003's own fix: any past collaborator could have pinned this
    // project under their own per-user key, so the purge must remove it
    // for every account, not just the first one seeded above.
    togglePinned("userB", "abc");
    setEntityTabOrder("abc", ["Deal", "Customer"]);

    // Seed "proj2" -- an unrelated project that must survive untouched.
    setColumnWidth("proj2", entity, "name", 300);
    setColumnOrder("proj2", entity, ["email", "name"]);
    toggleFieldVisibility("proj2", entity, "name");
    setFieldFilters("proj2", entity, { status: "closed" });
    setGroupByField("proj2", entity, "owner");
    setCollapsedBoardColumns("proj2", entity, "owner", ["archived"]);
    setCollapsedGroups("proj2", entity, "owner", ["active"]);
    setSortKeys("proj2", entity, [{ field: "email", direction: "desc" }]);
    setViewMode("proj2", entity, "calendar");
    addEntityRecentSearch("proj2", entity, "userA", "yossi");
    addRecentHistorySearch("proj2", "userA", "launch checklist");
    addRecentSearch("proj2", "userA", "global query proj2");
    addRecentWhatsAppNumber("proj2", "972500000002");
    addWhatsAppLogRecentSearch("proj2", "userA", "log query proj2");
    setWhatsAppLogFilter("proj2", "in");
    setWhatsAppLastSeen("proj2", { id: "msg-proj2", createdAt: "2024-01-01T00:00:00.000Z" });
    togglePinned("userA", "proj2");
    setEntityTabOrder("proj2", ["Customer", "Deal"]);

    // Seed "abc-other" -- a DIFFERENT project whose id starts with "abc",
    // the one case where naive prefix matching (without the colon) could
    // wrongly treat it as "abc"'s own data.
    setColumnWidth("abc-other", entity, "name", 400);
    setColumnOrder("abc-other", entity, ["name"]);
    toggleFieldVisibility("abc-other", entity, "name");
    setFieldFilters("abc-other", entity, { status: "other" });
    setGroupByField("abc-other", entity, "priority");
    setCollapsedBoardColumns("abc-other", entity, "priority", ["other"]);
    setCollapsedGroups("abc-other", entity, "priority", ["other"]);
    setSortKeys("abc-other", entity, [{ field: "status", direction: "asc" }]);
    setViewMode("abc-other", entity, "board");
    addEntityRecentSearch("abc-other", entity, "userA", "other search");
    addRecentHistorySearch("abc-other", "userA", "other checkpoint");
    addRecentSearch("abc-other", "userA", "global query abc-other");
    addRecentWhatsAppNumber("abc-other", "972500000003");
    addWhatsAppLogRecentSearch("abc-other", "userA", "log query abc-other");
    setWhatsAppLogFilter("abc-other", "out");
    setWhatsAppLastSeen("abc-other", { id: "msg-abc-other", createdAt: "2024-01-01T00:00:00.000Z" });
    togglePinned("userA", "abc-other");
    setEntityTabOrder("abc-other", ["Task", "Deal"]);

    purgeProjectPreferences("abc");

    // "abc" is gone from every single store.
    assert.deepEqual(getColumnWidths("abc", entity), {}, "columnWidths must be purged");
    assert.deepEqual(getColumnOrder("abc", entity), [], "columnOrder must be purged");
    assert.deepEqual(getHiddenFields("abc", entity), new Set(), "columnVisibility must be purged");
    assert.deepEqual(getFieldFilters("abc", entity), {}, "fieldFilters must be purged");
    assert.equal(getGroupByField("abc", entity), "", "groupBy must be purged");
    assert.deepEqual(getCollapsedBoardColumns("abc", entity, "status"), [], "collapsedBoardColumns must be purged");
    assert.deepEqual(getCollapsedGroups("abc", entity, "status"), [], "collapsedGroups must be purged");
    assert.deepEqual(getSortKeys("abc", entity), [], "sortKeys must be purged");
    assert.equal(getViewMode("abc", entity), "table", "viewMode must be purged");
    assert.deepEqual(getEntityRecentSearches("abc", entity, "userA"), [], "entityRecentSearches must be purged");
    assert.deepEqual(getRecentHistorySearches("abc", "userA"), [], "historyRecentSearches must be purged");
    assert.deepEqual(getRecentSearches("abc", "userA"), [], "recentSearches (global search) must be purged");
    assert.deepEqual(getRecentWhatsAppNumbers("abc"), [], "whatsappRecentNumbers must be purged");
    assert.deepEqual(getWhatsAppLogRecentSearches("abc", "userA"), [], "whatsappLogRecentSearches must be purged");
    assert.equal(getWhatsAppLogFilter("abc"), "all", "whatsappLogFilter must be purged");
    assert.equal(getWhatsAppLastSeen("abc"), null, "whatsappLastSeenId must be purged");
    assert.equal(getPinnedIds("userA").has("abc"), false, "pinnedProjects must be purged for userA");
    assert.equal(getPinnedIds("userB").has("abc"), false, "pinnedProjects must be purged for userB too -- any past collaborator could have pinned it under their own per-user key");
    assert.deepEqual(getEntityTabOrder("abc"), [], "entityTabOrder must be purged");

    // "proj2" -- a wholly unrelated project -- is completely untouched.
    assert.deepEqual(getColumnWidths("proj2", entity), { name: 300 }, "columnWidths must survive for an unrelated project");
    assert.deepEqual(getColumnOrder("proj2", entity), ["email", "name"], "columnOrder must survive");
    assert.deepEqual(getHiddenFields("proj2", entity), new Set(["name"]), "columnVisibility must survive");
    assert.deepEqual(getFieldFilters("proj2", entity), { status: "closed" }, "fieldFilters must survive");
    assert.equal(getGroupByField("proj2", entity), "owner", "groupBy must survive");
    assert.deepEqual(getCollapsedBoardColumns("proj2", entity, "owner"), ["archived"], "collapsedBoardColumns must survive");
    assert.deepEqual(getCollapsedGroups("proj2", entity, "owner"), ["active"], "collapsedGroups must survive");
    assert.deepEqual(getSortKeys("proj2", entity), [{ field: "email", direction: "desc" }], "sortKeys must survive");
    assert.equal(getViewMode("proj2", entity), "calendar", "viewMode must survive");
    assert.deepEqual(getEntityRecentSearches("proj2", entity, "userA"), ["yossi"], "entityRecentSearches must survive");
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["launch checklist"], "historyRecentSearches must survive");
    assert.deepEqual(getRecentSearches("proj2", "userA"), ["global query proj2"], "recentSearches (global search) must survive");
    assert.deepEqual(getRecentWhatsAppNumbers("proj2"), ["972500000002"], "whatsappRecentNumbers must survive");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj2", "userA"), ["log query proj2"], "whatsappLogRecentSearches must survive");
    assert.equal(getWhatsAppLogFilter("proj2"), "in", "whatsappLogFilter must survive");
    assert.deepEqual(getWhatsAppLastSeen("proj2"), { id: "msg-proj2", createdAt: "2024-01-01T00:00:00.000Z" }, "whatsappLastSeenId must survive");
    assert.equal(getPinnedIds("userA").has("proj2"), true, "pinnedProjects must survive");
    assert.deepEqual(getEntityTabOrder("proj2"), ["Customer", "Deal"], "entityTabOrder must survive for an unrelated project");

    // "abc-other" -- a DIFFERENT project that merely shares "abc" as a
    // prefix of its id -- must ALSO survive completely untouched. If the
    // purge ever matched by prefix without the colon separator, this is
    // exactly the case that would silently lose data.
    assert.deepEqual(getColumnWidths("abc-other", entity), { name: 400 }, "columnWidths must survive for a prefix-sharing project id");
    assert.deepEqual(getColumnOrder("abc-other", entity), ["name"], "columnOrder must survive for a prefix-sharing project id");
    assert.deepEqual(getHiddenFields("abc-other", entity), new Set(["name"]), "columnVisibility must survive for a prefix-sharing project id");
    assert.deepEqual(getFieldFilters("abc-other", entity), { status: "other" }, "fieldFilters must survive for a prefix-sharing project id");
    assert.equal(getGroupByField("abc-other", entity), "priority", "groupBy must survive for a prefix-sharing project id");
    assert.deepEqual(getCollapsedBoardColumns("abc-other", entity, "priority"), ["other"], "collapsedBoardColumns must survive for a prefix-sharing project id");
    assert.deepEqual(getCollapsedGroups("abc-other", entity, "priority"), ["other"], "collapsedGroups must survive for a prefix-sharing project id");
    assert.deepEqual(getSortKeys("abc-other", entity), [{ field: "status", direction: "asc" }], "sortKeys must survive for a prefix-sharing project id");
    assert.equal(getViewMode("abc-other", entity), "board", "viewMode must survive for a prefix-sharing project id");
    assert.deepEqual(getEntityRecentSearches("abc-other", entity, "userA"), ["other search"], "entityRecentSearches must survive for a prefix-sharing project id");
    assert.deepEqual(getRecentHistorySearches("abc-other", "userA"), ["other checkpoint"], "historyRecentSearches must survive for a prefix-sharing project id");
    assert.deepEqual(getRecentSearches("abc-other", "userA"), ["global query abc-other"], "recentSearches (global search) must survive for a prefix-sharing project id");
    assert.deepEqual(getRecentWhatsAppNumbers("abc-other"), ["972500000003"], "whatsappRecentNumbers must survive for a prefix-sharing project id");
    assert.deepEqual(getWhatsAppLogRecentSearches("abc-other", "userA"), ["log query abc-other"], "whatsappLogRecentSearches must survive for a prefix-sharing project id");
    assert.equal(getWhatsAppLogFilter("abc-other"), "out", "whatsappLogFilter must survive for a prefix-sharing project id");
    assert.deepEqual(
      getWhatsAppLastSeen("abc-other"),
      { id: "msg-abc-other", createdAt: "2024-01-01T00:00:00.000Z" },
      "whatsappLastSeenId must survive for a prefix-sharing project id",
    );
    assert.equal(getPinnedIds("userA").has("abc-other"), true, "pinnedProjects must survive for a prefix-sharing project id");
    assert.deepEqual(getEntityTabOrder("abc-other"), ["Task", "Deal"], "entityTabOrder must survive for a prefix-sharing project id");
  });
});
