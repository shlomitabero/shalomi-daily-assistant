import type { WhatsAppMessageLogEntry } from "./api.js";

const STORAGE_KEY_PREFIX = "forge.whatsappLastSeenId.";

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

/**
 * The id of the newest WhatsApp message this project's owner has already
 * had loaded in front of her -- null means "never connected/loaded any
 * messages yet", not "everything is unread" (a brand-new connection with
 * no history shouldn't flash a spurious badge). Same per-project
 * localStorage shape as whatsappLogFilter.ts.
 */
export function getWhatsAppLastSeenId(projectId: string): string | null {
  try {
    return localStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

export function setWhatsAppLastSeenId(projectId: string, messageId: string): void {
  try {
    localStorage.setItem(storageKey(projectId), messageId);
  } catch {
    // localStorage can be unavailable (private mode) -- the marker just won't survive a reload.
  }
}

/** Same purge-on-project-delete pattern as whatsappLogFilter.ts's clearWhatsAppLogFilter -- see projectPreferenceCleanup.ts for why this exists. */
export function clearWhatsAppLastSeenId(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Messages arrive DESC-ordered (newest first -- see WhatsAppPanel's own
 * handleLoadMore doc comment), so this walks from the newest message and
 * stops the moment it reaches lastSeenId: everything before that point is
 * new since the owner last had the log open. Only inbound ("in") messages
 * count -- a message this project itself sent was never "unread" in the
 * first place. If lastSeenId isn't found at all in this page (more unread
 * messages arrived than one page holds), the count is capped at what's
 * visible here rather than guessing a larger exact number, matching this
 * codebase's established "N+" pagination convention elsewhere.
 */
export function countUnreadWhatsAppMessages(messages: WhatsAppMessageLogEntry[], lastSeenId: string | null): number {
  if (lastSeenId === null) return 0;
  let count = 0;
  for (const m of messages) {
    if (m.id === lastSeenId) break;
    if (m.direction === "in") count++;
  }
  return count;
}
