// Stub adapters for systems we do not have API access to yet. Each one is
// already usable through the config-driven REST client (once the vendor's
// endpoint and key are entered) and through report upload. No vendor
// endpoints are assumed.

import { parseReport, reportReadiness, type ReportConfig } from "./report.ts";
import { restFetch, restReadiness, type RestConfig } from "./rest.ts";
import type { MetricsAdapter } from "./types.ts";
import type { SystemId } from "../store.ts";

function configurable(system: SystemId, label: string, defaultKeys: Record<string, string>): MetricsAdapter {
  return {
    system,
    label,
    capabilities: { pull: true, report: true, webhook: false },
    defaultKeys,
    needsSecret: true,
    configFields: [
      { key: "base_url", label: "כתובת API", type: "url", placeholder: "https://…" },
      { key: "auth", label: "אימות (JSON)", type: "json", placeholder: '{"type":"bearer"}' },
      { key: "requests", label: "נקודות קצה (JSON)", type: "json", help: "ראו docs/integrations.md" },
      { key: "report", label: "מיפוי עמודות לדוח מיוצא (JSON)", type: "json" },
    ],
    readiness(config, hasSecret) {
      if (config.base_url) return restReadiness(config as RestConfig, hasSecret);
      const r = reportReadiness(config.report as ReportConfig);
      return r.length ? ["לא הוגדר API או דוח"] : [];
    },
    async fetchMetrics(ctx, period) {
      return { rows: await restFetch(ctx, ctx.config as RestConfig, period) };
    },
    parseReport(text, period, config) {
      return parseReport(text, period, config.report as ReportConfig);
    },
  };
}

export const beecommAdapter = configurable("beecomm", "Beecomm", { upsell: "upsell_qty", promo: "promo_qty", revenue: "net_sales" });
export const costAdapter = configurable("cost", "מערכת עלויות (Restigo / MarketMan)", { food: "food_cost_pct" });
export const payrollAdapter = configurable("payroll", "שכר ונוכחות (מיכפל / חילן)", { labor: "labor_cost_pct" });
export const pbxAdapter = configurable("pbx", "מרכזיה (Voicenter / 3CX)", { answer: "answer_rate", phone: "qa_score" });
export const surveyAdapter = configurable("survey", "מערכת סקרים", { survey: "csat_avg" });
