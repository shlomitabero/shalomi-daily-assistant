import { useState } from "react";
import { changePassword } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

/**
 * There was previously no way to change your account password once
 * signed up. Requires the current password (matching the API route's own
 * requirement), and a client-side confirm-new-password field to catch a
 * typo before it's sent -- a mismatch never reaches the server.
 */
export function ChangePasswordPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(t("changePassword.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <div className="history-header">
          <h2 id="change-password-title">{t("changePassword.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>

        {done ? (
          <p className="success">{t("changePassword.success")}</p>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label className="field-row">
              <span>{t("changePassword.current")}</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </label>
            <label className="field-row">
              <span>{t("changePassword.new")}</span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label className="field-row">
              <span>{t("changePassword.confirm")}</span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            {error && <p className="error small">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? t("changePassword.busy") : t("changePassword.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
