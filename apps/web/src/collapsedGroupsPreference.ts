const STORAGE_KEY = "forge.collapsedGroups";

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
 * Which group keys a person has collapsed in the grouped table view,
 * scoped per project+entity, mirroring fieldFiltersPreference.ts's own
 * keying. Previously there was no way to collapse a group at all -- a
 * grouped table with a large group (e.g. 50 "Done" records) always
 * rendered every one of its rows, defeating the point of grouping a
 * sizeable table to begin with.
 */
export function getCollapsedGroups(projectId: string, entityName: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName)] ?? [])];
}

/** Persists the entity's full updated set of collapsed group keys and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setCollapsedGroups(projectId: string, entityName: string, keys: string[]): string[] {
  const store = readStore();
  const mapKey = keyFor(projectId, entityName);
  const deduped = [...new Set(keys)];
  if (deduped.length === 0) delete store[mapKey];
  else store[mapKey] = deduped;
  writeStore(store);
  return deduped;
}

/** Removes every stored collapsed-group set for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeCollapsedGroupsForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}
