const STORAGE_KEY_PREFIX = "forge.recentSearches.";
const MAX_RECENT_SEARCHES = 5;

/**
 * Global Search's own query was the one piece of "what you were just
 * looking for" state in this app that vanished the instant the panel
 * closed -- pinned projects, column visibility, and the home screen's
 * idea draft all survive a reload/reopen (see pinnedProjects.ts/
 * columnVisibility.ts/ideaDraft.ts's own localStorage usage), but reopening
 * this same panel a minute later meant retyping the exact same thing from
 * scratch. Keyed per-project (not globally) since two different projects'
 * entities/data have nothing to do with each other -- a recent search on
 * one project's Customer table is meaningless noise on another project
 * that has no such entity at all.
 *
 * Round 994: also keyed per-user, not just per-project. This project id
 * alone used to be the whole key -- but a project is routinely shared
 * between several real collaborator accounts (project_collaborators/
 * roles), and this app never reloads the page on logout/login (see
 * App.tsx's handleLogout/handleAccountDeleted/subscribeAuthExpired, round
 * 993's own identical fix for the UNSCOPED stores). Without the user's own
 * id in the key, a second collaborator logging into the SAME shared
 * project on the SAME browser (a shared office computer, say) saw the
 * FIRST collaborator's own literal typed search text -- a name, a dispute,
 * anything sensitive -- sitting in their own "recent searches" dropdown,
 * despite being a completely different account's own session. Round 993's
 * own fix doesn't reach this: App.tsx's three reset points clear state that
 * leaks across ANY two accounts regardless of project, but these stores
 * were already project-scoped, so there's no single key for a blanket
 * reset to clear -- the actual fix has to be in the key itself.
 */
function storageKey(projectId: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:${userId}`;
}

export function getRecentSearches(projectId: string, userId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Adds a query to the front of this project's recent-search list -- moving
 * it there (case-insensitively) if it's already present, rather than
 * keeping a duplicate entry -- and caps the list at MAX_RECENT_SEARCHES so
 * it stays a short, genuinely "recent" list rather than growing forever.
 * Returns the new list so callers can update their own state from the
 * return value instead of re-reading storage, the same convention
 * pinnedProjects.ts's togglePinned uses.
 */
export function addRecentSearch(projectId: string, userId: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentSearches(projectId, userId);
  const existing = getRecentSearches(projectId, userId);
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

/**
 * Removes a single query from this project's recent-search list -- the
 * only way to trim it down was previously "Clear" (wiping the whole
 * list), the same gap the WhatsApp log (round 208), Time Machine (round
 * 216) and refine-history (round 228) lists each had before their own
 * single-item delete. Case-insensitive match, mirroring addRecentSearch's
 * own dedup comparison.
 */
export function removeRecentSearch(projectId: string, userId: string, query: string): string[] {
  const next = getRecentSearches(projectId, userId).filter((q) => q.toLowerCase() !== query.toLowerCase());
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearRecentSearches(projectId: string, userId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId, userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Removes EVERY collaborator account's own recent-search list for this
 * project, not just the current one's -- used by projectPreferenceCleanup.ts
 * when the project itself is deleted, where there's no single "current
 * user" to scope a plain clearRecentSearches(projectId, userId) call to:
 * any number of other accounts could have their own entries for this now-
 * gone project sitting in this same browser's localStorage. Unlike
 * entityRecentSearches.ts's own purgeEntityRecentSearchesForProject (a
 * single flat object the whole store already lives in, so purging is just
 * an in-memory filter), this store keeps one real localStorage key per
 * project+user -- so purging every user's entry means enumerating
 * localStorage itself for every key under this project's own prefix.
 */
export function purgeRecentSearchesForProject(projectId: string): void {
  const prefix = `${STORAGE_KEY_PREFIX}${projectId}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
