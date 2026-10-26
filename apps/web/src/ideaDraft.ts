const STORAGE_KEY_PREFIX = "forge.ideaDraft.";

/**
 * The home screen's own idea textarea was the one piece of "what you're
 * currently working on" state in this app that DIDN'T survive a reload --
 * pinned projects, column visibility, language, and the auth token all do
 * (see pinnedProjects.ts/columnVisibility.ts/api.ts's own localStorage
 * usage). A half-typed, thoughtfully-written business description is
 * exactly the kind of thing a person hates losing to an accidental reload
 * or a closed tab.
 *
 * Round 1044: this store used one single flat key with no user dimension
 * at all, mirroring pinnedProjects.ts's own pre-round-1003 shape -- but a
 * half-typed BUSINESS DESCRIPTION is far more sensitive than a pinned
 * project id. Clearing it at logout/account-deletion/session-expiry
 * (App.tsx) only protects a continuously-running tab where one user
 * explicitly transitions out before another logs in; it does nothing when
 * a user simply closes the tab (no JS ever runs) and a different user
 * opens a fresh tab on the same shared/public machine and logs into their
 * own account -- that fresh page load's own `useState` initializer would
 * read the first user's still-present draft text straight into the second
 * user's own textarea. Keyed per user now, the same round-1003/994/995
 * fix already applied to pinnedProjects.ts/sharedProjectSeen.ts/the four
 * *RecentSearches.ts stores, so a different account can never see it no
 * matter how the first session actually ended.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function getIdeaDraft(userId: string): string {
  try {
    return localStorage.getItem(storageKey(userId)) ?? "";
  } catch {
    return "";
  }
}

export function saveIdeaDraft(userId: string, text: string): void {
  try {
    if (text.trim() === "") localStorage.removeItem(storageKey(userId));
    else localStorage.setItem(storageKey(userId), text);
  } catch {
    // localStorage can be unavailable (private mode) -- the draft just won't survive a reload.
  }
}

export function clearIdeaDraft(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
