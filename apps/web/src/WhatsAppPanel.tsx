import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import {
  clearWhatsAppMessages,
  connectWhatsApp,
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
}) {
  const { t, lang } = useTranslation();
  const [status, setStatus] = useState<WhatsAppStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessageLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [directionFilter, setDirectionFilter] = useState<WhatsAppLogFilter>("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();
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
   * button silently do nothing (see docs/roadmap.md).
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
            const { messages } = await listWhatsAppMessages(projectId);
            setMessages(messages);
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

  useEffect(() => {
    getWhatsAppStatus(projectId)
      .then((s) => {
        setStatus(s);
        if (s.status === "connecting" || s.status === "qr") startPolling();
        if (s.status === "connected") {
          listWhatsAppMessages(projectId).then(({ messages }) => setMessages(messages)).catch(() => {});
          startConnectedPolling();
        }
      })
      .catch((err) => setLoadError((err as Error).message));
    return () => {
      stopPolling();
      stopConnectedPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setSendResult(null);
    try {
      const result = await sendWhatsAppMessage(projectId, testTo, testMessage);
      setSendResult(
        result.ok ? { ok: true, text: t("whatsapp.send.success") } : { ok: false, text: result.error ?? t("whatsapp.send.genericError") },
      );
      const { messages } = await listWhatsAppMessages(projectId);
      setMessages(messages);
    } catch (err) {
      setSendResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
    }
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
      const { messages } = await listWhatsAppMessages(projectId);
      setMessages(messages);
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      setRetryingId(null);
    }
  }

  function handleDownloadLog() {
    downloadWhatsAppLog(formatWhatsAppLog(messages, projectName, lang, t), projectName);
  }

  async function handleClearHistory() {
    if (!window.confirm(t("whatsapp.log.confirmClear"))) return;
    setClearing(true);
    try {
      await clearWhatsAppMessages(projectId);
      setMessages([]);
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
        {loadError && <p className="error">{loadError}</p>}

        {s === "disconnected" && (
          <div className="whatsapp-connect-box">
            {status?.phoneNumber && <p className="muted small">{t("whatsapp.lastConnected", { phone: status.phoneNumber })}</p>}
            <button type="button" onClick={handleConnect} disabled={connecting}>
              {connecting ? t("whatsapp.connect.connecting") : t("whatsapp.connect.button")}
            </button>
            {status?.error && <p className="error">{status.error}</p>}
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
            {status?.error && <p className="error">{status.error}</p>}
          </div>
        )}

        {s === "connected" && (
          <div className="whatsapp-connected-box">
            <p className="whatsapp-connected-status">{t("whatsapp.connected.as", { phone: status?.phoneNumber ?? "" })}</p>
            <button type="button" className="secondary small" onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting ? t("whatsapp.connected.disconnecting") : t("whatsapp.connected.disconnect")}
            </button>
          </div>
        )}

        {s === "connected" && (
          <form className="whatsapp-test-form" onSubmit={handleSendTest}>
            <h3>{t("whatsapp.test.heading")}</h3>
            <label className="field-row">
              <span>{t("whatsapp.test.to")}</span>
              <input type="text" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={t("whatsapp.test.to.placeholder")} required />
            </label>
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
                  — {formatWhatsAppMessageCount(visibleMessages.length, messages.length, t)}
                </span>
              )}
            </h3>
            {messages.length > 0 && (
              <div className="whatsapp-log-header-actions">
                <button type="button" className="secondary small" onClick={handleDownloadLog}>
                  {t("whatsapp.log.download")}
                </button>
                <button type="button" className="secondary small" onClick={handleClearHistory} disabled={clearing}>
                  {clearing ? t("whatsapp.log.clearing") : t("whatsapp.log.clear")}
                </button>
              </div>
            )}
          </div>
          {retryError && <p className="error">{retryError}</p>}
          {messages.length > SEARCH_THRESHOLD && (
            <div className="whatsapp-log-filters">
              <input
                type="text"
                className="whatsapp-log-search"
                placeholder={t("whatsapp.log.search.placeholder")}
                aria-label={t("whatsapp.log.search.placeholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="whatsapp-log-direction-filter"
                aria-label={t("whatsapp.log.filter.label")}
                value={directionFilter}
                onChange={(e) => setDirectionFilter(e.target.value as WhatsAppLogFilter)}
              >
                <option value="all">{t("whatsapp.log.filter.all")}</option>
                <option value="in">{t("whatsapp.log.filter.incoming")}</option>
                <option value="out">{t("whatsapp.log.filter.outgoing")}</option>
                <option value="failed">{t("whatsapp.log.filter.failed")}</option>
              </select>
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
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
