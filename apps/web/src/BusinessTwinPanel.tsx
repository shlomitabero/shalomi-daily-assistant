import { useEffect, useState } from "react";
import { getBusinessTwin, type BusinessTwin } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { downloadTwinReport, formatTwinReport } from "./twinReport.js";

export function BusinessTwinPanel({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t, lang } = useTranslation();
  const [twin, setTwin] = useState<BusinessTwin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  function handleDownload() {
    if (!twin) return;
    downloadTwinReport(formatTwinReport(twin, projectName, lang, t), projectName);
  }

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
          <div className="history-header-actions">
            {twin && (
              <button type="button" className="secondary" onClick={handleDownload}>
                {t("twin.downloadReport")}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              {t("history.close")}
            </button>
          </div>
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
