// Turns normalized rows from any adapter into metric_results:
//   1. resolve the metric (direct id, or the source's own key via metric_source_map)
//   2. enforce the authoritative source for the metric
//   3. match the person (external id → payroll id → phone → exact full name)
//   4. write results, park unmatched rows for the manual-mapping screen
//   5. log the run and recalculate every touched period

import { isMetricId, type MetricId } from "./metrics.ts";
import { isPeriod } from "./period.ts";
import { recalcPeriod, type RecalcSummary } from "./recalc.ts";
import type { DataStore, EmployeeRec, ExternalIdRec, ResultUpsert, SystemId, UnmatchedInsert } from "./store.ts";

/** What every adapter returns. */
export interface NormalizedRow {
  period: string; // YYYY-MM
  metricId?: string; // our metric id, when the source already knows it
  externalKey?: string; // the source's own name for the metric
  employeeId?: string | null; // when already resolved (e.g. manual mapping)
  employeeExternalId?: string | null;
  employeeName?: string | null;
  value: number;
  note?: string | null;
}

export interface RowIssue {
  index: number;
  reason: string;
}

export interface IngestResult {
  syncId: string;
  received: number;
  written: number;
  unmatched: number;
  rejected: number;
  issues: RowIssue[];
  recalculated: RecalcSummary[];
}

// Admin-driven sources may write any metric; automatic sources only the
// metrics they are mapped to in metric_source_map.
const FREE_SOURCES: SystemId[] = ["csv", "manual"];

export function normalizeName(s: string): string {
  return s.normalize("NFKC").replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function digitsPhone(s: string): string {
  const d = s.replace(/\D/g, "");
  if (d.startsWith("0") && d.length >= 9) return `972${d.slice(1)}`;
  return d;
}

export class EmployeeMatcher {
  private byExt = new Map<string, string>();
  private byExtAny = new Map<string, string>();
  private byPayroll = new Map<string, string>();
  private byPhone = new Map<string, string>();
  private byName = new Map<string, string | null>(); // null = ambiguous

  constructor(employees: EmployeeRec[], externalIds: ExternalIdRec[], private system: SystemId) {
    for (const x of externalIds) {
      if (x.system === system) this.byExt.set(x.externalId.trim(), x.employeeId);
      this.byExtAny.set(x.externalId.trim(), x.employeeId);
    }
    for (const e of employees) {
      if (e.payrollId) this.byPayroll.set(e.payrollId.trim(), e.id);
      this.byPhone.set(e.phone, e.id);
      const full = normalizeName(`${e.firstName} ${e.lastName}`);
      this.byName.set(full, this.byName.has(full) ? null : e.id);
    }
    // previously mapped names (manual mapping screen stores them as external_name)
    for (const x of externalIds) {
      if (x.system === system && x.externalName) {
        const n = normalizeName(x.externalName);
        if (!this.byName.has(n)) this.byName.set(n, x.employeeId);
      }
    }
  }

  match(externalId?: string | null, name?: string | null): string | null {
    const id = externalId?.trim();
    if (id) {
      const hit =
        this.byExt.get(id) ??
        this.byPayroll.get(id) ??
        this.byPhone.get(digitsPhone(id)) ??
        this.byExtAny.get(id);
      if (hit) return hit;
    }
    if (name) {
      const hit = this.byName.get(normalizeName(name));
      if (hit) return hit;
    }
    return null;
  }
}

export async function ingestRows(
  store: DataStore,
  opts: {
    branchId: string;
    system: SystemId;
    integrationId: string | null;
    trigger: "cron" | "manual" | "webhook" | "csv";
    rows: NormalizedRow[];
    recalc?: boolean;
  },
): Promise<IngestResult> {
  const { branchId, system, rows } = opts;
  const syncId = await store.startSync({
    branchId,
    integrationId: opts.integrationId,
    system,
    trigger: opts.trigger,
    period: rows[0]?.period ?? null,
  });

  try {
    const [employees, externalIds, metrics, sourceMap] = await Promise.all([
      store.getEmployees(branchId),
      store.getExternalIds(branchId),
      store.getMetrics(),
      store.getSourceMap(branchId),
    ]);
    const metricById = new Map(metrics.map((m) => [m.id, m]));
    const matcher = new EmployeeMatcher(employees, externalIds, system);
    const validEmployee = new Set(employees.map((e) => e.id));
    const free = FREE_SOURCES.includes(system);
    const mapByKey = new Map(sourceMap.filter((s) => s.system === system).map((s) => [s.externalKey, s.metricId]));
    const authority = new Map(sourceMap.map((s) => [s.metricId, s.system]));

    const issues: RowIssue[] = [];
    const results = new Map<string, ResultUpsert>(); // last row wins per key
    const unmatched: UnmatchedInsert[] = [];

    rows.forEach((r, index) => {
      if (!isPeriod(r.period)) return issues.push({ index, reason: `תקופה לא תקינה: ${r.period}` });
      if (typeof r.value !== "number" || !Number.isFinite(r.value)) {
        return issues.push({ index, reason: "ערך אינו מספר" });
      }

      let metricId: MetricId | undefined;
      if (r.metricId && isMetricId(r.metricId)) metricId = r.metricId;
      else if (r.externalKey && mapByKey.has(r.externalKey)) metricId = mapByKey.get(r.externalKey);
      if (!metricId || !metricById.has(metricId)) {
        return issues.push({ index, reason: `מדד לא מוכר: ${r.metricId ?? r.externalKey ?? "—"}` });
      }
      if (!free && authority.get(metricId) !== system) {
        return issues.push({ index, reason: `המקור ${system} אינו המקור המוגדר למדד ${metricId}` });
      }

      const scope = metricById.get(metricId)!.scope;
      let employeeId: string | null = null;
      if (scope === "employee") {
        employeeId =
          r.employeeId && validEmployee.has(r.employeeId)
            ? r.employeeId
            : matcher.match(r.employeeExternalId, r.employeeName);
        if (!employeeId) {
          unmatched.push({
            branchId,
            system,
            period: r.period,
            externalId: r.employeeExternalId ?? null,
            externalName: r.employeeName ?? null,
            metricId,
            value: r.value,
          });
          return;
        }
      }

      results.set(`${r.period}|${metricId}|${employeeId ?? ""}`, {
        branchId,
        period: r.period,
        metricId,
        employeeId,
        value: r.value,
        source: system,
        integrationId: opts.integrationId,
        note: r.note ?? null,
      });
    });

    const toWrite = [...results.values()];
    if (toWrite.length) await store.upsertResults(toWrite);
    if (unmatched.length) await store.insertUnmatched(unmatched);

    const recalculated: RecalcSummary[] = [];
    if (opts.recalc !== false) {
      const periods = [...new Set(toWrite.map((r) => r.period))].sort();
      for (const p of periods) recalculated.push(await recalcPeriod(store, branchId, p));
    }

    const result: IngestResult = {
      syncId,
      received: rows.length,
      written: toWrite.length,
      unmatched: unmatched.length,
      rejected: issues.length,
      issues,
      recalculated,
    };
    await store.finishSync(syncId, {
      status: issues.length || unmatched.length ? (toWrite.length ? "partial" : "failed") : "success",
      rowsReceived: result.received,
      rowsWritten: result.written,
      rowsUnmatched: result.unmatched,
      rowsRejected: result.rejected,
      message: summaryMessage(result),
      details: { issues: issues.slice(0, 50) },
    });
    return result;
  } catch (e) {
    await store.finishSync(syncId, {
      status: "failed",
      rowsReceived: rows.length,
      rowsWritten: 0,
      rowsUnmatched: 0,
      rowsRejected: 0,
      message: `שגיאה: ${(e as Error).message}`,
    });
    throw e;
  }
}

function summaryMessage(r: IngestResult): string {
  const parts = [`התקבלו ${r.received}`, `נכתבו ${r.written}`];
  if (r.unmatched) parts.push(`${r.unmatched} ללא התאמת עובד`);
  if (r.rejected) parts.push(`${r.rejected} נדחו`);
  return parts.join(" · ");
}
