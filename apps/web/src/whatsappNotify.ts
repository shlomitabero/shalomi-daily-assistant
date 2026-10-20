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

/**
 * Messages arrive DESC-ordered (newest first -- same assumption
 * countUnreadWhatsAppMessages makes, see whatsappUnread.ts). Walks from the
 * newest message and collects every inbound one up to (not including)
 * lastNotifiedId, the id of the newest inbound message a desktop
 * notification has already been shown for.
 *
 * Returns null when lastNotifiedId is null: the very first check after a
 * project loads/reconnects has no baseline yet, and treating every message
 * already in the log as "new" would fire a desktop notification for a
 * customer's entire message history the instant the tab loads. Mirrors
 * countUnreadWhatsAppMessages' own `lastSeenId === null -> 0` convention --
 * the caller is expected to silently seed its own baseline (the current
 * newest message id) on that first check instead of notifying.
 *
 * If lastNotifiedId isn't found at all in this page (more new messages
 * arrived between two checks than one page holds), the count is capped at
 * what's visible here, matching this codebase's established "N+"
 * pagination convention rather than guessing a larger exact number.
 */
export function findNewInboundMessages(
  messages: WhatsAppMessageLogEntry[],
  lastNotifiedId: string | null,
): NewWhatsAppMessages | null {
  if (lastNotifiedId === null) return null;
  const newInbound: WhatsAppMessageLogEntry[] = [];
  for (const m of messages) {
    if (m.id === lastNotifiedId) break;
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
