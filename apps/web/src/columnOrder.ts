const STORAGE_KEY = "forge.columnOrder";

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
 * The persisted column order for one entity's table -- scoped per
 * project+entity, mirroring columnVisibility.ts's own keying. Empty when the
 * columns have never been reordered, in which case callers fall back to the
 * entity's own natural field order.
 */
export function getColumnOrder(projectId: string, entityName: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName)] ?? [])];
}

/** Persists a full field-name order and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setColumnOrder(projectId: string, entityName: string, order: string[]): string[] {
  const store = readStore();
  store[keyFor(projectId, entityName)] = order;
  writeStore(store);
  return order;
}

/** Removes every stored column order for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeColumnOrderForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored column order, unlike
 * purgeColumnOrderForProject above (the whole project). Used when a single
 * entity is dropped from an otherwise-surviving project's spec -- see
 * entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge.
 */
export function purgeColumnOrderForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  delete store[keyFor(projectId, entityName)];
  writeStore(store);
}

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename
 * -- see its doc comment for the full "case-only entity rename leaves this
 * store's real data unreachable under the old key" mechanism.
 */
export function migrateColumnOrderForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  const oldKey = keyFor(projectId, oldName);
  const newKey = keyFor(projectId, newName);
  if (store[oldKey] === undefined || store[newKey] !== undefined) return;
  store[newKey] = store[oldKey];
  delete store[oldKey];
  writeStore(store);
}

/**
 * Applies a persisted (possibly stale) column order to the entity's current
 * real field list: a field the order mentions keeps its persisted relative
 * position, and any field the order doesn't mention -- a newly added field,
 * or an order saved before it existed -- is appended at the end in the
 * entity's own original order. Every field the entity actually has appears
 * exactly once; nothing is ever dropped or duplicated.
 *
 * Round 985: an order entry is matched case-insensitively when no exact name
 * matches, same reasoning as pipeline.ts's/migrate.ts's own established
 * prevFieldsByName ?? prevFieldByLowerName convention for a live AI refine
 * that merely normalizes an existing field's letter casing (e.g. "email" ->
 * "Email") -- SQLite itself resolves that as the same column/no real
 * change (see migrate.ts's own doc comments), but the EXACT match here
 * previously couldn't tell that apart from the field being entirely
 * replaced, silently dropping a deliberately drag-reordered column back to
 * its default end-of-list position the instant such a refine completed.
 */
export function applyColumnOrder<T extends { name: string }>(fields: T[], order: string[]): T[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const byLowerName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const ordered: T[] = [];
  const used = new Set<T>();
  for (const name of order) {
    const field = byName.get(name) ?? byLowerName.get(name.toLowerCase());
    if (field && !used.has(field)) {
      ordered.push(field);
      used.add(field);
    }
  }
  for (const field of fields) {
    if (!used.has(field)) ordered.push(field);
  }
  return ordered;
}

/**
 * Computes the new full field-name order after dragging `sourceName`'s
 * column header to just before `targetName`'s -- a real no-op when a column
 * is dropped onto itself, and a no-op (returns `order` unchanged) if either
 * name isn't actually in `order`.
 */
export function reorderColumns(order: string[], sourceName: string, targetName: string): string[] {
  if (sourceName === targetName) return order;
  if (!order.includes(sourceName) || !order.includes(targetName)) return order;
  const withoutSource = order.filter((name) => name !== sourceName);
  const targetIndex = withoutSource.indexOf(targetName);
  const result = [...withoutSource];
  result.splice(targetIndex, 0, sourceName);
  return result;
}
