// DataStore backed by Supabase (PostgREST). Used with the service-role
// client on the server and in edge functions — never in the browser.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRole, MetricId } from "./metrics.ts";
import { dateToPeriod, periodToDate } from "./period.ts";
import type { DataStore, SystemId, TargetRec } from "./store.ts";

// deno-lint-ignore no-explicit-any
type Client = SupabaseClient<any, any, any>;

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

const CHUNK = 500;
function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

export function supabaseStore(db: Client): DataStore {
  return {
    async getEmployees(branchId) {
      const rows = must(
        await db.from("employees").select("*").eq("branch_id", branchId).eq("active", true),
        "employees",
      ) as Record<string, any>[];
      return rows.map((e) => ({
        id: e.id,
        branchId: e.branch_id,
        firstName: e.first_name,
        lastName: e.last_name,
        phone: e.phone,
        jobRole: e.job_role,
        payrollId: e.payroll_id,
        tipBased: e.tip_based,
        bonusEligible: e.bonus_eligible,
        startDate: e.start_date,
        endDate: e.end_date,
        active: e.active,
      }));
    },

    async getExternalIds(branchId) {
      const rows = must(
        await db
          .from("employee_external_ids")
          .select("employee_id, system, external_id, external_name, employees!inner(branch_id)")
          .eq("employees.branch_id", branchId),
        "external ids",
      ) as Record<string, any>[];
      return rows.map((x) => ({
        employeeId: x.employee_id,
        system: x.system,
        externalId: x.external_id,
        externalName: x.external_name,
      }));
    },

    async getMetrics() {
      const rows = must(await db.from("metrics").select("*").order("sort_order"), "metrics") as Record<string, any>[];
      return rows.map((m) => ({ id: m.id, name: m.name, scope: m.scope, direction: m.direction, unit: m.unit }));
    },

    async getRoleMetrics() {
      const rows = must(await db.from("role_metrics").select("job_role, metric_id"), "role metrics") as Record<
        string,
        any
      >[];
      return rows.map((r) => ({ jobRole: r.job_role as JobRole, metricId: r.metric_id as MetricId }));
    },

    async getTargets(branchId, period) {
      const rows = must(
        await db
          .from("metric_targets")
          .select("*, metric_target_role_amounts(job_role, max_amount)")
          .eq("branch_id", branchId)
          .eq("period", periodToDate(period)),
        "targets",
      ) as Record<string, any>[];
      return rows.map(
        (t): TargetRec => ({
          id: t.id,
          metricId: t.metric_id,
          target: Number(t.target),
          thresholdPct: Number(t.threshold_pct),
          maxAmount: t.max_amount,
          active: t.active,
          roleMaxAmount: Object.fromEntries(
            (t.metric_target_role_amounts ?? []).map((r: any) => [r.job_role, r.max_amount]),
          ),
        }),
      );
    },

    async getResults(branchId, period) {
      const rows = must(
        await db
          .from("metric_results")
          .select("metric_id, employee_id, value")
          .eq("branch_id", branchId)
          .eq("period", periodToDate(period)),
        "results",
      ) as Record<string, any>[];
      return rows.map((r) => ({ metricId: r.metric_id, employeeId: r.employee_id, value: Number(r.value) }));
    },

    async getPayouts(branchId, period) {
      const rows = must(
        await db
          .from("bonus_payouts")
          .select("id, employee_id, amount, status")
          .eq("branch_id", branchId)
          .eq("period", periodToDate(period)),
        "payouts",
      ) as Record<string, any>[];
      return rows.map((p) => ({ id: p.id, employeeId: p.employee_id, amount: p.amount, status: p.status }));
    },

    async getSourceMap(branchId) {
      const rows = must(
        await db.from("metric_source_map").select("metric_id, system, external_key").eq("branch_id", branchId),
        "source map",
      ) as Record<string, any>[];
      return rows.map((s) => ({ metricId: s.metric_id, system: s.system as SystemId, externalKey: s.external_key }));
    },

    async upsertResults(rows) {
      for (const c of chunks(rows)) {
        must(
          await db.from("metric_results").upsert(
            c.map((r) => ({
              branch_id: r.branchId,
              period: periodToDate(r.period),
              metric_id: r.metricId,
              employee_id: r.employeeId,
              value: r.value,
              source: r.source,
              integration_id: r.integrationId,
              note: r.note ?? null,
              synced_at: new Date().toISOString(),
            })),
            { onConflict: "branch_id,period,metric_id,employee_id" },
          ),
          "upsert results",
        );
      }
    },

    async insertUnmatched(rows) {
      for (const c of chunks(rows)) {
        must(
          await db.from("unmatched_rows").insert(
            c.map((r) => ({
              branch_id: r.branchId,
              system: r.system,
              period: periodToDate(r.period),
              external_id: r.externalId,
              external_name: r.externalName,
              metric_id: r.metricId,
              value: r.value,
            })),
          ),
          "insert unmatched",
        );
      }
    },

    async upsertPayouts(rows) {
      for (const c of chunks(rows)) {
        must(
          await db.from("bonus_payouts").upsert(
            c.map((p) => ({
              branch_id: p.branchId,
              period: periodToDate(p.period),
              employee_id: p.employeeId,
              amount: p.amount,
              lines: p.lines,
              avg_achievement: p.avgAchievement,
              missing_metrics: p.missingMetrics,
              calculated_at: new Date().toISOString(),
            })),
            { onConflict: "period,employee_id" },
          ),
          "upsert payouts",
        );
      }
    },

    async deleteDraftPayouts(ids) {
      must(await db.from("bonus_payouts").delete().in("id", ids).eq("status", "draft"), "delete payouts");
    },

    async startSync(s) {
      const r = must(
        await db
          .from("sync_log")
          .insert({
            branch_id: s.branchId,
            integration_id: s.integrationId,
            system: s.system,
            trigger: s.trigger,
            period: s.period ? periodToDate(s.period) : null,
          })
          .select("id")
          .single(),
        "sync start",
      ) as { id: string };
      return r.id;
    },

    async finishSync(id, f) {
      must(
        await db
          .from("sync_log")
          .update({
            status: f.status,
            finished_at: new Date().toISOString(),
            rows_received: f.rowsReceived,
            rows_written: f.rowsWritten,
            rows_unmatched: f.rowsUnmatched,
            rows_rejected: f.rowsRejected,
            message: f.message,
            details: f.details ?? null,
          })
          .eq("id", id),
        "sync finish",
      );
      const log = must(
        await db.from("sync_log").select("integration_id").eq("id", id).single(),
        "sync read",
      ) as { integration_id: string | null };
      if (log.integration_id) {
        await db
          .from("integrations")
          .update({ last_sync_at: new Date().toISOString(), last_status: f.status })
          .eq("id", log.integration_id);
      }
    },
  };
}

export { dateToPeriod };
