const STORAGE_KEY = "forge.collapsedBoardColumns";

// JSON-encoded rather than colon-joined: entity/field names have no character
// restriction (EntitySchema/FieldSchema just require a non-empty string), so two
// sibling entities like "Foo" and "Foo:Bar" can both legally exist in one project.
// A colon-joined key made purgeCollapsedBoardColumnsForEntity's prefix scan for
// "Foo" also match "Foo:Bar"'s keys. JSON.stringify of the tuple makes each
// segment boundary unambiguous regardless of what characters the segments contain.
function keyFor(projectId: string, entityName: string, boardFieldName: string): string {
  return JSON.stringify([projectId, entityName, boardFieldName]);
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
 * Which board-view column values a person has collapsed, scoped per
 * project+entity+boardFieldName, mirroring collapsedGroupsPreference.ts's
 * own keying (see its doc comment for why groupFieldName/boardFieldName
 * has to be part of the key) -- deliberately a SEPARATE store rather than
 * reusing that one: the grouped-table view's own collapsed keys come from
 * a potentially different field than the board's own boardField, so
 * sharing storage between the two would make collapsing "Won" in one view
 * silently collapse any same-named group/column in the other. Previously
 * there was no way to collapse a board column at all -- a huge "Done"
 * column always rendered every one of its cards.
 *
 * boardFieldName matters even for a single entity whose own name never
 * changes: findBoardField (entityFormatting.ts) recomputes which field is
 * the board field from the entity's CURRENT fields every render, so
 * adding/removing/reordering fields (or renaming one to/from "status"/
 * "stage") can silently swap which field drives the board -- without this
 * dimension in the key, the newly-chosen field would inherit whichever
 * columns were collapsed under the field that used to hold that role.
 */
export function getCollapsedBoardColumns(projectId: string, entityName: string, boardFieldName: string): string[] {
  const store = readStore();
  return [...(store[keyFor(projectId, entityName, boardFieldName)] ?? [])];
}

/**
 * Round 1008: the identical gap collapsedGroupsPreference.ts's own
 * migrateCollapsedGroupsFieldCase just fixed, for this store's own
 * boardFieldName dimension -- see that function's doc comment for the
 * full mechanism. boardFieldName isn't React state the way groupFieldName
 * is (findBoardField recomputes it fresh from entity.fields every render,
 * with no separate remap effect of its own), but a live refine that
 * renames the board-driving field's letters only (e.g. "status" ->
 * "Status") still makes it resolve to a new string the instant that
 * refine completes -- the load effect's own exact-match lookup under that
 * new key then finds nothing, and a board column the user had
 * deliberately collapsed silently reappears, with the real set orphaned
 * under the old key forever.
 */
export function migrateCollapsedBoardColumnsFieldCase(projectId: string, entityName: string, boardFieldName: string): string[] {
  const exact = getCollapsedBoardColumns(projectId, entityName, boardFieldName);
  if (exact.length > 0) return exact;
  const store = readStore();
  const lowerFieldName = boardFieldName.toLowerCase();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed || parsed[0] !== projectId || parsed[1] !== entityName) continue;
    if (parsed[2] === boardFieldName || parsed[2].toLowerCase() !== lowerFieldName) continue;
    const migrated = [...store[key]];
    delete store[key];
    const newKey = keyFor(projectId, entityName, boardFieldName);
    if (migrated.length > 0) store[newKey] = migrated;
    else delete store[newKey];
    writeStore(store);
    return migrated;
  }
  return [];
}

/** Persists the entity's full updated set of collapsed board-column values and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setCollapsedBoardColumns(projectId: string, entityName: string, boardFieldName: string, values: string[]): string[] {
  const store = readStore();
  const mapKey = keyFor(projectId, entityName, boardFieldName);
  const deduped = [...new Set(values)];
  if (deduped.length === 0) delete store[mapKey];
  else store[mapKey] = deduped;
  writeStore(store);
  return deduped;
}

/** Removes every stored collapsed-column set for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeCollapsedBoardColumnsForProject(projectId: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored collapsed-column sets (every
 * boardFieldName this entity has ever used, since the key has a third
 * segment this store-wide purge can't name in advance), unlike
 * purgeCollapsedBoardColumnsForProject above (the whole project). Used
 * when a single entity is dropped from an otherwise-surviving project's
 * spec -- see entityPreferenceCleanup.ts for why this exists alongside
 * the project-wide purge.
 */
export function purgeCollapsedBoardColumnsForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId && parsed[1] === entityName) delete store[key];
  }
  writeStore(store);
}
