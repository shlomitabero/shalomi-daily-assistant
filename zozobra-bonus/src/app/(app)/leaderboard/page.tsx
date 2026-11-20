import { requireMe } from "@/lib/auth";
import { resolvePeriod } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Empty, PageHeader } from "@/components/ui";
import { pct } from "@/lib/format";
import { periodLabel, periodToDate } from "@shared/period.ts";
import { ROLE_LABELS, type JobRole } from "@shared/metrics.ts";

export const metadata = { title: "טבלת מובילים" };

const MEDALS = ["🥇", "🥈", "🥉"];

export default async function Leaderboard({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireMe();
  const { period, periods } = await resolvePeriod((await searchParams).period);
  const sb = await createClient();
  const { data } = await sb.rpc("leaderboard", { p_period: periodToDate(period) });
  const rows = (data ?? []) as { rank: number; first_name: string; job_role: JobRole; avg_achievement: number; is_me: boolean }[];

  return (
    <>
      <PageHeader
        title="טבלת מובילים"
        subtitle="דירוג לפי אחוז עמידה ממוצע ביעדים"
        actions={<PeriodPicker period={period} periods={periods} />}
      />
      {!rows.length ? (
        <Empty title={`אין עדיין דירוג ל${periodLabel(period)}`} />
      ) : (
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={i}
              className={`card flex items-center gap-3 px-4 py-3 ${r.is_me ? "!border-gold/60 bg-gold/5" : ""}`}
            >
              <span className="w-8 text-center text-lg">
                {r.rank <= 3 ? MEDALS[r.rank - 1] : <span className="num text-sm text-muted">{r.rank}</span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {r.first_name} {r.is_me ? <span className="text-xs text-gold">(את/ה)</span> : null}
                </div>
                <div className="text-xs text-muted">{ROLE_LABELS[r.job_role]}</div>
              </div>
              <div className="w-24">
                <div className="num text-end text-sm font-semibold">{pct(r.avg_achievement)}</div>
                <div className="mt-1 h-1 rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-gradient-to-l from-gold to-gold-2"
                    style={{ width: `${Math.min(100, (r.avg_achievement / 1.2) * 100)}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
