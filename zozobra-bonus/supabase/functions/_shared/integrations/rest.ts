// Config-driven REST client. Any JSON API that returns rows for a period
// can be wired up from the integrations screen without code:
//
// {
//   "base_url": "https://api.vendor.example",
//   "auth": { "type": "bearer" } | { "type": "header", "name": "X-Api-Key" } | { "type": "query", "name": "key" },
//   "requests": [{
//     "path": "/reports/kpi",
//     "method": "GET",
//     "query": { "from": "{{period_start}}", "to": "{{period_end}}" },
//     "rows_path": "data.items",
//     "fields": { "employee_id": "agent.id", "employee_name": "agent.name",
//                 "metric_key": "kpi", "value": "value" },
//     "metric_key": "answer_rate"          // fixed key instead of a field
//   }]
// }

import type { NormalizedRow } from "../ingest.ts";
import { daysInPeriod } from "../period.ts";
import { AdapterNotReadyError, type AdapterContext } from "./types.ts";

export interface RestRequest {
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: unknown;
  rows_path?: string;
  fields: { employee_id?: string; employee_name?: string; metric_key?: string; value: string; period?: string };
  metric_key?: string;
}

export interface RestConfig {
  base_url?: string;
  auth?: { type: "bearer" | "header" | "query" | "none"; name?: string };
  requests?: RestRequest[];
  timeout_ms?: number;
}

export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function template(s: string, period: string): string {
  const last = String(daysInPeriod(period)).padStart(2, "0");
  return s
    .replaceAll("{{period}}", period)
    .replaceAll("{{period_start}}", `${period}-01`)
    .replaceAll("{{period_end}}", `${period}-${last}`)
    .replaceAll("{{year}}", period.slice(0, 4))
    .replaceAll("{{month}}", period.slice(5, 7));
}

function isPlaceholder(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "" || v.trim().toUpperCase().startsWith("TODO");
}

export function restReadiness(cfg: RestConfig, hasSecret: boolean): string[] {
  const p: string[] = [];
  if (isPlaceholder(cfg.base_url)) p.push("חסרה כתובת API");
  else if (!/^https:\/\//.test(cfg.base_url!)) p.push("כתובת ה־API חייבת להתחיל ב־https://");
  if (!cfg.requests?.length || cfg.requests.some((r) => isPlaceholder(r.path))) p.push("לא הוגדרו נקודות קצה");
  if ((cfg.auth?.type ?? "bearer") !== "none" && !hasSecret) p.push("חסר מפתח גישה");
  return p;
}

export async function restFetch(ctx: AdapterContext, cfg: RestConfig, period: string): Promise<NormalizedRow[]> {
  const problems = restReadiness(cfg, !!ctx.secret);
  if (problems.length) throw new AdapterNotReadyError(problems);

  const out: NormalizedRow[] = [];
  for (const req of cfg.requests!) {
    const url = new URL(template(req.path, period), cfg.base_url);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, template(v, period));
    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = cfg.auth ?? { type: "bearer" };
    if (auth.type === "bearer") headers.Authorization = `Bearer ${ctx.secret}`;
    if (auth.type === "header") headers[auth.name ?? "X-Api-Key"] = ctx.secret!;
    if (auth.type === "query") url.searchParams.set(auth.name ?? "api_key", ctx.secret!);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeout_ms ?? 30_000);
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method: req.method ?? "GET",
        headers: req.body ? { ...headers, "Content-Type": "application/json" } : headers,
        body: req.body ? template(JSON.stringify(req.body), period) : undefined,
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
    const json = await res.json();
    const rows = getPath(json, req.rows_path);
    if (!Array.isArray(rows)) throw new Error(`${url.pathname}: לא נמצאה רשימת שורות ב־${req.rows_path ?? "(root)"}`);

    const field = (r: unknown, path?: string) => (path ? getPath(r, path) : undefined);
    for (const r of rows) {
      const value = Number(field(r, req.fields.value));
      if (!Number.isFinite(value)) continue;
      const key = req.metric_key ?? String(field(r, req.fields.metric_key) ?? "");
      const p = req.fields.period ? String(field(r, req.fields.period) ?? "").slice(0, 7) : period;
      const id = field(r, req.fields.employee_id);
      const name = field(r, req.fields.employee_name);
      out.push({
        period: p || period,
        externalKey: key,
        employeeExternalId: id == null || id === "" ? null : String(id),
        employeeName: name == null || name === "" ? null : String(name),
        value,
      });
    }
  }
  return out;
}
