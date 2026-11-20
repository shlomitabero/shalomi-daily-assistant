import { requireMe } from "@/lib/auth";
import { resolvePeriod } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { MetricLineCard } from "@/components/MetricLineCard";
import { Empty, SectionTitle } from "@/components/ui";
import { pct } from "@/lib/format";
import { periodLabel, periodToDate } from "@shared/period.ts";
import { METRIC_BY_ID, ROLE_LABELS, type JobRole, type MetricId } from "@shared/metrics.ts";
import { computeMetricPayout } from "@shared/payout.ts";

export const metadata = { title: "טבלת מובילים" };

export default async function Leaderboard({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireMe();
  const { period, periods } = await resolvePeriod((await searchParams).period);
  const sb = await createClient();
  const pd = periodToDate(period);
  const [{ data }, { data: targets }, { data: results }] = await Promise.all([
    sb.rpc("leaderboard", { p_period: pd }),
    sb.from("metric_targets").select("*").eq("period", pd).eq("active", true),
    sb.from("metric_results").select("metric_id, value").eq("period", pd).is("employee_id", null),
  ]);
  const rows = (data ?? []) as { rank: number; first_name: string; job_role: JobRole; realization: number; is_me: boolean }[];

  // branch ("team") metrics — one result for the whole restaurant
  const team = (targets ?? [])
    .filter((t) => METRIC_BY_ID[t.metric_id as MetricId]?.scope === "branch")
    .sort((a, b) => Object.keys(METRIC_BY_ID).indexOf(a.metric_id) - Object.keys(METRIC_BY_ID).indexOf(b.metric_id))
    .map((t) => {
      const def = METRIC_BY_ID[t.metric_id as MetricId];
      const r = (results ?? []).find((x) => x.metric_id === t.metric_id);
      const actual = r ? Number(r.value) : null;
      const p = computeMetricPayout({
        actual,
        target: Number(t.target),
        thresholdPct: Number(t.threshold_pct),
        maxAmount: t.max_amount,
        direction: def.direction,
      });
      return {
        metric_id: def.id,
        name: def.name,
        actual,
        target: Number(t.target),
        threshold_pct: Number(t.threshold_pct),
        max_amount: t.max_amount,
        achievement: p.achievement,
        factor: p.factor,
        amount: p.amount,
        status: p.status,
        proration: 1,
      };
    });

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-[13px] text-muted">
        <span>תקופה:</span>
        <PeriodPicker period={period} periods={periods} />
      </div>

      <SectionTitle aside={<span className="text-xs text-muted">לפי % מימוש הבונוס</span>}>טבלת מובילים</SectionTitle>
      {!rows.length ? (
        <Empty title={`אין עדיין דירוג ל${periodLabel(period)}`} />
      ) : (
        <div className="card overflow-hidden !rounded-[18px] p-0">
          {rows.map((r, i) => (
            <div
              key={i}
              className={`grid grid-cols-[34px_1fr_auto_auto] items-center gap-3 border-b border-line px-[15px] py-[13px] last:border-b-0 ${r.is_me ? "bg-[#221d15]" : ""}`}
            >
              <div className={`num text-center text-[15px] font-extrabold ${r.rank === 1 ? "text-gold" : "text-faint"}`}>{r.rank}</div>
              <div className="min-w-0">
                <b className="block truncate text-sm">
                  {r.first_name} {r.is_me ? <span className="text-xs font-normal text-gold">(את/ה)</span> : null}
                </b>
                <small className="text-[11.5px] text-muted">{ROLE_LABELS[r.job_role]}</small>
              </div>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
                <i className="block h-full rounded-full bg-gold" style={{ width: `${Math.min(100, Number(r.realization) * 100)}%` }} />
              </div>
              <div className="num min-w-12 text-start font-extrabold">{pct(Number(r.realization))}</div>
            </div>
          ))}
        </div>
      )}

      {team.length ? (
        <div className="mt-6">
          <SectionTitle aside={<span className="text-xs text-muted">מדדי צוות — כולם מרוויחים יחד</span>}>יעדי הסניף</SectionTitle>
          <div className="space-y-2.5">
            {team.map((l) => (
              <MetricLineCard key={l.metric_id} line={l} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
