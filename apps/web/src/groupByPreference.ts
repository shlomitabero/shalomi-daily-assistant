const STORAGE_KEY = "forge.groupByField";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
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
export function getGroupByField(projectId: string, entityName: string): string {
  const store = readStore();
  return store[keyFor(projectId, entityName)] ?? "";
}

/** Persists a group-by field choice (or "" to clear it) and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setGroupByField(projectId: string, entityName: string, fieldName: string): string {
  const store = readStore();
  if (fieldName) store[keyFor(projectId, entityName)] = fieldName;
  else delete store[keyFor(projectId, entityName)];
  writeStore(store);
  return fieldName;
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
export function getGroupByFieldType(projectId: string, entityName: string): string {
  const store = readTypeStore();
  return store[keyFor(projectId, entityName)] ?? "";
}

/** Persists the field type alongside a group-by choice (call together with setGroupByField), or clears it when type is "". */
export function setGroupByFieldType(projectId: string, entityName: string, type: string): void {
  const store = readTypeStore();
  if (type) store[keyFor(projectId, entityName)] = type;
  else delete store[keyFor(projectId, entityName)];
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
