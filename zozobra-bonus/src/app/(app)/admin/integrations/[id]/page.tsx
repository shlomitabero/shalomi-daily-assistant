import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { RotateSecret } from "@/components/RotateSecret";
import { Badge, Card, LinkButton, Notice, PageHeader, SectionTitle, StatusBadge } from "@/components/ui";
import { FREQ_LABEL, dateTime } from "@/lib/format";
import { adapterFor } from "@shared/integrations/registry.ts";
import { currentPeriod, periodLabel, addMonths } from "@shared/period.ts";
import { rotateWebhookSecret, runNow, saveIntegration, setSecret, uploadReport } from "../actions";

export default async function IntegrationDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const sb = await createClient();
  const { data: i } = await sb.from("integrations").select("*").eq("id", id).maybeSingle();
  if (!i) notFound();
  const adapter = adapterFor(i.system);
  const [{ data: metrics }, { data: map }, { data: log }] = await Promise.all([
    sb.from("metrics").select("id, name").order("sort_order"),
    sb.from("metric_source_map").select("metric_id, system, external_key"),
    sb.from("sync_log").select("*").eq("integration_id", id).order("started_at", { ascending: false }).limit(10),
  ]);
  const hasSecret = !!i.secret_id;
  const problems = adapter?.readiness(i.config ?? {}, hasSecret) ?? [];
  const mapBy = new Map((map ?? []).map((m) => [m.metric_id, m]));
  const cp = currentPeriod();
  const webhookUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/zozobra/webhook?integration=${i.id}`;

  return (
    <>
      <PageHeader
        title={i.display_name}
        subtitle={<StatusBadge status={i.status} />}
        actions={<LinkButton href="/admin/integrations" variant="ghost" size="sm">→ חזרה</LinkButton>}
      />
      <Flash ok={sp.ok} err={sp.err} />

      <div className="space-y-4">
        {i.system === "tabit" ? (
          <Notice tone="gold">
            ל־Tabit אין API ציבורי — הגישה ניתנת דרך תוכנית השותפים שלהם. עד שיתקבלו פרטי הגישה, העלו את דוח המלצרים
            החודשי מ־Tabit כאן למטה. כשיגיעו המסמכים: בוחרים &quot;API שותפים&quot;, ממלאים כתובת ונקודות קצה, ושומרים
            מפתח — בלי שינוי קוד.
          </Notice>
        ) : null}
        {problems.length && i.system !== "webhook" ? (
          <Notice>נדרש להשלמת החיבור: {problems.join(" · ")}</Notice>
        ) : null}

        {adapter?.capabilities.report ? (
          <Card>
            <SectionTitle>העלאת דוח מהמערכת</SectionTitle>
            <form action={uploadReport} className="space-y-3">
              <input type="hidden" name="id" value={i.id} />
              <div className="grid grid-cols-2 gap-2">
                <select name="period" defaultValue={cp} className="field">
                  {[addMonths(cp, 1), cp, addMonths(cp, -1), addMonths(cp, -2)].map((p) => (
                    <option key={p} value={p}>{periodLabel(p)}</option>
                  ))}
                </select>
                <input type="file" name="file" accept=".csv,text/csv" className="field text-xs file:me-2 file:rounded-lg file:border-0 file:bg-surface-3 file:px-2 file:py-1 file:text-ink" required />
              </div>
              <SubmitButton variant="secondary" pendingText="קולט…">קליטת הדוח</SubmitButton>
            </form>
          </Card>
        ) : null}

        {adapter?.capabilities.webhook ? (
          <Card className="space-y-3">
            <SectionTitle>כתובת Webhook</SectionTitle>
            <code dir="ltr" className="block rounded-lg bg-surface-2 p-2.5 text-[0.7rem] break-all select-all">{webhookUrl}</code>
            <p className="text-xs text-muted">
              כל בקשה חתומה ב־HMAC-SHA256 עם מפתח החתימה (כותרות X-Zozobra-Timestamp ו־X-Zozobra-Signature). בקשות לא
              חתומות, ישנות מ־5 דקות או כפולות נדחות. פירוט במסמך docs/integrations.md.
            </p>
            <RotateSecret id={i.id} action={rotateWebhookSecret} hasSecret={hasSecret} />
          </Card>
        ) : null}

        <form action={saveIntegration} className="space-y-4">
          <input type="hidden" name="id" value={i.id} />
          <Card className="space-y-3">
            <SectionTitle>הגדרות</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">סטטוס</label>
                <select name="status" defaultValue={i.status} className="field">
                  <option value="active">פעיל</option>
                  <option value="paused">מושהה</option>
                  <option value="awaiting_credentials">ממתין לפרטי גישה</option>
                  <option value="not_configured">לא מוגדר</option>
                </select>
              </div>
              <div>
                <label className="label">תדירות סנכרון</label>
                <select name="frequency" defaultValue={i.frequency} className="field" disabled={!adapter?.capabilities.pull}>
                  {Object.entries(FREQ_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>
            {(adapter?.configFields ?? []).map((f) => {
              const v = (i.config ?? {})[f.key];
              return (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  {f.type === "select" ? (
                    <select name={`cfg:${f.key}`} defaultValue={String(v ?? f.options?.[0]?.value ?? "")} className="field">
                      {f.options!.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.type === "json" ? (
                    <textarea
                      name={`cfg:${f.key}`}
                      dir="ltr"
                      rows={4}
                      defaultValue={v === undefined ? "" : JSON.stringify(v, null, 2)}
                      placeholder={f.placeholder}
                      className="field font-mono text-xs"
                    />
                  ) : (
                    <input name={`cfg:${f.key}`} dir="ltr" defaultValue={v === undefined ? "" : String(v)} placeholder={f.placeholder} className="field text-end" />
                  )}
                  {f.help ? <p className="mt-1 text-[0.7rem] text-faint">{f.help}</p> : null}
                </div>
              );
            })}
          </Card>

          {i.system !== "webhook" || i.config?.act_as === "webhook" || !i.config?.act_as ? (
            <Card>
              <SectionTitle>אילו מדדים מגיעים ממקור זה</SectionTitle>
              <p className="mb-3 text-xs text-muted">
                שם השדה במערכת המקור לכל מדד. לכל מדד יש מקור מוסמך אחד — מקור אחר לא יוכל לדרוס אותו.
              </p>
              <div className="space-y-2">
                {(metrics ?? []).map((m) => {
                  const cur = mapBy.get(m.id);
                  const mine = cur?.system === i.system;
                  return (
                    <div key={m.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm">{m.name}</span>
                      {cur && !mine ? (
                        <Badge>מ־{cur.system}</Badge>
                      ) : (
                        <input
                          name={`map:${m.id}`}
                          dir="ltr"
                          defaultValue={mine ? cur!.external_key : ""}
                          placeholder={adapter?.defaultKeys[m.id] ?? "—"}
                          className="field !min-h-9 !w-40 !py-1 text-xs"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}
          <SubmitButton className="w-full">שמירת הגדרות</SubmitButton>
        </form>

        {adapter?.needsSecret && i.system !== "webhook" ? (
          <Card>
            <SectionTitle aside={hasSecret ? <Badge tone="ok">שמור ✓</Badge> : <Badge>לא הוגדר</Badge>}>מפתח גישה (API key)</SectionTitle>
            <form action={setSecret} className="flex gap-2">
              <input type="hidden" name="id" value={i.id} />
              <input name="secret" type="password" autoComplete="off" dir="ltr" placeholder={hasSecret ? "••••••••  (החלפה)" : "הדביקו את המפתח"} className="field flex-1" />
              <SubmitButton variant="secondary">שמירה</SubmitButton>
            </form>
            <p className="mt-2 text-[0.7rem] text-faint">המפתח נשמר בכספת המוצפנת של Supabase ולא ניתן לצפות בו שוב. הוא לא נשלח לדפדפן.</p>
          </Card>
        ) : null}

        {adapter?.capabilities.pull ? (
          <form action={runNow}>
            <input type="hidden" name="id" value={i.id} />
            <input type="hidden" name="period" value={cp} />
            <SubmitButton variant="secondary" className="w-full" pendingText="מסנכרן…">סנכרון עכשיו ({periodLabel(cp)})</SubmitButton>
          </form>
        ) : null}

        <Card>
          <SectionTitle>הרצות אחרונות</SectionTitle>
          {!log?.length ? (
            <p className="text-sm text-muted">עדיין לא היו הרצות.</p>
          ) : (
            <ul className="divide-y divide-line">
              {log.map((l) => (
                <li key={l.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-xs text-muted">{dateTime(l.started_at)}</span>
                    <StatusBadge status={l.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{l.message}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
