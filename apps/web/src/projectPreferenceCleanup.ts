import { removePinnedProject } from "./pinnedProjects.js";
import { removeSeenSharedProject } from "./sharedProjectSeen.js";
import { purgeEntityTabOrderForProject } from "./entityTabOrder.js";
import { purgeColumnWidthsForProject } from "./columnWidths.js";
import { purgeColumnOrderForProject } from "./columnOrder.js";
import { purgeHiddenFieldsForProject } from "./columnVisibility.js";
import { purgeFieldFiltersForProject } from "./fieldFiltersPreference.js";
import { purgeGroupByFieldForProject } from "./groupByPreference.js";
import { purgeCollapsedBoardColumnsForProject } from "./collapsedBoardColumnsPreference.js";
import { purgeCollapsedGroupsForProject } from "./collapsedGroupsPreference.js";
import { purgeSortKeysForProject } from "./sortKeysPreference.js";
import { purgeEntityRecentSearchesForProject } from "./entityRecentSearches.js";
import { clearRecentHistorySearches } from "./historyRecentSearches.js";
import { purgeViewModeForProject } from "./viewModePreference.js";
import { clearRecentSearches } from "./recentSearches.js";
import { clearRecentWhatsAppNumbers } from "./whatsappRecentNumbers.js";
import { clearWhatsAppLogRecentSearches } from "./whatsappLogRecentSearches.js";
import { clearWhatsAppLogFilter } from "./whatsappLogFilter.js";
import { clearWhatsAppLastSeenId } from "./whatsappUnread.js";

/**
 * Deleting a project server-side (App.tsx's handleDeleteProject/
 * handleBulkDeleteProjects) never touched any of this app's own
 * client-side preference stores. At least eighteen separate localStorage
 * stores are keyed entirely by projectId (or projectId:entityName) --
 * pinned projects, column widths/order/visibility, field filters,
 * group-by choice, collapsed board columns/groups, sort keys, view mode
 * (table/board/calendar), entity tab order, per-entity recent searches,
 * Time Machine's own recent searches, Global Search's own recent
 * searches, WhatsApp's own recent-number list / log search history /
 * log filter / last-seen marker, and the "new share" seen-marker (round
 * 401) -- and none of them ever expire or reconcile against which
 * projects still exist. Every project a user creates, builds up a few
 * preferences for, and deletes leaves its entries behind forever,
 * growing every one of these stores without bound for anyone who uses
 * the app for long enough. (Round 390 first fixed this for the first
 * ten; round 392 found six more of the exact same shape that were
 * missed; round 399 found entity tab order, added by an older commit
 * that predates both of those sweeps; round 401 added the "new share"
 * store at the same time it was created, rather than leaving it to be
 * found as a future missed-store gap.)
 *
 * Called once, right after a project is actually deleted server-side, to
 * sweep every one of those stores for that one project's entries. Each
 * underlying purge function is scoped to exactly one project and leaves
 * every other project's own entries (including one whose id happens to
 * be a prefix of another, like "abc" vs "abcdef" -- the `${projectId}:`
 * keying's own colon separator prevents that from ever colliding)
 * completely untouched.
 */
export function purgeProjectPreferences(projectId: string): void {
  removePinnedProject(projectId);
  removeSeenSharedProject(projectId);
  purgeEntityTabOrderForProject(projectId);
  purgeColumnWidthsForProject(projectId);
  purgeColumnOrderForProject(projectId);
  purgeHiddenFieldsForProject(projectId);
  purgeFieldFiltersForProject(projectId);
  purgeGroupByFieldForProject(projectId);
  purgeCollapsedBoardColumnsForProject(projectId);
  purgeCollapsedGroupsForProject(projectId);
  purgeSortKeysForProject(projectId);
  purgeViewModeForProject(projectId);
  purgeEntityRecentSearchesForProject(projectId);
  clearRecentHistorySearches(projectId);
  clearRecentSearches(projectId);
  clearRecentWhatsAppNumbers(projectId);
  clearWhatsAppLogRecentSearches(projectId);
  clearWhatsAppLogFilter(projectId);
  clearWhatsAppLastSeenId(projectId);
}
