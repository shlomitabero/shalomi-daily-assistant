import { requireAdmin } from "@/lib/auth";
import { adminPeriods } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Flash } from "@/components/Flash";
import { CheckAll, SubmitButton } from "@/components/forms";
import { Card, Empty, LinkButton, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { dateShort, pct, shekels } from "@/lib/format";
import { payday, periodLabel, periodToDate } from "@shared/period.ts";
import { METRIC_BY_ID, ROLE_LABELS, type JobRole, type MetricId } from "@shared/metrics.ts";
import { recalcAction, setPayoutStatus } from "../actions";

export const metadata = { title: "אישור בונוסים" };

export default async function Approvals({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const { period, periods } = await adminPeriods(sp.period);
  const sb = await createClient();
  const { data } = await sb
    .from("bonus_payouts")
    .select("id, amount, status, missing_metrics, realization, lines, employees!inner(first_name, last_name, job_role, tip_based, payroll_id)")
    .eq("period", periodToDate(period))
    .order("amount", { ascending: false });

  type Row = {
    id: string;
    amount: number;
    status: string;
    missing_metrics: string[];
    realization: number | null;
    lines: { name: string; amount: number; status: string }[];
    employees: { first_name: string; last_name: string; job_role: JobRole; tip_based: boolean; payroll_id: string | null };
  };
  const rows = (data ?? []) as unknown as Row[];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const approvedTotal = rows.filter((r) => r.status !== "draft").reduce((s, r) => s + r.amount, 0);
  const drafts = rows.filter((r) => r.status === "draft").length;

  return (
    <>
      <PageHeader
        title="אישור בונוסים"
        subtitle={`${periodLabel(period)} · משולם עם המשכורת ב־${dateShort(payday(period))}`}
        actions={<PeriodPicker period={period} periods={periods} />}
      />
      <Flash ok={sp.ok} err={sp.err} />

      {!rows.length ? (
        <Empty title="אין בונוסים מחושבים לחודש זה">
          <form action={recalcAction} className="mt-3">
            <input type="hidden" name="period" value={period} />
            <input type="hidden" name="to" value="/admin/approvals" />
            <SubmitButton variant="secondary">חישוב עכשיו</SubmitButton>
          </form>
        </Empty>
      ) : (
        <>
          <Card className="mb-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-xs text-muted">סה״כ לחודש</div>
                <div className="num font-display text-3xl font-black gold-text">{shekels(total)}</div>
              </div>
              <div className="text-end text-xs text-muted">
                <div>
                  מאושר לתשלום: <span className="num text-ink">{shekels(approvedTotal)}</span>
                </div>
                <div>{drafts} ממתינים לאישור</div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <LinkButton href={`/admin/export?period=${period}&format=xlsx`} download size="sm">
                ייצוא לאקסל
              </LinkButton>
              <LinkButton href={`/admin/export?period=${period}&format=csv`} download size="sm">
                ייצוא CSV
              </LinkButton>
            </div>
            <p className="mt-2 text-[0.7rem] text-faint">
              הייצוא כולל רק בונוסים מאושרים או ששולמו. הבונוס הוא שורת שכר נפרדת — גם לעובדי טיפים, בנוסף לטיפים
              ולהשלמה לשכר מינימום.
            </p>
          </Card>

          {rows.some((r) => r.missing_metrics?.length && r.status === "draft") ? (
            <div className="mb-3">
              <Notice>עובדים המסומנים ⚠ חסרים להם נתונים — אישור עכשיו ישלם 0 על המדד החסר.</Notice>
            </div>
          ) : null}

          <form id="payouts" action={setPayoutStatus}>
            <input type="hidden" name="period" value={period} />
            <Card className="!p-0">
              <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-xs text-muted">
                <CheckAll form="payouts" name="id" />
                <span>בחירת הכל</span>
              </div>
              <ul className="divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <label className="flex items-start gap-3">
                      <input type="checkbox" name="id" value={r.id} className="mt-1 h-4 w-4 accent-[#cfa95f]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">
                            {r.missing_metrics?.length ? "⚠ " : ""}
                            {r.employees.first_name} {r.employees.last_name}
                          </span>
                          <span className="num shrink-0 font-semibold">{shekels(r.amount)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
                          <span className="truncate">
                            {ROLE_LABELS[r.employees.job_role]} · מימוש {pct(r.realization)}
                            {r.missing_metrics?.length
                              ? ` · חסר: ${r.missing_metrics.map((m) => METRIC_BY_ID[m as MetricId]?.name ?? m).join(", ")}`
                              : ""}
                          </span>
                          <StatusBadge status={r.status} />
                        </div>
                      </div>
                    </label>
                    <details className="ms-7 mt-1 text-xs">
                      <summary className="cursor-pointer text-faint">פירוט</summary>
                      <ul className="mt-1 space-y-0.5 text-muted">
                        {r.lines.map((l) => (
                          <li key={l.name} className="flex justify-between">
                            <span>{l.name}</span>
                            <span className="num">{shekels(l.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            </Card>
            <div className="sticky bottom-20 mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-bg/80 p-1 backdrop-blur">
              <SubmitButton name="to" value="approved" pendingText="מאשר…">
                אישור
              </SubmitButton>
              <SubmitButton name="to" value="draft" variant="secondary" pendingText="…">
                החזרה לטיוטה
              </SubmitButton>
              <SubmitButton name="to" value="paid" variant="secondary" pendingText="…" confirm="לסמן את הנבחרים כשולמו? לאחר מכן לא ניתן לשנות.">
                סימון שולם
              </SubmitButton>
            </div>
          </form>
        </>
      )}
    </>
  );
}
