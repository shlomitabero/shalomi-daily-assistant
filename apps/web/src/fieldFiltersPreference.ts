const STORAGE_KEY = "forge.fieldFilters";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
}

function readStore(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, Record<string, string>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const filters: Record<string, string> = {};
      for (const [field, filterValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof filterValue === "string" && filterValue !== "") filters[field] = filterValue;
      }
      store[key] = filters;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, Record<string, string>>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted per-field enum filters on an entity's records table, scoped
 * per project+entity, mirroring columnWidths.ts's own keying. Previously
 * fieldFilters was reset to {} on every entity/tab switch (see
 * EntityPanel.tsx's combined reset effect, keyed on entity.name) and never
 * persisted at all, so a deliberately-set filter didn't survive clicking to
 * another tab and back -- unlike this entity's sort order, grouping, hidden
 * columns, and column widths, every one of which already survives the same
 * switch. A field absent from the returned record has no active filter.
 */
export function getFieldFilters(projectId: string, entityName: string): Record<string, string> {
  const store = readStore();
  return { ...(store[keyFor(projectId, entityName)] ?? {}) };
}

/** Persists the entity's full updated filter map (dropping any cleared-to-"" entries) and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setFieldFilters(projectId: string, entityName: string, filters: Record<string, string>): Record<string, string> {
  const store = readStore();
  const key = keyFor(projectId, entityName);
  const cleaned: Record<string, string> = {};
  for (const [field, value] of Object.entries(filters)) {
    if (value) cleaned[field] = value;
  }
  if (Object.keys(cleaned).length === 0) delete store[key];
  else store[key] = cleaned;
  writeStore(store);
  return cleaned;
}
