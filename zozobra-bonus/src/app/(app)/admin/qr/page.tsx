import { headers } from "next/headers";
import QRCode from "qrcode";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Notice } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { currentPeriod, periodToDate } from "@shared/period.ts";
import { ROLE_LABELS, type JobRole } from "@shared/metrics.ts";

export const metadata = { title: "קודי QR לסקר" };

export default async function QrPage() {
  await requireAdmin();
  const sb = await createClient();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const [{ data: roles }, { data: emps }, { data: resp }] = await Promise.all([
    sb.from("role_metrics").select("job_role").in("metric_id", ["survey", "service"]),
    sb.from("employees").select("id, first_name, last_name, job_role, survey_code, bonus_eligible").eq("active", true).order("first_name"),
    sb.from("survey_responses").select("employee_id").eq("period", periodToDate(currentPeriod())),
  ]);
  const eligible = new Set((roles ?? []).map((r) => r.job_role));
  const people = (emps ?? []).filter((e) => e.bonus_eligible && eligible.has(e.job_role) && e.survey_code);
  const count = new Map<string, number>();
  for (const r of resp ?? []) count.set(r.employee_id, (count.get(r.employee_id) ?? 0) + 1);

  const cards = await Promise.all(
    people.map(async (e) => {
      const url = `${origin}/s/${e.survey_code}`;
      const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } });
      return { ...e, url, svg };
    }),
  );

  return (
    <>
      <PageHeader title="קודי QR לסקר לקוחות" subtitle="קוד אישי לכל עובד — מדפיסים על החשבונית או על כרטיס שולחן" actions={<PrintButton />} />
      <div className="mb-4 print:hidden">
        <Notice tone="gold">
          הלקוח סורק, מדרג חוויה ושירות מ־1 עד 5, והציונים נכנסים לבד לבונוס של העובד: ממוצע החוויה = &quot;סקרי שביעות
          רצון&quot;, ממוצע השירות × 20 = &quot;שירות&quot; (0–100). מכשיר אחד יכול לדרג עובד פעם ב־12 שעות.
        </Notice>
      </div>
      {!cards.length ? (
        <Notice>אין עובדים פעילים בתפקידים שמקבלים בונוס על סקרים ושירות.</Notice>
      ) : (
        <div className="grid grid-cols-2 gap-3 print:grid-cols-3">
          {cards.map((c) => (
            <div key={c.id} className="card flex flex-col items-center gap-2 p-3 text-center print:break-inside-avoid print:border-black print:bg-white print:text-black">
              <div className="w-full max-w-40 overflow-hidden rounded-lg bg-white p-1" dangerouslySetInnerHTML={{ __html: c.svg }} />
              <div className="font-medium">{c.first_name} {c.last_name}</div>
              <div className="text-xs text-muted print:text-black">{ROLE_LABELS[c.job_role as JobRole]}</div>
              <div className="text-[0.7rem] text-faint print:hidden">{count.get(c.id) ?? 0} דירוגים החודש</div>
              <a href={c.url} target="_blank" className="text-[0.7rem] text-gold underline print:hidden" dir="ltr">
                פתיחת הסקר
              </a>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
