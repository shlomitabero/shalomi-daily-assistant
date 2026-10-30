import { useState } from "react";
import { changePassword } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { PasswordInput } from "./PasswordInput.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

/**
 * There was previously no way to change your account password once
 * signed up. Requires the current password (matching the API route's own
 * requirement), and a client-side confirm-new-password field to catch a
 * typo before it's sent -- a mismatch never reaches the server.
 */
export function ChangePasswordPanel({ onClose }: { onClose: () => void }) {
  const { t, lang } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  /**
   * Round 1245: this whole panel is a real dialog (useDialogFocusTrap
   * above), whose own Escape handler closes it entirely unless the event's
   * target sits under data-escape-handled-locally -- every other form on
   * this exact screen with real draft content already opts out this way
   * (CollaboratorsPanel.tsx's round-1062 invite form, AutomationsPanel.tsx's
   * round-1056 create/edit form, WhatsAppPanel.tsx's round-1061 test-send
   * form), but this one never did, despite holding the single
   * highest-stakes typed draft in the app -- a real new password typed
   * twice, plus the current password. The whole component unmounts on
   * close (App.tsx renders it conditionally), so the typed values are
   * destroyed, not just visually cleared.
   */
  const hasUnsavedDraft = currentPassword.trim() !== "" || newPassword.trim() !== "" || confirmPassword.trim() !== "";
  // Round 1331: the far more common way this exact draft gets lost isn't
  // Escape (guarded above) but a tab close/refresh/navigation away.
  // Excludes `done`, mirroring ChangeEmailPanel.tsx's own identical
  // reasoning -- the fields stay filled after a successful change, with
  // nothing left to warn about.
  useBeforeUnloadWarning(!done && hasUnsavedDraft);

  function handleResetForm() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(t("changePassword.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword, lang);
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
          <p className="success" role="status">
            {t("changePassword.success")}
          </p>
        ) : (
          <form
            className="auth-form"
            onSubmit={handleSubmit}
            data-escape-handled-locally={hasUnsavedDraft ? "" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hasUnsavedDraft) handleResetForm();
            }}
          >
            <label className="field-row">
              <span>{t("changePassword.current")}</span>
              <PasswordInput value={currentPassword} onChange={setCurrentPassword} required autoComplete="current-password" />
            </label>
            <label className="field-row">
              <span>{t("changePassword.new")}</span>
              <PasswordInput value={newPassword} onChange={setNewPassword} required minLength={8} autoComplete="new-password" showStrength />
            </label>
            <label className="field-row">
              <span>{t("changePassword.confirm")}</span>
              <PasswordInput value={confirmPassword} onChange={setConfirmPassword} required minLength={8} autoComplete="new-password" />
            </label>
            {error && (
              <p className="error small" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? t("changePassword.busy") : t("changePassword.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
