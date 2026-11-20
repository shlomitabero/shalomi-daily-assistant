// Called by pg_cron every 15 minutes. Runs every integration that is due
// (15 min / hourly / daily 05:00 Israel time). Auth: x-cron-secret header.
import { dispatchDue } from "../sync.ts";
import { json, safeEqual, serviceClient } from "../edge.ts";

export async function handleDispatch(req: Request): Promise<Response> {
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!expected || !safeEqual(expected, got)) return json({ error: "forbidden" }, 403);
  try {
    return json(await dispatchDue(serviceClient()));
  } catch (e) {
    console.error("dispatch failed", e);
    return json({ error: (e as Error).message }, 500);
  }
}
