const STORAGE_KEY = "forge.collapsedGroups";

// JSON-encoded rather than colon-joined: entity/field names have no character
// restriction (EntitySchema/FieldSchema just require a non-empty string), so two
// sibling entities like "Foo" and "Foo:Bar" can both legally exist in one project.
// A colon-joined key made purgeCollapsedGroupsForEntity's prefix scan for "Foo"
// also match "Foo:Bar"'s keys. JSON.stringify of the tuple makes each segment
// boundary unambiguous regardless of what characters the segments contain.
//
// Round 1077: userId was added as a 4th segment so two different collaborator
// accounts sharing the same project+entity+groupField on the same browser no
// longer see each other's own collapsed-group choices -- the same cross-
// account leak class already closed for every other sibling store on this
// exact screen (groupByPreference.ts round 1075, sortKeysPreference.ts round
// 1074, columnOrder.ts round 1069, and others), never ported to this store
// (or its own board-column twin) until now. See fieldFiltersPreference.ts's
// own keyFor doc comment for the full reasoning. purgeCollapsedGroupsForProject/
// purgeCollapsedGroupsForEntity below still match by parsed projectId/
// entityName alone, which keeps working unchanged regardless of what the
// key's own remaining segments (groupFieldName, userId) look like.
function keyFor(projectId: string, entityName: string, groupFieldName: string, userId: string): string {
  return JSON.stringify([projectId, entityName, groupFieldName, userId]);
}

function parseKey(key: string): [string, string, string, string] | null {
  try {
    const parsed = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((part): part is string => typeof part === "string")
    ) {
      return parsed as [string, string, string, string];
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
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * Which group keys a person has collapsed in the grouped table view,
 * scoped per project+entity+groupFieldName, mirroring fieldFiltersPreference.ts's
 * own keying. Previously there was no way to collapse a group at all -- a
 * grouped table with a large group (e.g. 50 "Done" records) always
 * rendered every one of its rows, defeating the point of grouping a
 * sizeable table to begin with.
 *
 * groupFieldName is part of the key (not just project+entity) because
 * groupRecordsByField's own group keys are field-independent: every
 * boolean field's two groups are keyed by the literal strings "true"/
 * "false", and an enum field's groups are keyed by its raw enum values --
 * so two boolean fields, or two enum fields sharing a value, would
 * otherwise collapse each other's groups the moment "Group by" switched
 * from one to the other.
 */
export function getCollapsedGroups(projectId: string, entityName: string, groupFieldName: string, userId: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName, groupFieldName, userId)] ?? [])];
}

/**
 * Round 1008: the load effect's own counterpart to EntityPanel.tsx's
 * round-985 fix for groupFieldName itself -- that fix correctly remaps the
 * React *selection* from an old field-name casing to a new one when a live
 * refine renames the grouped field's letters only (e.g. "status" ->
 * "Status"), but this store's own key includes groupFieldName as its
 * third segment (unlike hiddenFields/columnOrder/sortKeys, all fixed by
 * that same round, none of which are keyed by a dynamic field name this
 * way) -- so the moment groupFieldName's OWN state updates to the new
 * casing, a plain exact-match `getCollapsedGroups` lookup under the new
 * key finds nothing, and the group the user had deliberately collapsed
 * under the old key silently reappears fully expanded, with the real
 * collapsed set now orphaned in storage forever under a key nothing will
 * ever look up again.
 *
 * Falls back to a case-insensitive match under the SAME project+entity
 * only when the exact lookup is empty, and migrates it (persists under
 * the new key, removes the old one) rather than just reading through --
 * so the rename is resolved once, the same way hiddenFields' own round-985
 * fix persists its remap rather than re-discovering it on every load.
 * Prefers the exact match whenever it has anything at all, so a
 * genuinely-collapsed-to-empty set (a user who re-expanded everything)
 * can never be overridden by a stale old-cased entry.
 */
export function migrateCollapsedGroupsFieldCase(projectId: string, entityName: string, groupFieldName: string, userId: string): string[] {
  const exact = getCollapsedGroups(projectId, entityName, groupFieldName, userId);
  if (exact.length > 0) return exact;
  const store = readStore();
  const lowerFieldName = groupFieldName.toLowerCase();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed || parsed[0] !== projectId || parsed[1] !== entityName || parsed[3] !== userId) continue;
    if (parsed[2] === groupFieldName || parsed[2].toLowerCase() !== lowerFieldName) continue;
    const migrated = [...store[key]];
    delete store[key];
    const newKey = keyFor(projectId, entityName, groupFieldName, userId);
    if (migrated.length > 0) store[newKey] = migrated;
    else delete store[newKey];
    writeStore(store);
    return migrated;
  }
  return [];
}

/** Persists the entity's full updated set of collapsed group keys and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setCollapsedGroups(projectId: string, entityName: string, groupFieldName: string, userId: string, keys: string[]): string[] {
  const store = readStore();
  const mapKey = keyFor(projectId, entityName, groupFieldName, userId);
  const deduped = [...new Set(keys)];
  if (deduped.length === 0) delete store[mapKey];
  else store[mapKey] = deduped;
  writeStore(store);
  return deduped;
}

/** Removes every stored collapsed-group set for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeCollapsedGroupsForProject(projectId: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored collapsed-group sets (every
 * groupFieldName this entity has ever used, since the key has a third
 * segment this store-wide purge can't name in advance), unlike
 * purgeCollapsedGroupsForProject above (the whole project). Used when a
 * single entity is dropped from an otherwise-surviving project's spec --
 * see entityPreferenceCleanup.ts for why this exists alongside the
 * project-wide purge.
 */
export function purgeCollapsedGroupsForEntity(projectId: string, entityName: string): void {
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
 * store's real data unreachable under the old key" mechanism. Rewrites
 * EVERY groupFieldName this entity has ever used (the key's third segment,
 * which this function can't know in advance -- the same reason
 * purgeCollapsedGroupsForEntity above sweeps by parsed key rather than a
 * single exact one), independent of migrateCollapsedGroupsFieldCase above
 * (which only ever remaps the THIRD segment, groupFieldName, never the
 * second, entityName).
 */
export function migrateCollapsedGroupsForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed || parsed[0] !== projectId || parsed[1] !== oldName) continue;
    const newKey = keyFor(projectId, newName, parsed[2], parsed[3]);
    if (store[newKey] === undefined) store[newKey] = store[key];
    delete store[key];
    changed = true;
  }
  if (changed) writeStore(store);
}
