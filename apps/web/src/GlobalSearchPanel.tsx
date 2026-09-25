import { useRef, useState } from "react";
import type { Entity, EntityRecord } from "@forge/shared";
import { listRecords } from "./api.js";
import { recordDisplayLabel, searchEntityRecords, type EntitySearchResult } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "./recentSearches.js";

/**
 * A single query box that searches every entity in the project at once,
 * instead of only the currently-open tab (`EntityPanel`'s own search box).
 * Reuses the exact same `matchesSearch` rule as the per-tab search, via
 * `searchEntityRecords`, so results here and results in a tab never
 * disagree about what counts as a match.
 *
 * Each result group's own "Jump to" button (onJumpToEntity) only ever
 * switched to the right entity tab, leaving a person to re-scan the same
 * table they just searched to find the one row they were actually after --
 * the exact record they clicked was known the whole time and simply
 * thrown away. onJumpToRecord makes each individual matched row itself
 * clickable, carrying its own id through so `EntityPanel` can scroll to
 * and highlight that specific row once the tab switch lands.
 */
export function GlobalSearchPanel({
  projectId,
  entities,
  onClose,
  onJumpToEntity,
  onJumpToRecord,
}: {
  projectId: string;
  entities: Entity[];
  onClose: () => void;
  onJumpToEntity: (entityName: string) => void;
  onJumpToRecord: (entityName: string, recordId: number) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => getRecentSearches(projectId));
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();
  // Bumped once per runSearch call, so a stale search whose network round
  // trip just happens to take longer than a newer one's can recognize
  // itself as superseded (see the guard right after the await below)
  // instead of overwriting the newer, still-correct results on screen.
  const searchRequestId = useRef(0);

  // Promise.allSettled rather than Promise.all: a single entity whose
  // records fail to load (a transient network blip, a cold-starting
  // backend) must not blank out results from every OTHER entity that
  // searched fine -- Promise.all would reject the whole search on that
  // one failure, showing nothing at all instead of the results a user
  // with, say, 9 working entity tables and 1 flaky one would still want.
  async function runSearch(q: string) {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      setSelectedIndex(null);
      return;
    }
    const requestId = ++searchRequestId.current;
    setLoading(true);
    setError(null);
    const settled = await Promise.allSettled(
      entities.map(async (entity) => {
        const { records } = await listRecords(projectId, entity.name);
        return searchEntityRecords(entity, records, q);
      }),
    );
    // A later call to runSearch (the user editing/resubmitting the query
    // before this one's own network round trip finished) has already
    // bumped searchRequestId past what this call captured -- applying
    // this call's results now would silently replace the newer, correct
    // ones on screen with stale ones for a query the user has already
    // moved past.
    if (searchRequestId.current !== requestId) return;
    const succeeded = settled
      .filter((r): r is PromiseFulfilledResult<EntitySearchResult | null> => r.status === "fulfilled")
      .map((r) => r.value);
    setResults(succeeded.filter((r): r is EntitySearchResult => r !== null));
    setSearched(true);
    setSelectedIndex(null);
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length > 0) {
      setError(
        failures.length === entities.length
          ? (failures[0].reason as Error).message
          : t("search.partialFailure", { failed: failures.length, total: entities.length }),
      );
    }
    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setRecentSearches(addRecentSearch(projectId, query));
    await runSearch(query);
  }

  async function handleRecentSearchClick(q: string) {
    setQuery(q);
    setRecentSearches(addRecentSearch(projectId, q));
    await runSearch(q);
  }

  function handleClearRecentSearches() {
    clearRecentSearches(projectId);
    setRecentSearches([]);
  }

  function recordPreview(entity: Entity, record: EntityRecord): string {
    return recordDisplayLabel(entity, record);
  }

  /**
   * Down/Up move a highlight across the result groups (not individual
   * records -- "jump" always lands on an entity tab, so the group is the
   * unit that matters), and Enter jumps to whichever group is highlighted.
   * Enter with nothing highlighted still submits the form as a normal
   * search, so this never changes behavior for someone who just types and
   * hits Enter once.
   */
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev === null ? results.length - 1 : Math.max(prev - 1, 0)));
    } else if (e.key === "Enter" && selectedIndex !== null) {
      e.preventDefault();
      onJumpToEntity(results[selectedIndex].entityName);
    }
  }

  return (
    <div className="history-overlay">
      <div className="history-panel search-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="search-panel-title">
        <div className="history-header">
          <h2 id="search-panel-title">{t("search.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <p className="muted small">{t("search.description")}</p>

        <form className="global-search-form" onSubmit={handleSubmit}>
          <input
            type="text"
            autoFocus
            className="global-search-input"
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <button type="submit" disabled={!query.trim()}>
            {t("search.submit")}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">{t("entity.loading")}</p>}

        {!loading && !searched && !error && (
          <>
            <p className="muted">{t("search.noQuery")}</p>
            {recentSearches.length > 0 && (
              <div className="global-search-recent">
                <div className="global-search-recent-header">
                  <span className="muted small">{t("search.recent.heading")}</span>
                  <button type="button" className="link-button small" onClick={handleClearRecentSearches}>
                    {t("search.recent.clear")}
                  </button>
                </div>
                <div className="chips">
                  {recentSearches.map((q) => (
                    <button type="button" key={q} className="chip chip-button" onClick={() => handleRecentSearchClick(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {!loading && searched && results.length === 0 && !error && <p className="muted">{t("search.noResults")}</p>}

        {!loading && results.length > 0 && <p className="muted small">{t("search.keyboardHint")}</p>}

        {!loading && results.length > 0 && (
          <div className="global-search-results">
            {results.map((result, i) => (
              <div
                key={result.entityName}
                className={
                  i === selectedIndex ? "global-search-group global-search-group-selected" : "global-search-group"
                }
              >
                <div className="global-search-group-header">
                  <span className="global-search-entity-label">{result.entityLabel}</span>
                  <span className="muted small">{t("search.resultCount", { count: result.totalMatches })}</span>
                  <button type="button" className="secondary small" onClick={() => onJumpToEntity(result.entityName)}>
                    {t("search.jumpTo")}
                  </button>
                </div>
                <ul className="global-search-hits">
                  {result.sample.map((record) => (
                    <li key={String(record.id)}>
                      <button
                        type="button"
                        className="link-button global-search-hit-button"
                        onClick={() => onJumpToRecord(result.entityName, record.id as number)}
                      >
                        {recordPreview(entities.find((e) => e.name === result.entityName)!, record)}
                      </button>
                    </li>
                  ))}
                </ul>
                {result.totalMatches > result.sample.length && (
                  <p className="muted small">{t("search.andMore", { count: result.totalMatches - result.sample.length })}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
