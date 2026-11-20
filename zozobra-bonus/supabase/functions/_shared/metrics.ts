// Metric catalog and role eligibility. The database holds the same data
// (seeded from here); this file is the typed source of truth for code.

export type MetricId =
  | "survey"
  | "service"
  | "food"
  | "labor"
  | "upsell"
  | "promo"
  | "revenue"
  | "answer"
  | "phone";

export type Scope = "employee" | "branch";
export type Direction = "higher" | "lower";

export type JobRole =
  | "waiter"
  | "bartender"
  | "cook"
  | "chef"
  | "shift_manager"
  | "call_center";

export interface MetricDef {
  id: MetricId;
  name: string;
  description: string;
  scope: Scope;
  direction: Direction;
  defaultSource: string;
  unit: string;
}

export const METRICS: readonly MetricDef[] = [
  { id: "survey", name: "סקרי שביעות רצון", description: "ממוצע דירוג לקוחות (1–5)", scope: "employee", direction: "higher", defaultSource: "survey", unit: "ציון" },
  { id: "service", name: "שירות", description: "ציון מנהל / לקוח סמוי (0–100)", scope: "employee", direction: "higher", defaultSource: "manual", unit: "ציון" },
  { id: "food", name: "עמידה ביעד פוד קוסט", description: "עלות מזון מתוך מחזור", scope: "branch", direction: "lower", defaultSource: "cost", unit: "%" },
  { id: "labor", name: "עמידה ביעד ליבור קוסט", description: "עלות שכר מתוך מחזור", scope: "branch", direction: "lower", defaultSource: "payroll", unit: "%" },
  { id: "upsell", name: "הגדלת מכירות על מוצר", description: "מוצר החודש: Dragon Roll · יחידות", scope: "employee", direction: "higher", defaultSource: "tabit", unit: "יח׳" },
  { id: "promo", name: "הגדלת יעדי מבצעים", description: "מימושי מבצע Happy Hour בסניף", scope: "branch", direction: "higher", defaultSource: "tabit", unit: "יח׳" },
  { id: "revenue", name: "הגעה ליעד מחזור", description: "מחזור חודשי לפני מע״מ", scope: "branch", direction: "higher", defaultSource: "tabit", unit: "₪" },
  { id: "answer", name: "מרכז שירות – אחוז מענה", description: "שיחות שנענו מתוך נכנסות", scope: "branch", direction: "higher", defaultSource: "pbx", unit: "%" },
  { id: "phone", name: "שירות בטלפון", description: "ציון בקרת איכות שיחות (0–100)", scope: "employee", direction: "higher", defaultSource: "pbx", unit: "ציון" },
] as const;

export const METRIC_BY_ID: Record<MetricId, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.id, m]),
) as Record<MetricId, MetricDef>;

export const ROLE_LABELS: Record<JobRole, string> = {
  waiter: "מלצר/ית",
  bartender: "ברמן/ית",
  cook: "טבח/ית",
  chef: "שף / סו־שף",
  shift_manager: "אחמ״ש",
  call_center: "מוקד הזמנות",
};

export const ROLE_ELIGIBILITY: Record<JobRole, MetricId[]> = {
  waiter: ["survey", "service", "upsell", "promo", "revenue"],
  bartender: ["survey", "service", "upsell", "promo", "revenue"],
  cook: ["food", "revenue"],
  chef: ["food", "labor", "revenue"],
  shift_manager: ["survey", "service", "food", "labor", "promo", "revenue"],
  call_center: ["answer", "phone", "revenue"],
};

export function isMetricId(v: string): v is MetricId {
  return v in METRIC_BY_ID;
}
