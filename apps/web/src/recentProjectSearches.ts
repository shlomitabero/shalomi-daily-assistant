const STORAGE_KEY = "forge.recentProjectSearches";
const MAX_RECENT_SEARCHES = 5;

/**
 * The home screen's own "Your projects" search box had the exact same gap
 * Global Search's query box had before recentSearches.ts (round 180), the
 * Time Machine checkpoint search had before historyRecentSearches.ts, and
 * the WhatsApp test-number field had before whatsappRecentNumbers.ts: a
 * person re-searching a recurring term (a client name, a recurring project
 * prefix) had to retype it from scratch every time they came back to the
 * home screen. Unlike those three siblings, this one is NOT keyed per
 * project -- it IS the project list itself, the same single flat scope
 * projectSortMode.ts/projectStatusFilter.ts already use for their own
 * home-screen preferences, since there's no enclosing project to scope by.
 */
export function getRecentProjectSearches(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Adds a query to the front of the recent-search list -- moving it there
 * (case-insensitively) if it's already present, rather than keeping a
 * duplicate entry -- and caps the list at MAX_RECENT_SEARCHES, mirroring
 * addRecentSearch's own convention exactly.
 */
export function addRecentProjectSearch(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentProjectSearches();
  const existing = getRecentProjectSearches();
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeRecentProjectSearch(query: string): string[] {
  const next = getRecentProjectSearches().filter((q) => q.toLowerCase() !== query.toLowerCase());
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearRecentProjectSearches(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
