const STORAGE_KEY_PREFIX = "forge.recentProjectSearches.";
const MAX_RECENT_SEARCHES = 5;

/**
 * The home screen's own "Your projects" search box had the exact same gap
 * Global Search's query box had before recentSearches.ts (round 180), the
 * Time Machine checkpoint search had before historyRecentSearches.ts, and
 * the WhatsApp test-number field had before whatsappRecentNumbers.ts: a
 * person re-searching a recurring term (a client name, a recurring project
 * prefix) had to retype it from scratch every time they came back to the
 * home screen. Unlike those three siblings, this one is NOT keyed per
 * project -- it IS the project list itself, the same single flat-per-user
 * scope projectSortMode.ts/projectStatusFilter.ts already use for their own
 * home-screen preferences, since there's no enclosing project to scope by.
 *
 * Round 1045: this store used ONE SINGLE FLAT KEY SHARED BY EVERY ACCOUNT on
 * the same browser, the exact same gap round 1044 just fixed in ideaDraft.ts
 * (this file's own explicitly-named "direct sibling" in App.tsx's own round-
 * 993 comment). App.tsx cleared it at logout/account-deletion/session-expiry
 * at the time, but that only protected a continuously-running tab where one
 * user explicitly transitions out before another logs in -- closing the tab
 * without logging out (an ordinary, arguably more common way to leave a
 * shared/public computer) runs none of that cleanup, so the next account to
 * open a fresh tab on that machine inherited the previous account's own
 * typed search terms in their own Recent Searches dropdown. Keyed per user
 * now, the same round-1003/994/995/1044 fix already applied to
 * pinnedProjects.ts/sharedProjectSeen.ts/ideaDraft.ts/the four
 * *RecentSearches.ts stores.
 *
 * Round 1129: see ideaDraft.ts's own identical round-1129 note -- once
 * per-user keying made the clear-on-logout/session-expiry calls redundant
 * for protecting a different account, they became actively harmful for
 * the SAME account instead, wiping its own recent searches on every
 * ordinary logout or session timeout. App.tsx's handleLogout/
 * subscribeAuthExpired no longer call `clearRecentProjectSearches`; only
 * `handleAccountDeleted` still does.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function getRecentProjectSearches(userId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
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
export function addRecentProjectSearch(userId: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentProjectSearches(userId);
  const existing = getRecentProjectSearches(userId);
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeRecentProjectSearch(userId: string, query: string): string[] {
  const next = getRecentProjectSearches(userId).filter((q) => q.toLowerCase() !== query.toLowerCase());
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearRecentProjectSearches(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
