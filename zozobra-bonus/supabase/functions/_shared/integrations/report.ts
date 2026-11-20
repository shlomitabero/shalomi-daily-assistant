// Generic "report export" importer: a CSV exported from a vendor system
// (e.g. Tabit's per-waiter sales report) where each row is a person and each
// metric is a column. Column names come from the integration's config, so a
// new report layout needs a config change, not code.
//
// config.report = {
//   "employee_id_column": "Waiter ID",
//   "employee_name_column": "Waiter",
//   "period_column": null,                       // optional
//   "columns": { "upsell_qty": "Upsell Items", "net_sales": "Net Sales" },
//   "branch_totals": ["net_sales"],              // summed into a branch-level row
//   "skip_rows_matching": "^(Total|סה\"כ)"       // ignore summary lines
// }

import { parseCsv, parseNumber, parsePeriod } from "../csv.ts";
import type { NormalizedRow } from "../ingest.ts";

export interface ReportConfig {
  employee_id_column?: string | null;
  employee_name_column?: string | null;
  period_column?: string | null;
  columns: Record<string, string>;
  branch_totals?: string[];
  skip_rows_matching?: string | null;
}

export function reportReadiness(cfg: Partial<ReportConfig> | undefined): string[] {
  const p: string[] = [];
  if (!cfg?.columns || !Object.keys(cfg.columns).length) p.push("לא הוגדרו עמודות הדוח");
  if (cfg && !cfg.employee_id_column && !cfg.employee_name_column && (cfg.branch_totals?.length ?? 0) === 0) {
    p.push("יש להגדיר עמודת עובד או סיכומי סניף");
  }
  return p;
}

export function parseReport(text: string, period: string, cfg: ReportConfig): NormalizedRow[] {
  const { headers, rows } = parseCsv(text);
  const col = (name?: string | null) => (name ? headers.findIndex((h) => h.trim() === name.trim()) : -1);
  const iId = col(cfg.employee_id_column);
  const iName = col(cfg.employee_name_column);
  const iPeriod = col(cfg.period_column);
  const missing = Object.values(cfg.columns).filter((c) => col(c) < 0);
  if (missing.length) throw new Error(`עמודות חסרות בדוח: ${missing.join(", ")}`);
  const skip = cfg.skip_rows_matching ? new RegExp(cfg.skip_rows_matching) : null;
  const totals = new Set(cfg.branch_totals ?? []);
  const sums = new Map<string, Map<string, number>>(); // period → key → sum

  const out: NormalizedRow[] = [];
  for (const cells of rows) {
    const first = cells.find((c) => c.trim() !== "") ?? "";
    if (skip && skip.test(first.trim())) continue;
    const p = iPeriod >= 0 ? parsePeriod(cells[iPeriod] ?? "") ?? period : period;
    const id = iId >= 0 ? cells[iId]?.trim() || null : null;
    const name = iName >= 0 ? cells[iName]?.trim() || null : null;
    for (const [key, column] of Object.entries(cfg.columns)) {
      const v = parseNumber(cells[col(column)] ?? "");
      if (v === null) continue;
      if (totals.has(key)) {
        const m = sums.get(p) ?? new Map();
        m.set(key, (m.get(key) ?? 0) + v);
        sums.set(p, m);
      } else if (id || name) {
        out.push({ period: p, externalKey: key, employeeExternalId: id, employeeName: name, value: v });
      }
    }
  }
  for (const [p, m] of sums) for (const [key, value] of m) out.push({ period: p, externalKey: key, value });
  return out;
}
