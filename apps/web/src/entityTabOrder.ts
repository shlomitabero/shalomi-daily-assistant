const STORAGE_KEY_PREFIX = "forge.entityTabOrder.";

/**
 * Round 1067: moved from one single flat key to one key per signed-in
 * user, mirroring pinnedProjects.ts's own identical round-1003 fix --
 * this store's own shape (a single `Record<projectId, string[]>` blob,
 * not a `${projectId}:${entityName}` compound key) matches pinnedProjects
 * exactly, not the "add a userId segment to a compound key" shape most of
 * this store's siblings used. A project is routinely shared between real
 * collaborator accounts (project_collaborators/roles) on the same
 * browser, and this one array was the single remaining per-entity-
 * preference-screen store entityPreferenceCleanup.ts's own comments never
 * revisited for this dimension -- every other sibling sharing that screen
 * (columnWidths/columnOrder/columnVisibility/fieldFilters/groupBy/
 * sortKeys/collapsedGroups/collapsedBoardColumns/viewMode) either already
 * has it or is separately tracked as still open; this one had none at
 * all. A project reordered before this round has no per-user
 * entry yet (the old flat key is simply abandoned, the same additive-
 * only convention every other localStorage migration in this app already
 * uses): every user's own tab order from before this round is silently
 * lost once, the same one-time, harmless reset round 1003's own
 * migration already accepted for its own shape change.
 */
function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function readStore(userId: string): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
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

function writeStore(userId: string, store: Record<string, string[]>): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(store));
  } catch {
    // localStorage can be unavailable (private mode) -- the choice just won't survive a reload.
  }
}

/**
 * The persisted entity-tab order for one project's live-preview nav --
 * scoped per project only, unlike columnOrder.ts's own per-project+entity
 * keying, since this is the order of the tabs themselves rather than one
 * entity's own table columns. Empty when the tabs have never been
 * reordered, in which case callers fall back to the project's own natural
 * entity order (the same "empty order = natural order" convention
 * columnOrder.ts already established).
 *
 * The actual reorder math is deliberately not reimplemented here:
 * `applyColumnOrder`/`reorderColumns` (columnOrder.ts) are already generic
 * over any `{ name: string }[]`, and `Entity` has a `name` field just like
 * a table's fields do, so this file only owns the storage half.
 *
 * Round 1067: also scoped per user -- see storageKey's own doc comment.
 */
export function getEntityTabOrder(projectId: string, userId: string): string[] {
  const store = readStore(userId);
  return [...(store[projectId] ?? [])];
}

/** Persists a full entity-name order and returns it, so callers can update their own state from the return value instead of re-reading storage. */
export function setEntityTabOrder(projectId: string, userId: string, order: string[]): string[] {
  const store = readStore(userId);
  store[projectId] = order;
  writeStore(userId, store);
  return order;
}

/**
 * Removes every collaborator account's own tab order for one project --
 * used by projectPreferenceCleanup.ts when the project itself is deleted,
 * mirroring pinnedProjects.ts's own purgePinnedProjectForProject: there's
 * no single "current user" to scope a plain per-user delete to, since any
 * number of other collaborators could have reordered this now-gone
 * project's tabs in this same browser's localStorage, each under their
 * own per-user key.
 */
export function purgeEntityTabOrderForProject(projectId: string): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
      const userId = key.slice(STORAGE_KEY_PREFIX.length);
      const store = readStore(userId);
      if (!(projectId in store)) continue;
      delete store[projectId];
      writeStore(userId, store);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Removes one entity name from a project's persisted tab order, across
 * every collaborator account (same "no single current user at purge
 * time" reasoning as purgeEntityTabOrderForProject above), called by
 * entityPreferenceCleanup.ts's purgeEntityPreferences when a refine drops
 * that entity. Unlike every sibling store there (keyed per `${projectId}:${entityName}`,
 * so a whole-entry delete suffices), this store is keyed by projectId alone
 * with the entity names living inside the array value -- so the dropped
 * name has to be filtered out of that array instead. Without this, a later
 * refine that reintroduces an entity with the SAME name would have its tab
 * silently snap back into whatever position the old, unrelated entity
 * occupied, instead of landing at the natural end like a genuinely new
 * entity does via applyColumnOrder's own "ignore unknown names" fallback.
 * A no-op (not an error) when a given user never reordered the project, or
 * the name isn't present in their own order.
 */
export function purgeEntityNameFromTabOrder(projectId: string, entityName: string): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
      const userId = key.slice(STORAGE_KEY_PREFIX.length);
      const store = readStore(userId);
      const order = store[projectId];
      if (!order) continue;
      store[projectId] = order.filter((name) => name !== entityName);
      writeStore(userId, store);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
