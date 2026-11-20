// Inbound webhook. Authenticated by HMAC signature (no JWT).
//   POST /functions/v1/ingest-webhook?integration=<uuid>
//   X-Zozobra-Timestamp: <unix seconds>
//   X-Zozobra-Signature: sha256=<hex hmac(secret, `${ts}.${body}`)>
import { ingestRows } from "../_shared/ingest.ts";
import { parseWebhookPayload, verifySignature } from "../_shared/integrations/webhook.ts";
import { supabaseStore } from "../_shared/store-supabase.ts";
import type { SystemId } from "../_shared/store.ts";
import { json, serviceClient } from "../_shared/edge.ts";

const MAX_BODY = 1_000_000;
const UUID = /^[0-9a-f-]{36}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const id = new URL(req.url).searchParams.get("integration") ?? "";
  if (!UUID.test(id)) return json({ error: "unknown integration" }, 404);

  const body = await req.text();
  if (body.length > MAX_BODY) return json({ error: "payload too large" }, 413);

  const db = serviceClient();
  const { data: integration } = await db
    .from("integrations")
    .select("id, branch_id, system, status, config, secret_id")
    .eq("id", id)
    .maybeSingle();
  // same response for unknown / unconfigured, to avoid probing
  if (!integration?.secret_id || integration.status === "paused") return json({ error: "unauthorized" }, 401);

  const { data: secret } = await db.rpc("integration_secret", { p_integration: id });
  const signature = req.headers.get("x-zozobra-signature");
  const check = await verifySignature({
    secret: String(secret ?? ""),
    timestamp: req.headers.get("x-zozobra-timestamp"),
    signature,
    body,
  });
  if (!check.ok) return json({ error: "unauthorized" }, 401);

  // replay protection: each signature is accepted once
  const { error: replay } = await db.from("webhook_receipts").insert({ signature, integration_id: id });
  if (replay) return json({ error: "duplicate delivery" }, 409);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = parseWebhookPayload(payload);
  if ("error" in parsed) return json({ error: parsed.error }, 400);

  const system = ((integration.config as Record<string, unknown>)?.act_as as SystemId) ?? "webhook";
  const r = await ingestRows(supabaseStore(db), {
    branchId: integration.branch_id,
    system,
    integrationId: id,
    trigger: "webhook",
    rows: parsed.rows,
  });
  return json({ received: r.received, written: r.written, unmatched: r.unmatched, rejected: r.rejected, issues: r.issues.slice(0, 20) });
});
