import { useEffect, useState } from "react";
import type { Checkpoint, Project, ProductSpec } from "@forge/shared";
import { listCheckpoints, restoreCheckpoint } from "./api.js";
import { computeCheckpointDiff, downloadCheckpointHistory, filterCheckpoints, formatCheckpointHistory, isCheckpointCurrent } from "./checkpointDiff.js";
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
  const [search, setSearch] = useState("");
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();
  const visibleCheckpoints = filterCheckpoints(checkpoints, search);

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
          <h2 id="history-panel-title">{t("history.title")}</h2>
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
          <input
            type="text"
            className="history-search"
            placeholder={t("history.search.placeholder")}
            aria-label={t("history.search.placeholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {checkpoints.length === 0 ? (
          <p className="muted">{t("history.empty")}</p>
        ) : visibleCheckpoints.length === 0 ? (
          <p className="muted">{t("history.search.noResults")}</p>
        ) : (
          <ul className="checkpoint-list">
            {visibleCheckpoints.map((checkpoint) => {
              const diff = computeCheckpointDiff(currentSpec, checkpoint.spec);
              const hasChanges = diff.removedEntities.length > 0 || diff.changedEntities.length > 0;
              const isOpen = expandedId === checkpoint.id;
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
                      onClick={() => setExpandedId(isOpen ? null : checkpoint.id)}
                    >
                      {isOpen ? t("build.detail.hide") : t("history.diff.show")}
                    </button>
                    {isOpen && (
                      <div className="agent-detail">
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
