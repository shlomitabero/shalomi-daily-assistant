const STORAGE_KEY_PREFIX = "forge.historyRecentSearches.";
const MAX_RECENT_SEARCHES = 5;

/**
 * Time Machine's own checkpoint search box had the exact same gap Global
 * Search's query box had before recentSearches.ts (round 180): reopening
 * History to find "before the pricing overhaul" again meant retyping the
 * exact same search from scratch every time. Same shape as
 * recentSearches.ts, just its own separate storage key -- checkpoint
 * labels/messages and entity-record search terms are unrelated vocabularies,
 * so sharing one list between Global Search and History would mix two
 * kinds of "recent" that have nothing to do with each other. Keyed per
 * project and per user -- see recentSearches.ts's own doc comment (round
 * 994) for why the user id is part of the key too, not just the project.
 */
function storageKey(projectId: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:${userId}`;
}

export function getRecentHistorySearches(projectId: string, userId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Adds a query to the front of this project's recent-search list -- moving
 * it there (case-insensitively) if it's already present, rather than
 * keeping a duplicate entry -- and caps the list at MAX_RECENT_SEARCHES,
 * mirroring recentSearches.ts's own addRecentSearch exactly.
 */
export function addRecentHistorySearch(projectId: string, userId: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentHistorySearches(projectId, userId);
  const existing = getRecentHistorySearches(projectId, userId);
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeRecentHistorySearch(projectId: string, userId: string, query: string): string[] {
  const next = getRecentHistorySearches(projectId, userId).filter((q) => q.toLowerCase() !== query.toLowerCase());
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearRecentHistorySearches(projectId: string, userId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId, userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Removes EVERY collaborator account's own recent-search list for this
 * project -- see recentSearches.ts's own purgeRecentSearchesForProject
 * for the full reasoning. Used by projectPreferenceCleanup.ts when the
 * project itself is deleted.
 */
export function purgeRecentHistorySearchesForProject(projectId: string): void {
  const prefix = `${STORAGE_KEY_PREFIX}${projectId}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
