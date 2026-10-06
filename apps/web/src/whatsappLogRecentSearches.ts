const STORAGE_KEY_PREFIX = "forge.whatsappLogRecentSearches.";
const MAX_RECENT_SEARCHES = 5;

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
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
 */
export function getWhatsAppLogRecentSearches(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function addWhatsAppLogRecentSearch(projectId: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getWhatsAppLogRecentSearches(projectId);
  const existing = getWhatsAppLogRecentSearches(projectId);
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeWhatsAppLogRecentSearch(projectId: string, query: string): string[] {
  const next = getWhatsAppLogRecentSearches(projectId).filter((q) => q.toLowerCase() !== query.toLowerCase());
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearWhatsAppLogRecentSearches(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
