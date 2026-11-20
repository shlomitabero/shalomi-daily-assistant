import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/forms";
import { Card, LinkButton, PageHeader, SectionTitle } from "@/components/ui";
import { ROLE_LABELS, type JobRole } from "@shared/metrics.ts";
import { saveEmployee } from "../actions";

const SYSTEMS: [string, string][] = [
  ["tabit", "Tabit (מזהה מלצר)"],
  ["beecomm", "Beecomm"],
  ["payroll", "שכר / נוכחות"],
  ["pbx", "מרכזיה (שלוחה / סוכן)"],
  ["survey", "מערכת סקרים"],
];

export default async function EmployeeForm({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const isNew = id === "new";
  const sb = await createClient();
  let e: Record<string, any> | null = null;
  let ext = new Map<string, string>();
  if (!isNew) {
    const [{ data }, { data: ids }] = await Promise.all([
      sb.from("employees").select("*").eq("id", id).maybeSingle(),
      sb.from("employee_external_ids").select("system, external_id").eq("employee_id", id),
    ]);
    if (!data) notFound();
    e = data;
    ext = new Map((ids ?? []).map((x) => [x.system, x.external_id]));
  }
  const phoneLocal = e?.phone ? `0${String(e.phone).slice(3)}` : "";

  return (
    <>
      <PageHeader
        title={isNew ? "עובד חדש" : `${e!.first_name} ${e!.last_name}`}
        actions={<LinkButton href="/admin/employees" variant="ghost" size="sm">→ חזרה</LinkButton>}
      />
      <Flash ok={sp.ok} err={sp.err} />
      <form action={saveEmployee} className="space-y-4">
        <input type="hidden" name="id" value={isNew ? "" : id} />
        <Card className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="שם פרטי" name="first_name" value={e?.first_name} required />
            <Field label="שם משפחה" name="last_name" value={e?.last_name} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="טלפון נייד (לכניסה)" name="phone" value={phoneLocal} inputMode="tel" required ltr />
            <Field label="מספר עובד בשכר" name="payroll_id" value={e?.payroll_id} ltr />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">תפקיד</label>
              <select name="job_role" defaultValue={e?.job_role ?? "waiter"} className="field">
                {Object.entries(ROLE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">הרשאה באפליקציה</label>
              <select name="app_role" defaultValue={e?.app_role ?? "employee"} className="field">
                <option value="employee">עובד</option>
                <option value="shift_manager">מנהל משמרת</option>
                <option value="admin">מנהל / בעלים</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="תחילת עבודה" name="start_date" value={e?.start_date} type="date" />
            <Field label="סיום עבודה" name="end_date" value={e?.end_date} type="date" />
          </div>
          <Check name="tip_based" label="מקבל/ת טיפים + השלמה לשכר מינימום (מלצרים/בר)" checked={e ? e.tip_based : false} />
          <Check name="bonus_eligible" label="זכאי/ת לבונוס" checked={e ? e.bonus_eligible : true} />
          <Check name="active" label="פעיל/ה" checked={e ? e.active : true} />
        </Card>

        <Card>
          <SectionTitle>מזהים במערכות חיצוניות</SectionTitle>
          <p className="mb-3 text-xs text-muted">משמשים להתאמה אוטומטית של נתונים מהקופה, המרכזיה ושאר המערכות.</p>
          <div className="grid grid-cols-2 gap-3">
            {SYSTEMS.map(([k, label]) => (
              <Field key={k} label={label} name={`ext:${k}`} value={ext.get(k)} ltr />
            ))}
          </div>
        </Card>
        <SubmitButton className="w-full">{isNew ? "הוספת עובד" : "שמירה"}</SubmitButton>
      </form>
      {!isNew && e?.job_role ? (
        <p className="mt-3 text-xs text-faint">תפקיד נוכחי: {ROLE_LABELS[e.job_role as JobRole]}</p>
      ) : null}
    </>
  );
}

function Field(p: { label: string; name: string; value?: string | null; type?: string; inputMode?: "tel"; required?: boolean; ltr?: boolean }) {
  return (
    <div>
      <label className="label" htmlFor={p.name}>{p.label}</label>
      <input
        id={p.name}
        name={p.name}
        type={p.type ?? "text"}
        defaultValue={p.value ?? ""}
        inputMode={p.inputMode}
        required={p.required}
        dir={p.ltr ? "ltr" : undefined}
        className={`field ${p.ltr ? "text-end" : ""}`}
      />
    </div>
  );
}

function Check({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label className="flex items-center gap-2.5 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} className="h-4 w-4 accent-[#cfa95f]" />
      {label}
    </label>
  );
}
