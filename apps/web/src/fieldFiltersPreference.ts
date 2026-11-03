const STORAGE_KEY = "forge.fieldFilters";

/**
 * Round 1054: the userId segment was added so two different collaborator
 * accounts sharing the same project on the same browser no longer see each
 * other's typed filter values -- see entityRecentSearches.ts's own
 * keyFor doc comment (round 994) for the full reasoning. This store is
 * more sensitive than that one: a filter leaking across accounts doesn't
 * just surface a stray search string, it silently restores another
 * person's exact chosen condition (e.g. Status = "Overdue") into the next
 * collaborator's own table view, with no indication it came from someone
 * else. purgeFieldFiltersForProject/purgeFieldFiltersForEntity below still
 * match by prefix, which keeps working unchanged regardless of what the
 * key's own remaining segments (entityName, userId) look like.
 *
 * Round 1579: JSON-encoded rather than colon-joined -- see columnWidths.ts's
 * own keyFor doc comment for the full "Foo"/"Foo:Bar" collision reasoning,
 * ported here identically.
 */
function keyFor(projectId: string, entityName: string, userId: string): string {
  return JSON.stringify([projectId, entityName, userId]);
}

function parseKey(key: string): [string, string, string] | null {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((part): part is string => typeof part === "string")) {
      return parsed as [string, string, string];
    }
    return null;
  } catch {
    return null;
  }
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
 * Round 1054: also scoped per user -- see keyFor's own doc comment above.
 *
 * Round 1545: a case-only entity rename (an ordinary, explicitly-anticipated
 * refine/AI casing drift) only ever gets this store's keys rewritten by
 * migrateFieldFiltersForEntityRename below, which -- exactly like
 * columnOrder.ts's/columnWidths.ts's/columnVisibility.ts's own migrate
 * functions before rounds 1542-1544 -- is called only from the single
 * browser tab that happened to trigger the rename (App.tsx's
 * build/refine-complete handler, or a checkpoint restore). Every OTHER
 * collaborator's own localStorage keeps this preference under the entity's
 * OLD casing forever -- the exact-match lookup above would miss it with
 * zero error or indication, silently reverting that collaborator's table to
 * showing every row unfiltered while they still believe their own chosen
 * filter (e.g. Status = "Overdue") is applied -- arguably the most
 * consequential instance of this bug family, since it misleads about what
 * DATA is being shown rather than just a cosmetic layout choice. Falls back
 * to a case-insensitive scan of this exact project+user's own keys, the
 * same resolution rounds 1542-1544 applied to this bug family's other
 * instances.
 */
export function getFieldFilters(projectId: string, entityName: string, userId: string): Record<string, string> {
  const store = readStore();
  const exact = store[keyFor(projectId, entityName, userId)];
  if (exact) return { ...exact };
  const lowerEntityName = entityName.toLowerCase();
  for (const [key, value] of Object.entries(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, keyUserId] = parsed;
    if (keyProjectId === projectId && keyUserId === userId && keyEntityName.toLowerCase() === lowerEntityName) return { ...value };
  }
  return {};
}

/** Persists the entity's full updated filter map (dropping any cleared-to-"" entries) and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setFieldFilters(
  projectId: string,
  entityName: string,
  userId: string,
  filters: Record<string, string>,
): Record<string, string> {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const cleaned: Record<string, string> = {};
  for (const [field, value] of Object.entries(filters)) {
    if (value) cleaned[field] = value;
  }
  if (Object.keys(cleaned).length === 0) delete store[key];
  else store[key] = cleaned;
  writeStore(store);
  return cleaned;
}

/**
 * Round 1145: mirrors columnWidths.ts's own identical
 * removeColumnWidthsForUserProject -- see its doc comment for the full
 * "round 1128 incorrectly claimed this store wasn't per-user-keyed"
 * mechanism. A departing collaborator's own toolbar filters for every
 * entity of a project they left (or lost access to via account deletion)
 * leaked forever until this fix.
 */
export function removeFieldFiltersForUserProject(projectId: string, userId: string): void {
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId && parsed[2] === userId) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** Removes every stored filter map for this project, across all of its entities and every collaborator -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeFieldFiltersForProject(projectId: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored filter map, across every collaborator
 * account (the key's third segment is userId, not something this function
 * can know in advance -- the same reason
 * entityRecentSearches.ts's own purgeEntityRecentSearchesForEntity sweeps
 * by prefix rather than a single exact key), unlike
 * purgeFieldFiltersForProject above (the whole project). Used when a
 * single entity is dropped from an otherwise-surviving project's spec --
 * see entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge.
 */
export function purgeFieldFiltersForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId && parsed[1] === entityName) delete store[key];
  }
  writeStore(store);
}

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename
 * -- see its doc comment for the full "case-only entity rename leaves this
 * store's real data unreachable under the old key" mechanism. Round 1054:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * entityRecentSearches.ts's own migrateEntityRecentSearchesForEntityRename
 * does, since the key's own userId segment isn't known in advance.
 */
export function migrateFieldFiltersForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, userId] = parsed;
    if (keyProjectId !== projectId || keyEntityName !== oldName) continue;
    const newKey = keyFor(projectId, newName, userId);
    if (store[newKey] === undefined) store[newKey] = store[key];
    delete store[key];
    changed = true;
  }
  if (changed) writeStore(store);
}
