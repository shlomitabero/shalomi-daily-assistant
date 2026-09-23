import { useEffect, useState } from "react";
import type { ProjectCollaborator } from "@forge/shared";
import { addCollaborator, listCollaborators, removeCollaborator } from "./api.js";
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
  onClose,
}: {
  projectId: string;
  isOwner: boolean;
  onClose: () => void;
}) {
  const { t, lang } = useTranslation();
  const [collaborators, setCollaborators] = useState<ProjectCollaborator[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  useEffect(() => {
    listCollaborators(projectId)
      .then(({ collaborators }) => setCollaborators(collaborators))
      .catch((err) => setError((err as Error).message));
  }, [projectId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviteBusy(true);
    setError(null);
    try {
      const { collaborators } = await addCollaborator(projectId, trimmed);
      setCollaborators(collaborators);
      setEmail("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRemove(userId: string) {
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

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="collab-panel-title">
        <div className="history-header">
          <h2 id="collab-panel-title">{t("collab.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <p className="muted small">{t("collab.description")}</p>

        {error && <p className="error">{error}</p>}

        {isOwner && (
          <form className="collab-invite-form" onSubmit={handleInvite}>
            <input
              type="email"
              placeholder={t("collab.email.placeholder")}
              aria-label={t("collab.email.placeholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" disabled={inviteBusy || !email.trim()}>
              {inviteBusy ? t("collab.invite.busy") : t("collab.invite")}
            </button>
          </form>
        )}

        {collaborators === null && !error ? (
          <p className="muted">{t("collab.loading")}</p>
        ) : collaborators !== null && collaborators.length === 0 ? (
          <p className="muted">{t("collab.empty")}</p>
        ) : (
          <ul className="collab-list">
            {collaborators?.map((c) => (
              <li key={c.userId}>
                <div>
                  <strong>{c.email}</strong>
                  <div className="muted small">{new Date(c.addedAt).toLocaleDateString(LOCALE[lang])}</div>
                </div>
                {isOwner && (
                  <button type="button" className="secondary" onClick={() => handleRemove(c.userId)} disabled={removingUserId !== null}>
                    {removingUserId === c.userId ? t("collab.remove.busy") : t("collab.remove")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
