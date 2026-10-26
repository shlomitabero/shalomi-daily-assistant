const STORAGE_KEY = "forge.hiddenColumns";

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

/** Which of an entity's own fields are currently hidden from its table view, scoped per project+entity so hiding a wide entity's columns in one project never affects another project's same-named entity. */
export function getHiddenFields(projectId: string, entityName: string): Set<string> {
  const store = readStore();
  return new Set(store[keyFor(projectId, entityName)] ?? []);
}

/** Toggles one field's hidden state and returns the new full set, so callers can update their own state from the return value instead of re-reading storage. */
export function toggleFieldVisibility(projectId: string, entityName: string, fieldName: string): Set<string> {
  const store = readStore();
  const key = keyFor(projectId, entityName);
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
export function replaceHiddenFields(projectId: string, entityName: string, fields: Iterable<string>): Set<string> {
  const store = readStore();
  const key = keyFor(projectId, entityName);
  const hidden = new Set(fields);
  if (hidden.size === 0) delete store[key];
  else store[key] = [...hidden];
  writeStore(store);
  return hidden;
}

/** Removes every stored hidden-fields set for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeHiddenFieldsForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored hidden-fields set, unlike
 * purgeHiddenFieldsForProject above (the whole project). Used when a
 * single entity is dropped from an otherwise-surviving project's spec --
 * see entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge.
 */
export function purgeHiddenFieldsForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  delete store[keyFor(projectId, entityName)];
  writeStore(store);
}

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename
 * -- see its doc comment for the full "case-only entity rename leaves this
 * store's real data unreachable under the old key" mechanism.
 */
export function migrateHiddenFieldsForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  const oldKey = keyFor(projectId, oldName);
  const newKey = keyFor(projectId, newName);
  if (store[oldKey] === undefined || store[newKey] !== undefined) return;
  store[newKey] = store[oldKey];
  delete store[oldKey];
  writeStore(store);
}
