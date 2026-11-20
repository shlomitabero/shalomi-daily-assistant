-- Scheduled jobs. One dispatcher runs every 15 minutes and decides which
-- integrations are due (15 min / hourly / daily 05:00 Israel time), so the
-- schedule is data, not code. Requires pg_cron + pg_net (enabled on
-- Supabase). Skipped silently where they are not available (local tests).
--
-- One-time setup after deploy (Supabase SQL editor):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random 32+ chars>', 'cron_secret');
-- and set the same CRON_SECRET as an edge function secret.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron/pg_net not available — skipping schedules';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  perform cron.schedule(
    'zozobra-sync-dispatch',
    '*/15 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/zozobra/dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      )
    $job$
  );

  -- 00:10 UTC on the 1st ≈ 02:10/03:10 Israel time
  perform cron.schedule('zozobra-rollover-targets', '10 0 1 * *',
    $job$ select app.rollover_targets() $job$);

  -- keep webhook replay-guard table small
  perform cron.schedule('zozobra-prune-receipts', '30 3 * * *',
    $job$ delete from public.webhook_receipts where received_at < now() - interval '2 days' $job$);
end $$;
