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
          return (
            <li key={agent} className={`agent-step agent-step-${status}`}>
              {status === "pending" ? (
                <span className="step-icon step-pending">{info.icon}</span>
              ) : (
                <StatusIcon status={status as AgentStepEvent["status"]} />
              )}
              <div>
                <strong>
                  {info.icon} {info.title}
                </strong>
                <p>{caption}</p>
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
