// Tabit POS adapter.
//
// Tabit has no public API; access is granted through their partner program.
// Until real documentation arrives, every endpoint below is a TODO
// placeholder in config — nothing is invented. Two ways in:
//   1. mode "csv_report" (works today): upload Tabit's per-waiter sales
//      report; columns are mapped in config.report.
//   2. mode "api": the config-driven REST client (rest.ts). Fill base_url,
//      auth and requests from Tabit's partner docs — no code change needed.

import { parseReport, reportReadiness, type ReportConfig } from "./report.ts";
import { restFetch, restReadiness, type RestConfig } from "./rest.ts";
import { AdapterNotReadyError, type MetricsAdapter } from "./types.ts";

export const TABIT_DEFAULT_CONFIG = {
  mode: "csv_report",
  // TODO(tabit-partner-docs): real base URL from Tabit partner program
  base_url: "TODO: Tabit partner API base URL",
  // TODO(tabit-partner-docs): auth scheme (bearer / header) per Tabit docs
  auth: { type: "bearer" },
  requests: [
    {
      // TODO(tabit-partner-docs): per-waiter sales endpoint, query params and response shape
      path: "TODO: per-waiter sales report endpoint",
      method: "GET",
      query: { from: "{{period_start}}", to: "{{period_end}}" },
      rows_path: "TODO",
      fields: { employee_id: "TODO", employee_name: "TODO", metric_key: "TODO", value: "TODO" },
    },
  ],
  // Column names of the exported per-waiter report — adjust to the real export.
  report: {
    employee_id_column: "מספר מלצר",
    employee_name_column: "שם מלצר",
    columns: { upsell_qty: "פריטי אפסייל", promo_qty: "פריטי מבצע", net_sales: "מכירות נטו" },
    branch_totals: ["promo_qty", "net_sales"],
    skip_rows_matching: '^(סה"כ|סה״כ|Total)',
  } satisfies ReportConfig,
};

export const tabitAdapter: MetricsAdapter = {
  system: "tabit",
  label: "Tabit — קופה",
  capabilities: { pull: true, report: true, webhook: false },
  defaultKeys: { upsell: "upsell_qty", promo: "promo_qty", revenue: "net_sales" },
  needsSecret: true,
  configFields: [
    {
      key: "mode",
      label: "שיטת חיבור",
      type: "select",
      options: [
        { value: "csv_report", label: "העלאת דוח מ־Tabit (עובד כבר עכשיו)" },
        { value: "api", label: "API שותפים (אחרי קבלת פרטי גישה)" },
      ],
    },
    { key: "site_id", label: "מזהה מסעדה ב־Tabit", type: "text", placeholder: "TODO" },
    { key: "base_url", label: "כתובת API", type: "url", help: "מתוך תיעוד השותפים של Tabit" },
    { key: "auth", label: "אימות (JSON)", type: "json" },
    { key: "requests", label: "נקודות קצה (JSON)", type: "json", help: "ראו docs/integrations.md" },
    { key: "report", label: "מיפוי עמודות הדוח (JSON)", type: "json" },
  ],
  readiness(config, hasSecret) {
    if (config.mode === "api") return restReadiness(config as RestConfig, hasSecret);
    return reportReadiness(config.report as ReportConfig);
  },
  async fetchMetrics(ctx, period) {
    if (ctx.config.mode !== "api") {
      throw new AdapterNotReadyError(["מצב דוח: יש להעלות את דוח Tabit במסך החיבור"]);
    }
    const rows = await restFetch(ctx, ctx.config as RestConfig, period);
    return { rows };
  },
  parseReport(text, period, config) {
    return parseReport(text, period, config.report as ReportConfig);
  },
};
