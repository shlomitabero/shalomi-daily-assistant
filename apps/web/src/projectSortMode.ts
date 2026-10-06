const STORAGE_KEY = "forge.projectSortMode";

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
 */
export function getProjectSortMode(): ProjectSortMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "alphabetical" ? "alphabetical" : "recent";
  } catch {
    return "recent";
  }
}

export function setProjectSortMode(mode: ProjectSortMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable (private mode) -- the preference just won't survive a reload.
  }
}
