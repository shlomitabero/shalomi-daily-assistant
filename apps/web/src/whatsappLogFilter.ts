import type { WhatsAppLogFilter } from "./whatsappLog.js";

const STORAGE_KEY_PREFIX = "forge.whatsappLogFilter.";

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
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
 */
export function getWhatsAppLogFilter(projectId: string): WhatsAppLogFilter {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    return isWhatsAppLogFilter(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

/** Persists a filter choice and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setWhatsAppLogFilter(projectId: string, filter: WhatsAppLogFilter): WhatsAppLogFilter {
  try {
    if (filter === "all") localStorage.removeItem(storageKey(projectId));
    else localStorage.setItem(storageKey(projectId), filter);
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
  return filter;
}

/** Same purge-on-project-delete pattern as whatsappRecentNumbers.ts's clearRecentWhatsAppNumbers -- see projectPreferenceCleanup.ts for why this exists. */
export function clearWhatsAppLogFilter(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
