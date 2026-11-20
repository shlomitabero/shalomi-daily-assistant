import { requireAdmin } from "@/lib/auth";
import { adminPeriods } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { Badge, Card, PageHeader, SectionTitle } from "@/components/ui";
import { dateTime, num } from "@/lib/format";
import { periodLabel, periodToDate } from "@shared/period.ts";
import type { JobRole } from "@shared/metrics.ts";
import { saveResult } from "../actions";

export const metadata = { title: "תוצאות" };

const SOURCE: Record<string, string> = {
  manual: "ידני", csv: "CSV", webhook: "Webhook", tabit: "Tabit", beecomm: "Beecomm",
  cost: "עלויות", payroll: "שכר", pbx: "מרכזיה", survey: "סקרים",
};

export default async function Results({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const { period, periods } = await adminPeriods(sp.period);
  const sb = await createClient();
  const pd = periodToDate(period);
  const [{ data: metrics }, { data: results }, { data: employees }, { data: roleMetrics }, { data: targets }] = await Promise.all([
    sb.from("metrics").select("*").order("sort_order"),
    sb.from("metric_results").select("*").eq("period", pd),
    sb.from("employees").select("id, first_name, last_name, job_role, bonus_eligible").eq("active", true).order("first_name"),
    sb.from("role_metrics").select("*"),
    sb.from("metric_targets").select("metric_id, target, active").eq("period", pd),
  ]);
  const targetBy = new Map((targets ?? []).map((t) => [t.metric_id, t]));
  const resultKey = (m: string, e: string | null) => `${m}|${e ?? ""}`;
  const byKey = new Map((results ?? []).map((r) => [resultKey(r.metric_id, r.employee_id), r]));

  function Row({ metric, unit, employeeId, label }: { metric: string; unit: string; employeeId: string | null; label: string }) {
    const r = byKey.get(resultKey(metric, employeeId));
    return (
      <form action={saveResult} className="flex items-center gap-2 py-2">
        <input type="hidden" name="period" value={period} />
        <input type="hidden" name="metric" value={metric} />
        <input type="hidden" name="employee" value={employeeId ?? ""} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{label}</div>
          <div className="text-[0.68rem] text-faint">
            {r ? `${SOURCE[r.source] ?? r.source} · ${dateTime(r.synced_at)}` : "אין נתון"}
          </div>
        </div>
        <input
          name="value"
          defaultValue={r ? Number(r.value) : ""}
          inputMode="decimal"
          placeholder="—"
          className="field num !min-h-9 !w-28 !py-1 text-center text-sm"
          aria-label={`ערך ${label}`}
        />
        <span className="w-6 text-xs text-faint">{unit}</span>
        <SubmitButton size="sm" variant="secondary" pendingText="…">
          שמירה
        </SubmitButton>
      </form>
    );
  }

  return (
    <>
      <PageHeader
        title="תוצאות מדדים"
        subtitle={`${periodLabel(period)} — תיקון ידני נרשם ביומן השינויים ומחשב מחדש`}
        actions={<PeriodPicker period={period} periods={periods} />}
      />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="space-y-3">
        {(metrics ?? []).map((m) => {
          const t = targetBy.get(m.id);
          const roles = new Set((roleMetrics ?? []).filter((r) => r.metric_id === m.id).map((r) => r.job_role as JobRole));
          const people = (employees ?? []).filter((e) => e.bonus_eligible && roles.has(e.job_role));
          const filled = m.scope === "branch" ? (byKey.has(resultKey(m.id, null)) ? 1 : 0) : people.filter((e) => byKey.has(resultKey(m.id, e.id))).length;
          const needed = m.scope === "branch" ? 1 : people.length;
          return (
            <Card key={m.id}>
              <details open={m.scope === "branch"}>
                <summary className="cursor-pointer list-none">
                  <SectionTitle
                    aside={
                      <span className="flex items-center gap-1.5">
                        {t?.active ? null : <Badge>ללא יעד</Badge>}
                        <Badge tone={filled === needed ? "ok" : "warn"}>
                          {filled}/{needed}
                        </Badge>
                      </span>
                    }
                  >
                    {m.name}
                    {t ? <span className="ms-2 text-xs font-normal text-muted">יעד {num(Number(t.target), m.unit)}</span> : null}
                  </SectionTitle>
                </summary>
                <div className="divide-y divide-line">
                  {m.scope === "branch" ? (
                    <Row metric={m.id} unit={m.unit} employeeId={null} label="תוצאת הסניף" />
                  ) : (
                    people.map((e) => (
                      <Row key={e.id} metric={m.id} unit={m.unit} employeeId={e.id} label={`${e.first_name} ${e.last_name}`} />
                    ))
                  )}
                </div>
              </details>
            </Card>
          );
        })}
      </div>
    </>
  );
}
