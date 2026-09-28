const STORAGE_KEY = "forge.viewMode";

export type PersistedViewMode = "table" | "board" | "calendar";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
}

function isPersistedViewMode(value: unknown): value is PersistedViewMode {
  return value === "table" || value === "board" || value === "calendar";
}

function readStore(): Record<string, PersistedViewMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, PersistedViewMode> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPersistedViewMode(value)) store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, PersistedViewMode>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted Table/Board/Calendar view choice for one entity's records
 * screen (round 243) -- scoped per project+entity, mirroring
 * groupByPreference.ts's own keying. Previously viewMode was hard-reset to
 * "table" on every entity switch and never persisted, so a Kanban board or
 * calendar view someone deliberately set up for an entity had to be
 * re-selected by hand every single time they switched tabs and came back.
 * Returns "table" (matching the default view) when nothing has ever been
 * chosen for this project+entity.
 */
export function getViewMode(projectId: string, entityName: string): PersistedViewMode {
  const store = readStore();
  return store[keyFor(projectId, entityName)] ?? "table";
}

/** Persists a view-mode choice and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setViewMode(projectId: string, entityName: string, mode: PersistedViewMode): PersistedViewMode {
  const store = readStore();
  if (mode === "table") delete store[keyFor(projectId, entityName)];
  else store[keyFor(projectId, entityName)] = mode;
  writeStore(store);
  return mode;
}
