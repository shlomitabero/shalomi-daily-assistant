import type { CollaboratorRole, ProjectCollaborator } from "@forge/shared";
import { safeDownloadName, type ProjectOwnerInfo } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

function roleLabel(role: CollaboratorRole, t: (key: string, params?: Record<string, string | number>) => string): string {
  return role === "viewer" ? t("collab.role.viewer") : t("collab.role.editor");
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
