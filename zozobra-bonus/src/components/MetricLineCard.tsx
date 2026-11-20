import { AchievementMeter, Badge, achievementStatus } from "./ui";
import { MetricIcon } from "./MetricIcon";
import { num, pct, shekels } from "@/lib/format";
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

export function MetricLineCard({ line, source }: { line: PayoutLine; source?: string }) {
  const def = METRIC_BY_ID[line.metric_id];
  const unit = def?.unit ?? "";
  const max = Math.round(line.max_amount * (line.proration ?? 1));
  const st = achievementStatus(line.achievement);
  return (
    <article className="card flex flex-col gap-2.5 p-[15px]">
      <div className="flex items-start gap-2.5">
        <MetricIcon id={line.metric_id} />
        <div className="min-w-0 flex-1">
          <b className="block text-sm font-bold">{line.name}</b>
          <small className="text-[11.5px] text-muted">{def?.description}</small>
        </div>
        <div className="text-end font-extrabold whitespace-nowrap">
          <span className="num">{shekels(line.amount)}</span>
          <small className="block text-[10.5px] font-normal text-faint">
            מתוך <span className="num">{shekels(max)}</span>
          </small>
        </div>
      </div>
      <AchievementMeter achievement={line.achievement} />
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span>
          בפועל <b className="num font-medium text-ink">{num(line.actual, unit)}</b> · יעד{" "}
          <b className="num font-medium text-ink">{num(line.target, unit)}</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded-full border border-line px-[7px] py-0.5 text-[10.5px] text-faint">
            {def?.scope === "branch" ? "צוות" : "אישי"}
          </span>
          <Badge tone={st.tone}>
            {line.achievement === null ? st.label : `${pct(line.achievement)} · ${st.label}`}
          </Badge>
        </span>
      </div>
      <details className="text-[11px] text-faint">
        <summary className="cursor-pointer">
          {source ? `מקור: ${source} · ` : ""}איך מחושב?
        </summary>
        <div className="mt-2 rounded-xl bg-bg p-3 leading-7 text-muted">
          יעד <b className="num text-ink">{num(line.target, unit)}</b> ({def?.direction === "lower" ? "נמוך יותר = טוב" : "גבוה יותר = טוב"})<br />
          מתחת ל־{line.threshold_pct}% מהיעד ← <b className="text-ink">0 ₪</b>
          <br />
          ב־{line.threshold_pct}% מהיעד ← <b className="num text-ink">{shekels(max * 0.5)}</b>
          <br />
          ב־100% מהיעד ← <b className="num text-ink">{shekels(max)}</b>
          <br />
          מעל היעד ← עד <b className="num text-ink">{shekels(max * 1.2)}</b> (תקרה 120%)
        </div>
      </details>
    </article>
  );
}
