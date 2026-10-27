const STORAGE_KEY = "forge.columnOrder";

/**
 * Round 1069: the userId segment was added so two different collaborator
 * accounts sharing the same project+entity on the same browser no longer
 * see each other's own drag-reordered column order -- the same
 * cross-account leak class already closed for every other sibling store
 * on this exact screen (columnWidths.ts round 1068, columnVisibility.ts
 * round 1055, fieldFiltersPreference.ts round 1054), never ported here.
 * See fieldFiltersPreference.ts's own keyFor doc comment for the full
 * reasoning. purgeColumnOrderForProject/purgeColumnOrderForEntity below
 * still match by prefix, which keeps working unchanged regardless of what
 * the key's own remaining segments (entityName, userId) look like.
 */
function keyFor(projectId: string, entityName: string, userId: string): string {
  return `${projectId}:${entityName}:${userId}`;
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
 * entity's own natural field order. Round 1069: also scoped per user --
 * see keyFor's own doc comment above.
 */
export function getColumnOrder(projectId: string, entityName: string, userId: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName, userId)] ?? [])];
}

/** Persists a full field-name order and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setColumnOrder(projectId: string, entityName: string, userId: string, order: string[]): string[] {
  const store = readStore();
  store[keyFor(projectId, entityName, userId)] = order;
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
 * Removes just one entity's stored column order, across every collaborator
 * account (the key's third segment is userId, not something this function
 * can know in advance -- the same reason columnWidths.ts's own
 * purgeColumnWidthsForEntity sweeps by prefix rather than a single exact
 * key), unlike purgeColumnOrderForProject above (the whole project). Used
 * when a single entity is dropped from an otherwise-surviving project's
 * spec -- see entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge.
 */
export function purgeColumnOrderForEntity(projectId: string, entityName: string): void {
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
 * store's real data unreachable under the old key" mechanism. Round 1069:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * columnWidths.ts's own migrateColumnWidthsForEntityRename does, since the
 * key's own userId segment isn't known in advance.
 */
export function migrateColumnOrderForEntityRename(projectId: string, oldName: string, newName: string): void {
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
