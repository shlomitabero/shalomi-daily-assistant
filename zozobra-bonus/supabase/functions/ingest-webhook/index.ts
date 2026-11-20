import { handleWebhook } from "../_shared/http/webhook.ts";

Deno.serve(handleWebhook);
