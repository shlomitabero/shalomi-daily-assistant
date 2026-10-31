import { useState } from "react";
import type { User } from "@forge/shared";
import { changeEmail } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { PasswordInput } from "./PasswordInput.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

/**
 * There was previously no way to change your account's own login email --
 * a signup typo, or an email provider becoming inaccessible, left the only
 * "fix" as deleting the whole account (cascading away every owned
 * project) and re-registering from scratch. It's also the one piece of
 * identifying information CollaboratorsPanel/addCollaborator match a
 * collaborator invite against by exact address, so a stale email on your
 * own account silently broke being found or re-invited correctly too.
 * Mirrors ChangePasswordPanel.tsx's own shape exactly: requires the
 * current password (matching the API route's own requirement), a
 * client-side confirm-new-email field to catch a typo before it's sent --
 * arguably even more important here than for a password, since a typo'd
 * email could lock you out of a future password-reset flow with no
 * confirmation ever landing anywhere -- and reports the result here via
 * the shared onChanged callback so the caller can update its own held
 * `user` state, the same way CollaboratorsPanel's onOwnerTransferred
 * already does for a project.
 */
export function ChangeEmailPanel({ currentEmail, onClose, onChanged }: { currentEmail: string; onClose: () => void; onChanged: (user: User) => void }) {
  const { t, lang } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [email, setEmail] = useState(currentEmail);
  const [confirmEmail, setConfirmEmail] = useState(currentEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  /**
   * Round 1245: the same gap round 1062/1056/1061 already fixed for
   * CollaboratorsPanel/AutomationsPanel/WhatsAppPanel -- this dialog's own
   * Escape handler (useDialogFocusTrap) closes the whole panel unless the
   * event's target sits under data-escape-handled-locally, and this form
   * never opted out despite holding a typed new login email (twice) plus
   * the current password. Compares email/confirmEmail against
   * `currentEmail`, not against "", since both fields start pre-filled
   * with it -- an untouched field must not count as a draft worth saving.
   */
  const hasUnsavedDraft = currentPassword.trim() !== "" || email.trim() !== currentEmail || confirmEmail.trim() !== currentEmail;
  // Round 1331: the far more common way this exact draft gets lost isn't
  // Escape (guarded above) but a tab close/refresh/navigation away.
  // Excludes `done` -- the fields are deliberately left filled after a
  // successful change (the success message replaces the form, but the
  // state isn't reset), so there is nothing left to warn about by then.
  useBeforeUnloadWarning(!done && hasUnsavedDraft);

  function handleResetForm() {
    setCurrentPassword("");
    setEmail(currentEmail);
    setConfirmEmail(currentEmail);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Round 1367: busy already disabled the submit button, but
    // handleSubmit itself never checked it -- the same own-click
    // reentrancy gap rounds 1363-1366 closed elsewhere. Worse here than
    // most of those: changeEmail (api.ts) sends no x-idempotency-key at
    // all (unlike changePassword/resetPassword/deleteAccount), so a fast
    // double-click firing two independent PATCH requests isn't even
    // idempotency-protected server-side.
    if (busy) return;
    setError(null);
    // Round 1205: mirrors CollaboratorsPanel's own email-comparison
    // convention (c.email.toLowerCase() === trimmed.toLowerCase()) and the
    // server's own ChangeEmailSchema, which normalizes with .toLowerCase()
    // before ever comparing or storing it -- a raw, exact-case, untrimmed
    // comparison here could reject two fields the server would treat as
    // identical (e.g. "Dana@Example.com" vs "dana@example.com", or a
    // trailing space from autofill/paste), blocking a perfectly valid
    // change with a false "don't match" error.
    const newEmail = email.trim();
    const confirmed = confirmEmail.trim();
    if (newEmail.toLowerCase() !== confirmed.toLowerCase()) {
      setError(t("changeEmail.mismatch"));
      return;
    }
    setBusy(true);
    try {
      const { user } = await changeEmail(currentPassword, newEmail, lang);
      onChanged(user);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="change-email-title">
        <div className="history-header">
          <h2 id="change-email-title">{t("changeEmail.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>

        {done ? (
          <p className="success" role="status">
            {t("changeEmail.success")}
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
              <span>{t("changeEmail.newEmail")}</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label className="field-row">
              <span>{t("changeEmail.confirmEmail")}</span>
              <input type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label className="field-row">
              <span>{t("changeEmail.currentPassword")}</span>
              <PasswordInput value={currentPassword} onChange={setCurrentPassword} required autoComplete="current-password" />
            </label>
            {error && (
              <p className="error small" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? t("changeEmail.busy") : t("changeEmail.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
