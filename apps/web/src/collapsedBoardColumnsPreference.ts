const STORAGE_KEY = "forge.collapsedBoardColumns";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
}

function readStore(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      store[key] = value.filter((v): v is string => typeof v === "string");
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
 * Which board-view column values a person has collapsed, scoped per
 * project+entity, mirroring collapsedGroupsPreference.ts's own keying --
 * deliberately a SEPARATE store rather than reusing that one: the
 * grouped-table view's own collapsed keys are keyed only by
 * project+entity too, not by which field is being grouped, so sharing
 * storage with the board (whose column values come from a different
 * field, boardField) would make collapsing "Won" in one view silently
 * collapse any same-named group/column in the other. Previously there
 * was no way to collapse a board column at all -- a huge "Done" column
 * always rendered every one of its cards.
 */
export function getCollapsedBoardColumns(projectId: string, entityName: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName)] ?? [])];
}

/** Persists the entity's full updated set of collapsed board-column values and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setCollapsedBoardColumns(projectId: string, entityName: string, values: string[]): string[] {
  const store = readStore();
  const mapKey = keyFor(projectId, entityName);
  const deduped = [...new Set(values)];
  if (deduped.length === 0) delete store[mapKey];
  else store[mapKey] = deduped;
  writeStore(store);
  return deduped;
}
