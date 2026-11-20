import { AchievementMeter, Badge } from "./ui";
import { LINE_STATUS_LABEL, num, pct, shekels } from "@/lib/format";
import { METRIC_BY_ID, type MetricId } from "@shared/metrics.ts";

export interface PayoutLine {
  metric_id: MetricId;
  name: string;
  actual: number | null;
  target: number;
  threshold_pct: number;
  max_amount: number;
  achievement: number | null;
  factor: number;
  amount: number;
  status: "ok" | "below_threshold" | "missing" | "invalid_target";
  proration: number;
}

export function MetricLineCard({ line }: { line: PayoutLine }) {
  const def = METRIC_BY_ID[line.metric_id];
  const unit = def?.unit ?? "";
  const lower = def?.direction === "lower";
  const max = Math.round(line.max_amount * 1.2 * (line.proration ?? 1));
  return (
    <article className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium leading-snug">{line.name}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>{def?.scope === "branch" ? "מדד סניפי" : "מדד אישי"}</span>
            {lower ? <span>· נמוך = טוב</span> : null}
            {line.status !== "ok" ? (
              <Badge tone={line.status === "missing" ? "muted" : "bad"}>{LINE_STATUS_LABEL[line.status]}</Badge>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-end">
          <div className={`num text-lg font-bold ${line.amount > 0 ? "gold-text" : "text-faint"}`}>{shekels(line.amount)}</div>
          <div className="text-[0.7rem] text-faint">
            מתוך <span className="num">{shekels(max)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Cell label="בפועל" value={num(line.actual, unit)} />
        <Cell label="יעד" value={num(line.target, unit)} />
        <Cell label="עמידה" value={pct(line.achievement)} strong />
      </div>

      <AchievementMeter achievement={line.achievement} thresholdPct={line.threshold_pct} showLegend />
    </article>
  );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
      <div className="text-[0.65rem] text-muted">{label}</div>
      <div className={`num text-sm ${strong ? "font-semibold text-ink" : "text-ink/90"}`}>{value}</div>
    </div>
  );
}
