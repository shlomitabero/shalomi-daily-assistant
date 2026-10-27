import { useEffect, useState } from "react";
import type { CollaboratorRole, ProjectCollaborator } from "@forge/shared";
import { addCollaborator, listCollaborators, regenerateCalendarFeedToken, removeCollaborator, updateCollaboratorRole, type ProjectOwnerInfo } from "./api.js";
import { formatCollaboratorCount } from "./collaboratorCount.js";
import { downloadCollaboratorsReport, formatCollaboratorsReport } from "./collaboratorsReport.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

/**
 * Project sharing UI, the client side of the two-tier role system in
 * packages/db/src/collaborators.ts: a collaborator is either an "editor"
 * (full read/write, like the owner) or a "viewer" (read-only, enforced
 * server-side, not just hidden here). Only the owner can invite, remove, or
 * change someone's role -- a collaborator sees the same list read-only, so
 * they know who else has access and at what level without being able to
 * change it.
 */
export function CollaboratorsPanel({
  projectId,
  projectName,
  isOwner,
  currentUserId,
  onClose,
  onLeft,
}: {
  projectId: string;
  projectName: string;
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
  const [inviteRole, setInviteRole] = useState<CollaboratorRole>("editor");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [updatingRoleUserId, setUpdatingRoleUserId] = useState<string | null>(null);
  const [regeneratingFeedToken, setRegeneratingFeedToken] = useState(false);
  const [regenerateFeedTokenInfo, setRegenerateFeedTokenInfo] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
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
    const existingCollaborator = (collaborators ?? []).find((c) => c.email.toLowerCase() === trimmed.toLowerCase());
    try {
      const { collaborators, owner } = await addCollaborator(projectId, trimmed, inviteRole);
      setCollaborators(collaborators);
      setOwner(owner);
      setEmail("");
      if (existingCollaborator) {
        // The role dropdown right next to the email field is fully live on
        // a re-invite too, but addCollaborator's own idempotency silently
        // keeps the collaborator's existing role untouched -- without this
        // distinction, an owner picking a different role than the one this
        // person already has (e.g. trying to "invite as Viewer" someone
        // who's already an Editor) would see the same plain "already has
        // access" message and reasonably believe the role they just picked
        // took effect.
        //
        // Round 930: compares against the collaborator's role in the FRESH
        // response above, not existingCollaborator's own role (a snapshot
        // from BEFORE this request was sent) -- if something else changed
        // this person's role between this panel's last fetch and this
        // submit (another tab/session, or a same-tab role-dropdown change
        // still in flight), the stale snapshot could disagree with what the
        // server actually has, telling the owner their pick "wasn't
        // changed" even when it already matches, or vice versa. The fresh
        // list just set via setCollaborators above is the one genuinely
        // authoritative read of this person's CURRENT role.
        const currentRole = collaborators.find((c) => c.userId === existingCollaborator.userId)?.role ?? existingCollaborator.role;
        setInviteInfo(
          currentRole === inviteRole
            ? t("collab.alreadyCollaborator", { email: trimmed })
            : t("collab.alreadyCollaboratorRoleUnchanged", { email: trimmed }),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInviteBusy(false);
    }
  }

  /**
   * Round 1062: this whole panel is a real dialog (useDialogFocusTrap
   * above), whose own Escape handler closes it entirely unless the event's
   * target sits under data-escape-handled-locally -- every other form on
   * this exact screen with real draft content already opts out this way
   * now (AutomationsPanel.tsx's round-1056 create/edit form, WhatsAppPanel
   * .tsx's round-1061 test-send form), but this invite form never did.
   * Pressing Escape after starting to type a teammate's email for any
   * ordinary reason -- dismissing a browser autofill suggestion, a
   * reflexive tap -- silently closed the whole panel: the entire component
   * unmounts on close (App.tsx renders it conditionally), so the typed
   * email is destroyed, not just visually cleared. `hasUnsavedInviteDraft`
   * mirrors the same shape as those two prior fixes: true only while
   * there's something a user would actually lose, so an Escape on a
   * pristine (empty) email field still closes the dialog normally.
   */
  const hasUnsavedInviteDraft = email.trim() !== "";

  function handleResetInviteForm() {
    setEmail("");
    setInviteInfo(null);
  }

  async function handleRoleChange(userId: string, role: CollaboratorRole) {
    setUpdatingRoleUserId(userId);
    setError(null);
    try {
      const { collaborators } = await updateCollaboratorRole(projectId, userId, role);
      setCollaborators(collaborators);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUpdatingRoleUserId(null);
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

  /**
   * Round 1012: before this route existed, a calendar subscribe URL
   * (EntityPanel.tsx's own "Subscribe" button, round 1006) could never be
   * invalidated once handed out -- a removed/demoted collaborator (or
   * anyone they'd forwarded the URL to) kept live, unauthenticated feed
   * access forever. Owner-only, mirroring handleRemove's/handleLeave's
   * own confirm-dialog convention, since this also breaks every OTHER
   * collaborator's (and the owner's own) already-configured subscription
   * with no other warning.
   */
  async function handleRegenerateCalendarFeedToken() {
    if (!window.confirm(t("collab.calendarFeed.regenerate.confirm"))) return;
    setRegeneratingFeedToken(true);
    setError(null);
    setRegenerateFeedTokenInfo(null);
    try {
      await regenerateCalendarFeedToken(projectId);
      setRegenerateFeedTokenInfo(t("collab.calendarFeed.regenerate.success"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegeneratingFeedToken(false);
    }
  }

  function handleDownload() {
    downloadCollaboratorsReport(formatCollaboratorsReport(owner, collaborators ?? [], projectName, lang, t), projectName);
  }

  /**
   * Round 1112: same "Copy report" companion action every other read-heavy
   * "who/what does this project have" overlay panel in this app already has
   * for its own Download button (Business Twin, WhatsApp log, Time Machine,
   * Global Search, Automations) -- Collaborators was the one panel left
   * with no way to take its access list anywhere at all, short of a
   * screenshot or transcribing it by hand.
   */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatCollaboratorsReport(owner, collaborators ?? [], projectName, lang, t));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

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
          <div className="history-header-actions">
            {owner && collaborators !== null && (
              <button type="button" className="secondary" onClick={handleCopy} aria-live="polite" aria-atomic="true">
                {copyStatus === "copied"
                  ? t("collab.copy.copied")
                  : copyStatus === "failed"
                    ? t("collab.copy.failed")
                    : t("collab.copy")}
              </button>
            )}
            {owner && collaborators !== null && (
              <button type="button" className="secondary" onClick={handleDownload}>
                {t("collab.download")}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              {t("history.close")}
            </button>
          </div>
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
          <form
            className="collab-invite-form"
            onSubmit={handleInvite}
            data-escape-handled-locally={hasUnsavedInviteDraft ? "" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hasUnsavedInviteDraft) handleResetInviteForm();
            }}
          >
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
            <select
              aria-label={t("collab.role.label")}
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as CollaboratorRole)}
            >
              <option value="editor">{t("collab.role.editor")}</option>
              <option value="viewer">{t("collab.role.viewer")}</option>
            </select>
            {/* Same cross-gate as the role select/remove/leave buttons
                below, the other direction: handleInvite's own full
                setCollaborators(...) replace can just as easily resurrect
                a collaborator a still-pending remove/role-change already
                resolved locally, so invite must wait for those too, not
                just its own inviteBusy.
                Also gated on collaborators !== null: handleInvite's own
                "already a collaborator" pre-check (above) only works
                against the real list already on screen -- while the
                initial load is still in flight, or failed and left
                `collaborators` at its null initial value, that check
                silently evaluates against [] instead, so a re-invite of
                someone already on the project would 201 as a no-op
                (addCollaborator's own documented idempotency) with zero
                "role unchanged" feedback, looking like a genuine success. */}
            <button
              type="submit"
              disabled={inviteBusy || !email.trim() || removingUserId !== null || updatingRoleUserId !== null || collaborators === null}
            >
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
          loadError ? null : (
            <p className="muted" role="status">
              {t("collab.loading")}
            </p>
          )
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
                  {/* Disabled while ANY role update, ANY removal, OR an
                      invite is in flight, not just this row's own --
                      otherwise changing one collaborator's role (or
                      removing one) while a different request is still
                      pending fires two independent requests, and whichever
                      response lands last silently overwrites the other's
                      result (handleRoleChange and handleInvite both do a
                      full setCollaborators(...) replace from their own
                      server response, either of which can resurrect a
                      collaborator handleRemove already filtered out
                      locally -- round 680 originally gated role-change
                      against remove, but left invite, a third actor doing
                      the identical full-replace, out of the cross-gate).
                      Mirrors HistoryPanel's own restore/delete cross-gate
                      for the identical hazard. */}
                  {isOwner ? (
                    <select
                      aria-label={t("collab.role.label")}
                      value={c.role}
                      onChange={(e) => handleRoleChange(c.userId, e.target.value as CollaboratorRole)}
                      disabled={updatingRoleUserId !== null || removingUserId !== null || inviteBusy}
                    >
                      <option value="editor">{t("collab.role.editor")}</option>
                      <option value="viewer">{t("collab.role.viewer")}</option>
                    </select>
                  ) : (
                    <span className="chip collab-role-chip">
                      {c.role === "viewer" ? t("collab.role.viewer") : t("collab.role.editor")}
                    </span>
                  )}
                  {updatingRoleUserId === c.userId && <span className="muted small">{t("collab.role.updating")}</span>}
                  {isOwner ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleRemove(c.userId, c.email)}
                      disabled={removingUserId !== null || updatingRoleUserId !== null || inviteBusy}
                    >
                      {removingUserId === c.userId ? t("collab.remove.busy") : t("collab.remove")}
                    </button>
                  ) : (
                    c.userId === currentUserId && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={handleLeave}
                        disabled={removingUserId !== null || updatingRoleUserId !== null || inviteBusy}
                      >
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

        {isOwner && (
          <div className="collab-calendar-feed-section">
            <h3>{t("collab.calendarFeed.heading")}</h3>
            <p className="muted small">{t("collab.calendarFeed.description")}</p>
            <button type="button" className="secondary" onClick={handleRegenerateCalendarFeedToken} disabled={regeneratingFeedToken}>
              {regeneratingFeedToken ? t("collab.calendarFeed.regenerate.busy") : t("collab.calendarFeed.regenerate")}
            </button>
            {regenerateFeedTokenInfo && (
              <p className="muted small" role="status">
                {regenerateFeedTokenInfo}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
