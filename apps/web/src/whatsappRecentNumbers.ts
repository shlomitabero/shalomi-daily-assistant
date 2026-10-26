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
 *
 * Round 1011: also keyed per-user -- this store sat right next to
 * whatsappLogRecentSearches.ts (the message-log search box, in the same
 * file/component) and was missed when round 994 added the userId
 * dimension to that store and three siblings: a project is routinely
 * shared between real collaborator accounts (project_collaborators/
 * roles), and these chips render real, literally-typed phone numbers --
 * a second collaborator signing into the same project on the same
 * browser saw the first collaborator's own previously-tested numbers
 * (a real customer's or colleague's phone number) as clickable autofill
 * chips. See recentSearches.ts's own doc comment for the full reasoning
 * on why a project id alone isn't enough once a project is shared.
 */
function storageKey(projectId: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:${userId}`;
}

export function getRecentWhatsAppNumbers(projectId: string, userId: string): string[] {
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
 * Adds a number to the front of this project's recent-numbers list --
 * moving it there if it's already present, rather than keeping a
 * duplicate entry -- and caps the list at MAX_RECENT_NUMBERS, mirroring
 * addRecentSearch's own convention exactly.
 */
export function addRecentWhatsAppNumber(projectId: string, userId: string, phoneNumber: string): string[] {
  const trimmed = phoneNumber.trim();
  if (!trimmed) return getRecentWhatsAppNumbers(projectId, userId);
  const existing = getRecentWhatsAppNumbers(projectId, userId);
  const deduped = existing.filter((n) => n !== trimmed);
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT_NUMBERS);
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- the history just won't survive a reload.
  }
  return next;
}

export function removeRecentWhatsAppNumber(projectId: string, userId: string, phoneNumber: string): string[] {
  const next = getRecentWhatsAppNumbers(projectId, userId).filter((n) => n !== phoneNumber);
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to persist.
  }
  return next;
}

export function clearRecentWhatsAppNumbers(projectId: string, userId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId, userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Removes EVERY collaborator account's own recent-numbers list for this
 * project -- see recentSearches.ts's own purgeRecentSearchesForProject
 * for the full reasoning. Used by projectPreferenceCleanup.ts when the
 * project itself is deleted, replacing the old single-user
 * clearRecentWhatsAppNumbers call that only ever reached the current
 * user's own entry, not any past collaborator's.
 */
export function purgeRecentWhatsAppNumbersForProject(projectId: string): void {
  const prefix = `${STORAGE_KEY_PREFIX}${projectId}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}
