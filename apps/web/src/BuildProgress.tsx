import { useEffect, useRef, useState } from "react";
import type { AgentStepEvent, Project } from "@forge/shared";

const AGENT_INFO: Record<
  AgentStepEvent["agent"],
  { icon: string; title: string; running: string; success: string }
> = {
  Architect: {
    icon: "🏗️",
    title: "מתכנן/ת המוצר",
    running: "מתכנן/ת איך המסכים והנתונים מתחברים…",
    success: "התכנון מוכן.",
  },
  Database: {
    icon: "🗄️",
    title: "מהנדס/ת בסיס הנתונים",
    running: "בונה את מקום האחסון של המידע שלכם…",
    success: "בסיס הנתונים מוכן ועובד.",
  },
  "Seed Data": {
    icon: "🌱",
    title: "ממלא/ת דוגמאות",
    running: "מוסיף/ה כמה רשומות לדוגמה, כדי שלא תתחילו מדף ריק…",
    success: "נתוני דוגמה נוספו.",
  },
  QA: {
    icon: "🔍",
    title: "בודק/ת האיכות",
    running: "בודק/ת שהכל באמת עובד כמו שצריך…",
    success: "כל הבדיקות עברו בהצלחה.",
  },
  Security: {
    icon: "🛡️",
    title: "מומחה/ית האבטחה",
    running: "סורק/ת אחר בעיות אבטחה נפוצות…",
    success: "נסרק ואושר.",
  },
  Forge: {
    icon: "🔥",
    title: "סגירת הבנייה",
    running: "שומר/ת הכל ומכין/ה נקודת שחזור…",
    success: "הכל מוכן!",
  },
};

const AGENT_ORDER: AgentStepEvent["agent"][] = ["Architect", "Database", "Seed Data", "QA", "Security", "Forge"];

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
  type: "new_table" | "new_column";
  table: string;
  column?: string;
}

interface QaResultDetail {
  entity: string;
  checks: string[];
}

/** Renders the real payload each agent reported — the same data used to build the summary message, not a re-statement of it. */
function AgentDetail({ agent, detail }: { agent: AgentStepEvent["agent"]; detail: unknown }) {
  if (agent === "Architect" && detail) {
    const { newEntities, changedEntities } = detail as ImpactDetail;
    if (newEntities.length === 0 && changedEntities.length === 0) {
      return <p className="muted small">אין שינוי במבנה — הכל כבר קיים.</p>;
    }
    return (
      <ul className="detail-list">
        {newEntities.map((e) => (
          <li key={e.name}>מסך חדש: <strong>{e.label}</strong></li>
        ))}
        {changedEntities.map((e) => (
          <li key={e.name}>
            <strong>{e.label}</strong> קיבל שדות חדשים: {e.newFieldNames.join(", ")}
          </li>
        ))}
      </ul>
    );
  }

  if (agent === "Database" && Array.isArray(detail)) {
    const changes = detail as MigrationChangeDetail[];
    if (changes.length === 0) return <p className="muted small">לא היה צורך בשינוי בבסיס הנתונים.</p>;
    return (
      <ul className="detail-list">
        {changes.map((c, i) => (
          <li key={i}>{c.type === "new_table" ? `טבלה חדשה נוצרה: ${c.table}` : `עמודה חדשה נוספה: ${c.table}.${c.column}`}</li>
        ))}
      </ul>
    );
  }

  if (agent === "Seed Data" && detail) {
    const { seededCount, entities } = detail as { seededCount: number; entities: string[] };
    if (entities.length === 0) return <p className="muted small">לא נוספו נתוני דוגמה (אין מסכים חדשים).</p>;
    return <p className="muted small">{seededCount} רשומות דוגמה נוספו ב: {entities.join(", ")}.</p>;
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
    if (warnings.length === 0) return <p className="muted small">לא נמצאו אזהרות.</p>;
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
}: {
  title: string;
  run: (onEvent: (event: AgentStepEvent) => void) => Promise<void>;
  onComplete: (project: Project) => void;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<AgentStepEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run((event) => setEvents((prev) => [...prev, event]))
      .then(() => setFinished(true))
      .catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const failedStep = events.find((e) => e.status === "failed");

  // One row per agent, showing its latest status (the "running" placeholder
  // is replaced in place once that agent's success/failed event arrives).
  const latestByAgent = new Map<string, AgentStepEvent>();
  for (const event of events) {
    latestByAgent.set(event.agent, event);
  }
  const doneCount = AGENT_ORDER.filter((a) => latestByAgent.get(a)?.status === "success").length;

  return (
    <main className="ai-team">
      <h1>{title}</h1>
      <p className="muted">צוות ה-AI עובד עכשיו, בזמן אמת. שלב {Math.min(doneCount + 1, 6)} מתוך 6.</p>
      <ol className="agent-steps">
        {AGENT_ORDER.map((agent) => {
          const event = latestByAgent.get(agent);
          const info = AGENT_INFO[agent];
          const status = event?.status ?? "pending";
          const caption =
            status === "failed"
              ? `נתקלנו בבעיה: ${event!.message}`
              : status === "success"
                ? info.success
                : status === "running"
                  ? info.running
                  : "ממתין/ה בתור…";
          const hasDetail = agent !== "Forge" && event?.detail !== undefined && (status === "success" || status === "failed");
          const isOpen = expanded.has(agent);
          return (
            <li key={agent} className={`agent-step agent-step-${status}`}>
              {status === "pending" ? (
                <span className="step-icon step-pending">{info.icon}</span>
              ) : (
                <StatusIcon status={status as AgentStepEvent["status"]} />
              )}
              <div className="agent-step-body">
                <div className="agent-step-header">
                  <strong>
                    {info.icon} {info.title}
                  </strong>
                  {hasDetail && (
                    <button type="button" className="link-button detail-toggle" onClick={() => toggleExpanded(agent)}>
                      {isOpen ? "הסתרת פרטים" : "מה בדיוק נעשה?"}
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
      <p className="muted small">כל שלב פה קורה באמת עכשיו על הנתונים שלכם — לא רק אנימציה.</p>
      {error && <p className="error banner">{error}</p>}
      {failedStep && (
        <div>
          <p className="error">הבנייה נעצרה כדי לא לפרסם משהו שלא עובד כמו שצריך.</p>
          <button type="button" onClick={onBack}>
            חזרה
          </button>
        </div>
      )}
    </main>
  );
}
