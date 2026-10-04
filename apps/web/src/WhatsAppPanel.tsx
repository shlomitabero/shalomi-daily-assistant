import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import {
  clearWhatsAppMessages,
  connectWhatsApp,
  deleteWhatsAppMessage,
  disconnectWhatsApp,
  getWhatsAppStatus,
  listWhatsAppMessages,
  sendWhatsAppMessage,
  type WhatsAppMessageLogEntry,
  type WhatsAppStatusView,
} from "./api.js";
import { splitHighlightSegments } from "./entityFormatting.js";
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
import { setWhatsAppLastSeenId } from "./whatsappUnread.js";

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

export function WhatsAppPanel({
  projectId,
  projectName,
  onClose,
  onJumpToEntity,
  onJumpToRecord,
  prefillTo,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
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
  /** A phone number to open the test-send form pre-filled with, e.g. from an EntityPanel row's "Send WhatsApp" action -- the reverse direction of onJumpToRecord above. App.tsx only ever mounts this panel fresh (conditional render, not a persistent one), so a plain lazy useState initializer is enough; no effect is needed to react to a later change while already mounted. */
  prefillTo?: string | null;
}) {
  const { t, lang } = useTranslation();
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
  const [recentNumbers, setRecentNumbers] = useState<string[]>(() => getRecentWhatsAppNumbers(projectId));
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
  const [logRecentSearches, setLogRecentSearches] = useState<string[]>(() => getWhatsAppLogRecentSearches(projectId));
  // Lazy initializer, same shape as recentNumbers just above -- this panel
  // unmounts entirely on close (see App.tsx's `{showWhatsApp && <WhatsAppPanel .../>}`),
  // so a fresh mount always re-reads the real persisted choice for this
  // project rather than needing a separate load effect.
  const [directionFilter, setDirectionFilter] = useState<WhatsAppLogFilter>(() => getWhatsAppLogFilter(projectId));
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
          const { messages: freshPage } = await listWhatsAppMessages(projectId);
          if (cancelled) return;
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const newOnes = freshPage.filter((m) => !existingIds.has(m.id));
            return newOnes.length === 0 ? prev : [...newOnes, ...prev];
          });
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
            const { messages, hasMore } = await listWhatsAppMessages(projectId);
            setMessages(messages);
            setHasMoreMessages(hasMore);
            startConnectedPolling();
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
        setStatus(s);
        if (s.status === "connecting" || s.status === "qr") startPolling();
        if (s.status === "connected") {
          listWhatsAppMessages(projectId)
            .then(({ messages, hasMore }) => {
              setMessages(messages);
              setHasMoreMessages(hasMore);
            })
            .catch(() => {});
          startConnectedPolling();
        }
      })
      .catch((err) => setInitialLoadError((err as Error).message));
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
   * Keeps the "last seen" marker (see whatsappUnread.ts) in sync with
   * whatever's actually loaded here, from every source that updates
   * `messages` -- the initial mount fetch, the connected-poll's own live
   * refresh (round 288), sending/retrying a test message, all of them.
   * The topbar's own unread badge (App.tsx) is what actually reads this
   * marker; this panel only ever writes it. Deliberately keyed on
   * `messages` itself (not just its length) so a message removed via
   * "delete" or "clear" -- which never advances how far the owner has
   * genuinely read -- doesn't spuriously bump the marker either.
   */
  useEffect(() => {
    if (messages.length > 0) setWhatsAppLastSeenId(projectId, messages[0].id);
  }, [projectId, messages]);

  async function handleConnect() {
    setConnecting(true);
    setLoadError(null);
    try {
      const next = await connectWhatsApp(projectId);
      setStatus(next);
      startPolling();
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
      setStatus(next);
      setMessages([]);
      setHasMoreMessages(false);
    } catch (err) {
      setLoadError((err as Error).message);
      // The disconnect request itself failed -- nothing changed
      // server-side, so if we were connected before this attempt we still
      // are. stopConnectedPolling() above already killed the background
      // poll that would notice WhatsApp dropping the link on its own;
      // without resuming it here, a single failed disconnect attempt
      // silently leaves an otherwise-still-connected panel with no
      // monitoring at all until the user closes and reopens it.
      if (wasConnected) startConnectedPolling();
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
    setRecentNumbers(addRecentWhatsAppNumber(projectId, testTo));
    try {
      const result = await sendWhatsAppMessage(projectId, testTo, testMessage);
      setSendResult(
        result.ok ? { ok: true, text: t("whatsapp.send.success") } : { ok: false, text: result.error ?? t("whatsapp.send.genericError") },
      );
      const { messages, hasMore } = await listWhatsAppMessages(projectId);
      setMessages(messages);
      setHasMoreMessages(hasMore);
    } catch (err) {
      setSendResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
    }
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
   */
  function handleReplyToMessage(m: WhatsAppMessageLogEntry) {
    setTestTo(m.fromNumber);
  }

  function handleRemoveRecentNumber(n: string) {
    setRecentNumbers(removeRecentWhatsAppNumber(projectId, n));
  }

  function handleClearRecentNumbers() {
    clearRecentWhatsAppNumbers(projectId);
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
    if (e.key === "Enter" && search.trim()) {
      setLogRecentSearches(addWhatsAppLogRecentSearch(projectId, search));
    } else if (e.key === "Escape" && search.length > 0) {
      e.preventDefault();
      setSearch("");
    }
  }
  function handleRecentLogSearchClick(query: string) {
    setSearch(query);
  }
  function handleRemoveRecentLogSearch(query: string) {
    setLogRecentSearches(removeWhatsAppLogRecentSearch(projectId, query));
  }
  function handleClearRecentLogSearches() {
    clearWhatsAppLogRecentSearches(projectId);
    setLogRecentSearches([]);
  }

  async function handleRetry(m: WhatsAppMessageLogEntry) {
    setRetryingId(m.id);
    setRetryError(null);
    try {
      const result = await sendWhatsAppMessage(projectId, m.toNumber, m.body);
      // A retry can fail for a reason that never reaches insertWhatsAppMessage
      // on the server (e.g. WhatsApp disconnected since the original failed
      // send) -- in that case the message log is unchanged, so show the
      // reason directly instead of leaving the button silently reset.
      if (!result.ok) setRetryError(result.error ?? t("whatsapp.log.retryError"));
      const { messages, hasMore } = await listWhatsAppMessages(projectId);
      setMessages(messages);
      setHasMoreMessages(hasMore);
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      setRetryingId(null);
    }
  }

  /**
   * Appends the next older page rather than replacing state, since
   * listWhatsAppMessages' offset is server-side pagination over a
   * DESC-ordered log -- messages.length as the offset means "everything
   * already showing," so this always asks for the page right after what's
   * currently loaded, regardless of how many load-more clicks came before.
   */
  async function handleLoadMore() {
    setLoadingMore(true);
    try {
      const { messages: older, hasMore } = await listWhatsAppMessages(projectId, messages.length);
      setMessages((prev) => [...prev, ...older]);
      setHasMoreMessages(hasMore);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleDownloadLog() {
    downloadWhatsAppLog(formatWhatsAppLog(messages, projectName, lang, t), projectName);
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
      await navigator.clipboard.writeText(formatWhatsAppLog(messages, projectName, lang, t));
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
    try {
      await deleteWhatsAppMessage(projectId, m.id);
      setMessages((prev) => prev.filter((msg) => msg.id !== m.id));
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
      setMessages([]);
      setHasMoreMessages(false);
      setRetryError(null);
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
        {loadError && (
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
            <button type="button" onClick={handleConnect} disabled={connecting}>
              {connecting ? t("whatsapp.connect.connecting") : t("whatsapp.connect.button")}
            </button>
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
            {status?.error && (
              <p className="error" role="status">
                {status.error}
              </p>
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
              <button type="button" className="secondary small" onClick={handleDisconnect} disabled={disconnecting}>
                {disconnecting ? t("whatsapp.connected.disconnecting") : t("whatsapp.connected.disconnect")}
              </button>
            </div>
          </div>
        )}

        {s === "connected" && (
          <form className="whatsapp-test-form" onSubmit={handleSendTest}>
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
            <div className="form-actions">
              <button type="submit" disabled={sending}>
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
                <button type="button" className="secondary small" onClick={handleClearHistory} disabled={clearing}>
                  {clearing ? t("whatsapp.log.clearing") : t("whatsapp.log.clear")}
                </button>
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
            <div className="whatsapp-log-filters">
              <input
                type="text"
                className="whatsapp-log-search"
                placeholder={t("whatsapp.log.search.placeholder")}
                aria-label={t("whatsapp.log.search.placeholder")}
                value={search}
                data-escape-handled-locally={search.length > 0 ? "" : undefined}
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
                onChange={(e) => setDirectionFilter(persistWhatsAppLogFilter(projectId, e.target.value as WhatsAppLogFilter))}
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
                  ) : (
                    <span className="whatsapp-log-who">
                      <Highlighted text={m.matchedLabel ?? (m.direction === "in" ? m.fromNumber : m.toNumber)} query={search} />
                    </span>
                  )}
                  <span className="whatsapp-log-body">
                    <Highlighted text={m.body} query={search} />
                  </span>
                  <span className="whatsapp-log-time muted small">{new Date(m.createdAt).toLocaleString(LOCALE[lang])}</span>
                  {m.status === "failed" && (
                    <>
                      <span className="badge badge-negative">{t("whatsapp.log.failed")}</span>
                      {s === "connected" && (
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => handleRetry(m)}
                          disabled={retryingId === m.id}
                        >
                          {retryingId === m.id ? t("whatsapp.log.retrying") : t("whatsapp.log.retry")}
                        </button>
                      )}
                    </>
                  )}
                  {m.direction === "in" && s === "connected" && (
                    <button type="button" className="secondary small" onClick={() => handleReplyToMessage(m)}>
                      {t("whatsapp.log.reply")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="whatsapp-log-delete"
                    aria-label={t("whatsapp.log.deleteOne")}
                    onClick={() => handleDeleteMessage(m)}
                    disabled={deletingId === m.id}
                  >
                    {deletingId === m.id ? "…" : "🗑️"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hasMoreMessages && (
            <div className="whatsapp-log-load-more">
              <button type="button" className="secondary small" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? t("whatsapp.log.loadingMore") : t("whatsapp.log.loadMore")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
