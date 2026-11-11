import { useEffect, useState } from "react";
import type { CollaboratorRole, Entity, Project, ProjectCollaborator } from "@forge/shared";
import {
  addCollaborator,
  getCalendarFeedToken,
  getInboundWebhookToken,
  listCollaborators,
  listAutomationRuleDeletions,
  listCollaboratorAccessChanges,
  listRecordDeletions,
  listSchemaLabelEdits,
  regenerateCalendarFeedToken,
  regenerateInboundWebhookToken,
  removeCollaborator,
  resendCollaboratorInvite,
  transferProjectOwnership,
  updateCollaboratorRole,
  type AutomationRuleDeletion,
  type CollaboratorAccessChange,
  type ProjectOwnerInfo,
  type RecordDeletion,
  type SchemaLabelEdit,
} from "./api.js";
import { formatCollaboratorCount } from "./collaboratorCount.js";
import { downloadCollaboratorsReport, formatCollaboratorsReport } from "./collaboratorsReport.js";
import { entityDisplayLabel, entityLabelOccurrences, fieldDisplayLabel, fieldLabelOccurrences } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { useBeforeUnloadWarning } from "./useBeforeUnloadWarning.js";

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
  readOnly,
  currentUserId,
  entities,
  onClose,
  onLeft,
  onOwnerTransferred,
}: {
  projectId: string;
  projectName: string;
  isOwner: boolean;
  /**
   * Round 1620: mirrors AutomationsPanel's own identical prop (App.tsx
   * already computes `readOnly={myRole === "viewer"}` for that sibling
   * panel) -- true only for a viewer collaborator, false for an editor or
   * the owner. Gates the inbound-webhook "Check last received" diagnostic
   * below, which GET .../inbound-webhook-token itself (routes/projects.ts)
   * already grants to any editor via requireProjectWriteAccess, not just
   * the owner -- this prop lets the UI stop being stricter than the route
   * it calls.
   */
  readOnly: boolean;
  /** The signed-in user's own id -- lets this panel tell "my own row" apart from every other collaborator's, so only my own row ever gets a "Leave" button. */
  currentUserId: string | undefined;
  /**
   * Round 1656: mirrors AutomationsPanel's own identical `entities` prop
   * (App.tsx already passes it `orderedEntities` there) -- used only to
   * resolve a deleted record's raw internal entityName into its real
   * display label for the Copy/Download report's record-deletions section
   * (see deletionsForReport below), the same entityDisplayLabel/
   * entityLabelOccurrences pair GlobalSearchPanel.tsx's own truncated-
   * results banner already uses for the identical "don't show the raw
   * internal name" purpose. A project with no spec entities loaded yet
   * (or a test that doesn't pass this prop) still works fine -- the
   * lookup below just degrades to the raw name, same as a deleted entity.
   */
  entities: Entity[];
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
  // Round 1632: fetched alongside collaborators (not gated behind any
  // explicit user action) purely for the Copy/Download report below --
  // never rendered in the on-screen list itself, so a load failure here
  // is deliberately silent (stays []) rather than surfacing its own error
  // state, the same way the report's own data has always just been
  // "whatever's currently in memory," never a hard dependency of opening
  // this panel at all.
  const [recordDeletions, setRecordDeletions] = useState<RecordDeletion[]>([]);
  // Round 1636: the sibling fetch to recordDeletions above, for the
  // collaborator role-change/removal audit log -- same silent-on-failure
  // contract, for the same reason (Copy/Download-report-only data, never a
  // hard dependency of opening this panel at all).
  const [accessChanges, setAccessChanges] = useState<CollaboratorAccessChange[]>([]);
  // Round 1639: the sibling fetch to accessChanges above, for the
  // entity/field label-rename audit log -- same silent-on-failure
  // contract, for the same reason (Copy/Download-report-only data, never a
  // hard dependency of opening this panel at all).
  const [schemaLabelEdits, setSchemaLabelEdits] = useState<SchemaLabelEdit[]>([]);
  // Round 1666: the sibling fetch to schemaLabelEdits above, for the
  // automation-rule-deletion audit log -- same silent-on-failure contract,
  // for the same reason (Copy/Download-report-only data, never a hard
  // dependency of opening this panel at all).
  const [automationRuleDeletions, setAutomationRuleDeletions] = useState<AutomationRuleDeletion[]>([]);
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
  const [resendingUserId, setResendingUserId] = useState<string | null>(null);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [regeneratingFeedToken, setRegeneratingFeedToken] = useState(false);
  const [regenerateFeedTokenInfo, setRegenerateFeedTokenInfo] = useState<string | null>(null);
  const [regeneratingWebhookToken, setRegeneratingWebhookToken] = useState(false);
  const [regenerateWebhookTokenInfo, setRegenerateWebhookTokenInfo] = useState<string | null>(null);
  // Round 1456: undefined until the owner actually clicks "Check" below
  // (this is fetched on demand, not on mount -- see
  // handleCheckLastInboundWebhook's own doc comment) vs. null once
  // checked with no delivery ever recorded -- lets the JSX tell "haven't
  // checked yet" apart from "checked, and there's genuinely nothing"
  // without a third boolean.
  const [lastInboundWebhookAt, setLastInboundWebhookAt] = useState<string | null | undefined>(undefined);
  // Round 1471: same three-state shape as lastInboundWebhookAt just above,
  // fetched and reset together with it (see handleCheckLastInboundWebhook/
  // handleRegenerateInboundWebhookToken) -- independent of it, since a
  // project can have both a recent success and a recent failure at once.
  const [lastInboundWebhookFailure, setLastInboundWebhookFailure] = useState<{ at: string; reason: string } | null | undefined>(undefined);
  const [checkingLastInboundWebhook, setCheckingLastInboundWebhook] = useState(false);
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
    // Round 1632: deliberately a separate, independent call -- a failure
    // here must never block or error out the real collaborator list above
    // (see recordDeletions' own state comment for why this stays silent).
    listRecordDeletions(projectId)
      .then(({ deletions }) => setRecordDeletions(deletions))
      .catch(() => {});
    // Round 1636: same independent, silently-failing fetch pattern as
    // listRecordDeletions above, for the same reason.
    listCollaboratorAccessChanges(projectId)
      .then(({ changes }) => setAccessChanges(changes))
      .catch(() => {});
    // Round 1639: same independent, silently-failing fetch pattern as
    // listCollaboratorAccessChanges above, for the same reason.
    listSchemaLabelEdits(projectId)
      .then(({ edits }) => setSchemaLabelEdits(edits))
      .catch(() => {});
    // Round 1666: same independent, silently-failing fetch pattern as
    // listSchemaLabelEdits above, for the same reason.
    listAutomationRuleDeletions(projectId)
      .then(({ deletions }) => setAutomationRuleDeletions(deletions))
      .catch(() => {});
  }

  useEffect(() => {
    loadCollaborators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /**
   * Round 1456: deliberately on-demand (a click), not an automatic fetch on
   * mount -- mirrors handleCopyWebhookUrl/handleSubscribeCalendar's own
   * established "fetch fresh on the action that needs it" idiom
   * (EntityPanel.tsx) rather than this panel's own mount-time
   * loadCollaborators pattern just above. An automatic fetch here would run
   * on every single render of this owner-only section across the whole
   * app, for a value almost nobody checks on every open.
   */
  async function handleCheckLastInboundWebhook() {
    // Round 1466: see handleRegenerateInboundWebhookToken's own matching
    // guard -- the mirror-image half of the same cross-gate, so a Check
    // can't start reading the token that's about to be rotated out from
    // under it either.
    if (regeneratingWebhookToken) return;
    setCheckingLastInboundWebhook(true);
    try {
      const { lastInboundWebhookAt, lastInboundWebhookFailure } = await getInboundWebhookToken(projectId);
      setLastInboundWebhookAt(lastInboundWebhookAt ?? null);
      setLastInboundWebhookFailure(lastInboundWebhookFailure ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCheckingLastInboundWebhook(false);
    }
  }

  /**
   * Round 1592: this form's type="email" input had no `noValidate` on its
   * <form>, the same bug class rounds 342/1587/1588/1589 already fixed for
   * EntityPanel/AuthScreen/ChangePasswordPanel/ChangeEmailPanel/
   * AutomationsPanel. The submit button already disables on a blank email
   * (below), so that case was safe, but a non-empty, malformed value (e.g.
   * "not-an-email") still failed the browser's own native type="email"
   * constraint -- that check fires independent of `required` -- blocking
   * submission with an untranslated native popup and never reaching
   * handleInvite's own try/catch at all, let alone the server's real,
   * translated `z.string().email(...)` check (routes/projects.ts). Reuses
   * ChangeEmailPanel's own findFirstInvalidField/describeInvalidField pair
   * verbatim (minus the tooShort branch -- this form has no password
   * field).
   */
  function findFirstInvalidField(form: HTMLFormElement): HTMLInputElement | null {
    for (const el of Array.from(form.elements)) {
      if (el.tagName === "INPUT" && !(el as HTMLInputElement).checkValidity()) return el as HTMLInputElement;
    }
    return null;
  }

  function describeInvalidField(input: HTMLInputElement): string {
    if (input.validity.valueMissing) return t("auth.form.requiredField");
    if (input.validity.typeMismatch) return t("auth.form.invalidEmail");
    return t("auth.form.requiredField");
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    // Round 1365: inviteBusy already disabled the submit button, but
    // handleInvite itself never checked it -- the same own-click
    // reentrancy gap round 1363/1364 closed for EntityPanel/
    // AutomationsPanel/WhatsAppPanel. Here a fast double-click fires two
    // independent POST .../collaborators calls before React disables the
    // button, and unlike those earlier cases this one is externally
    // visible: the server best-effort-sends a real invite email to the
    // invitee, so a double-fire risks a duplicate invite email landing in
    // a third party's inbox for one click.
    if (inviteBusy) return;
    setError(null);
    setInviteInfo(null);
    const invalid = findFirstInvalidField(e.currentTarget as HTMLFormElement);
    if (invalid) {
      setError(describeInvalidField(invalid));
      invalid.focus();
      return;
    }
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviteBusy(true);
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
  // Round 1331: the far more common way this exact draft gets lost isn't
  // Escape (guarded above) but a tab close/refresh/navigation away.
  useBeforeUnloadWarning(hasUnsavedInviteDraft);

  function handleResetInviteForm() {
    setEmail("");
    setInviteInfo(null);
  }

  async function handleRoleChange(userId: string, role: CollaboratorRole) {
    // Round 1534: the same own-click reentrancy gap round 1365 closed for
    // handleInvite in this same file -- the <select>'s disabled= attribute
    // (set from updatingRoleUserId below) only takes effect once React
    // commits the next render, so two onChange events in that window (e.g.
    // arrow-key cycling a focused select, or two fast picks) each fire an
    // independent updateCollaboratorRole PATCH; whichever response lands
    // last silently overwrites the other via the full setCollaborators
    // replace below, regardless of which pick the user actually meant.
    if (updatingRoleUserId !== null) return;
    setUpdatingRoleUserId(userId);
    setError(null);
    try {
      const { collaborators } = await updateCollaboratorRole(projectId, userId, role, lang);
      setCollaborators(collaborators);
    } catch (err) {
      // Round 1884: mirrors EntityPanel.tsx's handleSubmit/commitInlineEdit/
      // handleMoveFields/handleBulkUpdate (rounds 1864/1873/1874) and
      // AutomationsPanel.tsx's handleSubmit/handleToggle (round 1875) --
      // another tab/collaborator can fully remove this person between this
      // tab rendering their row and this PATCH reaching the server
      // (routes/projects.ts's role route throws COLLABORATOR_NOT_FOUND for
      // exactly this). Silently reloading the real list drops their now-
      // stale row instead of leaving it stuck, repeating the same 404 on
      // every further role pick.
      if ((err as Error & { code?: string }).code === "COLLABORATOR_NOT_FOUND") {
        loadCollaborators();
        return;
      }
      setError((err as Error).message);
    } finally {
      setUpdatingRoleUserId(null);
    }
  }

  async function handleRemove(userId: string, email: string) {
    // Round 1534: the same own-click reentrancy gap round 1365 closed for
    // handleInvite -- window.confirm blocks most real double-clicks, but a
    // test or a very fast second invocation before React commits the
    // disabled= attribute can still fire two independent DELETE requests.
    if (removingUserId !== null) return;
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
    // Round 1534: same own-click reentrancy gap as handleRemove just above.
    if (transferringUserId !== null) return;
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
      // Round 1884: same cross-tab-delete-race gap as handleRoleChange just
      // above -- the target collaborator can be fully removed by another
      // tab/collaborator between this tab rendering their row and this
      // POST reaching the server (routes/projects.ts's transfer-ownership
      // route throws the identical COLLABORATOR_NOT_FOUND for an unknown
      // target). Reload instead of leaving the row stuck on a repeating 404.
      if ((err as Error & { code?: string }).code === "COLLABORATOR_NOT_FOUND") {
        loadCollaborators();
        return;
      }
      setError((err as Error).message);
    } finally {
      setTransferringUserId(null);
    }
  }

  /**
   * Round 1719: re-sends the invite route's own notification email, for a
   * collaborator who already has access but never actually received it
   * (RESEND_API_KEY not configured yet at invite time, or a one-off
   * delivery failure -- that send is best-effort and swallows its own
   * errors). Previously the only workaround was removing then re-inviting
   * them, which fires its own confusing "you were removed" email first.
   * This route itself touches no shared collaborator-list state, so it was
   * originally gated only against its own reentrancy -- but round 1734
   * folded it into the same disabled= cross-gate as the other four actions
   * anyway (see the comment above this row's own JSX): with no cross-gate,
   * clicking Resend on a row mid-Remove could race a "you were invited"
   * email against the removal it's concurrent with, landing after the
   * person already lost access (or, the other way round, surfacing a
   * confusing unrelated "Collaborator not found" from the resend route's
   * own 404 once the remove wins).
   */
  async function handleResendInvite(userId: string, email: string) {
    if (resendingUserId !== null) return;
    setResendingUserId(userId);
    setError(null);
    setResendInfo(null);
    try {
      await resendCollaboratorInvite(projectId, userId, lang);
      setResendInfo(t("collab.resendInvite.success", { email }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResendingUserId(null);
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
    // Round 1534: same own-click reentrancy gap as handleRemove above --
    // handleLeave shares removingUserId with it (both ultimately call
    // removeCollaborator), so the guard is against the same state.
    if (removingUserId !== null) return;
    if (!currentUserId) return;
    if (!window.confirm(t("collab.confirmLeave"))) return;
    setRemovingUserId(currentUserId);
    setError(null);
    try {
      // Round 1563: every sibling mutating call in this file passes lang
      // (handleRemove, handleRoleChange, handleTransferOwnership, ...) --
      // this one never did, so the round-1277 self-leave owner-notification
      // email's own isHebrew (req.query.lang !== "en") always defaulted to
      // Hebrew regardless of the leaver's or owner's actual UI language.
      await removeCollaborator(projectId, currentUserId, lang);
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
    // Round 1860: the same own-click reentrancy gap round 1365/1534 closed
    // for handleInvite/handleRoleChange/handleRemove/handleTransferOwnership
    // in this same file -- disabled={regeneratingFeedToken} on the button
    // below only takes effect after React commits the next render, so a
    // fast double-click fires this handler twice before that happens. A
    // double-fire here is externally visible: a successful rotation
    // best-effort-emails every other collaborator (round 1290), so two
    // overlapping calls risk two such emails for one click.
    if (regeneratingFeedToken) return;
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
   * Round 1405: owner-only, same confirm-dialog convention as
   * handleRegenerateCalendarFeedToken just above -- rotating this token
   * also breaks every external integration (Stripe, Typeform, a website's
   * own form handler) already configured with the old URL.
   *
   * Round 1419: now passes `lang` and notifies other collaborators too,
   * the same as handleRegenerateCalendarFeedToken -- round 1405's original
   * reasoning for NOT doing this (this token "only ever configures the
   * OWNER's own external integration dashboard") stopped holding once
   * round 1407 widened the GET route to admit editors too, who can
   * independently configure their own external service with this token.
   */
  async function handleRegenerateInboundWebhookToken() {
    // Round 1466: cross-gate against handleCheckLastInboundWebhook (see its
    // own matching guard below) -- without this, a Check already in
    // flight against the OLD token can resolve after this regenerate call
    // resets lastInboundWebhookAt back to "haven't checked yet", silently
    // overwriting that reset with the stale pre-rotation value. The exact
    // same "looks like it still belongs to the new token" bug round 1457
    // already closed for the simple sequential case, just reopened here
    // via a race between the two buttons.
    if (checkingLastInboundWebhook) return;
    // Round 1860: that guard above only cross-gates against the sibling
    // Check action -- this handler never guarded against its OWN
    // reentrancy, the same gap just closed on handleRegenerateCalendarFeedToken
    // just above. disabled={regeneratingWebhookToken || ...} on the button
    // below only takes effect after React commits the next render, so a
    // fast double-click still fires this handler twice first.
    if (regeneratingWebhookToken) return;
    if (!window.confirm(t("collab.webhookIn.regenerate.confirm"))) return;
    setRegeneratingWebhookToken(true);
    setError(null);
    setRegenerateWebhookTokenInfo(null);
    try {
      await regenerateInboundWebhookToken(projectId, lang);
      setRegenerateWebhookTokenInfo(t("collab.webhookIn.regenerate.success"));
      // Round 1457: the server just cleared lastInboundWebhookAt back to
      // null for this same reason (see regenerateInboundWebhookToken's own
      // doc comment) -- reset this panel's own already-checked value back
      // to the "haven't checked yet" sentinel too, so a result fetched
      // under the OLD token doesn't linger on screen looking like it still
      // applies to the one just generated.
      setLastInboundWebhookAt(undefined);
      // Round 1471: same reset, same reason -- a failure recorded under
      // the OLD token would otherwise linger looking like it still
      // applies to the one just generated.
      setLastInboundWebhookFailure(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegeneratingWebhookToken(false);
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

  // Round 1632: resolves each deletion's raw deletedByUserId into a display
  // email using the exact same owner+collaborators data this panel already
  // loaded for its own list -- mirrors the server-side collaboratorEmails
  // pattern (GET .../checkpoints, GET .../entities/:entityName) but built
  // client-side here, since there's no reason to duplicate that lookup in
  // a dedicated route response just for this one report.
  //
  // Round 1656: the same treatment for d.entityName, which was passed
  // through unresolved -- entityName is the raw internal spec identifier
  // (e.g. "Customer"), never the Hebrew/friendly `label` an AI-generated
  // spec actually gives most entities (e.g. "לקוחות"), the same raw-vs-
  // display gap round 1648 already fixed for GlobalSearchPanel's own
  // truncated-results banner. Case-insensitive fallback mirrors every
  // other entityName lookup in this codebase (findField's own sibling
  // pattern); an entity later removed from the spec entirely degrades to
  // the raw stored name, same as deletedByEmail's own null fallback for a
  // former collaborator whose email isn't in either current list.
  function deletionsForReport() {
    const emails: Record<string, string> = {};
    if (owner) emails[owner.userId] = owner.email;
    for (const c of collaborators ?? []) emails[c.userId] = c.email;
    const occurrences = entityLabelOccurrences(entities);
    return recordDeletions.map((d) => {
      const resolvedEntity = entities.find((e) => e.name === d.entityName) ?? entities.find((e) => e.name.toLowerCase() === d.entityName.toLowerCase());
      return {
        ...d,
        entityName: resolvedEntity ? entityDisplayLabel(resolvedEntity, occurrences) : d.entityName,
        deletedByEmail: d.deletedByUserId ? emails[d.deletedByUserId] ?? null : null,
      };
    });
  }

  // Round 1636: mirrors deletionsForReport's own email-resolution pattern
  // exactly, for the sibling access-change log -- same owner+collaborators
  // lookup, same limitation (a removed collaborator or former owner whose
  // email isn't in either current list resolves to null, same as a
  // deletedByUserId that no longer appears in either).
  function accessChangesForReport() {
    const emails: Record<string, string> = {};
    if (owner) emails[owner.userId] = owner.email;
    for (const c of collaborators ?? []) emails[c.userId] = c.email;
    return accessChanges.map((c) => ({
      action: c.action,
      // Round 1751: this used to fall back to the raw internal userId
      // string when the target isn't in either current list -- exactly
      // what happens for a "removed" entry every time, since
      // removeCollaborator hard-deletes the row this emails map is built
      // from. changedByEmail (below) already falls back to null
      // correctly; mirror that instead of leaking the id.
      targetEmail: emails[c.targetUserId] ?? null,
      changedByEmail: c.changedByUserId ? emails[c.changedByUserId] ?? null : null,
      previousRole: c.previousRole,
      newRole: c.newRole,
      changedAt: c.changedAt,
    }));
  }

  // Round 1639: mirrors accessChangesForReport's own email-resolution
  // pattern exactly, for the sibling schema-label-edit log.
  //
  // Round 1661: entityName/fieldName are the raw internal spec
  // identifiers logged at rename time, never the Hebrew/friendly label --
  // exactly the same gap round 1656 fixed one function up in this same
  // file, for deletionsForReport's own entityName. Resolves entityName the
  // same way (exact-case then case-insensitive fallback, via
  // entityDisplayLabel/entityLabelOccurrences), and, for a field_renamed
  // entry, also resolves fieldName against the resolved entity's own
  // fields the same way, via fieldDisplayLabel/fieldLabelOccurrences.
  function schemaLabelEditsForReport() {
    const emails: Record<string, string> = {};
    if (owner) emails[owner.userId] = owner.email;
    for (const c of collaborators ?? []) emails[c.userId] = c.email;
    const occurrences = entityLabelOccurrences(entities);
    return schemaLabelEdits.map((e) => {
      const resolvedEntity = entities.find((en) => en.name === e.entityName) ?? entities.find((en) => en.name.toLowerCase() === e.entityName.toLowerCase());
      let fieldName = e.fieldName;
      if (resolvedEntity && e.fieldName) {
        const resolvedField = resolvedEntity.fields.find((f) => f.name === e.fieldName) ?? resolvedEntity.fields.find((f) => f.name.toLowerCase() === e.fieldName!.toLowerCase());
        if (resolvedField) fieldName = fieldDisplayLabel(resolvedField, fieldLabelOccurrences(resolvedEntity.fields));
      }
      return {
        action: e.action,
        entityName: resolvedEntity ? entityDisplayLabel(resolvedEntity, occurrences) : e.entityName,
        fieldName,
        changedByEmail: e.changedByUserId ? emails[e.changedByUserId] ?? null : null,
        previousLabel: e.previousLabel,
        newLabel: e.newLabel,
        changedAt: e.changedAt,
      };
    });
  }

  // Round 1666: mirrors deletionsForReport's own entityName-resolution
  // pattern exactly, for the sibling automation-rule-deletion log.
  function automationRuleDeletionsForReport() {
    const emails: Record<string, string> = {};
    if (owner) emails[owner.userId] = owner.email;
    for (const c of collaborators ?? []) emails[c.userId] = c.email;
    const occurrences = entityLabelOccurrences(entities);
    return automationRuleDeletions.map((d) => {
      const resolvedEntity = entities.find((e) => e.name === d.entityName) ?? entities.find((e) => e.name.toLowerCase() === d.entityName.toLowerCase());
      return {
        entityName: resolvedEntity ? entityDisplayLabel(resolvedEntity, occurrences) : d.entityName,
        trigger: d.trigger,
        actionType: d.actionType,
        deletedByEmail: d.deletedByUserId ? emails[d.deletedByUserId] ?? null : null,
        deletedAt: d.deletedAt,
      };
    });
  }

  function handleDownload() {
    downloadCollaboratorsReport(
      formatCollaboratorsReport(
        owner,
        collaborators ?? [],
        projectName,
        lang,
        t,
        deletionsForReport(),
        accessChangesForReport(),
        schemaLabelEditsForReport(),
        automationRuleDeletionsForReport(),
      ),
      projectName,
    );
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
      await navigator.clipboard.writeText(
        formatCollaboratorsReport(
          owner,
          collaborators ?? [],
          projectName,
          lang,
          t,
          deletionsForReport(),
          accessChangesForReport(),
          schemaLabelEditsForReport(),
          automationRuleDeletionsForReport(),
        ),
      );
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
            noValidate
            data-escape-handled-locally={hasUnsavedInviteDraft ? "" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hasUnsavedInviteDraft) handleResetInviteForm();
            }}
          >
            <input
              type="email"
              placeholder={t("collab.email.placeholder")}
              aria-label={t("collab.email.placeholder")}
              maxLength={320}
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
                resendingUserId !== null ||
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

        {resendInfo && (
          <p className="muted small" role="status">
            {resendInfo}
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
                      doing the identical full-replace. Round 1734 extends
                      it again to handleResendInvite, a fifth actor -- not
                      because it shares the same full-replace hazard (it
                      touches no collaborator-list state at all), but
                      because it can otherwise race a stale "you were
                      invited" email against a concurrent remove/role-change
                      on the exact same row (see handleResendInvite's own
                      doc comment). */}
                  {isOwner ? (
                    <select
                      aria-label={t("collab.role.label")}
                      value={c.role}
                      onChange={(e) => handleRoleChange(c.userId, e.target.value as CollaboratorRole)}
                      disabled={
                        updatingRoleUserId !== null ||
                        removingUserId !== null ||
                        transferringUserId !== null ||
                        resendingUserId !== null ||
                        inviteBusy
                      }
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
                        disabled={
                          removingUserId !== null ||
                          updatingRoleUserId !== null ||
                          transferringUserId !== null ||
                          resendingUserId !== null ||
                          inviteBusy
                        }
                      >
                        {removingUserId === c.userId ? t("collab.remove.busy") : t("collab.remove")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleTransferOwnership(c.userId, c.email)}
                        disabled={
                          removingUserId !== null ||
                          updatingRoleUserId !== null ||
                          transferringUserId !== null ||
                          resendingUserId !== null ||
                          inviteBusy
                        }
                      >
                        {transferringUserId === c.userId ? t("collab.transferOwnership.busy") : t("collab.transferOwnership")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleResendInvite(c.userId, c.email)}
                        disabled={
                          resendingUserId !== null ||
                          removingUserId !== null ||
                          updatingRoleUserId !== null ||
                          transferringUserId !== null ||
                          inviteBusy
                        }
                      >
                        {resendingUserId === c.userId ? t("collab.resendInvite.busy") : t("collab.resendInvite")}
                      </button>
                    </>
                  ) : (
                    c.userId === currentUserId && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={handleLeave}
                        disabled={
                          removingUserId !== null ||
                          updatingRoleUserId !== null ||
                          transferringUserId !== null ||
                          resendingUserId !== null ||
                          inviteBusy
                        }
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

        {/*
          Round 1620: this whole section used to be isOwner-only, but
          GET .../inbound-webhook-token (routes/projects.ts) itself uses
          requireProjectWriteAccess, not requireProjectOwner -- an editor
          who wired this token into their own Stripe/Typeform integration
          (via EntityPanel.tsx's own handleCopyWebhookUrl, also not
          owner-gated) had no way anywhere in this app to check whether
          deliveries are actually arriving. The regenerate action stays
          strictly owner-only (rotating it breaks every other
          collaborator's already-configured integration, see
          handleRegenerateInboundWebhookToken's own doc comment below) --
          only the read-only "Check last received" diagnostic widens to
          match the boundary the GET route it calls already uses.
        */}
        {!readOnly && (
          <div className="collab-webhook-in-section">
            <h3>{t("collab.webhookIn.heading")}</h3>
            <p className="muted small">{t("collab.webhookIn.description")}</p>
            {isOwner && (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleRegenerateInboundWebhookToken}
                  disabled={regeneratingWebhookToken || checkingLastInboundWebhook}
                >
                  {regeneratingWebhookToken ? t("collab.webhookIn.regenerate.busy") : t("collab.webhookIn.regenerate")}
                </button>
                {regenerateWebhookTokenInfo && (
                  <p className="muted small" role="status">
                    {regenerateWebhookTokenInfo}
                  </p>
                )}
              </>
            )}
            {/*
              Round 1456: a second, independent action in this same section
              -- deliberately NOT auto-fetched on mount (see
              handleCheckLastInboundWebhook's own doc comment), so its own
              button and status line come after the regenerate button/status
              above rather than before them, leaving every existing
              `.collab-webhook-in-section button` lookup (this file's own
              regenerate tests) still finding the regenerate button first
              when both are present (owner). Round 1620: now the only
              control in this section for an editor, since the regenerate
              button just above is still isOwner-only.
            */}
            <button
              type="button"
              className="secondary"
              onClick={handleCheckLastInboundWebhook}
              disabled={checkingLastInboundWebhook || regeneratingWebhookToken}
            >
              {checkingLastInboundWebhook ? t("collab.webhookIn.checkLastReceived.busy") : t("collab.webhookIn.checkLastReceived")}
            </button>
            {lastInboundWebhookAt !== undefined && (
              <p className="muted small" role="status">
                {lastInboundWebhookAt
                  ? t("collab.webhookIn.lastReceived.some", { time: new Date(lastInboundWebhookAt).toLocaleString(LOCALE[lang]) })
                  : t("collab.webhookIn.lastReceived.never")}
              </p>
            )}
            {/*
              Round 1471: the failure-side counterpart to the success line
              just above -- only rendered once lastInboundWebhookFailure
              itself is non-null (a genuine recorded failure), so a project
              with no failure history shows nothing extra here at all.
            */}
            {lastInboundWebhookFailure != null && (
              <p className="muted small" role="status">
                {t("collab.webhookIn.lastFailure.some", {
                  time: new Date(lastInboundWebhookFailure.at).toLocaleString(LOCALE[lang]),
                  reason: lastInboundWebhookFailure.reason,
                })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
