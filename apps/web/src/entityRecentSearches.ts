const STORAGE_KEY = "forge.entityRecentSearches";
const MAX_RECENT_SEARCHES = 5;

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
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
}

/**
 * The per-entity table's own filter-as-you-type search box was the one
 * search box left in the app with zero memory -- Global Search
 * (recentSearches.ts), Time Machine (historyRecentSearches.ts), the
 * WhatsApp test-number field (whatsappRecentNumbers.ts), and the home
 * screen's own project search (recentProjectSearches.ts, round 316) all
 * already remember recent queries the same way. Scoped per project+entity,
 * mirroring columnOrder.ts/columnWidths.ts's own keying, since a recent
 * search on one project's Invoices table is meaningless noise on another
 * project's Invoices table, or on the same project's different entity.
 */
export function getEntityRecentSearches(projectId: string, entityName: string): string[] {
  return [...(readStore()[keyFor(projectId, entityName)] ?? [])];
}

/**
 * Adds a query to the front of this project+entity's recent-search list --
 * moving it there (case-insensitively) if it's already present, rather than
 * keeping a duplicate entry -- and caps the list at MAX_RECENT_SEARCHES,
 * mirroring addRecentSearch's/addRecentProjectSearch's own convention.
 */
export function addEntityRecentSearch(projectId: string, entityName: string, query: string): string[] {
  const trimmed = query.trim();
  const store = readStore();
  const key = keyFor(projectId, entityName);
  if (!trimmed) return [...(store[key] ?? [])];
  const existing = store[key] ?? [];
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  store[key] = next;
  writeStore(store);
  return next;
}

export function removeEntityRecentSearch(projectId: string, entityName: string, query: string): string[] {
  const store = readStore();
  const key = keyFor(projectId, entityName);
  const next = (store[key] ?? []).filter((q) => q.toLowerCase() !== query.toLowerCase());
  store[key] = next;
  writeStore(store);
  return next;
}

export function clearEntityRecentSearches(projectId: string, entityName: string): void {
  const store = readStore();
  delete store[keyFor(projectId, entityName)];
  writeStore(store);
}
