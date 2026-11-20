// Ops tool: recalculate payouts for a period.  npm run recalc -- 2027-01
import { createClient } from "@supabase/supabase-js";
import { supabaseStore } from "../supabase/functions/_shared/store-supabase.ts";
import { recalcPeriod } from "../supabase/functions/_shared/recalc.ts";

const period = process.argv[2];
if (!period) throw new Error("usage: npm run recalc -- YYYY-MM");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const { data: branches, error } = await db.from("branches").select("id, name");
if (error) throw error;
for (const b of branches!) {
  const s = await recalcPeriod(supabaseStore(db), b.id, period);
  console.log(`${b.name} ${period}: ${s.employees} employees, total ₪${(s.total / 100).toFixed(2)}, missing ${s.missing}`);
}
