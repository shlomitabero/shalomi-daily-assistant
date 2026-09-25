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

/**
 * Case-insensitive substring match against a message's own body text AND
 * the same "who" a person actually sees in the log row (matchedLabel, or
 * the raw phone number when nothing matched) -- mirrors filterCheckpoints'
 * own convention in checkpointDiff.ts for a long, ever-growing list with no
 * cap and no delete (a WhatsApp conversation only ever gets longer).
 * Matching on the displayed "who", not just the body, lets someone find
 * every message from a specific customer even when their own words don't
 * happen to repeat a search term.
 */
export function filterWhatsAppMessages(messages: WhatsAppMessageLogEntry[], search: string): WhatsAppMessageLogEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return messages;
  return messages.filter((m) => {
    const who = m.matchedLabel ?? (m.direction === "in" ? m.fromNumber : m.toNumber);
    return m.body.toLowerCase().includes(query) || who.toLowerCase().includes(query);
  });
}

/**
 * How many of the message log's entries are currently showing versus how
 * many exist in total -- the same two-distinct-phrasings convention
 * formatEntityRecordCount (entityFormatting.ts, round 155) and
 * formatMyProjectsCount (App.tsx, round 167) already established
 * elsewhere in this app, applied here to the WhatsApp log's own search
 * box (round 162): the search only even appears once there are more than
 * SEARCH_THRESHOLD messages, exactly the point where a person can no
 * longer tell at a glance how many of a long, never-capped conversation
 * history a search actually matched.
 */
export function formatWhatsAppMessageCount(
  shown: number,
  total: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return shown === total
    ? t("whatsapp.log.count.all", { count: total })
    : t("whatsapp.log.count.filtered", { shown, total });
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
