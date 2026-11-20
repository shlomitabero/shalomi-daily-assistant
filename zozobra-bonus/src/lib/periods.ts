import "server-only";
import { createClient } from "@/lib/supabase/server";
import { currentPeriod, dateToPeriod, isPeriod, addMonths } from "@shared/period.ts";

/** Periods that have targets, newest first, plus the current month. */
export async function availablePeriods(): Promise<string[]> {
  const sb = await createClient();
  const { data } = await sb.from("metric_targets").select("period").order("period", { ascending: false });
  const set = new Set<string>((data ?? []).map((r) => dateToPeriod(r.period)));
  return [...set].sort().reverse();
}

export async function resolvePeriod(requested?: string | string[]): Promise<{ period: string; periods: string[] }> {
  const periods = await availablePeriods();
  const req = typeof requested === "string" && isPeriod(requested) ? requested : null;
  if (req) return { period: req, periods: periods.includes(req) ? periods : [req, ...periods] };
  const now = currentPeriod();
  const period = periods.includes(now) ? now : (periods[0] ?? now);
  return { period, periods: periods.length ? periods : [now] };
}

/** For admin screens: also offer next month so targets can be prepared ahead. */
export async function adminPeriods(requested?: string | string[]) {
  const r = await resolvePeriod(requested);
  const next = addMonths(currentPeriod(), 1);
  const periods = [...new Set([next, ...r.periods])].sort().reverse();
  return { period: r.period, periods };
}
