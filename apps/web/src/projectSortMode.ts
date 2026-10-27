const STORAGE_KEY_PREFIX = "forge.projectSortMode.";

export type ProjectSortMode = "recent" | "alphabetical";

/**
 * The home screen's "Your projects" list only ever had one real order
 * (newest-first, per listProjectsForUser's own `ORDER BY createdAt DESC`)
 * with no way to switch to alphabetical -- fine for a handful of
 * projects, but tedious to scan once someone has built a dozen of them
 * and is looking for one specific project by name rather than by when
 * they made it. Persisted the same way pinnedProjects.ts/ideaDraft.ts/
 * recentSearches.ts already persist their own per-viewer preferences, so
 * the choice survives a reload instead of silently reverting every time.
 *
 * Round 1057: despite recentProjectSearches.ts's own doc comment claiming
 * this store already used "the same single flat-per-user scope" its
 * sibling preferences use, it genuinely used one flat key shared by every
 * account on the browser -- the same gap round 1044/1045 fixed for
 * ideaDraft.ts/recentProjectSearches.ts (this store's own direct siblings
 * on the exact same home screen), just never applied here. Keyed per user
 * now, same pattern.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function getProjectSortMode(userId: string): ProjectSortMode {
  try {
    return localStorage.getItem(storageKey(userId)) === "alphabetical" ? "alphabetical" : "recent";
  } catch {
    return "recent";
  }
}

export function setProjectSortMode(userId: string, mode: ProjectSortMode): void {
  try {
    localStorage.setItem(storageKey(userId), mode);
  } catch {
    // localStorage can be unavailable (private mode) -- the preference just won't survive a reload.
  }
}

/**
 * Round 1124: handleLogout/subscribeAuthExpired deliberately never clear
 * this store -- round 1057's whole point in keying it per user was so the
 * preference survives a logout and a later re-login to the SAME account.
 * But DELETE /auth/account permanently destroys the user row (no future
 * login can ever reuse that UUID), so for THAT one path specifically,
 * "survive the next login" can never happen -- leaving this key behind
 * forever is pure leak, not the feature it is everywhere else. Mirrors
 * ideaDraft.ts's own clearIdeaDraft, called only from handleAccountDeleted.
 */
export function clearProjectSortMode(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
