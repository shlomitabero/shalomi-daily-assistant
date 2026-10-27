import type { SortKey } from "./entityFormatting.js";

const STORAGE_KEY = "forge.sortKeys";

/**
 * Round 1074: the userId segment was added so two different collaborator
 * accounts sharing the same project+entity on the same browser no longer
 * see each other's own multi-column sort order -- the same cross-account
 * leak class already closed for every other sibling store on this exact
 * screen (columnOrder.ts round 1069, columnWidths.ts round 1068,
 * columnVisibility.ts round 1055, fieldFiltersPreference.ts round 1054),
 * never ported here. See fieldFiltersPreference.ts's own keyFor doc
 * comment for the full reasoning. purgeSortKeysForProject/
 * purgeSortKeysForEntity below still match by prefix, which keeps working
 * unchanged regardless of what the key's own remaining segments
 * (entityName, userId) look like.
 */
function keyFor(projectId: string, entityName: string, userId: string): string {
  return `${projectId}:${entityName}:${userId}`;
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
 * when nothing has ever been chosen for this project+entity. Round 1074:
 * also scoped per user -- see keyFor's own doc comment above.
 */
export function getSortKeys(projectId: string, entityName: string, userId: string): SortKey[] {
  const store = readStore();
  return store[keyFor(projectId, entityName, userId)] ?? [];
}

/** Persists a sort-key choice and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setSortKeys(projectId: string, entityName: string, userId: string, keys: SortKey[]): SortKey[] {
  const store = readStore();
  if (keys.length === 0) delete store[keyFor(projectId, entityName, userId)];
  else store[keyFor(projectId, entityName, userId)] = keys;
  writeStore(store);
  return keys;
}

/** Removes every stored sort-key choice for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeSortKeysForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored sort-key choice, across every
 * collaborator account (the key's third segment is userId, not something
 * this function can know in advance -- the same reason columnOrder.ts's
 * own purgeColumnOrderForEntity sweeps by prefix rather than a single
 * exact key), unlike purgeSortKeysForProject above (the whole project).
 * Used when a single entity is dropped from an otherwise-surviving
 * project's spec -- see entityPreferenceCleanup.ts for why this exists
 * alongside the project-wide purge.
 */
export function purgeSortKeysForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  const prefix = `${projectId}:${entityName}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename
 * -- see its doc comment for the full "case-only entity rename leaves this
 * store's real data unreachable under the old key" mechanism. Round 1074:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * columnOrder.ts's own migrateColumnOrderForEntityRename does, since the
 * key's own userId segment isn't known in advance.
 */
export function migrateSortKeysForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  const oldPrefix = `${projectId}:${oldName}:`;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (!key.startsWith(oldPrefix)) continue;
    const userId = key.slice(oldPrefix.length);
    const newKey = keyFor(projectId, newName, userId);
    if (store[newKey] === undefined) store[newKey] = store[key];
    delete store[key];
    changed = true;
  }
  if (changed) writeStore(store);
}
