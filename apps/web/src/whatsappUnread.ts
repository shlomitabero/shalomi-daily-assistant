import type { WhatsAppMessageLogEntry } from "./api.js";

const STORAGE_KEY_PREFIX = "forge.whatsappLastSeenId.";

function storageKey(projectId: string, userId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}:${userId}`;
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
 *
 * Round 1046: also keyed per-user now, the same gap round 1011 already
 * fixed for this exact feature's own sibling store, whatsappRecentNumbers.ts
 * (missed here at the time): a project is routinely shared between real
 * collaborator accounts (project_collaborators/roles), and this marker
 * drives a real, visible signal -- the topbar's unread badge and the
 * documentTitle.ts "(N)" prefix. Keyed by projectId alone, one
 * collaborator opening the WhatsApp panel and reading the log silently
 * zeroed the OTHER collaborator's own unread badge too, on their own
 * separate browser/session, for messages that collaborator never actually
 * saw -- the opposite of round 940's own documented per-project-not-per-
 * user rationale just above this comment, which is about a tracked
 * message id vanishing from the page (deletion), not about who the
 * marker belongs to.
 */
export interface WhatsAppLastSeen {
  id: string;
  createdAt: string;
}

export function getWhatsAppLastSeen(projectId: string, userId: string): WhatsAppLastSeen | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId, userId));
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

export function setWhatsAppLastSeen(projectId: string, userId: string, message: WhatsAppLastSeen): void {
  try {
    localStorage.setItem(storageKey(projectId, userId), JSON.stringify({ id: message.id, createdAt: message.createdAt }));
  } catch {
    // localStorage can be unavailable (private mode) -- the marker just won't survive a reload.
  }
}

/** Same purge-on-project-delete pattern as whatsappLogFilter.ts's clearWhatsAppLogFilter -- see projectPreferenceCleanup.ts for why this exists. */
export function clearWhatsAppLastSeenId(projectId: string, userId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId, userId));
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

/**
 * Removes EVERY collaborator account's own last-seen marker for this
 * project -- see whatsappRecentNumbers.ts's own purgeRecentWhatsAppNumbersForProject
 * for the full reasoning. Used by projectPreferenceCleanup.ts when the
 * project itself is deleted, replacing the old single-user
 * clearWhatsAppLastSeenId call that only ever reached the current user's
 * own entry, not any past collaborator's.
 */
export function purgeWhatsAppLastSeenForProject(projectId: string): void {
  const prefix = `${STORAGE_KEY_PREFIX}${projectId}:`;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
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
