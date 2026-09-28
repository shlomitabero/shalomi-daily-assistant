import type { SortKey } from "./entityFormatting.js";

const STORAGE_KEY = "forge.sortKeys";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
}

function isSortKey(value: unknown): value is SortKey {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.field === "string" && (v.direction === "asc" || v.direction === "desc");
}

function isSortKeyArray(value: unknown): value is SortKey[] {
  return Array.isArray(value) && value.every(isSortKey);
}

function readStore(): Record<string, SortKey[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, SortKey[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSortKeyArray(value)) store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, SortKey[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted multi-column sort for one entity's records table (round
 * 250), scoped per project+entity -- mirrors viewModePreference.ts's own
 * keying. Previously sortKeys was reset to [] on every single entity/tab
 * switch (see EntityPanel.tsx's combined reset effect, keyed on
 * entity.name), not just a page reload, so a deliberately-set sort order
 * never survived clicking to another tab and back. Returns [] (no sort)
 * when nothing has ever been chosen for this project+entity.
 */
export function getSortKeys(projectId: string, entityName: string): SortKey[] {
  const store = readStore();
  return store[keyFor(projectId, entityName)] ?? [];
}

/** Persists a sort-key choice and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setSortKeys(projectId: string, entityName: string, keys: SortKey[]): SortKey[] {
  const store = readStore();
  if (keys.length === 0) delete store[keyFor(projectId, entityName)];
  else store[keyFor(projectId, entityName)] = keys;
  writeStore(store);
  return keys;
}
