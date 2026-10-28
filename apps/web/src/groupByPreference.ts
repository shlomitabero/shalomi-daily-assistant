const STORAGE_KEY = "forge.groupByField";

/**
 * Round 1075: the userId segment was added so two different collaborator
 * accounts sharing the same project+entity on the same browser no longer
 * see each other's own "Group by" choice (and its paired field-type entry
 * below) -- the same cross-account leak class already closed for every
 * other sibling store on this exact screen (sortKeysPreference.ts round
 * 1074, columnOrder.ts round 1069, columnWidths.ts round 1068,
 * columnVisibility.ts round 1055, fieldFiltersPreference.ts round 1054),
 * never ported here. See fieldFiltersPreference.ts's own keyFor doc
 * comment for the full reasoning. purgeGroupByFieldForProject/
 * purgeGroupByFieldForEntity below still match by prefix, which keeps
 * working unchanged regardless of what the key's own remaining segments
 * (entityName, userId) look like.
 */
function keyFor(projectId: string, entityName: string, userId: string): string {
  return `${projectId}:${entityName}:${userId}`;
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
export function getGroupByField(projectId: string, entityName: string, userId: string): string {
  const store = readStore();
  return store[keyFor(projectId, entityName, userId)] ?? "";
}

/** Persists a group-by field choice (or "" to clear it) and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setGroupByField(projectId: string, entityName: string, userId: string, fieldName: string): string {
  const store = readStore();
  if (fieldName) store[keyFor(projectId, entityName, userId)] = fieldName;
  else delete store[keyFor(projectId, entityName, userId)];
  writeStore(store);
  return fieldName;
}

/**
 * Round 1145: mirrors columnWidths.ts's own identical
 * removeColumnWidthsForUserProject -- see its doc comment for the full
 * "round 1128 incorrectly claimed this store wasn't per-user-keyed"
 * mechanism. A departing collaborator's own group-by choice (and its
 * paired field-type entry) for every entity of a project they left (or
 * lost access to via account deletion) leaked forever until this fix.
 * Clears both stores together, the same pairing purgeGroupByFieldForEntity
 * above already keeps in sync.
 */
export function removeGroupByFieldForUserProject(projectId: string, userId: string): void {
  const prefix = `${projectId}:`;
  const suffix = `:${userId}`;
  const store = readStore();
  let storeChanged = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      delete store[key];
      storeChanged = true;
    }
  }
  if (storeChanged) writeStore(store);
  const typeStore = readTypeStore();
  let typeStoreChanged = false;
  for (const key of Object.keys(typeStore)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      delete typeStore[key];
      typeStoreChanged = true;
    }
  }
  if (typeStoreChanged) writeTypeStore(typeStore);
}

/** Removes every stored group-by choice for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeGroupByFieldForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
  purgeGroupByFieldTypeForProject(projectId);
}

const TYPE_STORAGE_KEY = "forge.groupByFieldType";

function readTypeStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TYPE_STORAGE_KEY);
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

function writeTypeStore(store: Record<string, string>): void {
  try {
    localStorage.setItem(TYPE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The field TYPE that was current at the moment getGroupByField's own value
 * above was last chosen for this project+entity -- a sibling store, not a
 * second property on the same entry, so the existing plain-string shape
 * above (and every test already asserting against it) stays untouched.
 *
 * Round 780 already closed the "field TYPE changes while its NAME survives"
 * hazard for a component that STAYS mounted through a live refine, via an
 * in-memory ref with no persistence of its own -- but a ref has nothing to
 * compare against the instant a fresh EntityPanel mounts (switching to a
 * different entity tab and back unmounts and remounts it, per App.tsx's own
 * `.filter((e) => e.name === activeEntity)`), so a refine that retypes the
 * grouped field while its tab is NOT the active one left the persisted
 * groupFieldName selected under its new, likely-incompatible type the
 * moment the tab was reopened -- the identical fabricated-group hazard
 * round 780's own fix describes, just reached via a remount instead of a
 * live refine while mounted. Returns "" when nothing has ever been
 * recorded, so a pre-existing persisted choice from before this round
 * shipped is treated as "no type on record yet" rather than a mismatch.
 */
export function getGroupByFieldType(projectId: string, entityName: string, userId: string): string {
  const store = readTypeStore();
  return store[keyFor(projectId, entityName, userId)] ?? "";
}

/** Persists the field type alongside a group-by choice (call together with setGroupByField), or clears it when type is "". */
export function setGroupByFieldType(projectId: string, entityName: string, userId: string, type: string): void {
  const store = readTypeStore();
  if (type) store[keyFor(projectId, entityName, userId)] = type;
  else delete store[keyFor(projectId, entityName, userId)];
  writeTypeStore(store);
}

/** Removes every stored group-by field TYPE for this project -- see purgeGroupByFieldForProject, which already calls this. */
export function purgeGroupByFieldTypeForProject(projectId: string): void {
  const store = readTypeStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeTypeStore(store);
}

/**
 * Removes just one entity's stored group-by field choice (and its paired
 * TYPE entry), across every collaborator account (the key's third segment
 * is userId, not something this function can know in advance -- the same
 * reason columnOrder.ts's own purgeColumnOrderForEntity sweeps by prefix
 * rather than a single exact key), unlike purgeGroupByFieldForProject
 * above (the whole project). Used when a single entity is dropped from an
 * otherwise-surviving project's spec -- see entityPreferenceCleanup.ts for
 * why this exists alongside the project-wide purge.
 */
export function purgeGroupByFieldForEntity(projectId: string, entityName: string): void {
  const prefix = `${projectId}:${entityName}:`;
  const store = readStore();
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
  const typeStore = readTypeStore();
  for (const key of Object.keys(typeStore)) {
    if (key.startsWith(prefix)) delete typeStore[key];
  }
  writeTypeStore(typeStore);
}

/**
 * Round 1029: mirrors columnWidths.ts's own migrateColumnWidthsForEntityRename
 * -- see its doc comment for the full "case-only entity rename leaves this
 * store's real data unreachable under the old key" mechanism. Migrates
 * both the group-by choice and its paired type entry, the same pair
 * purgeGroupByFieldForEntity above already keeps in sync. Round 1075:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * columnOrder.ts's own migrateColumnOrderForEntityRename does, since the
 * key's own userId segment isn't known in advance.
 */
export function migrateGroupByFieldForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const oldPrefix = `${projectId}:${oldName}:`;
  const store = readStore();
  let storeChanged = false;
  for (const key of Object.keys(store)) {
    if (!key.startsWith(oldPrefix)) continue;
    const userId = key.slice(oldPrefix.length);
    const newKey = keyFor(projectId, newName, userId);
    if (store[newKey] === undefined) store[newKey] = store[key];
    delete store[key];
    storeChanged = true;
  }
  if (storeChanged) writeStore(store);
  const typeStore = readTypeStore();
  let typeStoreChanged = false;
  for (const key of Object.keys(typeStore)) {
    if (!key.startsWith(oldPrefix)) continue;
    const userId = key.slice(oldPrefix.length);
    const newKey = keyFor(projectId, newName, userId);
    if (typeStore[newKey] === undefined) typeStore[newKey] = typeStore[key];
    delete typeStore[key];
    typeStoreChanged = true;
  }
  if (typeStoreChanged) writeTypeStore(typeStore);
}
