// Payout engine. Pure functions, no I/O — shared by the web app, the sync
// jobs and the tests so a bonus is computed the same way everywhere.
//
// Rules (approved defaults, every number is editable per metric/period):
//   achievement = actual / target          (higher = better)
//   achievement = target / actual          (lower  = better)
//   achievement <  threshold   -> 0%
//   achievement == threshold   -> 50%  of max bonus
//   threshold..target          -> linear 50% -> 100%
//   achievement >= target      -> 100% + 2 × (achievement − 100%)  (approved prototype)
//                                 e.g. 105% -> 110%, 110% and above -> 120% cap
//   missing data               -> 0, flagged "missing" so it is visible before approval
//   partial month              -> prorated by days employed
// Money is integer agorot (1 ₪ = 100).

import { daysInPeriod } from "./period.ts";
import type { Direction, JobRole, MetricId, Scope } from "./metrics.ts";

export const CAP = 1.2;
const EPS = 1e-9;

export type LineStatus = "ok" | "below_threshold" | "missing" | "invalid_target";

export function computeAchievement(
  actual: number | null | undefined,
  target: number,
  direction: Direction,
): number | null {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return null;
  if (!Number.isFinite(target) || target <= 0) return null;
  if (direction === "higher") return Math.max(0, actual) / target;
  // lower is better: zero or negative cost is the best possible result
  if (actual <= 0) return CAP;
  return target / actual;
}

/** Share of the max bonus (0..1.2) for an achievement ratio. */
export function payoutFactor(achievement: number, thresholdPct: number): number {
  const t = thresholdPct / 100;
  if (achievement + EPS >= 1) return Math.min(CAP, 1 + 2 * (achievement - 1));
  if (achievement + EPS < t || t >= 1) return 0;
  return 0.5 + (0.5 * (achievement - t)) / (1 - t);
}

export interface MetricInput {
  actual: number | null | undefined;
  target: number;
  thresholdPct: number;
  maxAmount: number; // agorot
  direction: Direction;
  proration?: number; // 0..1, default 1
}

export interface MetricPayout {
  achievement: number | null;
  factor: number;
  amount: number; // agorot
  status: LineStatus;
}

export function computeMetricPayout(i: MetricInput): MetricPayout {
  if (!Number.isFinite(i.target) || i.target <= 0) {
    return { achievement: null, factor: 0, amount: 0, status: "invalid_target" };
  }
  const achievement = computeAchievement(i.actual, i.target, i.direction);
  if (achievement === null) return { achievement: null, factor: 0, amount: 0, status: "missing" };
  const factor = payoutFactor(achievement, i.thresholdPct);
  const proration = clamp01(i.proration ?? 1);
  const amount = Math.round(Math.max(0, i.maxAmount) * factor * proration);
  return { achievement, factor, amount, status: factor === 0 ? "below_threshold" : "ok" };
}

// ---------------------------------------------------------------- employee

export interface TargetRow {
  metricId: MetricId;
  scope: Scope;
  direction: Direction;
  target: number;
  thresholdPct: number;
  maxAmount: number; // agorot, default for all roles
  roleMaxAmount?: Partial<Record<JobRole, number>>; // per-role override
  active: boolean;
}

export interface ResultRow {
  metricId: MetricId;
  employeeId: string | null; // null = branch-level result
  value: number;
}

export interface EmployeeCtx {
  id: string;
  jobRole: JobRole;
  startDate?: string | null; // YYYY-MM-DD
  endDate?: string | null;
}

export interface BonusLine extends MetricPayout {
  metricId: MetricId;
  actual: number | null;
  target: number;
  thresholdPct: number;
  maxAmount: number;
}

export interface EmployeeBonus {
  employeeId: string;
  period: string;
  proration: number;
  lines: BonusLine[];
  total: number; // agorot
  missing: MetricId[];
}

export function prorationFor(period: string, startDate?: string | null, endDate?: string | null): number {
  const days = daysInPeriod(period);
  const first = `${period}-01`;
  const last = `${period}-${String(days).padStart(2, "0")}`;
  const from = startDate && startDate > first ? startDate : first;
  const to = endDate && endDate < last ? endDate : last;
  if (from > to) return 0;
  const employed = Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1;
  return employed / days;
}

export function computeEmployeeBonus(args: {
  employee: EmployeeCtx;
  period: string;
  eligible: MetricId[];
  targets: TargetRow[];
  results: ResultRow[];
}): EmployeeBonus {
  const { employee, period, eligible, targets, results } = args;
  const proration = prorationFor(period, employee.startDate, employee.endDate);
  const lines: BonusLine[] = [];

  for (const t of targets) {
    if (!t.active || !eligible.includes(t.metricId)) continue;
    const wantEmployee = t.scope === "employee" ? employee.id : null;
    const r = results.find((x) => x.metricId === t.metricId && x.employeeId === wantEmployee);
    const maxAmount = t.roleMaxAmount?.[employee.jobRole] ?? t.maxAmount;
    const p = computeMetricPayout({
      actual: r?.value ?? null,
      target: t.target,
      thresholdPct: t.thresholdPct,
      maxAmount,
      direction: t.direction,
      proration,
    });
    lines.push({
      ...p,
      metricId: t.metricId,
      actual: r?.value ?? null,
      target: t.target,
      thresholdPct: t.thresholdPct,
      maxAmount,
    });
  }

  return {
    employeeId: employee.id,
    period,
    proration,
    lines,
    total: lines.reduce((s, l) => s + l.amount, 0),
    missing: lines.filter((l) => l.status === "missing").map((l) => l.metricId),
  };
}

/** Share of the employee's full (100%) bonus actually earned — the leaderboard ranking, as in the prototype. */
export function realization(lines: Pick<BonusLine, "amount" | "maxAmount">[], proration = 1): number | null {
  const max = lines.reduce((s, l) => s + l.maxAmount * proration, 0);
  if (!max) return null;
  return lines.reduce((s, l) => s + l.amount, 0) / max;
}

/** Average achievement (capped) across lines that have data. */
export function averageAchievement(lines: Pick<BonusLine, "achievement">[]): number | null {
  const xs = lines.map((l) => l.achievement).filter((a): a is number => a !== null);
  if (!xs.length) return null;
  return xs.reduce((s, a) => s + Math.min(a, CAP), 0) / xs.length;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function formatShekels(agorot: number): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: agorot % 100 === 0 ? 0 : 2,
  }).format(agorot / 100);
}
