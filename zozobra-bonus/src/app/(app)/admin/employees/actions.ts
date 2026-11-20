"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { back } from "@/lib/flash";
import { createClient } from "@/lib/supabase/server";
import { digitsPhone } from "@shared/ingest.ts";
import { ROLE_ELIGIBILITY } from "@shared/metrics.ts";

const SYSTEMS = ["tabit", "beecomm", "cost", "payroll", "pbx", "survey", "webhook"];

export async function saveEmployee(form: FormData) {
  const me = await requireAdmin();
  const id = String(form.get("id") ?? "");
  const path = id ? `/admin/employees/${id}` : "/admin/employees/new";
  const phone = digitsPhone(String(form.get("phone") ?? ""));
  if (!/^9725\d{8}$/.test(phone)) back(path, { err: "מספר טלפון נייד לא תקין" });
  const job_role = String(form.get("job_role"));
  if (!(job_role in ROLE_ELIGIBILITY)) back(path, { err: "תפקיד לא תקין" });
  const app_role = String(form.get("app_role"));
  if (!["employee", "shift_manager", "admin"].includes(app_role)) back(path, { err: "הרשאה לא תקינה" });

  const row = {
    first_name: String(form.get("first_name") ?? "").trim(),
    last_name: String(form.get("last_name") ?? "").trim(),
    phone,
    job_role,
    app_role,
    payroll_id: String(form.get("payroll_id") ?? "").trim() || null,
    tip_based: form.get("tip_based") === "on",
    bonus_eligible: form.get("bonus_eligible") === "on",
    start_date: String(form.get("start_date") ?? "") || null,
    end_date: String(form.get("end_date") ?? "") || null,
    active: form.get("active") === "on",
  };
  if (!row.first_name) back(path, { err: "חובה למלא שם פרטי" });

  const sb = await createClient();
  let employeeId = id;
  if (id) {
    const { error } = await sb.from("employees").update(row).eq("id", id);
    if (error) back(path, { err: error.message.includes("duplicate") ? "מספר הטלפון כבר קיים" : error.message });
  } else {
    const { data, error } = await sb.from("employees").insert({ ...row, branch_id: me.employee.branch_id }).select("id").single();
    if (error) back(path, { err: error.message.includes("duplicate") ? "מספר הטלפון כבר קיים" : error.message });
    employeeId = data!.id;
  }

  // external ids per system
  for (const sys of SYSTEMS) {
    const v = form.get(`ext:${sys}`);
    if (v === null) continue;
    const ext = String(v).trim();
    await sb.from("employee_external_ids").delete().eq("employee_id", employeeId).eq("system", sys);
    if (ext) {
      const { error } = await sb.from("employee_external_ids").insert({ employee_id: employeeId, system: sys, external_id: ext });
      if (error) back(`/admin/employees/${employeeId}`, { err: `המזהה ${ext} כבר משויך לעובד אחר ב־${sys}` });
    }
  }
  revalidatePath("/admin/employees");
  back(`/admin/employees/${employeeId}`, { ok: "נשמר. שינויי תפקיד ותאריכים ייכנסו בחישוב הבא." });
}
