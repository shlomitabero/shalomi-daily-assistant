const STORAGE_KEY_PREFIX = "forge.projectStatusFilter.";

export type ProjectStatusFilter = "all" | "built" | "draft";

/**
 * The home screen's "Your projects" status filter (round 217 -- Built/Draft/
 * all) was a plain useState that reset to "all" on every reload, unlike its
 * own sibling preference on the same screen, sort mode (round 182,
 * projectSortMode.ts), which already survives a reload. Persisted the same
 * way, so someone who filters down to just their drafts (to keep working on
 * unfinished projects) doesn't have to re-pick that filter every time they
 * come back to the home screen.
 *
 * Round 1057: the exact same fix projectSortMode.ts just got, for the exact
 * same reason -- see its own doc comment. This one is the more severe of
 * the pair: on a shared/public computer, if account A leaves this filter on
 * "built" and logs out without a reload, account B logging into the same
 * tab could see their own "Your projects" list render completely empty --
 * every one of B's own projects still a "draft" -- with nothing in the UI
 * hinting a stale filter, not B's own missing projects, is the reason.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function getProjectStatusFilter(userId: string): ProjectStatusFilter {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw === "built" || raw === "draft" ? raw : "all";
  } catch {
    return "all";
  }
}

export function setProjectStatusFilter(userId: string, filter: ProjectStatusFilter): void {
  try {
    localStorage.setItem(storageKey(userId), filter);
  } catch {
    // localStorage can be unavailable (private mode) -- the preference just won't survive a reload.
  }
}

/**
 * Round 1124: see projectSortMode.ts's own clearProjectSortMode doc
 * comment for the full reasoning -- the exact same fix, for the exact
 * same reason, called only from handleAccountDeleted.
 */
export function clearProjectStatusFilter(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
