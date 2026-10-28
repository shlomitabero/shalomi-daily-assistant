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
import { getSeenSharedTimestamps, markSharedProjectSeen } from "./sharedProjectSeen.js";
import { getEntityTabOrder, setEntityTabOrder } from "./entityTabOrder.js";
import { getViewMode, setViewMode } from "./viewModePreference.js";
import { addRecentSearch, getRecentSearches } from "./recentSearches.js";
import { addRecentWhatsAppNumber, getRecentWhatsAppNumbers } from "./whatsappRecentNumbers.js";
import { addWhatsAppLogRecentSearch, getWhatsAppLogRecentSearches } from "./whatsappLogRecentSearches.js";
import { getWhatsAppLogFilter, setWhatsAppLogFilter } from "./whatsappLogFilter.js";
import { getWhatsAppLastSeen, setWhatsAppLastSeen } from "./whatsappUnread.js";
import { purgeOwnProjectAccess, purgeProjectPreferences } from "./projectPreferenceCleanup.js";

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
    setColumnWidth("abc", entity, "userA", "name", 220);
    // A second collaborator account's own resized column width for the
    // SAME project -- round 1068's own fix: any past collaborator could
    // have resized a column under their own per-user key, so the purge
    // must remove it for every account, not just the first one seeded.
    setColumnWidth("abc", entity, "userB", "name", 999);
    setColumnOrder("abc", entity, "userA", ["name", "email"]);
    // A second collaborator account's own reordered columns for the SAME
    // project -- round 1069's own fix: any past collaborator could have
    // reordered columns under their own per-user key, so the purge must
    // remove it for every account, not just the first one seeded.
    setColumnOrder("abc", entity, "userB", ["email", "name"]);
    toggleFieldVisibility("abc", entity, "userA", "email");
    // A second collaborator account's own hidden-column choice for the
    // SAME project -- round 1055's own fix: any past collaborator could
    // have hidden a column under their own per-user key, so the purge
    // must remove it for every account, not just the first one seeded above.
    toggleFieldVisibility("abc", entity, "userB", "phone");
    setFieldFilters("abc", entity, "userA", { status: "active" });
    // A second collaborator account's own filter for the SAME project --
    // round 1054's own fix: any past collaborator could have filtered this
    // table under their own per-user key, so the purge must remove it for
    // every account, not just the first one seeded above.
    setFieldFilters("abc", entity, "userB", { status: "pending" });
    setGroupByField("abc", entity, "userA", "status");
    setCollapsedBoardColumns("abc", entity, "status", "userA", ["done"]);
    setCollapsedGroups("abc", entity, "status", "userA", ["pending"]);
    setSortKeys("abc", entity, "userA", [{ field: "name", direction: "asc" }]);
    setViewMode("abc", entity, "userA", "board");
    // A second collaborator account's own view-mode choice for the SAME
    // project -- round 1064's own fix: any past collaborator could have
    // switched to Board/Calendar under their own per-user key, so the
    // purge must remove it for every account, not just the first one
    // seeded above.
    setViewMode("abc", entity, "userB", "calendar");
    addEntityRecentSearch("abc", entity, "userA", "dana");
    addRecentHistorySearch("abc", "userA", "pricing overhaul");
    addRecentSearch("abc", "userA", "global query abc");
    addRecentWhatsAppNumber("abc", "userA", "972500000001");
    // A second collaborator account's own recent-number list for the SAME
    // project -- round 1011's own fix: any past collaborator could have
    // tested a WhatsApp number under their own per-user key, so the purge
    // must remove it for every account, not just the first one seeded.
    addRecentWhatsAppNumber("abc", "userB", "972500000099");
    addWhatsAppLogRecentSearch("abc", "userA", "log query abc");
    setWhatsAppLogFilter("abc", "userA", "failed");
    // A second collaborator account's own log filter for the SAME project --
    // round 1058's own fix: any past collaborator could have filtered the
    // WhatsApp log under their own per-user key, so the purge must remove
    // it for every account, not just the first one seeded above.
    setWhatsAppLogFilter("abc", "userB", "in");
    setWhatsAppLastSeen("abc", "userA", { id: "msg-abc", createdAt: "2024-01-01T00:00:00.000Z" });
    // A second collaborator account's own last-seen marker for the SAME
    // project -- round 1046's own fix: any past collaborator could have
    // read the WhatsApp log under their own per-user key, so the purge
    // must remove it for every account, not just the first one seeded.
    setWhatsAppLastSeen("abc", "userB", { id: "msg-abc-userB", createdAt: "2024-01-02T00:00:00.000Z" });
    togglePinned("userA", "abc");
    // A second collaborator account's own pin for the SAME project --
    // round 1003's own fix: any past collaborator could have pinned this
    // project under their own per-user key, so the purge must remove it
    // for every account, not just the first one seeded above.
    togglePinned("userB", "abc");
    setEntityTabOrder("abc", "userA", ["Deal", "Customer"]);
    // A second collaborator account's own reordered tabs for the SAME
    // project -- round 1067's own fix: any past collaborator could have
    // dragged this project's tabs under their own per-user key, so the
    // purge must remove it for every account, not just the first one
    // seeded above.
    setEntityTabOrder("abc", "userB", ["Customer", "Deal"]);

    // Seed "proj2" -- an unrelated project that must survive untouched.
    setColumnWidth("proj2", entity, "userA", "name", 300);
    setColumnOrder("proj2", entity, "userA", ["email", "name"]);
    toggleFieldVisibility("proj2", entity, "userA", "name");
    setFieldFilters("proj2", entity, "userA", { status: "closed" });
    setGroupByField("proj2", entity, "userA", "owner");
    setCollapsedBoardColumns("proj2", entity, "owner", "userA", ["archived"]);
    setCollapsedGroups("proj2", entity, "owner", "userA", ["active"]);
    setSortKeys("proj2", entity, "userA", [{ field: "email", direction: "desc" }]);
    setViewMode("proj2", entity, "userA", "calendar");
    addEntityRecentSearch("proj2", entity, "userA", "yossi");
    addRecentHistorySearch("proj2", "userA", "launch checklist");
    addRecentSearch("proj2", "userA", "global query proj2");
    addRecentWhatsAppNumber("proj2", "userA", "972500000002");
    addWhatsAppLogRecentSearch("proj2", "userA", "log query proj2");
    setWhatsAppLogFilter("proj2", "userA", "in");
    setWhatsAppLastSeen("proj2", "userA", { id: "msg-proj2", createdAt: "2024-01-01T00:00:00.000Z" });
    togglePinned("userA", "proj2");
    setEntityTabOrder("proj2", "userA", ["Customer", "Deal"]);

    // Seed "abc-other" -- a DIFFERENT project whose id starts with "abc",
    // the one case where naive prefix matching (without the colon) could
    // wrongly treat it as "abc"'s own data.
    setColumnWidth("abc-other", entity, "userA", "name", 400);
    setColumnOrder("abc-other", entity, "userA", ["name"]);
    toggleFieldVisibility("abc-other", entity, "userA", "name");
    setFieldFilters("abc-other", entity, "userA", { status: "other" });
    setGroupByField("abc-other", entity, "userA", "priority");
    setCollapsedBoardColumns("abc-other", entity, "priority", "userA", ["other"]);
    setCollapsedGroups("abc-other", entity, "priority", "userA", ["other"]);
    setSortKeys("abc-other", entity, "userA", [{ field: "status", direction: "asc" }]);
    setViewMode("abc-other", entity, "userA", "board");
    addEntityRecentSearch("abc-other", entity, "userA", "other search");
    addRecentHistorySearch("abc-other", "userA", "other checkpoint");
    addRecentSearch("abc-other", "userA", "global query abc-other");
    addRecentWhatsAppNumber("abc-other", "userA", "972500000003");
    addWhatsAppLogRecentSearch("abc-other", "userA", "log query abc-other");
    setWhatsAppLogFilter("abc-other", "userA", "out");
    setWhatsAppLastSeen("abc-other", "userA", { id: "msg-abc-other", createdAt: "2024-01-01T00:00:00.000Z" });
    togglePinned("userA", "abc-other");
    setEntityTabOrder("abc-other", "userA", ["Task", "Deal"]);

    purgeProjectPreferences("abc");

    // "abc" is gone from every single store.
    assert.deepEqual(getColumnWidths("abc", entity, "userA"), {}, "columnWidths must be purged for userA");
    assert.deepEqual(getColumnWidths("abc", entity, "userB"), {}, "columnWidths must be purged for userB too -- any past collaborator could have resized a column under their own per-user key");
    assert.deepEqual(getColumnOrder("abc", entity, "userA"), [], "columnOrder must be purged for userA");
    assert.deepEqual(getColumnOrder("abc", entity, "userB"), [], "columnOrder must be purged for userB too -- any past collaborator could have reordered columns under their own per-user key");
    assert.deepEqual(getHiddenFields("abc", entity, "userA"), new Set(), "columnVisibility must be purged for userA");
    assert.deepEqual(getHiddenFields("abc", entity, "userB"), new Set(), "columnVisibility must be purged for userB too -- any past collaborator could have hidden a column under their own per-user key");
    assert.deepEqual(getFieldFilters("abc", entity, "userA"), {}, "fieldFilters must be purged for userA");
    assert.deepEqual(getFieldFilters("abc", entity, "userB"), {}, "fieldFilters must be purged for userB too -- any past collaborator could have filtered under their own per-user key");
    assert.equal(getGroupByField("abc", entity, "userA"), "", "groupBy must be purged");
    assert.deepEqual(getCollapsedBoardColumns("abc", entity, "status", "userA"), [], "collapsedBoardColumns must be purged");
    assert.deepEqual(getCollapsedGroups("abc", entity, "status", "userA"), [], "collapsedGroups must be purged");
    assert.deepEqual(getSortKeys("abc", entity, "userA"), [], "sortKeys must be purged");
    assert.equal(getViewMode("abc", entity, "userA"), "table", "viewMode must be purged for userA");
    assert.equal(getViewMode("abc", entity, "userB"), "table", "viewMode must be purged for userB too -- any past collaborator could have switched views under their own per-user key");
    assert.deepEqual(getEntityRecentSearches("abc", entity, "userA"), [], "entityRecentSearches must be purged");
    assert.deepEqual(getRecentHistorySearches("abc", "userA"), [], "historyRecentSearches must be purged");
    assert.deepEqual(getRecentSearches("abc", "userA"), [], "recentSearches (global search) must be purged");
    assert.deepEqual(getRecentWhatsAppNumbers("abc", "userA"), [], "whatsappRecentNumbers must be purged for userA");
    assert.deepEqual(getRecentWhatsAppNumbers("abc", "userB"), [], "whatsappRecentNumbers must be purged for userB too -- any past collaborator could have tested a number under their own per-user key");
    assert.deepEqual(getWhatsAppLogRecentSearches("abc", "userA"), [], "whatsappLogRecentSearches must be purged");
    assert.equal(getWhatsAppLogFilter("abc", "userA"), "all", "whatsappLogFilter must be purged for userA");
    assert.equal(getWhatsAppLogFilter("abc", "userB"), "all", "whatsappLogFilter must be purged for userB too -- any past collaborator could have filtered under their own per-user key");
    assert.equal(getWhatsAppLastSeen("abc", "userA"), null, "whatsappLastSeenId must be purged for userA");
    assert.equal(getWhatsAppLastSeen("abc", "userB"), null, "whatsappLastSeenId must be purged for userB too -- any past collaborator could have read the log under their own per-user key");
    assert.equal(getPinnedIds("userA").has("abc"), false, "pinnedProjects must be purged for userA");
    assert.equal(getPinnedIds("userB").has("abc"), false, "pinnedProjects must be purged for userB too -- any past collaborator could have pinned it under their own per-user key");
    assert.deepEqual(getEntityTabOrder("abc", "userA"), [], "entityTabOrder must be purged for userA");
    assert.deepEqual(getEntityTabOrder("abc", "userB"), [], "entityTabOrder must be purged for userB too -- any past collaborator could have reordered tabs under their own per-user key");

    // "proj2" -- a wholly unrelated project -- is completely untouched.
    assert.deepEqual(getColumnWidths("proj2", entity, "userA"), { name: 300 }, "columnWidths must survive for an unrelated project");
    assert.deepEqual(getColumnOrder("proj2", entity, "userA"), ["email", "name"], "columnOrder must survive");
    assert.deepEqual(getHiddenFields("proj2", entity, "userA"), new Set(["name"]), "columnVisibility must survive");
    assert.deepEqual(getFieldFilters("proj2", entity, "userA"), { status: "closed" }, "fieldFilters must survive");
    assert.equal(getGroupByField("proj2", entity, "userA"), "owner", "groupBy must survive");
    assert.deepEqual(getCollapsedBoardColumns("proj2", entity, "owner", "userA"), ["archived"], "collapsedBoardColumns must survive");
    assert.deepEqual(getCollapsedGroups("proj2", entity, "owner", "userA"), ["active"], "collapsedGroups must survive");
    assert.deepEqual(getSortKeys("proj2", entity, "userA"), [{ field: "email", direction: "desc" }], "sortKeys must survive");
    assert.equal(getViewMode("proj2", entity, "userA"), "calendar", "viewMode must survive");
    assert.deepEqual(getEntityRecentSearches("proj2", entity, "userA"), ["yossi"], "entityRecentSearches must survive");
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["launch checklist"], "historyRecentSearches must survive");
    assert.deepEqual(getRecentSearches("proj2", "userA"), ["global query proj2"], "recentSearches (global search) must survive");
    assert.deepEqual(getRecentWhatsAppNumbers("proj2", "userA"), ["972500000002"], "whatsappRecentNumbers must survive");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj2", "userA"), ["log query proj2"], "whatsappLogRecentSearches must survive");
    assert.equal(getWhatsAppLogFilter("proj2", "userA"), "in", "whatsappLogFilter must survive");
    assert.deepEqual(getWhatsAppLastSeen("proj2", "userA"), { id: "msg-proj2", createdAt: "2024-01-01T00:00:00.000Z" }, "whatsappLastSeenId must survive");
    assert.equal(getPinnedIds("userA").has("proj2"), true, "pinnedProjects must survive");
    assert.deepEqual(getEntityTabOrder("proj2", "userA"), ["Customer", "Deal"], "entityTabOrder must survive for an unrelated project");

    // "abc-other" -- a DIFFERENT project that merely shares "abc" as a
    // prefix of its id -- must ALSO survive completely untouched. If the
    // purge ever matched by prefix without the colon separator, this is
    // exactly the case that would silently lose data.
    assert.deepEqual(getColumnWidths("abc-other", entity, "userA"), { name: 400 }, "columnWidths must survive for a prefix-sharing project id");
    assert.deepEqual(getColumnOrder("abc-other", entity, "userA"), ["name"], "columnOrder must survive for a prefix-sharing project id");
    assert.deepEqual(getHiddenFields("abc-other", entity, "userA"), new Set(["name"]), "columnVisibility must survive for a prefix-sharing project id");
    assert.deepEqual(getFieldFilters("abc-other", entity, "userA"), { status: "other" }, "fieldFilters must survive for a prefix-sharing project id");
    assert.equal(getGroupByField("abc-other", entity, "userA"), "priority", "groupBy must survive for a prefix-sharing project id");
    assert.deepEqual(getCollapsedBoardColumns("abc-other", entity, "priority", "userA"), ["other"], "collapsedBoardColumns must survive for a prefix-sharing project id");
    assert.deepEqual(getCollapsedGroups("abc-other", entity, "priority", "userA"), ["other"], "collapsedGroups must survive for a prefix-sharing project id");
    assert.deepEqual(getSortKeys("abc-other", entity, "userA"), [{ field: "status", direction: "asc" }], "sortKeys must survive for a prefix-sharing project id");
    assert.equal(getViewMode("abc-other", entity, "userA"), "board", "viewMode must survive for a prefix-sharing project id");
    assert.deepEqual(getEntityRecentSearches("abc-other", entity, "userA"), ["other search"], "entityRecentSearches must survive for a prefix-sharing project id");
    assert.deepEqual(getRecentHistorySearches("abc-other", "userA"), ["other checkpoint"], "historyRecentSearches must survive for a prefix-sharing project id");
    assert.deepEqual(getRecentSearches("abc-other", "userA"), ["global query abc-other"], "recentSearches (global search) must survive for a prefix-sharing project id");
    assert.deepEqual(getRecentWhatsAppNumbers("abc-other", "userA"), ["972500000003"], "whatsappRecentNumbers must survive for a prefix-sharing project id");
    assert.deepEqual(getWhatsAppLogRecentSearches("abc-other", "userA"), ["log query abc-other"], "whatsappLogRecentSearches must survive for a prefix-sharing project id");
    assert.equal(getWhatsAppLogFilter("abc-other", "userA"), "out", "whatsappLogFilter must survive for a prefix-sharing project id");
    assert.deepEqual(
      getWhatsAppLastSeen("abc-other", "userA"),
      { id: "msg-abc-other", createdAt: "2024-01-01T00:00:00.000Z" },
      "whatsappLastSeenId must survive for a prefix-sharing project id",
    );
    assert.equal(getPinnedIds("userA").has("abc-other"), true, "pinnedProjects must survive for a prefix-sharing project id");
    assert.deepEqual(getEntityTabOrder("abc-other", "userA"), ["Task", "Deal"], "entityTabOrder must survive for a prefix-sharing project id");
  });
});

/**
 * Round 1125: `purgeProjectPreferences` above is only correct once the
 * project itself is actually gone -- then there's no single "current
 * user" to scope a removal to, since any OTHER collaborator could have
 * their own pin/seen-share entry for it. But two of its real callers
 * (handleAccountDeleted's sharedProjectIds loop; CollaboratorsPanel's
 * self-service "leave project") never represent a real deletion at all --
 * only THIS one user's own access to a project that's still fully alive
 * for everyone else ends. Confirms `purgeOwnProjectAccess` -- the
 * narrower fix for exactly those two call sites -- removes only userA's
 * own pin and "new share" acknowledgment for the one project in
 * question, leaving userB's own entries for that SAME project (and
 * userA's own entries for a wholly unrelated project) completely intact.
 * `removePinnedProject`/`removeSeenSharedProject` already existed for
 * exactly this purpose but were never actually called from anywhere
 * before this round -- confirmed via a real grep across apps/web/src.
 */
test("purgeOwnProjectAccess removes only this one user's own pin and 'new share' acknowledgment for one project, leaving every other collaborator's own entries (and this user's own entries for other projects) untouched", async () => {
  await withJsdom(() => {
    togglePinned("userA", "abc");
    togglePinned("userA", "proj2");
    togglePinned("userB", "abc");
    markSharedProjectSeen("userA", "abc", "2024-01-01T00:00:00.000Z");
    markSharedProjectSeen("userA", "proj2", "2024-02-01T00:00:00.000Z");
    markSharedProjectSeen("userB", "abc", "2024-03-01T00:00:00.000Z");

    purgeOwnProjectAccess("userA", "abc");

    assert.equal(getPinnedIds("userA").has("abc"), false, "userA's own pin for the project they just left/lost access to must be removed");
    assert.equal(getPinnedIds("userA").has("proj2"), true, "userA's own pin for an UNRELATED project must survive untouched");
    assert.equal(
      getPinnedIds("userB").has("abc"),
      true,
      "userB's own pin for the SAME still-shared project must survive -- this is the exact cross-account corruption the broad purgeProjectPreferences would have caused",
    );
    assert.equal(getSeenSharedTimestamps("userA").has("abc"), false, "userA's own 'new share' acknowledgment for the project they just left/lost access to must be removed");
    assert.equal(getSeenSharedTimestamps("userA").has("proj2"), true, "userA's own 'new share' acknowledgment for an UNRELATED project must survive untouched");
    assert.equal(
      getSeenSharedTimestamps("userB").has("abc"),
      true,
      "userB's own 'new share' acknowledgment for the SAME still-shared project must survive -- otherwise it silently reappears as 'new' for them with no action on their part",
    );
  });
});

/**
 * Round 1127: round 1125 explicitly deferred seven more per-user-keyed
 * stores (entityTabOrder, historyRecentSearches, recentSearches,
 * whatsappRecentNumbers, whatsappLogRecentSearches, whatsappLogFilter,
 * whatsappUnread) as "lower-stakes, not touched here" -- but it also
 * stopped routing `handleAccountDeleted`'s `sharedProjectIds` loop and
 * CollaboratorsPanel's `onLeft` through the broad `purgeProjectPreferences`
 * sweep that used to reach all seven (for every collaborator, which was
 * itself the bug those two call sites needed fixing for). The result: for
 * those two specific events, none of these seven stores was cleared by
 * ANYTHING at all for the departing user -- reopening the exact same
 * unbounded-growth bug class rounds 390-1124 already fixed for every
 * other store that has it, just for this one newer "access revoked, not
 * deleted" event path. Confirms `purgeOwnProjectAccess` now clears all
 * seven for userA's own entry on the one project, while leaving userB's
 * own entries for that SAME still-shared project, and userA's own entries
 * for an UNRELATED project, both fully intact -- the exact same
 * other-collaborator-survives / other-project-survives shape the
 * pin/seen-share test above already proves for the first two stores.
 */
test("purgeOwnProjectAccess also clears this one user's own entityTabOrder/historyRecentSearches/recentSearches/whatsappRecentNumbers/whatsappLogRecentSearches/whatsappLogFilter/whatsappLastSeen entries for the one project, leaving every other collaborator's own entries (and this user's own entries for other projects) untouched", async () => {
  await withJsdom(() => {
    setEntityTabOrder("abc", "userA", ["Task", "Project"]);
    setEntityTabOrder("proj2", "userA", ["Contact"]);
    setEntityTabOrder("abc", "userB", ["Invoice"]);
    addRecentHistorySearch("abc", "userA", "pricing overhaul");
    addRecentHistorySearch("proj2", "userA", "launch plan");
    addRecentHistorySearch("abc", "userB", "security audit");
    addRecentSearch("abc", "userA", "overdue invoices");
    addRecentSearch("proj2", "userA", "q3 leads");
    addRecentSearch("abc", "userB", "churned customers");
    addRecentWhatsAppNumber("abc", "userA", "+15551234567");
    addRecentWhatsAppNumber("proj2", "userA", "+15559876543");
    addRecentWhatsAppNumber("abc", "userB", "+15550001111");
    addWhatsAppLogRecentSearch("abc", "userA", "delivery failed");
    addWhatsAppLogRecentSearch("proj2", "userA", "appointment");
    addWhatsAppLogRecentSearch("abc", "userB", "invoice reminder");
    setWhatsAppLogFilter("abc", "userA", "failed");
    setWhatsAppLogFilter("proj2", "userA", "in");
    setWhatsAppLogFilter("abc", "userB", "out");
    setWhatsAppLastSeen("abc", "userA", { id: "msg-1", createdAt: "2024-01-01T00:00:00.000Z" });
    setWhatsAppLastSeen("proj2", "userA", { id: "msg-2", createdAt: "2024-02-01T00:00:00.000Z" });
    setWhatsAppLastSeen("abc", "userB", { id: "msg-3", createdAt: "2024-03-01T00:00:00.000Z" });

    purgeOwnProjectAccess("userA", "abc");

    assert.deepEqual(getEntityTabOrder("abc", "userA"), [], "userA's own tab order for the project they just left/lost access to must be cleared");
    assert.deepEqual(getEntityTabOrder("proj2", "userA"), ["Contact"], "userA's own tab order for an UNRELATED project must survive untouched");
    assert.deepEqual(getEntityTabOrder("abc", "userB"), ["Invoice"], "userB's own tab order for the SAME still-shared project must survive");

    assert.deepEqual(getRecentHistorySearches("abc", "userA"), [], "userA's own History search list for the left project must be cleared");
    assert.deepEqual(getRecentHistorySearches("proj2", "userA"), ["launch plan"], "userA's own History search list for an UNRELATED project must survive");
    assert.deepEqual(getRecentHistorySearches("abc", "userB"), ["security audit"], "userB's own History search list for the SAME project must survive");

    assert.deepEqual(getRecentSearches("abc", "userA"), [], "userA's own Global Search list for the left project must be cleared");
    assert.deepEqual(getRecentSearches("proj2", "userA"), ["q3 leads"], "userA's own Global Search list for an UNRELATED project must survive");
    assert.deepEqual(getRecentSearches("abc", "userB"), ["churned customers"], "userB's own Global Search list for the SAME project must survive");

    assert.deepEqual(getRecentWhatsAppNumbers("abc", "userA"), [], "userA's own recent WhatsApp numbers for the left project must be cleared");
    assert.deepEqual(getRecentWhatsAppNumbers("proj2", "userA"), ["+15559876543"], "userA's own recent WhatsApp numbers for an UNRELATED project must survive");
    assert.deepEqual(getRecentWhatsAppNumbers("abc", "userB"), ["+15550001111"], "userB's own recent WhatsApp numbers for the SAME project must survive");

    assert.deepEqual(getWhatsAppLogRecentSearches("abc", "userA"), [], "userA's own WhatsApp log search list for the left project must be cleared");
    assert.deepEqual(getWhatsAppLogRecentSearches("proj2", "userA"), ["appointment"], "userA's own WhatsApp log search list for an UNRELATED project must survive");
    assert.deepEqual(getWhatsAppLogRecentSearches("abc", "userB"), ["invoice reminder"], "userB's own WhatsApp log search list for the SAME project must survive");

    assert.equal(getWhatsAppLogFilter("abc", "userA"), "all", "userA's own WhatsApp log filter for the left project must reset to 'all'");
    assert.equal(getWhatsAppLogFilter("proj2", "userA"), "in", "userA's own WhatsApp log filter for an UNRELATED project must survive");
    assert.equal(getWhatsAppLogFilter("abc", "userB"), "out", "userB's own WhatsApp log filter for the SAME project must survive");

    assert.equal(getWhatsAppLastSeen("abc", "userA"), null, "userA's own WhatsApp last-seen marker for the left project must be cleared");
    assert.deepEqual(getWhatsAppLastSeen("proj2", "userA"), { id: "msg-2", createdAt: "2024-02-01T00:00:00.000Z" }, "userA's own last-seen marker for an UNRELATED project must survive");
    assert.deepEqual(getWhatsAppLastSeen("abc", "userB"), { id: "msg-3", createdAt: "2024-03-01T00:00:00.000Z" }, "userB's own last-seen marker for the SAME project must survive");
  });
});

/**
 * Round 1128: round 1127's own doc comment on `purgeOwnProjectAccess`
 * named `entityRecentSearches.ts` as an eighth per-user-keyed store it
 * still didn't reach, deliberately left for a dedicated look since its
 * per-(projectId,entityName,userId) compound key inside one shared blob
 * needs enumerating every entity rather than a single exact key. Confirms
 * `purgeOwnProjectAccess` now also clears userA's own entity-search lists
 * for the project across MULTIPLE entities at once, while userB's own
 * list for the SAME entity on the SAME still-shared project, and userA's
 * own list for an UNRELATED project, both survive untouched.
 */
test("purgeOwnProjectAccess also clears this one user's own entityRecentSearches lists across every entity of the one project, leaving every other collaborator's own lists for the SAME project (and this user's own lists for other projects) untouched", async () => {
  await withJsdom(() => {
    addEntityRecentSearch("abc", "Customer", "userA", "overdue invoices");
    addEntityRecentSearch("abc", "Order", "userA", "refunds");
    addEntityRecentSearch("abc", "Customer", "userB", "vip clients");
    addEntityRecentSearch("proj2", "Customer", "userA", "q3 leads");

    purgeOwnProjectAccess("userA", "abc");

    assert.deepEqual(getEntityRecentSearches("abc", "Customer", "userA"), [], "userA's own Customer search list for the left project must be cleared");
    assert.deepEqual(getEntityRecentSearches("abc", "Order", "userA"), [], "userA's own Order search list for the SAME left project must also be cleared");
    assert.deepEqual(getEntityRecentSearches("abc", "Customer", "userB"), ["vip clients"], "userB's own search list for the SAME still-shared project must survive");
    assert.deepEqual(getEntityRecentSearches("proj2", "Customer", "userA"), ["q3 leads"], "userA's own search list for an UNRELATED project must survive untouched");
  });
});

/**
 * Round 1145: round 1128's own closing note (and its mirror in
 * docs/roadmap.md) incorrectly claimed nine more per-user-keyed stores --
 * columnWidths, columnOrder, columnVisibility, fieldFiltersPreference,
 * groupByPreference, collapsedBoardColumnsPreference,
 * collapsedGroupsPreference, sortKeysPreference, viewModePreference --
 * were "NOT per-user-keyed at all", so `purgeOwnProjectAccess` never
 * reached any of them. Every one of those nine files' own `keyFor` has
 * taken `userId` as an explicit parameter since rounds 1054-1077, so each
 * has the identical leak this function exists to close. Confirms
 * `purgeOwnProjectAccess` now also clears userA's own entry in all nine
 * stores, across multiple entities where the store is entity-scoped, while
 * userB's own entries for the SAME still-shared project, and userA's own
 * entries for an UNRELATED project, all survive untouched.
 */
test("purgeOwnProjectAccess also clears this one user's own columnWidths/columnOrder/columnVisibility/fieldFilters/groupBy/collapsedBoardColumns/collapsedGroups/sortKeys/viewMode entries for the one project, leaving every other collaborator's own entries (and this user's own entries for other projects) untouched", async () => {
  await withJsdom(() => {
    setColumnWidth("abc", "Customer", "userA", "name", 220);
    setColumnWidth("abc", "Order", "userA", "total", 180);
    setColumnWidth("abc", "Customer", "userB", "name", 300);
    setColumnWidth("proj2", "Customer", "userA", "name", 260);

    setColumnOrder("abc", "Customer", "userA", ["email", "name"]);
    setColumnOrder("abc", "Order", "userA", ["total", "date"]);
    setColumnOrder("abc", "Customer", "userB", ["name", "email"]);
    setColumnOrder("proj2", "Customer", "userA", ["phone", "name"]);

    toggleFieldVisibility("abc", "Customer", "userA", "notes");
    toggleFieldVisibility("abc", "Order", "userA", "total");
    toggleFieldVisibility("abc", "Customer", "userB", "phone");
    toggleFieldVisibility("proj2", "Customer", "userA", "email");

    setFieldFilters("abc", "Customer", "userA", { status: "overdue" });
    setFieldFilters("abc", "Order", "userA", { status: "shipped" });
    setFieldFilters("abc", "Customer", "userB", { status: "paid" });
    setFieldFilters("proj2", "Customer", "userA", { status: "closed" });

    setGroupByField("abc", "Customer", "userA", "status");
    setGroupByField("abc", "Order", "userA", "owner");
    setGroupByField("abc", "Customer", "userB", "priority");
    setGroupByField("proj2", "Customer", "userA", "stage");

    setCollapsedBoardColumns("abc", "Customer", "status", "userA", ["Won"]);
    setCollapsedBoardColumns("abc", "Order", "owner", "userA", ["Active"]);
    setCollapsedBoardColumns("abc", "Customer", "status", "userB", ["Lost"]);
    setCollapsedBoardColumns("proj2", "Customer", "status", "userA", ["Won"]);

    setCollapsedGroups("abc", "Customer", "status", "userA", ["Won"]);
    setCollapsedGroups("abc", "Order", "owner", "userA", ["Active"]);
    setCollapsedGroups("abc", "Customer", "status", "userB", ["Lost"]);
    setCollapsedGroups("proj2", "Customer", "status", "userA", ["Won"]);

    setSortKeys("abc", "Customer", "userA", [{ field: "status", direction: "asc" }]);
    setSortKeys("abc", "Order", "userA", [{ field: "total", direction: "desc" }]);
    setSortKeys("abc", "Customer", "userB", [{ field: "name", direction: "asc" }]);
    setSortKeys("proj2", "Customer", "userA", [{ field: "status", direction: "asc" }]);

    setViewMode("abc", "Customer", "userA", "board");
    setViewMode("abc", "Order", "userA", "calendar");
    setViewMode("abc", "Customer", "userB", "calendar");
    setViewMode("proj2", "Customer", "userA", "board");

    purgeOwnProjectAccess("userA", "abc");

    assert.deepEqual(getColumnWidths("abc", "Customer", "userA"), {}, "userA's own columnWidths for the left project must be cleared");
    assert.deepEqual(getColumnWidths("abc", "Order", "userA"), {}, "userA's own columnWidths for the SAME left project must also be cleared, not just one entity");
    assert.deepEqual(getColumnWidths("abc", "Customer", "userB"), { name: 300 }, "userB's own columnWidths for the SAME still-shared project must survive");
    assert.deepEqual(getColumnWidths("proj2", "Customer", "userA"), { name: 260 }, "userA's own columnWidths for an UNRELATED project must survive untouched");

    assert.deepEqual(getColumnOrder("abc", "Customer", "userA"), [], "userA's own columnOrder for the left project must be cleared");
    assert.deepEqual(getColumnOrder("abc", "Order", "userA"), [], "userA's own columnOrder for the SAME left project must also be cleared");
    assert.deepEqual(getColumnOrder("abc", "Customer", "userB"), ["name", "email"], "userB's own columnOrder for the SAME still-shared project must survive");
    assert.deepEqual(getColumnOrder("proj2", "Customer", "userA"), ["phone", "name"], "userA's own columnOrder for an UNRELATED project must survive untouched");

    assert.deepEqual(getHiddenFields("abc", "Customer", "userA"), new Set(), "userA's own columnVisibility for the left project must be cleared");
    assert.deepEqual(getHiddenFields("abc", "Order", "userA"), new Set(), "userA's own columnVisibility for the SAME left project must also be cleared");
    assert.deepEqual(getHiddenFields("abc", "Customer", "userB"), new Set(["phone"]), "userB's own columnVisibility for the SAME still-shared project must survive");
    assert.deepEqual(getHiddenFields("proj2", "Customer", "userA"), new Set(["email"]), "userA's own columnVisibility for an UNRELATED project must survive untouched");

    assert.deepEqual(getFieldFilters("abc", "Customer", "userA"), {}, "userA's own fieldFilters for the left project must be cleared");
    assert.deepEqual(getFieldFilters("abc", "Order", "userA"), {}, "userA's own fieldFilters for the SAME left project must also be cleared");
    assert.deepEqual(getFieldFilters("abc", "Customer", "userB"), { status: "paid" }, "userB's own fieldFilters for the SAME still-shared project must survive");
    assert.deepEqual(getFieldFilters("proj2", "Customer", "userA"), { status: "closed" }, "userA's own fieldFilters for an UNRELATED project must survive untouched");

    assert.equal(getGroupByField("abc", "Customer", "userA"), "", "userA's own groupBy for the left project must be cleared");
    assert.equal(getGroupByField("abc", "Order", "userA"), "", "userA's own groupBy for the SAME left project must also be cleared");
    assert.equal(getGroupByField("abc", "Customer", "userB"), "priority", "userB's own groupBy for the SAME still-shared project must survive");
    assert.equal(getGroupByField("proj2", "Customer", "userA"), "stage", "userA's own groupBy for an UNRELATED project must survive untouched");

    assert.deepEqual(getCollapsedBoardColumns("abc", "Customer", "status", "userA"), [], "userA's own collapsedBoardColumns for the left project must be cleared");
    assert.deepEqual(getCollapsedBoardColumns("abc", "Order", "owner", "userA"), [], "userA's own collapsedBoardColumns for the SAME left project must also be cleared");
    assert.deepEqual(getCollapsedBoardColumns("abc", "Customer", "status", "userB"), ["Lost"], "userB's own collapsedBoardColumns for the SAME still-shared project must survive");
    assert.deepEqual(getCollapsedBoardColumns("proj2", "Customer", "status", "userA"), ["Won"], "userA's own collapsedBoardColumns for an UNRELATED project must survive untouched");

    assert.deepEqual(getCollapsedGroups("abc", "Customer", "status", "userA"), [], "userA's own collapsedGroups for the left project must be cleared");
    assert.deepEqual(getCollapsedGroups("abc", "Order", "owner", "userA"), [], "userA's own collapsedGroups for the SAME left project must also be cleared");
    assert.deepEqual(getCollapsedGroups("abc", "Customer", "status", "userB"), ["Lost"], "userB's own collapsedGroups for the SAME still-shared project must survive");
    assert.deepEqual(getCollapsedGroups("proj2", "Customer", "status", "userA"), ["Won"], "userA's own collapsedGroups for an UNRELATED project must survive untouched");

    assert.deepEqual(getSortKeys("abc", "Customer", "userA"), [], "userA's own sortKeys for the left project must be cleared");
    assert.deepEqual(getSortKeys("abc", "Order", "userA"), [], "userA's own sortKeys for the SAME left project must also be cleared");
    assert.deepEqual(getSortKeys("abc", "Customer", "userB"), [{ field: "name", direction: "asc" }], "userB's own sortKeys for the SAME still-shared project must survive");
    assert.deepEqual(getSortKeys("proj2", "Customer", "userA"), [{ field: "status", direction: "asc" }], "userA's own sortKeys for an UNRELATED project must survive untouched");

    assert.equal(getViewMode("abc", "Customer", "userA"), "table", "userA's own viewMode for the left project must be cleared");
    assert.equal(getViewMode("abc", "Order", "userA"), "table", "userA's own viewMode for the SAME left project must also be cleared");
    assert.equal(getViewMode("abc", "Customer", "userB"), "calendar", "userB's own viewMode for the SAME still-shared project must survive");
    assert.equal(getViewMode("proj2", "Customer", "userA"), "board", "userA's own viewMode for an UNRELATED project must survive untouched");
  });
});
