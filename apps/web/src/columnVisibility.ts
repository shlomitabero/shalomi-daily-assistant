const STORAGE_KEY = "forge.hiddenColumns";

/**
 * Round 1055: the userId segment was added so two different collaborator
 * accounts sharing the same project on the same browser no longer see
 * each other's own chosen hidden columns -- see fieldFiltersPreference.ts's
 * own keyFor doc comment (round 1054) and entityRecentSearches.ts's (round
 * 994) for the full reasoning. This store fails more silently than either
 * of those: a leaked filter value or search string is at least visible in
 * its own input, but a hidden column is simply absent, with nothing in the
 * UI telling a collaborator a field even exists -- they just see fewer
 * columns than their teammate set up, with no cue anything is missing.
 * purgeHiddenFieldsForProject/purgeHiddenFieldsForEntity below still match
 * by prefix, which keeps working unchanged regardless of what the key's
 * own remaining segments (entityName, userId) look like.
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
 * Which of an entity's own fields are currently hidden from its table view,
 * scoped per project+entity so hiding a wide entity's columns in one
 * project never affects another project's same-named entity. Round 1055:
 * also scoped per user -- see keyFor's own doc comment above.
 */
export function getHiddenFields(projectId: string, entityName: string, userId: string): Set<string> {
  const store = readStore();
  return new Set(store[keyFor(projectId, entityName, userId)] ?? []);
}

/** Toggles one field's hidden state and returns the new full set, so callers can update their own state from the return value instead of re-reading storage. */
export function toggleFieldVisibility(projectId: string, entityName: string, userId: string, fieldName: string): Set<string> {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const hidden = new Set(store[key] ?? []);
  if (hidden.has(fieldName)) hidden.delete(fieldName);
  else hidden.add(fieldName);
  store[key] = [...hidden];
  writeStore(store);
  return hidden;
}

/**
 * Replaces the entity's full hidden-fields set and returns it, so callers
 * can update their own state from the return value instead of re-reading
 * storage -- unlike toggleFieldVisibility above (one field at a time).
 * Used when remapping stale, case-differently-spelled entries after a live
 * refine renames a field's letter casing (round 985).
 */
export function replaceHiddenFields(projectId: string, entityName: string, userId: string, fields: Iterable<string>): Set<string> {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const hidden = new Set(fields);
  if (hidden.size === 0) delete store[key];
  else store[key] = [...hidden];
  writeStore(store);
  return hidden;
}

/**
 * Round 1145: mirrors columnWidths.ts's own identical
 * removeColumnWidthsForUserProject -- see its doc comment for the full
 * "round 1128 incorrectly claimed this store wasn't per-user-keyed"
 * mechanism. A departing collaborator's own hidden-columns choice for
 * every entity of a project they left (or lost access to via account
 * deletion) leaked forever until this fix.
 */
export function removeHiddenFieldsForUserProject(projectId: string, userId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  const suffix = `:${userId}`;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** Removes every stored hidden-fields set for this project, across all of its entities and every collaborator -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeHiddenFieldsForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored hidden-fields set, across every
 * collaborator account (the key's third segment is userId, not something
 * this function can know in advance -- the same reason
 * entityRecentSearches.ts's own purgeEntityRecentSearchesForEntity sweeps
 * by prefix rather than a single exact key), unlike
 * purgeHiddenFieldsForProject above (the whole project). Used when a
 * single entity is dropped from an otherwise-surviving project's spec --
 * see entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge.
 */
export function purgeHiddenFieldsForEntity(projectId: string, entityName: string): void {
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
 * store's real data unreachable under the old key" mechanism. Round 1055:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * entityRecentSearches.ts's own migrateEntityRecentSearchesForEntityRename
 * does, since the key's own userId segment isn't known in advance.
 */
export function migrateHiddenFieldsForEntityRename(projectId: string, oldName: string, newName: string): void {
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
