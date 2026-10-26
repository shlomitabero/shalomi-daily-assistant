const STORAGE_KEY_PREFIX = "forge.pinnedProjects.";

/**
 * Round 1003: this store moved from one single flat key to one key per
 * signed-in user, mirroring sharedProjectSeen.ts's own identical round-995
 * fix -- see getPinnedIds's own doc comment for why. A project pinned
 * before this round has no per-user entry yet (the old flat key is simply
 * abandoned, same additive-only convention every other localStorage
 * migration in this app already uses): every user's own pins before this
 * round are silently lost once, the same one-time, harmless reset
 * round 995's own migration already accepted for its own shape change.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function readStoredIds(userId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredIds(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(ids));
  } catch {
    // localStorage can be unavailable (private mode) -- the pin just won't survive a reload.
  }
}

/**
 * Round 1003: the storage key carried no user dimension at all before
 * this round, despite a project being routinely shared between several
 * real collaborator accounts (project_collaborators/roles) -- exactly the
 * same gap round 995 found and fixed for sharedProjectSeen.ts, and round
 * 994 found for four separate recent-search stores. Two different
 * collaborators sharing a project on the same browser shared this one
 * array: whichever one pinned it first made it appear pinned for every
 * other collaborator who later signs into that same browser, and since
 * togglePinned flips the shared state rather than setting it, a second
 * collaborator clicking the star to "pin it for themselves" actually
 * UNPINNED the first collaborator's own real, intentionally-chosen
 * preference -- silently destroying a different account's own choice with
 * no warning to either side.
 */
export function getPinnedIds(userId: string): Set<string> {
  return new Set(readStoredIds(userId));
}

/** Toggles one project's pinned state for this one user and returns the new full set, so callers can update their own state from the return value instead of re-reading storage. */
export function togglePinned(userId: string, projectId: string): Set<string> {
  const ids = readStoredIds(userId);
  const index = ids.indexOf(projectId);
  if (index === -1) ids.push(projectId);
  else ids.splice(index, 1);
  writeStoredIds(userId, ids);
  return new Set(ids);
}

/**
 * Unconditionally removes one project from this one user's own pinned set
 * -- unlike togglePinned above, which flips whichever state it's currently
 * in.
 */
export function removePinnedProject(userId: string, projectId: string): Set<string> {
  const ids = readStoredIds(userId).filter((id) => id !== projectId);
  writeStoredIds(userId, ids);
  return new Set(ids);
}

/**
 * Removes EVERY collaborator account's own pin for this one project --
 * used by projectPreferenceCleanup.ts when the project itself is deleted,
 * where (like sharedProjectSeen.ts's own identical purgeSeenSharedProjectsForProject)
 * there's no single "current user" to scope a plain removePinnedProject
 * call to: any number of other collaborators could have pinned this now-
 * gone project in this same browser's localStorage, each under their own
 * per-user key.
 */
export function purgePinnedProjectForProject(projectId: string): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
      const userId = key.slice(STORAGE_KEY_PREFIX.length);
      const ids = readStoredIds(userId);
      if (!ids.includes(projectId)) continue;
      writeStoredIds(
        userId,
        ids.filter((id) => id !== projectId),
      );
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/** Pinned projects first, unpinned after -- each group keeping its own original relative order, so pinning never reshuffles anything beyond moving pinned items to the front. */
export function sortByPinned<T extends { id: string }>(projects: T[], pinnedIds: Set<string>): T[] {
  const pinned = projects.filter((p) => pinnedIds.has(p.id));
  const unpinned = projects.filter((p) => !pinnedIds.has(p.id));
  return [...pinned, ...unpinned];
}
