import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatusBadge } from "@/components/ui";
import { FREQ_LABEL, dateTime } from "@/lib/format";

export const metadata = { title: "חיבורים" };

export default async function Integrations() {
  await requireAdmin();
  const sb = await createClient();
  const [{ data }, { data: map }] = await Promise.all([
    sb.from("integrations").select("*").order("created_at"),
    sb.from("metric_source_map").select("metric_id, system, metrics(name)"),
  ]);
  return (
    <>
      <PageHeader title="חיבורים למערכות" subtitle="מקורות הנתונים לחישוב הבונוסים" />
      <ul className="space-y-2">
        {(data ?? []).map((i) => {
          const metrics = (map ?? []).filter((m) => m.system === i.system).map((m) => (m.metrics as unknown as { name: string })?.name);
          return (
            <li key={i.id}>
              <Link href={i.system === "csv" ? "/admin/import" : `/admin/integrations/${i.id}`} className="card block px-4 py-3.5 hover:border-line-strong">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{i.display_name}</span>
                  <StatusBadge status={i.status} />
                </div>
                <div className="mt-1 text-xs text-muted">
                  {FREQ_LABEL[i.frequency]}
                  {i.last_sync_at ? ` · סנכרון אחרון ${dateTime(i.last_sync_at)}` : ""}
                  {i.last_status ? <> · <StatusBadge status={i.last_status} /></> : null}
                </div>
                {metrics.length ? <div className="mt-1 truncate text-xs text-faint">מדדים: {metrics.join(", ")}</div> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
