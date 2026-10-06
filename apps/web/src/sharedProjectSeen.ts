const STORAGE_KEY = "forge.seenSharedProjects";

function readStoredMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Round 401 stored this key as a plain array of ids (no way to tell one
    // share from the next). Treating that old shape as "nothing seen yet"
    // means every already-opened share re-shows its "New share" chip once,
    // the one time a browser upgrades past this round -- an acceptable
    // one-time reset, not a crash or data-loss risk.
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

function writeStoredMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
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
 */
export function getSeenSharedTimestamps(): Map<string, string> {
  return new Map(Object.entries(readStoredMap()));
}

/** Records `sharedAt` as the most recently acknowledged share grant for one project. Idempotent -- re-acknowledging the same `sharedAt` is a no-op write. */
export function markSharedProjectSeen(projectId: string, sharedAt: string): Map<string, string> {
  const map = readStoredMap();
  map[projectId] = sharedAt;
  writeStoredMap(map);
  return new Map(Object.entries(map));
}

/** Unconditionally removes one project's entry, mirroring pinnedProjects.ts's removePinnedProject. Used when the project itself is deleted (projectPreferenceCleanup.ts). */
export function removeSeenSharedProject(projectId: string): Map<string, string> {
  const map = readStoredMap();
  delete map[projectId];
  writeStoredMap(map);
  return new Map(Object.entries(map));
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
