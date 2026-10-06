const STORAGE_KEY = "forge.projectStatusFilter";

export type ProjectStatusFilter = "all" | "built" | "draft";

/**
 * The home screen's "Your projects" status filter (round 217 -- Built/Draft/
 * all) was a plain useState that reset to "all" on every reload, unlike its
 * own sibling preference on the same screen, sort mode (round 182,
 * projectSortMode.ts), which already survives a reload. Persisted the same
 * way, so someone who filters down to just their drafts (to keep working on
 * unfinished projects) doesn't have to re-pick that filter every time they
 * come back to the home screen.
 */
export function getProjectStatusFilter(): ProjectStatusFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "built" || raw === "draft" ? raw : "all";
  } catch {
    return "all";
  }
}

export function setProjectStatusFilter(filter: ProjectStatusFilter): void {
  try {
    localStorage.setItem(STORAGE_KEY, filter);
  } catch {
    // localStorage can be unavailable (private mode) -- the preference just won't survive a reload.
  }
}
