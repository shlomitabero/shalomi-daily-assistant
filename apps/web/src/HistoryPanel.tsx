import { useEffect, useState } from "react";
import type { Checkpoint, Project, ProductSpec } from "@forge/shared";
import { listCheckpoints, restoreCheckpoint } from "./api.js";
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | CheckpointType>("all");
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();
  const visibleCheckpoints = filterCheckpointsByType(filterCheckpoints(checkpoints, search), typeFilter);

  useEffect(() => {
    listCheckpoints(projectId)
      .then(({ checkpoints }) => setCheckpoints(checkpoints))
      .catch((err) => setError((err as Error).message));
  }, [projectId]);

  function handleDownload() {
    downloadCheckpointHistory(formatCheckpointHistory(checkpoints, currentSpec, projectName, lang, t), projectName);
  }

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
        {error && <p className="error">{error}</p>}
        {checkpoints.length > 5 && (
          <div className="history-filters">
            <input
              type="text"
              className="history-search"
              placeholder={t("history.search.placeholder")}
              aria-label={t("history.search.placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
        {checkpoints.length === 0 ? (
          <p className="muted">{t("history.empty")}</p>
        ) : visibleCheckpoints.length === 0 ? (
          <p className="muted">{t("history.search.noResults")}</p>
        ) : (
          <ul className="checkpoint-list">
            {visibleCheckpoints.map((checkpoint) => {
              const isOpen = expandedId === checkpoint.id;
              const compareSpec = isOpen ? resolveCompareSpec(checkpoints, compareTargetId, currentSpec) : currentSpec;
              const diff = computeCheckpointDiff(compareSpec, checkpoint.spec);
              const hasChanges = diff.removedEntities.length > 0 || diff.changedEntities.length > 0;
              const isCurrent = isCheckpointCurrent(currentSpec, checkpoint.spec);
              return (
                <li key={checkpoint.id}>
                  <div>
                    <strong>{checkpoint.label}</strong>
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
                              <li key={e.name}>{t("history.diff.entityRemoved", { entity: e.label })}</li>
                            ))}
                            {diff.changedEntities.map((e) => (
                              <li key={e.name}>
                                {t("history.diff.entityLostFields", { entity: e.label, fields: e.removedFieldNames.join(", ") })}
                              </li>
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
                    disabled={busyId !== null || isCurrent}
                  >
                    {busyId === checkpoint.id ? t("history.restore.busy") : t("history.restore")}
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
