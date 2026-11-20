# ZOZOBRA · אפליקציית בונוסים לצוות

אפליקציה לטלפון (אפשר להתקין אותה כאפליקציה) שבה כל עובד רואה את הבונוס החודשי שלו, מנהלי משמרת מזינים
ציונים, והבעלים מגדיר יעדים, מאשר בונוסים ומוציא קובץ לרואה החשבון.

## מה יש באפליקציה

| מי | מה רואה / עושה |
|---|---|
| עובד | הבונוס שלו לחודש, פירוט לפי מדד, חודשים קודמים, טבלת מובילים (שמות פרטיים בלבד) |
| מנהל משמרת | הזנת ציוני שירות, סקרים ושירות טלפוני |
| בעלים / מנהל | לוח בקרה, יעדים וסכומים, תיקון תוצאות, אישור ותשלום, ייצוא לאקסל, עובדים, חיבורים, ייבוא CSV, שיוך שמות, יומני סנכרון ושינויים |

**כלל החישוב** (כל המספרים ניתנים לשינוי במסך "יעדים", לכל מדד ולכל חודש):
מתחת לסף — 0. בסף — 50%. בין הסף ליעד — עולה בקו ישר. ביעד — 100%. מעל היעד — לפי אחוז העמידה, עד 120%.
במדדים שבהם נמוך = טוב (פוד קוסט, ליבור קוסט), העמידה היא יעד ÷ בפועל. נתון חסר = 0 על אותו מדד, ומסומן
באדום לפני אישור. עובד שהתחיל או סיים באמצע חודש — הבונוס יחסי לימי העבודה. שינוי תוצאה או יעד אחרי
אישור מחזיר את הבונוסים המושפעים לטיוטה ונרשם ביומן. בונוס ששולם נעול.

**תשלום**: הבונוס משולם עם המשכורת ב־10 לחודש העוקב, כשורה נפרדת בתלוש — גם אצל מלצרים וברמנים, בנוסף
לטיפים ולהשלמה לשכר מינימום.

## Technical overview

- **Next.js 15** (App Router, server components and server actions), TypeScript, Tailwind v4, Hebrew RTL, installable PWA.
- **Supabase**: Postgres with RLS on every table, phone OTP auth, Vault for integration keys, Edge Functions (Deno), pg_cron.
- **One payout engine** (`supabase/functions/_shared/payout.ts`) shared by the web server, edge functions and tests.

```
supabase/
  migrations/      schema · business-rule triggers · RLS · cron
  seed.sql         branch, 9 metrics, role eligibility, demo team, Jan 2027 targets
  functions/
    _shared/       payout engine, recalc, ingest, CSV, adapters, sync (Node + Deno)
    ingest-webhook/  sync-dispatch/  sync-run/
src/app/           screens (employee /me /leaderboard · manager /manager/scores · admin /admin/*)
tests/db/          RLS + import tests against the real migrations
docs/              integrations.md · DEPLOY.md
public/templates/  results-template.csv
```

### Run locally
```bash
npm install
npx supabase start            # Docker; applies migrations + seed
cp .env.example .env.local    # fill from `npx supabase status`
npm run recalc -- 2027-01
npm run dev                   # http://localhost:3000, log in 050-0000001 / 123456 (admin)
```
Demo logins (local only, OTP `123456`): 050-0000001 owner · 050-0000002 shift manager · 050-0000003 waiter.

### Tests
```bash
npm test     # 93 tests: payout engine, CSV, adapters/webhook/schedules, RLS, template CSV import
```
DB tests need a local Postgres 16+ (`TEST_DATABASE_ADMIN_URL`, default `postgres://postgres:postgres@localhost:5432/postgres`).
They build a throwaway database from the real migrations with a small Supabase auth/vault stand-in (`tests/db/supabase-shim.sql`).

### Security
- The browser gets only the Supabase URL and anon key; every table is protected by RLS. Anon has no grants.
- Service-role key: server only (`src/lib/supabase/admin.ts` imports `server-only`). It is used only after the caller's role has been checked.
- Integration keys live in Supabase Vault. Admins can write a key, nobody can read it back through the API, and only the service role can decrypt it.
- Webhooks: HMAC-SHA256 signature, 5-minute timestamp window, replay guard.
- Payout amounts cannot be written by any user, only by the server-side recalculation. Status changes follow a draft → approved → paid state machine enforced in the database.

Deploy: see [docs/DEPLOY.md](docs/DEPLOY.md). Integrations: see [docs/integrations.md](docs/integrations.md).
