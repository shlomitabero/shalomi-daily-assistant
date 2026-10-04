const STORAGE_KEY = "forge.groupByField";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
}

function readStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted "Group by" field for one entity's table (round 219) --
 * scoped per project+entity, mirroring columnOrder.ts's own keying. Unlike
 * hidden/reordered/resized columns, the group-by choice was never persisted
 * at all: reloading the page, or just switching away to another entity and
 * back, silently reset it to "no grouping" even though the whole point of
 * grouping a table is to leave it that way while you keep working. Returns
 * "" (matching the "no grouping" option's own empty value) when nothing has
 * ever been chosen for this project+entity.
 */
export function getGroupByField(projectId: string, entityName: string): string {
  const store = readStore();
  return store[keyFor(projectId, entityName)] ?? "";
}

/** Persists a group-by field choice (or "" to clear it) and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setGroupByField(projectId: string, entityName: string, fieldName: string): string {
  const store = readStore();
  if (fieldName) store[keyFor(projectId, entityName)] = fieldName;
  else delete store[keyFor(projectId, entityName)];
  writeStore(store);
  return fieldName;
}
