import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { adminPeriods } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { Card, Empty, LinkButton, Notice, PageHeader, SectionTitle, Stat, StatusBadge } from "@/components/ui";
import { dateShort, dateTime, pct, shekels } from "@/lib/format";
import { payday, periodLabel, periodToDate } from "@shared/period.ts";
import { METRICS } from "@shared/metrics.ts";
import { recalcAction } from "./actions";

export const metadata = { title: "לוח בקרה" };

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const { period, periods } = await adminPeriods(sp.period);
  const sb = await createClient();
  const pd = periodToDate(period);

  const [{ data: payouts }, { data: targets }, { data: results }, { count: unmatched }, { data: integrations }] =
    await Promise.all([
      sb.from("bonus_payouts").select("amount, status, missing_metrics, avg_achievement").eq("period", pd),
      sb.from("metric_targets").select("metric_id, active").eq("period", pd),
      sb.from("metric_results").select("metric_id, employee_id").eq("period", pd),
      sb.from("unmatched_rows").select("id", { count: "exact", head: true }).is("resolved_at", null),
      sb.from("integrations").select("display_name, system, status, last_sync_at, last_status").order("display_name"),
    ]);

  const sum = (s?: string) => (payouts ?? []).filter((p) => !s || p.status === s).reduce((a, p) => a + p.amount, 0);
  const count = (s: string) => (payouts ?? []).filter((p) => p.status === s).length;
  const withMissing = (payouts ?? []).filter((p) => p.missing_metrics?.length).length;
  const activeTargets = new Set((targets ?? []).filter((t) => t.active).map((t) => t.metric_id));
  const branchMetricsMissing = METRICS.filter(
    (m) => m.scope === "branch" && activeTargets.has(m.id) && !(results ?? []).some((r) => r.metric_id === m.id),
  );
  const avg = payouts?.length
    ? payouts.reduce((a, p) => a + Number(p.avg_achievement ?? 0), 0) / payouts.length
    : null;

  return (
    <>
      <PageHeader
        title="לוח בקרה"
        subtitle={`${periodLabel(period)} · תשלום ב־${dateShort(payday(period))}`}
        actions={<PeriodPicker period={period} periods={periods} />}
      />
      <Flash ok={sp.ok} err={sp.err} />

      {!targets?.length ? (
        <Empty title={`לא הוגדרו יעדים ל${periodLabel(period)}`}>
          <div className="mt-3">
            <LinkButton href={`/admin/targets?period=${period}`} variant="primary">
              הגדרת יעדים
            </LinkButton>
          </div>
        </Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="סה״כ בונוסים לחודש" value={shekels(sum())} tone="gold" hint={`${payouts?.length ?? 0} עובדים`} />
            <Stat label="עמידה ממוצעת" value={pct(avg)} />
            <Stat label="ממתינים לאישור" value={count("draft")} hint={shekels(sum("draft"))} />
            <Stat label="מאושרים / שולמו" value={`${count("approved")} / ${count("paid")}`} hint={shekels(sum("approved") + sum("paid"))} />
          </div>

          {withMissing || branchMetricsMissing.length || unmatched ? (
            <div className="space-y-2">
              {branchMetricsMissing.length ? (
                <Notice>חסרים נתוני סניף: {branchMetricsMissing.map((m) => m.name).join(", ")}</Notice>
              ) : null}
              {withMissing ? (
                <Notice>
                  ל־{withMissing} עובדים חסר לפחות נתון אחד — הם יקבלו 0 על המדד החסר אם יאושרו כך.{" "}
                  <Link className="underline" href={`/admin/results?period=${period}`}>
                    לתוצאות
                  </Link>
                </Notice>
              ) : null}
              {unmatched ? (
                <Notice tone="bad">
                  {unmatched} שורות מיובאות ממתינות לשיוך עובד.{" "}
                  <Link className="underline" href="/admin/mapping">
                    לשיוך
                  </Link>
                </Notice>
              ) : null}
            </div>
          ) : (
            <Notice tone="ok">כל הנתונים לחודש התקבלו.</Notice>
          )}

          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/admin/approvals?period=${period}`} variant="primary">
              לאישור בונוסים
            </LinkButton>
            <form action={recalcAction}>
              <input type="hidden" name="period" value={period} />
              <SubmitButton variant="secondary" pendingText="מחשב…">
                חישוב מחדש
              </SubmitButton>
            </form>
          </div>

          <Card>
            <SectionTitle aside={<Link href="/admin/sync-log" className="text-xs text-gold">יומן סנכרון</Link>}>
              מקורות נתונים
            </SectionTitle>
            <ul className="divide-y divide-line">
              {(integrations ?? []).map((i) => (
                <li key={i.system} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="min-w-0 truncate">{i.display_name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                    {i.last_sync_at ? dateTime(i.last_sync_at) : null}
                    <StatusBadge status={i.last_status ?? i.status} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
