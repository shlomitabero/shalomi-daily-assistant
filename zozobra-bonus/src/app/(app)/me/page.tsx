import { requireMe } from "@/lib/auth";
import { resolvePeriod } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { MetricLineCard, type PayoutLine } from "@/components/MetricLineCard";
import { Card, Empty, Notice, PageHeader, SectionTitle, StatusBadge } from "@/components/ui";
import { dateShort, pct, shekels } from "@/lib/format";
import { dateToPeriod, payday, periodLabel, periodToDate } from "@shared/period.ts";
import { METRIC_BY_ID } from "@shared/metrics.ts";

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
  const maxTotal = lines.reduce((s, l) => s + Math.round(l.max_amount * 1.2 * (l.proration ?? 1)), 0);
  const proration = lines[0]?.proration ?? 1;

  return (
    <>
      <PageHeader
        title={`שלום ${me.employee.first_name}`}
        subtitle="הבונוס החודשי שלך, מעודכן לפי הנתונים האחרונים"
        actions={<PeriodPicker period={period} periods={periods} />}
      />

      {!payout ? (
        <Empty title={`עדיין אין חישוב בונוס ל${periodLabel(period)}`}>
          הבונוס יופיע כאן ברגע שיתקבלו נתונים ראשונים לחודש.
        </Empty>
      ) : (
        <div className="space-y-4">
          <Card className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -top-16 -start-16 h-48 w-48 rounded-full bg-gold/10 blur-3xl" />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">בונוס {periodLabel(period)}</span>
              <StatusBadge status={payout.status} />
            </div>
            <div className="num mt-2 text-end font-display text-5xl font-black gold-text">{shekels(payout.amount)}</div>
            <div className="mt-3 h-1.5 rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-gradient-to-l from-gold to-gold-2"
                style={{ width: `${maxTotal ? Math.min(100, (payout.amount / maxTotal) * 100) : 0}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>עמידה ממוצעת {pct(payout.avg_achievement)}</span>
              <span>
                מקסימום אפשרי <span className="num">{shekels(maxTotal)}</span>
              </span>
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-muted">
              {payout.status === "paid"
                ? "הבונוס שולם עם המשכורת."
                : `ישולם עם המשכורת ב־${dateShort(payday(period))}${payout.status === "draft" ? ", לאחר אישור ההנהלה" : ""}.`}
              {me.employee.tip_based ? " הבונוס מופיע בתלוש כשורה נפרדת, בנוסף לטיפים ולהשלמה לשכר מינימום." : ""}
            </p>
          </Card>

          {proration < 1 ? (
            <Notice tone="gold">הבונוס מחושב באופן יחסי לימי העבודה בחודש ({pct(proration)}).</Notice>
          ) : null}
          {payout.missing_metrics?.length ? (
            <Notice>
              חסרים עדיין נתונים עבור: {payout.missing_metrics.map((m: string) => METRIC_BY_ID[m as keyof typeof METRIC_BY_ID]?.name ?? m).join(", ")}.
              הסכום יתעדכן כשיגיעו.
            </Notice>
          ) : null}

          <SectionTitle>פירוט לפי מדד</SectionTitle>
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
