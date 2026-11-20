import { requireMe } from "@/lib/auth";
import { resolvePeriod } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { MetricLineCard, type PayoutLine } from "@/components/MetricLineCard";
import { ProgressRing } from "@/components/MetricIcon";
import { Card, Empty, Notice, SectionTitle, StatusBadge } from "@/components/ui";
import { dateShort, pct, shekels } from "@/lib/format";
import { dateToPeriod, payday, periodLabel, periodToDate } from "@shared/period.ts";
import { METRIC_BY_ID, ROLE_LABELS } from "@shared/metrics.ts";

export const metadata = { title: "הבונוס שלי" };

export default async function MyBonus({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const me = await requireMe();
  const { period, periods } = await resolvePeriod((await searchParams).period);
  const sb = await createClient();

  const [{ data: payout }, { data: history }] = await Promise.all([
    sb.from("bonus_payouts").select("*").eq("employee_id", me.employee.id).eq("period", periodToDate(period)).maybeSingle(),
    sb.from("bonus_payouts").select("period, amount, status").eq("employee_id", me.employee.id).order("period", { ascending: false }).limit(12),
  ]);

  const lines = (payout?.lines ?? []) as PayoutLine[];
  const maxTotal = lines.reduce((s, l) => s + Math.round(l.max_amount * (l.proration ?? 1)), 0);
  const hit = lines.filter((l) => l.achievement !== null && l.achievement + 1e-9 >= 1).length;
  const openBest = lines
    .map((l) => ({ name: l.name, gap: Math.round(l.max_amount * (l.proration ?? 1)) - l.amount }))
    .sort((a, b) => b.gap - a.gap)
    .find((x) => x.gap > 0);
  const proration = lines[0]?.proration ?? 1;

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-[13px] text-muted">
        <span>תקופה:</span>
        <PeriodPicker period={period} periods={periods} />
      </div>

      {!payout ? (
        <Empty title={`עדיין אין חישוב בונוס ל${periodLabel(period)}`}>
          הבונוס יופיע כאן ברגע שיתקבלו נתונים ראשונים לחודש.
        </Empty>
      ) : (
        <div className="space-y-4">
          <section className="hero flex items-center gap-4 p-[22px]">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-normal text-muted">הבונוס שלך החודש, {me.employee.first_name}</h2>
              <div className="mt-1 mb-0.5 flex flex-wrap items-baseline gap-x-1.5 leading-tight">
                <span className="num text-[2.4rem] font-extrabold tracking-tight">{shekels(payout.amount)}</span>
                <small className="text-base font-medium whitespace-nowrap text-gold">
                  מתוך <span className="num">{shekels(maxTotal)}</span>
                </small>
              </div>
              <div className="text-[13px] text-muted">
                {hit} מתוך {lines.length} יעדים הושגו
                {openBest ? (
                  <>
                    {" "}· הכי הרבה כסף פתוח ב<b className="text-ink">{openBest.name}</b> <span className="num whitespace-nowrap">({shekels(openBest.gap)})</span>
                  </>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-muted">{ROLE_LABELS[me.employee.job_role]}</span>
                <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-muted">
                  {payout.status === "paid" ? "✓ שולם" : payout.status === "approved" ? "✓ אושר לשכר" : "ממתין לאישור"}
                </span>
              </div>
            </div>
            <ProgressRing value={Number(payout.realization ?? 0)} size={92} />
          </section>
          <p className="px-1 text-xs leading-relaxed text-muted">
            {payout.status === "paid"
              ? "הבונוס שולם עם המשכורת."
              : `ישולם עם המשכורת ב־${dateShort(payday(period))}${payout.status === "draft" ? ", לאחר אישור ההנהלה" : ""}.`}
            {me.employee.tip_based ? " הבונוס משולם מעבר לתשר ולהשלמה לשכר מינימום, כשורה נפרדת בתלוש." : ""}
          </p>

          {proration < 1 ? (
            <Notice tone="gold">הבונוס מחושב באופן יחסי לימי העבודה בחודש ({pct(proration)}).</Notice>
          ) : null}
          {payout.missing_metrics?.length ? (
            <Notice>
              חסרים עדיין נתונים עבור: {payout.missing_metrics.map((m: string) => METRIC_BY_ID[m as keyof typeof METRIC_BY_ID]?.name ?? m).join(", ")}.
              הסכום יתעדכן כשיגיעו.
            </Notice>
          ) : null}

          <SectionTitle aside={<span className="text-xs text-muted">{lines.length} מדדים לתפקיד</span>}>המדדים שלי</SectionTitle>
          <div className="space-y-3">
            {lines.map((l) => (
              <MetricLineCard key={l.metric_id} line={l} />
            ))}
          </div>

          {history && history.length > 1 ? (
            <Card>
              <SectionTitle>חודשים קודמים</SectionTitle>
              <ul className="divide-y divide-line">
                {history.map((h) => (
                  <li key={h.period} className="flex items-center justify-between py-2.5 text-sm">
                    <span>{periodLabel(dateToPeriod(h.period))}</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={h.status} />
                      <span className="num font-semibold">{shekels(h.amount)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
