import { requireAdmin } from "@/lib/auth";
import { adminPeriods } from "@/lib/periods";
import { createClient } from "@/lib/supabase/server";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { Badge, Card, PageHeader } from "@/components/ui";
import { addMonths, periodLabel, periodToDate } from "@shared/period.ts";
import { ROLE_ELIGIBILITY, ROLE_LABELS, type JobRole } from "@shared/metrics.ts";
import { copyTargets, saveTargets } from "../actions";

export const metadata = { title: "יעדים" };

export default async function Targets({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const { period, periods } = await adminPeriods(sp.period);
  const sb = await createClient();
  const [{ data: metrics }, { data: targets }] = await Promise.all([
    sb.from("metrics").select("*").order("sort_order"),
    sb.from("metric_targets").select("*, metric_target_role_amounts(job_role, max_amount)").eq("period", periodToDate(period)),
  ]);
  const byMetric = new Map((targets ?? []).map((t) => [t.metric_id, t]));

  return (
    <>
      <PageHeader
        title="יעדים ובונוסים"
        subtitle={`הגדרות ל${periodLabel(period)}. סכומים בשקלים, לפני תקרת 120%.`}
        actions={<PeriodPicker period={period} periods={periods} />}
      />
      <Flash ok={sp.ok} err={sp.err} />

      {!targets?.length ? (
        <form action={copyTargets} className="mb-4">
          <input type="hidden" name="period" value={period} />
          <SubmitButton variant="secondary" pendingText="מעתיק…">
            העתקת יעדים מ{periodLabel(addMonths(period, -1))}
          </SubmitButton>
        </form>
      ) : null}

      <form action={saveTargets} className="space-y-3">
        <input type="hidden" name="period" value={period} />
        {(metrics ?? []).map((m) => {
          const t = byMetric.get(m.id);
          const roles = (Object.keys(ROLE_ELIGIBILITY) as JobRole[]).filter((r) => ROLE_ELIGIBILITY[r].includes(m.id));
          const overrides = new Map<string, number>((t?.metric_target_role_amounts ?? []).map((r: { job_role: string; max_amount: number }) => [r.job_role, r.max_amount]));
          return (
            <Card key={m.id}>
              <input type="hidden" name="metric" value={m.id} />
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-medium">{m.name}</h3>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge>{m.scope === "branch" ? "סניפי" : "אישי"}</Badge>
                    <Badge tone={m.direction === "lower" ? "warn" : "muted"}>{m.direction === "lower" ? "נמוך = טוב" : "גבוה = טוב"}</Badge>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={`active:${m.id}`} defaultChecked={t ? t.active : true} className="h-4 w-4 accent-[#cfa95f]" />
                  פעיל
                </label>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="label">יעד {m.unit ? `(${m.unit})` : ""}</label>
                  <input name={`target:${m.id}`} defaultValue={t ? Number(t.target) : ""} inputMode="decimal" className="field num text-center" />
                </div>
                <div>
                  <label className="label">סף (%)</label>
                  <input name={`threshold:${m.id}`} defaultValue={t ? Number(t.threshold_pct) : 90} inputMode="decimal" className="field num text-center" />
                </div>
                <div>
                  <label className="label">בונוס ב־100% (₪)</label>
                  <input name={`max:${m.id}`} defaultValue={t ? t.max_amount / 100 : ""} inputMode="decimal" className="field num text-center" />
                </div>
              </div>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted">
                  סכום שונה לפי תפקיד {overrides.size ? <span className="text-gold">({overrides.size})</span> : null}
                </summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {roles.map((r) => (
                    <div key={r}>
                      <label className="label">{ROLE_LABELS[r]} (₪)</label>
                      <input
                        name={`role:${m.id}:${r}`}
                        defaultValue={overrides.has(r) ? overrides.get(r)! / 100 : ""}
                        placeholder="ברירת מחדל"
                        inputMode="decimal"
                        className="field num text-center"
                      />
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          );
        })}
        <div className="sticky bottom-20">
          <SubmitButton className="w-full" pendingText="שומר ומחשב…">
            שמירה וחישוב מחדש
          </SubmitButton>
        </div>
      </form>
      <p className="mt-4 text-xs leading-relaxed text-faint">
        כלל החישוב: מתחת לסף — 0. בסף — 50% מהבונוס. בין הסף ליעד — עולה בקו ישר. ביעד — 100%. מעל היעד — כל אחוז מעל היעד מוסיף 2% לבונוס,
        עד תקרה של 120% (מושגת ב־110% מהיעד). במדדים שבהם נמוך = טוב, העמידה היא יעד ÷ בפועל. שינוי יעד אחרי אישור מחזיר את
        הבונוסים המושפעים לטיוטה.
      </p>
    </>
  );
}
