// DataStore over a raw pg connection, for tests. Mirrors store-supabase.ts
// so ingest/recalc logic is exercised against the real schema + triggers.
import type pg from "pg";
import type { DataStore } from "@shared/store.ts";
import { periodToDate } from "@shared/period.ts";

export function pgStore(pool: pg.Pool): DataStore {
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p).then((r) => r.rows);
  return {
    async getEmployees(b) {
      return (await q(`select * from employees where branch_id=$1 and active`, [b])).map((e) => ({
        id: e.id, branchId: e.branch_id, firstName: e.first_name, lastName: e.last_name, phone: e.phone,
        jobRole: e.job_role, payrollId: e.payroll_id, tipBased: e.tip_based, bonusEligible: e.bonus_eligible,
        startDate: e.start_date && iso(e.start_date), endDate: e.end_date && iso(e.end_date), active: e.active,
      }));
    },
    async getExternalIds(b) {
      return (await q(
        `select x.* from employee_external_ids x join employees e on e.id=x.employee_id where e.branch_id=$1`, [b],
      )).map((x) => ({ employeeId: x.employee_id, system: x.system, externalId: x.external_id, externalName: x.external_name }));
    },
    async getMetrics() {
      return (await q(`select * from metrics order by sort_order`)).map((m) => ({
        id: m.id, name: m.name, scope: m.scope, direction: m.direction, unit: m.unit,
      }));
    },
    async getRoleMetrics() {
      return (await q(`select * from role_metrics`)).map((r) => ({ jobRole: r.job_role, metricId: r.metric_id }));
    },
    async getTargets(b, p) {
      const rows = await q(
        `select t.*, coalesce(json_object_agg(ra.job_role, ra.max_amount) filter (where ra.job_role is not null), '{}') roles
           from metric_targets t left join metric_target_role_amounts ra on ra.target_id=t.id
          where t.branch_id=$1 and t.period=$2 group by t.id`, [b, periodToDate(p)]);
      return rows.map((t) => ({
        id: t.id, metricId: t.metric_id, target: Number(t.target), thresholdPct: Number(t.threshold_pct),
        maxAmount: t.max_amount, active: t.active, roleMaxAmount: t.roles,
      }));
    },
    async getResults(b, p) {
      return (await q(`select metric_id, employee_id, value from metric_results where branch_id=$1 and period=$2`,
        [b, periodToDate(p)])).map((r) => ({ metricId: r.metric_id, employeeId: r.employee_id, value: Number(r.value) }));
    },
    async getPayouts(b, p) {
      return (await q(`select id, employee_id, amount, status from bonus_payouts where branch_id=$1 and period=$2`,
        [b, periodToDate(p)])).map((r) => ({ id: r.id, employeeId: r.employee_id, amount: r.amount, status: r.status }));
    },
    async getSourceMap(b) {
      return (await q(`select * from metric_source_map where branch_id=$1`, [b])).map((s) => ({
        metricId: s.metric_id, system: s.system, externalKey: s.external_key,
      }));
    },
    async upsertResults(rows) {
      for (const r of rows) {
        await q(
          `insert into metric_results (branch_id, period, metric_id, employee_id, value, source, integration_id, note)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (branch_id, period, metric_id, employee_id)
           do update set value=excluded.value, source=excluded.source, integration_id=excluded.integration_id,
                         note=excluded.note, synced_at=now()`,
          [r.branchId, periodToDate(r.period), r.metricId, r.employeeId, r.value, r.source, r.integrationId, r.note ?? null]);
      }
    },
    async insertUnmatched(rows) {
      for (const r of rows) {
        await q(`insert into unmatched_rows (branch_id, system, period, external_id, external_name, metric_id, value)
                 values ($1,$2,$3,$4,$5,$6,$7)`,
          [r.branchId, r.system, periodToDate(r.period), r.externalId, r.externalName, r.metricId, r.value]);
      }
    },
    async upsertPayouts(rows) {
      for (const p of rows) {
        await q(
          `insert into bonus_payouts (branch_id, period, employee_id, amount, lines, avg_achievement, realization, missing_metrics)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (period, employee_id) do update set amount=excluded.amount, lines=excluded.lines,
             avg_achievement=excluded.avg_achievement, realization=excluded.realization,
             missing_metrics=excluded.missing_metrics, calculated_at=now()`,
          [p.branchId, periodToDate(p.period), p.employeeId, p.amount, JSON.stringify(p.lines), p.avgAchievement, p.realization, p.missingMetrics]);
      }
    },
    async deleteDraftPayouts(ids) {
      await q(`delete from bonus_payouts where id = any($1) and status='draft'`, [ids]);
    },
    async startSync(s) {
      const [r] = await q(`insert into sync_log (branch_id, integration_id, system, trigger, period)
                           values ($1,$2,$3,$4,$5) returning id`,
        [s.branchId, s.integrationId, s.system, s.trigger, s.period ? periodToDate(s.period) : null]);
      return r.id;
    },
    async finishSync(id, f) {
      await q(`update sync_log set status=$2, finished_at=now(), rows_received=$3, rows_written=$4,
               rows_unmatched=$5, rows_rejected=$6, message=$7, details=$8 where id=$1`,
        [id, f.status, f.rowsReceived, f.rowsWritten, f.rowsUnmatched, f.rowsRejected, f.message, JSON.stringify(f.details ?? null)]);
    },
  };
}

function iso(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  // pg returns DATE as local-midnight Date; format in local time
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
