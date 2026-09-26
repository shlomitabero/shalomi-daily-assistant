const STORAGE_KEY_PREFIX = "forge.recentSearches.";
const MAX_RECENT_SEARCHES = 5;

/**
 * Global Search's own query was the one piece of "what you were just
 * looking for" state in this app that vanished the instant the panel
 * closed -- pinned projects, column visibility, and the home screen's
 * idea draft all survive a reload/reopen (see pinnedProjects.ts/
 * columnVisibility.ts/ideaDraft.ts's own localStorage usage), but reopening
 * this same panel a minute later meant retyping the exact same thing from
 * scratch. Keyed per-project (not globally) since two different projects'
 * entities/data have nothing to do with each other -- a recent search on
 * one project's Customer table is meaningless noise on another project
 * that has no such entity at all.
 */
function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

export function getRecentSearches(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
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
 * keeping a duplicate entry -- and caps the list at MAX_RECENT_SEARCHES so
 * it stays a short, genuinely "recent" list rather than growing forever.
 * Returns the new list so callers can update their own state from the
 * return value instead of re-reading storage, the same convention
 * pinnedProjects.ts's togglePinned uses.
 */
export function addRecentSearch(projectId: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentSearches(projectId);
  const existing = getRecentSearches(projectId);
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function clearRecentSearches(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
