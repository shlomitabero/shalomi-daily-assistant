import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Empty, PageHeader } from "@/components/ui";
import { dateTime, shekels } from "@/lib/format";

export const metadata = { title: "יומן שינויים" };

const ACTIONS: Record<string, string> = {
  insert: "נוסף",
  update: "עודכן",
  delete: "נמחק",
  payout_approved: "בונוס אושר",
  payout_paid: "בונוס סומן כשולם",
  payout_reverted_to_draft: "בונוס הוחזר לטיוטה",
  changed_after_paid: "שינוי אחרי תשלום",
  secret_set: "מפתח גישה עודכן",
};
const ENTITIES: Record<string, string> = {
  metric_results: "תוצאה",
  metric_targets: "יעד",
  bonus_payouts: "בונוס",
  employees: "עובד",
  integrations: "חיבור",
};

export default async function Audit() {
  await requireAdmin();
  const sb = await createClient();
  const [{ data }, { data: emps }] = await Promise.all([
    sb.from("audit_log").select("*").order("at", { ascending: false }).limit(200),
    sb.from("employees").select("id, auth_user_id, first_name"),
  ]);
  const byAuth = new Map((emps ?? []).filter((e) => e.auth_user_id).map((e) => [e.auth_user_id, e.first_name]));
  const byId = new Map((emps ?? []).map((e) => [e.id, e.first_name]));

  function describe(a: Record<string, any>): string {
    const b = a.before ?? {}, n = a.after ?? {};
    if (a.entity === "metric_results") {
      const who = byId.get(n.employee_id ?? b.employee_id) ?? "סניף";
      const metric = n.metric_id ?? b.metric_id;
      return `${metric} · ${who}: ${b.value ?? "—"} → ${n.value ?? "—"}`;
    }
    if (a.entity === "metric_targets") return `${n.metric_id ?? b.metric_id}: יעד ${b.target ?? "—"} → ${n.target ?? "—"}`;
    if (a.entity === "bonus_payouts") return `${shekels(n.amount ?? b.amount)}${a.reason ? ` · ${a.reason}` : ""}`;
    if (a.entity === "employees") return `${n.first_name ?? b.first_name ?? ""}`;
    return a.reason ?? "";
  }

  return (
    <>
      <PageHeader title="יומן שינויים" subtitle="200 הפעולות האחרונות" />
      {!data?.length ? (
        <Empty title="אין עדיין רשומות" />
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {data.map((a) => (
              <li key={a.id} className="px-4 py-2.5 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">
                    {ENTITIES[a.entity] ?? a.entity} · {ACTIONS[a.action] ?? a.action}
                  </span>
                  <span className="num shrink-0 text-xs text-faint">{dateTime(a.at)}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {describe(a)} · {a.actor ? byAuth.get(a.actor) ?? "משתמש" : "מערכת"}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
