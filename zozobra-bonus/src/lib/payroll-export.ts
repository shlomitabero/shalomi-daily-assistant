import "server-only";
import ExcelJS from "exceljs";
import { ROLE_LABELS, type JobRole } from "@shared/metrics.ts";
import { payday, periodLabel } from "@shared/period.ts";

export interface ExportRow {
  payroll_id: string | null;
  first_name: string;
  last_name: string;
  phone: string;
  job_role: JobRole;
  tip_based: boolean;
  amount: number; // agorot
  status: string;
}

export const EXPORT_HEADERS = [
  "מספר עובד",
  "שם פרטי",
  "שם משפחה",
  "תפקיד",
  "סוג שכר",
  "סמל רכיב",
  "תיאור רכיב",
  "סכום (₪)",
  "חודש עבודה",
  "תאריך תשלום",
  "סטטוס",
];

function toCells(r: ExportRow, period: string, componentCode: string): (string | number)[] {
  return [
    r.payroll_id ?? "",
    r.first_name,
    r.last_name,
    ROLE_LABELS[r.job_role],
    r.tip_based ? "טיפים + השלמה לשכר מינימום" : "שכר רגיל",
    componentCode,
    `בונוס יעדים ${periodLabel(period)}`,
    Number((r.amount / 100).toFixed(2)),
    period,
    payday(period),
    r.status === "paid" ? "שולם" : "מאושר",
  ];
}

function csvCell(v: string | number): string {
  const s = String(v);
  // neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: ExportRow[], period: string, componentCode: string): string {
  const lines = [EXPORT_HEADERS, ...rows.map((r) => toCells(r, period, componentCode))].map((l) => l.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`; // BOM so Excel opens Hebrew correctly
}

export async function toXlsx(rows: ExportRow[], period: string, componentCode: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ZOZOBRA";
  const ws = wb.addWorksheet(`בונוסים ${period}`, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.addRow(EXPORT_HEADERS);
  for (const r of rows) ws.addRow(toCells(r, period, componentCode));
  const total = rows.reduce((s, r) => s + r.amount, 0) / 100;
  const totalRow = ws.addRow(["", "", "", "", "", "", "סה״כ", total]);
  totalRow.font = { bold: true };
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1915" } };
  ws.getColumn(8).numFmt = "#,##0.00 ₪";
  ws.columns.forEach((c, i) => (c.width = [12, 12, 14, 14, 26, 10, 26, 14, 12, 14, 10][i] ?? 12));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
