import type { BusinessTwin } from "./api.js";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

/**
 * Renders the Business Twin's own data (already fetched into the panel --
 * no extra network round-trip) as a plain, shareable text snapshot. Plain
 * UTF-8 text rather than a PDF deliberately: this app's Hebrew-first
 * audience means a "real" PDF would need an embedded font with Hebrew
 * glyphs (the 14 standard PDF fonts are Latin-only) -- a genuinely bigger,
 * riskier undertaking than this feature's actual value justifies right
 * now. Plain text has no such limitation and is trivially shareable
 * (WhatsApp, email, paste anywhere) without ever mis-rendering Hebrew.
 */
export function formatTwinReport(
  twin: BusinessTwin,
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  lines.push(`${t("twin.title")} — ${projectName}`);
  lines.push(t("twin.report.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) }));
  lines.push("");
  if (twin.summary.trim().length > 0) {
    lines.push(twin.summary);
    lines.push("");
  }
  if (twin.roles.length > 0) {
    lines.push(`${t("twin.report.roles")}: ${twin.roles.join(", ")}`);
    lines.push("");
  }
  lines.push(`${t("twin.report.records")}:`);
  for (const e of twin.entities) {
    lines.push(`- ${e.label}: ${e.count}`);
  }
  lines.push(`${t("twin.report.total")}: ${twin.totalRecords}`);

  // mostLinkedRecord is kept as its own structured field (not inside
  // `observations`) so the live panel can make it a real clickable jump --
  // but the plain-text report has no such distinction, so it's folded back
  // in here as one more bullet, in the same position it held before that split.
  const allObservations = twin.mostLinkedRecord ? [twin.mostLinkedRecord.text, ...twin.observations] : twin.observations;
  if (allObservations.length > 0) {
    lines.push("");
    lines.push(`${t("twin.observations")}:`);
    for (const o of allObservations) {
      lines.push(`- ${o}`);
    }
  }
  return lines.join("\n");
}

/** Saves the already-rendered report text as a real downloaded .txt file, the same browser-download mechanics api.ts's downloadBlob uses for exports/backups. */
export function downloadTwinReport(text: string, projectName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(projectName, "forge-app")}-business-twin.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
