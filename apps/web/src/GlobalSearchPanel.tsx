import { useState } from "react";
import type { Entity, EntityRecord } from "@forge/shared";
import { listRecords } from "./api.js";
import { recordDisplayLabel, searchEntityRecords, type EntitySearchResult } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";

/**
 * A single query box that searches every entity in the project at once,
 * instead of only the currently-open tab (`EntityPanel`'s own search box).
 * Reuses the exact same `matchesSearch` rule as the per-tab search, via
 * `searchEntityRecords`, so results here and results in a tab never
 * disagree about what counts as a match.
 */
export function GlobalSearchPanel({
  projectId,
  entities,
  onClose,
  onJumpToEntity,
}: {
  projectId: string;
  entities: Entity[];
  onClose: () => void;
  onJumpToEntity: (entityName: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function runSearch(q: string) {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const perEntity = await Promise.all(
        entities.map(async (entity) => {
          const { records } = await listRecords(projectId, entity.name);
          return searchEntityRecords(entity, records, q);
        }),
      );
      setResults(perEntity.filter((r): r is EntitySearchResult => r !== null));
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await runSearch(query);
  }

  function recordPreview(entity: Entity, record: EntityRecord): string {
    return recordDisplayLabel(entity, record);
  }

  return (
    <div className="history-overlay">
      <div className="history-panel search-panel">
        <div className="history-header">
          <h2>{t("search.title")}</h2>
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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={!query.trim()}>
            {t("search.submit")}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">{t("entity.loading")}</p>}

        {!loading && !searched && !error && <p className="muted">{t("search.noQuery")}</p>}
        {!loading && searched && results.length === 0 && !error && <p className="muted">{t("search.noResults")}</p>}

        {!loading && results.length > 0 && (
          <div className="global-search-results">
            {results.map((result) => (
              <div key={result.entityName} className="global-search-group">
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
                      {recordPreview(entities.find((e) => e.name === result.entityName)!, record)}
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
