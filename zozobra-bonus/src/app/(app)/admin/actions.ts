"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { back } from "@/lib/flash";
import { recalcNow } from "@/lib/recalc";
import { createClient } from "@/lib/supabase/server";
import { formatShekels } from "@shared/payout.ts";
import { addMonths, isPeriod, periodToDate } from "@shared/period.ts";
import { parseNumber } from "@shared/csv.ts";
import { ROLE_ELIGIBILITY, type JobRole } from "@shared/metrics.ts";

function periodOf(form: FormData): string {
  const p = String(form.get("period") ?? "");
  if (!isPeriod(p)) throw new Error("תקופה לא תקינה");
  return p;
}

// ------------------------------------------------------------ recalculate
export async function recalcAction(form: FormData) {
  const me = await requireAdmin();
  const period = periodOf(form);
  const to = String(form.get("to") ?? "/admin");
  const s = await recalcNow(me.employee.branch_id, period);
  revalidatePath("/admin", "layout");
  back(to, { period, ok: `חושב מחדש: ${s.employees} עובדים, סה״כ ${formatShekels(s.total)}` });
}

// ---------------------------------------------------------------- targets
const ROLES: JobRole[] = Object.keys(ROLE_ELIGIBILITY) as JobRole[];

export async function saveTargets(form: FormData) {
  const me = await requireAdmin();
  const period = periodOf(form);
  const sb = await createClient();
  const metricIds = form.getAll("metric").map(String);
  const path = "/admin/targets";

  for (const id of metricIds) {
    const target = parseNumber(String(form.get(`target:${id}`) ?? ""));
    const threshold = parseNumber(String(form.get(`threshold:${id}`) ?? ""));
    const max = parseNumber(String(form.get(`max:${id}`) ?? ""));
    const active = form.get(`active:${id}`) === "on";
    if (target === null && max === null) continue; // untouched row
    if (target === null || target <= 0) back(path, { period, err: `יעד לא תקין במדד ${id}` });
    if (threshold === null || threshold <= 0 || threshold > 100) back(path, { period, err: `סף לא תקין במדד ${id} (1–100)` });
    if (max === null || max < 0) back(path, { period, err: `סכום מקסימלי לא תקין במדד ${id}` });

    const { data: row, error } = await sb
      .from("metric_targets")
      .upsert(
        {
          branch_id: me.employee.branch_id,
          metric_id: id,
          period: periodToDate(period),
          target,
          threshold_pct: threshold,
          max_amount: Math.round(max * 100),
          active,
        },
        { onConflict: "branch_id,metric_id,period" },
      )
      .select("id")
      .single();
    if (error) back(path, { period, err: error.message });

    // per-role amount overrides (empty = use default)
    for (const role of ROLES) {
      const raw = form.get(`role:${id}:${role}`);
      if (raw === null) continue;
      const v = parseNumber(String(raw));
      if (v === null) {
        await sb.from("metric_target_role_amounts").delete().eq("target_id", row!.id).eq("job_role", role);
      } else {
        await sb
          .from("metric_target_role_amounts")
          .upsert({ target_id: row!.id, job_role: role, max_amount: Math.round(v * 100) }, { onConflict: "target_id,job_role" });
      }
    }
  }
  await recalcNow(me.employee.branch_id, period);
  revalidatePath("/admin", "layout");
  back(path, { period, ok: "היעדים נשמרו והבונוסים חושבו מחדש" });
}

export async function copyTargets(form: FormData) {
  const me = await requireAdmin();
  const period = periodOf(form);
  const sb = await createClient();
  const prev = addMonths(period, -1);
  const { data: src } = await sb
    .from("metric_targets")
    .select("*, metric_target_role_amounts(job_role, max_amount)")
    .eq("period", periodToDate(prev));
  if (!src?.length) back("/admin/targets", { period, err: "אין יעדים בחודש הקודם להעתקה" });
  for (const t of src!) {
    const { data: row } = await sb
      .from("metric_targets")
      .upsert(
        {
          branch_id: me.employee.branch_id,
          metric_id: t.metric_id,
          period: periodToDate(period),
          target: t.target,
          threshold_pct: t.threshold_pct,
          max_amount: t.max_amount,
          active: t.active,
        },
        { onConflict: "branch_id,metric_id,period", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (row) {
      for (const ra of t.metric_target_role_amounts ?? []) {
        await sb.from("metric_target_role_amounts").upsert({ target_id: row.id, ...ra }, { onConflict: "target_id,job_role" });
      }
    }
  }
  back("/admin/targets", { period, ok: "היעדים הועתקו מהחודש הקודם (יעדים קיימים לא שונו)" });
}

// -------------------------------------------------------------- approvals
export async function setPayoutStatus(form: FormData) {
  await requireAdmin();
  const period = periodOf(form);
  const to = String(form.get("to"));
  const ids = form.getAll("id").map(String);
  const sb = await createClient();
  const path = "/admin/approvals";
  if (!ids.length) back(path, { period, err: "לא נבחרו עובדים" });

  const map: Record<string, { from: string; to: string }> = {
    approved: { from: "draft", to: "approved" },
    draft: { from: "approved", to: "draft" },
    paid: { from: "approved", to: "paid" },
  };
  const t = map[to];
  if (!t) back(path, { period, err: "פעולה לא חוקית" });
  const { data, error } = await sb
    .from("bonus_payouts")
    .update({ status: t.to })
    .in("id", ids)
    .eq("status", t.from)
    .select("id");
  if (error) back(path, { period, err: error.message });
  const label = { approved: "אושרו", draft: "הוחזרו לטיוטה", paid: "סומנו כשולמו" }[to];
  revalidatePath("/admin", "layout");
  back(path, { period, ok: `${data?.length ?? 0} בונוסים ${label}` });
}

// ---------------------------------------------------------------- results
export async function saveResult(form: FormData) {
  const me = await requireAdmin();
  const period = periodOf(form);
  const metric = String(form.get("metric"));
  const employee = String(form.get("employee") || "") || null;
  const raw = String(form.get("value") ?? "").trim();
  const sb = await createClient();
  const path = "/admin/results";

  if (raw === "") {
    let q = sb.from("metric_results").delete().eq("period", periodToDate(period)).eq("metric_id", metric);
    q = employee ? q.eq("employee_id", employee) : q.is("employee_id", null);
    const { error } = await q;
    if (error) back(path, { period, err: error.message });
  } else {
    const value = parseNumber(raw);
    if (value === null) back(path, { period, err: `ערך לא תקין: ${raw}` });
    const { error } = await sb.from("metric_results").upsert(
      {
        branch_id: me.employee.branch_id,
        period: periodToDate(period),
        metric_id: metric,
        employee_id: employee,
        value,
        source: "manual",
        integration_id: null,
        note: String(form.get("note") ?? "") || null,
        synced_at: new Date().toISOString(),
      },
      { onConflict: "branch_id,period,metric_id,employee_id" },
    );
    if (error) back(path, { period, err: error.message });
  }
  await recalcNow(me.employee.branch_id, period);
  revalidatePath("/admin", "layout");
  back(path, { period, ok: "התוצאה עודכנה והבונוסים חושבו מחדש" });
}
