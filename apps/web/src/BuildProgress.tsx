import { useEffect, useRef, useState } from "react";
import type { AgentStepEvent, Project } from "@forge/shared";

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
  const agentOrder: string[] = [];
  for (const event of events) {
    if (!latestByAgent.has(event.agent)) agentOrder.push(event.agent);
    latestByAgent.set(event.agent, event);
  }
  const steps = agentOrder.map((agent) => latestByAgent.get(agent)!);

  return (
    <main className="ai-team">
      <h1>{title}</h1>
      <p className="muted">
        Every step below does real, verifiable work — a real migration, real seed data, a real
        smoke test, a real static scan — not a scripted delay.
      </p>
      <ol className="agent-steps">
        {steps.map((event) => (
          <li key={event.agent} className={`agent-step agent-step-${event.status}`}>
            <StatusIcon status={event.status} />
            <div>
              <strong>{event.agent} Agent</strong>
              <p>{event.message}</p>
            </div>
          </li>
        ))}
      </ol>
      {error && <p className="error banner">{error}</p>}
      {failedStep && (
        <div>
          <p className="error">
            The {failedStep.agent} agent reported a failure, so this build was not published. Fix
            the underlying issue and try again.
          </p>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      )}
    </main>
  );
}
