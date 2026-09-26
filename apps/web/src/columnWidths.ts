const STORAGE_KEY = "forge.columnWidths";

/** A column can never be dragged narrower than this -- below it, a field's own label and values stop being readable at all. */
export const MIN_COLUMN_WIDTH = 60;
/** A column can never be dragged wider than this -- unbounded dragging could otherwise push a table wide enough to make every other column effectively invisible off-screen. */
export const MAX_COLUMN_WIDTH = 480;

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
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
 * never been resized and keeps the table's normal automatic sizing.
 */
export function getColumnWidths(projectId: string, entityName: string): Record<string, number> {
  const store = readStore();
  return { ...(store[keyFor(projectId, entityName)] ?? {}) };
}

/** Persists one field's own resized width and returns the entity's full updated width map, so callers can update their own state from the return value instead of re-reading storage. */
export function setColumnWidth(projectId: string, entityName: string, fieldName: string, width: number): Record<string, number> {
  const store = readStore();
  const key = keyFor(projectId, entityName);
  const widths = { ...(store[key] ?? {}), [fieldName]: width };
  store[key] = widths;
  writeStore(store);
  return widths;
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
