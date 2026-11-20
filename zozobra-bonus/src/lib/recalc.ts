import "server-only";
import { adminStore } from "@/lib/supabase/admin";
import { recalcPeriod } from "@shared/recalc.ts";

/** Recalculate a period with the service role. Call only after checking the caller's permission. */
export async function recalcNow(branchId: string, period: string) {
  return recalcPeriod(adminStore(), branchId, period);
}
