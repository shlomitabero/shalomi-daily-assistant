import { useEffect, useState } from "react";
import type { Checkpoint, Project } from "@forge/shared";
import { listCheckpoints, restoreCheckpoint } from "./api.js";

export function HistoryPanel({
  projectId,
  onRestored,
  onClose,
}: {
  projectId: string;
  onRestored: (project: Project) => void;
  onClose: () => void;
}) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      <div className="history-panel">
        <div className="history-header">
          <h2>ציר זמן</h2>
          <button type="button" className="secondary" onClick={onClose}>
            סגירה
          </button>
        </div>
        <p className="muted small">
          כל בנייה או שיפור נשמר כאן כנקודת שחזור. חוזרים אחורה בלי לאבד מידע — אף פעולה כאן לא
          מוחקת נתונים קיימים.
        </p>
        {error && <p className="error">{error}</p>}
        {checkpoints.length === 0 ? (
          <p className="muted">אין עדיין נקודות שמורות.</p>
        ) : (
          <ul className="checkpoint-list">
            {checkpoints.map((checkpoint) => (
              <li key={checkpoint.id}>
                <div>
                  <strong>{checkpoint.label}</strong>
                  <div className="muted small">{new Date(checkpoint.createdAt).toLocaleString("he-IL")}</div>
                  <div className="muted small">{checkpoint.spec.entities.length} מסכים</div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRestore(checkpoint.id)}
                  disabled={busyId === checkpoint.id}
                >
                  {busyId === checkpoint.id ? "משחזר…" : "שחזור"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
