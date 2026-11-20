import { describe, expect, it } from "vitest";
import {
  averageAchievement,
  computeAchievement,
  computeEmployeeBonus,
  computeMetricPayout,
  payoutFactor,
  prorationFor,
  type TargetRow,
} from "./payout.ts";
import { ROLE_ELIGIBILITY } from "./metrics.ts";

const base = { target: 100, thresholdPct: 90, maxAmount: 50_000, direction: "higher" as const };

describe("payoutFactor", () => {
  it("pays nothing below threshold", () => {
    expect(payoutFactor(0.8999, 90)).toBe(0);
    expect(payoutFactor(0, 90)).toBe(0);
  });
  it("pays 50% exactly at threshold", () => {
    expect(payoutFactor(0.9, 90)).toBeCloseTo(0.5);
  });
  it("is linear between threshold and target", () => {
    expect(payoutFactor(0.95, 90)).toBeCloseTo(0.75);
  });
  it("pays 100% at target", () => {
    expect(payoutFactor(1, 90)).toBe(1);
  });
  it("pays achievement above target", () => {
    expect(payoutFactor(1.1, 90)).toBeCloseTo(1.1);
  });
  it("caps at 120%", () => {
    expect(payoutFactor(1.2, 90)).toBeCloseTo(1.2);
    expect(payoutFactor(3, 90)).toBe(1.2);
  });
  it("handles a threshold equal to target (all-or-nothing)", () => {
    expect(payoutFactor(0.99, 100)).toBe(0);
    expect(payoutFactor(1, 100)).toBe(1);
  });
  it("is not fooled by floating point at the threshold", () => {
    // 0.1 + 0.2 style error: 27/30 = 0.8999999999999999
    expect(payoutFactor(27 / 30, 90)).toBeCloseTo(0.5);
  });
});

describe("computeMetricPayout — higher is better", () => {
  it("below threshold → 0", () => {
    const p = computeMetricPayout({ ...base, actual: 85 });
    expect(p).toMatchObject({ amount: 0, status: "below_threshold" });
  });
  it("at threshold → half", () => {
    expect(computeMetricPayout({ ...base, actual: 90 }).amount).toBe(25_000);
  });
  it("at target → full", () => {
    expect(computeMetricPayout({ ...base, actual: 100 }).amount).toBe(50_000);
  });
  it("above target → up to cap", () => {
    expect(computeMetricPayout({ ...base, actual: 110 }).amount).toBe(55_000);
    expect(computeMetricPayout({ ...base, actual: 500 }).amount).toBe(60_000);
  });
});

describe("computeMetricPayout — lower is better (inverted)", () => {
  const food = { target: 28, thresholdPct: 90, maxAmount: 40_000, direction: "lower" as const };
  it("on target → full", () => {
    expect(computeMetricPayout({ ...food, actual: 28 }).amount).toBe(40_000);
  });
  it("better than target → more, capped", () => {
    // 28/25 = 1.12
    expect(computeMetricPayout({ ...food, actual: 25 }).amount).toBe(44_800);
    expect(computeMetricPayout({ ...food, actual: 10 }).amount).toBe(48_000);
  });
  it("worse than target but within threshold → partial", () => {
    // 28/30 = 0.9333 → 0.5 + 0.5*(0.0333/0.1) = 0.6667
    expect(computeMetricPayout({ ...food, actual: 30 }).amount).toBe(26_667);
  });
  it("much worse → 0", () => {
    expect(computeMetricPayout({ ...food, actual: 35 }).amount).toBe(0);
  });
  it("zero cost counts as best possible", () => {
    expect(computeAchievement(0, 28, "lower")).toBe(1.2);
  });
});

describe("missing / invalid data", () => {
  it("missing actual → 0 and flagged", () => {
    for (const actual of [null, undefined, Number.NaN]) {
      expect(computeMetricPayout({ ...base, actual })).toMatchObject({ amount: 0, status: "missing", achievement: null });
    }
  });
  it("zero or negative target → 0, flagged invalid", () => {
    expect(computeMetricPayout({ ...base, target: 0, actual: 50 }).status).toBe("invalid_target");
    expect(computeMetricPayout({ ...base, target: -5, actual: 50 }).status).toBe("invalid_target");
  });
  it("negative actual on a higher-better metric pays nothing", () => {
    expect(computeMetricPayout({ ...base, actual: -10 }).amount).toBe(0);
  });
});

describe("proration", () => {
  it("full month", () => expect(prorationFor("2027-01")).toBe(1));
  it("started mid-month", () => expect(prorationFor("2027-01", "2027-01-17")).toBeCloseTo(15 / 31));
  it("left mid-month", () => expect(prorationFor("2027-02", null, "2027-02-14")).toBeCloseTo(0.5));
  it("not employed in period", () => expect(prorationFor("2027-01", "2027-03-01")).toBe(0));
});

describe("computeEmployeeBonus", () => {
  const targets: TargetRow[] = [
    { metricId: "survey", scope: "employee", direction: "higher", target: 4.6, thresholdPct: 90, maxAmount: 30_000, active: true },
    { metricId: "upsell", scope: "employee", direction: "higher", target: 120, thresholdPct: 90, maxAmount: 30_000, active: true },
    { metricId: "food", scope: "branch", direction: "lower", target: 28, thresholdPct: 90, maxAmount: 40_000, roleMaxAmount: { chef: 80_000 }, active: true },
    { metricId: "revenue", scope: "branch", direction: "higher", target: 1_200_000, thresholdPct: 90, maxAmount: 50_000, active: true },
    { metricId: "promo", scope: "branch", direction: "higher", target: 150, thresholdPct: 90, maxAmount: 20_000, active: false },
  ];

  it("uses only eligible, active metrics and branch results", () => {
    const b = computeEmployeeBonus({
      employee: { id: "w1", jobRole: "waiter" },
      period: "2027-01",
      eligible: ROLE_ELIGIBILITY.waiter,
      targets,
      results: [
        { metricId: "survey", employeeId: "w1", value: 4.6 },
        { metricId: "survey", employeeId: "w2", value: 1 },
        { metricId: "upsell", employeeId: "w1", value: 132 },
        { metricId: "revenue", employeeId: null, value: 1_200_000 },
        { metricId: "food", employeeId: null, value: 28 },
      ],
    });
    expect(b.lines.map((l) => l.metricId)).toEqual(["survey", "upsell", "revenue"]);
    expect(b.total).toBe(30_000 + 33_000 + 50_000);
    expect(b.missing).toEqual([]);
  });

  it("applies role override amounts", () => {
    const b = computeEmployeeBonus({
      employee: { id: "c1", jobRole: "chef" },
      period: "2027-01",
      eligible: ROLE_ELIGIBILITY.chef,
      targets,
      results: [{ metricId: "food", employeeId: null, value: 28 }],
    });
    expect(b.lines.find((l) => l.metricId === "food")!.amount).toBe(80_000);
    expect(b.missing).toEqual(["revenue"]);
  });

  it("does not use another employee's result", () => {
    const b = computeEmployeeBonus({
      employee: { id: "w1", jobRole: "waiter" },
      period: "2027-01",
      eligible: ["survey"],
      targets,
      results: [{ metricId: "survey", employeeId: "w2", value: 5 }],
    });
    expect(b.lines[0].status).toBe("missing");
    expect(b.total).toBe(0);
  });

  it("prorates every line for a mid-month starter", () => {
    const b = computeEmployeeBonus({
      employee: { id: "w1", jobRole: "waiter", startDate: "2027-01-17" },
      period: "2027-01",
      eligible: ["revenue"],
      targets,
      results: [{ metricId: "revenue", employeeId: null, value: 1_200_000 }],
    });
    expect(b.total).toBe(Math.round((50_000 * 15) / 31));
  });

  it("averageAchievement ignores missing lines and caps", () => {
    expect(averageAchievement([{ achievement: 1 }, { achievement: null }, { achievement: 2 }])).toBeCloseTo(1.1);
    expect(averageAchievement([{ achievement: null }])).toBeNull();
  });
});
