import { useEffect, useState } from "react";
import type { CollaboratorRole, Project, ProjectCollaborator } from "@forge/shared";
import {
  addCollaborator,
  getCalendarFeedToken,
  listCollaborators,
  regenerateCalendarFeedToken,
  removeCollaborator,
  transferProjectOwnership,
  updateCollaboratorRole,
  type ProjectOwnerInfo,
} from "./api.js";
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
  onOwnerTransferred,
}: {
  projectId: string;
  projectName: string;
  isOwner: boolean;
  /** The signed-in user's own id -- lets this panel tell "my own row" apart from every other collaborator's, so only my own row ever gets a "Leave" button. */
  currentUserId: string | undefined;
  onClose: () => void;
  /** Called once a real self-removal succeeds -- the caller no longer has access to this project at all, so it's expected to navigate away (e.g. back to the home screen), not just close this panel. */
  onLeft: () => void;
  /**
   * Called once a real ownership transfer succeeds, with the project's own
   * fresh state (new ownerId). The caller is expected to pass its existing
   * project setter (e.g. onOwnerTransferred={setProject}, the exact same
   * pattern ProjectNameEditor's onRenamed already uses) so every owner-gated
   * control derived from project.ownerId -- including this panel's own
   * isOwner prop -- correctly reflects that the signed-in user is no longer
   * the owner, without closing this panel: they're still a collaborator
   * (now "editor"), so staying on this read-only view of the list is the
   * right outcome, the same as any other non-owner collaborator already
   * sees.
   *
   * Round 1195: the second argument is the acting user's own fresh
   * `addedAt` on the brand-new "editor" collaborator row transferring away
   * ownership just minted for them (transferProjectOwnership demotes the
   * previous owner to a real collaborator row, see that function's own
   * doc comment in packages/db/src/projects.ts) -- undefined only if that
   * row somehow isn't in the response (never in practice; defensive only).
   * The caller is expected to immediately acknowledge it via
   * markSharedProjectSeen, the same one-line idiom openExistingProject
   * already uses for the ordinary "open a shared project" case, so this
   * project doesn't show a "New share!" badge on its own former owner's
   * next trip to the home screen -- without it, the home screen's
   * `sharedAt`-vs-`seenShared` comparison (isNewShare) has no way to know
   * this grant was self-inflicted rather than a genuine new invite from
   * someone else, since it's indistinguishable at the data layer from one.
   */
  onOwnerTransferred: (project: Project, selfSharedAt: string | undefined) => void;
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
  const [transferringUserId, setTransferringUserId] = useState<string | null>(null);
  const [transferInfo, setTransferInfo] = useState<string | null>(null);
  const [regeneratingFeedToken, setRegeneratingFeedToken] = useState(false);
  const [regenerateFeedTokenInfo, setRegenerateFeedTokenInfo] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [subscribeAllStatus, setSubscribeAllStatus] = useState<"idle" | "copied" | "failed">("idle");
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
      const { collaborators, owner } = await addCollaborator(projectId, trimmed, inviteRole, lang);
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
      const { collaborators } = await updateCollaboratorRole(projectId, userId, role, lang);
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
      await removeCollaborator(projectId, userId, lang);
      setCollaborators((current) => (current ? current.filter((c) => c.userId !== userId) : current));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemovingUserId(null);
    }
  }

  /**
   * Round 1170: previously the only way an owner could stop being
   * responsible for a project was deleting the whole account or the
   * project outright -- both destroy it for every collaborator, with no
   * way to hand it off instead. Owner-only, mirroring handleRemove's own
   * confirm-dialog convention for the same reason: this is a serious,
   * essentially irreversible-feeling action from the acting owner's own
   * point of view. Does a full setCollaborators/setOwner replace from the
   * server's fresh response, exactly like handleRoleChange/handleRemove
   * already do, so it's cross-gated against them the same way (see the
   * disabled= conditions below) rather than introducing a fourth,
   * independently-racing actor against the identical shared list state.
   */
  async function handleTransferOwnership(userId: string, email: string) {
    if (!window.confirm(t("collab.transferOwnership.confirm", { email }))) return;
    setTransferringUserId(userId);
    setError(null);
    setTransferInfo(null);
    try {
      const { collaborators, owner, project } = await transferProjectOwnership(projectId, userId, lang);
      setCollaborators(collaborators);
      setOwner(owner);
      setTransferInfo(t("collab.transferOwnership.success", { email }));
      // Round 1195: see onOwnerTransferred's own doc comment for why the
      // acting user's own fresh collaborator row (keyed by currentUserId,
      // never undefined here in practice) has to be found and passed up.
      const selfEntry = currentUserId ? collaborators.find((c) => c.userId === currentUserId) : undefined;
      onOwnerTransferred(project, selfEntry?.addedAt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTransferringUserId(null);
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
      await regenerateCalendarFeedToken(projectId, lang);
      setRegenerateFeedTokenInfo(t("collab.calendarFeed.regenerate.success"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegeneratingFeedToken(false);
    }
  }

  /**
   * Round 1247: the project-wide counterpart to EntityPanel.tsx's own
   * per-entity handleSubscribeCalendar -- a real project routinely has
   * more than one entity with its own independent date field (a clinic's
   * Appointment.date alongside its Invoice.dueDate), each needing its own
   * separate "Subscribe" URL today, with zero cross-entity view once
   * pasted into a real calendar app. Mirrors handleSubscribeCalendar's
   * own shape exactly: fetches the project's own feed token fresh each
   * click (cheap, same reasoning as that function's own doc comment)
   * rather than caching it, and builds the new combined-feed route's URL
   * (routes/calendar.ts's `GET /public/calendar/:projectId/all/feed.ics`
   * -- a two-segment path, not a single-segment `all.ics` literal, since
   * round 1250 found that a literal `all.ics` would silently collide with
   * any real entity named "All" in any letter case, because Express's
   * route matching is case-insensitive by default; see that route's own
   * doc comment) instead of one entity-scoped URL.
   */
  async function handleSubscribeAllCalendars() {
    try {
      const { token } = await getCalendarFeedToken(projectId);
      const url = `${window.location.origin}/api/public/calendar/${projectId}/all/feed.ics?token=${token}`;
      await navigator.clipboard.writeText(url);
      setSubscribeAllStatus("copied");
    } catch {
      setSubscribeAllStatus("failed");
    }
  }

  useEffect(() => {
    if (subscribeAllStatus === "idle") return;
    const timer = setTimeout(() => setSubscribeAllStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [subscribeAllStatus]);

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
              disabled={
                inviteBusy ||
                !email.trim() ||
                removingUserId !== null ||
                updatingRoleUserId !== null ||
                transferringUserId !== null ||
                collaborators === null
              }
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

        {transferInfo && (
          <p className="muted small" role="status">
            {transferInfo}
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
                      for the identical hazard. Round 1170 extends the same
                      cross-gate to handleTransferOwnership, a fourth actor
                      doing the identical full-replace. */}
                  {isOwner ? (
                    <select
                      aria-label={t("collab.role.label")}
                      value={c.role}
                      onChange={(e) => handleRoleChange(c.userId, e.target.value as CollaboratorRole)}
                      disabled={updatingRoleUserId !== null || removingUserId !== null || transferringUserId !== null || inviteBusy}
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
                    <>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleRemove(c.userId, c.email)}
                        disabled={removingUserId !== null || updatingRoleUserId !== null || transferringUserId !== null || inviteBusy}
                      >
                        {removingUserId === c.userId ? t("collab.remove.busy") : t("collab.remove")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleTransferOwnership(c.userId, c.email)}
                        disabled={removingUserId !== null || updatingRoleUserId !== null || transferringUserId !== null || inviteBusy}
                      >
                        {transferringUserId === c.userId ? t("collab.transferOwnership.busy") : t("collab.transferOwnership")}
                      </button>
                    </>
                  ) : (
                    c.userId === currentUserId && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={handleLeave}
                        disabled={removingUserId !== null || updatingRoleUserId !== null || transferringUserId !== null || inviteBusy}
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

        {/*
          Round 1247: NOT owner-gated, unlike the regenerate section just
          below -- GET .../calendar-feed-token (which this button calls,
          via getCalendarFeedToken) uses requireProjectAccess, not
          requireProjectOwner, the same access any collaborator already
          has to EntityPanel.tsx's own per-entity "Subscribe" button.
        */}
        <div className="collab-calendar-subscribe-all-section">
          <h3>{t("collab.calendarFeed.subscribeAll.heading")}</h3>
          <p className="muted small">{t("collab.calendarFeed.subscribeAll.description")}</p>
          <button type="button" className="secondary" onClick={handleSubscribeAllCalendars} aria-live="polite" aria-atomic="true">
            {subscribeAllStatus === "copied"
              ? t("collab.calendarFeed.subscribeAll.copied")
              : subscribeAllStatus === "failed"
                ? t("collab.calendarFeed.subscribeAll.failed")
                : t("collab.calendarFeed.subscribeAll.button")}
          </button>
        </div>

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
