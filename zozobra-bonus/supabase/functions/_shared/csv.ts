// CSV import: parsing, column mapping and row validation. Dependency-free
// so it runs in the browser (preview), on the server and in edge functions.

import { METRICS, type MetricId } from "./metrics.ts";
import type { NormalizedRow } from "./ingest.ts";

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

/** RFC 4180 parser with BOM stripping and delimiter detection (, ; tab). */
export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"]
    .map((d) => [d, firstLine.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0][0];

  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    out.push(row);
  }
  const nonEmpty = out.filter((r) => r.some((f) => f.trim() !== ""));
  const [headers = [], ...rows] = nonEmpty;
  return { headers: headers.map((h) => h.trim()), rows, delimiter };
}

export interface CsvMapping {
  employeeId: string | null; // column with employee/external/payroll id or phone
  employeeName: string | null; // column with the person's name
  metric: string; // column with metric id or Hebrew name
  value: string;
  period: string | null; // column; if null, defaultPeriod is used
  defaultPeriod: string; // YYYY-MM
}

const HINTS: Record<keyof Omit<CsvMapping, "defaultPeriod">, RegExp> = {
  employeeId: /^(employee_?id|external_?id|id|מספר ?עובד|מזהה|ת\.?ז|טלפון|phone)$/i,
  employeeName: /^(employee_?name|name|שם( עובד)?|עובד)$/i,
  metric: /^(metric|kpi|מדד)$/i,
  value: /^(value|actual|ערך|תוצאה|ביצוע)$/i,
  period: /^(period|month|תקופה|חודש)$/i,
};

export function guessMapping(headers: string[], defaultPeriod: string): CsvMapping {
  const find = (re: RegExp) => headers.find((h) => re.test(h.trim())) ?? null;
  return {
    employeeId: find(HINTS.employeeId),
    employeeName: find(HINTS.employeeName),
    metric: find(HINTS.metric) ?? "",
    value: find(HINTS.value) ?? "",
    period: find(HINTS.period),
    defaultPeriod,
  };
}

const METRIC_ALIASES: Map<string, MetricId> = new Map(
  METRICS.flatMap((m) => [
    [m.id.toLowerCase(), m.id] as const,
    [m.name.replace(/\s+/g, " ").trim(), m.id] as const,
  ]),
);

export function resolveMetric(raw: string): MetricId | null {
  const k = raw.replace(/\s+/g, " ").trim();
  return METRIC_ALIASES.get(k) ?? METRIC_ALIASES.get(k.toLowerCase()) ?? null;
}

/** "1,234.5", "92%", "₪ 1,200,000", "(5)" → number */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/[₪%\s‏‎]/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  // 1.234,5 (European) → 1234.5 ; 1,234.5 → 1234.5 ; 4,6 → 4.6
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** "2027-01", "2027-01-31", "01/2027", "1/2027" → "2027-01" */
export function parsePeriod(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return fmt(m[1], m[2]);
  m = s.match(/^(\d{1,2})[/.](\d{4})$/);
  if (m) return fmt(m[2], m[1]);
  m = s.match(/^\d{1,2}[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return fmt(m[2], m[1]);
  return null;
}

function fmt(y: string, mo: string): string | null {
  const n = Number(mo);
  return n >= 1 && n <= 12 ? `${y}-${String(n).padStart(2, "0")}` : null;
}

export interface CsvRowCheck {
  line: number; // 1-based line in the file (header = 1)
  ok: boolean;
  error?: string;
  row?: NormalizedRow;
  raw: Record<string, string>;
}

export function csvToRows(parsed: ParsedCsv, mapping: CsvMapping): CsvRowCheck[] {
  const idx = (col: string | null) => (col ? parsed.headers.indexOf(col) : -1);
  const iId = idx(mapping.employeeId);
  const iName = idx(mapping.employeeName);
  const iMetric = idx(mapping.metric);
  const iValue = idx(mapping.value);
  const iPeriod = idx(mapping.period);

  return parsed.rows.map((cells, i) => {
    const raw = Object.fromEntries(parsed.headers.map((h, j) => [h, cells[j] ?? ""]));
    const line = i + 2;
    const fail = (error: string): CsvRowCheck => ({ line, ok: false, error, raw });
    if (iMetric < 0 || iValue < 0) return fail("יש למפות עמודת מדד ועמודת ערך");

    const metricId = resolveMetric(cells[iMetric] ?? "");
    if (!metricId) return fail(`מדד לא מוכר: "${cells[iMetric] ?? ""}"`);
    const value = parseNumber(cells[iValue] ?? "");
    if (value === null) return fail(`ערך לא תקין: "${cells[iValue] ?? ""}"`);
    const period = iPeriod >= 0 && cells[iPeriod]?.trim() ? parsePeriod(cells[iPeriod]) : mapping.defaultPeriod;
    if (!period) return fail(`תקופה לא תקינה: "${cells[iPeriod]}"`);

    const employeeExternalId = iId >= 0 ? cells[iId]?.trim() || null : null;
    const employeeName = iName >= 0 ? cells[iName]?.trim() || null : null;
    return {
      line,
      ok: true,
      raw,
      row: { period, metricId, value, employeeExternalId, employeeName },
    };
  });
}

export const TEMPLATE_HEADERS = ["period", "employee_id", "employee_name", "metric", "value"];
