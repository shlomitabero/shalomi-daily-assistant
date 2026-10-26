import type { WhatsAppMessageLogEntry } from "./api.js";

export interface NewWhatsAppMessages {
  newestMessageId: string;
  count: number;
  fromNumber: string;
  // Round 750: carried through alongside fromNumber (not instead of it,
  // since a real caller still needs the raw number as the no-match
  // fallback) so App.tsx's desktop notification can show the same
  // "matchedLabel ?? fromNumber" human label whatsappLog.ts/
  // WhatsAppPanel.tsx already show everywhere else this exact message
  // appears -- without this, the one surface specifically meant to alert
  // someone while they're away from the tab was the only place still
  // showing a bare, unrecognizable phone number instead of "Sarah Cohen".
  matchedLabel: string | null;
  snippet: string;
}

/** The newest inbound message a desktop notification has already been shown for -- both its id AND its own createdAt timestamp, the same shape whatsappUnread.ts's own WhatsAppLastSeen uses, for the identical reason (see this function's own doc comment below). */
export interface LastNotifiedWhatsAppMessage {
  id: string;
  createdAt: string;
}

/**
 * Messages arrive DESC-ordered (newest first -- same assumption
 * countUnreadWhatsAppMessages makes, see whatsappUnread.ts). Walks from the
 * newest message and collects every inbound one up to (not including)
 * lastNotified, the newest inbound message a desktop notification has
 * already been shown for.
 *
 * Returns null when lastNotified is null: the very first check after a
 * project loads/reconnects has no baseline yet, and treating every message
 * already in the log as "new" would fire a desktop notification for a
 * customer's entire message history the instant the tab loads. Mirrors
 * countUnreadWhatsAppMessages' own `lastSeenId === null -> 0` convention --
 * the caller is expected to silently seed its own baseline (the current
 * newest message) on that first check instead of notifying.
 *
 * If lastNotified's own id isn't found at all in this page (more new
 * messages arrived between two checks than one page holds), the count is
 * capped at what's visible here, matching this codebase's established
 * "N+" pagination convention rather than guessing a larger exact number
 * -- UNLESS this page's own oldest message is already at or older than
 * lastNotified's own timestamp, which means the id is genuinely missing
 * because that exact message was deleted (by this tab's own
 * WhatsAppPanel, a different tab/device on the same account, or any
 * collaborator -- these messages are project-scoped, not per-user),
 * rather than simply paged out. The old id-only walk treated both cases
 * as "collect the whole page", which silently re-announced every already
 * -read message past the deleted one as brand new the next time the tab
 * was backgrounded -- a real, surprising desktop notification showing
 * stale content, not just internal state every reader already handled
 * gracefully. Mirrors countUnreadWhatsAppMessages' own identical
 * round-940 fix, falling back to createdAt the moment a message's own
 * timestamp is at or before lastNotified's, not just on an exact id
 * match.
 */
export function findNewInboundMessages(
  messages: WhatsAppMessageLogEntry[],
  lastNotified: LastNotifiedWhatsAppMessage | null,
): NewWhatsAppMessages | null {
  if (lastNotified === null) return null;
  const lastNotifiedTime = new Date(lastNotified.createdAt).getTime();
  const newInbound: WhatsAppMessageLogEntry[] = [];
  for (const m of messages) {
    if (m.id === lastNotified.id) break;
    if (!Number.isNaN(lastNotifiedTime) && new Date(m.createdAt).getTime() <= lastNotifiedTime) break;
    if (m.direction === "in") newInbound.push(m);
  }
  if (newInbound.length === 0) return null;
  const newest = newInbound[0];
  return {
    newestMessageId: newest.id,
    count: newInbound.length,
    fromNumber: newest.fromNumber,
    matchedLabel: newest.matchedLabel,
    snippet: newest.body,
  };
}
