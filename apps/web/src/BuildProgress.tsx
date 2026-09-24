import { useEffect, useRef, useState } from "react";
import type { AgentStepEvent, Project } from "@forge/shared";
import { useTranslation } from "./i18n/LanguageContext.js";

const AGENT_ICONS: Record<AgentStepEvent["agent"], string> = {
  Architect: "🏗️",
  Database: "🗄️",
  Debug: "🔧",
  "Seed Data": "🌱",
  QA: "🔍",
  Security: "🛡️",
  Forge: "🔥",
};

/** Translation-key-safe identifier for an agent name that contains a space ("Seed Data"). */
const AGENT_KEY: Record<AgentStepEvent["agent"], string> = {
  Architect: "Architect",
  Database: "Database",
  Debug: "Debug",
  "Seed Data": "SeedData",
  QA: "QA",
  Security: "Security",
  Forge: "Forge",
};

const AGENT_ORDER: AgentStepEvent["agent"][] = ["Architect", "Database", "Debug", "Seed Data", "QA", "Security", "Forge"];

/** m:ss for anything under an hour (the realistic range for a build) -- a raw ms count is never what a person watching a build wants to read. */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function StatusIcon({ status }: { status: AgentStepEvent["status"] }) {
  if (status === "success") return <span className="step-icon step-success">✓</span>;
  if (status === "failed") return <span className="step-icon step-failed">✕</span>;
  return <span className="step-icon step-running">●</span>;
}

interface ImpactDetail {
  newEntities: { name: string; label: string }[];
  changedEntities: { name: string; label: string; newFieldNames: string[] }[];
}

interface MigrationChangeDetail {
  type: "new_table" | "new_column" | "type_changed";
  table: string;
  column?: string;
  fromType?: string;
  toType?: string;
}

interface QaResultDetail {
  entity: string;
  checks: string[];
}

/** Renders the real payload each agent reported — the same data used to build the summary message, not a re-statement of it. */
function AgentDetail({ agent, detail }: { agent: AgentStepEvent["agent"]; detail: unknown }) {
  const { t } = useTranslation();

  if (agent === "Architect" && detail) {
    const { newEntities, changedEntities } = detail as ImpactDetail;
    if (newEntities.length === 0 && changedEntities.length === 0) {
      return <p className="muted small">{t("build.detail.architect.noChange")}</p>;
    }
    return (
      <ul className="detail-list">
        {newEntities.map((e) => (
          <li key={e.name}>
            {t("build.detail.architect.newScreen")}
            <strong>{e.label}</strong>
          </li>
        ))}
        {changedEntities.map((e) => (
          <li key={e.name}>
            <strong>{e.label}</strong>
            {t("build.detail.architect.gainedFields")}
            {e.newFieldNames.join(", ")}
          </li>
        ))}
      </ul>
    );
  }

  if (agent === "Database" && Array.isArray(detail)) {
    const changes = detail as MigrationChangeDetail[];
    if (changes.length === 0) return <p className="muted small">{t("build.detail.database.noChange")}</p>;
    return (
      <ul className="detail-list">
        {changes.map((c, i) => (
          <li key={i}>
            {c.type === "new_table"
              ? `${t("build.detail.database.newTable")}${c.table}`
              : c.type === "new_column"
                ? `${t("build.detail.database.newColumn")}${c.table}.${c.column}`
                : `${t("build.detail.database.typeChanged")}${c.table}.${c.column} (${c.fromType} → ${c.toType})`}
          </li>
        ))}
      </ul>
    );
  }

  // A failed seed step (apps/api/src/pipeline.ts) sends `detail` as a
  // plain string[] of per-record errors, not the { seededCount, entities }
  // shape a successful one sends -- this must be checked first, or the
  // object-shape branch below destructures `entities` off an array and
  // crashes on `entities.length` with no ErrorBoundary to catch it.
  if (agent === "Seed Data" && Array.isArray(detail)) {
    const errors = detail as string[];
    return (
      <ul className="detail-list">
        {errors.map((e, i) => (
          <li key={i} className="detail-fail">
            {e}
          </li>
        ))}
      </ul>
    );
  }

  if (agent === "Seed Data" && detail) {
    const { seededCount, entities } = detail as { seededCount: number; entities: string[] };
    if (entities.length === 0) return <p className="muted small">{t("build.detail.seed.none")}</p>;
    return (
      <p className="muted small">
        {t("build.detail.seed.summary", { count: seededCount, entities: entities.join(", ") })}
      </p>
    );
  }

  if (agent === "QA" && Array.isArray(detail)) {
    const results = detail as QaResultDetail[];
    return (
      <ul className="detail-list">
        {results.map((r) => (
          <li key={r.entity}>
            <strong>{r.entity}</strong>
            <ul className="detail-sublist">
              {r.checks.map((c, i) => (
                <li key={i} className={c.startsWith("FAILED") ? "detail-fail" : undefined}>
                  {c}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    );
  }

  if (agent === "Security" && Array.isArray(detail)) {
    const warnings = detail as string[];
    if (warnings.length === 0) return <p className="muted small">{t("build.detail.security.none")}</p>;
    return (
      <ul className="detail-list">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    );
  }

  return null;
}

export function BuildProgress({
  title,
  run,
  onComplete,
  onBack,
  compact = false,
}: {
  title?: string;
  run: (onEvent: (event: AgentStepEvent) => void) => Promise<void>;
  onComplete: (project: Project) => void;
  onBack: () => void;
  /** Renders without the full-page <main>/<h1> chrome, for embedding inline
   * (e.g. in the preview screen's chat pane during a refine) instead of
   * taking over the whole screen. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AgentStepEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const started = useRef(false);
  const [startedAt] = useState(() => Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run((event) => setEvents((prev) => [...prev, event]))
      .then(() => setFinished(true))
      .catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticks once a second while the build is still running, so a person
  // watching a multi-step build knows it's actually progressing rather
  // than silently stuck -- and stops (leaving the final, exact duration
  // frozen on screen) the instant `finished` flips, rather than drifting
  // up to a second past the real finish time waiting for the next tick.
  useEffect(() => {
    if (finished) {
      setElapsedMs(Date.now() - startedAt);
      return;
    }
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(interval);
  }, [finished, startedAt]);

  useEffect(() => {
    if (!finished) return;
    const last = events[events.length - 1];
    if (last?.agent === "Forge" && last.status === "success") {
      onComplete((last.detail as { project: Project }).project);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  function toggleExpanded(agent: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  // One row per agent, showing its latest status (the "running" placeholder
  // is replaced in place once that agent's success/failed event arrives).
  const latestByAgent = new Map<string, AgentStepEvent>();
  for (const event of events) {
    latestByAgent.set(event.agent, event);
  }

  // Must reflect each agent's CURRENT (latest) status, not "any failure
  // ever seen in this build's history" -- a Database failure the Debug
  // Agent successfully recovers from (see pipeline.ts) is always followed
  // by a fresh Database success event, but the earlier failed one stays in
  // `events` forever. Scanning raw `events` for the first failed status
  // would keep the "Build failed" banner (and its Back button, in place of
  // the rest of the step list) showing for the whole remainder of a build
  // that's actually recovering and about to complete successfully.
  const failedStep = [...latestByAgent.values()].find((e) => e.status === "failed");
  // Debug only ever shows up if it actually ran (a real migration failure)
  // — most builds never trigger it, so it shouldn't sit there as a
  // permanent "pending" placeholder on every successful build.
  const visibleAgents = AGENT_ORDER.filter((a) => a !== "Debug" || latestByAgent.has("Debug"));
  const doneCount = visibleAgents.filter((a) => latestByAgent.get(a)?.status === "success").length;

  const Wrapper = compact ? "div" : "main";

  return (
    <Wrapper className={compact ? "ai-team ai-team-compact" : "ai-team"}>
      {!compact && <h1>{title}</h1>}
      <p className={compact ? "muted small" : "muted"}>
        {t("build.subtitle", { current: Math.min(doneCount + 1, visibleAgents.length), total: visibleAgents.length })}
        {" · "}
        <span className="build-elapsed" aria-label={t("build.elapsed.label")}>
          ⏱️ {formatElapsedTime(elapsedMs)}
        </span>
      </p>
      <ol className="agent-steps">
        {visibleAgents.map((agent) => {
          const event = latestByAgent.get(agent);
          const key = AGENT_KEY[agent];
          const icon = AGENT_ICONS[agent];
          const status = event?.status ?? "pending";
          const caption =
            status === "failed"
              ? `${t("build.status.failedPrefix")}${event!.message}`
              : status === "success"
                ? t(`build.agent.${key}.success`)
                : status === "running"
                  ? t(`build.agent.${key}.running`)
                  : t("build.status.pending");
          const hasDetail =
            agent !== "Forge" &&
            agent !== "Debug" &&
            event?.detail !== undefined &&
            (status === "success" || status === "failed");
          const isOpen = expanded.has(agent);
          return (
            <li key={agent} className={`agent-step agent-step-${status}`}>
              {status === "pending" ? (
                <span className="step-icon step-pending">{icon}</span>
              ) : (
                <StatusIcon status={status as AgentStepEvent["status"]} />
              )}
              <div className="agent-step-body">
                <div className="agent-step-header">
                  <strong>
                    {icon} {t(`build.agent.${key}.title`)}
                  </strong>
                  {hasDetail && (
                    <button type="button" className="link-button detail-toggle" onClick={() => toggleExpanded(agent)}>
                      {isOpen ? t("build.detail.hide") : t("build.detail.show")}
                    </button>
                  )}
                </div>
                <p>{caption}</p>
                {hasDetail && isOpen && (
                  <div className="agent-detail">
                    <AgentDetail agent={agent} detail={event!.detail} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!compact && <p className="muted small">{t("build.footer")}</p>}
      {error && <p className="error banner">{error}</p>}
      {failedStep && (
        <div>
          <p className="error">{t("build.failed.banner")}</p>
          <button type="button" onClick={onBack}>
            {t("build.back")}
          </button>
        </div>
      )}
    </Wrapper>
  );
}
