import { useEffect, useState } from "react";
import { getBusinessTwin, type BusinessTwin } from "./api.js";
import { formatNumberValue } from "./entityFormatting.js";
import { useTranslation } from "./i18n/LanguageContext.js";
import type { Lang } from "./i18n/language.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";
import { computeTwinStatPercent, downloadTwinReport, formatTwinReport, sortTwinStatsByCount } from "./twinReport.js";

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
 *
 * Round 1343: each row is now a real `<button>` wired to `onJumpToEntity`
 * with the field's exact raw breakdown value, so this chart follows the
 * same clickable convention every other dashboard tile already does
 * (round 1332's stat tiles, round 1337's overdue/dueSoon tiles) instead of
 * being the one dashboard element a person could only look at. `rawValue`
 * is carried separately from `count` (the bar's own magnitude) because
 * `computeEnumDistributionObservations` (twin.ts) already builds this
 * exact raw string for both enum fields (the stored `enumValue`) and
 * boolean fields (literally `"true"`/`"false"`) -- byte-for-byte what
 * EntityPanel.tsx's own generic field-filter fallback
 * (`String(r[fieldName] ?? "") === value`) and boolean branch
 * (`String(Boolean(r[fieldName])) === value`) already compare against, so
 * no new filter-matching logic is needed on the receiving end.
 */
function TwinBarChart({
  title,
  bars,
  lang,
  entityName,
  fieldName,
  onJumpToEntity,
}: {
  title: string;
  bars: { label: string; count: number; rawValue: string }[];
  lang: Lang;
  entityName: string;
  fieldName: string;
  onJumpToEntity: (entityName: string, dateFilter?: { fieldName: string; value: string }) => void;
}) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <div className="twin-chart">
      <h4 className="twin-chart-title">{title}</h4>
      <div className="twin-chart-bars">
        {bars.map((b, i) => (
          <button
            key={`${b.label}-${i}`}
            type="button"
            className="twin-chart-row"
            title={`${b.label}: ${formatNumberValue(b.count, lang)}`}
            onClick={() => onJumpToEntity(entityName, { fieldName, value: b.rawValue })}
          >
            <span className="twin-chart-row-label">{b.label}</span>
            <div className="twin-chart-track">
              <div className="twin-chart-bar" style={{ width: `${Math.max(2, (b.count / max) * 100)}%` }} />
            </div>
            <span className="twin-chart-row-value">{formatNumberValue(b.count, lang)}</span>
          </button>
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
  /**
   * Round 1337: the optional second argument lets the overdue/dueSoon
   * stat tiles below carry the exact field+state the tile is already
   * named for, so the caller (App.tsx) can pre-apply the matching
   * toolbar filter on landing -- without it, a user clicking "3 Invoices
   * overdue" lands on the entity's full, unfiltered table and has to
   * manually find and set the same filter themselves. Every other
   * onJumpToEntity call site (the per-entity tiles, mostActiveObservation,
   * jumpableObservations) has no single field to filter by, so they omit
   * this argument entirely.
   *
   * Round 1343: `value`'s type widened from the literal `"overdue" |
   * "dueSoon"` to a plain `string` so TwinBarChart's own distribution bars
   * (below) can reuse this exact mechanism with an enum/boolean field's raw
   * breakdown value -- EntityPanel.tsx's own `createDateFilter` effect was
   * already fully generic (`setFieldFilters(prev => ({...prev,
   * [field.name]: createDateFilter.value}))`, no logic specific to
   * "overdue"/"dueSoon"), so widening the type is the only change needed
   * to make it work for any field+value pair, not just deadline fields.
   */
  onJumpToEntity: (entityName: string, dateFilter?: { fieldName: string; value: string }) => void;
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

            {view === "dashboard" &&
              (twin.distributions.length > 0 || twin.numericStats.length > 0 || twin.overdueStats.length > 0 || twin.dueSoonStats.length > 0) && (
                <div className="twin-dashboard">
                  {twin.distributions.map((d, i) => (
                    <TwinBarChart
                      key={`dist-${i}`}
                      title={t("twin.dashboard.distributionTitle", { field: d.fieldLabel, entity: d.entityLabel })}
                      bars={d.breakdown.map((b) => ({ label: b.label, count: b.count, rawValue: b.value }))}
                      lang={lang}
                      entityName={d.entityName}
                      fieldName={d.fieldName}
                      onJumpToEntity={onJumpToEntity}
                    />
                  ))}
                  {(twin.numericStats.length > 0 || twin.overdueStats.length > 0 || twin.dueSoonStats.length > 0) && (
                    <div className="twin-dashboard-stats">
                      {twin.numericStats.map((s, i) => (
                        <button
                          key={`stat-${i}`}
                          type="button"
                          className="twin-stat-tile"
                          aria-label={t("twin.stat.jumpTo", { entity: s.entityLabel })}
                          onClick={() => onJumpToEntity(s.entityName)}
                        >
                          <div className="twin-stat-value">{formatNumberValue(s.sum, lang)}</div>
                          <div className="twin-stat-label">{t("twin.dashboard.totalOf", { field: s.fieldLabel, entity: s.entityLabel })}</div>
                          <div className="twin-stat-percent">
                            {t("twin.dashboard.averageOf", { average: formatNumberValue(s.average, lang, { maximumFractionDigits: 1 }) })}
                          </div>
                        </button>
                      ))}
                      {twin.overdueStats.map((s, i) => (
                        <button
                          key={`overdue-${i}`}
                          type="button"
                          className="twin-stat-tile"
                          aria-label={t("twin.stat.jumpTo", { entity: s.entityLabel })}
                          onClick={() => onJumpToEntity(s.entityName, { fieldName: s.fieldName, value: "overdue" })}
                        >
                          <div className="twin-stat-value">{formatNumberValue(s.overdueCount, lang)}</div>
                          <div className="twin-stat-label">{t("twin.dashboard.overdueOf", { field: s.fieldLabel, entity: s.entityLabel })}</div>
                          <div className="twin-stat-percent">{t("twin.dashboard.outOfRecords", { count: s.recordCount })}</div>
                        </button>
                      ))}
                      {twin.dueSoonStats.map((s, i) => (
                        <button
                          key={`duesoon-${i}`}
                          type="button"
                          className="twin-stat-tile"
                          aria-label={t("twin.stat.jumpTo", { entity: s.entityLabel })}
                          onClick={() => onJumpToEntity(s.entityName, { fieldName: s.fieldName, value: "dueSoon" })}
                        >
                          <div className="twin-stat-value">{formatNumberValue(s.dueSoonCount, lang)}</div>
                          <div className="twin-stat-label">{t("twin.dashboard.dueSoonOf", { field: s.fieldLabel, entity: s.entityLabel })}</div>
                          <div className="twin-stat-percent">{t("twin.dashboard.outOfRecords", { count: s.recordCount })}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            {view === "dashboard" &&
              twin.distributions.length === 0 &&
              twin.numericStats.length === 0 &&
              twin.overdueStats.length === 0 &&
              twin.dueSoonStats.length === 0 && <p className="muted small">{t("twin.dashboard.empty")}</p>}

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
