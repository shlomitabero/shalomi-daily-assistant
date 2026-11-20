# Deploy (one time, ~30 minutes)

## 1. Supabase
1. Create a project in region **eu-central-1 (Frankfurt)**, the closest to Israel.
2. Run the migrations and seed from this folder:
   `npx supabase link --project-ref <ref> && npx supabase db push && psql "$DB_URL" -f supabase/seed.sql`
   (the seed holds the demo team; replace the employees with the real team on the employees screen).
3. **Auth → Providers → Phone**: enable it, choose Twilio (or Vonage), paste the SMS keys (stored by Supabase, not in this repo). SMS template: `קוד הכניסה שלך ל-ZOZOBRA: {{ .Code }}`.
4. **Auth → URL configuration**: Site URL = the Vercel URL.
5. Edge functions:
   ```
   npx supabase functions deploy ingest-webhook --no-verify-jwt
   npx supabase functions deploy sync-dispatch --no-verify-jwt
   npx supabase functions deploy sync-run
   npx supabase secrets set CRON_SECRET=<random 32+ chars>
   ```
6. SQL editor, once (lets pg_cron call the dispatcher):
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('<same CRON_SECRET>', 'cron_secret');
   ```

## 2. Vercel
1. Import the GitHub repo, **Root directory: `zozobra-bonus`**.
2. Environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public by design; data is protected by RLS)
   - `SUPABASE_SERVICE_ROLE_KEY`: server only. Never prefix it with `NEXT_PUBLIC_`.
3. Deploy. Region: `fra1`.

## 3. First login
The owner's phone must be on an employee row with `app_role = admin`
(in the seed: 050-0000001; change it to the real number in SQL before the
first login).
