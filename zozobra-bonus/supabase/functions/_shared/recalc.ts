// Recalculate every employee's draft payout for one branch + period.
// Paid payouts are never touched. If an approved payout's amount changes,
// the database trigger moves it back to draft and writes the audit log.

import { METRIC_BY_ID, type MetricId } from "./metrics.ts";
import {
  averageAchievement,
  realization,
  computeEmployeeBonus,
  type EmployeeBonus,
  type TargetRow,
} from "./payout.ts";
import { daysInPeriod } from "./period.ts";
import type { DataStore, EmployeeRec, PayoutUpsert } from "./store.ts";

export interface RecalcSummary {
  period: string;
  employees: number;
  total: number; // agorot
  missing: number; // employees with at least one missing metric
  skippedPaid: number;
}

export function employedInPeriod(e: EmployeeRec, period: string): boolean {
  const first = `${period}-01`;
  const last = `${period}-${String(daysInPeriod(period)).padStart(2, "0")}`;
  if (e.startDate && e.startDate > last) return false;
  if (e.endDate && e.endDate < first) return false;
  return true;
}

export async function recalcPeriod(store: DataStore, branchId: string, period: string): Promise<RecalcSummary> {
  const [employees, metrics, roleMetrics, targets, results, existing] = await Promise.all([
    store.getEmployees(branchId),
    store.getMetrics(),
    store.getRoleMetrics(),
    store.getTargets(branchId, period),
    store.getResults(branchId, period),
    store.getPayouts(branchId, period),
  ]);

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const targetRows: TargetRow[] = targets
    .filter((t) => metricById.has(t.metricId))
    .map((t) => {
      const m = metricById.get(t.metricId)!;
      return {
        metricId: t.metricId,
        scope: m.scope,
        direction: m.direction,
        target: t.target,
        thresholdPct: t.thresholdPct,
        maxAmount: t.maxAmount,
        roleMaxAmount: t.roleMaxAmount,
        active: t.active,
      };
    });

  const eligibility = new Map<string, MetricId[]>();
  for (const rm of roleMetrics) {
    eligibility.set(rm.jobRole, [...(eligibility.get(rm.jobRole) ?? []), rm.metricId]);
  }

  const existingByEmp = new Map(existing.map((p) => [p.employeeId, p]));
  const upserts: PayoutUpsert[] = [];
  const keep = new Set<string>();
  let skippedPaid = 0;
  let missing = 0;

  for (const e of employees) {
    if (!e.bonusEligible || !employedInPeriod(e, period)) continue;
    const bonus = computeEmployeeBonus({
      employee: { id: e.id, jobRole: e.jobRole, startDate: e.startDate, endDate: e.endDate },
      period,
      eligible: eligibility.get(e.jobRole) ?? [],
      targets: targetRows,
      results,
    });
    if (!bonus.lines.length) continue;
    keep.add(e.id);
    if (existingByEmp.get(e.id)?.status === "paid") {
      skippedPaid++;
      continue;
    }
    if (bonus.missing.length) missing++;
    upserts.push(toUpsert(branchId, period, bonus));
  }

  const stale = existing.filter((p) => !keep.has(p.employeeId) && p.status === "draft").map((p) => p.id);
  if (upserts.length) await store.upsertPayouts(upserts);
  if (stale.length) await store.deleteDraftPayouts(stale);

  return {
    period,
    employees: upserts.length,
    total: upserts.reduce((s, u) => s + u.amount, 0),
    missing,
    skippedPaid,
  };
}

function toUpsert(branchId: string, period: string, b: EmployeeBonus): PayoutUpsert {
  return {
    branchId,
    period,
    employeeId: b.employeeId,
    amount: b.total,
    avgAchievement: averageAchievement(b.lines),
    realization: realization(b.lines, b.proration),
    missingMetrics: b.missing,
    lines: b.lines.map((l) => ({
      metric_id: l.metricId,
      name: METRIC_BY_ID[l.metricId]?.name ?? l.metricId,
      actual: l.actual,
      target: l.target,
      threshold_pct: l.thresholdPct,
      max_amount: l.maxAmount,
      achievement: l.achievement === null ? null : Math.round(l.achievement * 10000) / 10000,
      factor: Math.round(l.factor * 10000) / 10000,
      amount: l.amount,
      status: l.status,
      proration: Math.round(b.proration * 10000) / 10000,
    })),
  };
}
