const STORAGE_KEY = "forge.pinnedProjects";

function readStoredIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage can be unavailable (private mode) -- the pin just won't survive a reload.
  }
}

export function getPinnedIds(): Set<string> {
  return new Set(readStoredIds());
}

/** Toggles one project's pinned state and returns the new full set, so callers can update their own state from the return value instead of re-reading storage. */
export function togglePinned(projectId: string): Set<string> {
  const ids = readStoredIds();
  const index = ids.indexOf(projectId);
  if (index === -1) ids.push(projectId);
  else ids.splice(index, 1);
  writeStoredIds(ids);
  return new Set(ids);
}

/** Pinned projects first, unpinned after -- each group keeping its own original relative order, so pinning never reshuffles anything beyond moving pinned items to the front. */
export function sortByPinned<T extends { id: string }>(projects: T[], pinnedIds: Set<string>): T[] {
  const pinned = projects.filter((p) => pinnedIds.has(p.id));
  const unpinned = projects.filter((p) => !pinnedIds.has(p.id));
  return [...pinned, ...unpinned];
}
