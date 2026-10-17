# MODULE 4: Social Automation & Publishing Pipeline

## 4.0 About "anti-ban": what this module does and doesn't do

AI-creator accounts don't get restricted because platforms "detect AI." Meta and TikTok both
*allow* virtual creators. What gets them restricted is:

1. **Unlabelled realistic AI media.** Both platforms require the AI label and penalise its absence.
2. **Undisclosed paid promotion.** Platform policy, plus Israel's Consumer Protection Law
   (§7(ג), the 2021 influencer-advertising guidelines) requires marking ads.
3. **Automation through unofficial channels:** private APIs, headless-browser posting,
   anti-detect browsers, proxy farms.
4. **Bot-like engagement:** auto-follow, auto-like, mass DMs, comment pods, bought followers.
5. **Bursty behaviour on a new account:** 10 posts on day one, then silence.

So the "anti-ban" layer here is the opposite of evasion. It uses **official APIs only**, labels
everything, keeps a human-like cadence and never automates engagement on other people's content.
I deliberately haven't built device-fingerprint spoofing, proxy rotation or private-API posting.
Those are ToS violations, they're the fastest route to a permanent ban, and a ban would take the
ZOZOBRA brand association down with the account.

## 4.1 Account setup (do once, by hand)

### Instagram
1. Create the account on a real phone, with a dedicated SIM/email owned by the business
   (`lilo@zozobra.co.il`). Turn on 2FA (authenticator app) and store the backup codes in the
   company password manager.
2. Switch to a **Creator** account (category: *Digital creator*). Link it to a **Facebook Page**
   ("LILO") owned by ZOZOBRA's **Meta Business Portfolio**. The Graph API requires that link.
3. Profile: bio from `docs/01_persona_bible.md` (it states "AI"). Add ZOZOBRA as a
   **branded-content partner**: Settings → Business tools → Branded content → approve
   `@zozobra`, so the "Paid partnership with ZOZOBRA" tag appears.
4. Meta developer app → products: *Instagram Graph API*. Permissions:
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
   `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `business_management`.
   Create a **System User** in the Business Portfolio, assign the app and the IG asset, and
   generate a long-lived token → `IG_ACCESS_TOKEN`. Get `IG_USER_ID` from
   `GET /me/accounts?fields=instagram_business_account`.
5. **AI label:** on posts made in-app, toggle *Add AI label* (Advanced settings). Meta also reads
   C2PA/IPTC metadata. Keep `DigitalSourceType = trainedAlgorithmicMedia` in the exported files
   (`exiftool -XMP-iptcExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" final.mp4`).
   The caption disclosure from `compliance.py` is always added too.

### TikTok
1. Create the account in the app (same business email). Switch to a **Business account**. Bio
   states "AI virtual creator."
2. Settings → Content preferences: turn on **AI-generated content** labelling by default.
3. developers.tiktok.com: create an app, add **Content Posting API** with **Direct Post**, scopes
   `user.info.basic`, `video.publish`, `video.list`. The publisher uploads the rendered file
   directly (`FILE_UPLOAD`), so no domain verification is needed. You only need to verify a domain
   if you switch to `PULL_FROM_URL`.
4. Submit the app for **audit**. Until it's approved, API posts are forced to `SELF_ONLY`
   (private). Use that period for warm-up tests.
5. The publisher sets `brand_content_toggle: true` (the "Paid partnership" label) and
   `is_aigc: true` (the AI-generated label) on every post.

## 4.2 Warm-up plan (enforced by `account_health.PublishGuard`)

| Week | IG posts/day | TikTok posts/day | Notes |
|---|---|---|---|
| 1 | ≤1 | ≤1 | Post **manually in-app** (3–4 posts total). Follow ~10 relevant accounts by hand, reply to every comment by hand. No ads |
| 2 | ≤1 | ≤1 | Start API publishing. Stories daily (manual) |
| 3–4 | ≤1 | ≤2 | Collabs with @zozobra (Collab post = shows on both grids) |
| 5+ | ≤2 | ≤3 | Spark Ads (TikTok) / Partnership Ads (IG) on the top 10% organic posts |

Plus: at least 3h between posts, no publishing from 01:00 to 08:00 Israel time, and nothing during
national memorial days or sirens (the Brain flags those weeks). Instagram also enforces its own
100 API posts/24h quota; `quota_left()` checks it before every publish.

## 4.3 Publishing flow

```
pipeline produce  ─► data/queue/<day>.json (status: pending, caption with disclosures, media URL)
human review      ─► python -m zozobra.pipeline approve <day>   (watch final.mp4 first)
scheduler (panel) ─► publish-due every 15 min (or cron below)
                        ├─ skip if not approved (REQUIRE_HUMAN_APPROVAL=true)
                        ├─ PublishGuard: caps / gap / quiet hours
                        ├─ IG:  POST /{ig-user}/media (REELS) → poll status_code=FINISHED → /media_publish
                        ├─ TT:  creator_info/query → video/init (PULL_FROM_URL, brand + AIGC flags) → status/fetch
                        └─ ledger + analytics.posts row
```

Human approval is **on by default** and should stay on. It's brand-safety for a restaurant: one
wrong dish name, an allergy claim or a tone-deaf post on a sensitive day costs more than the
review takes.

### Crontab: only if you run without the control panel (the panel has its own scheduler)
```cron
CRON_TZ=Asia/Jerusalem
*/15 * * * *  cd /srv/zozobra-influencer && .venv/bin/python -m zozobra.pipeline publish-due >> logs/publish.log 2>&1
30 2 * * *    cd /srv/zozobra-influencer && .venv/bin/python -m zozobra.pipeline metrics     >> logs/metrics.log 2>&1
0 10 * * 0    cd /srv/zozobra-influencer && .venv/bin/python -m zozobra.pipeline plan --focus "$(cat focus.txt)" >> logs/plan.log 2>&1
```

## 4.4 Hard "never" list (keep the account alive)
- No private/unofficial APIs, Selenium/Playwright posting, anti-detect browsers or proxy rotation.
- No auto-follow, auto-like, auto-comment on others, mass DMs, engagement pods or bought followers.
- No removing the AI label or the ad disclosure, ever. `compliance.finalize_caption` adds both,
  and publishers set the platform flags.
- No reposting other creators' content or trending audio you don't have rights to.
