const STORAGE_KEY = "forge.pinnedRecords";

// JSON-encoded rather than colon-joined, mirroring collapsedGroupsPreference.ts's
// own keyFor doc comment: entity names have no character restriction
// (EntitySchema just requires a non-empty string), so a colon-joined key would
// let a sibling entity whose name happens to contain a colon collide with
// another entity's own prefix scan. JSON.stringify of the tuple makes each
// segment boundary unambiguous regardless of what characters the segments
// contain. userId is part of the key from day one -- the identical
// cross-account leak class rounds 1054-1077 fixed for every sibling
// per-project+entity preference store, never reopened here since this store
// is new.
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

function readStore(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      store[key] = value.filter((v): v is string => typeof v === "string");
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
    // localStorage can be unavailable (private mode) -- the pin just won't survive a reload.
  }
}

/**
 * Round 1571: records had no per-row "pin"/"favorite" affordance at all --
 * the project level has had exactly this (pinnedProjects.ts, round 1003)
 * since the My Projects home screen's own ⭐/☆ toggle, but it was never
 * extended one level down to an entity's own records, even though almost
 * every other per-row/per-view preference on this exact screen (view mode,
 * sort, group-by, column order/width/visibility, collapsed groups, recent
 * searches) already has a mature per-project+entity+user store of this
 * same shape. A handful of records someone keeps coming back to (an
 * overdue invoice, a VIP customer, a blocked task) had no way to surface
 * above the rest of a long table short of a manual filter or search every
 * single time.
 *
 * Scoped per project+entity+user, mirroring collapsedGroupsPreference.ts's
 * own JSON-array key shape. Falls back to a case-insensitive scan of this
 * exact project+user's own keys when no exact match exists, the SAME
 * resolution rounds 1542-1550 had to retrofit onto nine sibling stores
 * after the fact for a case-only entity rename (an ordinary,
 * explicitly-anticipated refine/AI casing drift) -- built in here from the
 * start instead of waiting to be rediscovered as a missed-store gap.
 */
export function getPinnedRecordIds(projectId: string, entityName: string, userId: string): Set<number> {
  const store = readStore();
  const exact = store[keyFor(projectId, entityName, userId)];
  if (exact !== undefined) return toIdSet(exact);
  const lowerEntityName = entityName.toLowerCase();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, keyUserId] = parsed;
    if (keyProjectId === projectId && keyUserId === userId && keyEntityName.toLowerCase() === lowerEntityName) {
      return toIdSet(store[key]);
    }
  }
  return new Set();
}

function toIdSet(ids: string[]): Set<number> {
  const result = new Set<number>();
  for (const id of ids) {
    const n = Number(id);
    if (Number.isFinite(n)) result.add(n);
  }
  return result;
}

/**
 * Round 1595: a deleted record's own id never got removed from this store --
 * commitPendingDelete (EntityPanel.tsx) only ever restores on failure, never
 * forgets on success, so a pinned record's id sat in localStorage forever
 * once the real record was gone, with no size cap of its own (unlike e.g.
 * whatsappRecentNumbers.ts's MAX_RECENT_NUMBERS) to bound the leak. The
 * exact "unbounded localStorage growth across a resource's lifecycle" bug
 * class rounds 390-1128 already fixed repeatedly for projects/entities, just
 * never extended to this finer grain since records didn't have their own
 * preference key before round 1571. Unconditional (unlike toggleRecordPinned,
 * which flips state either way) -- a no-op on an id that was never pinned.
 */
export function removePinnedRecord(projectId: string, entityName: string, userId: string, recordId: number): void {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const ids = store[key];
  if (ids === undefined) return;
  const idStr = String(recordId);
  const next = ids.filter((id) => id !== idStr);
  if (next.length === ids.length) return;
  if (next.length === 0) delete store[key];
  else store[key] = next;
  writeStore(store);
}

/** Toggles one record's pinned state for this one project+entity+user and returns the new full set, so callers can update their own state from the return value instead of re-reading storage. */
export function toggleRecordPinned(projectId: string, entityName: string, userId: string, recordId: number): Set<number> {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const ids = store[key] ?? [];
  const idStr = String(recordId);
  const index = ids.indexOf(idStr);
  const next = index === -1 ? [...ids, idStr] : ids.filter((id) => id !== idStr);
  if (next.length === 0) delete store[key];
  else store[key] = next;
  writeStore(store);
  return toIdSet(next);
}

/**
 * Pinned records first, unpinned after -- each group keeping its own
 * original relative order, mirroring pinnedProjects.ts's own identical
 * sortByPinned. Deliberately unconstrained (no `extends { id }`): EntityRecord
 * (packages/shared) is a pure index-signature type (`Record<string, string |
 * number | boolean | null>`), which TypeScript never treats as structurally
 * "having" an `id` property for a generic constraint check, even though
 * `record.id` works fine at runtime -- the same reason EntityPanel.tsx casts
 * `record.id as number` at every other use site instead of relying on the
 * type checker to know the shape.
 */
export function sortRecordsByPinned<T>(records: T[], pinnedIds: Set<number>): T[] {
  if (pinnedIds.size === 0) return records;
  const idOf = (r: T): number => (r as { id: unknown }).id as number;
  const pinned = records.filter((r) => pinnedIds.has(idOf(r)));
  const unpinned = records.filter((r) => !pinnedIds.has(idOf(r)));
  return [...pinned, ...unpinned];
}

/** Same purge-on-entity-drop pattern as collapsedGroupsPreference.ts/viewModePreference.ts and siblings -- see entityPreferenceCleanup.ts for why this exists. Sweeps every collaborator's own entry for this one entity, since the key's own userId segment isn't knowable in advance. */
export function purgePinnedRecordsForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed[0] === projectId && parsed[1] === entityName) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** Same purge-on-project-delete pattern as collapsedGroupsPreference.ts/viewModePreference.ts and siblings -- see projectPreferenceCleanup.ts for why this exists. */
export function purgePinnedRecordsForProject(projectId: string): void {
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed[0] === projectId) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/**
 * Removes just this one user's own pins across every entity of this one
 * project, unlike purgePinnedRecordsForProject above (every collaborator).
 * Same "departing collaborator's own leftovers" shape projectPreferenceCleanup.ts's
 * purgeOwnProjectAccess already closed for nine sibling stores in rounds
 * 1127-1145 -- see its own doc comment for the full "access revoked, not
 * project deleted" reasoning this mirrors.
 */
export function removePinnedRecordsForUserProject(projectId: string, userId: string): void {
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed[0] === projectId && parsed[2] === userId) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/**
 * Round 1571: mirrors viewModePreference.ts's own migrateViewModeForEntityRename
 * -- see its doc comment for the full "case-only entity rename leaves this
 * store's real data unreachable under the old key" mechanism. Rewrites
 * EVERY collaborator's own entry for this entity, since the key's own
 * userId segment isn't known in advance -- though getPinnedRecordIds's own
 * case-insensitive fallback already covers the read path for every
 * collaborator except this one, calling this from the single tab that
 * triggered the rename still collapses the stale old-cased key instead of
 * leaving it to rot forever, the same choice every sibling migrate
 * function in this family already makes.
 */
export function migratePinnedRecordsForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, keyUserId] = parsed;
    if (keyProjectId !== projectId || keyEntityName !== oldName) continue;
    const newKey = keyFor(projectId, newName, keyUserId);
    const existing = store[newKey] ?? [];
    const merged = [...new Set([...existing, ...store[key]])];
    store[newKey] = merged;
    delete store[key];
    changed = true;
  }
  if (changed) writeStore(store);
}
