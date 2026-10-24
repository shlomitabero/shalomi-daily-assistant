import type { WhatsAppMessageLogEntry } from "./api.js";

const STORAGE_KEY_PREFIX = "forge.whatsappLastSeenId.";

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

/**
 * The newest WhatsApp message this project's owner has already had loaded
 * in front of her -- both its id AND its own createdAt timestamp (round
 * 939's own addition; see countUnreadWhatsAppMessages' doc comment for
 * why the timestamp matters). null means "never connected/loaded any
 * messages yet", not "everything is unread" (a brand-new connection with
 * no history shouldn't flash a spurious badge). Same per-project
 * localStorage shape as whatsappLogFilter.ts, just a small JSON object
 * instead of a bare string.
 */
export interface WhatsAppLastSeen {
  id: string;
  createdAt: string;
}

export function getWhatsAppLastSeen(projectId: string): WhatsAppLastSeen | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WhatsAppLastSeen>;
    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") return null;
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch {
    // Either localStorage is unavailable (private mode), or this is a
    // pre-round-939 marker still stored as a bare id string, not JSON --
    // both just mean "no safely-usable marker", not a crash. Falling back
    // to null here (rather than the old bare id) is deliberately safe:
    // the owner's very next real panel-open re-seeds a fresh, correct one.
    return null;
  }
}

export function setWhatsAppLastSeen(projectId: string, message: WhatsAppLastSeen): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify({ id: message.id, createdAt: message.createdAt }));
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
 * stops the moment it reaches a point at or before lastSeen: everything
 * strictly after that point is new since the owner last had the log
 * open. Only inbound ("in") messages count -- a message this project
 * itself sent was never "unread" in the first place.
 *
 * Round 940: lastSeen's own `id` can legitimately vanish from this page
 * for two completely different reasons this function used to lump
 * together -- more unread messages arrived than one page holds
 * (genuine overflow -- the tracked message is still out there, just
 * further back than this page reaches), or the owner's own message, or
 * any collaborator's (WhatsApp messages are per-project, not per-user;
 * any owner/editor can delete one via the real DELETE route), actually
 * deleted the exact message this browser's `lastSeen` marker still
 * points to -- which never advances "how far the owner has genuinely
 * read" and can happen from a completely different browser/session than
 * the one whose badge this count feeds, with no live signal of any kind
 * reaching this one. The old id-only walk treated BOTH cases as "count
 * everything in the page", which is right for the first and badly wrong
 * for the second (every already-read message past the deleted one got
 * counted as a phantom unread, inflating the topbar badge and the
 * documentTitle.ts "(N)" prefix for no real reason). Falling back to
 * `createdAt` the moment a message's timestamp is at or before
 * lastSeen's own -- not just on an exact id match -- resolves both
 * cases correctly with one rule: a page that genuinely overflows still
 * never reaches back far enough in time to trip this fallback (every
 * message on it stays strictly newer than lastSeen, so the walk still
 * counts the whole page, same as before); a page missing only the
 * now-deleted tracked message, but still reaching back to or past its
 * timestamp, stops there instead of overcounting everything newer than
 * messages the owner already read.
 */
export function countUnreadWhatsAppMessages(messages: WhatsAppMessageLogEntry[], lastSeen: WhatsAppLastSeen | null): number {
  if (lastSeen === null) return 0;
  const lastSeenTime = new Date(lastSeen.createdAt).getTime();
  let count = 0;
  for (const m of messages) {
    if (m.id === lastSeen.id) break;
    if (!Number.isNaN(lastSeenTime) && new Date(m.createdAt).getTime() <= lastSeenTime) break;
    if (m.direction === "in") count++;
  }
  return count;
}
