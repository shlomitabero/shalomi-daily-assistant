import Link from "next/link";
import { requireManager } from "@/lib/auth";
import { resolvePeriod } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { Card, Empty, Notice, PageHeader, cx } from "@/components/ui";
import { dateTime, num } from "@/lib/format";
import { periodLabel, periodToDate } from "@shared/period.ts";
import { ROLE_LABELS, type JobRole } from "@shared/metrics.ts";
import { saveScores } from "./actions";

export const metadata = { title: "הזנת ציונים" };

export default async function Scores({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; metric?: string; ok?: string; err?: string }>;
}) {
  const me = await requireManager();
  const sp = await searchParams;
  const { period, periods } = await resolvePeriod(sp.period);
  const sb = await createClient();

  const { data: metrics } = await sb.from("metrics").select("id, name, unit").eq("manager_editable", true).order("sort_order");
  const metric = metrics?.find((m) => m.id === sp.metric) ?? metrics?.[0];
  if (!metric) return <Empty title="אין מדדים להזנה ידנית" />;

  const [{ data: roleRows }, { data: employees }, { data: results }, { data: target }] = await Promise.all([
    sb.from("role_metrics").select("job_role").eq("metric_id", metric.id),
    sb.from("employees").select("id, first_name, last_name, job_role, bonus_eligible").eq("active", true).order("first_name"),
    sb.from("metric_results").select("employee_id, value, source, synced_at").eq("metric_id", metric.id).eq("period", periodToDate(period)),
    sb.from("metric_targets").select("target, active").eq("metric_id", metric.id).eq("period", periodToDate(period)).maybeSingle(),
  ]);
  const roles = new Set((roleRows ?? []).map((r) => r.job_role as JobRole));
  const people = (employees ?? []).filter((e) => e.bonus_eligible && roles.has(e.job_role));
  const byEmp = new Map((results ?? []).map((r) => [r.employee_id, r]));

  return (
    <>
      <PageHeader
        title="הזנת ציונים"
        subtitle={`ציונים ידניים ל${periodLabel(period)} — נשמרים ומעדכנים את הבונוס מיד`}
        actions={<PeriodPicker period={period} periods={periods} />}
      />
      <Flash ok={sp.ok} err={sp.err} />

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {metrics!.map((m) => (
          <Link
            key={m.id}
            href={`?period=${period}&metric=${m.id}`}
            className={cx(
              "rounded-full border px-3.5 py-1.5 text-sm whitespace-nowrap",
              m.id === metric.id ? "border-gold bg-gold/15 text-gold" : "border-line text-muted",
            )}
          >
            {m.name}
          </Link>
        ))}
      </div>

      {!target?.active ? (
        <div className="mb-4">
          <Notice>לא הוגדר יעד פעיל למדד זה בחודש הנבחר — הציונים יישמרו אך לא ייכנסו לבונוס עד שיוגדר יעד.</Notice>
        </div>
      ) : (
        <p className="mb-3 text-sm text-muted">
          יעד: <span className="num text-ink">{num(Number(target.target), metric.unit)}</span>
        </p>
      )}

      {!people.length ? (
        <Empty title="אין עובדים זכאים למדד זה" />
      ) : (
        <form action={saveScores}>
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="metric" value={metric.id} />
          <Card className="!p-0">
            <ul className="divide-y divide-line">
              {people.map((e) => {
                const r = byEmp.get(e.id);
                const locked = r && r.source !== "manual" && me.employee.app_role !== "admin";
                return (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {e.first_name} {e.last_name}
                      </div>
                      <div className="text-xs text-muted">
                        {ROLE_LABELS[e.job_role as JobRole]}
                        {r ? ` · עודכן ${dateTime(r.synced_at)}${r.source !== "manual" ? " (ממערכת)" : ""}` : ""}
                      </div>
                    </div>
                    {r ? <input type="hidden" name={`had:${e.id}`} value="1" /> : null}
                    <input
                      name={locked ? undefined : `score:${e.id}`}
                      defaultValue={r ? Number(r.value) : ""}
                      inputMode="decimal"
                      disabled={!!locked}
                      className="field num !w-24 text-center"
                      aria-label={`ציון ${e.first_name}`}
                      placeholder="—"
                    />
                  </li>
                );
              })}
            </ul>
          </Card>
          <div className="sticky bottom-20 mt-4">
            <SubmitButton className="w-full">שמירת ציונים</SubmitButton>
          </div>
        </form>
      )}
    </>
  );
}
