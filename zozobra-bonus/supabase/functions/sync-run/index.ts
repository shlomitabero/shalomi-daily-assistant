// Run one integration now. Caller must be a logged-in admin of that branch.
//   POST { "integration_id": "...", "periods": ["2027-01"]? }
import { createClient } from "@supabase/supabase-js";
import { runIntegration } from "../_shared/sync.ts";
import { isPeriod } from "../_shared/period.ts";
import { json, serviceClient } from "../_shared/edge.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = req.headers.get("Authorization") ?? "";
  // act as the caller: RLS only returns the integration if they are its branch admin
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const body = await req.json().catch(() => ({}));
  const id = String(body.integration_id ?? "");
  const { data: visible } = await asUser.from("integrations").select("id").eq("id", id).maybeSingle();
  if (!visible) return json({ error: "forbidden" }, 403);

  const periods = Array.isArray(body.periods) ? body.periods.filter(isPeriod) : undefined;
  const r = await runIntegration(serviceClient(), id, "manual", periods?.length ? periods : undefined);
  return json({ ok: r.ok, message: r.message }, r.ok ? 200 : 422);
});
