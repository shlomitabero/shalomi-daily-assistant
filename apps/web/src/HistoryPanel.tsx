import { useEffect, useState } from "react";
import type { Checkpoint, Project } from "@forge/shared";
import { listCheckpoints, restoreCheckpoint } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

const LOCALE: Record<string, string> = { he: "he-IL", en: "en-US" };

export function HistoryPanel({
  projectId,
  onRestored,
  onClose,
}: {
  projectId: string;
  onRestored: (project: Project) => void;
  onClose: () => void;
}) {
  const { t, lang } = useTranslation();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  useEffect(() => {
    listCheckpoints(projectId)
      .then(({ checkpoints }) => setCheckpoints(checkpoints))
      .catch((err) => setError((err as Error).message));
  }, [projectId]);

  async function handleRestore(checkpointId: string) {
    setBusyId(checkpointId);
    setError(null);
    try {
      const { project } = await restoreCheckpoint(projectId, checkpointId);
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
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <p className="muted small">{t("history.description")}</p>
        {error && <p className="error">{error}</p>}
        {checkpoints.length === 0 ? (
          <p className="muted">{t("history.empty")}</p>
        ) : (
          <ul className="checkpoint-list">
            {checkpoints.map((checkpoint) => (
              <li key={checkpoint.id}>
                <div>
                  <strong>{checkpoint.label}</strong>
                  <div className="muted small">
                    {new Date(checkpoint.createdAt).toLocaleString(LOCALE[lang])}
                  </div>
                  <div className="muted small">
                    {t("history.screenCount", { count: checkpoint.spec.entities.length })}
                  </div>
                </div>
                {/* Disabled while ANY restore is in flight, not just this
                    row's own -- otherwise clicking a second checkpoint's
                    button while the first restore is still pending fires a
                    second concurrent restoreCheckpoint request, and
                    whichever response lands last silently overwrites the
                    other's result via onRestored. */}
                <button
                  type="button"
                  onClick={() => handleRestore(checkpoint.id)}
                  disabled={busyId !== null}
                >
                  {busyId === checkpoint.id ? t("history.restore.busy") : t("history.restore")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
