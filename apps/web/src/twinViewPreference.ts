const STORAGE_KEY_PREFIX = "forge.twinView.";

export type TwinView = "dashboard" | "report";

function isTwinView(value: unknown): value is TwinView {
  return value === "dashboard" || value === "report";
}

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function readStoredMap(userId: string): Record<string, TwinView> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, TwinView> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isTwinView(value)) out[projectId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredMap(userId: string, map: Record<string, TwinView>): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(map));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * Round 1596: BusinessTwinPanel's own Dashboard/Report `view-toggle` (the
 * only one of this app's three `view-toggle` groups -- EntityPanel.tsx's
 * table/board/calendar and App.tsx's project-list recent/alphabetical are
 * the other two, both persisted since round 243/1057 respectively -- that
 * never persisted anything) reset to its hardcoded "report" default every
 * time the panel remounted, even for someone who always switches straight
 * to Dashboard. Mirrors sharedProjectSeen.ts's own shape exactly (one
 * key per signed-in user, holding a projectId-keyed map inside it) rather
 * than viewModePreference.ts's three-segment JSON-array key, since this
 * preference has no third (entityName) dimension to disambiguate --
 * BusinessTwinPanel is a whole-project dialog, not a per-entity one.
 * Falls back to the panel's existing "report" default on any failure or
 * missing entry, exactly like getViewMode's own "table" fallback.
 */
export function getTwinView(userId: string, projectId: string): TwinView {
  return readStoredMap(userId)[projectId] ?? "report";
}

/** Persists a Dashboard/Report choice for this one user+project. */
export function setTwinView(userId: string, projectId: string, view: TwinView): void {
  const map = readStoredMap(userId);
  map[projectId] = view;
  writeStoredMap(userId, map);
}

/**
 * Unconditionally removes one project's entry for this one user --
 * mirrors removeSeenSharedProject/removePinnedProject's identical shape.
 * Wired into projectPreferenceCleanup.ts's purgeOwnProjectAccess for the
 * "access revoked, not project deleted" event path (rounds 1125-1145's own
 * established convention for every per-user-keyed store in this family).
 */
export function removeTwinView(userId: string, projectId: string): void {
  const map = readStoredMap(userId);
  if (!(projectId in map)) return;
  delete map[projectId];
  writeStoredMap(userId, map);
}

/**
 * Removes EVERY collaborator account's own choice for this one project --
 * used by projectPreferenceCleanup.ts when the project itself is deleted,
 * where (like sharedProjectSeen.ts's own identical purgeSeenSharedProjectsForProject)
 * there's no single "current user" to scope a plain removeTwinView call to:
 * any number of other collaborators could have their own choice for this
 * now-gone project sitting in this same browser's localStorage, each under
 * their own per-user key.
 */
export function purgeTwinViewForProject(projectId: string): void {
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
