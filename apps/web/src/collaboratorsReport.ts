import type { CollaboratorRole, ProjectCollaborator } from "@forge/shared";
import { safeDownloadName, type ProjectOwnerInfo } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

function roleLabel(role: CollaboratorRole, t: (key: string, params?: Record<string, string | number>) => string): string {
  return role === "viewer" ? t("collab.role.viewer") : t("collab.role.editor");
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
  if (!owner && collaborators.length === 0) {
    lines.push(t("collab.empty"));
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
