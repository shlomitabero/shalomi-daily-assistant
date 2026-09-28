const STORAGE_KEY_PREFIX = "forge.whatsappRecentNumbers.";
const MAX_RECENT_NUMBERS = 5;

/**
 * The WhatsApp "Send test message" form's own "To" field had the exact
 * same gap Global Search's query box had before recentSearches.ts (round
 * 180): a real owner verifying their WhatsApp connection typically tests
 * against the same 1-3 numbers (their own phone, a colleague's) over and
 * over, but had to retype the number from scratch every single time. Same
 * shape as recentSearches.ts, just for phone numbers instead of queries,
 * and keyed per-project since two different projects' test numbers have
 * nothing to do with each other.
 */
function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

export function getRecentWhatsAppNumbers(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Adds a number to the front of this project's recent-numbers list --
 * moving it there if it's already present, rather than keeping a
 * duplicate entry -- and caps the list at MAX_RECENT_NUMBERS, mirroring
 * addRecentSearch's own convention exactly.
 */
export function addRecentWhatsAppNumber(projectId: string, phoneNumber: string): string[] {
  const trimmed = phoneNumber.trim();
  if (!trimmed) return getRecentWhatsAppNumbers(projectId);
  const existing = getRecentWhatsAppNumbers(projectId);
  const deduped = existing.filter((n) => n !== trimmed);
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_NUMBERS);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeRecentWhatsAppNumber(projectId: string, phoneNumber: string): string[] {
  const next = getRecentWhatsAppNumbers(projectId).filter((n) => n !== phoneNumber);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearRecentWhatsAppNumbers(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
