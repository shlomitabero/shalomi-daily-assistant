import { useEffect, useState } from "react";
import { getBusinessTwin, type BusinessTwin } from "./api.js";

export function BusinessTwinPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [twin, setTwin] = useState<BusinessTwin | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBusinessTwin(projectId)
      .then(({ twin }) => setTwin(twin))
      .catch((err) => setError((err as Error).message));
  }, [projectId]);

  return (
    <div className="history-overlay">
      <div className="history-panel twin-panel">
        <div className="history-header">
          <h2>🧠 תמונת העסק</h2>
          <button type="button" className="secondary" onClick={onClose}>
            סגירה
          </button>
        </div>
        <p className="muted small">
          זו תמונת מצב אמיתית, מבוססת על הנתונים שבפועל נמצאים באפליקציה שלך — לא ניתוח עסקי מלא.
        </p>

        {error && <p className="error">{error}</p>}
        {!twin && !error && <p className="muted">טוען…</p>}

        {twin && (
          <>
            <div className="chips">
              {twin.roles.map((r) => (
                <span className="chip" key={r}>
                  {r}
                </span>
              ))}
            </div>

            <div className="twin-stats">
              {twin.entities.map((e) => (
                <div key={e.name} className="twin-stat-tile">
                  <div className="twin-stat-value">{e.count}</div>
                  <div className="twin-stat-label">{e.label}</div>
                </div>
              ))}
            </div>

            {twin.observations.length > 0 && (
              <div className="twin-observations">
                <span className="label">מה שמתי לב אליו</span>
                <ul>
                  {twin.observations.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
