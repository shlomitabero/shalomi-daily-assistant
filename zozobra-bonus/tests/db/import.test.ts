// Definition of done: importing the template CSV recalculates bonuses correctly.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestDatabase } from "./harness";
import { pgStore } from "./pg-store";
import { csvToRows, guessMapping, parseCsv } from "@shared/csv.ts";
import { ingestRows } from "@shared/ingest.ts";
import { recalcPeriod } from "@shared/recalc.ts";

const BRANCH = "00000000-0000-4000-8000-000000000001";
const E = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const TEMPLATE = readFileSync(path.resolve(__dirname, "../../public/templates/results-template.csv"), "utf8");

let pool: pg.Pool;
const amount = async (id: string) =>
  (await pool.query(`select amount, status, missing_metrics from bonus_payouts where employee_id=$1 and period='2027-01-01'`, [id])).rows[0];

beforeAll(async () => {
  pool = await createTestDatabase("zozobra_import_test");
});
afterAll(async () => pool?.end());

describe("template CSV import", () => {
  it("maps template columns automatically and validates every row", () => {
    const parsed = parseCsv(TEMPLATE);
    const mapping = guessMapping(parsed.headers, "2027-01");
    expect(mapping).toMatchObject({ employeeId: "employee_id", employeeName: "employee_name", metric: "metric", value: "value", period: "period" });
    const checks = csvToRows(parsed, mapping);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks).toHaveLength(14);
  });

  it("writes results, matches every person and recalculates payouts", async () => {
    const store = pgStore(pool);
    await recalcPeriod(store, BRANCH, "2027-01"); // payouts from seed data
    await pool.query(`update bonus_payouts set status='approved'`);

    const parsed = parseCsv(TEMPLATE);
    const rows = csvToRows(parsed, guessMapping(parsed.headers, "2027-01")).map((c) => c.row!);
    const res = await ingestRows(store, { branchId: BRANCH, system: "csv", integrationId: null, trigger: "csv", rows });

    expect(res).toMatchObject({ received: 14, written: 14, unmatched: 0, rejected: 0 });
    expect(res.recalculated[0].employees).toBe(11);

    // Noa (waiter): survey 4.8/4.6 → 108.7%, service 95/90 (seed) → 111.1%, upsell 74/60 → cap 120%,
    // promo 905/900 → 101.1%, revenue 1.236M/1.2M → 106%
    expect((await amount(E(3))).amount).toBe(43478 + 33333 + 30000 + 25278 + 63600);
    // Itai: survey 4.232 = exactly 92% threshold → 50%; service via Tabit id W-102; upsell 45/60 = exactly 75% threshold → 50%
    expect((await amount(E(4))).amount).toBe(20000 + 30000 + 12500 + 25278 + 63600);
    // Yossi (chef): food 28/28.4 below target → 93%; labor 30/29.6 above target (lower is better) → 102.7%; revenue
    expect((await amount(E(8))).amount).toBe(46479 + 51351 + 63600);
    // Shira (call center), matched by name: phone 81/90 → 50%, answer 96.1/95, revenue
    expect((await amount(E(12))).amount).toBe(15000 + 35811 + 63600);
    // Cooks: food + revenue
    expect((await amount(E(9))).amount).toBe(46479 + 63600);
  });

  it("missing data and partial months are visible on the payout", async () => {
    const liya = await amount(E(5)); // started 17/1, has no service score
    expect(liya.missing_metrics).toEqual(["service"]);
    const lines = (await pool.query(`select lines from bonus_payouts where employee_id=$1`, [E(5)])).rows[0].lines;
    expect(lines[0].proration).toBeCloseTo(15 / 31, 4);
  });

  it("every previously approved payout whose numbers changed is back in draft", async () => {
    const r = await pool.query(`select count(*) filter (where status='approved')::int a, count(*)::int n from bonus_payouts`);
    expect(r.rows[0].a).toBe(0);
    const audit = await pool.query(`select count(*)::int n from audit_log where action='payout_reverted_to_draft'`);
    expect(audit.rows[0].n).toBe(r.rows[0].n);
  });

  it("logs the import in the sync log", async () => {
    const r = await pool.query(`select * from sync_log order by started_at desc limit 1`);
    expect(r.rows[0]).toMatchObject({ system: "csv", trigger: "csv", status: "success", rows_written: 14 });
  });

  it("re-importing the same file changes nothing", async () => {
    const before = (await pool.query(`select employee_id, amount from bonus_payouts order by 1`)).rows;
    const parsed = parseCsv(TEMPLATE);
    const rows = csvToRows(parsed, guessMapping(parsed.headers, "2027-01")).map((c) => c.row!);
    await ingestRows(pgStore(pool), { branchId: BRANCH, system: "csv", integrationId: null, trigger: "csv", rows });
    const after = (await pool.query(`select employee_id, amount from bonus_payouts order by 1`)).rows;
    expect(after).toEqual(before);
  });

  it("parks unknown people for manual mapping and rejects unknown metrics", async () => {
    const parsed = parseCsv("period,employee_id,employee_name,metric,value\n2027-01,9999,אורח לא מוכר,survey,4.2\n2027-01,1003,,bogus,5\n");
    const checks = csvToRows(parsed, guessMapping(parsed.headers, "2027-01"));
    expect(checks[1]).toMatchObject({ ok: false });
    expect(checks[1].error).toContain("מדד לא מוכר");
    const res = await ingestRows(pgStore(pool), {
      branchId: BRANCH, system: "csv", integrationId: null, trigger: "csv",
      rows: checks.filter((c) => c.ok).map((c) => c.row!),
    });
    expect(res).toMatchObject({ written: 0, unmatched: 1 });
    const u = await pool.query(`select external_id, external_name from unmatched_rows where resolved_at is null`);
    expect(u.rows).toEqual([{ external_id: "9999", external_name: "אורח לא מוכר" }]);
  });

  it("automatic sources may only write the metrics mapped to them", async () => {
    const res = await ingestRows(pgStore(pool), {
      branchId: BRANCH, system: "pbx", integrationId: null, trigger: "cron",
      rows: [
        { period: "2027-01", externalKey: "answer_rate", value: 95 },
        { period: "2027-01", metricId: "revenue", value: 1 }, // PBX must not touch revenue
      ],
    });
    expect(res).toMatchObject({ written: 1, rejected: 1 });
    const r = await pool.query(`select value from metric_results where metric_id='revenue'`);
    expect(Number(r.rows[0].value)).toBe(1236000);
  });
});
