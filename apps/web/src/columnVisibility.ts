const STORAGE_KEY = "forge.hiddenColumns";

function keyFor(projectId: string, entityName: string): string {
  return `${projectId}:${entityName}`;
}

function readStore(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) store[key] = value.filter((v): v is string => typeof v === "string");
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

/** Which of an entity's own fields are currently hidden from its table view, scoped per project+entity so hiding a wide entity's columns in one project never affects another project's same-named entity. */
export function getHiddenFields(projectId: string, entityName: string): Set<string> {
  const store = readStore();
  return new Set(store[keyFor(projectId, entityName)] ?? []);
}

/** Toggles one field's hidden state and returns the new full set, so callers can update their own state from the return value instead of re-reading storage. */
export function toggleFieldVisibility(projectId: string, entityName: string, fieldName: string): Set<string> {
  const store = readStore();
  const key = keyFor(projectId, entityName);
  const hidden = new Set(store[key] ?? []);
  if (hidden.has(fieldName)) hidden.delete(fieldName);
  else hidden.add(fieldName);
  store[key] = [...hidden];
  writeStore(store);
  return hidden;
}
