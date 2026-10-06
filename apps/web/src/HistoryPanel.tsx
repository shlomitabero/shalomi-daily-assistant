import { Fragment, useEffect, useState } from "react";
import type { Checkpoint, Project, ProductSpec } from "@forge/shared";
import { deleteCheckpoint, listCheckpoints, restoreCheckpoint } from "./api.js";
import { CheckpointLabelEditor } from "./CheckpointLabelEditor.js";
import {
  addRecentHistorySearch,
  clearRecentHistorySearches,
  getRecentHistorySearches,
  removeRecentHistorySearch,
} from "./historyRecentSearches.js";
import {
  type CheckpointType,
  computeCheckpointDiff,
  downloadCheckpointHistory,
  filterCheckpoints,
  filterCheckpointsByType,
  formatCheckpointCount,
  formatCheckpointHistory,
  formatCompareTarget,
  isCheckpointCurrent,
  resolveCompareSpec,
} from "./checkpointDiff.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

export function HistoryPanel({
  projectId,
  projectName,
  currentSpec,
  onRestored,
  onClose,
}: {
  projectId: string;
  projectName: string;
  currentSpec: ProductSpec;
  onRestored: (project: Project) => void;
  onClose: () => void;
}) {
  const { t, lang } = useTranslation();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>(() => getRecentHistorySearches(projectId));
  const [typeFilter, setTypeFilter] = useState<"all" | CheckpointType>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);
  const visibleCheckpoints = filterCheckpointsByType(filterCheckpoints(checkpoints, search), typeFilter);

  function loadHistory() {
    setLoadError(null);
    listCheckpoints(projectId)
      .then(({ checkpoints }) => setCheckpoints(checkpoints))
      .catch((err) => setLoadError((err as Error).message));
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /** Splices the freshly-renamed checkpoint back into the loaded list, matching handleRestore's own "update from the real server response" shape rather than an optimistic local edit. */
  function handleCheckpointRenamed(renamed: Checkpoint) {
    setCheckpoints((prev) => prev.map((c) => (c.id === renamed.id ? renamed : c)));
  }

  function handleDownload() {
    downloadCheckpointHistory(formatCheckpointHistory(checkpoints, currentSpec, projectName, lang, t), projectName);
  }

  /**
   * Same "Copy report" companion action rounds 222/223 added to Business
   * Twin's and the WhatsApp log's own Download buttons, closing out the
   * pattern's third and final known candidate here -- Time Machine's own
   * timeline is already formatted as the same plain, shareable text
   * (formatCheckpointHistory), but the only way to get it anywhere was a
   * real file download.
   */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatCheckpointHistory(checkpoints, currentSpec, projectName, lang, t));
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

  async function handleRestore(checkpoint: Checkpoint) {
    if (!window.confirm(t("history.confirmRestore", { label: checkpoint.label }))) return;
    setBusyId(checkpoint.id);
    setError(null);
    try {
      const { project } = await restoreCheckpoint(projectId, checkpoint.id);
      onRestored(project);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Time Machine's history otherwise only ever grows -- every build and
   * every refine adds a checkpoint, with no way to prune a single unwanted
   * one (an experimental refine that went nowhere, say). Mirrors
   * WhatsAppPanel.tsx's own handleDeleteMessage: a real confirm, then a
   * real DELETE, then remove exactly that one from local state on success
   * -- never an optimistic remove that could drift from the server if the
   * request actually failed. Deleting a checkpoint never touches the
   * project's own current spec (that lives on the project row itself), so
   * this is safe regardless of whether the deleted checkpoint happens to
   * be the one currently shown with the "Current" chip.
   */
  async function handleDelete(checkpoint: Checkpoint) {
    if (!window.confirm(t("history.confirmDelete", { label: checkpoint.label }))) return;
    setDeletingId(checkpoint.id);
    setDeleteError(null);
    try {
      await deleteCheckpoint(projectId, checkpoint.id);
      setCheckpoints((prev) => prev.filter((c) => c.id !== checkpoint.id));
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  /**
   * Records a real committed search (blur or Enter, not every keystroke --
   * the search itself is already a live filter via `search` state) into
   * this project's own recent-history-searches list, same "commit on
   * leaving the field" convention as this app's other recentX lists.
   * The search box's own Escape-to-clear and ✕ button (below, mirroring
   * EntityPanel.tsx's identical search box from rounds 355/357) both call
   * setSearch("") directly -- a genuinely separate action from
   * handleClearRecentSearches, which only empties the *saved*
   * recent-searches list below, never the live search value itself.
   */
  function commitRecentSearch() {
    if (!search.trim()) return;
    setRecentSearches(addRecentHistorySearch(projectId, search));
  }

  function handleRecentSearchClick(q: string) {
    setSearch(q);
    setRecentSearches(addRecentHistorySearch(projectId, q));
  }

  function handleClearRecentSearches() {
    clearRecentHistorySearches(projectId);
    setRecentSearches([]);
  }

  function handleRemoveRecentSearch(q: string) {
    setRecentSearches(removeRecentHistorySearch(projectId, q));
  }

  return (
    <div className="history-overlay">
      <div className="history-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="history-panel-title">
        <div className="history-header">
          <h2 id="history-panel-title">
            {t("history.title")}
            {checkpoints.length > 0 && (
              <span className="muted small history-count">
                {" "}
                — {formatCheckpointCount(visibleCheckpoints.length, checkpoints.length, t)}
              </span>
            )}
          </h2>
          <div className="history-header-actions">
            {checkpoints.length > 0 && (
              <button type="button" className="secondary" onClick={handleCopy} aria-live="polite" aria-atomic="true">
                {copyStatus === "copied"
                  ? t("history.copy.copied")
                  : copyStatus === "failed"
                    ? t("history.copy.failed")
                    : t("history.copy")}
              </button>
            )}
            {checkpoints.length > 0 && (
              <button type="button" className="secondary" onClick={handleDownload}>
                {t("history.download")}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              {t("history.close")}
            </button>
          </div>
        </div>
        <p className="muted small">{t("history.description")}</p>
        {error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
        {deleteError && (
          <p className="error" role="status">
            {deleteError}
          </p>
        )}
        {loadError && (
          <div className="error-retry-row">
            <p className="error" role="status">
              {loadError}
            </p>
            <button type="button" className="secondary small" onClick={loadHistory}>
              {t("history.retry")}
            </button>
          </div>
        )}
        {checkpoints.length > 5 && (
          <div className="history-filters">
            <input
              type="text"
              className="history-search"
              placeholder={t("history.search.placeholder")}
              aria-label={t("history.search.placeholder")}
              value={search}
              data-escape-handled-locally={search.length > 0 ? "" : undefined}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={commitRecentSearch}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRecentSearch();
                else if (e.key === "Escape" && search.length > 0) {
                  e.preventDefault();
                  setSearch("");
                }
              }}
            />
            {search.length > 0 && (
              <button
                type="button"
                className="secondary small history-clear-search"
                aria-label={t("history.search.clear")}
                onClick={() => setSearch("")}
              >
                ✕
              </button>
            )}
            <select
              className="history-type-filter"
              aria-label={t("history.filter.label")}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as "all" | CheckpointType)}
            >
              <option value="all">{t("history.filter.all")}</option>
              <option value="build">{t("history.filter.build")}</option>
              <option value="refine">{t("history.filter.refine")}</option>
            </select>
          </div>
        )}
        {checkpoints.length > 5 && recentSearches.length > 0 && (
          <div className="global-search-recent history-recent-searches">
            <div className="global-search-recent-header">
              <span className="muted small">{t("history.recent.heading")}</span>
              <button type="button" className="link-button small" onClick={handleClearRecentSearches}>
                {t("history.recent.clear")}
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
                    title={t("history.recent.remove")}
                    aria-label={t("history.recent.remove", { query: q })}
                    onClick={() => handleRemoveRecentSearch(q)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {checkpoints.length === 0 ? (
          loadError ? null : <p className="muted">{t("history.empty")}</p>
        ) : visibleCheckpoints.length === 0 ? (
          <p className="muted">{t("history.search.noResults")}</p>
        ) : (
          <ul className="checkpoint-list">
            {visibleCheckpoints.map((checkpoint) => {
              const isOpen = expandedId === checkpoint.id;
              const compareSpec = isOpen ? resolveCompareSpec(checkpoints, compareTargetId, currentSpec) : currentSpec;
              const diff = computeCheckpointDiff(compareSpec, checkpoint.spec);
              const hasChanges = diff.removedEntities.length > 0 || diff.addedEntities.length > 0 || diff.changedEntities.length > 0;
              const isCurrent = isCheckpointCurrent(currentSpec, checkpoint.spec);
              return (
                <li key={checkpoint.id}>
                  <div>
                    <CheckpointLabelEditor checkpoint={checkpoint} projectId={projectId} onRenamed={handleCheckpointRenamed} />
                    {isCurrent && <span className="chip checkpoint-current-chip">{t("history.current")}</span>}
                    <div className="muted small">
                      {new Date(checkpoint.createdAt).toLocaleString(LOCALE[lang])}
                    </div>
                    <div className="muted small">
                      {t("history.screenCount", { count: checkpoint.spec.entities.length })}
                    </div>
                    <button
                      type="button"
                      className="link-button detail-toggle"
                      onClick={() => {
                        setExpandedId(isOpen ? null : checkpoint.id);
                        setCompareTargetId(null);
                      }}
                    >
                      {isOpen ? t("build.detail.hide") : t("history.diff.show")}
                    </button>
                    {isOpen && (
                      <div className="agent-detail">
                        {checkpoints.length > 1 && (
                          <label className="field-row checkpoint-compare-row">
                            <span>{t("history.diff.compareWith")}</span>
                            <select
                              value={compareTargetId ?? ""}
                              onChange={(e) => setCompareTargetId(e.target.value || null)}
                            >
                              <option value="">{t("history.diff.currentState")}</option>
                              {checkpoints
                                .filter((c) => c.id !== checkpoint.id)
                                .map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.label}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                        <p className="muted small">
                          {t("history.diff.comparingTo", { label: formatCompareTarget(checkpoints, compareTargetId, t) })}
                        </p>
                        {!hasChanges ? (
                          <p className="muted small">{t("history.diff.noChanges")}</p>
                        ) : (
                          <ul className="detail-list">
                            {diff.removedEntities.map((e) => (
                              <li key={`removed-${e.name}`}>{t("history.diff.entityRemoved", { entity: e.label })}</li>
                            ))}
                            {diff.addedEntities.map((e) => (
                              <li key={`added-${e.name}`}>{t("history.diff.entityAdded", { entity: e.label })}</li>
                            ))}
                            {diff.changedEntities.map((e) => (
                              <Fragment key={e.name}>
                                {e.removedFieldNames.length > 0 && (
                                  <li>
                                    {t("history.diff.entityLostFields", { entity: e.label, fields: e.removedFieldNames.join(", ") })}
                                  </li>
                                )}
                                {e.addedFieldNames.length > 0 && (
                                  <li>
                                    {t("history.diff.entityGainedFields", { entity: e.label, fields: e.addedFieldNames.join(", ") })}
                                  </li>
                                )}
                                {e.changedFieldNames.length > 0 && (
                                  <li>
                                    {t("history.diff.entityChangedFields", { entity: e.label, fields: e.changedFieldNames.join(", ") })}
                                  </li>
                                )}
                              </Fragment>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Disabled while ANY restore is in flight, not just this
                      row's own -- otherwise clicking a second checkpoint's
                      button while the first restore is still pending fires a
                      second concurrent restoreCheckpoint request, and
                      whichever response lands last silently overwrites the
                      other's result via onRestored. */}
                  <button
                    type="button"
                    className="checkpoint-restore-btn"
                    onClick={() => handleRestore(checkpoint)}
                    disabled={busyId !== null || deletingId !== null || isCurrent}
                  >
                    {busyId === checkpoint.id ? t("history.restore.busy") : t("history.restore")}
                  </button>
                  <button
                    type="button"
                    className="checkpoint-delete-btn"
                    aria-label={t("history.deleteOne")}
                    onClick={() => handleDelete(checkpoint)}
                    disabled={busyId !== null || deletingId !== null}
                  >
                    {deletingId === checkpoint.id ? "…" : "🗑️"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
