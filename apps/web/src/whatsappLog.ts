import type { Entity } from "@forge/shared";
import type { WhatsAppMessageLogEntry } from "./api.js";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

// Round 1137: hand-duplicated entityLabelOccurrences/entityDisplayLabel
// pair, same shape as every other consuming module in this codebase
// (WhatsAppPanel.tsx, AutomationsPanel.tsx, automationsReport.ts,
// checkpointDiff.ts, pipeline.ts) -- the Entity Label editor doesn't
// enforce uniqueness, so two entities can legitimately share one label,
// and every other display surface disambiguates that with the entity's
// own raw name in parens.
function entityLabelOccurrences(entities: Entity[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const e of entities) {
    const label = e.label ?? e.name;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  return occurrences;
}

function entityDisplayLabel(entity: Entity, occurrences: Map<string, number>): string {
  const label = entity.label ?? entity.name;
  return (occurrences.get(label) ?? 0) > 1 ? `${label} (${entity.name})` : label;
}

/** Falls back to the raw stored entityName when the entity has since been renamed or deleted -- same convention as WhatsAppPanel.tsx's own matchedEntityLabel/AutomationsPanel's entityLabel helpers for a reference that no longer resolves. */
function matchedEntityLabel(entityName: string, entities: Entity[]): string {
  const entity = entities.find((e) => e.name === entityName);
  return entity ? entityDisplayLabel(entity, entityLabelOccurrences(entities)) : entityName;
}

/**
 * Renders the WhatsApp message log (already fetched into the panel -- no
 * extra network round-trip) as a plain, shareable text snapshot -- same
 * "plain UTF-8 text, not a PDF" reasoning as twinReport.ts's own doc
 * comment (this app's Hebrew-first audience means a real PDF would need an
 * embedded Hebrew font, a bigger undertaking than this feature's value
 * justifies). Lets a person keep a real record of a business conversation
 * -- for a dispute, an invoice, or just their own files -- before using
 * the panel's own "Clear history" button, which is irreversible.
 *
 * Round 1137: the on-screen log (WhatsAppPanel.tsx) shows a matched
 * message's own entity label right next to its matched name (round 957,
 * since a matched name alone can't tell a Customer named "Dana" apart from
 * a Lead named "Dana") -- this report never took an `entities` param at
 * all, so the exact same disambiguation it exists to show was silently
 * missing from the one artifact a person actually keeps/shares.
 */
export function formatWhatsAppLog(
  messages: WhatsAppMessageLogEntry[],
  entities: Entity[],
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
    const entitySuffix = m.matchedEntityName ? ` — ${matchedEntityLabel(m.matchedEntityName, entities)}` : "";
    const time = new Date(m.createdAt).toLocaleString(LOCALE[lang]);
    const status = m.status === "failed" ? ` [${t("whatsapp.log.failed")}]` : "";
    lines.push(`[${time}] ${direction} — ${who}${entitySuffix}${status}`);
    lines.push(m.body);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Case-insensitive substring match against a message's own body text AND
 * the same "who" a person actually sees in the log row (matchedLabel, or
 * the raw phone number when nothing matched) -- mirrors filterCheckpoints'
 * own convention in checkpointDiff.ts for a long, ever-growing list (a
 * WhatsApp conversation only ever gets longer, and paginates rather than
 * capping out, since round 263). Matching on the displayed "who", not just
 * the body, lets someone find every message from a specific customer even
 * when their own words don't happen to repeat a search term.
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
 *
 * `hasMore` (round 263) covers the case a plain shown===total comparison
 * can't see: the server itself only ever hands over one page at a time, so
 * "all 50 loaded so far are showing" and "these are truly every message
 * that exists" are different facts. Before pagination, this always claimed
 * "N of N (all)" once every *loaded* message passed the search/filter --
 * even when 200 older ones sat unfetched behind the "load older" button.
 */
export function formatWhatsAppMessageCount(
  shown: number,
  total: number,
  t: (key: string, params?: Record<string, string | number>) => string,
  hasMore = false,
): string {
  if (shown !== total) return t("whatsapp.log.count.filtered", { shown, total });
  if (hasMore) return t("whatsapp.log.count.hasMore", { count: total });
  // A count of exactly 1 is this log's own default first-use state --
  // the very first WhatsApp message ever sent/received for a project --
  // not a rare edge case, so "1 messages"/"1 הודעות" was wrong from day
  // one. Only this branch needs the singular split: listWhatsAppMessages
  // (packages/db/src/whatsapp.ts) always requests a full page (50) at a
  // time, and `hasMore` is only ever true when that full page came back,
  // so `hasMore && total === 1` can never happen -- "1+ messages" is
  // unreachable, confirmed by reading the pagination query directly.
  // Mirrors the identical .one/.many split rounds 1388/1389 used for
  // formatCheckpointCount/formatMyProjectsCount.
  return total === 1 ? t("whatsapp.log.count.all.one", { count: total }) : t("whatsapp.log.count.all.many", { count: total });
}

export type WhatsAppLogFilter = "all" | "in" | "out" | "failed";

/**
 * Narrows the log to one of: every message, only incoming, only outgoing,
 * or only failed sends -- applied together with (not instead of)
 * filterWhatsAppMessages' own text search, the same two-independent-
 * filters combination EntityPanel.tsx's search+statusFilter already use
 * on the entity table. A long, ever-growing conversation -- paginated since
 * round 263, and always deletable one message (or the whole log) at a time
 * via deleteWhatsAppMessage/clearWhatsAppMessages -- is exactly where being
 * able to isolate "just what I sent" or "just what failed" matters --
 * scanning by eye stops working once the log gets long.
 */
export function filterWhatsAppMessagesByDirection(
  messages: WhatsAppMessageLogEntry[],
  filter: WhatsAppLogFilter,
): WhatsAppMessageLogEntry[] {
  if (filter === "all") return messages;
  if (filter === "failed") return messages.filter((m) => m.status === "failed");
  return messages.filter((m) => m.direction === filter);
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
