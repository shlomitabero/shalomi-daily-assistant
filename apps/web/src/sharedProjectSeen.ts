const STORAGE_KEY = "forge.seenSharedProjects";

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
 * and notice an unfamiliar project card. This store tracks which shared
 * project ids the signed-in user has already opened at least once, so a
 * share they haven't yet acknowledged can be highlighted differently
 * from one they already have.
 */
export function getSeenSharedProjectIds(): Set<string> {
  return new Set(readStoredIds());
}

/** Marks one shared project as acknowledged. Idempotent -- opening an already-seen project again is a no-op write. */
export function markSharedProjectSeen(projectId: string): Set<string> {
  const ids = readStoredIds();
  if (!ids.includes(projectId)) ids.push(projectId);
  writeStoredIds(ids);
  return new Set(ids);
}

/** Unconditionally removes one project's entry, mirroring pinnedProjects.ts's removePinnedProject. Used when the project itself is deleted (projectPreferenceCleanup.ts). */
export function removeSeenSharedProject(projectId: string): Set<string> {
  const ids = readStoredIds().filter((id) => id !== projectId);
  writeStoredIds(ids);
  return new Set(ids);
}
