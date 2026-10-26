import { useEffect, useRef, useState } from "react";
import type { Entity, EntityRecord } from "@forge/shared";
import { listRecords } from "./api.js";
import {
  recordDisplayLabel,
  scrollIntoViewRespectingMotion,
  searchEntityRecords,
  splitHighlightSegments,
  splitLinkSegments,
  type EntitySearchResult,
  type RelatedRecordsByEntity,
} from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { addRecentSearch, clearRecentSearches, getRecentSearches, removeRecentSearch } from "./recentSearches.js";
import { downloadSearchResults, formatSearchResults } from "./searchReport.js";

/**
 * Mirrors EntityPanel.tsx's own Highlighted wrapper (round 195) around the
 * same splitHighlightSegments -- a result row here already told you a
 * record matched, but not where within its own display label the match
 * actually was, the same gap the per-tab search box had.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {splitHighlightSegments(text, query).map((seg, i) =>
        seg.matched ? (
          <mark key={i} className="search-match">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Round 1050: closes round 1049's own deferred sibling gap -- a record's
 * display label (recordPreview below) can fall back to a `text`/`longtext`
 * field (pickDisplayField, entityFormatting.ts) when the entity has no
 * name/title field, so a URL or email embedded in that field (e.g. a
 * `Lead` entity whose only usable display field is `website`) rendered as
 * inert text here, the same gap round 1049 already fixed for the WhatsApp
 * message log. Round 1049 deliberately did NOT extend that fix to this
 * file, since each row used to be a single native `<button>` -- nesting a
 * real `<a>` inside a `<button>` is invalid HTML with broken click-target
 * behavior. This round's own row restructure (role="button" div instead
 * of a native button -- see the result-row JSX below) removes that
 * blocker, so this composes splitLinkSegments with Highlighted exactly
 * the way WhatsAppPanel.tsx's LinkifiedBody already does, with each link's
 * own onClick stopping propagation so clicking it opens the link instead
 * of also triggering the row's own onJumpToRecord.
 */
function LinkifiedHighlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitLinkSegments(text).map((seg, i) =>
        seg.href ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="cell-link"
            onClick={(e) => e.stopPropagation()}
          >
            {seg.text}
          </a>
        ) : (
          <Highlighted key={i} text={seg.text} query={query} />
        ),
      )}
    </>
  );
}

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
  projectName,
  entities,
  userId,
  onClose,
  onJumpToEntity,
  onJumpToRecord,
}: {
  projectId: string;
  projectName: string;
  entities: Entity[];
  userId: string;
  onClose: () => void;
  onJumpToEntity: (entityName: string) => void;
  onJumpToRecord: (entityName: string, recordId: number) => void;
}) {
  const { t, lang } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  // The query text the currently-shown `results` actually matched, kept
  // separate from the live `query` input state above: without it, typing
  // ahead into the box after a search already ran (before hitting submit
  // again) would immediately start highlighting the new, not-yet-searched
  // text against results that were matched on the old query.
  const [highlightQuery, setHighlightQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => getRecentSearches(projectId, userId));
  // A group's "and N more" text used to be a dead end -- the extra matches
  // were real (totalMatches said so) but nothing on screen could reach
  // them short of switching tabs and re-typing the same search. Keyed by
  // entityName so expanding one group's "Show all" never affects another's.
  const [expandedSamples, setExpandedSamples] = useState<Record<string, EntityRecord[]>>({});
  const [showAllLoading, setShowAllLoading] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);
  const resultsContainerRef = useRef<HTMLDivElement>(null);
  // Bumped once per runSearch call, so a stale search whose network round
  // trip just happens to take longer than a newer one's can recognize
  // itself as superseded (see the guard right after the await below)
  // instead of overwriting the newer, still-correct results on screen.
  const searchRequestId = useRef(0);
  // Every entity's own records from the most recently *completed* search,
  // keyed by entity name -- reused as `matchesSearch`'s relatedRecords so a
  // relation field's search match resolves to its real display label (e.g.
  // "Dana Levi") instead of a raw foreign-key id, with zero extra network
  // calls: since this search already fetches every entity's records to
  // search them, that same result set doubles as the lookup table for
  // whichever OTHER entity a relation field happens to point at. handleShowAll
  // reuses it too, since it's a same-query follow-up on results already shown.
  const lastRecordsByEntityRef = useRef<RelatedRecordsByEntity>({});
  // Round 904: `error` is shared between runSearch's own partial/full-
  // failure message and handleShowAll's round-663 catch -- a successful
  // handleShowAll must only clear it when IT was the one that set it (a
  // failed, now-retried "Show all" for this same entity), never when the
  // currently-shown error is actually runSearch's own still-unresolved
  // failure for a completely different, unrelated entity.
  const errorFromShowAllRef = useRef(false);

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
      setHighlightQuery("");
      setSelectedIndex(null);
      return;
    }
    const requestId = ++searchRequestId.current;
    setLoading(true);
    setError(null);
    errorFromShowAllRef.current = false;
    const settled = await Promise.allSettled(
      entities.map(async (entity) => {
        const { records } = await listRecords(projectId, entity.name);
        return [entity.name, records] as const;
      }),
    );
    // A later call to runSearch (the user editing/resubmitting the query
    // before this one's own network round trip finished) has already
    // bumped searchRequestId past what this call captured -- applying
    // this call's results now would silently replace the newer, correct
    // ones on screen with stale ones for a query the user has already
    // moved past.
    if (searchRequestId.current !== requestId) return;
    const recordsByEntity: RelatedRecordsByEntity = {};
    for (const result of settled) {
      if (result.status === "fulfilled") {
        const [name, records] = result.value;
        recordsByEntity[name] = records;
      }
    }
    lastRecordsByEntityRef.current = recordsByEntity;
    const succeeded = entities
      .map((entity) =>
        recordsByEntity[entity.name]
          ? searchEntityRecords(entity, recordsByEntity[entity.name], q, 5, entities, recordsByEntity, lang)
          : null,
      )
      .filter((r): r is EntitySearchResult => r !== null);
    // Entity groups are shown in descending totalMatches order rather than
    // whichever order the project's entities happen to be declared in --
    // without this, an entity with one coincidental match could sit above
    // one with fifty, just because it comes first in the spec, which has
    // nothing to do with how relevant either group actually is to the
    // query. Array.prototype.sort is stable (ES2019+), so two entities
    // tied on totalMatches keep their original declared order rather than
    // visibly reshuffling between searches for no reason.
    succeeded.sort((a, b) => b.totalMatches - a.totalMatches);
    setResults(succeeded);
    setSearched(true);
    setHighlightQuery(q);
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
    setExpandedSamples({});
    setRecentSearches(addRecentSearch(projectId, userId, query));
    await runSearch(query);
  }

  async function handleRecentSearchClick(q: string) {
    setQuery(q);
    setExpandedSamples({});
    setRecentSearches(addRecentSearch(projectId, userId, q));
    await runSearch(q);
  }

  /**
   * Fetches this one entity's records again (a cheap, idempotent GET --
   * the same request runSearch already made) and re-filters them with no
   * sample cap, so "Show all" reveals every real match instead of just the
   * first 5. Keyed per entity in expandedSamples rather than reusing
   * `results` in place, so a still-collapsed group elsewhere is untouched.
   *
   * Guarded by searchRequestId the same way runSearch guards its own
   * network round trip (round 412; flagged but not pursued back in round
   * 394): without it, a new search started while this fetch is still in
   * flight (the user editing/resubmitting the query before this "Show
   * all" round trip finishes) resolves into expandedSamples anyway,
   * merging a sample matched against the OLD query into results now
   * showing the NEW one -- wrong records, a `remaining` count that no
   * longer matches `totalMatches`, and "jump to record" targets that
   * don't correspond to anything the on-screen search actually matched.
   *
   * Also patches this entity's own `totalMatches` in `results` to this
   * fresh fetch's real count (round 556): without it, data that changed
   * since the original search -- a collaborator's edit, a WhatsApp-matched
   * write, anything while the panel stayed open on the same, still-current
   * query -- left the header's "N results" text and the `remaining`
   * calculation reading the original search's now-stale count even though
   * `displayed` already reflects this fetch's real, current data; a
   * record added since then left the header undercounting what's on
   * screen, and one removed left the "Show N more" button offering more
   * results than actually exist, forever (clicking it just re-fetches the
   * same already-complete list with no new rows to reveal).
   *
   * Also surfaces a failed fetch via setError (round 663): without this,
   * a rejected listRecords call (a timeout, a cold-starting backend, a
   * 404 from an entity a collaborator removed) was an unhandled promise
   * rejection -- the "Loading…" button silently reverted to "Show N more"
   * with zero visible indication anything went wrong, unlike runSearch's
   * own identical listRecords call just above, which already surfaces a
   * failure through this same error banner.
   *
   * Round 983: round 556's own totalMatches patch above only ever
   * considered a fresh count that shrinks but stays positive -- when
   * every one of this entity's previously-matching records has since
   * been deleted or edited away, this entity's group is removed from
   * `results` entirely instead, restoring runSearch's own invariant that
   * a 0-match entity is never shown. See the removal branch's own
   * comment inline for why patching to a literal 0 instead left a
   * permanently stuck, empty group with no way to dismiss it.
   */
  async function handleShowAll(entityName: string) {
    const entity = entities.find((e) => e.name === entityName);
    if (!entity) return;
    const requestId = searchRequestId.current;
    setShowAllLoading((prev) => new Set(prev).add(entityName));
    try {
      const { records } = await listRecords(projectId, entityName);
      if (searchRequestId.current !== requestId) return;
      // Keeps the shared relation-label lookup in sync with the fresh data
      // this fetch just pulled -- without this, a DIFFERENT entity's own
      // later "Show all" (which reads this exact ref for resolving a
      // relation field pointing at entityName) kept matching against this
      // entity's data as it stood at the ORIGINAL search, not the fresh
      // snapshot already sitting right here in memory.
      lastRecordsByEntityRef.current = { ...lastRecordsByEntityRef.current, [entityName]: records };
      const full = searchEntityRecords(
        entity,
        records,
        highlightQuery,
        records.length,
        entities,
        lastRecordsByEntityRef.current,
        lang,
      );
      if (!full) {
        // Round 983: every one of this entity's previously-matching
        // records has since been deleted or edited away (a collaborator,
        // a WhatsApp-triggered automation write, another tab) -- there is
        // nothing left to show. runSearch's own normal path already
        // filters out any entity searchEntityRecords returns null for
        // (a 0-match entity group is never supposed to be visible at
        // all), but patching totalMatches to 0 here instead of removing
        // the group left it rendered forever: the header still read "0
        // results", the list was empty, and remaining (0 - 0) was never
        // > 0 either, so the one button that reaches this code path
        // never reappeared -- a permanently stuck, empty group with no
        // way to dismiss it short of starting a brand-new search.
        // Resetting selectedIndex too: removing an entry shifts every
        // later index down, which could otherwise leave a keyboard-
        // highlighted selection pointing past the end of the shrunk
        // array (or at the wrong group), and Enter on an out-of-bounds
        // index would throw.
        setResults((prev) => prev.filter((r) => r.entityName !== entityName));
        setSelectedIndex(null);
      } else {
        setExpandedSamples((prev) => ({ ...prev, [entityName]: full.sample }));
        // Round 1020: runSearch's own sort just above establishes the
        // panel's documented "descending totalMatches order" once, at the
        // original search -- but this patches one group's own count to a
        // fresh, possibly much larger number (the exact "data changed
        // while the panel stayed open" case round 983's own comment right
        // above already names: a collaborator's edit, an automation
        // write, another tab) without ever re-sorting. A group that was
        // genuinely smaller at search time can now hold more real matches
        // than one still sitting above it, visibly contradicting this
        // panel's own ordering contract (a smaller count rendered above a
        // larger one) until the next brand-new search happens to fix it
        // by chance. Re-sorting with the identical comparator keeps this
        // self-consistent the instant the count itself changes.
        // Round 1033: selectedIndex is a plain array SLOT number into
        // `results`, set by arrow-key navigation and consumed by both
        // Enter (results[selectedIndex].entityName) and the "selected"
        // highlight/scroll-into-view effect just below (keyed on the
        // index value itself). The re-sort above never adjusts it, so a
        // keyboard-highlighted group can land at a different slot after
        // reordering while selectedIndex still points at its OLD slot --
        // the exact same "index now names the wrong thing" hazard round
        // 983's own selectedIndex reset (right above this branch) already
        // guards against for a removal, just never extended to a resort.
        // Resolves the SAME entity to its new slot instead of leaving a
        // stale number, so Enter still jumps to whatever the user actually
        // highlighted, not whatever reordering happened to leave behind.
        // React doesn't guarantee a setState updater function runs
        // synchronously at the point it's passed to the setter (confirmed
        // empirically, against the real exported app's equivalent in
        // codegen.ts: a value written inside a setResults updater was
        // still unset on the very next line) -- so the new index can't be
        // threaded through a side-effect variable written by that updater.
        // Computes the sorted array directly from the current `results`
        // closure instead (the same closure-read tolerance `entityName`/
        // `full.sample.length` just above already rely on), so the
        // resolved index is known synchronously, before either setState
        // call.
        const selectedEntityName = selectedIndex !== null ? results[selectedIndex]?.entityName ?? null : null;
        const nextResults = results
          .map((r) => (r.entityName === entityName ? { ...r, totalMatches: full.sample.length } : r))
          .sort((a, b) => b.totalMatches - a.totalMatches);
        setResults(nextResults);
        if (selectedEntityName !== null) {
          const newIndex = nextResults.findIndex((r) => r.entityName === selectedEntityName);
          setSelectedIndex(newIndex === -1 ? null : newIndex);
        }
      }
      // Round 904: a failed "Show all" (just below) surfaces through this
      // same shared `error` banner -- succeeding on a later retry must
      // clear it, the same self-healing convention runSearch's own clear-
      // on-start already follows. But `error` is ALSO used for runSearch's
      // own still-unresolved partial/full-search failure, which this
      // entity's unrelated, successful "Show all" must never silently
      // dismiss -- errorFromShowAllRef (set only in the catch below, reset
      // by runSearch's own clear-on-start) is what tells these two sources
      // apart.
      if (errorFromShowAllRef.current) {
        setError(null);
        errorFromShowAllRef.current = false;
      }
    } catch (err) {
      // Round 923: the success path above already discards a stale
      // "Show all" fetch a newer top-level search has since superseded
      // (the requestId check just above it, round 412) -- this catch
      // never got the same guard when round 663 added it, so a stale
      // fetch that rejects AFTER the user has already moved on to a new
      // search used to surface its own unrelated error over the new
      // search's current results.
      if (searchRequestId.current !== requestId) return;
      setError((err as Error).message);
      errorFromShowAllRef.current = true;
    } finally {
      setShowAllLoading((prev) => {
        const next = new Set(prev);
        next.delete(entityName);
        return next;
      });
    }
  }

  function handleClearRecentSearches() {
    clearRecentSearches(projectId, userId);
    setRecentSearches([]);
  }

  function handleRemoveRecentSearch(q: string) {
    setRecentSearches(removeRecentSearch(projectId, userId, q));
  }

  function handleDownload() {
    downloadSearchResults(
      formatSearchResults(results, entities, expandedSamples, highlightQuery, projectName, lang, t),
      projectName,
    );
  }

  /**
   * Same "Copy report" companion action every other read-heavy panel in
   * this app already has (Business Twin round 222, WhatsApp log round
   * 223, Time Machine round 224) for its own Download button -- Global
   * Search was the one panel that searches across every entity in a
   * project at once and had no way to take that result set anywhere at
   * all, not even a Download button, let alone a Copy one.
   */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(
        formatSearchResults(results, entities, expandedSamples, highlightQuery, projectName, lang, t),
      );
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  function recordPreview(entity: Entity, record: EntityRecord): string {
    return recordDisplayLabel(entity, record);
  }

  // Mirrors EntityPanel.tsx's own focusedRowId scroll effect (round 260):
  // with more result groups than fit in the panel's own scrollable height,
  // arrow-key navigation could move the highlight below the fold with zero
  // visual cue, and Enter would then jump to a group the user couldn't see
  // was even selected.
  useEffect(() => {
    if (selectedIndex == null) return;
    const group = resultsContainerRef.current?.querySelector(`[data-group-index="${selectedIndex}"]`);
    scrollIntoViewRespectingMotion(group, { behavior: "smooth", block: "nearest" });
  }, [selectedIndex]);

  // Round 875: runSearch itself already resets selectedIndex once a new
  // search actually completes (both the empty-query early-return and the
  // real-results branch above) -- but nothing reset it the moment the
  // query text itself changed, before that new search ever runs. Arrow-key
  // selecting a result group, then editing the query to something else
  // entirely, left selectedIndex pointing at a group from the OLD search.
  // handleInputKeyDown's Enter branch only checks `selectedIndex !== null`,
  // never that it still corresponds to the text currently in the box, so
  // pressing Enter called preventDefault() and jumped to that stale
  // entity instead of letting the form's own onSubmit run the new search
  // the user just typed -- contradicting this component's own doc comment
  // a few lines below ("Enter with nothing highlighted still submits the
  // form as a normal search"), whose premise (no highlight survives into
  // a new query) this didn't actually hold. Keyed on `query` alone (not a
  // handler-specific fix) so it covers every way the text can change --
  // typing, the Escape-to-clear branch below, and the separate "clear
  // query" button -- in one place rather than three scattered resets.
  useEffect(() => {
    setSelectedIndex(null);
  }, [query]);

  /**
   * Down/Up move a highlight across the result groups (not individual
   * records -- "jump" always lands on an entity tab, so the group is the
   * unit that matters), and Enter jumps to whichever group is highlighted.
   * Enter with nothing highlighted still submits the form as a normal
   * search, so this never changes behavior for someone who just types and
   * hits Enter once.
   */
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && query.length > 0) {
      e.preventDefault();
      setQuery("");
      return;
    }
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
          <div className="history-header-actions">
            {!loading && results.length > 0 && (
              <button type="button" className="secondary" onClick={handleCopy} aria-live="polite" aria-atomic="true">
                {copyStatus === "copied"
                  ? t("search.copy.copied")
                  : copyStatus === "failed"
                    ? t("search.copy.failed")
                    : t("search.copy")}
              </button>
            )}
            {!loading && results.length > 0 && (
              <button type="button" className="secondary" onClick={handleDownload}>
                {t("search.download")}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              {t("history.close")}
            </button>
          </div>
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
            data-escape-handled-locally={query.length > 0 ? "" : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          {query.length > 0 && (
            <button
              type="button"
              className="secondary small global-search-clear-query"
              aria-label={t("search.query.clear")}
              onClick={() => setQuery("")}
            >
              ✕
            </button>
          )}
          <button type="submit" disabled={!query.trim()}>
            {t("search.submit")}
          </button>
        </form>

        {error && (
          <div className="error-retry-row">
            <p className="error" role="status">
              {error}
            </p>
            <button
              type="button"
              className="secondary small"
              onClick={() => {
                setExpandedSamples({});
                runSearch(highlightQuery);
              }}
            >
              {t("search.retry")}
            </button>
          </div>
        )}
        {loading && (
          <p className="muted" role="status">
            {t("entity.loading")}
          </p>
        )}

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
                    <span className="chip chip-removable" key={q}>
                      <button type="button" className="chip-text" onClick={() => handleRecentSearchClick(q)}>
                        {q}
                      </button>
                      <button
                        type="button"
                        className="chip-remove"
                        title={t("search.recent.remove")}
                        aria-label={t("search.recent.remove", { query: q })}
                        onClick={() => handleRemoveRecentSearch(q)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {!loading && searched && results.length === 0 && !error && <p className="muted">{t("search.noResults")}</p>}

        {!loading && results.length > 0 && <p className="muted small">{t("search.keyboardHint")}</p>}

        {!loading && results.length > 0 && (
          <div className="global-search-results" ref={resultsContainerRef}>
            {results.map((result, i) => {
              const displayed = expandedSamples[result.entityName] ?? result.sample;
              const remaining = result.totalMatches - displayed.length;
              return (
                <div
                  key={result.entityName}
                  data-group-index={i}
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
                    {displayed.map((record) => (
                      <li key={String(record.id)}>
                        {/* Round 1050: a role="button" div, not a native <button> --
                            LinkifiedHighlighted below can render a real <a> for an
                            embedded URL/email, and nesting <a> inside <button> is
                            invalid HTML with broken click-target behavior. Mirrors
                            EntityPanel.tsx's own calendar day-cell pattern (a
                            clickable div containing its own nested interactive
                            controls, each stopping propagation on its own click). */}
                        <div
                          role="button"
                          tabIndex={0}
                          className="link-button global-search-hit-button"
                          onClick={() => onJumpToRecord(result.entityName, record.id as number)}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            onJumpToRecord(result.entityName, record.id as number);
                          }}
                        >
                          <LinkifiedHighlighted
                            text={recordPreview(entities.find((e) => e.name === result.entityName)!, record)}
                            query={highlightQuery}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  {remaining > 0 && (
                    <button
                      type="button"
                      className="link-button small global-search-show-all"
                      disabled={showAllLoading.has(result.entityName)}
                      onClick={() => handleShowAll(result.entityName)}
                    >
                      {showAllLoading.has(result.entityName)
                        ? t("search.showAll.busy")
                        : t("search.showAll", { count: remaining })}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
