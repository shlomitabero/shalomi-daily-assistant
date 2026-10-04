const STORAGE_KEY = "forge.entityTabOrder";

function readStore(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) store[key] = value.filter((v): v is string => typeof v === "string");
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted entity-tab order for one project's live-preview nav --
 * scoped per project only, unlike columnOrder.ts's own per-project+entity
 * keying, since this is the order of the tabs themselves rather than one
 * entity's own table columns. Empty when the tabs have never been
 * reordered, in which case callers fall back to the project's own natural
 * entity order (the same "empty order = natural order" convention
 * columnOrder.ts already established).
 *
 * The actual reorder math is deliberately not reimplemented here:
 * `applyColumnOrder`/`reorderColumns` (columnOrder.ts) are already generic
 * over any `{ name: string }[]`, and `Entity` has a `name` field just like
 * a table's fields do, so this file only owns the storage half.
 */
export function getEntityTabOrder(projectId: string): string[] {
  const store = readStore();
  return [...(store[projectId] ?? [])];
}

/** Persists a full entity-name order and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setEntityTabOrder(projectId: string, order: string[]): string[] {
  const store = readStore();
  store[projectId] = order;
  writeStore(store);
  return order;
}

/** Unconditionally removes one project's entry. Used when the project itself is deleted (projectPreferenceCleanup.ts), mirroring removePinnedProject's shape (pinnedProjects.ts) since this store is also keyed directly by projectId, not `${projectId}:${entityName}`. */
export function purgeEntityTabOrderForProject(projectId: string): void {
  const store = readStore();
  delete store[projectId];
  writeStore(store);
}
