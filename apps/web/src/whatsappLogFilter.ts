import type { WhatsAppLogFilter } from "./whatsappLog.js";

const STORAGE_KEY_PREFIX = "forge.whatsappLogFilter.";

/**
 * Round 1058: also keyed per-user -- this store sat right next to
 * whatsappRecentNumbers.ts/whatsappLogRecentSearches.ts (the "To" field
 * and the message-log search box, in the same file/component) and was
 * missed when rounds 994/1011 added the userId dimension to those two
 * siblings: a project is routinely shared between real collaborator
 * accounts (project_collaborators/roles), and this filter is a real,
 * visible choice a second collaborator signing into the same project on
 * the same browser would silently inherit -- filtering to "Failed" to
 * debug a delivery problem, then another collaborator logging in and
 * seeing that same filter applied to their own view, with no indication
 * anything unusual happened. See recentSearches.ts's own doc comment for
 * the full reasoning on why a project id alone isn't enough once a
 * project is shared.
 */
function storageKey(projectId: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:${userId}`;
}

function isWhatsAppLogFilter(value: unknown): value is WhatsAppLogFilter {
  return value === "all" || value === "in" || value === "out" || value === "failed";
}

/**
 * The WhatsApp log's own direction/status filter (all/incoming/outgoing/
 * failed) was plain in-memory state with no persistence -- filter down to
 * "Failed" to track failed sends, close the panel to check something else,
 * reopen it, and the filter silently reset back to "All". Same shape as
 * whatsappRecentNumbers.ts, just for the single filter value instead of a
 * list, keyed per-project since two projects' WhatsApp logs are unrelated.
 * Returns "all" when nothing has ever been chosen for this project.
 * Round 1058: also scoped per user -- see storageKey's own doc comment.
 */
export function getWhatsAppLogFilter(projectId: string, userId: string): WhatsAppLogFilter {
  try {
    const raw = localStorage.getItem(storageKey(projectId, userId));
    return isWhatsAppLogFilter(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

/** Persists a filter choice and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setWhatsAppLogFilter(projectId: string, userId: string, filter: WhatsAppLogFilter): WhatsAppLogFilter {
  try {
    if (filter === "all") localStorage.removeItem(storageKey(projectId, userId));
    else localStorage.setItem(storageKey(projectId, userId), filter);
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
  return filter;
}

/**
 * Removes EVERY collaborator account's own filter choice for this
 * project -- see whatsappRecentNumbers.ts's own
 * purgeRecentWhatsAppNumbersForProject for the full reasoning. Used by
 * projectPreferenceCleanup.ts when the project itself is deleted,
 * replacing the old single-user clearWhatsAppLogFilter call that only
 * ever reached the current user's own entry, not any past collaborator's.
 */
export function purgeWhatsAppLogFilterForProject(projectId: string): void {
  const prefix = `${STORAGE_KEY_PREFIX}${projectId}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
