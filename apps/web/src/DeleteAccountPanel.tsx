import { useEffect, useState } from "react";
import { deleteAccount, listProjects } from "./api.js";
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
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  // Fetches the real project list itself (rather than trusting App.tsx's own
  // myProjects, which is only ever populated while `view === "home"` -- this
  // panel can just as easily be opened from a project's own preview screen,
  // where myProjects would still be empty), so the warning's own project
  // count is accurate regardless of which screen this was opened from.
  useEffect(() => {
    listProjects()
      .then(({ projects }) => {
        const owned = projects.filter((p) => p.ownerId === userId);
        const shared = projects.filter((p) => p.ownerId !== userId);
        setProjectSummary({ owned: owned.length, shared: shared.length });
        setOwnedProjectIds(owned.map((p) => p.id));
        setSharedProjectIds(shared.map((p) => p.id));
      })
      .catch(() => setProjectSummary(null));
  }, [userId]);

  const canSubmit = confirmText.trim().toLowerCase() === email.toLowerCase();
  const summaryText = projectSummary ? formatDeleteAccountSummary(projectSummary.owned, projectSummary.shared, t) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
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
            <button type="submit" className="danger" disabled={busy || !canSubmit}>
              {busy ? t("deleteAccount.busy") : t("deleteAccount.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
