import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n/LanguageContext.js";
import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppStatus,
  listWhatsAppMessages,
  sendWhatsAppMessage,
  type WhatsAppMessageLogEntry,
  type WhatsAppStatusView,
} from "./api.js";

const POLL_INTERVAL_MS = 1500;

export function WhatsAppPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WhatsAppStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessageLogEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const next = await getWhatsAppStatus(projectId);
        setStatus(next);
        if (next.status === "connected" || next.status === "disconnected") {
          stopPolling();
          if (next.status === "connected") {
            const { messages } = await listWhatsAppMessages(projectId);
            setMessages(messages);
          }
        }
      } catch {
        stopPolling();
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
        }
      })
      .catch((err) => setLoadError((err as Error).message));
    return () => stopPolling();
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
    setDisconnecting(true);
    stopPolling();
    try {
      const next = await disconnectWhatsApp(projectId);
      setStatus(next);
      setMessages([]);
    } catch (err) {
      setLoadError((err as Error).message);
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

  const s = status?.status ?? "disconnected";

  return (
    <div className="history-overlay">
      <div className="history-panel whatsapp-panel">
        <div className="history-header">
          <h2>{t("whatsapp.title")}</h2>
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
          <h3>{t("whatsapp.log.heading")}</h3>
          {messages.length === 0 ? (
            <p className="muted small">{t("whatsapp.log.empty")}</p>
          ) : (
            <ul className="whatsapp-log-list">
              {messages.map((m) => (
                <li key={m.id} className={m.direction === "in" ? "whatsapp-log-in" : "whatsapp-log-out"}>
                  <span className="whatsapp-log-direction">{m.direction === "in" ? "⬇️" : "⬆️"}</span>
                  <span className="whatsapp-log-who">{m.matchedLabel ?? (m.direction === "in" ? m.fromNumber : m.toNumber)}</span>
                  <span className="whatsapp-log-body">{m.body}</span>
                  {m.status === "failed" && <span className="badge badge-negative">{t("whatsapp.log.failed")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
