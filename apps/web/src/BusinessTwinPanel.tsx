import { useEffect, useState } from "react";
import { getBusinessTwin, type BusinessTwin } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

export function BusinessTwinPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [twin, setTwin] = useState<BusinessTwin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  useEffect(() => {
    getBusinessTwin(projectId)
      .then(({ twin }) => setTwin(twin))
      .catch((err) => setError((err as Error).message));
  }, [projectId]);

  return (
    <div className="history-overlay">
      <div className="history-panel twin-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="twin-panel-title">
        <div className="history-header">
          <h2 id="twin-panel-title">{t("twin.title")}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("history.close")}
          </button>
        </div>
        <p className="muted small">{t("twin.description")}</p>

        {error && <p className="error">{error}</p>}
        {!twin && !error && <p className="muted">{t("twin.loading")}</p>}

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
                <span className="label">{t("twin.observations")}</span>
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
