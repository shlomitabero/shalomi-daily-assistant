"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { guessMapping, parseCsv, type CsvMapping } from "@shared/csv.ts";
import { periodLabel } from "@shared/period.ts";
import { Badge, Card, Notice, SectionTitle, buttonClass } from "@/components/ui";
import { shekels } from "@/lib/format";
import { commitImport, previewImport, type PreviewResult } from "./actions";

type Done = Awaited<ReturnType<typeof commitImport>>;

const FIELDS: { key: keyof Omit<CsvMapping, "defaultPeriod">; label: string; required?: boolean }[] = [
  { key: "employeeId", label: "מזהה עובד (מספר עובד / מזהה במערכת / טלפון)" },
  { key: "employeeName", label: "שם עובד" },
  { key: "metric", label: "מדד", required: true },
  { key: "value", label: "ערך", required: true },
  { key: "period", label: "חודש" },
];

export function ImportWizard({ periods, defaultPeriod }: { periods: string[]; defaultPeriod: string }) {
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const headers = useMemo(() => (text ? parseCsv(text).headers : []), [text]);

  async function onFile(f: File | undefined) {
    setError(null);
    setPreview(null);
    setDone(null);
    if (!f) return;
    if (f.size > 5_000_000) return setError("הקובץ גדול מ־5MB");
    const t = await f.text();
    const parsed = parseCsv(t);
    if (!parsed.headers.length) return setError("הקובץ ריק");
    setFileName(f.name);
    setText(t);
    setMapping(guessMapping(parsed.headers, defaultPeriod));
  }

  function set<K extends keyof CsvMapping>(k: K, v: CsvMapping[K]) {
    setMapping((m) => (m ? { ...m, [k]: v } : m));
    setPreview(null);
  }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle aside={<a href="/templates/results-template.csv" download className="text-xs text-gold">הורדת תבנית</a>}>
          1. בחירת קובץ
        </SectionTitle>
        <input
          type="file"
          accept=".csv,text/csv,.txt"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="field text-sm file:me-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-ink"
        />
        <p className="mt-2 text-xs text-muted">
          עמודות נדרשות: מדד וערך. עובד מזוהה לפי מספר עובד, מזהה במערכת, טלפון או שם מלא. מדדים סניפיים — בלי עובד.
        </p>
      </Card>

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {mapping ? (
        <Card className="space-y-3">
          <SectionTitle aside={<Badge>{fileName}</Badge>}>2. מיפוי עמודות</SectionTitle>
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="label">
                {f.label} {f.required ? <span className="text-gold">*</span> : null}
              </label>
              <select className="field" value={mapping[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value || null as never)}>
                <option value="">— ללא —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>
          ))}
          <div>
            <label className="label">חודש לשורות בלי עמודת חודש</label>
            <select className="field" value={mapping.defaultPeriod} onChange={(e) => set("defaultPeriod", e.target.value)}>
              {periods.map((p) => (
                <option key={p} value={p}>{periodLabel(p)}</option>
              ))}
            </select>
          </div>
          <button
            className={buttonClass("secondary") + " w-full"}
            disabled={pending || !mapping.metric || !mapping.value}
            onClick={() =>
              start(async () => {
                setDone(null);
                setPreview(await previewImport(text, mapping));
              })
            }
          >
            {pending && !preview ? "בודק…" : "3. תצוגה מקדימה ובדיקה"}
          </button>
        </Card>
      ) : null}

      {preview ? (
        preview.error ? (
          <Notice tone="bad">{preview.error}</Notice>
        ) : (
          <Card className="space-y-3">
            <SectionTitle>בדיקת הקובץ</SectionTitle>
            <div className="flex flex-wrap gap-2">
              <Badge tone="ok">{preview.valid} תקינות</Badge>
              {preview.invalid ? <Badge tone="bad">{preview.invalid} שגויות — לא ייובאו</Badge> : null}
              {preview.unmatched ? <Badge tone="warn">{preview.unmatched} ללא שיוך עובד</Badge> : null}
            </div>
            {preview.unmatched ? (
              <p className="text-xs text-muted">שורות ללא שיוך יישמרו וימתינו במסך &quot;שיוך עובדים&quot; — לאחר השיוך הן ייקלטו אוטומטית.</p>
            ) : null}
            <div className="table-wrap -mx-4">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>שורה</th>
                    <th>עובד</th>
                    <th>מדד</th>
                    <th>ערך</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} className={r.ok ? "" : "text-bad"}>
                      <td className="num text-faint">{r.line}</td>
                      {r.ok ? (
                        <>
                          <td className={r.matched ? "" : "text-warn"}>{r.matched ? r.who : `⚠ ${r.who}`}</td>
                          <td className="max-w-36 truncate">{r.metric}</td>
                          <td className="num">{r.value}</td>
                        </>
                      ) : (
                        <td colSpan={3}>{r.error}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className={buttonClass("primary") + " w-full"}
              disabled={pending || !preview.valid}
              onClick={() =>
                start(async () => {
                  const r = await commitImport(text, mapping!);
                  setDone(r);
                  if (!("error" in r)) setPreview(null);
                })
              }
            >
              {pending ? "מייבא ומחשב…" : `4. ייבוא ${preview.valid} שורות וחישוב בונוסים`}
            </button>
          </Card>
        )
      ) : null}

      {done ? (
        "error" in done && done.error ? (
          <Notice tone="bad">{done.error}</Notice>
        ) : (
          <Notice tone="ok">
            <div className="font-medium">הייבוא הושלם</div>
            {"written" in done ? (
              <div className="mt-1 text-sm">
                נכתבו {done.written} תוצאות{done.unmatched ? ` · ${done.unmatched} ממתינות לשיוך` : ""}.
                {done.recalculated?.map((r) => (
                  <div key={r.period}>
                    {periodLabel(r.period)}: {r.employees} עובדים, סה״כ {shekels(r.total)}
                  </div>
                ))}
                <div className="mt-2 flex gap-3">
                  <Link className="underline" href="/admin/approvals">לאישור בונוסים</Link>
                  {done.unmatched ? <Link className="underline" href="/admin/mapping">לשיוך עובדים</Link> : null}
                </div>
              </div>
            ) : null}
          </Notice>
        )
      ) : null}
    </div>
  );
}
