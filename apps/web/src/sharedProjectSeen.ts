const STORAGE_KEY_PREFIX = "forge.seenSharedProjects.";

/**
 * Round 995: this store moved from one single flat key to one key per
 * signed-in user -- see getSeenSharedTimestamps's own doc comment for why.
 * A project created before this round has no per-user entry yet (the old
 * flat key is simply abandoned, same additive-only convention every other
 * localStorage migration in this app already uses): every user's very
 * next share they haven't personally acknowledged under the NEW key shows
 * its "New share" chip once more, the same one-time, harmless re-show
 * readStoredMap's own comment already accepts for the round-401 shape
 * change.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function readStoredMap(userId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, sharedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sharedAt === "string") out[id] = sharedAt;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredMap(userId: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(map));
  } catch {
    // localStorage can be unavailable (private mode) -- the "new share" badge just won't stay dismissed across reloads.
  }
}

/**
 * The home screen's permanent "Shared" chip (round ~190s) never
 * distinguished a project someone was just given access to from one
 * they've had access to for months -- a collaborator invite (round
 * 381's own `POST /projects/:id/collaborators`) has no email, no
 * desktop notification, and no "new" marker of any kind, so the only way
 * to ever discover a new share is to happen to reopen the home screen
 * and notice an unfamiliar project card. This store tracks, per shared
 * project id, the `sharedAt` of the most recent share grant the signed-in
 * user has acknowledged by opening that project (see Project["sharedAt"],
 * populated from project_collaborators.addedAt by listProjectsForUser) --
 * not just whether the id was ever seen. A collaborator who was removed
 * and later re-invited to the same project gets a fresh addedAt server-side
 * (round 405), so comparing timestamps rather than a flat id set means that
 * second invite shows as new again instead of staying silently suppressed
 * by the first one's now-stale acknowledgment.
 *
 * Round 995: "the signed-in user" above was never actually true before
 * this round -- the storage key carried no user dimension at all, just
 * `projectId`, despite a project being routinely shared between SEVERAL
 * real collaborator accounts (project_collaborators/roles). Two different
 * collaborators invited to the same project on the same browser shared
 * this one acknowledgment per project: whichever one opened the project
 * first silently suppressed the "New share" chip for every other
 * collaborator who later logs into that same browser and had never
 * personally opened it -- defeating this feature's entire stated purpose.
 * `userId` is now part of the key for exactly the reason recentSearches.ts/
 * historyRecentSearches.ts/entityRecentSearches.ts/whatsappLogRecentSearches.ts
 * already needed it (round 994): this store was already project-scoped,
 * so there's no single account-wide key a round-993-style App.tsx reset
 * could ever have cleared -- the fix has to be in the key itself.
 */
export function getSeenSharedTimestamps(userId: string): Map<string, string> {
  return new Map(Object.entries(readStoredMap(userId)));
}

/** Records `sharedAt` as the most recently acknowledged share grant for one project, for this one user. Idempotent -- re-acknowledging the same `sharedAt` is a no-op write. */
export function markSharedProjectSeen(userId: string, projectId: string, sharedAt: string): Map<string, string> {
  const map = readStoredMap(userId);
  map[projectId] = sharedAt;
  writeStoredMap(userId, map);
  return new Map(Object.entries(map));
}

/** Unconditionally removes one project's entry for this one user, mirroring pinnedProjects.ts's removePinnedProject. Used when the project itself is deleted (projectPreferenceCleanup.ts). */
export function removeSeenSharedProject(userId: string, projectId: string): Map<string, string> {
  const map = readStoredMap(userId);
  delete map[projectId];
  writeStoredMap(userId, map);
  return new Map(Object.entries(map));
}

/**
 * Removes EVERY collaborator account's own acknowledgment for this one
 * project -- used by projectPreferenceCleanup.ts when the project itself
 * is deleted, where (like round 994's own identical purge functions)
 * there's no single "current user" to scope a plain removeSeenSharedProject
 * call to: any number of other collaborators could have their own
 * acknowledgment for this now-gone project sitting in this same browser's
 * localStorage, each under their own per-user key.
 */
export function purgeSeenSharedProjectsForProject(projectId: string): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
      const userId = key.slice(STORAGE_KEY_PREFIX.length);
      const map = readStoredMap(userId);
      if (!(projectId in map)) continue;
      delete map[projectId];
      writeStoredMap(userId, map);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * True when `sharedAt` (a shared project's current share grant, absent for
 * an owned project) is defined and doesn't match what's already been
 * acknowledged for that id in `seen` -- i.e. the "New share" chip should
 * show. A project the signed-in user owns always passes `undefined` here
 * from the caller, so it's never "new".
 */
export function isNewShare(seen: Map<string, string>, projectId: string, sharedAt: string | undefined): boolean {
  return sharedAt !== undefined && seen.get(projectId) !== sharedAt;
}
