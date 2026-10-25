const STORAGE_KEY_PREFIX = "forge.whatsappLogRecentSearches.";
const MAX_RECENT_SEARCHES = 5;

function storageKey(projectId: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:${userId}`;
}

/**
 * The WhatsApp panel's own message-log search box (shown once a project
 * has more than 5 messages) was the last live-filter-as-you-type search
 * box in the app with zero memory of past queries -- Global Search
 * (recentSearches.ts, round 180), Time Machine (historyRecentSearches.ts),
 * the home screen's project search (recentProjectSearches.ts, round 316),
 * and the per-entity table search (entityRecentSearches.ts, round 318)
 * all already remember recent queries the same way. Keyed per-project
 * (not per-entity) since there's only one message log per project, the
 * same scoping recentSearches.ts/recentProjectSearches.ts already use for
 * their own single-list-per-project shape. Distinct from
 * whatsappRecentNumbers.ts, which remembers phone numbers typed into the
 * separate "send test message" field, not log search queries.
 *
 * Round 994: also keyed per-user -- see recentSearches.ts's own doc
 * comment for why a project id alone isn't enough once the project is
 * shared between several real collaborator accounts on the same browser.
 */
export function getWhatsAppLogRecentSearches(projectId: string, userId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function addWhatsAppLogRecentSearch(projectId: string, userId: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getWhatsAppLogRecentSearches(projectId, userId);
  const existing = getWhatsAppLogRecentSearches(projectId, userId);
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeWhatsAppLogRecentSearch(projectId: string, userId: string, query: string): string[] {
  const next = getWhatsAppLogRecentSearches(projectId, userId).filter((q) => q.toLowerCase() !== query.toLowerCase());
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearWhatsAppLogRecentSearches(projectId: string, userId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId, userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Removes EVERY collaborator account's own log-search list for this
 * project -- see recentSearches.ts's own purgeRecentSearchesForProject
 * for the full reasoning. Used by projectPreferenceCleanup.ts when the
 * project itself is deleted.
 */
export function purgeWhatsAppLogRecentSearchesForProject(projectId: string): void {
  const prefix = `${STORAGE_KEY_PREFIX}${projectId}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
