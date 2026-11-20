// Inbound webhook: any system can push results to
//   POST {SUPABASE_URL}/functions/v1/zozobra/webhook?integration=<id>
// Headers:
//   X-Zozobra-Timestamp: unix seconds
//   X-Zozobra-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
// Body:
//   { "period": "2027-01", "rows": [ { "metric": "upsell" | "<source key>",
//       "employee_id": "W-101", "employee_name": "נועה", "value": 12 } ] }

import type { NormalizedRow } from "../ingest.ts";
import { isPeriod } from "../period.ts";
import type { MetricsAdapter } from "./types.ts";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

const enc = new TextEncoder();

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signPayload(secret: string, timestamp: number, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

export async function verifySignature(args: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number; // seconds
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { secret, timestamp, signature, body } = args;
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const expected = await signPayload(secret, ts, body);
  return timingSafeEqual(expected, signature.trim()) ? { ok: true } : { ok: false, reason: "bad signature" };
}

export interface WebhookPayload {
  period: string;
  rows: { metric: string; employee_id?: string | null; employee_name?: string | null; value: number; period?: string }[];
}

export function parseWebhookPayload(json: unknown): { rows: NormalizedRow[] } | { error: string } {
  const p = json as WebhookPayload;
  if (!p || typeof p !== "object" || !Array.isArray(p.rows)) return { error: "body must be { period, rows: [] }" };
  if (p.rows.length > 5000) return { error: "too many rows (max 5000)" };
  const rows: NormalizedRow[] = [];
  for (const [i, r] of p.rows.entries()) {
    const period = r.period ?? p.period;
    if (!period || !isPeriod(period)) return { error: `row ${i}: invalid period` };
    if (typeof r.metric !== "string" || !r.metric) return { error: `row ${i}: metric is required` };
    const value = Number(r.value);
    if (!Number.isFinite(value)) return { error: `row ${i}: value must be a number` };
    rows.push({
      period,
      metricId: r.metric,
      externalKey: r.metric,
      employeeExternalId: r.employee_id ?? null,
      employeeName: r.employee_name ?? null,
      value,
    });
  }
  return { rows };
}

export const webhookAdapter: MetricsAdapter = {
  system: "webhook",
  label: "Webhook כללי",
  capabilities: { pull: false, report: false, webhook: true },
  defaultKeys: {},
  needsSecret: true,
  configFields: [
    {
      key: "act_as",
      label: "הנתונים מגיעים בשם מערכת",
      type: "select",
      help: "המערכת שבשמה הנתונים נקלטים — קובע אילו מדדים מותר לה לעדכן",
      options: [
        { value: "webhook", label: "Webhook (מדדים שמופו ל־Webhook)" },
        { value: "tabit", label: "Tabit" },
        { value: "beecomm", label: "Beecomm" },
        { value: "cost", label: "מערכת עלויות" },
        { value: "payroll", label: "שכר ונוכחות" },
        { value: "pbx", label: "מרכזיה" },
        { value: "survey", label: "מערכת סקרים" },
      ],
    },
  ],
  readiness(_config, hasSecret) {
    return hasSecret ? [] : ["יש ליצור מפתח חתימה"];
  },
  async fetchMetrics() {
    return { rows: [] }; // push-only
  },
};
