const STORAGE_KEY = "forge.collapsedBoardColumns";

function keyFor(projectId: string, entityName: string, boardFieldName: string): string {
  return `${projectId}:${entityName}:${boardFieldName}`;
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
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}
