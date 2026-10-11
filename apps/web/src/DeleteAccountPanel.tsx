import { useEffect, useState } from "react";
import { deleteAccount, listMyProjectIds } from "./api.js";
import { formatDeleteAccountSummary } from "./deleteAccountSummary.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

/**
 * Real, permanent self-service account deletion -- there was previously no
 * way to actually leave; the account and every project it owned just sat
 * there forever. Given how much more severe and irreversible this is than
 * anything else a plain window.confirm gates elsewhere in this app (a
 * single record, a checkpoint), the guard here is stronger: typing the
 * account's own email address exactly, not just clicking a confirm button.
 */
export function DeleteAccountPanel({
  email,
  userId,
  onClose,
  onDeleted,
}: {
  email: string;
  userId: string;
  onClose: () => void;
  onDeleted: (ownedProjectIds: string[], sharedProjectIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectSummary, setProjectSummary] = useState<{ owned: number; shared: number } | null>(null);
  // The same real project ids projectSummary's own "owned" count is derived
  // from, kept around (round 403) so a successful delete can hand them back
  // to App.tsx -- the server deletes every one of these the same way
  // handleDeleteProject/handleBulkDeleteProjects do, but has no way to also
  // sweep this browser's own localStorage preference stores for them
  // (projectPreferenceCleanup.ts); App.tsx needs the actual ids, not just
  // the count, to do that itself.
  const [ownedProjectIds, setOwnedProjectIds] = useState<string[]>([]);
  // Round 423: DELETE /auth/account also calls removeAllCollaborationsForUser
  // server-side (apps/api/src/routes/auth.ts), revoking this account's
  // access to every project it merely collaborates on -- the exact same
  // "this browser can never reach this project again" event round 404's
  // own "leave project" fix already sweeps purgeProjectPreferences for.
  // Round 403 only ever collected/passed the *owned* ids (the ones actually
  // deleted), so every shared project's own localStorage entries across all
  // eighteen projectId-keyed stores sat here forever, unlike the single-
  // project "leave" path.
  const [sharedProjectIds, setSharedProjectIds] = useState<string[]>([]);
  // The mount-time listMyProjectIds() fetch below and handleSubmit are two
  // independent, uncoordinated consumers of ownedProjectIds/sharedProjectIds:
  // nothing ties submission to that fetch having settled. If the user
  // types/pastes the confirmation email and submits before it resolves (a
  // real network round trip -- entirely plausible if the email is already in
  // a password manager or clipboard), handleSubmit would read the still-
  // initial [] arrays and hand them to onDeleted even though deleteAccount()
  // genuinely deleted real owned/shared projects server-side, silently
  // skipping purgeProjectPreferences for all of them in App.tsx (round 542).
  // Deliberately separate from projectSummary (which stays null on a FAILED
  // fetch too, for display purposes) so a fetch failure never permanently
  // blocks the user from deleting their own account.
  const [idsFetchSettled, setIdsFetchSettled] = useState(false);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  // Fetches the real project id lists itself (rather than trusting App.tsx's
  // own myProjects, which is only ever populated while `view === "home"` --
  // this panel can just as easily be opened from a project's own preview
  // screen, where myProjects would still be empty), so the warning's own
  // project count is accurate regardless of which screen this was opened
  // from. Uses listMyProjectIds, not listProjects: the latter silently drops
  // any project whose stored spec no longer parses against today's schema
  // (a real, expected case for an older project), which would leave that
  // project's own localStorage preference entries un-swept forever once
  // this account -- the only one that could ever reach them again -- is
  // gone (see listMyProjectIds' own doc comment).
  useEffect(() => {
    listMyProjectIds()
      .then(({ ownedProjectIds, sharedProjectIds }) => {
        setProjectSummary({ owned: ownedProjectIds.length, shared: sharedProjectIds.length });
        setOwnedProjectIds(ownedProjectIds);
        setSharedProjectIds(sharedProjectIds);
      })
      .catch(() => setProjectSummary(null))
      .finally(() => setIdsFetchSettled(true));
  }, [userId]);

  const canSubmit = confirmText.trim().toLowerCase() === email.toLowerCase();
  const summaryText = projectSummary ? formatDeleteAccountSummary(projectSummary.owned, projectSummary.shared, t) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !idsFetchSettled) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      onDeleted(ownedProjectIds, sharedProjectIds);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
        <div className="history-header">
          <h2 id="delete-account-title">{t("deleteAccount.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <p className="delete-account-warning">{t("deleteAccount.warning")}</p>
          {summaryText && <p className="delete-account-summary muted small">{summaryText}</p>}
          <label className="field-row">
            <span>{t("deleteAccount.confirmLabel", { email })}</span>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={t("deleteAccount.confirmPlaceholder")}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          {error && <p className="error small">{error}</p>}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              {t("deleteAccount.cancel")}
            </button>
            <button type="submit" className="danger" disabled={busy || !canSubmit || !idsFetchSettled}>
              {busy ? t("deleteAccount.busy") : t("deleteAccount.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
