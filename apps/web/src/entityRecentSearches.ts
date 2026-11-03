const STORAGE_KEY = "forge.entityRecentSearches";
const MAX_RECENT_SEARCHES = 5;

/**
 * Round 994: the userId segment was added so two different collaborator
 * accounts sharing the same project on the same browser no longer see
 * each other's typed table-search text -- see recentSearches.ts's own
 * doc comment for the full reasoning. purgeEntityRecentSearchesForProject
 * below still matches on a plain `${projectId}:` prefix, which keeps
 * working unchanged regardless of what the key's own remaining segments
 * (entityName, userId) look like.
 *
 * Round 1579: JSON-encoded rather than colon-joined -- see columnWidths.ts's
 * own keyFor doc comment for the full "Foo"/"Foo:Bar" collision reasoning,
 * ported here identically.
 */
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
 * Round 994: also scoped per user -- see keyFor's own doc comment above.
 *
 * Round 1549: a case-only entity rename (an ordinary, explicitly-anticipated
 * refine/AI casing drift) only ever gets this store's keys rewritten by
 * migrateEntityRecentSearchesForEntityRename below, which -- exactly like
 * columnOrder.ts's/columnWidths.ts's/columnVisibility.ts's/
 * fieldFiltersPreference.ts's/groupByPreference.ts's/sortKeysPreference.ts's
 * own migrate functions before rounds 1542-1548 -- is called only from the
 * single browser tab that happened to trigger the rename. Every OTHER
 * collaborator's own localStorage keeps their recent-search history under
 * the entity's OLD casing forever -- the exact-match lookup above would
 * miss it with zero error or indication, silently reverting that
 * collaborator's table-search dropdown to empty. Falls back to a
 * case-insensitive scan of this exact project+user's own keys, the same
 * resolution rounds 1542-1548 applied to this bug family's other instances.
 */
export function getEntityRecentSearches(projectId: string, entityName: string, userId: string): string[] {
  const store = readStore();
  const exact = store[keyFor(projectId, entityName, userId)];
  if (exact !== undefined) return [...exact];
  const lowerEntityName = entityName.toLowerCase();
  for (const [key, value] of Object.entries(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, keyUserId] = parsed;
    if (keyProjectId === projectId && keyUserId === userId && keyEntityName.toLowerCase() === lowerEntityName) return [...value];
  }
  return [];
}

/**
 * Adds a query to the front of this project+entity's recent-search list --
 * moving it there (case-insensitively) if it's already present, rather than
 * keeping a duplicate entry -- and caps the list at MAX_RECENT_SEARCHES,
 * mirroring addRecentSearch's/addRecentProjectSearch's own convention.
 */
export function addEntityRecentSearch(projectId: string, entityName: string, userId: string, query: string): string[] {
  const trimmed = query.trim();
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  if (!trimmed) return [...(store[key] ?? [])];
  const existing = store[key] ?? [];
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  store[key] = next;
  writeStore(store);
  return next;
}

export function removeEntityRecentSearch(projectId: string, entityName: string, userId: string, query: string): string[] {
  const store = readStore();
  const key = keyFor(projectId, entityName, userId);
  const next = (store[key] ?? []).filter((q) => q.toLowerCase() !== query.toLowerCase());
  store[key] = next;
  writeStore(store);
  return next;
}

export function clearEntityRecentSearches(projectId: string, entityName: string, userId: string): void {
  const store = readStore();
  delete store[keyFor(projectId, entityName, userId)];
  writeStore(store);
}

/**
 * Removes EVERY collaborator account's own recent-search list for this
 * one project+entity, not just the current user's -- used by
 * entityPreferenceCleanup.ts when the entity itself is dropped from the
 * spec, where (like purgeEntityRecentSearchesForProject below) there's no
 * single "current user" to scope a plain clearEntityRecentSearches call
 * to: any other collaborator could have their own entries for this now-
 * gone entity sitting in this same store.
 */
export function purgeEntityRecentSearchesForEntity(projectId: string, entityName: string): void {
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
 * EVERY collaborator's own entry for this entity (the key's third segment
 * is userId, not something this function can know in advance -- the same
 * reason purgeEntityRecentSearchesForEntity above sweeps by prefix rather
 * than a single exact key).
 */
export function migrateEntityRecentSearchesForEntityRename(projectId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const [keyProjectId, keyEntityName, userId] = parsed;
    if (keyProjectId !== projectId || keyEntityName !== oldName) continue;
    const newKey = keyFor(projectId, newName, userId);
    if (store[newKey] === undefined) {
      store[newKey] = store[key];
      changed = true;
    }
    delete store[key];
    changed = true;
  }
  if (changed) writeStore(store);
}

/**
 * Round 1128: removes just ONE user's own recent-search lists for this
 * project, across all of its entities -- mirroring entityTabOrder.ts's own
 * round-1127 removeEntityTabOrder, for the same "this one user's own
 * access ended, the project itself is still alive for everyone else"
 * events (account deletion's shared-project loop; CollaboratorsPanel's
 * self-service "leave project") that projectPreferenceCleanup.ts's
 * purgeOwnProjectAccess already handles for every other per-user store.
 * The entityName segment is unknowable in advance (this user could have
 * searched any number of this project's entities), so -- like
 * purgeEntityRecentSearchesForEntity/migrateEntityRecentSearchesForEntityRename
 * above, which face the identical "can't build one exact key" problem for
 * their own missing middle/last segment -- this matches on BOTH the
 * `${projectId}:` prefix AND the `:${userId}` suffix, not a single exact
 * key, so a key only qualifies when every other collaborator's own
 * entityName*userId combination is ruled out by one or the other test.
 */
export function removeEntityRecentSearchesForUserProject(projectId: string, userId: string): void {
  const store = readStore();
  let changed = false;
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId && parsed[2] === userId) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** Removes every stored recent-search list for this project, across all of its entities -- see columnWidths.ts's purgeColumnWidthsForProject for the full rationale. */
export function purgeEntityRecentSearchesForProject(projectId: string): void {
  const store = readStore();
  for (const key of Object.keys(store)) {
    const parsed = parseKey(key);
    if (parsed && parsed[0] === projectId) delete store[key];
  }
  writeStore(store);
}
