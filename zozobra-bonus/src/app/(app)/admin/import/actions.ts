"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { adminStore } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { csvToRows, parseCsv, type CsvMapping } from "@shared/csv.ts";
import { EmployeeMatcher, ingestRows } from "@shared/ingest.ts";
import { METRIC_BY_ID, type MetricId } from "@shared/metrics.ts";
import { isPeriod } from "@shared/period.ts";
import type { EmployeeRec, ExternalIdRec } from "@shared/store.ts";

const MAX = 5_000_000;

export interface PreviewRow {
  line: number;
  ok: boolean;
  error?: string;
  period?: string;
  metric?: string;
  who?: string;
  matched?: boolean;
  value?: number;
}

export interface PreviewResult {
  error?: string;
  total: number;
  valid: number;
  invalid: number;
  unmatched: number;
  rows: PreviewRow[];
}

function check(text: string, mapping: CsvMapping): string | null {
  if (!text || text.length > MAX) return "קובץ ריק או גדול מ־5MB";
  if (!mapping.metric || !mapping.value) return "יש למפות עמודת מדד ועמודת ערך";
  if (!isPeriod(mapping.defaultPeriod)) return "חודש ברירת מחדל לא תקין";
  return null;
}

export async function previewImport(text: string, mapping: CsvMapping): Promise<PreviewResult> {
  const me = await requireAdmin();
  const err = check(text, mapping);
  if (err) return { error: err, total: 0, valid: 0, invalid: 0, unmatched: 0, rows: [] };

  const checks = csvToRows(parseCsv(text), mapping);
  const sb = await createClient();
  const [{ data: emps }, { data: ext }] = await Promise.all([
    sb.from("employees").select("*").eq("branch_id", me.employee.branch_id).eq("active", true),
    sb.from("employee_external_ids").select("*"),
  ]);
  const employees: EmployeeRec[] = (emps ?? []).map((e) => ({
    id: e.id, branchId: e.branch_id, firstName: e.first_name, lastName: e.last_name, phone: e.phone,
    jobRole: e.job_role, payrollId: e.payroll_id, tipBased: e.tip_based, bonusEligible: e.bonus_eligible,
    startDate: e.start_date, endDate: e.end_date, active: e.active,
  }));
  const externalIds: ExternalIdRec[] = (ext ?? []).map((x) => ({
    employeeId: x.employee_id, system: x.system, externalId: x.external_id, externalName: x.external_name,
  }));
  const matcher = new EmployeeMatcher(employees, externalIds, "csv");
  const nameOf = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

  let unmatched = 0;
  const rows: PreviewRow[] = checks.map((c) => {
    if (!c.ok || !c.row) return { line: c.line, ok: false, error: c.error };
    const def = METRIC_BY_ID[c.row.metricId as MetricId];
    if (def.scope === "branch") {
      return { line: c.line, ok: true, period: c.row.period, metric: def.name, who: "סניף", matched: true, value: c.row.value };
    }
    const id = matcher.match(c.row.employeeExternalId, c.row.employeeName);
    if (!id) unmatched++;
    return {
      line: c.line,
      ok: true,
      period: c.row.period,
      metric: def.name,
      who: id ? nameOf.get(id) : c.row.employeeName || c.row.employeeExternalId || "—",
      matched: !!id,
      value: c.row.value,
    };
  });
  const invalid = rows.filter((r) => !r.ok).length;
  return { total: rows.length, valid: rows.length - invalid, invalid, unmatched, rows: rows.slice(0, 300) };
}

export async function commitImport(text: string, mapping: CsvMapping) {
  const me = await requireAdmin();
  const err = check(text, mapping);
  if (err) return { error: err };
  const rows = csvToRows(parseCsv(text), mapping).filter((c) => c.ok && c.row).map((c) => c.row!);
  if (!rows.length) return { error: "אין שורות תקינות לייבוא" };
  const r = await ingestRows(adminStore(), {
    branchId: me.employee.branch_id,
    system: "csv",
    integrationId: null,
    trigger: "csv",
    rows,
  });
  revalidatePath("/admin", "layout");
  return {
    written: r.written,
    unmatched: r.unmatched,
    rejected: r.rejected,
    recalculated: r.recalculated.map((x) => ({ period: x.period, employees: x.employees, total: x.total })),
  };
}
