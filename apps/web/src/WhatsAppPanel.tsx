import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity } from "@forge/shared";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import {
  clearWhatsAppMessages,
  connectWhatsApp,
  deleteWhatsAppAttachment,
  deleteWhatsAppMessage,
  disconnectWhatsApp,
  getWhatsAppStatus,
  listWhatsAppMessages,
  sendWhatsAppMessage,
  uploadWhatsAppAttachment,
  type WhatsAppAttachmentDescriptor,
  type WhatsAppMessageLogEntry,
  type WhatsAppStatusView,
} from "./api.js";
import { findSinglePhoneFieldTarget, splitHighlightSegments, splitLinkSegments } from "./entityFormatting.js";
import {
  downloadWhatsAppLog,
  filterWhatsAppMessages,
  filterWhatsAppMessagesByDirection,
  formatWhatsAppLog,
  formatWhatsAppMessageCount,
  type WhatsAppLogFilter,
} from "./whatsappLog.js";
import {
  addRecentWhatsAppNumber,
  clearRecentWhatsAppNumbers,
  getRecentWhatsAppNumbers,
  removeRecentWhatsAppNumber,
} from "./whatsappRecentNumbers.js";
import { getWhatsAppLogFilter, setWhatsAppLogFilter as persistWhatsAppLogFilter } from "./whatsappLogFilter.js";
import {
  addWhatsAppLogRecentSearch,
  clearWhatsAppLogRecentSearches,
  getWhatsAppLogRecentSearches,
  removeWhatsAppLogRecentSearch,
} from "./whatsappLogRecentSearches.js";
import { setWhatsAppLastSeen } from "./whatsappUnread.js";

/**
 * Mirrors EntityPanel.tsx's and GlobalSearchPanel.tsx's own Highlighted
 * wrapper (rounds 195-196) around the same splitHighlightSegments -- the
 * WhatsApp log's own search box already narrowed the list down to
 * matching messages, but never showed where within a message's own body
 * or sender/recipient label the match actually was, the exact same gap
 * those two search boxes had.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {splitHighlightSegments(text, query).map((seg, i) =>
        seg.matched ? (
          <mark key={i} className="search-match">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Round 1049: mirrors EntityPanel.tsx's own Linkified (round 274's
 * splitLinkSegments) -- a WhatsApp message's own body is, if anything, a
 * MORE link-heavy piece of text than a Customer/Vendor "Notes" field
 * (splitLinkSegments' own doc comment literally names "a WhatsApp-sourced
 * message" as a motivating case for linkifying free text), but this log
 * never adopted it: a real customer message containing a product link, a
 * Google Maps pin, a payment URL, or an email address rendered as
 * completely inert text the business owner had to manually select and
 * retype elsewhere, while the identical string typed into a plain
 * text/longtext field already renders as a real clickable link everywhere
 * that field is shown (table, print sheet). Composes with this file's own
 * Highlighted exactly the way EntityPanel.tsx's Linkified already does,
 * so search-match highlighting and linkification keep working together.
 */
function LinkifiedBody({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitLinkSegments(text).map((seg, i) =>
        seg.href ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="cell-link">
            {seg.text}
          </a>
        ) : (
          <Highlighted key={i} text={seg.text} query={query} />
        ),
      )}
    </>
  );
}

// Mirrors HistoryPanel's own threshold for showing its checkpoint search
// box -- a handful of messages are trivial to scan by eye; a search box
// above them would just be clutter with nothing real to filter yet.
const SEARCH_THRESHOLD = 5;

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

const POLL_INTERVAL_MS = 1500;
// A single dropped request (a momentary network blip, a cold-starting
// backend) shouldn't permanently strand the panel in "connecting" with no
// further updates -- only give up after several polls in a row fail.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
// Once connected, WhatsApp itself can still drop the link later (phone
// loses signal, is turned off, unlinks the device, ...) with no action
// from this panel at all -- a slower background poll is enough to notice
// that and refresh the UI, without hammering the server the way the fast
// QR-waiting poll above needs to.
const CONNECTED_POLL_INTERVAL_MS = 10000;
// Mirrors MAX_CONSECUTIVE_POLL_FAILURES above -- without this, a
// persistently failing background check (backend down, expired session,
// network drop) would retry silently forever, leaving the panel stuck
// showing a "Connected" status the code can no longer actually confirm,
// with no indication anything is wrong.
const MAX_CONSECUTIVE_CONNECTED_POLL_FAILURES = 5;

// Round 973: mirrors EntityPanel.tsx's own MAX_FILE_UPLOAD_SIZE_BYTES --
// the same 10 MB server-side limit (createWhatsAppAttachmentUploadMiddleware
// in routes/projects.ts) checked client-side first, so a too-large file is
// rejected instantly instead of only after a full upload round-trip.
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Folds a freshly-fetched newest-page response into whatever's already
 * loaded, instead of replacing it outright -- a plain `setMessages(fresh)`
 * after sending/retrying a message silently threw away any older pages the
 * user had already paged back through via "Load older messages"
 * (handleLoadMore), making them vanish from view (and the button reappear)
 * even though nothing was actually lost server-side. `freshPage` always
 * overlaps with the newest end of `prev` (both are the same DESC-ordered
 * log), so only the ids not already present are new.
 */
function mergeFreshMessages(
  prev: WhatsAppMessageLogEntry[],
  freshPage: WhatsAppMessageLogEntry[],
): WhatsAppMessageLogEntry[] {
  const existingIds = new Set(prev.map((m) => m.id));
  const newOnes = freshPage.filter((m) => !existingIds.has(m.id));
  return newOnes.length === 0 ? prev : [...newOnes, ...prev];
}

export function WhatsAppPanel({
  projectId,
  projectName,
  entities,
  userId,
  onClose,
  onJumpToEntity,
  onJumpToRecord,
  onCreateRecordFromMessage,
  prefillTo,
  onMessageDeleted,
  onHistoryCleared,
  readOnly = false,
}: {
  projectId: string;
  projectName: string;
  /** The project's own spec.entities -- used only to find the single unambiguous phone-field entity+field for the "create new record from this message" button below; see findSinglePhoneFieldTarget's own doc comment. */
  entities: Entity[];
  userId: string;
  onClose: () => void;
  /** True for a "viewer" collaborator -- the server already rejects every write here with 403 VIEWER_READ_ONLY; this just keeps a viewer from clicking a control that can only ever fail. */
  readOnly?: boolean;
  onJumpToEntity: (entityName: string) => void;
  /**
   * The API already resolves each matched message down to a specific
   * record id (see whatsappWeb.ts / routes/projects.ts's own
   * matchedRecordId), but this panel's own "jump to" button used to throw
   * it away and only ever pass the entity name -- the exact same gap
   * Global Search's own "jump to" had before round 174 gave it a real
   * per-record jump. Falls back to onJumpToEntity for the rare case a
   * message matched an entity but its specific record has since been
   * deleted (matchedRecordId null, matchedEntityName not).
   */
  onJumpToRecord: (entityName: string, recordId: number) => void;
  /**
   * Round 921: an UNmatched inbound message (a brand-new contact --
   * matchedEntityName/matchedRecordId both null) had no path at all,
   * manual or automated, to becoming a real record -- the one real "data
   * entry point" this app's own product vision leads with (a WhatsApp
   * lead turning into a CRM record) that every OTHER entry point
   * (manual Add, CSV import, refine) already has. Called with the single
   * unambiguous phone-field entity+field findSinglePhoneFieldTarget
   * found and the message's own fromNumber, so the caller can switch to
   * that entity's tab with its create form pre-filled -- the same
   * "jump, don't guess" principle onJumpToRecord above already follows.
   */
  onCreateRecordFromMessage: (entityName: string, fieldName: string, phoneNumber: string) => void;
  /** A phone number to open the test-send form pre-filled with, e.g. from an EntityPanel row's "Send WhatsApp" action -- the reverse direction of onJumpToRecord above. App.tsx only ever mounts this panel fresh (conditional render, not a persistent one), so a plain lazy useState initializer is enough; no effect is needed to react to a later change while already mounted. */
  prefillTo?: string | null;
  /**
   * Round 593: App.tsx's own independent unread-poll tracks a desktop-
   * notification baseline (lastNotifiedWhatsAppIdRef) purely in memory,
   * set to whatever message was newest at its last check -- with no
   * resync path of its own. The topbar badge's sibling baseline
   * (whatsappLastSeenId, below) already self-heals on every messages
   * change via its own effect, but that effect lives in THIS component,
   * not App.tsx's, so it can't reach the poll's ref. Deleting the exact
   * message a notification baseline points to makes it vanish from the
   * next fetched page; findNewInboundMessages (whatsappNotify.ts) can't
   * find it there and, by design, falls back to treating every inbound
   * message still on the page as "new" -- a fallback meant for pagination
   * overflow, not for "the user just deleted it" -- so the next
   * background-tab check fires a real OS notification re-announcing
   * already-read messages. These two callbacks let App.tsx forget its
   * stale baseline the moment it's invalidated, the same way
   * whatsappLastSeenId already forgets it below.
   */
  onMessageDeleted?: (id: string) => void;
  onHistoryCleared?: () => void;
}) {
  const { t, lang } = useTranslation();
  // Computed once per render from the project's own entity list, not per
  // message row -- the result is identical for every unmatched message in
  // the log, since it only depends on the spec's own fields, never on any
  // one message.
  const phoneFieldTarget = findSinglePhoneFieldTarget(entities);
  // Round 957: the log mixes messages matched against every phone-bearing
  // entity in the spec (any of this app's own seed templates, e.g. a
  // delivery app with both Customer and Courier phone fields, matches more
  // than one) into one flat chronological list with no indication at all of
  // which entity a given matched name belongs to -- the API already
  // resolves the match down to a specific entity+record (see
  // findMatchingRecord, apps/api/src/whatsapp.ts), this panel just never
  // showed which one. Hand-duplicated entityLabelOccurrences/
  // entityDisplayLabel pair, same shape as every other consuming module in
  // this codebase (AutomationsPanel.tsx, automationsReport.ts,
  // checkpointDiff.ts, pipeline.ts) -- the Entity/Field Label editors don't
  // enforce uniqueness, so two entities can legitimately share one label,
  // and every other display surface disambiguates that with the entity's
  // own raw name in parens.
  function entityLabelOccurrences(allEntities: Entity[]): Map<string, number> {
    const occurrences = new Map<string, number>();
    for (const e of allEntities) {
      const label = e.label ?? e.name;
      occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
    }
    return occurrences;
  }
  function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
    const label = entity.label ?? entity.name;
    return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
  }
  const entityOccurrences = useMemo(() => entityLabelOccurrences(entities), [entities]);
  /** Falls back to the raw stored entityName when the entity has since been renamed or deleted -- same convention as AutomationsPanel's own entityLabel helper for a rule whose entity no longer resolves. */
  function matchedEntityLabel(entityName: string): string {
    const entity = entities.find((e) => e.name === entityName);
    return entity ? entityDisplayLabel(entity, entityOccurrences) : entityName;
  }
  const [status, setStatus] = useState<WhatsAppStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * Distinct from the shared loadError above (which also covers connect/
   * disconnect/send/load-more failures, all of which have their own clear
   * recovery action already): specifically the very first status fetch on
   * mount failing, which left the panel permanently stuck with nothing to
   * click short of closing and reopening it.
   */
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testTo, setTestTo] = useState(() => prefillTo ?? "");
  const [testMessage, setTestMessage] = useState("");
  const [testAttachment, setTestAttachment] = useState<WhatsAppAttachmentDescriptor | null>(null);
  // Round 1005: mirrors testAttachment for the unmount-cleanup effect
  // below -- that effect's own cleanup closure only ever sees whatever
  // testAttachment was at the moment the effect last ran (empty deps,
  // so once, at mount), never a later value a real picker interaction
  // set after that.
  const testAttachmentRef = useRef<WhatsAppAttachmentDescriptor | null>(null);
  testAttachmentRef.current = testAttachment;
  /**
   * Round 1192: handleAttachmentChange's own upload has a real `await`
   * (uploadWhatsAppAttachment) that lands BEFORE setTestAttachment ever
   * runs -- so if the panel unmounts while that upload is still pending,
   * the round-1005 unmount effect below finds testAttachmentRef.current
   * still null (nothing has landed yet) and deletes nothing, then the
   * upload finishes moments later with nowhere left to tell. Checked
   * inside handleAttachmentChange's own `.then` continuation to delete
   * that just-uploaded file directly instead of calling setTestAttachment
   * once the component is already gone.
   */
  const mountedRef = useRef(true);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [recentNumbers, setRecentNumbers] = useState<string[]>(() => getRecentWhatsAppNumbers(projectId, userId));
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessageLogEntry[]>([]);
  // Whether older messages exist beyond what's currently loaded -- the
  // server only ever hands back one page (see listWhatsAppMessages,
  // round 263), so this drives both the "load older" button's visibility
  // and formatWhatsAppMessageCount's "N+" vs "N (all)" phrasing.
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  // Lazy initializer, same shape as recentNumbers/directionFilter below --
  // this panel unmounts entirely on close (see App.tsx's
  // `{showWhatsApp && <WhatsAppPanel .../>}`), so a fresh mount always
  // re-reads the real persisted list for this project rather than needing
  // a separate load effect.
  const [logRecentSearches, setLogRecentSearches] = useState<string[]>(() => getWhatsAppLogRecentSearches(projectId, userId));
  // Lazy initializer, same shape as recentNumbers just above -- this panel
  // unmounts entirely on close (see App.tsx's `{showWhatsApp && <WhatsAppPanel .../>}`),
  // so a fresh mount always re-reads the real persisted choice for this
  // project rather than needing a separate load effect.
  const [directionFilter, setDirectionFilter] = useState<WhatsAppLogFilter>(() => getWhatsAppLogFilter(projectId, userId));
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  // "unsupported" covers both a browser with no Notification API at all and
  // this component's own SSR-less test/build environments -- reading
  // Notification.permission eagerly (rather than in an effect) means the
  // enable button never has to flash in before immediately disappearing on
  // an already-granted/denied browser.
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailuresRef = useRef(0);
  const connectedPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedPollFailuresRef = useRef(0);
  // Set by startConnectedPolling(), called by stopConnectedPolling() --
  // clearInterval only stops *future* ticks; a status fetch already in
  // flight when the user disconnects (or reconnects) keeps running and
  // would otherwise resolve afterward and overwrite the fresh state with
  // its now-stale "connected" payload. See stopConnectedPolling below.
  const cancelInFlightConnectedCheckRef = useRef<(() => void) | null>(null);
  // The same guard as cancelInFlightConnectedCheckRef above, for this
  // panel's *other* poll: startPolling's own getWhatsAppStatus call can
  // already be in flight when the user disconnects (or reconnects) mid-QR-
  // wait, and clearInterval alone doesn't stop that one call from resolving
  // afterward and overwriting the fresh, correct state with a stale
  // "connecting"/"qr" payload.
  const cancelInFlightPollRef = useRef<(() => void) | null>(null);
  /**
   * Bumped by handleDeleteMessage/handleClearHistory's own explicit
   * removal, the moment it's known to have succeeded server-side. Every
   * fetch-then-setMessages call site below -- the three mergeFreshMessages
   * ones (the connected-poll tick, handleSendTest, handleRetry) and
   * handleLoadMore's own plain-append one -- captures this value right
   * before its own listWhatsAppMessages fetch starts, and skips applying
   * that fetch's result if the value changed while it was in flight.
   * Without this, a delete/clear landing while one of those fetches is
   * already running resurrects the just-deleted message(s): that fetch's
   * response still reflects the pre-deletion log, and either
   * mergeFreshMessages treats every id missing from the now-shorter `prev`
   * as new and splices it right back in, or (handleLoadMore) the plain
   * `[...prev, ...older]` concat glues the stale page onto whatever `prev`
   * has shrunk to in the meantime -- permanently in both cases, since no
   * later fetch of the now-genuinely-smaller log ever removes an id it
   * doesn't recognize as missing.
   */
  const messagesVersionRef = useRef(0);

  // The keyset cursor from the most recently loaded page's own nextCursor
  // (see listWhatsAppMessages, packages/db/src/whatsapp.ts) -- NOT
  // messages.length, which round 652 found silently skips a message
  // whenever another collaborator deletes one above the pagination
  // boundary between two "load more" calls (a count-based OFFSET re-counts
  // position from the top of the DESC-ordered log on every call, so a
  // deletion there shifts everything below it up by one). A ref, not
  // state, since setting it never needs to trigger a re-render on its own
  // -- it only ever matters the next time handleLoadMore reads it.
  const nextCursorRef = useRef<string | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    cancelInFlightPollRef.current?.();
    cancelInFlightPollRef.current = null;
  }

  function stopConnectedPolling() {
    if (connectedPollRef.current) {
      clearInterval(connectedPollRef.current);
      connectedPollRef.current = null;
    }
    cancelInFlightConnectedCheckRef.current?.();
    cancelInFlightConnectedCheckRef.current = null;
  }

  /**
   * Runs while status is "connected", so the panel notices if WhatsApp
   * itself drops the link later (phone loses signal, gets unlinked, ...)
   * instead of trusting a status that could be stale indefinitely -- this
   * is what was missing when a stale "connected" status let the Retry
   * button silently do nothing (see docs/roadmap.md). Also re-fetches the
   * newest page of messages on the same tick, so an inbound WhatsApp
   * message shows up in the open log within CONNECTED_POLL_INTERVAL_MS
   * instead of only appearing after closing and reopening the panel --
   * before this, the message log was the one part of this screen that
   * silently went stale while you were actively watching it (round 288).
   */
  function startConnectedPolling() {
    stopConnectedPolling();
    connectedPollFailuresRef.current = 0;
    let cancelled = false;
    cancelInFlightConnectedCheckRef.current = () => {
      cancelled = true;
    };
    connectedPollRef.current = setInterval(async () => {
      try {
        const next = await getWhatsAppStatus(projectId);
        if (cancelled) return;
        connectedPollFailuresRef.current = 0;
        setStatus(next);
        if (next.status !== "connected") {
          stopConnectedPolling();
          if (next.status === "connecting" || next.status === "qr") startPolling();
          return;
        }
        try {
          const versionBeforeFetch = messagesVersionRef.current;
          const { messages: freshPage } = await listWhatsAppMessages(projectId);
          if (cancelled) return;
          if (messagesVersionRef.current === versionBeforeFetch) {
            setMessages((prev) => mergeFreshMessages(prev, freshPage));
          }
        } catch {
          // A single failed message-refresh isn't worth surfacing an error
          // for -- the connection-status check above already covers real
          // failures. Just skip this tick's message update and try again
          // on the next one.
        }
      } catch (err) {
        if (cancelled) return;
        // A lone failed background check isn't worth interrupting the
        // user over -- keep trying. Only give up, and say so, after
        // several in a row fail, same threshold as the fast poll above.
        connectedPollFailuresRef.current += 1;
        if (connectedPollFailuresRef.current >= MAX_CONSECUTIVE_CONNECTED_POLL_FAILURES) {
          stopConnectedPolling();
          setLoadError((err as Error).message);
        }
      }
    }, CONNECTED_POLL_INTERVAL_MS);
  }

  function startPolling() {
    stopPolling();
    pollFailuresRef.current = 0;
    let cancelled = false;
    cancelInFlightPollRef.current = () => {
      cancelled = true;
    };
    pollRef.current = setInterval(async () => {
      try {
        const next = await getWhatsAppStatus(projectId);
        if (cancelled) return;
        pollFailuresRef.current = 0;
        setStatus(next);
        if (next.status === "connected" || next.status === "disconnected") {
          stopPolling();
          if (next.status === "connected") {
            // stopPolling() just above set this tick's own `cancelled` to
            // true as a side effect (it nulls cancelInFlightPollRef, which
            // *is* this closure) -- that's a normal part of every
            // successful transition, not evidence of an external
            // disconnect, so `cancelled` can no longer tell the two apart.
            // The messagesVersionRef guard (same idiom as
            // startConnectedPolling above, and handleDeleteMessage/
            // handleClearHistory below) distinguishes them instead: only
            // skip applying this fetch if something that actually mutated
            // messages (e.g. handleDisconnect) ran during the await.
            const versionBeforeFetch = messagesVersionRef.current;
            const { messages, hasMore, nextCursor } = await listWhatsAppMessages(projectId);
            if (messagesVersionRef.current === versionBeforeFetch) {
              setMessages(messages);
              setHasMoreMessages(hasMore);
              nextCursorRef.current = nextCursor;
              startConnectedPolling();
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        // A lone failed poll is likely transient -- keep trying instead of
        // stranding the user with a QR code that never updates again.
        // Only give up, and say so, after several in a row fail.
        pollFailuresRef.current += 1;
        if (pollFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          stopPolling();
          setLoadError((err as Error).message);
        }
      }
    }, POLL_INTERVAL_MS);
  }

  function loadInitialStatus() {
    setInitialLoadError(null);
    getWhatsAppStatus(projectId)
      .then((s) => {
        // Round 1238: this is the panel's very first network call, fired
        // unconditionally from the mount effect below. Unlike
        // startPolling/startConnectedPolling's own ticks (each guarded by
        // their own `cancelled` closure) and handleAttachmentChange's own
        // post-upload check (round 1192), this .then had no guard at all --
        // closing the panel before this resolves lets it still call
        // startPolling/startConnectedPolling on a component instance that's
        // already gone, arming a setInterval nothing will ever clear again
        // (the unmount cleanup already ran, and the polling refs it clears
        // are still null -- polling hadn't started yet). Same mountedRef
        // convention as round 1192's own fix closes it here too.
        if (!mountedRef.current) return;
        setStatus(s);
        if (s.status === "connecting" || s.status === "qr") startPolling();
        if (s.status === "connected") {
          // Same messagesVersionRef idiom as startPolling/startConnectedPolling
          // below -- this fetch can still be in flight when handleDisconnect
          // runs (e.g. the panel mounts already-connected and the user hits
          // Disconnect before this resolves). Without the guard, this
          // .then would unconditionally overwrite the empty log
          // handleDisconnect just set with this stale, pre-disconnect page
          // (round 541).
          const versionBeforeFetch = messagesVersionRef.current;
          listWhatsAppMessages(projectId)
            .then(({ messages, hasMore, nextCursor }) => {
              if (messagesVersionRef.current !== versionBeforeFetch) return;
              setMessages(messages);
              setHasMoreMessages(hasMore);
              nextCursorRef.current = nextCursor;
            })
            .catch(() => {});
          startConnectedPolling();
        }
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setInitialLoadError((err as Error).message);
      });
  }

  useEffect(() => {
    loadInitialStatus();
    return () => {
      stopPolling();
      stopConnectedPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /**
   * Round 1005: this panel fully unmounts the moment it's closed (App.tsx's
   * `{showWhatsApp && <WhatsAppPanel .../>}`) -- handleAttachmentChange's
   * own replace case and handleRemoveAttachment (round 979) only ever
   * clean up a superseded/removed attachment while the panel stays open,
   * and handleSendTest only clears it after an actual send attempt. Picking
   * an attachment and then simply closing the panel -- without ever
   * clicking Send or Remove -- left that upload sitting on disk forever,
   * the same orphaned-upload shape round 979 already fixed for every OTHER
   * way of abandoning a chosen attachment, just not this one.
   */
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (testAttachmentRef.current) {
        void deleteWhatsAppAttachment(projectId, testAttachmentRef.current.url).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /**
   * Keeps the "last seen" marker (see whatsappUnread.ts) in sync with
   * whatever's actually loaded here, from every source that updates
   * `messages` -- the initial mount fetch, the connected-poll's own live
   * refresh (round 288), sending/retrying a test message, all of them.
   * The topbar's own unread badge (App.tsx) is what actually reads this
   * marker; this panel only ever writes it. Deliberately keyed on
   * `messages` itself (not just its length) so a message removed via
   * "delete" or "clear" -- which never advances how far the owner has
   * genuinely read -- doesn't spuriously bump the marker either.
   *
   * Only self-heals this way while THIS browser's panel happens to be
   * open (round 940): a different collaborator deleting this exact
   * tracked message from a different session leaves this marker stale
   * here, with no live signal of any kind to resync it from. Stores the
   * message's own createdAt alongside its id for exactly that reason --
   * see countUnreadWhatsAppMessages' own doc comment for how that lets
   * the unread count stay correct even once this marker's tracked id no
   * longer exists.
   *
   * Round 1046: also keyed per-user now (see whatsappUnread.ts), the same
   * gap round 1011 already fixed for this exact feature's own sibling
   * store, whatsappRecentNumbers.ts (missed here at the time) -- without
   * it, one collaborator reading the log on their own browser silently
   * zeroed every OTHER collaborator's own unread badge too, for messages
   * that other person never actually saw.
   */
  useEffect(() => {
    if (messages.length > 0) setWhatsAppLastSeen(projectId, userId, { id: messages[0].id, createdAt: messages[0].createdAt });
  }, [projectId, userId, messages]);

  /**
   * startPolling's own 5-consecutive-failures giveup (above) sets loadError
   * but never changes `status`, so a user mid-QR-pairing was left staring
   * at the stale QR code plus an error line with no in-panel action at
   * all -- the shared loadError block right above this component's own
   * per-status boxes renders it as a bare, buttonless <p>, unlike every
   * other loadError cause (connect/disconnect/send failures), which all
   * keep their own clear recovery action (the Connect/Disconnect/Retry
   * button for that state) usable. Reuses loadInitialStatus rather than
   * just calling startPolling() again, since the real status may have
   * changed during the outage (e.g. genuinely connected or disconnected
   * while the poll was failing) -- a plain retry must re-check reality,
   * not just assume nothing changed.
   */
  function handleRetryPoll() {
    setLoadError(null);
    loadInitialStatus();
  }

  async function handleConnect() {
    setConnecting(true);
    setLoadError(null);
    try {
      const next = await connectWhatsApp(projectId);
      setStatus(next);
      // Round 1239: closing the panel (unmount) while this request was
      // still in flight already ran the mount effect's own cleanup
      // (stopPolling()/stopConnectedPolling()) before this line -- both
      // were no-ops since nothing had started polling yet. Without this
      // guard, startPolling() below would still arm a brand-new
      // setInterval for a component instance that's already gone, which
      // nothing will ever clear again (same gap, same fix, as
      // loadInitialStatus's own round-1238 comment above).
      if (mountedRef.current) startPolling();
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    const wasConnected = status?.status === "connected";
    setDisconnecting(true);
    stopPolling();
    stopConnectedPolling();
    try {
      const next = await disconnectWhatsApp(projectId);
      // Bumped before touching messages, same idiom as
      // handleDeleteMessage/handleClearHistory below -- this is what lets
      // startPolling's own tick (above) tell a genuine disconnect apart
      // from its own stopPolling() self-cancellation side effect.
      messagesVersionRef.current += 1;
      setStatus(next);
      setMessages([]);
      setHasMoreMessages(false);
      nextCursorRef.current = null;
      // Round 902: same staleness handleClearHistory already guards
      // against -- a retryError/deleteError from a failed retry/delete
      // just before this disconnect otherwise survives the message wipe
      // into the disconnected view, with no message left for it to refer to.
      setRetryError(null);
      setDeleteError(null);
    } catch (err) {
      setLoadError((err as Error).message);
      // The disconnect request itself failed -- nothing changed
      // server-side, so if we were connected before this attempt we still
      // are. stopConnectedPolling() above already killed the background
      // poll that would notice WhatsApp dropping the link on its own;
      // without resuming it here, a single failed disconnect attempt
      // silently leaves an otherwise-still-connected panel with no
      // monitoring at all until the user closes and reopens it.
      // Round 1239: the same unmount gap as handleConnect's own fix above
      // -- a disconnect request that fails after the panel already
      // closed must not re-arm startConnectedPolling() for a component
      // instance that's already gone.
      if (wasConnected && mountedRef.current) startConnectedPolling();
    } finally {
      setDisconnecting(false);
    }
  }

  // Must be called from a real user gesture (a click) -- browsers reject a
  // permission request fired from anywhere else, so this can't just run in
  // an effect on mount. App.tsx's own background unread-poll checks
  // Notification.permission itself before ever calling `new Notification`,
  // so this only needs to update the local UI state; nothing else reads it.
  async function handleRequestNotifyPermission() {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifyPermission(result);
  }

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setSendResult(null);
    setRecentNumbers(addRecentWhatsAppNumber(projectId, userId, testTo));
    try {
      const result = await sendWhatsAppMessage(projectId, testTo, testMessage, testAttachment ?? undefined);
      setSendResult(
        result.ok ? { ok: true, text: t("whatsapp.send.success") } : { ok: false, text: result.error ?? t("whatsapp.send.genericError") },
      );
      // Round 1001's own comment claimed the server (routes/projects.ts's
      // POST .../whatsapp/send) "deletes the resolved attachment file from
      // disk unconditionally the moment whatsapp.sendMessage above
      // resolves, win or lose" -- true only for a failure that actually
      // reaches that point. Several failures short-circuit BEFORE the
      // server ever touches the file at all: WHATSAPP_NOT_CONNECTED (the
      // connection-status check runs before the attachment is even
      // resolved), a VALIDATION_ERROR on `to`/`message`, and the send-route's
      // own rate limiter rejecting the request outright. Round 1081's
      // Explore survey found that clearing unconditionally here orphaned
      // the real uploaded file on disk with zero remaining client-side
      // reference in every one of those cases -- unlike the success path,
      // where the server really did delete it, there is now nothing left
      // pointing at the file for the existing "Remove" button to clean up,
      // and (per this same file's own round-979 comment) the only other
      // cleanup for an orphaned attachment is deleting the whole project.
      // result.attachmentAlreadyHandled (api.ts's sendWhatsAppMessage) is
      // true exactly when the server already deleted the file or confirmed
      // there was nothing to clean up -- clearing on that, rather than on
      // result.ok alone, still fixes round 1001's own original dead end (a
      // Baileys-level send failure, e.g. an invalid number, still deletes
      // the file server-side despite result.ok being false) while no longer
      // discarding the only remaining reference to a file that's still
      // genuinely sitting on disk, unsent and untouched.
      if (result.attachmentAlreadyHandled) setTestAttachment(null);
      // Mirrors every other write-form in this app (EntityPanel's own
      // record form resets to empty right after a successful create) --
      // only on success, so a failed send still leaves the typed
      // recipient/message in place to retry, rather than forcing the
      // user to redo both after e.g. a transient network error.
      if (result.ok) {
        setTestTo("");
        setTestMessage("");
      }
      const versionBeforeFetch = messagesVersionRef.current;
      const { messages: freshPage } = await listWhatsAppMessages(projectId);
      if (messagesVersionRef.current === versionBeforeFetch) {
        setMessages((prev) => mergeFreshMessages(prev, freshPage));
      }
    } catch (err) {
      setSendResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
    }
  }

  /**
   * Round 973: mirrors EntityPanel.tsx's own file-field upload branch --
   * uploads immediately on selection (rather than waiting for the Send
   * click) so a failed/too-large upload is caught and shown before the
   * user even finishes composing the rest of the message.
   */
  async function handleAttachmentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0];
    e.target.value = "";
    if (!chosen) return;
    setAttachmentError(null);
    if (chosen.size > MAX_ATTACHMENT_SIZE_BYTES) {
      setAttachmentError(t("whatsapp.test.attachment.tooLarge"));
      return;
    }
    setUploadingAttachment(true);
    try {
      const uploaded = await uploadWhatsAppAttachment(projectId, chosen);
      // Round 1192: the panel closed (unmounted) while this exact upload
      // was still in flight -- the round-1005 unmount effect already ran
      // and found nothing in testAttachment yet to delete, so this file
      // is this call's own, and only this call's own, responsibility to
      // clean up now that nothing will ever reference it.
      if (!mountedRef.current) {
        void deleteWhatsAppAttachment(projectId, uploaded.url).catch(() => {});
        return;
      }
      // Round 979: replacing an already-selected attachment with a
      // different file otherwise left the first upload sitting on disk
      // forever (nothing but whole-project deletion ever touched it) --
      // only delete the OLD one once the new one has actually uploaded
      // successfully, so a failed re-upload never loses the still-valid
      // previous selection. Best-effort: nothing here needs to block on or
      // react to this failing.
      if (testAttachment) {
        void deleteWhatsAppAttachment(projectId, testAttachment.url).catch(() => {});
      }
      setTestAttachment({ url: uploaded.url, name: uploaded.name, mimeType: uploaded.mimeType });
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingAttachment(false);
    }
  }

  /**
   * Round 979: the same orphaned-upload gap as handleAttachmentChange's own
   * replace case just above -- removing a chosen attachment before ever
   * sending it previously only ever cleared local React state, leaving the
   * real upload on disk forever.
   */
  function handleRemoveAttachment() {
    // Round 1119: handleSendTest reads testAttachment synchronously the
    // moment Send is clicked and sends that exact file's url to the
    // server; deleting the file here while that request is still in
    // flight raced the server's own existsSync check (routes/projects.ts),
    // turning what looked like a normal in-progress send into a real,
    // user-visible ATTACHMENT_FILE_GONE failure.
    if (sending) return;
    if (testAttachment) {
      void deleteWhatsAppAttachment(projectId, testAttachment.url).catch(() => {});
    }
    setTestAttachment(null);
    setAttachmentError(null);
  }

  /**
   * Round 1061: this whole panel is a real dialog (useDialogFocusTrap
   * above), whose own Escape handler closes it entirely unless the event's
   * target sits under data-escape-handled-locally -- every other form on
   * this exact screen with real draft content already opts out this way
   * (AutomationsPanel.tsx's own create/edit form, this file's own log
   * search box just below), but this test-send form never did. Pressing
   * Escape after typing a recipient/message (or choosing an attachment)
   * for any ordinary reason -- dismissing a browser autofill suggestion,
   * a reflexive tap -- silently closed the whole panel and discarded the
   * draft with zero confirmation. `hasUnsavedTestDraft` mirrors
   * AutomationsPanel's own hasUnsavedDraft shape exactly: true only while
   * there's something a user would actually lose, so an Escape on a
   * pristine form still closes the panel normally, matching the log
   * search box's own already-established "nothing to clear" behavior
   * (round 362's own comment just above explains why that distinction
   * matters). handleResetTestForm also deletes an already-uploaded
   * attachment via the real DELETE call, mirroring handleRemoveAttachment
   * just above -- otherwise Escape would silently orphan it on disk the
   * same way round 979 already closed for the explicit "Remove" button.
   */
  const hasUnsavedTestDraft = testTo.trim() !== "" || testMessage.trim() !== "" || testAttachment !== null;

  function handleResetTestForm() {
    // Round 1119: see handleRemoveAttachment's own identical guard just
    // above -- Escape-to-clear deletes the attachment the same way, and
    // must not race an in-flight send either.
    if (sending) return;
    if (testAttachment) {
      void deleteWhatsAppAttachment(projectId, testAttachment.url).catch(() => {});
    }
    setTestTo("");
    setTestMessage("");
    setTestAttachment(null);
    setAttachmentError(null);
  }

  function handleRecentNumberClick(n: string) {
    setTestTo(n);
  }

  /**
   * An inbound message had no way to reply to it directly -- only a
   * delete button (and, for a failed outbound message, Retry). Seeing a
   * customer's message but having to scroll up and manually copy their
   * number into the test-send "to" field is exactly the kind of friction
   * a real WhatsApp inbox shouldn't have. Reuses the same setTestTo call
   * handleRecentNumberClick already makes; the recipient of a reply is
   * always the message's own sender (fromNumber), never toNumber (that's
   * this project's own WhatsApp number).
   *
   * Also clears any already-drafted testMessage -- otherwise text typed
   * for one contact silently follows the recipient switch to whichever
   * message was just replied to, risking the drafted text being sent to
   * the wrong person if the user doesn't notice the swap before hitting
   * Send.
   *
   * Round 1104: testAttachment is the other half of a drafted send
   * (sendWhatsAppMessage above sends testTo/testMessage/testAttachment
   * together) and was missing from this clear entirely -- an attachment
   * already chosen for one contact silently followed the recipient switch
   * too, so replying to a DIFFERENT message while a file was still
   * pending sent that file to the new recipient instead, a real
   * misdirected-attachment risk, not just a cosmetic one. Deletes the
   * real upload from disk first (best-effort, same pattern as
   * handleRemoveAttachment/handleResetTestForm just above), since leaving
   * it would orphan it the same way round 979 already closed for the
   * explicit "Remove" button and Escape-to-clear.
   */
  function handleReplyToMessage(m: WhatsAppMessageLogEntry) {
    // Round 1119: see handleRemoveAttachment's own identical guard above --
    // switching recipients mid-send deletes the attachment the in-flight
    // send is still using, for the same reason.
    if (sending) return;
    setTestTo(m.fromNumber);
    setTestMessage("");
    if (testAttachment) {
      void deleteWhatsAppAttachment(projectId, testAttachment.url).catch(() => {});
    }
    setTestAttachment(null);
    setAttachmentError(null);
  }

  function handleRemoveRecentNumber(n: string) {
    setRecentNumbers(removeRecentWhatsAppNumber(projectId, userId, n));
  }

  function handleClearRecentNumbers() {
    clearRecentWhatsAppNumbers(projectId, userId);
    setRecentNumbers([]);
  }

  /**
   * Persists the log search box's current value once the user signals
   * they're "done" by pressing Enter -- same reasoning as App.tsx's own
   * handleProjectSearchKeyDown (round 316) and EntityPanel.tsx's own
   * handleSearchKeyDown (round 318): a live filter-as-you-type box has no
   * submit button, so Enter is the closest thing to a commit signal.
   * Escape clears the live search value (mirroring HistoryPanel.tsx's own
   * search box, round 358) -- the input only carries
   * data-escape-handled-locally while there's actually something to clear
   * (round 362): with the marker unconditional, Escape on an EMPTY box
   * matched neither this function's own `search.length > 0` guard nor
   * useDialogFocusTrap's own close-the-dialog branch (which the marker's
   * mere presence always skipped, regardless of whether this handler did
   * anything) -- so Escape from a focused, empty search box silently did
   * nothing at all instead of closing the dialog like every other focused
   * control in it.
   */
  function handleLogSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Round 1103: the Escape-to-clear branch that used to live here moved
    // up to the wrapping .whatsapp-log-filters div's own onKeyDown, so it
    // also covers Escape fired from the "✕ clear" button or the
    // direction-filter select, not just this input.
    if (e.key === "Enter" && search.trim()) {
      setLogRecentSearches(addWhatsAppLogRecentSearch(projectId, userId, search));
    }
  }
  function handleRecentLogSearchClick(query: string) {
    setSearch(query);
  }
  function handleRemoveRecentLogSearch(query: string) {
    setLogRecentSearches(removeWhatsAppLogRecentSearch(projectId, userId, query));
  }
  function handleClearRecentLogSearches() {
    clearWhatsAppLogRecentSearches(projectId, userId);
    setLogRecentSearches([]);
  }

  async function handleRetry(m: WhatsAppMessageLogEntry) {
    // Round 1101: the original attachment file is already gone by the
    // time this row even exists (the send route deletes it right after
    // whatsapp.sendMessage() resolves, win or lose, round 979) -- so
    // there is no file left to resend, ever. Without this, Retry would
    // silently call sendWhatsAppMessage with only the text body, and a
    // "sent" result afterward would look identical to the original
    // message having gone through in full, with nothing anywhere telling
    // the user the customer never got the attachment a second time
    // either.
    if (m.hadAttachment && !window.confirm(t("whatsapp.log.confirmRetryTextOnly"))) return;
    setRetryingId(m.id);
    setRetryError(null);
    // Round 909: handleClearHistory/handleDisconnect already cross-clear
    // both retryError and deleteError (round 902) -- this function and
    // handleDeleteMessage just below are the file's own other pair of
    // per-action handlers, and were never given the same treatment. A
    // delete that succeeds for the exact message a retry just failed for
    // (or any other message, while an unrelated retry succeeds) must not
    // leave the OTHER action's stale error banner on screen, since both
    // render unconditionally with no gate on which action produced them.
    setDeleteError(null);
    try {
      const result = await sendWhatsAppMessage(projectId, m.toNumber, m.body);
      // A retry can fail for a reason that never reaches insertWhatsAppMessage
      // on the server (e.g. WhatsApp disconnected since the original failed
      // send) -- in that case the message log is unchanged, so show the
      // reason directly instead of leaving the button silently reset.
      if (!result.ok) setRetryError(result.error ?? t("whatsapp.log.retryError"));
      const versionBeforeFetch = messagesVersionRef.current;
      const { messages: freshPage } = await listWhatsAppMessages(projectId);
      if (messagesVersionRef.current === versionBeforeFetch) {
        setMessages((prev) => mergeFreshMessages(prev, freshPage));
      }
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      setRetryingId(null);
    }
  }

  /**
   * Appends the next older page rather than replacing state, using the
   * keyset cursor from the last loaded page (nextCursorRef) rather than
   * messages.length as an offset -- an offset recounts position from the
   * top of the DESC-ordered log on every call, so a message inserted OR
   * deleted anywhere above the pagination boundary between two "load more"
   * clicks (by this session or any other collaborator -- see
   * listWhatsAppMessages, packages/db/src/whatsapp.ts) shifts every later
   * row's position. An insertion then duplicates a message across pages;
   * a deletion silently and permanently skips one, with no duplicate for a
   * dedup filter to catch. A keyset cursor pins "everything strictly after
   * this specific row," so it's immune to either. The id-based dedup filter
   * below stays as defense-in-depth against the one remaining race a cursor
   * doesn't cover -- a message arriving between this function reading
   * nextCursorRef and the server running the query, which can still repeat
   * the newest row of the previous page under a small window.
   */
  async function handleLoadMore() {
    setLoadingMore(true);
    try {
      const versionBeforeFetch = messagesVersionRef.current;
      const { messages: older, hasMore, nextCursor } = await listWhatsAppMessages(projectId, nextCursorRef.current);
      if (messagesVersionRef.current === versionBeforeFetch) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          return [...prev, ...older.filter((m) => !existingIds.has(m.id))];
        });
        setHasMoreMessages(hasMore);
        nextCursorRef.current = nextCursor;
      }
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleDownloadLog() {
    downloadWhatsAppLog(formatWhatsAppLog(messages, entities, projectName, lang, t), projectName);
  }

  /**
   * Same "Copy report" companion action round 222 added to Business Twin's
   * own Download button -- the log is already formatted as plain,
   * shareable text (formatWhatsAppLog mirrors formatTwinReport's own
   * approach), but the only way to actually get it anywhere was a real
   * file download. Same navigator.clipboard.writeText + auto-fading
   * copyStatus label, reused verbatim rather than reinvented.
   */
  async function handleCopyLog() {
    try {
      await navigator.clipboard.writeText(formatWhatsAppLog(messages, entities, projectName, lang, t));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  /**
   * clearWhatsAppMessages above was previously the only way to remove
   * anything from the log at all -- one junk or test message meant wiping
   * the whole history to get rid of it. Removes exactly the clicked
   * message, both from the server and from this panel's own local state,
   * matching handleClearHistory's own confirm-then-request-then-update
   * shape rather than an optimistic remove that could drift from the
   * server if the request actually failed.
   */
  async function handleDeleteMessage(m: WhatsAppMessageLogEntry) {
    if (!window.confirm(t("whatsapp.log.confirmDeleteOne"))) return;
    setDeletingId(m.id);
    setDeleteError(null);
    // Round 909: mirrors handleRetry's own cross-clear just above.
    setRetryError(null);
    try {
      await deleteWhatsAppMessage(projectId, m.id);
      messagesVersionRef.current += 1;
      setMessages((prev) => prev.filter((msg) => msg.id !== m.id));
      onMessageDeleted?.(m.id);
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleClearHistory() {
    if (!window.confirm(t("whatsapp.log.confirmClear"))) return;
    setClearing(true);
    try {
      await clearWhatsAppMessages(projectId);
      messagesVersionRef.current += 1;
      setMessages([]);
      setHasMoreMessages(false);
      nextCursorRef.current = null;
      setRetryError(null);
      // Round 902: a stale deleteError (e.g. from a failed delete attempt
      // just before this clear) otherwise survives the wipe -- the panel
      // would show an empty log with a red "delete failed" banner on top,
      // referring to a message that no longer exists anywhere.
      setDeleteError(null);
      onHistoryCleared?.();
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setClearing(false);
    }
  }

  const s = status?.status ?? "disconnected";
  const visibleMessages = filterWhatsAppMessagesByDirection(filterWhatsAppMessages(messages, search), directionFilter);

  return (
    <div className="history-overlay">
      <div
        className="history-panel whatsapp-panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsapp-panel-title"
      >
        <div className="history-header">
          <h2 id="whatsapp-panel-title">{t("whatsapp.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <p className="muted small">{t("whatsapp.description")}</p>
        <p className="muted small whatsapp-prereq">{t("whatsapp.prerequisite")}</p>
        {/* s === "connecting"/"qr" renders its own loadError + Retry button
         * below instead -- that's the one state with no other recovery
         * action, unlike every other loadError cause (disconnected/
         * connected both keep their own Connect/Disconnect button usable
         * regardless). */}
        {loadError && s !== "connecting" && s !== "qr" && (
          <p className="error" role="status">
            {loadError}
          </p>
        )}
        {initialLoadError && (
          <div className="error-retry-row">
            <p className="error" role="status">
              {initialLoadError}
            </p>
            <button type="button" className="secondary small" onClick={loadInitialStatus}>
              {t("whatsapp.retry")}
            </button>
          </div>
        )}

        {s === "disconnected" && (
          <div className="whatsapp-connect-box">
            {status?.phoneNumber && <p className="muted small">{t("whatsapp.lastConnected", { phone: status.phoneNumber })}</p>}
            {!readOnly && (
              <button type="button" onClick={handleConnect} disabled={connecting}>
                {connecting ? t("whatsapp.connect.connecting") : t("whatsapp.connect.button")}
              </button>
            )}
            {status?.error && (
              <p className="error" role="status">
                {status.error}
              </p>
            )}
          </div>
        )}

        {(s === "connecting" || s === "qr") && (
          <div className="whatsapp-connect-box">
            {s === "connecting" && <p className="muted small">{t("whatsapp.connect.connecting")}</p>}
            {s === "qr" && status?.qrDataUrl && (
              <>
                <p className="muted small">{t("whatsapp.connect.qrInstructions")}</p>
                <img className="whatsapp-qr-image" src={status.qrDataUrl} alt={t("whatsapp.title")} />
              </>
            )}
            {/* Round 976: the server redacts qrDataUrl to null for a viewer
                (routes/projects.ts's GET .../whatsapp/status) -- without
                this, a viewer watching an owner/editor connect would just
                see an empty box here with no explanation. */}
            {s === "qr" && !status?.qrDataUrl && readOnly && <p className="muted small">{t("whatsapp.connect.qrHiddenForViewer")}</p>}
            {status?.error && (
              <p className="error" role="status">
                {status.error}
              </p>
            )}
            {loadError && (
              <div className="error-retry-row">
                <p className="error" role="status">
                  {loadError}
                </p>
                <button type="button" className="secondary small" onClick={handleRetryPoll}>
                  {t("whatsapp.retry")}
                </button>
              </div>
            )}
          </div>
        )}

        {s === "connected" && (
          <div className="whatsapp-connected-box">
            <p className="whatsapp-connected-status">{t("whatsapp.connected.as", { phone: status?.phoneNumber ?? "" })}</p>
            <div className="whatsapp-connected-actions">
              {notifyPermission === "default" && (
                <button type="button" className="secondary small" onClick={handleRequestNotifyPermission}>
                  {t("whatsapp.notify.enable")}
                </button>
              )}
              {notifyPermission === "granted" && <p className="muted small whatsapp-notify-status">{t("whatsapp.notify.enabled")}</p>}
              {notifyPermission === "denied" && <p className="muted small whatsapp-notify-status">{t("whatsapp.notify.denied")}</p>}
              {!readOnly && (
                <button type="button" className="secondary small" onClick={handleDisconnect} disabled={disconnecting}>
                  {disconnecting ? t("whatsapp.connected.disconnecting") : t("whatsapp.connected.disconnect")}
                </button>
              )}
            </div>
          </div>
        )}

        {s === "connected" && !readOnly && (
          <form
            className="whatsapp-test-form"
            onSubmit={handleSendTest}
            data-escape-handled-locally={hasUnsavedTestDraft ? "" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hasUnsavedTestDraft) handleResetTestForm();
            }}
          >
            <h3>{t("whatsapp.test.heading")}</h3>
            <label className="field-row">
              <span>{t("whatsapp.test.to")}</span>
              <input type="text" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={t("whatsapp.test.to.placeholder")} required />
            </label>
            {recentNumbers.length > 0 && (
              <div className="whatsapp-recent-numbers">
                <div className="whatsapp-recent-numbers-header">
                  <span className="muted small">{t("whatsapp.test.recent.heading")}</span>
                  <button type="button" className="link-button small" onClick={handleClearRecentNumbers}>
                    {t("whatsapp.test.recent.clear")}
                  </button>
                </div>
                <div className="chips">
                  {recentNumbers.map((n) => (
                    <span className="chip chip-removable" key={n}>
                      <button type="button" className="chip-text" onClick={() => handleRecentNumberClick(n)}>
                        {n}
                      </button>
                      <button
                        type="button"
                        className="chip-remove"
                        title={t("whatsapp.test.recent.remove")}
                        aria-label={t("whatsapp.test.recent.remove", { number: n })}
                        onClick={() => handleRemoveRecentNumber(n)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <label className="field-row">
              <span>{t("whatsapp.test.message")}</span>
              <input
                type="text"
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                placeholder={t("whatsapp.test.message.placeholder")}
                required
              />
            </label>
            <div className="whatsapp-attachment-field">
              {testAttachment ? (
                <span className="file-field-current">
                  {testAttachment.name}
                  <button type="button" className="link-button" disabled={sending} onClick={handleRemoveAttachment}>
                    {t("whatsapp.test.attachment.remove")}
                  </button>
                </span>
              ) : (
                <input
                  type="file"
                  aria-label={t("whatsapp.test.attachment.choose")}
                  disabled={uploadingAttachment || sending}
                  onChange={handleAttachmentChange}
                />
              )}
              {uploadingAttachment && <p className="muted small">{t("whatsapp.test.attachment.uploading")}</p>}
              {attachmentError ? <p role="alert">{attachmentError}</p> : !testAttachment && <p className="muted small">{t("entity.file.maxSize")}</p>}
            </div>
            <div className="form-actions">
              <button type="submit" disabled={sending || uploadingAttachment}>
                {sending ? t("whatsapp.test.sending") : t("whatsapp.test.send")}
              </button>
            </div>
            {sendResult && <p className={sendResult.ok ? "muted small" : "error"}>{sendResult.text}</p>}
          </form>
        )}

        <div className="whatsapp-message-log">
          <div className="whatsapp-log-header">
            <h3>
              {t("whatsapp.log.heading")}
              {messages.length > 0 && (
                <span className="muted small whatsapp-log-count">
                  {" "}
                  — {formatWhatsAppMessageCount(visibleMessages.length, messages.length, t, hasMoreMessages)}
                </span>
              )}
            </h3>
            {messages.length > 0 && (
              <div className="whatsapp-log-header-actions">
                <button type="button" className="secondary small" onClick={handleCopyLog} aria-live="polite" aria-atomic="true">
                  {copyStatus === "copied"
                    ? t("whatsapp.log.copy.copied")
                    : copyStatus === "failed"
                      ? t("whatsapp.log.copy.failed")
                      : t("whatsapp.log.copy")}
                </button>
                <button type="button" className="secondary small" onClick={handleDownloadLog}>
                  {t("whatsapp.log.download")}
                </button>
                {!readOnly && (
                  // Disabled while ANY of retry/delete/load-more is also in
                  // flight, not just clearing itself -- all four mutate the
                  // same messages state through the same messagesVersionRef
                  // guard, the identical "independent busy flags on one
                  // shared list" shape round 680 fixed for CollaboratorsPanel
                  // (mirroring HistoryPanel's own restore/delete convention).
                  // Without this, a retry/load-more fetch still in flight
                  // when Clear History commits could still pass its own
                  // version check and put already-cleared rows right back on
                  // screen.
                  <button
                    type="button"
                    className="secondary small"
                    onClick={handleClearHistory}
                    disabled={clearing || retryingId !== null || deletingId !== null || loadingMore}
                  >
                    {clearing ? t("whatsapp.log.clearing") : t("whatsapp.log.clear")}
                  </button>
                )}
              </div>
            )}
          </div>
          {retryError && (
            <p className="error" role="status">
              {retryError}
            </p>
          )}
          {deleteError && (
            <p className="error" role="status">
              {deleteError}
            </p>
          )}
          {messages.length > SEARCH_THRESHOLD && (
            <div
              className="whatsapp-log-filters"
              data-escape-handled-locally={search.length > 0 ? "" : undefined}
              onKeyDown={(e) => {
                // Round 1103: this marker used to sit on the <input> alone,
                // so useDialogFocusTrap.ts's own closest()-based Escape
                // check only protected a search while the input itself had
                // focus. Tab to the "✕ clear search" button or the
                // direction-filter <select> right next to it (both plain
                // siblings of the input inside this same div, covered by
                // neither the marker nor a key handler of their own), then
                // press Escape, and the event's own target no longer has
                // the marker as an ancestor -- the dialog's own default
                // Escape branch fired instead, silently closing the WHOLE
                // panel, exactly like clicking "Close". Moving the marker
                // to this div (an ancestor of every control inside it) and
                // handling the actual clear here too means Escape clears
                // the search and keeps the panel open no matter which of
                // the three controls currently has focus -- mirrors round
                // 1085's identical fix for GlobalSearchPanel.tsx's own
                // query box.
                if (e.key === "Escape" && search.length > 0) {
                  e.preventDefault();
                  setSearch("");
                }
              }}
            >
              <input
                type="text"
                className="whatsapp-log-search"
                placeholder={t("whatsapp.log.search.placeholder")}
                aria-label={t("whatsapp.log.search.placeholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleLogSearchKeyDown}
              />
              {search.length > 0 && (
                <button
                  type="button"
                  className="secondary small whatsapp-log-clear-search"
                  aria-label={t("whatsapp.log.search.clear")}
                  onClick={() => setSearch("")}
                >
                  ✕
                </button>
              )}
              <select
                className="whatsapp-log-direction-filter"
                aria-label={t("whatsapp.log.filter.label")}
                value={directionFilter}
                onChange={(e) => setDirectionFilter(persistWhatsAppLogFilter(projectId, userId, e.target.value as WhatsAppLogFilter))}
              >
                <option value="all">{t("whatsapp.log.filter.all")}</option>
                <option value="in">{t("whatsapp.log.filter.incoming")}</option>
                <option value="out">{t("whatsapp.log.filter.outgoing")}</option>
                <option value="failed">{t("whatsapp.log.filter.failed")}</option>
              </select>
            </div>
          )}
          {messages.length > SEARCH_THRESHOLD && !search.trim() && logRecentSearches.length > 0 && (
            <div className="whatsapp-log-search-recent">
              <div className="whatsapp-log-search-recent-header">
                <span className="muted small">{t("whatsapp.log.search.recent.heading")}</span>
                <button type="button" className="link-button small" onClick={handleClearRecentLogSearches}>
                  {t("whatsapp.log.search.recent.clear")}
                </button>
              </div>
              <div className="chips">
                {logRecentSearches.map((q) => (
                  <span className="chip chip-removable" key={q}>
                    <button type="button" className="chip-text" onClick={() => handleRecentLogSearchClick(q)}>
                      {q}
                    </button>
                    <button
                      type="button"
                      className="chip-remove"
                      title={t("whatsapp.log.search.recent.remove", { query: q })}
                      aria-label={t("whatsapp.log.search.recent.remove", { query: q })}
                      onClick={() => handleRemoveRecentLogSearch(q)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {messages.length === 0 ? (
            <p className="muted small">{t("whatsapp.log.empty")}</p>
          ) : visibleMessages.length === 0 ? (
            <p className="muted small">{t("whatsapp.log.search.noResults")}</p>
          ) : (
            <ul className="whatsapp-log-list">
              {visibleMessages.map((m) => (
                <li key={m.id} className={m.direction === "in" ? "whatsapp-log-in" : "whatsapp-log-out"}>
                  <span className="whatsapp-log-direction" aria-label={m.direction === "in" ? t("whatsapp.log.incoming") : t("whatsapp.log.outgoing")}>
                    {m.direction === "in" ? "⬇️" : "⬆️"}
                  </span>
                  {m.matchedEntityName ? (
                    <>
                      <button
                        type="button"
                        className="whatsapp-log-who whatsapp-log-who-link"
                        aria-label={t("whatsapp.log.jumpTo", { name: m.matchedLabel ?? "" })}
                        onClick={() =>
                          m.matchedRecordId != null
                            ? onJumpToRecord(m.matchedEntityName!, m.matchedRecordId)
                            : onJumpToEntity(m.matchedEntityName!)
                        }
                      >
                        <Highlighted text={m.matchedLabel!} query={search} />
                      </button>
                      <span className="whatsapp-log-entity muted small">{matchedEntityLabel(m.matchedEntityName)}</span>
                    </>
                  ) : (
                    <span className="whatsapp-log-who">
                      <Highlighted text={m.matchedLabel ?? (m.direction === "in" ? m.fromNumber : m.toNumber)} query={search} />
                    </span>
                  )}
                  <span className="whatsapp-log-body">
                    <LinkifiedBody text={m.body} query={search} />
                  </span>
                  <span className="whatsapp-log-time muted small">{new Date(m.createdAt).toLocaleString(LOCALE[lang])}</span>
                  {m.status === "failed" && (
                    <>
                      <span className="badge badge-negative">{t("whatsapp.log.failed")}</span>
                      {s === "connected" && !readOnly && (
                        // Disabled while ANY retry is in flight, not just this row's
                        // own (same convention as HistoryPanel's restore/delete and
                        // AutomationsPanel's toggle/delete buttons): retryingId is a
                        // single panel-wide slot, so starting a second row's retry
                        // while the first is still pending overwrites it and silently
                        // re-enables the first row's button mid-request -- a second
                        // click there fires a real, second sendWhatsAppMessage to the
                        // same customer, not just a harmless duplicate state update.
                        // Also cross-gated against delete/clear/load-more -- all four
                        // read/write the same messages state through messagesVersionRef,
                        // so a delete or clear committing while this retry's own
                        // listWhatsAppMessages fetch is still in flight can make that
                        // fetch's version check fail, silently dropping the
                        // just-retried message from the on-screen log.
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => handleRetry(m)}
                          disabled={retryingId !== null || deletingId !== null || clearing || loadingMore}
                        >
                          {retryingId === m.id ? t("whatsapp.log.retrying") : t("whatsapp.log.retry")}
                        </button>
                      )}
                    </>
                  )}
                  {m.direction === "in" && s === "connected" && !readOnly && (
                    <button type="button" className="secondary small" disabled={sending} onClick={() => handleReplyToMessage(m)}>
                      {t("whatsapp.log.reply")}
                    </button>
                  )}
                  {/* Round 921: a brand-new contact's first message (no
                      matchedEntityName at all) previously had no path to
                      becoming a real record -- see onCreateRecordFromMessage's
                      own doc comment above. Doesn't require s === "connected"
                      the way Reply does, since creating a record from an
                      already-stored message needs no live connection at all. */}
                  {m.direction === "in" && !m.matchedEntityName && phoneFieldTarget && !readOnly && (
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => onCreateRecordFromMessage(phoneFieldTarget.entityName, phoneFieldTarget.fieldName, m.fromNumber)}
                    >
                      {t("whatsapp.log.createRecord")}
                    </button>
                  )}
                  {!readOnly && (
                  // Same cross-gate as the retry/clear/load-more buttons --
                  // deleting one message while any of the other three is
                  // still reading/writing messages via messagesVersionRef
                  // can resurrect this exact message once that other
                  // operation's own stale read lands.
                  <button
                    type="button"
                    className="whatsapp-log-delete"
                    aria-label={t("whatsapp.log.deleteOne")}
                    onClick={() => handleDeleteMessage(m)}
                    disabled={deletingId !== null || retryingId !== null || clearing || loadingMore}
                  >
                    {deletingId === m.id ? "…" : "🗑️"}
                  </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {hasMoreMessages && (
            <div className="whatsapp-log-load-more">
              {/* Same cross-gate as retry/delete/clear -- loading an older
                  page shares the same messagesVersionRef guard, so it can
                  race against them exactly the same way. */}
              <button
                type="button"
                className="secondary small"
                onClick={handleLoadMore}
                disabled={loadingMore || retryingId !== null || deletingId !== null || clearing}
              >
                {loadingMore ? t("whatsapp.log.loadingMore") : t("whatsapp.log.loadMore")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
