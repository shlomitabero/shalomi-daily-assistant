# עלייה לאוויר — מה נשאר (מצב נכון ל־20.11.2026)

## ✅ כבר בוצע
- מסד הנתונים מותקן בפרויקט Supabase **"זוזוברה"** (`oajfkdvwnfhuujozhlkr`), בלי לגעת בטבלאות הקיימות של הקמת המסעדה.
- המדדים, יעדי ינואר 2027, החיבורים, ומשתמש הבעלים (054-7080080, מנהל) נטענו.
- בדיקת האבטחה של Supabase הורצה; הממצאים של אפליקציית הבונוסים טופלו.

## 1. אירוח האפליקציה — Railway (כ־5 דקות)
בפרויקט Railway הקיים **zozobra-website**:
1. **+ Create → GitHub Repo** → `shlomitabero/shalomi-daily-assistant`, ענף `claude/zozobra-bonus-backend-6ztk4b`.
2. Settings → **Root Directory**: `zozobra-bonus`.
3. Variables — להדביק:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://oajfkdvwnfhuujozhlkr.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase → Project Settings → API → anon public>
   SUPABASE_SERVICE_ROLE_KEY=<Supabase → Project Settings → API → service_role — סודי! רק כאן>
   ```
4. Settings → Networking → **Generate Domain**.

## 2. הודעות SMS לכניסה (חובה — בלי זה אף אחד לא יוכל להתחבר)
1. פותחים חשבון ב־twilio.com, קונים מספר / Messaging Service.
2. Supabase → Authentication → Providers → **Phone** → Enable → Twilio → מדביקים Account SID, Auth Token, Message Service SID.
3. Authentication → URL Configuration → Site URL = הכתובת מ־Railway.

## 3. כשמחברים מערכת חיצונית ראשונה (Tabit / מרכזיה / Webhook)
להעלות את פונקציית השרת ולהפעיל תזמון (פקודה אחת, מהמחשב):
```
npx supabase login
npx supabase functions deploy zozobra --project-ref oajfkdvwnfhuujozhlkr --no-verify-jwt
npx supabase secrets set CRON_SECRET=<מחרוזת אקראית> --project-ref oajfkdvwnfhuujozhlkr
```
ואז בעורך ה־SQL: את `supabase/migrations/20261120000004_cron.sql` ושתי שורות ה־vault מ־docs/DEPLOY.md.
עד אז — ייבוא CSV, הזנה ידנית ו"סנכרון עכשיו" עובדים בלי זה.
