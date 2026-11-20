import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, LinkButton, PageHeader } from "@/components/ui";
import { ROLE_LABELS, type JobRole } from "@shared/metrics.ts";

export const metadata = { title: "עובדים" };

export default async function Employees() {
  await requireAdmin();
  const sb = await createClient();
  const { data } = await sb.from("employees").select("*").order("active", { ascending: false }).order("first_name");
  return (
    <>
      <PageHeader
        title="עובדים"
        subtitle={`${data?.filter((e) => e.active).length ?? 0} פעילים`}
        actions={<LinkButton href="/admin/employees/new" variant="primary" size="sm">+ עובד חדש</LinkButton>}
      />
      <ul className="space-y-2">
        {(data ?? []).map((e) => (
          <li key={e.id}>
            <Link href={`/admin/employees/${e.id}`} className={`card flex items-center gap-3 px-4 py-3 ${e.active ? "" : "opacity-50"}`}>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm text-gold">
                {e.first_name.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {e.first_name} {e.last_name}
                </div>
                <div className="text-xs text-muted">
                  {ROLE_LABELS[e.job_role as JobRole]}
                  {e.payroll_id ? ` · ${e.payroll_id}` : ""}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {e.app_role === "admin" ? <Badge tone="gold">מנהל</Badge> : e.app_role === "shift_manager" ? <Badge>מנהל משמרת</Badge> : null}
                {!e.auth_user_id && e.active ? <span className="text-[0.65rem] text-faint">טרם התחבר</span> : null}
                {!e.active ? <Badge>לא פעיל</Badge> : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
