const STORAGE_KEY = "forge.viewMode";

export type PersistedViewMode = "table" | "board" | "calendar";

/**
 * Round 1064: the userId segment was added so two different collaborator
 * accounts sharing the same project on the same browser no longer see each
 * other's own chosen Table/Board/Calendar view -- the same cross-account
 * leak class rounds 1054 (fieldFiltersPreference.ts) and 1055
 * (columnVisibility.ts) already closed for two sibling stores on this
 * exact screen, never ported here. See fieldFiltersPreference.ts's own
 * keyFor doc comment for the full reasoning. purgeViewModeForProject/
 * purgeViewModeForEntity below still match by prefix, which keeps working
 * unchanged regardless of what the key's own remaining segments
 * (entityName, userId) look like.
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

function isPersistedViewMode(value: unknown): value is PersistedViewMode {
  return value === "table" || value === "board" || value === "calendar";
}

function readStore(): Record<string, PersistedViewMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, PersistedViewMode> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPersistedViewMode(value)) store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, PersistedViewMode>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted Table/Board/Calendar view choice for one entity's records
 * screen (round 243) -- scoped per project+entity, mirroring
 * groupByPreference.ts's own keying. Previously viewMode was hard-reset to
 * "table" on every entity switch and never persisted, so a Kanban board or
 * calendar view someone deliberately set up for an entity had to be
 * re-selected by hand every single time they switched tabs and came back.
 * Returns "table" (matching the default view) when nothing has ever been
 * chosen for this project+entity. Round 1064: also scoped per user -- see
 * keyFor's own doc comment above.
 *
 * Round 1549: a case-only entity rename (an ordinary, explicitly-anticipated
 * refine/AI casing drift) only ever gets this store's keys rewritten by
 * migrateViewModeForEntityRename below, which -- exactly like
 * columnOrder.ts's/columnWidths.ts's/columnVisibility.ts's/
 * fieldFiltersPreference.ts's/groupByPreference.ts's/sortKeysPreference.ts's
 * own migrate functions before rounds 1542-1548 -- is called only from the
 * single browser tab that happened to trigger the rename. Every OTHER
 * collaborator's own localStorage keeps this choice under the entity's OLD
 * casing forever -- the exact-match lookup above would miss it with zero
 * error or indication, silently reverting that collaborator's deliberately
 * chosen Board/Calendar view back to "table". Falls back to a
 * case-insensitive scan of this exact project+user's own keys, the same
 * resolution rounds 1542-1548 applied to this bug family's other instances.
 */
export function getViewMode(projectId: string, entityName: string, userId: string): PersistedViewMode {
  const store = readStore();
  const exact = store[keyFor(projectId, entityName, userId)];
  if (exact !== undefined) return exact;
  const lowerEntityName = entityName.toLowerCase();
  for (const [key, value] of Object.entries(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, keyUserId] = parsed;
    if (keyProjectId === projectId && keyUserId === userId && keyEntityName.toLowerCase() === lowerEntityName) return value;
  }
  return "table";
}

/** Persists a view-mode choice and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setViewMode(projectId: string, entityName: string, userId: string, mode: PersistedViewMode): PersistedViewMode {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  if (mode === "table") delete store[key];
  else store[key] = mode;
  writeStore(store);
  return mode;
}

/**
 * Round 1145: mirrors columnWidths.ts's own identical
 * removeColumnWidthsForUserProject -- see its doc comment for the full
 * "round 1128 incorrectly claimed this store wasn't per-user-keyed"
 * mechanism. A departing collaborator's own Table/Board/Calendar choice
 * for every entity of a project they left (or lost access to via account
 * deletion) leaked forever until this fix.
 */
export function removeViewModeForUserProject(projectId: string, userId: string): void {
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

/** Same purge-on-project-delete pattern as groupByPreference.ts/columnWidths.ts and siblings -- see projectPreferenceCleanup.ts for why this exists. */
export function purgeViewModeForProject(projectId: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes every collaborator account's own view-mode choice for one
 * entity, unlike purgeViewModeForProject above (the whole project). Used
 * when a single entity is dropped from an otherwise-surviving project's
 * spec -- see entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge. Round 1064: sweeps by prefix across every
 * collaborator account rather than deleting one exact key -- the key's own
 * userId segment isn't knowable in advance, the same reason
 * fieldFiltersPreference.ts's own purgeFieldFiltersForEntity does the same.
 */
export function purgeViewModeForEntity(projectId: string, entityName: string): void {
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
 * store's real data unreachable under the old key" mechanism. Round 1064:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * fieldFiltersPreference.ts's own migrateFieldFiltersForEntityRename does,
 * since the key's own userId segment isn't known in advance.
 */
export function migrateViewModeForEntityRename(projectId: string, oldName: string, newName: string): void {
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
