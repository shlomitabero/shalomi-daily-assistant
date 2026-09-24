import type { WhatsAppMessageLogEntry } from "./api.js";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

/**
 * Renders the WhatsApp message log (already fetched into the panel -- no
 * extra network round-trip) as a plain, shareable text snapshot -- same
 * "plain UTF-8 text, not a PDF" reasoning as twinReport.ts's own doc
 * comment (this app's Hebrew-first audience means a real PDF would need an
 * embedded Hebrew font, a bigger undertaking than this feature's value
 * justifies). Lets a person keep a real record of a business conversation
 * -- for a dispute, an invoice, or just their own files -- before using
 * the panel's own "Clear history" button, which is irreversible.
 */
export function formatWhatsAppLog(
  messages: WhatsAppMessageLogEntry[],
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  lines.push(`${t("whatsapp.title")} — ${projectName}`);
  lines.push(t("whatsapp.log.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) }));
  lines.push("");

  if (messages.length === 0) {
    lines.push(t("whatsapp.log.empty"));
    return lines.join("\n");
  }

  for (const m of messages) {
    const direction = m.direction === "in" ? t("whatsapp.log.incoming") : t("whatsapp.log.outgoing");
    const who = m.matchedLabel ?? (m.direction === "in" ? m.fromNumber : m.toNumber);
    const time = new Date(m.createdAt).toLocaleString(LOCALE[lang]);
    const status = m.status === "failed" ? ` [${t("whatsapp.log.failed")}]` : "";
    lines.push(`[${time}] ${direction} — ${who}${status}`);
    lines.push(m.body);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Saves the already-rendered log text as a real downloaded .txt file, the same browser-download mechanics twinReport.ts's downloadTwinReport uses. */
export function downloadWhatsAppLog(text: string, projectName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(projectName, "forge-app")}-whatsapp-log.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
