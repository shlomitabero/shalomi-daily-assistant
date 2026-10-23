const STORAGE_KEY = "forge.collapsedGroups";

// JSON-encoded rather than colon-joined: entity/field names have no character
// restriction (EntitySchema/FieldSchema just require a non-empty string), so two
// sibling entities like "Foo" and "Foo:Bar" can both legally exist in one project.
// A colon-joined key made purgeCollapsedGroupsForEntity's prefix scan for "Foo"
// also match "Foo:Bar"'s keys. JSON.stringify of the tuple makes each segment
// boundary unambiguous regardless of what characters the segments contain.
function keyFor(projectId: string, entityName: string, groupFieldName: string): string {
  return JSON.stringify([projectId, entityName, groupFieldName]);
}

function parseKey(key: string): [string, string, string] | null {
  try {
    const parsed = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part): part is string => typeof part === "string")
    ) {
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
export function getCollapsedGroups(projectId: string, entityName: string, groupFieldName: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName, groupFieldName)] ?? [])];
}

/** Persists the entity's full updated set of collapsed group keys and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setCollapsedGroups(projectId: string, entityName: string, groupFieldName: string, keys: string[]): string[] {
  const store = readStore();
  const mapKey = keyFor(projectId, entityName, groupFieldName);
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
