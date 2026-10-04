import type { Entity, EntityRecord } from "@forge/shared";
import { safeDownloadName } from "./api.js";
import { recordDisplayLabel, type EntitySearchResult } from "./entityFormatting.js";
import type { Lang } from "./i18n/language.js";

const LOCALE: Record<Lang, string> = { he: "he-IL", en: "en-US" };

/**
 * Renders the search panel's own already-fetched results as a plain,
 * shareable text snapshot -- same "plain UTF-8 text, not a PDF" reasoning
 * as twinReport.ts's own doc comment. Global Search was the one panel in
 * this app that searches across every entity in a project at once and had
 * no way to take that result set anywhere at all: results only ever
 * existed on screen until the panel closed. `expandedSamples` mirrors
 * exactly what the panel itself is currently showing (including any
 * "Show all" expansions), so the copied/downloaded text never disagrees
 * with what's actually on screen.
 */
export function formatSearchResults(
  results: EntitySearchResult[],
  entities: Entity[],
  expandedSamples: Record<string, EntityRecord[]>,
  query: string,
  projectName: string,
  lang: Lang,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  lines.push(`${t("search.title")} — ${projectName}`);
  lines.push(t("search.report.generatedAt", { date: new Date().toLocaleString(LOCALE[lang]) }));
  lines.push(t("search.report.query", { query }));
  lines.push("");

  if (results.length === 0) {
    lines.push(t("search.noResults"));
    return lines.join("\n").trimEnd();
  }

  for (const result of results) {
    const entity = entities.find((e) => e.name === result.entityName);
    const displayed = expandedSamples[result.entityName] ?? result.sample;
    lines.push(`${result.entityLabel} — ${t("search.resultCount", { count: result.totalMatches })}`);
    for (const record of displayed) {
      lines.push(`- ${entity ? recordDisplayLabel(entity, record) : `#${record.id}`}`);
    }
    const remaining = result.totalMatches - displayed.length;
    if (remaining > 0) {
      lines.push(t("search.report.andMore", { count: remaining }));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Saves the already-rendered results text as a real downloaded .txt file, the same browser-download mechanics checkpointDiff.ts's downloadCheckpointHistory uses. */
export function downloadSearchResults(text: string, projectName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeDownloadName(projectName, "forge-app")}-search-results.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
