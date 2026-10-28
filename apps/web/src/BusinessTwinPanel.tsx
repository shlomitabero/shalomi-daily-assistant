import { useEffect, useState } from "react";
import { getBusinessTwin, type BusinessTwin } from "./api.js";
import { formatNumberValue } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import type { Lang } from "./i18n/language.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { downloadTwinReport, formatTwinReport, sortTwinStatsByCount } from "./twinReport.js";

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

/**
 * A single horizontal bar chart -- the dashboard's one reusable chart
 * primitive, used for both the per-entity record-count comparison and
 * every enum/boolean field's value breakdown. Deliberately a single,
 * flat accent color (var(--accent), the same brand color the rest of this
 * app already uses) rather than a different hue per bar: each row's own
 * text label is what carries identity here, not color -- an unbounded,
 * business-defined set of entity names or enum values has no fixed
 * categorical order to assign fixed hues to, and a "9th bar" would
 * otherwise need an invented color with no meaning. Magnitude is carried
 * by bar length alone, which reads correctly regardless of color vision.
 * A native `title` attribute on each row doubles as the hover tooltip,
 * the same lightweight convention EntityPanel.tsx's own longtext table
 * cells already use.
 */
function TwinBarChart({ title, bars, lang }: { title: string; bars: { label: string; value: number }[]; lang: Lang }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="twin-chart">
      <h4 className="twin-chart-title">{title}</h4>
      <div className="twin-chart-bars">
        {bars.map((b, i) => (
          <div key={`${b.label}-${i}`} className="twin-chart-row" title={`${b.label}: ${formatNumberValue(b.value, lang)}`}>
            <span className="twin-chart-row-label">{b.label}</span>
            <div className="twin-chart-track">
              <div className="twin-chart-bar" style={{ width: `${Math.max(2, (b.value / max) * 100)}%` }} />
            </div>
            <span className="twin-chart-row-value">{formatNumberValue(b.value, lang)}</span>
          </div>
        ))}
      </div>
    </div>
  );
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
  // Defaults to "report" (not "dashboard") specifically so every existing
  // insight -- the jumpable mostLinkedRecord/mostActiveObservation/
  // jumpableObservations buttons -- keeps rendering immediately exactly as
  // it always has, with no extra click required; the dashboard is an
  // additional view a person opts into, not a replacement for what was
  // already there.
  const [view, setView] = useState<"dashboard" | "report">("report");
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
              <button type="button" className="secondary" onClick={handleCopy} aria-live="polite" aria-atomic="true">
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
            <p className="error" role="status">
              {error}
            </p>
            <button type="button" className="secondary small" onClick={loadTwin}>
              {t("twin.retry")}
            </button>
          </div>
        )}
        {!twin && !error && (
          <p className="muted" role="status">
            {t("twin.loading")}
          </p>
        )}

        {twin && (
          <>
            {twin.summary.trim().length > 0 && <p className="twin-summary">{twin.summary}</p>}

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

            {(twin.distributions.length > 0 ||
              twin.numericStats.length > 0 ||
              twin.observations.length > 0 ||
              twin.jumpableObservations.length > 0 ||
              twin.mostLinkedRecord ||
              twin.mostActiveObservation) && (
              <div className="view-toggle twin-view-toggle" role="group">
                <button
                  type="button"
                  className={view === "dashboard" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  aria-pressed={view === "dashboard"}
                  onClick={() => setView("dashboard")}
                >
                  {t("twin.view.dashboard")}
                </button>
                <button
                  type="button"
                  className={view === "report" ? "view-toggle-btn view-toggle-btn-active" : "view-toggle-btn"}
                  aria-pressed={view === "report"}
                  onClick={() => setView("report")}
                >
                  {t("twin.view.report")}
                </button>
              </div>
            )}

            {view === "dashboard" && (twin.distributions.length > 0 || twin.numericStats.length > 0) && (
              <div className="twin-dashboard">
                {twin.distributions.map((d, i) => (
                  <TwinBarChart
                    key={`dist-${i}`}
                    title={t("twin.dashboard.distributionTitle", { field: d.fieldLabel, entity: d.entityLabel })}
                    bars={d.breakdown.map((b) => ({ label: b.label, value: b.count }))}
                    lang={lang}
                  />
                ))}
                {twin.numericStats.length > 0 && (
                  <div className="twin-dashboard-stats">
                    {twin.numericStats.map((s, i) => (
                      <div key={`stat-${i}`} className="twin-stat-tile twin-stat-tile-static">
                        <div className="twin-stat-value">{formatNumberValue(s.sum, lang)}</div>
                        <div className="twin-stat-label">{t("twin.dashboard.totalOf", { field: s.fieldLabel, entity: s.entityLabel })}</div>
                        <div className="twin-stat-percent">
                          {t("twin.dashboard.averageOf", { average: formatNumberValue(s.average, lang, { maximumFractionDigits: 1 }) })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {view === "dashboard" && twin.distributions.length === 0 && twin.numericStats.length === 0 && (
              <p className="muted small">{t("twin.dashboard.empty")}</p>
            )}

            {view === "report" && (twin.observations.length > 0 ||
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
