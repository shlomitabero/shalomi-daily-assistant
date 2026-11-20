"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { back } from "@/lib/flash";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { adapterFor } from "@shared/integrations/registry.ts";
import { runIntegration, runReport } from "@shared/sync.ts";
import { currentPeriod, isPeriod } from "@shared/period.ts";
import { isMetricId } from "@shared/metrics.ts";

const FREQ = ["manual", "every_15_min", "hourly", "daily_0500"];
const STATUS = ["not_configured", "awaiting_credentials", "active", "paused"];

/** RLS check: returns the integration only if the caller administers its branch. */
async function ownIntegration(id: string) {
  await requireAdmin();
  const sb = await createClient();
  const { data } = await sb.from("integrations").select("*").eq("id", id).maybeSingle();
  if (!data) back("/admin/integrations", { err: "חיבור לא נמצא" });
  return { sb, integration: data };
}

export async function saveIntegration(form: FormData) {
  const id = String(form.get("id"));
  const { sb, integration } = await ownIntegration(id);
  const path = `/admin/integrations/${id}`;
  const adapter = adapterFor(integration.system);
  const config: Record<string, unknown> = { ...(integration.config ?? {}) };

  for (const f of adapter?.configFields ?? []) {
    const raw = form.get(`cfg:${f.key}`);
    if (raw === null) continue;
    const s = String(raw).trim();
    if (f.type === "json") {
      if (!s) {
        delete config[f.key];
        continue;
      }
      try {
        config[f.key] = JSON.parse(s);
      } catch {
        back(path, { err: `JSON לא תקין בשדה "${f.label}"` });
      }
    } else if (s) config[f.key] = s;
    else delete config[f.key];
  }
  if (JSON.stringify(config).match(/(api[_-]?key|token|secret|password)"\s*:\s*"[^"T]/i)) {
    back(path, { err: "אין לשמור מפתחות בהגדרות. השתמשו בשדה 'מפתח גישה' — הוא נשמר בכספת מוצפנת." });
  }

  const frequency = String(form.get("frequency"));
  const status = String(form.get("status"));
  const { error } = await sb
    .from("integrations")
    .update({
      config,
      frequency: FREQ.includes(frequency) ? frequency : integration.frequency,
      status: STATUS.includes(status) ? status : integration.status,
    })
    .eq("id", id);
  if (error) back(path, { err: error.message });

  // metric → source key mapping for this system
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("map:")) continue;
    const metric = k.slice(4);
    if (!isMetricId(metric)) continue;
    const key = String(v).trim();
    const { data: current } = await sb.from("metric_source_map").select("system").eq("metric_id", metric).maybeSingle();
    if (key) {
      await sb
        .from("metric_source_map")
        .upsert(
          { branch_id: integration.branch_id, metric_id: metric, system: integration.system, external_key: key },
          { onConflict: "branch_id,metric_id" },
        );
    } else if (current?.system === integration.system) {
      await sb.from("metric_source_map").delete().eq("metric_id", metric).eq("system", integration.system);
    }
  }
  revalidatePath("/admin/integrations");
  back(path, { ok: "ההגדרות נשמרו" });
}

export async function setSecret(form: FormData) {
  const id = String(form.get("id"));
  const { sb } = await ownIntegration(id);
  const secret = String(form.get("secret") ?? "").trim();
  if (secret.length < 8) back(`/admin/integrations/${id}`, { err: "מפתח קצר מדי" });
  // stored in Supabase Vault by a SECURITY DEFINER function; never readable back
  const { error } = await sb.rpc("set_integration_secret", { p_integration: id, p_secret: secret });
  if (error) back(`/admin/integrations/${id}`, { err: error.message });
  back(`/admin/integrations/${id}`, { ok: "המפתח נשמר בכספת המוצפנת" });
}

/** Returns the new secret to the caller once (never via URL, never stored in plain text). */
export async function rotateWebhookSecret(
  _prev: { secret?: string; error?: string } | null,
  form: FormData,
): Promise<{ secret?: string; error?: string }> {
  const id = String(form.get("id"));
  const { sb } = await ownIntegration(id);
  const { data, error } = await sb.rpc("rotate_webhook_secret", { p_integration: id });
  if (error) return { error: error.message };
  return { secret: data as string };
}

export async function runNow(form: FormData) {
  const id = String(form.get("id"));
  await ownIntegration(id);
  const period = String(form.get("period") || currentPeriod());
  const r = await runIntegration(createAdminClient(), id, "manual", isPeriod(period) ? [period] : undefined);
  revalidatePath("/admin", "layout");
  back(`/admin/integrations/${id}`, r.ok ? { ok: r.message } : { err: r.message });
}

export async function uploadReport(form: FormData) {
  const id = String(form.get("id"));
  await ownIntegration(id);
  const period = String(form.get("period"));
  const file = form.get("file");
  const path = `/admin/integrations/${id}`;
  if (!isPeriod(period)) back(path, { err: "תקופה לא תקינה" });
  if (!(file instanceof File) || !file.size) back(path, { err: "לא נבחר קובץ" });
  if (file.size > 5_000_000) back(path, { err: "הקובץ גדול מ־5MB" });
  try {
    const r = await runReport(createAdminClient(), id, await file.text(), period);
    revalidatePath("/admin", "layout");
    back(path, {
      ok: `הדוח נקלט: ${r.written} תוצאות נכתבו${r.unmatched ? `, ${r.unmatched} ממתינות לשיוך עובד` : ""}${r.rejected ? `, ${r.rejected} נדחו` : ""}`,
    });
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    back(path, { err: (e as Error).message });
  }
}
