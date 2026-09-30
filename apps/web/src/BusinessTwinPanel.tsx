import { useEffect, useState } from "react";
import { getBusinessTwin, type BusinessTwin, type BusinessTwinEntityStat } from "./api.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { downloadTwinReport, formatTwinReport } from "./twinReport.js";

/**
 * The server (apps/api/src/twin.ts) returns entities in the spec's own
 * declaration order, not by activity -- so a project whose busiest entity
 * happened to be declared last showed its biggest number at the bottom of
 * the grid, behind several all-zero tiles, exactly backwards from how a
 * stats dashboard is meant to read (biggest numbers first). A plain
 * `.sort()` on `count` alone isn't enough: Array.prototype.sort is only
 * guaranteed stable as of ES2019, and even then, sorting descending by a
 * key that has ties (multiple entities on 0 records, or on the same count)
 * needs an explicit tie-break to keep those tied entities in their
 * original, predictable order rather than depending on engine-specific
 * behavior for the tie itself.
 */
export function sortTwinStatsByCount(entities: BusinessTwinEntityStat[]): BusinessTwinEntityStat[] {
  return entities
    .map((entity, index) => ({ entity, index }))
    .sort((a, b) => b.entity.count - a.entity.count || a.index - b.index)
    .map(({ entity }) => entity);
}

/**
 * What share of the project's total records a single entity's own count
 * represents, as a whole-number percentage -- the grid already shows each
 * tile's raw count and the panel's own total separately (`twin.totalRecords`
 * above the grid), but never how the two relate. Guards against a
 * zero/negative total (an otherwise-real state for a freshly built project
 * with no data seeded yet) the same defensive way
 * BuildProgress.tsx's own computeBuildProgressPercent does for its own
 * div-by-zero case.
 */
export function computeTwinStatPercent(count: number, totalRecords: number): number {
  if (totalRecords <= 0) return 0;
  return Math.round((count / totalRecords) * 100);
}

export function BusinessTwinPanel({
  projectId,
  projectName,
  onClose,
  onJumpToEntity,
  onJumpToRecord,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onJumpToEntity: (entityName: string) => void;
  /**
   * computeRelationHubObservation (twin.ts) already resolves the
   * "most-linked record" insight down to a specific real entityName+id --
   * the same "jump to entity, not the record" gap round 174/175 already
   * closed for Global Search and WhatsApp, now closed here too instead of
   * just stating the fact as inert text.
   */
  onJumpToRecord: (entityName: string, recordId: number) => void;
}) {
  const { t, lang } = useTranslation();
  const [twin, setTwin] = useState<BusinessTwin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(onClose);

  function handleDownload() {
    if (!twin) return;
    downloadTwinReport(formatTwinReport(twin, projectName, lang, t), projectName);
  }

  /**
   * A "copy to clipboard" companion to the existing download button --
   * the report is plain text specifically so it's trivially shareable
   * (WhatsApp, email, paste anywhere, per formatTwinReport's own comment),
   * but until now the only way to actually get it anywhere was a real file
   * download + manually opening it. navigator.clipboard.writeText can
   * genuinely reject (denied permission, insecure context), so a real
   * failure gets its own transient label rather than silently doing
   * nothing.
   */
  async function handleCopy() {
    if (!twin) return;
    try {
      await navigator.clipboard.writeText(formatTwinReport(twin, projectName, lang, t));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  // Fades the transient "Copied!"/"Couldn't copy" label back to the
  // normal button text a couple seconds later, mirroring EntityPanel's
  // own auto-fading highlight (round 174) -- same cleanup-on-unmount
  // discipline via clearTimeout.
  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  function loadTwin() {
    setError(null);
    getBusinessTwin(projectId)
      .then(({ twin }) => setTwin(twin))
      .catch((err) => setError((err as Error).message));
  }

  useEffect(() => {
    loadTwin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <div className="history-overlay">
      <div className="history-panel twin-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="twin-panel-title">
        <div className="history-header">
          <h2 id="twin-panel-title">{t("twin.title")}</h2>
          <div className="history-header-actions">
            {twin && (
              <button type="button" className="secondary" onClick={handleCopy}>
                {copyStatus === "copied"
                  ? t("twin.copyReport.copied")
                  : copyStatus === "failed"
                    ? t("twin.copyReport.failed")
                    : t("twin.copyReport")}
              </button>
            )}
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

        {error && (
          <div className="twin-error-row">
            <p className="error">{error}</p>
            <button type="button" className="secondary small" onClick={loadTwin}>
              {t("twin.retry")}
            </button>
          </div>
        )}
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

            <p className="muted small twin-total">{t("twin.totalRecords", { count: twin.totalRecords })}</p>

            <div className="twin-stats">
              {sortTwinStatsByCount(twin.entities).map((e) => (
                <button
                  key={e.name}
                  type="button"
                  className={e.count === 0 ? "twin-stat-tile twin-stat-tile-empty" : "twin-stat-tile"}
                  aria-label={t("twin.stat.jumpTo", { entity: e.label })}
                  onClick={() => onJumpToEntity(e.name)}
                >
                  <div className="twin-stat-value">{e.count}</div>
                  <div className="twin-stat-label">{e.label}</div>
                  {e.count > 0 && twin.totalRecords > 0 && (
                    <div className="twin-stat-percent">
                      {t("twin.stat.percentOfTotal", { percent: computeTwinStatPercent(e.count, twin.totalRecords) })}
                    </div>
                  )}
                </button>
              ))}
            </div>

            {(twin.observations.length > 0 ||
              twin.jumpableObservations.length > 0 ||
              twin.mostLinkedRecord ||
              twin.mostActiveObservation) && (
              <div className="twin-observations">
                <span className="label">{t("twin.observations")}</span>
                <ul>
                  {twin.mostActiveObservation && (
                    <li>
                      <button
                        type="button"
                        className="link-button twin-observation-link"
                        onClick={() => onJumpToEntity(twin.mostActiveObservation!.entityName)}
                      >
                        {twin.mostActiveObservation.text}
                      </button>
                    </li>
                  )}
                  {twin.mostLinkedRecord && (
                    <li>
                      <button
                        type="button"
                        className="link-button twin-observation-link"
                        onClick={() => onJumpToRecord(twin.mostLinkedRecord!.entityName, twin.mostLinkedRecord!.recordId)}
                      >
                        {twin.mostLinkedRecord.text}
                      </button>
                    </li>
                  )}
                  {twin.jumpableObservations.map((o, i) => (
                    <li key={`jumpable-${i}`}>
                      <button
                        type="button"
                        className="link-button twin-observation-link"
                        onClick={() => onJumpToEntity(o.entityName)}
                      >
                        {o.text}
                      </button>
                    </li>
                  ))}
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
