import { useEffect, useState } from "react";
import type { ProjectCollaborator } from "@forge/shared";
import { addCollaborator, listCollaborators, removeCollaborator, type ProjectOwnerInfo } from "./api.js";
import { formatCollaboratorCount } from "./collaboratorCount.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

/**
 * Project sharing UI, the client side of the honest first step past
 * "every project has exactly one owner and nobody else can touch it" (see
 * packages/db/src/collaborators.ts's own comment). Only the owner can
 * invite or remove someone -- a collaborator sees the same list read-only,
 * so they know who else has access without being able to change it.
 */
export function CollaboratorsPanel({
  projectId,
  isOwner,
  currentUserId,
  onClose,
  onLeft,
}: {
  projectId: string;
  isOwner: boolean;
  /** The signed-in user's own id -- lets this panel tell "my own row" apart from every other collaborator's, so only my own row ever gets a "Leave" button. */
  currentUserId: string | undefined;
  onClose: () => void;
  /** Called once a real self-removal succeeds -- the caller no longer has access to this project at all, so it's expected to navigate away (e.g. back to the home screen), not just close this panel. */
  onLeft: () => void;
}) {
  const { t, lang } = useTranslation();
  const [collaborators, setCollaborators] = useState<ProjectCollaborator[] | null>(null);
  const [owner, setOwner] = useState<ProjectOwnerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinct from the error above (shared by invite/remove/leave failures,
  // each of which already has its own clear recovery path): specifically
  // the initial listCollaborators call failing, which otherwise left the
  // panel showing nothing at all but the bare error line -- no owner row,
  // no collaborator list, no empty-state, and no way to retry short of
  // closing and reopening the whole panel.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  function loadCollaborators() {
    setLoadError(null);
    listCollaborators(projectId)
      .then(({ collaborators, owner }) => {
        setCollaborators(collaborators);
        setOwner(owner);
      })
      .catch((err) => setLoadError((err as Error).message));
  }

  useEffect(() => {
    loadCollaborators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviteBusy(true);
    setError(null);
    setInviteInfo(null);
    // addCollaborator (packages/db/src/collaborators.ts) is deliberately
    // idempotent -- inviting someone already on the project is a silent
    // no-op server-side, still a 201 with the unchanged list, so the owner
    // previously got zero feedback that nothing actually happened. Checked
    // BEFORE the request (against the list already on screen), since the
    // response alone can't tell a genuine new add apart from a no-op.
    const alreadyCollaborator = (collaborators ?? []).some((c) => c.email.toLowerCase() === trimmed.toLowerCase());
    try {
      const { collaborators, owner } = await addCollaborator(projectId, trimmed);
      setCollaborators(collaborators);
      setOwner(owner);
      setEmail("");
      if (alreadyCollaborator) {
        setInviteInfo(t("collab.alreadyCollaborator", { email: trimmed }));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRemove(userId: string, email: string) {
    if (!window.confirm(t("collab.confirmRemove", { email }))) return;
    setRemovingUserId(userId);
    setError(null);
    try {
      await removeCollaborator(projectId, userId);
      setCollaborators((current) => (current ? current.filter((c) => c.userId !== userId) : current));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemovingUserId(null);
    }
  }

  /**
   * Real self-service "leave project" -- previously the only way for a
   * collaborator to lose access was asking the owner to remove them. Reuses
   * the exact same DELETE the owner's own "Remove" button calls (the API
   * route now allows a collaborator to target their own id), just calls
   * onLeft instead of trimming the local list: once this succeeds, the
   * caller has no access to this project at all any more, so there's
   * nothing left here to keep showing.
   */
  async function handleLeave() {
    if (!currentUserId) return;
    if (!window.confirm(t("collab.confirmLeave"))) return;
    setRemovingUserId(currentUserId);
    setError(null);
    try {
      await removeCollaborator(projectId, currentUserId);
      onLeft();
    } catch (err) {
      setError((err as Error).message);
      setRemovingUserId(null);
    }
  }

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="collab-panel-title">
        <div className="history-header">
          <h2 id="collab-panel-title">
            {t("collab.title")}
            {owner && collaborators !== null && (
              <span className="muted small collab-count"> — {formatCollaboratorCount(1 + collaborators.length, t)}</span>
            )}
          </h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <p className="muted small">{t("collab.description")}</p>

        {error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
        {loadError && (
          <div className="error-retry-row">
            <p className="error" role="status">
              {loadError}
            </p>
            <button type="button" className="secondary small" onClick={loadCollaborators}>
              {t("collab.retry")}
            </button>
          </div>
        )}

        {isOwner && (
          <form className="collab-invite-form" onSubmit={handleInvite}>
            <input
              type="email"
              placeholder={t("collab.email.placeholder")}
              aria-label={t("collab.email.placeholder")}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setInviteInfo(null);
              }}
            />
            <button type="submit" disabled={inviteBusy || !email.trim()}>
              {inviteBusy ? t("collab.invite.busy") : t("collab.invite")}
            </button>
          </form>
        )}

        {inviteInfo && (
          <p className="muted small" role="status">
            {inviteInfo}
          </p>
        )}

        {collaborators === null && !error ? (
          loadError ? null : <p className="muted">{t("collab.loading")}</p>
        ) : (
          <>
            <ul className="collab-list">
              {owner && (
                <li className="collab-owner-row">
                  <div>
                    <strong>{owner.email}</strong>
                    <div className="muted small">
                      <span className="chip collab-owner-chip">{isOwner ? t("collab.owner.you") : t("collab.owner")}</span>
                    </div>
                  </div>
                </li>
              )}
              {collaborators?.map((c) => (
                <li key={c.userId}>
                  <div>
                    <strong>{c.email}</strong>
                    <div className="muted small">{new Date(c.addedAt).toLocaleDateString(LOCALE[lang])}</div>
                  </div>
                  {isOwner ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleRemove(c.userId, c.email)}
                      disabled={removingUserId !== null}
                    >
                      {removingUserId === c.userId ? t("collab.remove.busy") : t("collab.remove")}
                    </button>
                  ) : (
                    c.userId === currentUserId && (
                      <button type="button" className="secondary" onClick={handleLeave} disabled={removingUserId !== null}>
                        {removingUserId === currentUserId ? t("collab.leave.busy") : t("collab.leave")}
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
            {collaborators !== null && collaborators.length === 0 && <p className="muted small">{t("collab.empty")}</p>}
          </>
        )}
      </div>
    </div>
  );
}
