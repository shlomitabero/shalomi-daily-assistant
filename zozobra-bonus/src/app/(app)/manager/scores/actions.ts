"use server";

import { requireManager } from "@/lib/auth";
import { back } from "@/lib/flash";
import { recalcNow } from "@/lib/recalc";
import { createClient } from "@/lib/supabase/server";
import { parseNumber } from "@shared/csv.ts";
import { isPeriod, periodToDate } from "@shared/period.ts";

export async function saveScores(form: FormData) {
  const me = await requireManager();
  const period = String(form.get("period"));
  const metric = String(form.get("metric"));
  const path = "/manager/scores";
  if (!isPeriod(period)) back(path, { err: "תקופה לא תקינה" });

  const rows: { employee_id: string; value: number }[] = [];
  const clear: string[] = [];
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("score:")) continue;
    const employee_id = k.slice(6);
    const raw = String(v).trim();
    if (raw === "") {
      if (form.get(`had:${employee_id}`) === "1") clear.push(employee_id);
      continue;
    }
    const n = parseNumber(raw);
    if (n === null || n < 0) back(path, { period, metric, err: `ציון לא תקין: "${raw}"` });
    rows.push({ employee_id, value: n });
  }

  const sb = await createClient();
  if (rows.length) {
    // RLS: manager may only write manual scores for manager-editable metrics in their branch
    const { error } = await sb.from("metric_results").upsert(
      rows.map((r) => ({
        branch_id: me.employee.branch_id,
        period: periodToDate(period),
        metric_id: metric,
        employee_id: r.employee_id,
        value: r.value,
        source: "manual",
        integration_id: null,
        synced_at: new Date().toISOString(),
      })),
      { onConflict: "branch_id,period,metric_id,employee_id" },
    );
    if (error) back(path, { period, metric, err: `השמירה נכשלה: ${error.message}` });
  }
  if (clear.length && me.employee.app_role === "admin") {
    await sb.from("metric_results").delete()
      .eq("period", periodToDate(period)).eq("metric_id", metric).in("employee_id", clear);
  }

  await recalcNow(me.employee.branch_id, period);
  back(path, { period, metric, ok: `נשמרו ${rows.length} ציונים והבונוסים חושבו מחדש` });
}
