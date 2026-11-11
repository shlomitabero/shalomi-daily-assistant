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

  /**
   * Round 1588: this form's two type="email" inputs and its password field
   * still relied on native HTML5 constraint-validation popups -- the same
   * bug class round 342 fixed for EntityPanel and round 1587 fixed for
   * AuthScreen (see ChangePasswordPanel.tsx's own identical doc comment).
   * `noValidate` on the form (added below) suppresses only the automatic
   * popup; checkValidity() stays intact, so this reuses it exactly the way
   * AuthScreen.tsx's findFirstInvalidField/describeInvalidField already do.
   */
  function findFirstInvalidField(form: HTMLFormElement): HTMLInputElement | null {
    for (const el of Array.from(form.elements)) {
      if (el.tagName === "INPUT" && !(el as HTMLInputElement).checkValidity()) return el as HTMLInputElement;
    }
    return null;
  }

  function describeInvalidField(input: HTMLInputElement): string {
    if (input.validity.valueMissing) return t("auth.form.requiredField");
    if (input.validity.tooShort) return t("auth.form.passwordTooShort");
    if (input.validity.typeMismatch) return t("auth.form.invalidEmail");
    return t("auth.form.requiredField");
  }

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
    // reentrancy gap rounds 1363-1366 closed elsewhere. (Round 1610 later
    // added x-idempotency-key protection to changeEmail/PATCH /auth/email
    // itself, closing the server-side gap this comment used to describe
    // here -- this guard is still needed independently, since busy only
    // disables the button visually and a second Enter-key submit before
    // re-render would otherwise still fire a second, now-idempotency-
    // deduped but still wasted request.)
    if (busy) return;
    setError(null);
    const invalid = findFirstInvalidField(e.currentTarget as HTMLFormElement);
    if (invalid) {
      setError(describeInvalidField(invalid));
      invalid.focus();
      return;
    }
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
            noValidate
            data-escape-handled-locally={hasUnsavedDraft ? "" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hasUnsavedDraft) handleResetForm();
            }}
          >
            <label className="field-row">
              <span>{t("changeEmail.newEmail")}</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" maxLength={320} />
            </label>
            <label className="field-row">
              <span>{t("changeEmail.confirmEmail")}</span>
              <input type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} required autoComplete="email" maxLength={320} />
            </label>
            <label className="field-row">
              <span>{t("changeEmail.currentPassword")}</span>
              <PasswordInput value={currentPassword} onChange={setCurrentPassword} required maxLength={256} autoComplete="current-password" />
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
