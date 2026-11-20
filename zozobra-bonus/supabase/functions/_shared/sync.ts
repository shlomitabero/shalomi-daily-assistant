// Sync orchestration: decide which integrations are due, run an adapter,
// and push its rows through ingestRows(). Runs in edge functions (cron)
// and on the Next.js server ("run now", report upload) with the service role.

import type { SupabaseClient } from "@supabase/supabase-js";
import { adapterFor } from "./integrations/registry.ts";
import { AdapterNotReadyError } from "./integrations/types.ts";
import { ingestRows, type IngestResult, type NormalizedRow } from "./ingest.ts";
import { addMonths, currentPeriod } from "./period.ts";
import { supabaseStore } from "./store-supabase.ts";
import type { SystemId } from "./store.ts";

// deno-lint-ignore no-explicit-any
type Client = SupabaseClient<any, any, any>;

export type Frequency = "manual" | "every_15_min" | "hourly" | "daily_0500";

function israelParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => f.find((x) => x.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Is an integration due to sync now? The dispatcher runs every 15 minutes. */
export function isDue(frequency: Frequency, lastSyncAt: string | null, now: Date = new Date()): boolean {
  if (frequency === "manual") return false;
  const last = lastSyncAt ? new Date(lastSyncAt) : null;
  const minutes = last ? (now.getTime() - last.getTime()) / 60_000 : Infinity;
  if (frequency === "every_15_min") return minutes >= 14;
  if (frequency === "hourly") return minutes >= 59;
  // daily at 05:00 Israel time: due once per Israeli day, from 05:00
  const n = israelParts(now);
  if (n.hour < 5) return false;
  if (!last) return true;
  const l = israelParts(last);
  return l.date < n.date || (l.date === n.date && l.hour < 5);
}

/** Periods to pull: the current month, plus last month during the first 3 days (late data). */
export function periodsToSync(now: Date = new Date()): string[] {
  const p = currentPeriod(now);
  const day = Number(israelParts(now).date.slice(8, 10));
  return day <= 3 ? [addMonths(p, -1), p] : [p];
}

interface IntegrationRow {
  id: string;
  branch_id: string;
  system: SystemId;
  status: string;
  frequency: Frequency;
  config: Record<string, unknown>;
  secret_id: string | null;
  last_sync_at: string | null;
}

async function loadIntegration(db: Client, id: string): Promise<IntegrationRow> {
  const { data, error } = await db.from("integrations").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`integration ${id} not found`);
  return data as IntegrationRow;
}

async function loadSecret(db: Client, i: IntegrationRow): Promise<string | null> {
  if (!i.secret_id) return null;
  const { data, error } = await db.rpc("integration_secret", { p_integration: i.id });
  if (error) throw new Error(`secret: ${error.message}`);
  return (data as string | null) ?? null;
}

async function logFailure(db: Client, i: IntegrationRow, trigger: string, message: string) {
  await db.from("sync_log").insert({
    branch_id: i.branch_id,
    integration_id: i.id,
    system: i.system,
    trigger,
    status: "failed",
    finished_at: new Date().toISOString(),
    message,
  });
  await db
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), last_status: "failed" })
    .eq("id", i.id);
}

export async function runIntegration(
  db: Client,
  integrationId: string,
  trigger: "cron" | "manual",
  periods: string[] = periodsToSync(),
): Promise<{ ok: boolean; message: string; results: IngestResult[] }> {
  const i = await loadIntegration(db, integrationId);
  const adapter = adapterFor(i.system);
  if (!adapter || !adapter.capabilities.pull) {
    return { ok: false, message: "למערכת זו אין משיכת נתונים", results: [] };
  }
  const results: IngestResult[] = [];
  try {
    const secret = await loadSecret(db, i);
    const problems = adapter.readiness(i.config, !!secret);
    if (problems.length) throw new AdapterNotReadyError(problems);
    for (const period of periods) {
      const { rows } = await adapter.fetchMetrics(
        { integrationId: i.id, branchId: i.branch_id, config: i.config, secret, fetch },
        period,
      );
      results.push(
        await ingestRows(supabaseStore(db), {
          branchId: i.branch_id,
          system: i.system,
          integrationId: i.id,
          trigger,
          rows,
        }),
      );
    }
    if (i.status === "error") await db.from("integrations").update({ status: "active" }).eq("id", i.id);
    const written = results.reduce((s, r) => s + r.written, 0);
    return { ok: true, message: `נכתבו ${written} תוצאות`, results };
  } catch (e) {
    const msg = e instanceof AdapterNotReadyError ? `לא מוכן: ${e.message}` : `שגיאה: ${(e as Error).message}`;
    await logFailure(db, i, trigger, msg);
    if (!(e instanceof AdapterNotReadyError) && i.status === "active") {
      await db.from("integrations").update({ status: "error" }).eq("id", i.id);
    }
    return { ok: false, message: msg, results };
  }
}

/** Called by the cron dispatcher every 15 minutes. */
export async function dispatchDue(db: Client, now: Date = new Date()) {
  const { data, error } = await db
    .from("integrations")
    .select("id, system, frequency, last_sync_at, status")
    .eq("status", "active")
    .neq("frequency", "manual");
  if (error) throw new Error(error.message);
  const due = (data ?? []).filter((i) => isDue(i.frequency as Frequency, i.last_sync_at, now));
  const out: { id: string; system: string; ok: boolean; message: string }[] = [];
  for (const i of due) {
    const r = await runIntegration(db, i.id, "cron", periodsToSync(now));
    out.push({ id: i.id, system: i.system, ok: r.ok, message: r.message });
  }
  return { checked: data?.length ?? 0, ran: out };
}

/** Uploaded vendor report (e.g. Tabit export) → ingest as that system. */
export async function runReport(db: Client, integrationId: string, text: string, period: string): Promise<IngestResult> {
  const i = await loadIntegration(db, integrationId);
  const adapter = adapterFor(i.system);
  if (!adapter?.parseReport) throw new Error("למערכת זו אין ייבוא דוח");
  const rows: NormalizedRow[] = adapter.parseReport(text, period, i.config);
  return ingestRows(supabaseStore(db), {
    branchId: i.branch_id,
    system: i.system,
    integrationId: i.id,
    trigger: "manual",
    rows,
  });
}
