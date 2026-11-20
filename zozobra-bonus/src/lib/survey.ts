import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseStore } from "@shared/store-supabase.ts";
import { recalcPeriod } from "@shared/recalc.ts";
import { currentPeriod, periodToDate } from "@shared/period.ts";

export interface SurveyTarget {
  id: string;
  branchId: string;
  firstName: string;
}

const CODE = /^[0-9a-f]{12}$/;

export async function findSurveyTarget(code: string): Promise<SurveyTarget | null> {
  if (!CODE.test(code)) return null;
  const db = createAdminClient();
  const { data } = await db
    .from("employees")
    .select("id, branch_id, first_name, active")
    .eq("survey_code", code)
    .maybeSingle();
  if (!data?.active) return null;
  return { id: data.id, branchId: data.branch_id, firstName: data.first_name };
}

export function clientHash(ip: string, ua: string): string {
  return createHash("sha256").update(`${ip}|${ua}`).digest("hex").slice(0, 32);
}

/**
 * Store one response, then turn the month's responses into the survey
 * (average 1–5) and service (average × 20 → 0–100) results and recalculate.
 * Abuse limit: one response per device per employee per 12h, 20 per device per day.
 */
export async function submitSurvey(t: SurveyTarget, overall: number, service: number, comment: string | null, hash: string) {
  const db = createAdminClient();
  const since12h = new Date(Date.now() - 12 * 3600_000).toISOString();
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [{ count: same }, { count: all }] = await Promise.all([
    db.from("survey_responses").select("id", { count: "exact", head: true })
      .eq("client_hash", hash).eq("employee_id", t.id).gte("created_at", since12h),
    db.from("survey_responses").select("id", { count: "exact", head: true })
      .eq("client_hash", hash).gte("created_at", since24h),
  ]);
  if ((same ?? 0) > 0) return { ok: false as const, reason: "already" };
  if ((all ?? 0) >= 20) return { ok: false as const, reason: "limit" };

  const period = currentPeriod();
  const pd = periodToDate(period);
  const { error } = await db.from("survey_responses").insert({
    branch_id: t.branchId, employee_id: t.id, period: pd, overall, service, comment, client_hash: hash,
  });
  if (error) throw new Error(error.message);

  const { data: rows } = await db.from("survey_responses").select("overall, service")
    .eq("employee_id", t.id).eq("period", pd);
  const n = rows?.length ?? 0;
  if (!n) return { ok: true as const };
  const avg = (k: "overall" | "service") => rows!.reduce((s, r) => s + r[k], 0) / n;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  const store = supabaseStore(db);
  await store.upsertResults([
    { branchId: t.branchId, period, metricId: "survey", employeeId: t.id, value: round2(avg("overall")), source: "survey", integrationId: null, note: `${n} תגובות` },
    { branchId: t.branchId, period, metricId: "service", employeeId: t.id, value: round2(avg("service") * 20), source: "survey", integrationId: null, note: `${n} תגובות` },
  ]);
  await recalcPeriod(store, t.branchId, period);
  return { ok: true as const };
}
