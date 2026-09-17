import { useEffect, useState } from "react";
import {
  getWhatsAppSettings,
  listWhatsAppMessages,
  saveWhatsAppSettings,
  sendWhatsAppMessage,
  type WhatsAppMessageLogEntry,
  type WhatsAppSettingsView,
} from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * Real, two-way WhatsApp sync is only possible through Meta's official
 * WhatsApp Business Platform -- there is no other supported way for a
 * third-party app to send or receive WhatsApp messages, and no way for
 * Forge AI to create that account on the project owner's behalf. This
 * panel is the real integration point: it stores the owner's own
 * Meta-issued credentials, shows the exact webhook URL + verify token
 * they need to paste into Meta's console, sends a real test message
 * through the Cloud API once configured, and lists messages actually
 * received through the webhook (matched to an entity record by phone
 * number when possible).
 */
export function WhatsAppPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<WhatsAppSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [messages, setMessages] = useState<WhatsAppMessageLogEntry[]>([]);

  useEffect(() => {
    getWhatsAppSettings(projectId)
      .then((s) => {
        setSettings(s);
        setPhoneNumberId(s.phoneNumberId ?? "");
      })
      .catch((err) => setLoadError((err as Error).message));
    listWhatsAppMessages(projectId)
      .then(({ messages }) => setMessages(messages))
      .catch(() => {
        // The message log is a nice-to-have -- a failure here shouldn't block the settings view.
      });
  }, [projectId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await saveWhatsAppSettings(projectId, {
        phoneNumberId,
        ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      });
      setSettings(result);
      setAccessToken("");
      setSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setSendResult(null);
    try {
      const result = await sendWhatsAppMessage(projectId, testTo, testMessage);
      setSendResult(
        result.ok
          ? { ok: true, text: t("whatsapp.send.success") }
          : { ok: false, text: result.error ?? t("whatsapp.send.genericError") },
      );
      const { messages } = await listWhatsAppMessages(projectId);
      setMessages(messages);
    } catch (err) {
      setSendResult({ ok: false, text: (err as Error).message });
    } finally {
      setSending(false);
    }
  }

  async function handleCopyWebhookUrl() {
    if (!settings) return;
    try {
      await navigator.clipboard.writeText(settings.webhookUrl);
    } catch {
      // Clipboard access can be denied; the field is still selectable/copyable by hand.
    }
  }

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

        <form className="whatsapp-settings-form" onSubmit={handleSave}>
          <label className="field-row">
            <span>{t("whatsapp.phoneNumberId")}</span>
            <input
              type="text"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder={t("whatsapp.phoneNumberId.placeholder")}
              required
            />
          </label>
          <label className="field-row">
            <span>{t("whatsapp.accessToken")}</span>
            <input
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={settings?.configured ? (settings.accessTokenMasked ?? "") : t("whatsapp.accessToken.placeholder")}
            />
            {settings?.configured && <span className="muted small">{t("whatsapp.accessToken.keepHint")}</span>}
          </label>
          <div className="form-actions">
            <button type="submit" disabled={saving}>
              {saving ? t("whatsapp.saving") : t("whatsapp.save")}
            </button>
          </div>
          {saveError && <p className="error">{saveError}</p>}
          {saved && !saveError && <p className="muted small">{t("whatsapp.saved")}</p>}
        </form>

        {settings?.configured && (
          <div className="whatsapp-webhook-info">
            <h3>{t("whatsapp.webhook.heading")}</h3>
            <p className="muted small">{t("whatsapp.webhook.description")}</p>
            <div className="whatsapp-webhook-field">
              <span className="muted small">{t("whatsapp.webhook.urlLabel")}</span>
              <div className="whatsapp-webhook-value-row">
                <input type="text" readOnly value={settings.webhookUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="secondary small" onClick={handleCopyWebhookUrl}>
                  {t("whatsapp.webhook.copy")}
                </button>
              </div>
            </div>
            <div className="whatsapp-webhook-field">
              <span className="muted small">{t("whatsapp.webhook.verifyTokenLabel")}</span>
              <input type="text" readOnly value={settings.verifyToken ?? ""} onFocus={(e) => e.target.select()} />
            </div>
          </div>
        )}

        {settings?.configured && (
          <form className="whatsapp-test-form" onSubmit={handleSendTest}>
            <h3>{t("whatsapp.test.heading")}</h3>
            <label className="field-row">
              <span>{t("whatsapp.test.to")}</span>
              <input
                type="text"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder={t("whatsapp.test.to.placeholder")}
                required
              />
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
