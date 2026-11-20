import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseStore } from "@shared/store-supabase.ts";

/**
 * Service-role client. Bypasses RLS — use ONLY after the caller's permission
 * was checked, and only for server-side jobs (recalculation, ingest).
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminStore() {
  return supabaseStore(createAdminClient());
}
