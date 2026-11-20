"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { back } from "@/lib/flash";
import { adminStore } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ingestRows, normalizeName } from "@shared/ingest.ts";
import { dateToPeriod } from "@shared/period.ts";
import type { SystemId } from "@shared/store.ts";

export async function resolveGroup(form: FormData) {
  const me = await requireAdmin();
  const system = String(form.get("system")) as SystemId;
  const externalId = String(form.get("external_id") ?? "") || null;
  const externalName = String(form.get("external_name") ?? "") || null;
  const employeeId = String(form.get("employee_id") ?? "");
  const ignore = form.get("ignore") === "1";
  const path = "/admin/mapping";
  const sb = await createClient();

  let q = sb.from("unmatched_rows").select("*").eq("system", system).is("resolved_at", null);
  q = externalId ? q.eq("external_id", externalId) : q.is("external_id", null).eq("external_name", externalName ?? "");
  const { data: rows, error } = await q;
  if (error || !rows?.length) back(path, { err: "השורות לא נמצאו" });

  if (ignore) {
    await sb.from("unmatched_rows").update({ resolved_at: new Date().toISOString() }).in("id", rows!.map((r) => r.id));
    revalidatePath(path);
    back(path, { ok: `${rows!.length} שורות סומנו כלא רלוונטיות` });
  }
  if (!employeeId) back(path, { err: "יש לבחור עובד" });

  // remember the mapping so future imports match automatically
  const key = externalId ?? `name:${normalizeName(externalName ?? "")}`;
  const { error: mapErr } = await sb
    .from("employee_external_ids")
    .upsert({ employee_id: employeeId, system, external_id: key, external_name: externalName }, { onConflict: "system,external_id" });
  if (mapErr) back(path, { err: mapErr.message });

  const r = await ingestRows(adminStore(), {
    branchId: me.employee.branch_id,
    system,
    integrationId: null,
    trigger: "manual",
    rows: rows!.map((u) => ({
      period: dateToPeriod(u.period),
      metricId: u.metric_id,
      employeeId,
      value: Number(u.value),
    })),
  });
  await sb
    .from("unmatched_rows")
    .update({ resolved_at: new Date().toISOString(), resolved_employee_id: employeeId })
    .in("id", rows!.map((u) => u.id));
  revalidatePath("/admin", "layout");
  back(path, { ok: `שויך. ${r.written} תוצאות נקלטו והבונוסים חושבו מחדש. הייבוא הבא יזהה אוטומטית.` });
}
