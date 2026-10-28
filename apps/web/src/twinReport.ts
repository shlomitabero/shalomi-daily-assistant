import type { BusinessTwin, BusinessTwinEntityStat } from "./api.js";
import { safeDownloadName } from "./api.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

/**
 * The server (apps/api/src/twin.ts) returns entities in the spec's own
 * declaration order, not by activity -- so a project whose busiest entity
 * happened to be declared last showed its biggest number at the bottom of
 * the on-screen grid (BusinessTwinPanel.tsx, which imports this from here),
 * exactly backwards from how a stats dashboard is meant to read (biggest
 * numbers first). A plain `.sort()` on `count` alone isn't enough:
 * Array.prototype.sort is only guaranteed stable as of ES2019, and even
 * then, sorting descending by a key that has ties (multiple entities on 0
 * records, or on the same count) needs an explicit tie-break to keep those
 * tied entities in their original, predictable order rather than depending
 * on engine-specific behavior for the tie itself. Lives here (not in
 * BusinessTwinPanel.tsx, which imports it) so formatTwinReport below --
 * the plain-text "Copy"/"Download" snapshot of the exact same data -- can
 * use the identical order without a circular import.
 */
export function sortTwinStatsByCount(entities: BusinessTwinEntityStat[]): BusinessTwinEntityStat[] {
  return entities
    .map((entity, index) => ({ entity, index }))
    .sort((a, b) => b.entity.count - a.entity.count || a.index - b.index)
    .map(({ entity }) => entity);
}

/**
 * What share of the project's total records a single entity's own count
 * represents, as a whole-number percentage -- the live grid (BusinessTwinPanel.tsx,
 * which imports this from here) shows each tile's raw count and the panel's
 * own total separately, but never how the two relate on their own. Lives
 * here, not in BusinessTwinPanel.tsx, for the same reason sortTwinStatsByCount
 * above does: formatTwinReport below needs the identical figure without a
 * circular import. Guards against a zero/negative total (an otherwise-real
 * state for a freshly built project with no data seeded yet) the same
 * defensive way BuildProgress.tsx's own computeBuildProgressPercent does for
 * its own div-by-zero case.
 */
export function computeTwinStatPercent(count: number, totalRecords: number): number {
  if (totalRecords <= 0) return 0;
  return Math.round((count / totalRecords) * 100);
}

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
  // Same count-descending order the live panel's own grid already uses
  // (sortTwinStatsByCount above) -- without this, this report iterated
  // twin.entities in the server's raw spec-declaration order, silently
  // contradicting the "biggest numbers first" order a reader just saw on
  // screen the moment they share this exact snapshot.
  for (const e of sortTwinStatsByCount(twin.entities)) {
    // Same guard, and the same percent figure, the live tile already shows
    // next to this exact count (BusinessTwinPanel.tsx's own twin-stat-percent)
    // -- without this, the one artifact a person shares specifically to carry
    // that context (WhatsApp/email, see this function's own doc comment)
    // silently dropped the one number that says whether this entity is the
    // dominant one or a minor one.
    const percentSuffix =
      e.count > 0 && twin.totalRecords > 0
        ? ` (${t("twin.stat.percentOfTotal", { percent: computeTwinStatPercent(e.count, twin.totalRecords) })})`
        : "";
    lines.push(`- ${e.label}: ${e.count}${percentSuffix}`);
  }
  lines.push(`${t("twin.report.total")}: ${twin.totalRecords}`);

  // mostLinkedRecord, mostActiveObservation, and jumpableObservations are all
  // kept as their own structured fields (not inside `observations`) so the
  // live panel can make each a real clickable jump -- but the plain-text
  // report has no such distinction, so all are folded back in here as plain
  // bullets, in the same order BusinessTwinPanel.tsx renders them on screen
  // (mostActiveObservation before mostLinkedRecord).
  // twin.distributions/twin.numericStats are NOT folded in here separately --
  // computeBusinessTwin (apps/api/src/twin.ts) already spreads both of them
  // into jumpableObservations itself ("jumpableObservations.push(...
  // numericStats, ...distributions)"), so their own `.text` is already
  // present via the jumpableObservations line below. Folding them in again
  // here printed every distribution/numeric-aggregate sentence twice in the
  // one artifact a user actually shares (WhatsApp/email) -- the bug this
  // comment now guards against re-introducing.
  const allObservations = [
    ...(twin.mostActiveObservation ? [twin.mostActiveObservation.text] : []),
    ...(twin.mostLinkedRecord ? [twin.mostLinkedRecord.text] : []),
    ...twin.jumpableObservations.map((o) => o.text),
    ...twin.observations,
  ];
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
