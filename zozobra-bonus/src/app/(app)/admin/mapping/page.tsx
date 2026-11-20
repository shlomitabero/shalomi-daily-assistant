import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { normalizeName } from "@shared/ingest.ts";
import { METRIC_BY_ID, ROLE_LABELS, type JobRole, type MetricId } from "@shared/metrics.ts";
import { resolveGroup } from "./actions";

export const metadata = { title: "שיוך עובדים" };

export default async function Mapping({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const sb = await createClient();
  const [{ data: rows }, { data: employees }] = await Promise.all([
    sb.from("unmatched_rows").select("*").is("resolved_at", null).order("created_at"),
    sb.from("employees").select("id, first_name, last_name, job_role").eq("active", true).order("first_name"),
  ]);

  const groups = new Map<string, { system: string; externalId: string | null; externalName: string | null; metrics: Set<string>; count: number }>();
  for (const r of rows ?? []) {
    const k = `${r.system}|${r.external_id ?? ""}|${r.external_id ? "" : r.external_name ?? ""}`;
    const g = groups.get(k) ?? { system: r.system, externalId: r.external_id, externalName: r.external_name, metrics: new Set(), count: 0 };
    g.metrics.add(r.metric_id);
    g.count++;
    groups.set(k, g);
  }

  // suggest the employee whose name shares a word with the external name
  function suggest(name: string | null): string {
    if (!name) return "";
    const words = normalizeName(name).split(" ");
    const hit = (employees ?? []).find((e) => {
      const fn = normalizeName(e.first_name);
      return words.some((w) => w.length >= 2 && (w === fn || w.startsWith(fn) || fn.startsWith(w)));
    });
    return hit?.id ?? "";
  }

  return (
    <>
      <PageHeader title="שיוך עובדים" subtitle="שמות ומזהים ממערכות חיצוניות שלא זוהו אוטומטית" />
      <Flash ok={sp.ok} err={sp.err} />
      {!groups.size ? (
        <Empty title="אין שורות שממתינות לשיוך">כל הנתונים שיובאו שויכו לעובדים.</Empty>
      ) : (
        <div className="space-y-3">
          {[...groups.values()].map((g) => (
            <Card key={`${g.system}${g.externalId}${g.externalName}`}>
              <form action={resolveGroup} className="space-y-3">
                <input type="hidden" name="system" value={g.system} />
                <input type="hidden" name="external_id" value={g.externalId ?? ""} />
                <input type="hidden" name="external_name" value={g.externalName ?? ""} />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{g.externalName || g.externalId}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {g.externalId && g.externalName ? <span dir="ltr">{g.externalId} · </span> : null}
                      {[...g.metrics].map((m) => METRIC_BY_ID[m as MetricId]?.name ?? m).join(", ")}
                    </div>
                  </div>
                  <span className="flex shrink-0 gap-1">
                    <Badge>{g.system}</Badge>
                    <Badge tone="warn">{g.count}</Badge>
                  </span>
                </div>
                <select name="employee_id" defaultValue={suggest(g.externalName)} className="field">
                  <option value="">בחירת עובד…</option>
                  {(employees ?? []).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.first_name} {e.last_name} · {ROLE_LABELS[e.job_role as JobRole]}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <SubmitButton className="flex-1" pendingText="משייך…">שיוך וקליטה</SubmitButton>
                  <SubmitButton name="ignore" value="1" variant="ghost" confirm="להתעלם מהשורות האלה?">
                    התעלמות
                  </SubmitButton>
                </div>
              </form>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
