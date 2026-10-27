const STORAGE_KEY = "forge.columnWidths";

/** A column can never be dragged narrower than this -- below it, a field's own label and values stop being readable at all. */
export const MIN_COLUMN_WIDTH = 60;
/** A column can never be dragged wider than this -- unbounded dragging could otherwise push a table wide enough to make every other column effectively invisible off-screen. */
export const MAX_COLUMN_WIDTH = 480;

/**
 * Round 1068: the userId segment was added so two different collaborator
 * accounts sharing the same project on the same browser no longer see each
 * other's own drag-resized column widths -- the same cross-account leak
 * class already closed for the other sibling stores on this exact screen
 * (fieldFiltersPreference.ts round 1054, columnVisibility.ts round 1055,
 * viewModePreference.ts round 1064), never ported here. See
 * fieldFiltersPreference.ts's own keyFor doc comment for the full
 * reasoning. purgeColumnWidthsForProject/purgeColumnWidthsForEntity below
 * still match by prefix, which keeps working unchanged regardless of what
 * the key's own remaining segments (entityName, userId) look like.
 */
function keyFor(projectId: string, entityName: string, userId: string): string {
  return `${projectId}:${entityName}:${userId}`;
}

function readStore(): Record<string, Record<string, number>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, Record<string, number>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const widths: Record<string, number> = {};
      for (const [field, width] of Object.entries(value as Record<string, unknown>)) {
        if (typeof width === "number" && Number.isFinite(width)) widths[field] = width;
      }
      store[key] = widths;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, Record<string, number>>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * Which of an entity's own fields have a real, drag-resized width -- scoped
 * per project+entity, mirroring columnVisibility.ts's own keying (so
 * resizing a wide entity's columns in one project never affects another
 * project's same-named entity). A field absent from the returned record has
 * never been resized and keeps the table's normal automatic sizing. Round
 * 1068: also scoped per user -- see keyFor's own doc comment above.
 */
export function getColumnWidths(projectId: string, entityName: string, userId: string): Record<string, number> {
  const store = readStore();
  return { ...(store[keyFor(projectId, entityName, userId)] ?? {}) };
}

/** Persists one field's own resized width and returns the entity's full updated width map, so callers can update their own state from the return value instead of re-reading storage. */
export function setColumnWidth(
  projectId: string,
  entityName: string,
  userId: string,
  fieldName: string,
  width: number,
): Record<string, number> {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const widths = { ...(store[key] ?? {}), [fieldName]: width };
  store[key] = widths;
  writeStore(store);
  return widths;
}

/**
 * Drops every manually-resized width for this entity for the current user,
 * returning the table to its normal automatic sizing -- previously the
 * only way back to default widths after a drag was resizing each column
 * back by hand, one drag at a time, unlike fieldFilters' own one-click
 * "Clear all filters" (round 341).
 */
export function clearColumnWidths(projectId: string, entityName: string, userId: string): Record<string, number> {
  const store = readStore();
  delete store[keyFor(projectId, entityName, userId)];
  writeStore(store);
  return {};
}

/**
 * Round 1029: a refine/restore can rename an entity by letter casing
 * alone (e.g. "customer" -> "Customer", round 988's own established
 * "genuine no-op" case) -- round 988 correctly stopped treating this as
 * a drop (so purgeColumnWidthsForProject/purgeColumnWidthsForEntity never
 * ran against it), but nothing filled the resulting gap: every getter
 * above is keyed by the entity's CURRENT name, which no longer matches
 * this store's own key, so the real widths sat unreachable under the old
 * casing forever. Renames the key in place (persists under the new
 * casing, removes the old one) rather than just reading through, the
 * same way the field-level case-rename fixes (EntityPanel.tsx round
 * 985) persist their remap rather than re-discovering it on every load.
 * A no-op when there's nothing to migrate, or the new key already has
 * its own data (never overwrites a genuinely-distinct entry). Round 1068:
 * rewrites EVERY collaborator's own entry for this entity, the same way
 * columnVisibility.ts's own migrateHiddenFieldsForEntityRename does,
 * since the key's own userId segment isn't known in advance.
 */
export function migrateColumnWidthsForEntityRename(projectId: string, oldName: string, newName: string): void {
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

/** Removes every stored width for this project, across all of its entities, regardless of entity name -- unlike purgeColumnWidthsForEntity below, which needs one specific entity. Used when the whole project is deleted (projectPreferenceCleanup.ts): nothing else ever clears this store, so without this a deleted project's entries sit here forever. */
export function purgeColumnWidthsForProject(projectId: string): void {
  const store = readStore();
  const prefix = `${projectId}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * Removes just one entity's stored widths, across every collaborator
 * account (the key's third segment is userId, not something this
 * function can know in advance -- the same reason
 * columnVisibility.ts's own purgeHiddenFieldsForEntity sweeps by prefix
 * rather than a single exact key), unlike purgeColumnWidthsForProject
 * above (the whole project). Used when a single entity is dropped from an
 * otherwise-surviving project's spec -- see entityPreferenceCleanup.ts for
 * why this exists alongside the project-wide purge. Round 1068: replaces
 * the old single-user clearColumnWidths call entityPreferenceCleanup.ts
 * used to make here, which only ever cleared whichever one user happened
 * to be signed in when the drop ran, leaving every other collaborator's
 * own stale widths for the now-gone entity behind.
 */
export function purgeColumnWidthsForEntity(projectId: string, entityName: string): void {
  const store = readStore();
  const prefix = `${projectId}:${entityName}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(store);
}

/**
 * The actual drag math behind dragging a column's resize handle: how far the
 * mouse has moved since the drag started, added to the column's width at
 * that moment, clamped to a sane range. In a right-to-left layout (Hebrew),
 * a column's "far" edge is on its visual LEFT rather than its right, so the
 * same rightward mouse movement that widens a column in LTR must narrow it
 * in RTL instead -- flipping the sign of deltaX is what makes dragging feel
 * natural (the handle still visually follows the cursor) in both directions.
 */
export function computeResizedWidth(startWidth: number, deltaX: number, dir: "ltr" | "rtl" = "ltr"): number {
  const signedDelta = dir === "rtl" ? -deltaX : deltaX;
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + signedDelta));
}
