import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Empty, PageHeader, StatusBadge } from "@/components/ui";
import { dateTime } from "@/lib/format";

export const metadata = { title: "יומן סנכרון" };

const TRIGGER: Record<string, string> = { cron: "מתוזמן", manual: "ידני", webhook: "Webhook", csv: "ייבוא CSV" };
const SYSTEM: Record<string, string> = {
  manual: "ידני", csv: "CSV", webhook: "Webhook", tabit: "Tabit", beecomm: "Beecomm",
  cost: "עלויות", payroll: "שכר", pbx: "מרכזיה", survey: "סקרים",
};

export default async function SyncLog({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const sb = await createClient();
  let q = sb.from("sync_log").select("*").order("started_at", { ascending: false }).limit(100);
  if (sp.status === "failed") q = q.in("status", ["failed", "partial"]);
  const { data } = await q;

  return (
    <>
      <PageHeader
        title="יומן סנכרון"
        subtitle="100 ההרצות האחרונות של כל המקורות"
        actions={
          <a href={sp.status === "failed" ? "?" : "?status=failed"} className="text-xs text-gold">
            {sp.status === "failed" ? "הצגת הכל" : "רק תקלות"}
          </a>
        }
      />
      {!data?.length ? (
        <Empty title="אין עדיין הרצות" />
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {data.map((l) => (
              <li key={l.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {SYSTEM[l.system] ?? l.system} <span className="text-xs font-normal text-muted">· {TRIGGER[l.trigger]}</span>
                  </span>
                  <StatusBadge status={l.status} />
                </div>
                <div className="mt-0.5 flex justify-between gap-2 text-xs text-muted">
                  <span className="min-w-0">{l.message ?? "—"}</span>
                  <span className="num shrink-0">{dateTime(l.started_at)}</span>
                </div>
                {l.details?.issues?.length ? (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-faint">{l.details.issues.length} הערות</summary>
                    <ul className="mt-1 space-y-0.5 text-bad/90">
                      {l.details.issues.slice(0, 20).map((i: { index: number; reason: string }) => (
                        <li key={i.index}>שורה {i.index + 1}: {i.reason}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
