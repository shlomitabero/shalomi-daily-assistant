// Single deployable entry point with three routes. Each route does its own auth:
//   POST /functions/v1/zozobra/webhook?integration=<id>   HMAC signature
//   POST /functions/v1/zozobra/dispatch                     x-cron-secret (pg_cron)
//   POST /functions/v1/zozobra/run                          admin JWT (RLS)
import { handleDispatch } from "../_shared/http/dispatch.ts";
import { handleRun } from "../_shared/http/run.ts";
import { handleWebhook } from "../_shared/http/webhook.ts";

Deno.serve((req) => {
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  if (route === "webhook") return handleWebhook(req);
  if (route === "dispatch") return handleDispatch(req);
  if (route === "run") return handleRun(req);
  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
});
