import { purgePinnedProjectForProject, removePinnedProject } from "./pinnedProjects.js";
import { purgeSeenSharedProjectsForProject, removeSeenSharedProject } from "./sharedProjectSeen.js";
import { purgeEntityTabOrderForProject, removeEntityTabOrder } from "./entityTabOrder.js";
import { purgeColumnWidthsForProject } from "./columnWidths.js";
import { purgeColumnOrderForProject } from "./columnOrder.js";
import { purgeHiddenFieldsForProject } from "./columnVisibility.js";
import { purgeFieldFiltersForProject } from "./fieldFiltersPreference.js";
import { purgeGroupByFieldForProject } from "./groupByPreference.js";
import { purgeCollapsedBoardColumnsForProject } from "./collapsedBoardColumnsPreference.js";
import { purgeCollapsedGroupsForProject } from "./collapsedGroupsPreference.js";
import { purgeSortKeysForProject } from "./sortKeysPreference.js";
import { purgeEntityRecentSearchesForProject } from "./entityRecentSearches.js";
import { purgeRecentHistorySearchesForProject, clearRecentHistorySearches } from "./historyRecentSearches.js";
import { purgeViewModeForProject } from "./viewModePreference.js";
import { purgeRecentSearchesForProject, clearRecentSearches } from "./recentSearches.js";
import { purgeRecentWhatsAppNumbersForProject, clearRecentWhatsAppNumbers } from "./whatsappRecentNumbers.js";
import { purgeWhatsAppLogRecentSearchesForProject, clearWhatsAppLogRecentSearches } from "./whatsappLogRecentSearches.js";
import { purgeWhatsAppLogFilterForProject, setWhatsAppLogFilter } from "./whatsappLogFilter.js";
import { purgeWhatsAppLastSeenForProject, clearWhatsAppLastSeenId } from "./whatsappUnread.js";

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
  purgePinnedProjectForProject(projectId);
  purgeSeenSharedProjectsForProject(projectId);
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
  purgeRecentHistorySearchesForProject(projectId);
  purgeRecentSearchesForProject(projectId);
  purgeRecentWhatsAppNumbersForProject(projectId);
  purgeWhatsAppLogRecentSearchesForProject(projectId);
  purgeWhatsAppLogFilterForProject(projectId);
  purgeWhatsAppLastSeenForProject(projectId);
}

/**
 * Round 1125: `purgeProjectPreferences` above is only correct when the
 * project itself is actually gone -- then there's no single "current
 * user" to scope a removal to, since any number of OTHER collaborators
 * could have their own entry for it in this same browser's localStorage
 * (each already-per-user store's own `purgeXForProject` doc comment says
 * exactly this). But two of its callers never represented a real deletion
 * at all: `handleAccountDeleted`'s `sharedProjectIds` loop (that account's
 * own grant was revoked; the project itself, and every OTHER collaborator's
 * own access to it, is untouched) and CollaboratorsPanel's self-service
 * "leave project" (identical -- only this one user's own access ends).
 * Routing either through the broad, "assume it's gone" purge silently
 * wipes a DIFFERENT, still-active collaborator's own pinned-project star
 * or "new share" acknowledgment on a browser shared between accounts --
 * exactly the cross-account corruption rounds 1003/995 added per-user
 * keying to prevent in the first place, reached through a path neither of
 * those rounds (nor round 404, which wired up CollaboratorsPanel's onLeft
 * in the first place) ever audited against `purgeProjectPreferences`'s own
 * "project is gone" assumption.
 *
 * Round 1125 scoped this to exactly the two stores whose corruption is
 * directly visible to the OTHER collaborator (a project silently
 * unpinning itself, or a "new share" badge silently reappearing), and
 * explicitly deferred seven more per-user-keyed stores as lower-stakes
 * UX-only leftovers: `entityTabOrder.ts`, `historyRecentSearches.ts`,
 * `recentSearches.ts`, `whatsappRecentNumbers.ts`,
 * `whatsappLogRecentSearches.ts`, `whatsappLogFilter.ts`,
 * `whatsappUnread.ts`. But "lower stakes" was never "correctly handled" --
 * before this round, none of these seven was cleared by anything at all
 * for the departing user: not the broad sweep (no longer called from
 * either of `purgeOwnProjectAccess`'s two real call sites, replaced by
 * this narrower function), and not any per-user equivalent either, since
 * this function only ever called the two above. Every one of these seven
 * leaked forever for that user's own account, the exact same unbounded-
 * growth bug class rounds 390-1124 fixed for every OTHER store that has
 * it, just reopened specifically for the "access revoked, not deleted"
 * event path round 1125 itself created when it stopped routing these two
 * call sites through the broad sweep.
 *
 * Round 1127: added all seven. Six already had an existing single-user,
 * single-project clear primitive, each parameterized by (projectId,
 * userId) exactly like `removePinnedProject`/`removeSeenSharedProject`
 * above, simply never wired into this function --
 * `clearRecentHistorySearches`, `clearRecentSearches`,
 * `clearRecentWhatsAppNumbers`, `clearWhatsAppLogRecentSearches`, and
 * `clearWhatsAppLastSeenId` are called directly; `whatsappLogFilter.ts`
 * has no dedicated `clear*` export, but its own `setWhatsAppLogFilter`
 * already removes the stored key entirely when given "all" (its own
 * implementation's doc comment), so that's used as the equivalent clear.
 * `entityTabOrder.ts` had no single-user removal at all (only the
 * broad, every-collaborator `purgeEntityTabOrderForProject`, since its
 * own single-blob-per-user shape doesn't fit the `${projectId}:${userId}`
 * key-enumeration pattern the other six share) -- `removeEntityTabOrder`
 * was added there this round, mirroring `removePinnedProject`'s own shape
 * (delete just the one project entry from the one user's own store).
 */
export function purgeOwnProjectAccess(userId: string, projectId: string): void {
  removePinnedProject(userId, projectId);
  removeSeenSharedProject(userId, projectId);
  removeEntityTabOrder(userId, projectId);
  clearRecentHistorySearches(projectId, userId);
  clearRecentSearches(projectId, userId);
  clearRecentWhatsAppNumbers(projectId, userId);
  clearWhatsAppLogRecentSearches(projectId, userId);
  setWhatsAppLogFilter(projectId, userId, "all");
  clearWhatsAppLastSeenId(projectId, userId);
}
