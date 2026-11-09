import type { CollaboratorRole, ProjectCollaborator } from "@forge/shared";
import { safeDownloadName, type AutomationActionType, type AutomationTrigger, type ProjectOwnerInfo } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

function roleLabel(role: CollaboratorRole, t: (key: string, params?: Record<string, string | number>) => string): string {
  return role === "viewer" ? t("collab.role.viewer") : t("collab.role.editor");
}

/** Round 1666: reuses AutomationsPanel.tsx's own short trigger/actionType labels ("automations.trigger." and "automations.actionType." keys) rather than duplicating them -- this report only needs to name which rule was deleted, not the full describeRule/describeDestination sentence those keys' siblings build (which needs field/entity context a deleted rule no longer has). */
function triggerLabel(trigger: AutomationTrigger, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (trigger === "record_created") return t("automations.trigger.recordCreated");
  if (trigger === "field_equals") return t("automations.trigger.fieldEquals");
  if (trigger === "schedule") return t("automations.trigger.schedule");
  if (trigger === "record_deleted") return t("automations.trigger.recordDeleted");
  if (trigger === "record_updated") return t("automations.trigger.recordUpdated");
  return t("automations.trigger.inboundWebhook");
}

function actionTypeLabel(actionType: AutomationActionType, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (actionType === "webhook") return t("automations.actionType.webhook");
  if (actionType === "send_email") return t("automations.actionType.sendEmail");
  return t("automations.actionType.sendWhatsapp");
}

/**
 * Round 1632: the deletion half of the createdByUserId/updatedByUserId
 * audit-trail pair (rounds 1613/1617), which the live record table itself
 * has no natural place to show (the row is gone) -- this report is the one
 * surface a collaborator can already reach for "what happened on this
 * project," so it's the natural home for "who deleted what." `email` is
 * already resolved by the caller (CollaboratorsPanel.tsx, using the exact
 * owner+collaborators data this same report already renders above), not
 * the raw `deletedByUserId` -- this module has no access to that lookup.
 */
export interface RecordDeletionForReport {
  entityName: string;
  recordLabel: string;
  deletedByEmail: string | null;
  deletedAt: string;
}

/**
 * Round 1636: the sibling of RecordDeletionForReport above, for
 * collaborator role changes/removal -- docs/security.md's own "Section
 * 40" note named this as the one gap left in this audit-trail family.
 * `targetEmail`/`changedByEmail` are already resolved by the caller
 * (CollaboratorsPanel.tsx), same reason as RecordDeletionForReport's own
 * `deletedByEmail`.
 */
export interface CollaboratorAccessChangeForReport {
  action: "invited" | "role_changed" | "removed" | "ownership_transferred";
  targetEmail: string | null;
  changedByEmail: string | null;
  previousRole: CollaboratorRole | null;
  newRole: CollaboratorRole | null;
  changedAt: string;
}

/**
 * Round 1639: the sibling of CollaboratorAccessChangeForReport above, for
 * entity/field label renames -- docs/security.md's own "Section 40" note
 * named this as the one sub-gap this audit-trail family left open.
 * `changedByEmail` is already resolved by the caller (CollaboratorsPanel.tsx),
 * same reason as the sibling report types' own *Email fields.
 */
export interface SchemaLabelEditForReport {
  action: "entity_renamed" | "field_renamed" | "role_added" | "role_removed" | "role_renamed";
  entityName: string;
  fieldName: string | null;
  changedByEmail: string | null;
  previousLabel: string;
  newLabel: string;
  changedAt: string;
}

/**
 * Round 1666: the sibling of SchemaLabelEditForReport above, for automation
 * rule deletions -- the one action in the automation-rule audit-trail
 * family (createdByUserId/updatedByUserId, round 1664) that still had no
 * trail at all. `deletedByEmail` is already resolved by the caller
 * (CollaboratorsPanel.tsx), same reason as the sibling report types' own
 * *Email fields. `entityName` is already resolved to its display label
 * the same way deletionsForReport/schemaLabelEditsForReport resolve
 * theirs; trigger/actionType stay as the raw enum values this module's
 * own triggerLabel/actionTypeLabel translate.
 */
export interface AutomationRuleDeletionForReport {
  entityName: string;
  trigger: AutomationTrigger;
  actionType: AutomationActionType;
  deletedByEmail: string | null;
  deletedAt: string;
}

/**
 * Renders the Collaborators panel's own already-fetched owner + collaborator
 * list as a plain, shareable text snapshot -- the same gap every other
 * read-heavy "list of real data" overlay panel in this app (Business Twin,
 * WhatsApp log, Time Machine, Global Search, Automations) already closed for
 * itself. An owner reviewing who currently has access to a project, or
 * handing that list to someone else, had no way to take it anywhere short of
 * a screenshot or transcribing it by hand.
 */
export function formatCollaboratorsReport(
  owner: ProjectOwnerInfo | null,
  collaborators: ProjectCollaborator[],
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
  recordDeletions: RecordDeletionForReport[] = [],
  accessChanges: CollaboratorAccessChangeForReport[] = [],
  schemaLabelEdits: SchemaLabelEditForReport[] = [],
  automationRuleDeletions: AutomationRuleDeletionForReport[] = [],
): string {
  const lines: string[] = [];
  lines.push(`${t("collab.title")} — ${projectName}`);
  lines.push(t("collab.report.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) }));
  lines.push("");

  if (owner) {
    lines.push(`${owner.email} — ${t("collab.owner")}`);
  }
  for (const c of collaborators) {
    lines.push(`${c.email} — ${roleLabel(c.role, t)} (${new Date(c.addedAt).toLocaleDateString(LOCALE[lang])})`);
  }
  // Round 1190: was `!owner && collaborators.length === 0` -- owner is
  // truthy for every normal project (CollaboratorsPanel.tsx's own Copy/
  // Download buttons are only rendered once `owner` is truthy at all, see
  // their own gating condition), so this line could never actually appear
  // for the single most common real state (an owner with zero invited
  // collaborators), even though the on-screen panel's own identical-
  // purpose empty check is gated only on `collaborators.length === 0`,
  // independent of owner.
  if (collaborators.length === 0) {
    lines.push(t("collab.empty"));
  }

  if (recordDeletions.length > 0) {
    lines.push("");
    lines.push(t("collab.report.recordDeletionsHeading"));
    for (const d of recordDeletions) {
      lines.push(
        t("collab.report.recordDeletedEntry", {
          label: d.recordLabel,
          entity: d.entityName,
          who: d.deletedByEmail ?? t("collab.report.unknownActor"),
          date: new Date(d.deletedAt).toLocaleString(LOCALE[lang]),
        }),
      );
    }
  }

  if (accessChanges.length > 0) {
    lines.push("");
    lines.push(t("collab.report.accessChangesHeading"));
    for (const c of accessChanges) {
      if (c.action === "invited") {
        // Round 1665: without its own explicit branch here, an "invited"
        // entry would silently fall into the final `else` below and render
        // with removedEntry's own text -- "X was removed from the project"
        // for what was actually a brand-new grant of access, the exact
        // opposite of what happened.
        lines.push(
          t("collab.report.invitedEntry", {
            who: c.targetEmail ?? t("collab.report.unknownActor"),
            role: c.newRole ? roleLabel(c.newRole, t) : "",
            by: c.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(c.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else if (c.action === "role_changed") {
        lines.push(
          t("collab.report.roleChangedEntry", {
            who: c.targetEmail ?? t("collab.report.unknownActor"),
            from: c.previousRole ? roleLabel(c.previousRole, t) : "",
            to: c.newRole ? roleLabel(c.newRole, t) : "",
            by: c.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(c.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else if (c.action === "ownership_transferred") {
        lines.push(
          t("collab.report.ownershipTransferredEntry", {
            who: c.targetEmail ?? t("collab.report.unknownActor"),
            by: c.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(c.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else {
        // Round 1751: targetEmail is now null, not the raw internal userId,
        // when the target isn't in either current list -- which is the
        // normal case for a removal, since removeCollaborator hard-deletes
        // the row the caller's email lookup is built from. Falls back to
        // the same unknownActor translation changedByEmail already uses.
        lines.push(
          t("collab.report.removedEntry", {
            who: c.targetEmail ?? t("collab.report.unknownActor"),
            by: c.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(c.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      }
    }
  }

  if (schemaLabelEdits.length > 0) {
    lines.push("");
    lines.push(t("collab.report.schemaLabelEditsHeading"));
    for (const e of schemaLabelEdits) {
      if (e.action === "entity_renamed") {
        lines.push(
          t("collab.report.entityRenamedEntry", {
            entity: e.entityName,
            from: e.previousLabel,
            to: e.newLabel,
            by: e.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(e.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else if (e.action === "field_renamed") {
        lines.push(
          t("collab.report.fieldRenamedEntry", {
            field: e.fieldName ?? "",
            entity: e.entityName,
            from: e.previousLabel,
            to: e.newLabel,
            by: e.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(e.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else if (e.action === "role_added") {
        // Round 1775: the first of 3 new branches this widened action
        // union needs -- without them, a role entry would silently fall
        // into the `else` below (field_renamed's own text) before this
        // round, or now into a wrong branch above it, misdescribing what
        // actually changed.
        lines.push(
          t("collab.report.roleAddedEntry", {
            role: e.newLabel,
            by: e.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(e.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else if (e.action === "role_removed") {
        lines.push(
          t("collab.report.roleRemovedEntry", {
            role: e.previousLabel,
            by: e.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(e.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      } else {
        lines.push(
          t("collab.report.roleRenamedEntry", {
            from: e.previousLabel,
            to: e.newLabel,
            by: e.changedByEmail ?? t("collab.report.unknownActor"),
            date: new Date(e.changedAt).toLocaleString(LOCALE[lang]),
          }),
        );
      }
    }
  }

  if (automationRuleDeletions.length > 0) {
    lines.push("");
    lines.push(t("collab.report.automationRuleDeletionsHeading"));
    for (const d of automationRuleDeletions) {
      lines.push(
        t("collab.report.automationRuleDeletedEntry", {
          entity: d.entityName,
          trigger: triggerLabel(d.trigger, t),
          action: actionTypeLabel(d.actionType, t),
          by: d.deletedByEmail ?? t("collab.report.unknownActor"),
          date: new Date(d.deletedAt).toLocaleString(LOCALE[lang]),
        }),
      );
    }
  }

  return lines.join("\n").trimEnd();
}

/** Saves the already-rendered report text as a real downloaded .txt file, the same browser-download mechanics automationsReport.ts's downloadAutomationsReport uses. */
export function downloadCollaboratorsReport(text: string, projectName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(projectName, "forge-app")}-collaborators.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
